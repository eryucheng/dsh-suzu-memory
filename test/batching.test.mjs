import assert from 'node:assert/strict';
import test from 'node:test';
import { DshMemoryRuntime } from '../src/runtime.mjs';
import { host, config, session, user, assistant, textChunks } from './helpers.mjs';

function turn(value, n) {
  user(value, `${n}用户`.padEnd(400, '甲'), n);
  assistant(value, `${n}回复`.padEnd(100, '乙'), n);
}
async function drain(runtime, value) {
  runtime.scheduleArchive(value);
  await runtime.require(value).running;
}

test('short conversations and unchanged notifications make no analysis or history reads', async t => {
  const { ctx, adapter } = await host(t);
  const runtime = new DshMemoryRuntime(ctx, config(t, { automaticMaintenance: true }));
  t.after(() => runtime.close());
  const value = session();
  for (let n = 1; n <= 10; n++) { turn(value, n); await drain(runtime, value); }
  assert.equal(adapter.calls.length, 0);
  const entry = runtime.require(value);
  const history = t.mock.method(value, 'snapshotEvents', () => { throw new Error('unchanged history read'); });
  const pending = t.mock.method(entry.memory, 'listInputEvents', () => { throw new Error('unchanged pending read'); });
  for (let n = 0; n < 10; n++) await drain(runtime, value);
  assert.equal(history.mock.callCount(), 0);
  assert.equal(pending.mock.callCount(), 0);
});

test('length threshold waits for one following round and archives each core once', async t => {
  const { ctx, adapter } = await host(t);
  const runtime = new DshMemoryRuntime(ctx, config(t, { automaticMaintenance: true, archiveBatchCharacters: 1000 }));
  t.after(() => runtime.close());
  const value = session();
  turn(value, 1); await drain(runtime, value);
  turn(value, 2); await drain(runtime, value);
  assert.equal(adapter.calls.length, 0);
  turn(value, 3); await drain(runtime, value);
  const entry = runtime.require(value);
  assert.equal(entry.memory.listInputEvents({ statuses: ['archived'] }).total, 4);
  assert.equal(entry.memory.listInputEvents().total, 2);
  assert.equal(entry.pendingCharacters, 500);
  assert.ok(adapter.calls[0].messages[0].content[0].text.includes('3用户'));
  turn(value, 4); await drain(runtime, value);
  turn(value, 5); await drain(runtime, value);
  assert.equal(entry.memory.listInputEvents({ statuses: ['archived'] }).total, 8);
  assert.equal(entry.memory.listInputEvents().total, 2);
  const last = adapter.calls.filter(call => call.messages[0].content[0].text.includes('5用户')).at(-1);
  assert.ok(last.messages[0].content[0].text.includes('2用户'), 'previous complete round is read-only context');
  await runtime.maintain(value, { force: true });
  assert.equal(entry.memory.listInputEvents().total, 0);
  assert.equal(entry.memory.listInputEvents({ statuses: ['archived'] }).total, 10);
});

test('resume preserves the short tail without rereading DSH history or analyzing early', async t => {
  const { ctx, adapter } = await host(t);
  const options = config(t, { automaticMaintenance: true, archiveBatchCharacters: 1000 });
  const value = session(); turn(value, 1);
  let runtime = new DshMemoryRuntime(ctx, options);
  runtime.consume(value); await runtime.close();
  runtime = new DshMemoryRuntime(ctx, options);
  t.after(() => runtime.close());
  const read = t.mock.method(value, 'snapshotEvents', () => { throw new Error('already captured'); });
  await drain(runtime, value);
  assert.equal(read.mock.callCount(), 0);
  assert.equal(adapter.calls.length, 0);
  assert.equal(runtime.require(value).pendingCharacters, 500);
  read.mock.restore();
  turn(value, 2); await drain(runtime, value);
  turn(value, 3); await drain(runtime, value);
  assert.equal(runtime.require(value).memory.listInputEvents().total, 2);
});

