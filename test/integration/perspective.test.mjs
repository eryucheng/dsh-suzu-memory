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
import { host, config, user, assistant, enableConversation } from '../helpers.mjs';

test('DSH memory tool preserves speaker attribution for model-authored queries', async t => {
  const { ctx } = await host(t);
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(AgentLoop, { agents: [] });
  const settings = config({ memoryOwner: 'Suzu', userName: 'Rin', consoleEnabled: false });
  const fiber = ctx.plugin(plugin, settings);
  await fiber;
  const handle = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('perspective-conversation'),
    agentOptions: { provider: 'test', model: 'deepseek-test' } });
  try {
    await enableConversation(ctx, handle.agent);
    const value = handle.agent.session;
    user(value, '我喜欢吃火锅，最爱番茄锅。我答应周末陪家人去看电影。I like hotpot. I promised to watch a movie with my family.');
    assistant(value, '我不喜欢吃火锅，尤其是麻辣锅。我答应周末陪用户去看电影。I dislike hotpot. I promised to watch a movie with the user.');
    const memory = createMemoryService({ dataRoot: settings.dataRoot, agentId: sessionMemoryId(value.id),
      defaults: { memoryOwner: 'Suzu', primaryUserId: 'user', userName: 'Rin' } });
    await memory.processPendingEvents({ sourceScope: sourceScope(value), generator: async () => ({ output: { memories: [] } }) });
    const utterances = memory.listMemories({ kinds: ['utterance'] }).items;
    assert.equal(utterances.length, 2);
    let sequence = 0;
    for (const [query, role] of [
      ['你喜欢吃火锅吗', 'user'],
      ['我答应周末陪用户去看电影', 'agent'],
      ['我喜欢吃火锅吗', 'agent'],
      ['Do you like hotpot?', 'user'],
      ['I promise to watch a movie', 'agent'],
      ['Rin likes hotpot', 'user'],
      ['Suzu likes hotpot', 'agent'],
      ['Rin喜欢吃火锅吗', 'user'],
      ['Suzu喜欢吃火锅吗', 'agent'],
    ]) await t.test(query, async () => {
      value.append('turn/start', { turn: sequence + 2 });
      const result = await ctx.tools.execute({ callId: ToolCallId(`perspective-${++sequence}`),
        name: 'suzu_memory_search', arguments: { query }, agent: handle.agent, signal: new AbortController().signal });
      assert.equal(result.isError, false, JSON.stringify(result));
      const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      assert.match(text, /^记忆编号：/u);
      const recordIds = [...text.matchAll(/^记忆编号：(.*)$/gmu)].map(match => match[1]);
      assert.equal(new Set(recordIds).size,recordIds.length);
      for (const [holder, name] of [['user', 'Rin'], ['agent', 'Suzu']]) {
        const phrase = holder === 'user' ? 'I like hotpot.' : 'I dislike hotpot.';
        const evidence = text.split('\n\n').find(block => block.includes(phrase));
        if (evidence) assert.match(evidence, new RegExp('\\] ' + name + '：'));
      }
      const sourcePhrase = role === "user" ? "I like hotpot." : "I dislike hotpot.";
      assert.equal(text.split(sourcePhrase).length - 1, 1, "selected source text must appear once");
    });
    await t.test('displayed recall activates memories with the default service policy', async () => {
      const states = memory.withRepository(repository => repository.listMemoryRecallReactivationStates(memory.agentId));
      assert.ok(states.length > 0);
      assert.ok(states.every(state => state.activation_count > 0));
    });
    await t.test('structured preference text retains the holder and does not repeat returned evidence', async () => {
      value.append('turn/start', { turn: ++sequence + 1 });
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
        name: 'suzu_memory_search', arguments: { query: 'Rin喜欢吃火锅吗' }, agent: handle.agent, signal: new AbortController().signal });
      assert.equal(result.isError, false, JSON.stringify(result));
      const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      assert.ok(text.includes('Rin明确表示喜欢吃火锅。'), text);
      for (const phrase of ['I like hotpot.', 'I dislike hotpot.']) {
        if (text.includes(phrase)) assert.equal(text.split(phrase).length - 1, 1);
      }
    });
    await t.test('long original evidence retains its final fact under the default capacity', async () => {
      const content='远山露营经历。'+ '路途中记录了沿途的风景和行程细节。'.repeat(120)+'最后确认：露营地点是青石湖。';
      user(value,content,++sequence + 1);assistant(value,'记住了。',sequence + 1);
      await memory.processPendingEvents({sourceScope:sourceScope(value),generator:async()=>({output:{memories:[]}})});
      const result=await ctx.tools.execute({callId:ToolCallId('long-evidence'),name:'suzu_memory_search',arguments:{query:'远山露营经历'},
        agent:handle.agent,signal:new AbortController().signal});
      assert.equal(result.isError,false,JSON.stringify(result));
      const text=result.content.filter(block=>block.type==='text').map(block=>block.text).join('\n');
      assert.ok(text.includes(content),text);
      assert.ok(text.length<=settings.recallMaximumCharacters);
    });
  } finally {
    await handle.dispose();
    await fiber.dispose();
  }
});

test('DSH shares concurrent recall, delivers evidence once per turn, and resets for the next turn', async t => {
  const { ctx, adapter } = await host(t);
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(AgentLoop, { agents: [] });
  const settings = config({ memoryOwner: 'Suzu', userName: 'Lin', consoleEnabled: false });
  const fiber = ctx.plugin(plugin, settings); await fiber;
  const handle = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('recall-session'),
    agentOptions: { provider: 'test', model: 'deepseek-test' } });
  let prototype, original;
  try {
    await enableConversation(ctx, handle.agent);
    const value = handle.agent.session;
    user(value, '昨天去了山谷博物馆。'); assistant(value, '记住了。');
    const memory = createMemoryService({ dataRoot: settings.dataRoot, agentId: sessionMemoryId(value.id) });
    await memory.processPendingEvents({ sourceScope: sourceScope(value), generator: async () => ({ output: { memories: [] } }) });
    prototype = Object.getPrototypeOf(memory); original = prototype.search;
    const reads = [];
    prototype.search = function(query, options) { reads.push(options); return original.call(this, query, options); };
    let call = 0;
    const execute = async () => {
      const result = await ctx.tools.execute({ callId: ToolCallId(`shared-${++call}`), name: 'suzu_memory_search',
        arguments: { query: '山谷博物馆' }, agent: handle.agent, signal: new AbortController().signal });
      assert.equal(result.isError, false, JSON.stringify(result));
      return result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
    };
    const parallel = await Promise.all([execute(), execute()]);
    assert.equal(reads.length, 1);
    assert.equal(parallel.filter(text => text.includes('昨天去了山谷博物馆。')).length, 1);
    assert.match(parallel.find(text => text.includes('昨天去了山谷博物馆。')), /^记忆编号：m1\n/u);
    assert.ok(!(await execute()).includes('昨天去了山谷博物馆。'));
    const afterExhaustion = reads.length;
    await execute();
    assert.equal(reads.length, afterExhaustion, 'The unchanged exhausted query reuses its result.');
    user(value, '再回想一下昨天去哪了。', 2);
    assert.ok((await execute()).includes('昨天去了山谷博物馆。'));
    assert.equal(adapter.calls.length, 0);
  } finally {
    if (prototype && original) prototype.search = original;
    await handle.dispose(); await fiber.dispose();
  }
});
