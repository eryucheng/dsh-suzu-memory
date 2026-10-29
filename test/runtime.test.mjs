import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import test from 'node:test';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { DshMemoryRuntime } from '../src/runtime.mjs';
import { resolveConfig } from '../src/config.mjs';
import { sourceScope } from '../src/events.mjs';
import { host, config, session, user, assistant, textChunks, eventCandidate } from './helpers.mjs';

test('memory uses the configured timezone and follows the system when it is omitted', async t => {
  const { ctx } = await host(t);
  for (const timeZone of ['', 'America/Los_Angeles']) {
    const runtime = new DshMemoryRuntime(ctx, config(t, { timeZone }), () => true);
    try {
      const entry = runtime.require(session());
      assert.equal(entry.memory.defaults.retrieval.timeZone, timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone);
    } finally { await runtime.close(); }
  }
  assert.throws(() => resolveConfig({ timeZone: 'not-a-timezone' }), RangeError);
});

test('committed conversation text keeps host identities and excludes injected context and failed attempts', async t => {
  const { ctx } = await host(t);
  const runtime = new DshMemoryRuntime(ctx, config(t), () => true);
  t.after(() => runtime.close());
  const value = session();
  user(value, '今天去了灯塔博物馆。');
  assistant(value, '你最喜欢哪个展区？');
  value.append('user/message', createUserMessage({ content: [{ type: 'text', text: '技能注入材料' }], source: { kind: 'skill', summary: 'skill', cause: 'test' } }), { surfaceOp: 'append' });
  value.append('assistant/attempt', { turn: 1, step: 2, stream: [] });
  const { entry, inserted } = runtime.consume(value);
  assert.equal(inserted, 2);
  const events = entry.memory.listInputEvents().items;
  assert.equal(events.length, 2);
  assert.deepEqual(new Set(events.map(event => event.actor_role)), new Set(['user', 'companion']));
  assert.ok(events.every(event => event.metadata.eventSource.dsh.sessionId === value.id));
  assert.ok(events.every(event => event.metadata.eventSource.dsh.messageId));
});

test('resume consumes only the missing suffix and repeated notifications read no history', async t => {
  const { ctx } = await host(t);
  const options = config(t, { historyBatchSize: 2 });
  let runtime = new DshMemoryRuntime(ctx, options, () => true);
  const value = session();
  user(value, '第一条'); assistant(value, '回复一');
  const ranges = [];
  const snapshot = value.snapshotEvents.bind(value);
  value.snapshotEvents = (from, to) => { ranges.push([Number(from), Number(to)]); return snapshot(from, to); };
  runtime.consume(value);
  const upper = Number(value.seq);
  ranges.length = 0;
  runtime.consume(value);
  assert.deepEqual(ranges, []);
  await runtime.close();
  runtime = new DshMemoryRuntime(ctx, options, () => true);
  t.after(() => runtime.close());
  user(value, '第二条', 2);
  const { entry } = runtime.consume(value);
  assert.ok(ranges.every(([from]) => from >= upper));
  assert.equal(entry.memory.listInputEvents().total, 3);
});

test('a new message after a large history reads only its new log range', async t => {
  const { ctx } = await host(t);
  const options = config(t);
  const runtime = new DshMemoryRuntime(ctx, options, () => true);
  t.after(() => runtime.close());
  const value = session();
  for (let turn = 1; turn <= 1000; turn++) user(value, `虚构历史 ${turn}`, turn);
  runtime.consume(value);
  const upper = Number(value.seq);
  const snapshot = value.snapshotEvents.bind(value);
  const ranges = [];
  value.snapshotEvents = (from, to) => { ranges.push([Number(from), Number(to)]); return snapshot(from, to); };
  runtime.consume(value);
  assert.equal(ranges.length, 0);
  user(value, '一条新增消息', 1001);
  runtime.consume(value);
  assert.deepEqual(ranges, [[upper, upper + 2]]);
  fs.writeFileSync(path.join(options.dataRoot, 'read-evidence.json'), JSON.stringify({ historyMessages: 1000,
    unchangedReads: 0, incrementalReads: ranges, readEvents: 2, pid: process.pid }));
});

test('an interrupted acknowledgement can replay the same committed input without duplicates', async t => {
  const { ctx } = await host(t);
  const runtime = new DshMemoryRuntime(ctx, config(t), () => true);
  t.after(() => runtime.close());
  const value = session(); user(value, '记住这条经历。');
  const entry = runtime.require(value);
  const append = entry.memory.appendEventSources.bind(entry.memory);
  const stub = t.mock.method(entry.memory, 'appendEventSources', input => { append(input); throw new Error('injected lost acknowledgement'); });
  assert.throws(() => runtime.consume(value), /injected lost acknowledgement/);
  stub.mock.restore();
  runtime.consume(value);
  assert.equal(entry.memory.listInputEvents().total, 1);
});

