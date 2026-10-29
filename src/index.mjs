import { defineTool } from '@deepseek-ai/dsh-tools';
import { resolveConfig } from './config.mjs';
import { DshMemoryRuntime } from './runtime.mjs';
import { sourceScope } from './events.mjs';
import { SessionSettings, CHAT_COMPACTION_PROMPT } from './session-settings.mjs';
import { installCompactionPrompts } from './compaction.mjs';
import { liveValue } from './schedule.mjs';

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

function boundedResult(result, limit) {
  const memoryIds = result.context ? [...new Set(result.trace?.selectedIds || [])] : [];
  const text = `状态：${result.status}\n记忆 ID：${memoryIds.join('、')}\n${result.context || ''}`;
  if (text.length > limit) throw new Error('记忆材料超过输出预算。');
  return { text, memoryIds };
}

/** Mounts the host's existing session, model and tool services. */
export function apply(ctx, input) {
  const config = resolveConfig(input, ctx.get('profileContext'));
  const prompts = new SessionSettings(ctx, config.dataRoot, () => liveValue(config.enabled) !== false);
  const runtime = new DshMemoryRuntime(ctx, config, id => prompts.read(id).memoryEnabled);
  const unregisterTools = new Map();
  installCompactionPrompts(ctx, prompts, config, (id, value) => runtime.compactions.set(id, value), id =>
    AbortSignal.any([runtime.controlSignal.signal, runtime.sessions.get(id)?.activation.signal].filter(Boolean)));
  ctx.effect(() => () => { for (const dispose of unregisterTools.values()) dispose(); unregisterTools.clear(); return runtime.close(); });
  ctx.on('agent/created', ({ agent }) => { void refreshAgent(agent).catch(error => runtime.report(error)); });
  ctx.on('agent/disposed', ({ agent }) => { unregisterTools.get(agent.id)?.(); unregisterTools.delete(agent.id); });
  ctx.on('suzu-memory/session-settings-changed', id => {
    const agent = ctx.get('agents')?.get(id);
    void (agent ? refreshAgent(agent) : runtime.refreshSession(id)).catch(error => runtime.report(error));
  });
  ctx.on('session/event', (session, event) => {
    runtime.observe(session);
    if (event.type === 'compaction/start' || (event.type === 'user/message'
      && event.surfaceOp?.op === 'replace' && event.data.source.kind !== 'compact-checkpoint')) runtime.scheduleArchive(session, { flush: true });
    else if (event.type === 'turn/end' && event.data.reason.kind === 'completed') runtime.scheduleArchive(session);
  });
  ctx.on('session/disposed', session => { runtime.compactions.delete(session.id); void runtime.release(session).catch(error => runtime.report(error)); });
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
          : config.consoleEnabled ? runtime.view(agent.session) : null;
        if (!entry) return { kind: 'success', text: JSON.stringify({ ...flags, enabled, processing: false, policy }) };
        return { kind: 'success', text: JSON.stringify({ ...flags, enabled, policy,
          deferred: entry.deferred || (policy.automatic && policy.offPeakOnly && !policy.allowed && Boolean(entry.pendingEvents || entry.maintenancePending)),
          compaction: runtime.compactions.get(agent.session.id), processing: Boolean(entry.running),
          pending: entry.pendingEvents > 0 || entry.maintenancePending, error: entry.error,
          status: entry.memory.managementStatus(), consoleUrl: await runtime.consoleUrl(entry) }) };
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
    description: '需要回想此前交流过的人、事或原话时，检索长期记忆。可用返回的记忆 ID 继续查关联。',
    parameters: {
      query: { type: 'string', required: true, description: '结合当前对话明确需要回想的人、事或时间。' },
      limit: { type: 'number', description: '返回候选数，1—10。' },
      anchors: { type: 'array', items: { type: 'string' }, description: '此前返回的记忆 ID，最多三个。' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      if (!args.query.trim() || args.query.length > 2000) throw new Error('query 应为 1—2000 字符。');
      if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 10)) throw new Error('limit 应为 1—10 的整数。');
      if (args.anchors && args.anchors.length > 3) throw new Error('最多提供三个记忆锚点。');
      const { entry } = runtime.consume(sessionOf(exec));
      const result = await entry.memory.search(args.query, {
        anchors: args.anchors || [], persistTrace: false, reactivate: false,
        queryPerspective: {
          speakerRole: 'agent', speakerKey: entry.identity.agentId, speakerNames: [entry.identity.memoryOwner],
          addresseeRole: 'user', addresseeKey: entry.identity.userId, addresseeNames: [entry.identity.userName],
        },
        sourceScope: sourceScope(entry.session),
        signal: AbortSignal.any([exec.signal, entry.controller.signal, entry.activation.signal, runtime.controlSignal.signal]),
        options: { maximumReturnedCandidates: args.limit || config.recallLimit,
          maximumContextMemories: args.limit || config.recallLimit,
          maximumContextChars: Math.max(64, config.recallMaximumCharacters - 1024) },
      });
      const visible = boundedResult(result, config.recallMaximumCharacters);
      if (result.status === 'ready' && visible.memoryIds.length) entry.memory.reactivateRecall({
        activationId: `dsh:${entry.session.id}:${exec.callId}`, memoryIds: visible.memoryIds,
        sourceScope: sourceScope(entry.session),
        signal: AbortSignal.any([exec.signal, entry.controller.signal, entry.activation.signal, runtime.controlSignal.signal]),
      });
      return visible.text;
    },
  });
  async function refreshAgent(agent) {
    const enabled = runtime.enabledFor(agent.session);
    const settling = runtime.refreshSession(agent.session.id);
    if (!enabled) { unregisterTools.get(agent.id)?.(); unregisterTools.delete(agent.id); }
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
