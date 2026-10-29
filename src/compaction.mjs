import { BlockAssembler, LlmError, CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm';
import { liveValue } from './schedule.mjs';

const NATIVE_DIRECTIVE = 'You are now acting as a compaction engine';
const SEGMENT_INSTRUCTION = '概括本段对话，保留后续交流需要的人物、时间、变化和未完成事项。';
const MERGE_INSTRUCTION = '按时间顺序合并这些摘要，保留事实归属和变化，合并重复内容。';

/** Quote history as material and keep speaker labels on every continuation. */
export function compactionBatches(messages, limit, { maximumTokens = Infinity, estimateMessage } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('无效的分段长度。');
  const batches = [];
  let blocks = [], length = 0, role = 'user';
  const fits = text => {
    if (maximumTokens === Infinity) return true;
    const previous = blocks.at(-1);
    const content = previous?.type === 'text'
      ? [...blocks.slice(0, -1), { type: 'text', text: previous.text + text }]
      : [...blocks, { type: 'text', text }];
    return estimateMessage({ role: 'user', content }) <= maximumTokens;
  };
  const flush = () => {
    if (blocks.length) batches.push(blocks);
    blocks = []; length = 0;
  };
  const appendRaw = text => {
    const previous = blocks.at(-1);
    if (previous?.type === 'text') previous.text += text;
    else blocks.push({ type: 'text', text });
    length += text.length;
  };
  const label = () => '\n[' + role + ']\n';
  const start = () => {
    if (blocks.length) return;
    if (label().length + 2 > limit || !fits(label() + '🙂')) throw new Error('分段预算不足以保留说话者与正文。');
    appendRaw(label());
  };
  const appendText = text => {
    while (text.length) {
      start();
      const available = limit - length;
      if (available < 2 && text.length > available) { flush(); continue; }
      let end = Math.min(text.length, available);
      if (!fits(text.slice(0, end))) {
        let low = 0, high = end;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          if (fits(text.slice(0, middle))) low = middle;
          else high = middle - 1;
        }
        end = low;
      }
      if (end < text.length) {
        let boundary = text.lastIndexOf('\n', end);
        if (boundary < end / 2) boundary = text.lastIndexOf(' ', end);
        if (boundary >= end / 2) end = boundary;
      }
      if (end > 0 && /[\uD800-\uDBFF]/u.test(text[end - 1]) && end < text.length) end--;
      if (!end) {
        if (length === label().length) throw new Error('分段预算不足以容纳一个完整字符。');
        flush(); continue;
      }
      appendRaw(text.slice(0, end)); text = text.slice(end);
      if (text.length) flush();
    }
  };
  for (const message of messages) {
    role = message.role === 'tool' ? 'tool ' + message.toolCallId : message.role;
    if (blocks.length) {
      if (limit - length < label().length + 2 || !fits(label() + '🙂')) flush();
      else appendRaw(label());
    }
    for (const block of message.content || []) {
      if (block.type === 'text') appendText(block.text);
      else if (block.type === 'tool-call') appendText('\n[Tool: ' + block.name + ' / ' + block.id + '] ' + block.arguments + '\n');
      else if (block.type === 'tool-addition' || block.type === 'tool-removal') appendText('\n[' + block.type + ': ' + block.toolName + ']\n');
      else if (block.type !== 'reasoning') { start(); blocks.push(block); flush(); }
    }
  }
  flush();
  return batches;
}

async function summarize(ctx, options, redirected) {
  redirected.add(options);
  const assembler = new BlockAssembler();
  let finished = false;
  for await (const chunk of ctx.llm.stream(options)) {
    options.signal?.throwIfAborted(); assembler.push(chunk);
    if (chunk.type === 'finish') finished = true;
  }
  options.signal?.throwIfAborted();
  if (assembler.finish.kind === 'error' || assembler.finish.kind === 'aborted') {
    const failure = assembler.finish.failure;
    throw new LlmError(failure.message, failure.code, failure);
  }
  if (!finished || assembler.finish.kind !== 'stop') {
    throw Object.assign(new Error('分段压缩未完整结束，原上下文保留。'), {
      code: assembler.finish.kind === 'max-tokens' ? 'MAX_TOKENS' : 'COMPACTION_INCOMPLETE',
    });
  }
  const output = assembler.blocks();
  if (output.some(block => !['text', 'reasoning'].includes(block.type))) throw new Error('分段摘要应只包含文本。');
  const text = output.filter(block => block.type === 'text').map(block => block.text).join('').trim();
  if (!text) throw new Error('分段压缩返回空摘要，原上下文保留。');
  return { text, usage: assembler.usage };
}