test('context eviction joins the running task and flushes the bounded tail in the background', async t => {
  let release, start;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { start = resolve; });
  const { ctx } = await host(t, async (_options, call) => {
    if (call === 1) { start(); await gate; }
    return textChunks('{"memories":[]}');
  });
  const runtime = new DshMemoryRuntime(ctx, config(t, { automaticMaintenance: true, archiveBatchCharacters: 1000 }));
  t.after(() => runtime.close());
  const value = session();
  for (let n = 1; n <= 3; n++) turn(value, n);
  runtime.scheduleArchive(value);
  const entry = runtime.require(value), running = entry.running;
  try {
    await started;
    turn(value, 4);
    runtime.scheduleArchive(value, { flush: true });
    assert.equal(entry.running, running);
  } finally { release(); }
  await running;
  assert.equal(entry.memory.listInputEvents().total, 0);
  assert.equal(entry.memory.listInputEvents({ statuses: ['archived'] }).total, 8);
});

test('automatic processing can be disabled while explicit bounded maintenance remains available', async t => {
  const { ctx, adapter } = await host(t);
  const runtime = new DshMemoryRuntime(ctx, config(t, { automaticMaintenance: false, archiveBatchCharacters: 1000 }));
  t.after(() => runtime.close());
  const value = session();
  for (let n = 1; n <= 5; n++) turn(value, n);
  runtime.scheduleArchive(value); runtime.scheduleArchive(value, { flush: true });
  assert.equal(adapter.calls.length, 0);
  await runtime.maintain(value, { force: true });
  assert.equal(runtime.require(value).memory.listInputEvents().total, 0);
});

test('new messages arriving during a waiting plan are processed by the same background job', async t => {
  const { ctx } = await host(t);
  const runtime = new DshMemoryRuntime(ctx, config(t, { automaticMaintenance: true, archiveBatchCharacters: 1000 }));
  t.after(() => runtime.close());
  const value = session(); turn(value, 1); turn(value, 2);
  let start, release, paused = false;
  const started = new Promise(resolve => { start = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const policy = runtime.chunkPolicy.bind(runtime);
  runtime.chunkPolicy = (...args) => {
    const result = policy(...args), resolveReply = result.resolveReply;
    result.resolveReply = async row => {
      if (!paused) { paused = true; start(); await gate; }
      return resolveReply(row);
    };
    return result;
  };
  runtime.scheduleArchive(value);
  const entry = runtime.require(value), running = entry.running;
  try { await started; turn(value, 3); runtime.scheduleArchive(value); }
  finally { release(); }
  await running;
  assert.equal(entry.memory.listInputEvents({ statuses: ['archived'] }).total, 4);
  assert.equal(entry.pendingEvents, 2);
});

test('failed analysis retains pending content and a retry archives it once', async t => {
  const { ctx } = await host(t, (_options, call) => {
    if (call === 1) throw new Error('temporary provider failure');
    return textChunks('{"memories":[]}');
  });
  const runtime = new DshMemoryRuntime(ctx, config(t));
  t.after(() => runtime.close());
  const value = session(); turn(value, 1);
  assert.equal((await runtime.maintain(value, { force: true })).status, 'completed-with-failures');
  const entry = runtime.require(value);
  assert.equal(entry.memory.listInputEvents().total, 2);
  await runtime.maintain(value, { force: true });
  assert.equal(entry.memory.listInputEvents().total, 0);
  assert.equal(entry.memory.listInputEvents({ statuses: ['archived'] }).total, 2);
});

test('a message larger than the full request cap is retained for review without a huge model call', async t => {
  const { ctx, adapter } = await host(t);
  const runtime = new DshMemoryRuntime(ctx, config(t));
  t.after(() => runtime.close());
  const value = session(), text = '超长原文'.repeat(25000);
  user(value, text);
  await runtime.maintain(value, { force: true });
  const rows = runtime.require(value).memory.listInputEvents({ statuses: [], sourceOrder: true, limit: 500 }).items;
  assert.equal(rows.map(row => row.content.text).join(''), text);
  assert.ok(rows.every(row => row.processing_disposition === 'quarantined'));
  assert.equal(adapter.calls.length, 0);
});