test('real Memory extraction and retrieval use the DSH model bridge', async t => {
  const { ctx, adapter } = await host(t, () => textChunks(JSON.stringify({ memories: [eventCandidate()] })));
  const runtime = new DshMemoryRuntime(ctx, config(t), () => true);
  t.after(() => runtime.close());
  const value = session(); user(value, '今天去了灯塔博物馆。');
  const { entry } = runtime.consume(value);
  const processed = await entry.memory.processPendingEvents({ generator: entry.generator, runMaintenance: false, sourceScope: sourceScope(value) });
  assert.equal(processed.status, 'processed');
  const recalled = await entry.memory.search('灯塔博物馆', { persistTrace: false, sourceScope: sourceScope(value) });
  assert.equal(recalled.status, 'ready');
  assert.match(recalled.context, /灯塔博物馆/);
  assert.match(adapter.calls[0].messages[0].content[0].text, /今天去了灯塔博物馆/);
  assert.ok(entry.memory.listMemories().items.some(memory => memory.title === '参观灯塔博物馆'));
});

test('concurrent maintenance requests reuse one execution and shutdown aborts it', async t => {
  const { ctx } = await host(t);
  const runtime = new DshMemoryRuntime(ctx, config(t), () => true);
  t.after(() => runtime.close());
  const value = session(); user(value, '一个待处理事件');
  const entry = runtime.require(value);
  let calls = 0;
  let finished = false;
  entry.memory.runMaintenance = ({ signal }) => new Promise((resolve, reject) => {
    calls++;
    signal.addEventListener('abort', () => { finished = true; reject(signal.reason); }, { once: true });
  });
  const first = runtime.maintain(value).catch(error => error);
  const second = runtime.maintain(value).catch(error => error);
  assert.equal(calls, 1);
  await runtime.close();
  await Promise.all([first, second]);
  assert.equal(finished, true);
  assert.equal(runtime.sessions.size, 0);
});