/** Keep DSH's region, retained tail, checkpoints and rollback authoritative. */
export function installCompactionPrompts(ctx, prompts, config = {}, progress = () => {}, signalFor = () => undefined) {
  const redirected = new WeakSet();
  ctx.on('llm/stream', (options, next) => {
    const last = options.messages?.at(-1);
    if (options.purpose !== 'compaction' || !options.sessionId || redirected.has(options)
      || last?.role !== 'user' || last.content?.length !== 1
      || last.content[0].type !== 'text' || !last.content[0].text.startsWith(NATIVE_DIRECTIVE)) return next();
    prompts.nativeCompaction.set(options.sessionId, last.content[0].text);
    if (!prompts.isEnabled(options.sessionId)) return next();
    const instruction = prompts.compactionInstruction(options.sessionId) ?? last.content[0].text;
    const signal = AbortSignal.any([options.signal, signalFor(options.sessionId)].filter(Boolean));
    const region = options.messages.slice(0, -1);
    const body = region.filter(message => message.role !== 'system');
    const routed = { ...options, signal, messages: [...region,
      Object.freeze({ ...last, content: Object.freeze([Object.freeze({ type: 'text', text: instruction })]) })] };
    if (liveValue(config.batchedCompaction) === false) {
      if (instruction === last.content[0].text) return next();
      redirected.add(routed); return ctx.llm.stream(routed);
    }
    return (async function* () {
      const work = new AbortController();
      const workSignal = AbortSignal.any([signal, work.signal]);
      const system = region.filter(message => message.role === 'system');
      const usage = {};
      const account = result => {
        for (const [key, value] of Object.entries(result.usage || {})) if (typeof value === 'number') usage[key] = (usage[key] || 0) + value;
        return result.text;
      };
      try {
        workSignal.throwIfAborted();
        const meter = ctx.get('tokenMeter');
        if (!meter) throw new Error('分段压缩需要 DSH 的 token 估算服务。');
        const estimateMessage = message => meter.estimateMessage(message);
        const model = await ctx.llm.resolveModelInfo(options.provider, options.model, workSignal);
        const manualLimit = liveValue(config.compactionBatchCharacters) || 0;
        const limit = manualLimit || Number.MAX_SAFE_INTEGER;
        const contextWindow = model.context?.contextWindow;
        if (!contextWindow && !manualLimit) throw new Error('压缩模型未提供上下文容量，请配置模型的 contextWindow，或手动填写每段原文字符上限。');
        // Use the host's estimator, reserve the configured output and a 10% estimation margin.
        const requestBudget = contextWindow ? Math.floor(contextWindow * 0.9) - (options.maxTokens ?? model.defaultMaxTokens ?? 0) : Infinity;
        const directive = text => ({ role: 'user', content: [{ type: 'text', text: instruction + '\n\n' + text }] });
        const fixedTokens = system.reduce((sum, message) => sum + estimateMessage(message), 0)
          + Math.max(estimateMessage(directive(SEGMENT_INSTRUCTION)), estimateMessage(directive(MERGE_INSTRUCTION)));
        const maximumTokens = requestBudget - fixedTokens;
        let batches = manualLimit ? compactionBatches(body, limit) : [];
        let learnedTokens = maximumTokens;
        const concurrency = liveValue(config.compactionConcurrency) ?? 3;
        if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('压缩并发数应为 1–8。');
        const toolsTokens = options.tools?.length ? estimateMessage({ role: 'user', content: [{ type: 'text', text: JSON.stringify(options.tools) }] }) : 0;
        const originalTokens = routed.messages.reduce((sum, message) => sum + estimateMessage(message), toolsTokens);
        let summaries;
        if (batches.length < 2 && originalTokens <= requestBudget) {
          try { summaries = [account(await summarize(ctx, { ...routed, signal: workSignal }, redirected))]; }
          catch (error) {
            if (error.code !== CONTEXT_WINDOW_EXCEEDED_CODE || workSignal.aborted) throw error;
            learnedTokens = Math.min(maximumTokens, Math.floor(body.reduce((sum, message) => sum + estimateMessage(message), 0) / 2));
          }
        }
        const compact = async (content, phaseInstruction) => {
          workSignal.throwIfAborted();
          const previous = estimateMessage({ role: 'user', content });
          if (previous <= learnedTokens) {
            try {
              return [account(await summarize(ctx, { ...options, signal: workSignal, tools: undefined, toolHistory: undefined,
                messages: [...system, { role: 'user', content }, directive(phaseInstruction)],
              }, redirected))];
            } catch (error) {
              if (error.code !== CONTEXT_WINDOW_EXCEEDED_CODE || workSignal.aborted) throw error;
              learnedTokens = Math.min(learnedTokens, Math.floor(previous / 2));
            }
          }
          // Share the reduced budget with later work; completed siblings are retained.
          const smaller = compactionBatches([{ role: 'user', content }], limit,
            { maximumTokens: learnedTokens, estimateMessage });
          if (smaller.length < 2 || smaller.some(part => estimateMessage({ role: 'user', content: part }) >= previous)) {
            throw new Error('压缩材料无法继续拆小，请检查压缩模型的系统提示词和输出额度。');
          }
          const results = [];
          for (const part of smaller) results.push(...await compact(part, phaseInstruction));
          return results;
        };
        const runStage = async (parts, phase, phaseInstruction) => {
          const results = new Array(parts.length);
          let nextIndex = 0, completed = 0;
          progress(options.sessionId, { phase, completed, total: parts.length });
          const worker = async () => {
            while (nextIndex < parts.length) {
              workSignal.throwIfAborted();
              const index = nextIndex++;
              try { results[index] = await compact(parts[index], phaseInstruction); }
              catch (error) { work.abort(error); throw error; }
              progress(options.sessionId, { phase, completed: ++completed, total: parts.length });
            }
          };
          const settled = await Promise.allSettled(Array.from({ length: Math.min(concurrency, parts.length) }, worker));
          const failure = settled.find(result => result.status === 'rejected');
          if (failure) throw work.signal.reason || failure.reason;
          return results.flat();
        };
        if (!summaries) {
          if (maximumTokens <= 0) throw new Error('压缩模型的上下文不足以容纳系统提示词和输出额度，请调整压缩模型或输出上限。');
          batches = compactionBatches(body, limit, { maximumTokens: learnedTokens, estimateMessage });
          if (!batches.length) throw new Error('没有可用于分段压缩的正文。');
          summaries = await runStage(batches, 'summarizing', SEGMENT_INSTRUCTION);
        }
        while (summaries.length > 1) {
          const text = summaries.join('\n\n');
          const mergeBatches = compactionBatches([{ role: 'user', content: [{ type: 'text', text }] }], limit,
            { maximumTokens: learnedTokens, estimateMessage });
          const merged = await runStage(mergeBatches, 'merging', MERGE_INSTRUCTION);
          if (merged.length > 1 && merged.join('\n\n').length >= text.length) throw new Error('分段摘要未能收敛，原上下文保留。');
          summaries = merged;
        }
        signal.throwIfAborted();
        yield { type: 'text-delta', index: 0, text: summaries[0] };
        if (Object.keys(usage).length) yield { type: 'usage', usage };
        yield { type: 'finish', reason: { kind: 'stop' } };
        progress(options.sessionId, { phase: 'completed', completed: batches.length || 1, total: batches.length || 1 });
      } catch (error) {
        work.abort(error);
        progress(options.sessionId, { phase: 'failed', message: error.message });
        throw error;
      }
    })();
  });
}
