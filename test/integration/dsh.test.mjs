import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import test from 'node:test';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createMemoryService } from '@suzu-memory/service';
import * as plugin from '../../src/index.mjs';
import { sessionMemoryId } from '../../src/events.mjs';
import { DshMemoryRuntime } from '../../src/runtime.mjs';
import { host, config, textChunks, eventCandidate, enableConversation } from '../helpers.mjs';

test('a memory storage failure warns while DSH still creates and chats in the session', async t => {
  const { ctx } = await host(t, () => textChunks('正常回复。'));
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(AgentLoop, { agents: [] });
  const warnings = [];
  t.mock.method(DshMemoryRuntime.prototype, 'report', error => warnings.push(error));
  const settings = config(t, { consoleEnabled: false });
  fs.writeFileSync(path.join(settings.dataRoot, 'agents'), 'blocked memory directory');
  const fiber = ctx.plugin(plugin, settings);
  await fiber;
  const handle = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('memory-storage-fault'),
    agentOptions: { provider: 'test', model: 'deepseek-test' } });
  try {
    await enableConversation(ctx, handle.agent);
    assert.ok(warnings.length > 0);
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: '会话仍然可以使用。' }], source: { kind: 'user' } }));
    await handle.agent.whenIdle();
    assert.ok(handle.agent.session.snapshotEvents().some(event => event.type === 'assistant/message'));
  } finally { await handle.dispose(); await fiber.dispose(); }
});

test('the installed DSH services run conversation, maintenance, recall, and plugin unload', async t => {
  let search = false;
  const { ctx, adapter } = await host(t, options => {
    if (options.system?.includes('JSON Schema')) {
      const schema = JSON.parse(options.system.split('JSON 对象。不要输出 Markdown 或解释。\n').at(-1));
      if (schema.properties?.memories) return textChunks(JSON.stringify({ memories: [eventCandidate()] }));
      const output = Object.fromEntries(Object.entries(schema.properties || {}).map(([name, value]) => [name, value.type === 'array' ? [] : value.type === 'string' ? (value.enum?.[0] || '') : value.type === 'boolean' ? false : 0]));
      return textChunks(JSON.stringify(output));
    }
    if (search) {
      search = false;
      const id = ToolCallId('recall-1');
      return [{ type: 'tool-call-delta', index: 0, id, name: 'suzu_memory_search', argumentsDelta: '{"query":"灯塔博物馆"}' },
        { type: 'finish', reason: { kind: 'tool-calls' } }];
    }
    return textChunks('我记得灯塔博物馆。');
  });
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(AgentLoop, { agents: [] });
  const settings = config(t);
  const fiber = ctx.plugin(plugin, settings);
  await fiber;
  const handle = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('conversation-integration'), agentOptions: { provider: 'test', model: 'deepseek-test' } });
  const agent = handle.agent;
  await enableConversation(ctx, agent);
  agent.followup(createUserMessage({ content: [{ type: 'text', text: '今天去了灯塔博物馆。' }], source: { kind: 'user' } }));
  await agent.whenIdle();
  const memory = createMemoryService({ dataRoot: settings.dataRoot, agentId: sessionMemoryId(agent.id), defaults: { memoryOwner: 'Assistant', primaryUserId: 'user', userName: 'User' } });
  assert.equal(memory.listInputEvents().total, 2);
  const maintain = await ctx.commands.execute(agent, '/suzu-memory-maintain', [], new AbortController().signal);
  assert.equal(maintain.result.kind, 'success', JSON.stringify(maintain));
  assert.match(maintain.result.text, /completed/);
  const status = await ctx.commands.execute(agent, '/suzu-memory-status', [], new AbortController().signal);
  const url = new URL(JSON.parse(status.result.text).consoleUrl);
  const prior = adapter.calls.filter(call => !call.system?.includes('JSON Schema')).at(-1);
  assert.ok(!prior.system?.includes('Suzu Memory'));
  assert.deepEqual(prior.tools.map(tool => tool.name), ['suzu_memory_search']);
  search = true;
  agent.followup(createUserMessage({ content: [{ type: 'text', text: '我之前去了哪里？' }], source: { kind: 'user' } }));
  await agent.whenIdle();
  const logs = agent.session.snapshotEvents();
  const results = logs.filter(event => event.type === 'tool/result');
  assert.ok(results.some(event => JSON.stringify(event.data).includes('灯塔博物馆')));
  const subsequent = adapter.calls.filter(call => !call.system?.includes('JSON Schema')).at(-1);
  assert.deepEqual(subsequent.messages.slice(0, prior.messages.length), prior.messages);
  assert.ok(!JSON.stringify(subsequent.messages).includes('consoleUrl'));
  assert.ok(!JSON.stringify(subsequent.messages).includes('suzu-memory-maintain'));
  fs.writeFileSync(path.join(settings.dataRoot, 'console-evidence.json'), JSON.stringify({ pid: process.pid, port: Number(url.port), state: 'listening' }));
  await handle.dispose();
  await fiber.dispose();
  const missing = await ctx.tools.execute({ callId: ToolCallId('after-dispose'), name: 'suzu_memory_search', arguments: { query: 'museum' }, signal: new AbortController().signal });
  assert.equal(missing.isError, true);
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(url.port), '127.0.0.1', resolve); });
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  fs.writeFileSync(path.join(settings.dataRoot, 'console-evidence.json'), JSON.stringify({ pid: process.pid, port: Number(url.port), state: 'closed-and-rebound' }));
});

