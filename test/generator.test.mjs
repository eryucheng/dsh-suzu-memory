import assert from 'node:assert/strict';
import test from 'node:test';
import { LONG_TERM_EXTRACTION_SCHEMA } from '@suzu-memory/extraction';
import { createDshGenerator } from '../src/generator.mjs';
import { host, textChunks } from './helpers.mjs';

const request = { schemaName: 'long-term-memory-extraction-v2', schema: LONG_TERM_EXTRACTION_SCHEMA, systemPrompt: '从对话中提取记忆。', input: '虚构对话。' };
function generator(ctx, controller = new AbortController(), overrides = {}) {
  return createDshGenerator({ llm: ctx.llm, resolveRoute: () => ({ provider: 'test', model: 'deepseek-test' }), signal: controller.signal,
    timeoutMs: 5000, maxTokens: 8192, maximumOutputCharacters: 10000, ...overrides });
}

test('structured generation uses the registered DSH route and maps token usage', async t => {
  const { ctx, adapter } = await host(t);
  const result = await generator(ctx)(request);
  assert.deepEqual(result.output, { memories: [] });
  assert.equal(result.usage.input_tokens, 30);
  assert.equal(result.usage.cache_read_input_tokens, 10);
  assert.equal(result.usage.cache_creation_input_tokens, 5);
  assert.equal(result.usage.output_tokens, 20);
  assert.match(adapter.calls[0].system, /memories/);
  assert.equal(adapter.calls[0].model, 'deepseek-test');
  assert.equal(adapter.calls[0].messages[0].content[0].text, request.input);
  assert.equal(adapter.calls[0].tools, undefined);
});

test('invalid JSON and schema violations fail before entering Memory', async t => {
  const { ctx } = await host(t, (_options, count) => textChunks(count === 1 ? 'invalid' : '{"memories":[],"extra":true}'));
  const generate = generator(ctx);
  await assert.rejects(generate(request), { code: 'MEMORY_OUTPUT_INVALID' });
  await assert.rejects(generate(request), { code: 'MEMORY_TASK_SCHEMA_INVALID' });
});

test('truncation, transport failure and missing finish are not accepted as valid output', async t => {
  const { ctx } = await host(t, (_options, count) => count === 1
    ? [{ type: 'text-delta', index: 0, text: '{"memories":[]}' }, { type: 'finish', reason: { kind: 'max-tokens' } }]
    : count === 2 ? [{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'rate limit' } } }]
      : [{ type: 'text-delta', index: 0, text: '{"memories":[]}' }]);
  for (let i = 0; i < 3; i++) await assert.rejects(generator(ctx)(request), { code: 'MEMORY_GENERATION_FAILED' });
});

test('cancellation and output limits release an in-flight stream', async t => {
  let returned = false;
  const { ctx } = await host(t, () => textChunks('x'.repeat(200)));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(generator(ctx, controller)(request), { name: 'AbortError' });
  const llm = { async prepareCall(route) { return { config: route, async * stream() {
    try { yield { type: 'text-delta', index: 0, text: 'x'.repeat(200) }; }
    finally { returned = true; }
  } }; } };
  await assert.rejects(generator({ llm }, new AbortController(), { maximumOutputCharacters: 100 })(request), { code: 'MEMORY_OUTPUT_LIMIT' });
  assert.equal(returned, true);
});
