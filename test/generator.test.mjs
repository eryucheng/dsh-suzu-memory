import { appendCompanionEvents, processPendingCompanionEvents } from '@suzu-memory/ingestion';
import { MemoryRepository, openMemoryDatabase } from '@suzu-memory/core';
import assert from 'node:assert/strict';
import test from 'node:test';
import { LONG_TERM_EXTRACTION_SCHEMA, parseGeneratedLongTermExtraction } from '@suzu-memory/extraction';
import { createDshGenerator } from '../src/generator.mjs';
import { analysisSchemaForCount, PREFERENCE_SPECIALIST_ANALYZERS, parsePreferenceSpecialistGeneration } from '@suzu-memory/analysis';
import { resolveConfig } from '../src/config.mjs';
import { proposeStructuresForBatch, prepareStructureGeneration } from '@suzu-memory/structurer';
import { host, textChunks, eventCandidate } from './helpers.mjs';

const request = { schemaName: 'long-term-memory-extraction-v4', schema: LONG_TERM_EXTRACTION_SCHEMA, systemPrompt: '从对话中提取记忆。', input: '虚构对话。' };
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

test('DSH organization sends local references and retains canonical membership and complete memory text', async t => {
  const database = openMemoryDatabase(':memory:'); t.after(() => database.close());
  const repository = new MemoryRepository(database), agentId = 'owner';
  const contents = ['Lin visited the museum. 最后确认参观已完成。', 'Lin attended the museum exhibition.'];
  const ids = ['canonical-museum-event', 'canonical-exhibition-event'];
  ids.forEach((id, index) => repository.upsertMemory({ id, agentId, kind: 'event', layer: 'episodic', content: contents[index] }));
  const { ctx, adapter } = await host(t, options => {
    const input = JSON.parse(options.messages[0].content[0].text);
    if (input.members) {
      assert.ok(input.members.some(memory => memory.content === 'Lin returned to the space exhibit.'));
      return textChunks(JSON.stringify({ title: 'Museum activities', content: 'Lin visits museum exhibitions and returns to the space exhibit.' }));
    }
    if (input.candidateContainers.length) {
      return textChunks(JSON.stringify({ creations: [], attachments: input.memories.map(memory => ({
        targetMemoryId: input.candidateContainers[0].id, title: '', content: 'Museum activities.', memberIds: [memory.id],
        confidence: 0.9, rationale: 'The visit develops the same topic.' })) }));
    }
    assert.deepEqual(input.memories.map(memory => memory.content), contents);
    assert.ok(input.memories.every(memory => !ids.includes(memory.id)));
    return textChunks(JSON.stringify({ attachments: [], creations: [{ kind: 'topic',
      title: 'Museum activities', content: 'Lin visited the museum and its exhibition.', subjectRole: 'unknown', subjectKey: '',
      memberIds: input.memories.map(memory => memory.id), actorRoles: [],
      confidence: 0.9, rationale: 'Both records describe museum activities.' }] }));
  });
  const generate = generator(ctx), prepared = prepareStructureGeneration({ repository, agentId, memoryIds: ids, generator: generate });
  const result = await proposeStructuresForBatch({ repository, agentId, memoryIds: ids, generator: generate, preparedGeneration: prepared });
  assert.equal(result.status, 'proposed'); assert.equal(adapter.calls.length, 1);
  assert.deepEqual(result.proposed[0].memberIds.slice().sort(), ids.slice().sort());
  assert.equal(generate.measureRequest(prepared.request), JSON.stringify({ system: adapter.calls[0].system, messages: adapter.calls[0].messages }).length);
  const nextIds = ['return-to-exhibit', 'learn-about-space'];
  nextIds.forEach(id => repository.upsertMemory({ id, agentId, kind: 'event', layer: 'episodic',
    content: id === nextIds[0] ? 'Lin returned to the space exhibit.' : 'Lin learned about the space exhibit.' }));
  const updated = await proposeStructuresForBatch({ repository, agentId, memoryIds: nextIds,
    nearbyContainerIds: [result.proposed[0].result_memory_id], generator: generate });
  assert.deepEqual(updated.rejected, []); assert.equal(updated.proposed.length, 1);
  assert.equal(adapter.calls.length, 3, 'Both attachments share one complete summary reconstruction through the real DSH route.');
  const topic = repository.getMemory(result.proposed[0].result_memory_id);
  assert.match(topic.content, /returns to the space exhibit/);
  assert.equal(repository.listTopicMembers({ agentId, topicId: topic.id }).length, 4);
});

test('rejects invalid JSON and delivers candidate validation to the owning Memory task', async t => {
  const { ctx } = await host(t, (_options, count) => textChunks(count === 1 ? 'invalid' : '{"memories":[],"extra":true}'));
  const generate = generator(ctx);
  await assert.rejects(generate(request), error => {
    assert.equal(error.code, 'MEMORY_OUTPUT_INVALID');
    assert.equal(error.model, 'deepseek-test');
    assert.equal(error.usage.input_tokens, 30);
    assert.equal(error.usage.output_tokens, 20);
    return true;
  });
  const result = await generate(request);
  assert.deepEqual(result.output, { memories: [], extra: true });
  assert.throws(() => parseGeneratedLongTermExtraction(result.output), /不适用：extra/);
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
    try {
      yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 20 } };
      yield { type: 'text-delta', index: 0, text: 'x'.repeat(200) };
    }
    finally { returned = true; }
  } }; } };
  await assert.rejects(generator({ llm }, new AbortController(), { maximumOutputCharacters: 100 })(request), error =>
    error.code === 'MEMORY_OUTPUT_LIMIT' && error.usage.input_tokens === 30 && error.usage.output_tokens === 20);
  assert.equal(returned, true);
});

test('the DSH route preserves valid candidates and splits one repaired candidate into multiple memories', async t => {
  const valid = eventCandidate('User visited the museum.');
  const corrected = { ...eventCandidate('User attended a concert.'), title: 'Concert visit' };
  const another = { ...eventCandidate('User watched fireworks.'), title: 'Fireworks' };
  const invalid = { ...corrected, content: 'User attended a concert and watched fireworks.', classification: { category: 'invalid-kind' } };
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
