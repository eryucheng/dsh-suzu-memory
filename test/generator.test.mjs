import { appendCompanionEvents, processPendingCompanionEvents } from '@suzu-memory/ingestion';
import { MemoryRepository, openMemoryDatabase } from '@suzu-memory/core';
import assert from 'node:assert/strict';
import test from 'node:test';
import { LONG_TERM_EXTRACTION_SCHEMA, parseGeneratedLongTermExtraction } from '@suzu-memory/extraction';
import { createDshGenerator } from '../src/generator.mjs';
import { analysisSchemaForCount, PREFERENCE_SPECIALIST_ANALYZERS, parsePreferenceSpecialistGeneration } from '@suzu-memory/analysis';
import { resolveConfig } from '../src/config.mjs';
import { host, textChunks, eventCandidate } from './helpers.mjs';

const request = { schemaName: 'long-term-memory-extraction-v2', schema: LONG_TERM_EXTRACTION_SCHEMA, systemPrompt: '从对话中提取记忆。', input: '虚构对话。' };
function generator(ctx, controller = new AbortController(), overrides = {}) {
  return createDshGenerator({ llm: ctx.llm, resolveRoute: () => ({ provider: 'test', model: 'deepseek-test' }), signal: controller.signal,
    timeoutMs: 5000, maxTokens: 8192, maximumOutputCharacters: 10000, ...overrides });
}

test('DSH accepts an input-sized analysis contract above eighty with the shared default output budget', async t => {
  const definition = PREFERENCE_SPECIALIST_ANALYZERS.objectGrounding;
  const memories = Array.from({ length: 81 }, (_, index) => ({ id: `memory-${index}`, sourceIds: [`source-${index}`] }));
  const { ctx, adapter } = await host(t, options => {
    const schema = JSON.parse(options.system.split('JSON 对象。不要输出 Markdown 或解释。\n').at(-1));
    assert.equal(schema.properties.analyses.maxItems, 81);
    assert.equal(JSON.parse(options.messages[0].content[0].text).memories.length, 81);
    return textChunks(JSON.stringify({ analyses: memories.map(memory => ({ memoryId: memory.id, sourceIds: memory.sourceIds,
      confidence: 0.9, rationale: 'The supplied statement supports this target.', targetMatch: 'exact', matchedLabel: 'swimming' })) }));
  });
  const result = await generator(ctx, new AbortController(), { maxTokens: resolveConfig({}).analysisMaxTokens, maximumOutputCharacters: 100000 })({
    schemaName: definition.schemaName, schema: analysisSchemaForCount(definition.schema, memories.length),
    analyzerRole: definition.role, systemPrompt: 'Analyze the supplied statements.', input: JSON.stringify({ memories }),
  });
  assert.equal(parsePreferenceSpecialistGeneration(definition.role, result.output, { maximumAnalyses: memories.length }).analyses.length, 81);
  assert.equal(adapter.calls.length, 1);
  assert.equal(adapter.calls[0].maxTokens, 32768);
});

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

test('rejects invalid JSON and delivers candidate validation to the owning Memory task', async t => {
  const { ctx } = await host(t, (_options, count) => textChunks(count === 1 ? 'invalid' : '{"memories":[],"extra":true}'));
  const generate = generator(ctx);
  await assert.rejects(generate(request), { code: 'MEMORY_OUTPUT_INVALID' });
  const result = await generate(request);
  assert.deepEqual(result.output, { memories: [], extra: true });
  assert.throws(() => parseGeneratedLongTermExtraction(result.output), /只能包含 memories/);
});

test('truncation, transport failure and missing finish are not accepted as valid output', async t => {
  const { ctx } = await host(t, (_options, count) => count === 1
    ? [...textChunks('{"memories":[]}').slice(0, -1), { type: 'finish', reason: { kind: 'max-tokens' } }]
    : count === 2 ? [{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'rate limit' } } }]
      : [{ type: 'text-delta', index: 0, text: '{"memories":[]}' }]);
  await assert.rejects(generator(ctx)(request), error => {
    assert.equal(error.code, 'MAX_TOKENS');
    assert.equal(error.usage.output_tokens, 20);
    assert.equal(error.usage.input_tokens, 30);
    assert.equal(error.model, 'deepseek-test');
    assert.equal(error.diagnostics.maxOutputTokens, 8192);
    return true;
  });
  for (let i = 0; i < 2; i++) await assert.rejects(generator(ctx)(request), { code: 'MEMORY_GENERATION_FAILED' });
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

test('the DSH route preserves valid candidates and splits one repaired candidate into multiple memories', async t => {
  const valid = eventCandidate('User visited the museum.');
  const corrected = { ...eventCandidate('User attended a concert.'), title: 'Concert visit' };
  const another = { ...eventCandidate('User watched fireworks.'), title: 'Fireworks' };
  const invalid = { ...corrected, content: 'User attended a concert and watched fireworks.', kind: 'invalid-kind' };
  const { ctx, adapter } = await host(t, (_options, count) => textChunks(JSON.stringify(count === 1
    ? { memories: [valid, invalid] }
    : { results: [{ candidateIndex: 1, status: 'repaired', memories: [corrected, another] }] })));
  const identity = { spaceId: 'test-space', companionId: 'agent', companionName: 'Companion',
    primaryUserId: 'user', primaryUserName: 'User' };
  const database = openMemoryDatabase(':memory:');
  t.after(() => database.close());
  const repository = new MemoryRepository(database);
  appendCompanionEvents({ repository, agentId: 'agent', identity,
    events: [{ protocolVersion: 1, eventId: 'event', spaceId: 'test-space', eventType: 'conversation.turn',
      occurredAt: '2026-08-04T02:00:00Z', knownAt: '2026-08-04T02:00:00Z',
      actor: { role: 'user', id: 'user', name: 'User' }, participants: [],
      world: { id: 'real', frame: 'physical' }, content: { text: 'I visited the museum, attended a concert and watched fireworks.' },
      source: { kind: 'test', locator: 'test://turn' }, metadata: {} }],
  });
  const result = await processPendingCompanionEvents({ repository, agentId: 'agent', identity, generator: generator(ctx) });
  assert.equal(adapter.calls.length, 2);
  assert.deepEqual(result.candidateResults.map(candidate => candidate.status), ['created', 'created', 'created']);
  assert.deepEqual(result.candidateResults.map(candidate => candidate.candidate.content), [valid.content, corrected.content, another.content]);
  const repair = JSON.parse(adapter.calls[1].messages[0].content[0].text);
  assert.deepEqual(repair.candidates.map(item => [item.candidateIndex, item.candidate]), [[1, invalid]]);
  assert.equal(result.generationDiagnostics.unresolvedCandidateCount, 0);
});
