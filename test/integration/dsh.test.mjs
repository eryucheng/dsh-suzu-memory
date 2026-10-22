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
import { host, config, textChunks, eventCandidate } from '../helpers.mjs';

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
  agent.followup(createUserMessage({ content: [{ type: 'text', text: '今天去了灯塔博物馆。' }], source: { kind: 'user' } }));
  await agent.whenIdle();
  const memory = createMemoryService({ dataRoot: settings.dataRoot, agentId: sessionMemoryId(agent.id), defaults: { memoryOwner: 'Assistant', primaryUserId: 'user', userName: 'User' } });
  assert.equal(memory.listInputEvents().total, 2);
  const maintain = await ctx.tools.execute({ callId: ToolCallId('maintain-1'), name: 'suzu_memory_maintain', arguments: {}, agent, signal: new AbortController().signal });
  assert.equal(Boolean(maintain.isError), false, JSON.stringify(maintain));
  assert.match(maintain.content[0].text, /completed/);
  const prior = adapter.calls.filter(call => !call.system?.includes('JSON Schema')).at(-1);
  search = true;
  agent.followup(createUserMessage({ content: [{ type: 'text', text: '我之前去了哪里？' }], source: { kind: 'user' } }));
  await agent.whenIdle();
  const logs = agent.session.snapshotEvents();
  const results = logs.filter(event => event.type === 'tool/result');
  assert.ok(results.some(event => JSON.stringify(event.data).includes('灯塔博物馆')));
  const subsequent = adapter.calls.filter(call => !call.system?.includes('JSON Schema')).at(-1);
  assert.deepEqual(subsequent.messages.slice(0, prior.messages.length), prior.messages);
  const status = await ctx.tools.execute({ callId: ToolCallId('status-1'), name: 'suzu_memory_status', arguments: {}, agent, signal: new AbortController().signal });
  const url = new URL(JSON.parse(status.content[0].text).consoleUrl);
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

test('the normal DSH idle transition starts background Memory maintenance', async t => {
  const { ctx, adapter } = await host(t, options => options.system?.includes('JSON Schema')
    ? textChunks('{"memories":[]}') : textChunks('收到。'));
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(AgentLoop, { agents: [] });
  await ctx.plugin(plugin, config(t, { automaticMaintenance: true }));
  const handle = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('automatic-maintenance'), agentOptions: { provider: 'test', model: 'deepseek-test' } });
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: '这是虚构测试对话。' }], source: { kind: 'user' } }));
  await handle.agent.whenIdle();
  const result = await ctx.tools.execute({ callId: ToolCallId('await-maintenance'), name: 'suzu_memory_maintain', arguments: {}, agent: handle.agent, signal: new AbortController().signal });
  assert.equal(Boolean(result.isError), false, JSON.stringify(result));
  assert.ok(adapter.calls.some(call => call.system?.includes('JSON Schema')));
  await handle.dispose();
});
