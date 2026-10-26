import { BlockAssembler } from '@deepseek-ai/dsh-llm';
import { assertMemoryTaskRequest, validateMemoryTaskOutput } from '@suzu-memory/service';

/** Bridges Memory's structured tasks to the host's registered model route. */
export function createDshGenerator({ llm, resolveRoute, signal, timeoutMs, maxTokens, maximumOutputCharacters }) {
  const generate = async request => {
    assertMemoryTaskRequest(request);
    const combinedSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    combinedSignal.throwIfAborted();
    const route = resolveRoute();
    const prepared = await llm.prepareCall({ ...route, maxTokens }, combinedSignal);
    const schema = JSON.stringify(request.schema);
    const options = {
      ...prepared.config,
      signal: combinedSignal,
      system: `${request.systemPrompt}\n\n只返回符合以下 JSON Schema 的一个 JSON 对象。不要输出 Markdown 或解释。\n${schema}`,
      messages: [{ role: 'user', content: [{ type: 'text', text: typeof request.input === 'string' ? request.input : JSON.stringify(request.input) }] }],
    };
    const assembler = new BlockAssembler();
    let characters = 0;
    const blockSizes = new Map();
    let finished = false;
    for await (const chunk of prepared.stream(options)) {
      combinedSignal.throwIfAborted();
      const previousSize = blockSizes.get(chunk.index) || 0;
      if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
        blockSizes.set(chunk.index, previousSize + chunk.text.length);
        characters += chunk.text.length;
      } else if (chunk.type === 'block-end' && typeof chunk.block.text === 'string') {
        blockSizes.set(chunk.index, chunk.block.text.length);
        characters += chunk.block.text.length - previousSize;
      }
      if (characters > maximumOutputCharacters) throw Object.assign(new Error('记忆分析输出超过配置上限。'), { code: 'MEMORY_OUTPUT_LIMIT' });
      assembler.push(chunk);
      if (chunk.type === 'finish') finished = true;
    }
    combinedSignal.throwIfAborted();
    const usage = assembler.usage;
    const responseInfo = { usage: usage ? {
      input_tokens: usage.inputTokens,
      cache_read_input_tokens: usage.cacheReadTokens || 0,
      cache_creation_input_tokens: usage.cacheWriteTokens || 0,
      output_tokens: usage.outputTokens,
      ...(usage.totalTokens === undefined ? {} : { total_tokens: usage.totalTokens }),
    } : {}, model: prepared.config.model };
    if (!finished || assembler.finish.kind !== 'stop') {
      const truncated = finished && assembler.finish.kind === 'max-tokens';
      throw Object.assign(new Error(`记忆分析未正常完成：${assembler.finish.kind}。`), {
        ...responseInfo, code: truncated ? 'MAX_TOKENS' : 'MEMORY_GENERATION_FAILED', cause: assembler.finish,
        ...(truncated ? { diagnostics: { kind: 'output-limit', finishReason: 'max-tokens', maxOutputTokens: maxTokens } } : {}),
      });
    }
    const text = assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('').trim()
      .replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
    let output;
    try { output = JSON.parse(text); }
    catch (cause) { throw Object.assign(new Error('记忆分析没有返回有效 JSON。', { cause }), { code: 'MEMORY_OUTPUT_INVALID' }); }
    validateMemoryTaskOutput(request, output);
    return { output, ...responseInfo };
  };
  generate.supportsCombinedStateAnalysis = true;
  generate.supportsCombinedConsolidation = true;
  return generate;
}
