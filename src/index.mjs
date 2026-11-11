import { defineTool } from '@deepseek-ai/dsh-tools';
import { resolveConfig } from './config.mjs';
import { DshMemoryRuntime } from './runtime.mjs';
import { sourceScope, sessionMemoryId } from './events.mjs';
import { libraryExists } from './library-storage.mjs';
import { SessionSettings, CHAT_COMPACTION_PROMPT } from './session-settings.mjs';
import { installCompactionPrompts } from './compaction.mjs';
import { liveValue } from './schedule.mjs';
import { createMemorySearchSession, MEMORY_SEARCH_TOOL } from './memory.mjs';

export { Config } from './config.mjs';
export const name = 'suzu-memory';
export const inject = ['llm', 'tools', 'sessions'];

function sessionOf(exec) {
  if (!exec.agent) throw new Error('Suzu Memory 工具必须在 DSH 会话中执行。');
  return exec.agent.session;
}

function waitForTask(task, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Mounts the host's existing session, model and tool services. */
export function apply(ctx, input) {
  const config = resolveConfig(input, ctx.get('profileContext'));
  const prompts = new SessionSettings(ctx, config.dataRoot, () => liveValue(config.enabled) !== false);
  const runtime = new DshMemoryRuntime(ctx, config, id => prompts.read(id).memoryEnabled, prompts);
  const unregisterTools = new Map();
  const recalls = new Map();
  const closeRecall = id => { recalls.get(id)?.session.close(); recalls.delete(id); };
  installCompactionPrompts(ctx, prompts, config, (id, value) => runtime.compactions.set(id, value), id =>
    AbortSignal.any([runtime.controlSignal.signal, runtime.sessions.get(id)?.activation.signal].filter(Boolean)));
  ctx.effect(() => () => {
    for (const id of recalls.keys()) closeRecall(id);
    for (const dispose of unregisterTools.values()) dispose(); unregisterTools.clear(); return runtime.close();
  });
  ctx.on('agent/created', ({ agent }) => { void refreshAgent(agent).catch(error => runtime.report(error)); });
  ctx.on('agent/disposed', ({ agent }) => { closeRecall(agent.session.id); unregisterTools.get(agent.id)?.(); unregisterTools.delete(agent.id); });
  ctx.on('suzu-memory/session-settings-changed', id => {
    const agent = ctx.get('agents')?.get(id);
    void (agent ? refreshAgent(agent) : runtime.refreshSession(id)).catch(error => runtime.report(error));
  });
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start' || event.type === 'compaction/start'
      || (event.type === 'user/message' && event.surfaceOp?.op === 'replace')) closeRecall(session.id);
    runtime.observe(session);
    if (event.type === 'compaction/start' || (event.type === 'user/message'
      && event.surfaceOp?.op === 'replace' && event.data.source.kind !== 'compact-checkpoint')) runtime.scheduleArchive(session, { flush: true });
    else if (event.type === 'turn/end' && event.data.reason.kind === 'completed') runtime.scheduleArchive(session);
  });
  ctx.on('session/disposed', session => { closeRecall(session.id); runtime.compactions.delete(session.id); void runtime.release(session).catch(error => runtime.report(error)); });
  ctx.inject(['commands'], ctx => {
    ctx.commands.register({ name: 'suzu-memory-enable', description: '设置当前会话的记忆开关。',
      input: { hint: '会话开关与配置版本' }, recordInput: false,
      async handler({ agent, rawInput, signal }) {
        const { enabled, revision } = JSON.parse(rawInput);
        const result = await prompts.setMemoryEnabled(agent.session.id, enabled, revision, signal);
        if (result.saved) await refreshAgent(agent);
        return { kind: 'success', text: JSON.stringify(result) };
      },
    });
    ctx.commands.register({ name: 'suzu-memory-prompts', description: '读取本会话的人设与压缩设置。', recordInput: false,
      async handler({ agent, signal }) {
        return { kind: 'success', text: JSON.stringify({ value: prompts.read(agent.session.id), chatTemplate: CHAT_COMPACTION_PROMPT,
          native: await prompts.nativeView(agent, signal) }) };
      },
    });
    ctx.commands.register({ name: 'suzu-memory-save-prompts', description: '保存本会话的人设与压缩设置。',
      input: { hint: '会话提示词配置' }, recordInput: false,
      async handler({ agent, rawInput, signal }) {
        const { value, revision } = JSON.parse(rawInput);
        const result = await prompts.save(agent.session.id, value, revision, signal);
        return { kind: 'success', text: JSON.stringify(result) };
      },
    });
    ctx.commands.register({ name: 'suzu-memory-status', description: '查看记忆状态与审核台。',
      async handler({ agent }) {
        const policy = runtime.window();
        const preferences = prompts.read(agent.session.id);
        const flags = { profileEnabled: policy.enabled, sessionEnabled: preferences.memoryEnabled, settingsRevision: preferences.revision };
        const enabled = runtime.enabledFor(agent.session);
        const entry = enabled ? runtime.consume(agent.session).entry
          : libraryExists(config.dataRoot, sessionMemoryId(agent.session.id)) ? runtime.view(agent.session) : null;
        const consoleUrl = await runtime.consoleUrl({ session: agent.session });
        const budget = await runtime.budget.status();
        if (!entry) return { kind: 'success', text: JSON.stringify({ ...flags, enabled, processing: false, policy, consoleUrl, budget }) };
        return { kind: 'success', text: JSON.stringify({ ...flags, enabled, policy,
          deferred: entry.deferred || (policy.automatic && policy.offPeakOnly && !policy.allowed && Boolean(entry.pendingEvents || entry.maintenancePending)),
          compaction: runtime.compactions.get(agent.session.id), processing: Boolean(entry.running),
          pending: entry.pendingEvents > 0 || entry.maintenancePending, error: entry.error,
          status: entry.memory.managementStatus(), consoleUrl, budget }) };
      },
    });
    ctx.commands.register({ name: 'suzu-memory-maintain', description: '整理当前会话的记忆。',
      async handler({ agent, signal }) {
        const result = await waitForTask(runtime.maintain(agent.session, { force: true }), signal);
        return { kind: 'success', text: JSON.stringify({ status: result.status }) };
      },
    });
  });
  const searchTool = defineTool({
    name: 'suzu_memory_search',
    description: MEMORY_SEARCH_TOOL.description,
    parameters: {
      query: { type: 'string', required: true, description: '需要回想的人、事或时间；已知姓名时使用姓名。' },
      limit: { type: 'number', description: '返回候选数，1—10。' },
      anchors: { type: 'array', items: { type: 'string' }, description: '此前返回的记忆编号，如 m1，最多三个。' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const { entry } = runtime.consume(sessionOf(exec));
      let recall = recalls.get(entry.session.id);
      if (recall?.entry !== entry || recall.activation !== entry.activation || recall.control !== runtime.controlSignal) {
        closeRecall(entry.session.id);
        recall = { entry, activation: entry.activation, control: runtime.controlSignal,
          session: createMemorySearchSession({ memory: { search: (...args) => entry.memory.search(...args) }, maximumSearches: Infinity,
            signal: AbortSignal.any([entry.controller.signal, entry.activation.signal, runtime.controlSignal.signal]),
            maximumContextMemories: 10, maximumContextChars: config.recallMaximumCharacters,
            searchOptions: {
              queryPerspective: {
                speakerRole: 'agent', speakerKey: entry.identity.agentId, speakerNames: [entry.identity.memoryOwner],
                addresseeRole: 'user', addresseeKey: entry.identity.userId, addresseeNames: [entry.identity.userName],
              },
              sourceScope: sourceScope(entry.session),
            },
          }),
        };
        recalls.set(entry.session.id, recall);
      }
      const result = await recall.session.execute({ ...args, limit: args.limit ?? config.recallLimit }, { signal: exec.signal });
      const memoryIds = result.memoryIds;
      if (result.status === 'ready' && memoryIds.length) entry.memory.reactivateRecall({
        activationId: `dsh:${entry.session.id}:${exec.callId}`, memoryIds,
        sourceScope: sourceScope(entry.session),
        signal: AbortSignal.any([exec.signal, entry.controller.signal, entry.activation.signal, runtime.controlSignal.signal]),
      });
      return result.text;
    },
  });
  async function refreshAgent(agent) {
    const enabled = runtime.enabledFor(agent.session);
    const settling = runtime.refreshSession(agent.session.id);
    if (!enabled) { closeRecall(agent.session.id); unregisterTools.get(agent.id)?.(); unregisterTools.delete(agent.id); }
    else {
      if (!unregisterTools.has(agent.id)) unregisterTools.set(agent.id, agent.ctx.tools.register(searchTool));
      await settling;
      if (!runtime.enabledFor(agent.session)) return;
      runtime.observe(agent.session);
      runtime.scheduleArchive(agent.session);
    }
    if (!enabled) await settling;
  }
  const refresh = () => {
    const wasEnabled = runtime.enabled;
    runtime.refreshSettings();
    for (const agent of ctx.get('agents')?.list() || []) void refreshAgent(agent).catch(error => runtime.report(error));
    if (wasEnabled !== runtime.enabled) ctx.emit('system-prompt/change');
  };
  refresh();
  ctx.on('loader/volatile-update', refresh);
}
