import { defineTool } from '@deepseek-ai/dsh-tools';
import { resolveConfig } from './config.mjs';
import { DshMemoryRuntime } from './runtime.mjs';
import { sourceScope } from './events.mjs';
import { SessionPrompts, CHAT_COMPACTION_PROMPT } from './session-prompts.mjs';
import { installCompactionPrompts } from './compaction.mjs';

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
  let text = `状态：${result.status}\n记忆 ID：${(result.candidates || []).map(item => item.memoryId).join('、')}\n${result.context || ''}`;
  const memoryIds = new Set(result.trace?.selectedIds || []);
  if (text.length > limit) throw new Error('记忆材料超过输出预算。');
  for (const candidate of result.candidates || []) {
    const preview = `\n\n记忆 ID：${candidate.memoryId}\n${candidate.recallContext || ''}`;
    if (text.length + preview.length > limit) break;
    text += preview;
    memoryIds.add(candidate.memoryId);
  }
  return { text, memoryIds: [...memoryIds] };
}

/** Mounts the host's existing session, model and tool services. */
export function apply(ctx, input) {
  const config = resolveConfig(input, ctx.get('profileContext'));
  const runtime = new DshMemoryRuntime(ctx, config);
  const prompts = new SessionPrompts(ctx, config.dataRoot);
  installCompactionPrompts(ctx, prompts);
  ctx.effect(() => () => runtime.close());
  ctx.on('agent/created', ({ agent }) => { runtime.consume(agent.session); });
  ctx.on('session/event', session => runtime.observe(session));
  ctx.on('agent/status', ({ agent, status }) => { if (status === 'idle') runtime.idle(agent.session); });
  ctx.on('session/disposed', session => { void runtime.release(session).catch(error => runtime.report(error)); });
  ctx.on('loader/volatile-update', () => runtime.refreshEmbedding());
  ctx.inject(['commands'], ctx => {
    ctx.commands.register({ name: 'suzu-memory-prompts', description: '读取本会话的人设与压缩设置。', recordInput: false,
      handler({ agent }) {
        return { kind: 'success', text: JSON.stringify({ value: prompts.read(agent.session.id), chatTemplate: CHAT_COMPACTION_PROMPT }) };
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
        const { entry } = runtime.consume(agent.session);
        return { kind: 'success', text: JSON.stringify({ processing: Boolean(entry.running),
          pending: entry.cursor.maintenancePending, error: entry.error,
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
  ctx.tools.register(defineTool({
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
        sourceScope: sourceScope(entry.session),
        signal: AbortSignal.any([exec.signal, entry.controller.signal]),
        options: { includeCandidateContext: true, maximumReturnedCandidates: args.limit || config.recallLimit,
          maximumContextChars: Math.max(64, config.recallMaximumCharacters - 1024) },
      });
      const visible = boundedResult(result, config.recallMaximumCharacters);
      if (result.status === 'ready' && visible.memoryIds.length) entry.memory.reactivateRecall({
        activationId: `dsh:${entry.session.id}:${exec.callId}`, memoryIds: visible.memoryIds,
        sourceScope: sourceScope(entry.session),
        signal: AbortSignal.any([exec.signal, entry.controller.signal]),
      });
      return visible.text;
    },
  }));
}