test('the existing review console closes its listening socket with the session', async t => {
  const { ctx } = await host(t);
  const runtime = new DshMemoryRuntime(ctx, config(t), () => true);
  t.after(() => runtime.close());
  const value = session();
  user(value, '一条用于审核台维护的虚构消息。');
  const { entry } = runtime.consume(value);
  const address = await runtime.consoleUrl(entry);
  const url = new URL(address);
  fs.writeFileSync(path.join(runtime.config.dataRoot, 'console-evidence.json'), JSON.stringify({ pid: process.pid, port: Number(url.port), state: 'listening' }));
  const response = await fetch(address);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Suzu Memory/);
  const maintenance = await fetch(`${url.origin}/v1/maintenance/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lane: 'semantic' }) });
  const maintained = await maintenance.json();
  assert.equal(maintenance.status, 200, JSON.stringify(maintained));
  assert.equal(maintained.data.lane, 'semantic');
  await runtime.close();
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(url.port), '127.0.0.1', resolve); });
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  fs.writeFileSync(path.join(runtime.config.dataRoot, 'console-evidence.json'), JSON.stringify({ pid: process.pid, port: Number(url.port), state: 'closed-and-rebound' }));
});

test('the workbench switches live and cold libraries without restoring logs or starting model work', async t => {
  const { ctx, adapter } = await host(t, () => textChunks(JSON.stringify({ memories: [eventCandidate()] })));
  const settings = config(t);
  const cold = session('saved-conversation');
  user(cold, '今天去了灯塔博物馆。');
  const writer = new DshMemoryRuntime(ctx, settings, () => true);
  const { entry } = writer.consume(cold);
  await entry.memory.processPendingEvents({ generator: entry.generator, runMaintenance: false, sourceScope: sourceScope(cold) });
  const memoryId = entry.memory.brainSnapshot().nodes.find(node => node.title === '参观灯塔博物馆').id;
  user(cold, '已入库尚未整理的虚构内容。'.repeat(5000), 2);
  writer.consume(cold);
  const captured = entry.memory.listInputEvents({ statuses: [] }).total;
  const actors = memory => memory.withRepository(repository => ['user', 'agent'].map(role => {
    const binding = repository.getActorEntityBinding({ agentId: memory.agentId, actorRole: role,
      actorKey: role === 'user' ? 'user' : memory.agentId });
    return { displayName: binding.display_name, aliases: repository.getEntity(memory.agentId, binding.entity_id).aliases };
  }), { readOnly: true });
  const originalActors = actors(entry.memory), originalTimeZone = entry.memory.defaults.retrieval.timeZone;
  await writer.close();
  user(cold, '关闭后新增的历史不能因浏览而入库。', 3);
  const history = t.mock.method(cold, 'snapshotEvents', () => { throw new Error('Browsing read the log'); });
  const live = ctx.sessions.create('current-conversation');
  let rows = [
    { sessionId: live.id, projections: { values: { title: '当前会话' } } },
    { sessionId: cold.id, projections: { values: { title: '博物馆旧会话' } } },
  ];
  let listings = 0;
  ctx.provide('sessionController', { list: async () => { listings++; return { items: rows }; } });
  const runtime = new DshMemoryRuntime(ctx, { ...settings, enabled: false }, () => false);
  t.after(() => runtime.close());
  const calls = adapter.calls.length;
  const url = new URL(await runtime.consoleUrl(runtime.view(live)));
  const list = (await (await fetch(new URL('/memory/sessions', url))).json()).data;
  assert.equal(list.currentId, live.id);
  assert.deepEqual(list.items, rows.map(row => ({ id: row.sessionId, title: row.projections.values.title })));
  assert.equal(runtime.savedViews.size, 0, 'listing must not open any saved databases');
  const before = listings;
  await Promise.all([runtime.conversations(), runtime.conversations()]);
  assert.equal(listings - before, 1, 'concurrent directory reads share one request');
  const selected = (await (await fetch(new URL('/memory/sessions/' + cold.id, url))).json()).data;
  const other = new URL(selected.url);
  const graph = (await (await fetch(new URL('/v1/brain', other))).json()).data;
  assert.ok(graph.nodes.some(node => node.id === memoryId));
  assert.equal((await fetch(new URL('/v1/memories/' + memoryId, url))).status, 404);
  assert.equal((await fetch(new URL('/v1/memories/' + memoryId, other))).status, 200);
  assert.equal((await fetch(new URL('/v1/review-console', other))).status, 200);
  assert.equal(runtime.savedViews.get(cold.id).memory.listInputEvents({ statuses: [] }).total, captured);
  assert.deepEqual(actors(runtime.savedViews.get(cold.id).memory), originalActors);
  assert.equal(runtime.savedViews.get(cold.id).memory.defaults.retrieval.timeZone, originalTimeZone);
  assert.equal(await runtime.openConversation(cold.id), other.href);
  assert.equal(await runtime.openConversation(live.id), url.href);
  assert.equal(runtime.sessions.size, 1);
  assert.equal(runtime.savedViews.size, 1);
  assert.equal(ctx.sessions.get(cold.id), undefined);
  runtime.tick();
  assert.equal(adapter.calls.length, calls);
  assert.equal(history.mock.callCount(), 0);
  const detach = ctx.sessions.enter(cold);
  const automatic = new DshMemoryRuntime(ctx, { ...settings, automaticMaintenance: true }, () => true);
  try {
    const viewed = automatic.view(cold);
    assert.ok(viewed.pendingCharacters >= settings.archiveBatchCharacters);
    const schedule = t.mock.method(automatic, 'scheduleArchive', () => { throw new Error('Browsing scheduled processing'); });
    automatic.tick();
    assert.equal(schedule.mock.callCount(), 0);
  } finally { await automatic.close(); }
  const resumedView = runtime.view(cold);
  assert.equal(await runtime.consoleUrl(resumedView), other.href, 'opening the conversation reuses its saved-library server');
  await runtime.release(cold);
  detach();
  assert.equal((await fetch(new URL('/v1/memories/' + memoryId, other))).status, 200);
  assert.equal(adapter.calls.length, calls);
  assert.equal(history.mock.callCount(), 0);
  rows = rows.slice(0, 1);
  assert.equal((await fetch(new URL('/memory/sessions/' + cold.id, url))).status, 404);
  assert.equal((await fetch(new URL('/memory/sessions/not-a-real-session', url))).status, 404);
  await runtime.close();
  for (const address of [url, other]) {
    const socket = net.createServer();
    await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(Number(address.port), '127.0.0.1', resolve); });
    await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  }
});

test('live embedding edits preserve each running provider snapshot and apply to the next operation', async t => {
  const { ctx } = await host(t);
  let current = { baseUrl: 'https://embedding.invalid/v1', model: 'fixture-a', dimensions: 2, apiKey: 'fixture-key' };
  const settings = config(t, { embedding: { get: () => current } });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const request = JSON.parse(options.body); requests.push(request);
    return Response.json({ model: request.model, data: [{ index: 0, embedding: Array(request.dimensions).fill(1) }] });
  });
  const runtime = new DshMemoryRuntime(ctx, settings, () => true);
  t.after(() => runtime.close());
  const value = session();
  user(value, '用于配置更新检查的虚构消息。');
  const { entry } = runtime.consume(value);
  const originalOffset = entry.cursor.nextOffset;
  const first = entry.memory.providers.embedding;
  current = { ...current, model: 'fixture-b', dimensions: 3 };
  runtime.consume(value);
  const second = entry.memory.providers.embedding;
  assert.equal(entry.cursor.nextOffset, originalOffset);
  assert.equal(entry.memory.listInputEvents().total, 1);
  await first('fictitious text');
  await second('fictitious text');
  assert.deepEqual(requests.map(request => [request.model, request.dimensions]), [['fixture-a', 2], ['fixture-b', 3]]);
  assert.equal(first.model, 'fixture-a');
  assert.equal(second.model, 'fixture-b');
  current = { ...current, enabled: false };
  runtime.consume(value);
  assert.equal(entry.memory.providers.embedding, null);
  current = { ...current, enabled: true };
  runtime.consume(value);
  assert.equal(entry.memory.providers.embedding.model, 'fixture-b');
});