test('normal DSH short conversations make no analysis calls until explicit maintenance', async t => {
  const { ctx, adapter } = await host(t, options => options.system?.includes('JSON Schema')
    ? textChunks('{"memories":[]}') : textChunks('收到。'));
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(AgentLoop, { agents: [] });
  await ctx.plugin(plugin, config(t, { automaticMaintenance: true }));
  const handle = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('automatic-maintenance'), agentOptions: { provider: 'test', model: 'deepseek-test' } });
  await enableConversation(ctx, handle.agent);
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: '这是虚构测试对话。' }], source: { kind: 'user' } }));
  await handle.agent.whenIdle();
  assert.ok(!adapter.calls.some(call => call.system?.includes('JSON Schema')));
  const result = await ctx.commands.execute(handle.agent, '/suzu-memory-maintain', [], new AbortController().signal);
  assert.equal(result.result.kind, 'success', JSON.stringify(result));
  assert.ok(adapter.calls.some(call => call.system?.includes('JSON Schema')));
  await handle.dispose();
});

test('complete DSH turns schedule length batches while idle notifications do no work', { timeout: 15000 }, async t => {
  let release, reached;
  const gate = new Promise(resolve => { release = resolve; });
  const stopping = new Promise(resolve => { reached = resolve; });
  const jobs = [];
  const maintain = DshMemoryRuntime.prototype.maintain;
  t.mock.method(DshMemoryRuntime.prototype, 'maintain', function (...args) {
    const work = maintain.apply(this, args); jobs.push(work); return work;
  });
  const { ctx, adapter } = await host(t, options => options.system?.includes('JSON Schema')
    ? textChunks('{"memories":[]}') : textChunks('回复'.padEnd(100, '乙')));
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(AgentLoop, { agents: [] });
  ctx.on('agent/turn-stopping', async ({ turn }) => { if (turn === 3) { reached(); await gate; } });
  const settings = config(t, { automaticMaintenance: true, archiveBatchCharacters: 1000, consoleEnabled: false });
  const fiber = ctx.plugin(plugin, settings);
  await fiber;
  const handle = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('length-batch-scheduling'),
    agentOptions: { provider: 'test', model: 'deepseek-test' } });
  const agent = handle.agent;
  await enableConversation(ctx, agent);
  const memory = createMemoryService({ dataRoot: settings.dataRoot, agentId: sessionMemoryId(agent.id) });
  const say = n => agent.followup(createUserMessage({ content: [{ type: 'text', text: `${n}用户`.padEnd(400, '甲') }], source: { kind: 'user' } }));
  const analysisCalls = () => adapter.calls.filter(call => call.system?.includes('JSON Schema'));
  try {
    for (let n = 1; n <= 2; n++) { say(n); await agent.whenIdle(); await Promise.all(jobs); }
    assert.equal(analysisCalls().length, 0);
    say(3); await stopping;
    assert.equal(memory.listInputEvents().total, 6);
    const before = jobs.length;
    for (let n = 0; n < 10; n++) ctx.emit('agent/status', { agent, status: 'idle' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(jobs.length, before, 'idle notifications never schedule maintenance');
    assert.equal(analysisCalls().length, 0, 'the following turn has not ended yet');
    release(); await agent.whenIdle(); await Promise.all(jobs);
    assert.equal(analysisCalls().length, 1);
    assert.equal(memory.listInputEvents({ statuses: ['archived'] }).total, 4);
    assert.equal(memory.listInputEvents().total, 2);
  } finally {
    release(); await handle.dispose(); await fiber.dispose(); await Promise.allSettled(jobs); await memory.close();
  }
});
