import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryServiceFromConfig } from 'dsh-suzu-memory/memory';
import { runMemoryBenchmark } from 'dsh-suzu-memory/benchmark';

test('public benchmark entry supplies native retrieved evidence before scoring the host answer', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-benchmark-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(typeof createMemoryServiceFromConfig, 'function');
  const report = await runMemoryBenchmark({ config: { agentId: 'benchmark-fixture', providers: {
    generation: { baseUrl: 'https://generation.test/v1', model: 'fixture-extraction', apiKey: 'fixture-key' } } }, outputDirectory: path.join(root, 'run'),
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"memories":[]}' } }] })),
    dataset: { version: 1, name: 'Plugin entry', samples: [{ id: 'fixture',
      identity: { primaryUserId: 'a', primaryUserName: 'Avery', companionId: 'b', companionName: 'Robin' },
      turns: [{ recordedAt: '2026-01-01T00:00:00Z', userMessage: { text: 'Cedar is my cat.' } }],
      questions: [{ id: 'cat', now: '2026-01-02T00:00:00Z', question: 'Cat name?', reference: 'Cedar' }] }] },
    complete: async (messages, options) => {
      if (messages.at(-1).role === 'tool') {
        assert.match(JSON.stringify(messages.at(-1).content), /Cedar is my cat\./);
        return { message: { role: 'assistant', content: 'Cedar' } };
      }
      assert.equal(options.toolChoice.function.name, 'suzu_memory_search');
      return { message: { role: 'assistant', tool_calls: [{ id: 'lookup', type: 'function',
        function: { name: 'suzu_memory_search', arguments: '{"query":"cat name"}' } }] } };
    },
  });
  assert.equal(report.status, 'completed'); assert.equal(report.summary.correct, 1);
  assert.equal(report.rows[0].search.searches, 1);
});
