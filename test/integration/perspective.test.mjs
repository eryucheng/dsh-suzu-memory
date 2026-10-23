import assert from 'node:assert/strict';
import test from 'node:test';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createMemoryService } from '@suzu-memory/service';
import * as plugin from '../../src/index.mjs';
import { sessionMemoryId, sourceScope } from '../../src/events.mjs';
import { host, config, user, assistant } from '../helpers.mjs';

test('DSH memory tool resolves model-authored pronouns and named people against the right actors', async t => {
  const { ctx } = await host(t);
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(AgentLoop, { agents: [] });
  const settings = config(t, { memoryOwner: 'Suzu', userName: 'Rin', consoleEnabled: false });
  const fiber = ctx.plugin(plugin, settings);
  await fiber;
  const handle = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('perspective-conversation'),
    agentOptions: { provider: 'test', model: 'deepseek-test' } });
  try {
    const value = handle.agent.session;
    user(value, '我喜欢吃火锅，最爱番茄锅。我答应周末陪家人去看电影。I like hotpot. I promised to watch a movie with my family.');
    assistant(value, '我不喜欢吃火锅，尤其是麻辣锅。我答应周末陪用户去看电影。I dislike hotpot. I promised to watch a movie with the user.');
    const memory = createMemoryService({ dataRoot: settings.dataRoot, agentId: sessionMemoryId(value.id),
      defaults: { memoryOwner: 'Suzu', primaryUserId: 'user', userName: 'Rin' } });
    await memory.processPendingEvents({ sourceScope: sourceScope(value), generator: async () => ({ output: { memories: [] } }) });
    const utterances = memory.listMemories({ kinds: ['utterance'] }).items;
    assert.equal(utterances.length, 2);
    const ids = Object.fromEntries(utterances.map(node => [node.subject_role, node.id]));
    let sequence = 0;
    for (const [query, role] of [
      ['你喜欢吃火锅吗', 'user'],
      ['我答应周末陪用户去看电影', 'agent'],
      ['我喜欢吃火锅吗', 'agent'],
      ['Do you like hotpot?', 'user'],
      ['I promise to watch a movie', 'agent'],
      ['Rin likes hotpot', 'user'],
      ['Suzu likes hotpot', 'agent'],
    ]) await t.test(query, async () => {
      const result = await ctx.tools.execute({ callId: ToolCallId(`perspective-${++sequence}`),
        name: 'suzu_memory_search', arguments: { query }, agent: handle.agent, signal: new AbortController().signal });
      assert.equal(result.isError, false, JSON.stringify(result));
      const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      const candidateIds = text.match(/^记忆 ID：(.*)$/mu)?.[1].split('、').filter(Boolean) || [];
      assert.ok(candidateIds.includes(ids[role]), text);
      assert.ok(!candidateIds.includes(ids[role === 'user' ? 'agent' : 'user']), text);
    });
    await t.test('structured preferences keep the queried holder and reject the other actor', async () => {
      const sources = Object.fromEntries(utterances.map(node => [node.subject_role, memory.getMemory(node.id).sources[0].id]));
      memory.withRepository(repository => {
        for (const [role, key, name] of [['user', 'user', 'Rin'], ['agent', sessionMemoryId(value.id), 'Suzu']]) {
          const id = `${role}-hotpot-preference`;
          repository.upsertMemory({ id, agentId: sessionMemoryId(value.id), kind: 'preference', layer: 'semantic',
            content: `${name}明确表示${role === 'agent' ? '不' : ''}喜欢吃火锅。`, subjectRole: role, subjectKey: key,
            canonicalKey: `${role}:preference:hotpot`, representationLayer: 'reported', stateFamily: 'preference',
            statePhase: 'active', temporalState: 'current', evidenceMode: 'explicit' });
          repository.linkSource(id, sources[role], 'supports');
        }
      });
      const result = await ctx.tools.execute({ callId: ToolCallId('structured-preference'),
        name: 'suzu_memory_search', arguments: { query: '你喜欢吃火锅吗' }, agent: handle.agent, signal: new AbortController().signal });
      assert.equal(result.isError, false, JSON.stringify(result));
      const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      const candidateIds = text.match(/^记忆 ID：(.*)$/mu)?.[1].split('、').filter(Boolean) || [];
      assert.ok(candidateIds.includes('user-hotpot-preference'), text);
      assert.ok(!candidateIds.includes('agent-hotpot-preference'), text);
    });
  } finally {
    await handle.dispose();
    await fiber.dispose();
  }
});
