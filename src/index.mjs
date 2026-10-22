import { defineTool } from '@deepseek-ai/dsh-tools';
import { resolveConfig } from './config.mjs';
import { DshMemoryRuntime } from './runtime.mjs';
import { sourceScope } from './events.mjs';

export { Config } from './config.mjs';
export const name = 'suzu-memory';
export const inject = ['llm', 'tools', 'sessions', 'systemPrompt'];

const GUIDANCE = `当前会话启用了 Suzu Memory 长期记忆。需要以前交流过的细节、经历或原话时，调用 suzu_memory_search；可以改写查询，或用已返回的记忆 ID 继续查关联。结果是历史材料，结合时间、来源和当前对话使用。没有找到不等于从未发生。记忆只属于当前会话。聊天内容由宿主记录和整理，无需为写入记忆编造事件。suzu_memory_status 可查看状态和审核台地址，suzu_memory_maintain 可请求整理或重试。`;

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
  ctx.effect(() => () => runtime.close());
  ctx.on('agent/created', ({ agent }) => { runtime.consume(agent.session); });
  ctx.on('session/event', session => runtime.observe(session));
  ctx.on('agent/status', ({ agent, status }) => { if (status === 'idle') runtime.idle(agent.session); });
  ctx.on('session/disposed', session => { void runtime.release(session).catch(error => runtime.report(error)); });
  ctx.systemPrompt.section({ name: 'suzu-memory:recall', order: 85, text: GUIDANCE, interpolate: false });
  ctx.tools.register(defineTool({
    name: 'suzu_memory_search',
    description: '回想当前会话的长期记忆，可沿已返回的记忆 ID 查询关联、后续和原话。',
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
  ctx.tools.register(defineTool({
    name: 'suzu_memory_status', description: '查看当前会话的记忆处理状态和本地审核台地址。', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(_args, exec) {
      const { entry } = runtime.consume(sessionOf(exec));
      return JSON.stringify({ sessionId: entry.session.id, processing: Boolean(entry.running), pending: entry.cursor.maintenancePending, error: entry.error,
        status: entry.memory.managementStatus(), consoleUrl: await runtime.consoleUrl(entry) });
    },
  }));
  ctx.tools.register(defineTool({
    name: 'suzu_memory_maintain', description: '整理当前会话已记录的经历，或重试尚未完成的记忆维护。', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(_args, exec) {
      const result = await waitForTask(runtime.maintain(sessionOf(exec), { force: true }), exec.signal);
      return JSON.stringify({ status: result.status });
    },
  }));
}
