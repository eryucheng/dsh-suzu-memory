import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import { DailyRequestBudget } from '../src/request-budget.mjs';
import { DshMemoryRuntime } from '../src/runtime.mjs';
import { SessionSettings } from '../src/session-settings.mjs';
import { installCompactionPrompts } from '../src/compaction.mjs';
import { libraryPaths, removeStoredLibrary } from '../src/library-storage.mjs';
import { sessionMemoryId } from '../src/events.mjs';
import { host, config, session, user, assistant, temporary, consoleClient, textChunks } from './helpers.mjs';

test('daily admission is shared, durable, concurrent and resets in the configured time zone', async () => {
  const root = temporary();
  let time = new Date('2026-11-02T15:59:00Z'), limit = 3;
  const create = () => new DailyRequestBudget(root, () => limit, 'Asia/Shanghai', () => time);
  const first = create(), second = create();
  const attempts = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => (index % 2 ? first : second).reserve()));
  assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 3);
  assert.ok(attempts.filter(item => item.status === 'rejected').every(item => item.reason.code === 'MEMORY_BUDGET_EXCEEDED'));
  assert.deepEqual(await create().status(), { day: '2026-11-02', used: 3, limit: 3, exhausted: true });
  limit = 4; await second.reserve();
  assert.equal((await first.status()).used, 4);
  time = new Date('2026-11-02T16:00:00Z');
  assert.equal((await create().reserve()).used, 1);
  for (const content of ['{broken', 'null']) {
    await fs.writeFile(path.join(root, 'request-budget.json'), content);
    assert.ok((await create().status()).error, 'unreadable accounting is visible without blocking library browsing');
    await assert.rejects(create().reserve());
  }
});

test('budget exhaustion does not quarantine input, and raising the allowance resumes pending work', async t => {
  const { ctx, adapter } = await host(t);
  const settings = config({ dailyRequestLimit: 1 });
  const runtime = new DshMemoryRuntime(ctx, settings, () => true); t.after(() => runtime.close());
  await runtime.budget.reserve();
  const value = session(); user(value, 'A saved conversation about a museum.'); assistant(value, 'I remember.');
  const result = await runtime.maintain(value, { force: true });
  assert.equal(result.status, 'budget-exhausted');
  assert.equal(adapter.calls.length, 0);
  const entry = runtime.sessions.get(value.id);
  const pending = entry.memory.listInputEvents({ statuses: [] }).items;
  assert.equal(pending.length, 2);
  assert.ok(pending.every(event => event.processing_disposition !== 'quarantined'));
  settings.dailyRequestLimit = 100;
  await runtime.maintain(value, { force: true });
  assert.ok(adapter.calls.length > 0);
  assert.equal(entry.pendingEvents, 0);
});

test('wrapped embedding calls count once, including failures, and share the analysis allowance', async t => {
  const { ctx } = await host(t);
  const runtime = new DshMemoryRuntime(ctx, config({ dailyRequestLimit: 2 }), () => true); t.after(() => runtime.close());
  let calls = 0;
  const provider = Object.assign(async () => { calls++; throw new Error('synthetic failure'); }, {
    model: 'synthetic', embedMany: async () => { calls++; return { vectors: [[1, 0]] }; },
  });
  const controller = new AbortController();
  const wrapped = runtime.sessionEmbedding(controller, () => undefined, provider);
  const again = runtime.sessionEmbedding(controller, () => undefined, wrapped);
  await assert.rejects(again('synthetic'));
  await again.embedMany(['synthetic']);
  await assert.rejects(runtime.reserveRequest(controller), { code: 'MEMORY_BUDGET_EXCEEDED' });
  assert.equal(calls, 2);
  assert.equal((await runtime.budget.status()).used, 2);
});

function rawRequest(url, headers) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
  });
}

test('every workspace data route requires a credential and refuses foreign origins and rebound hosts', async t => {
  const { ctx } = await host(t);
  const runtime = new DshMemoryRuntime(ctx, config(), () => true); t.after(() => runtime.close());
  const value = session(); user(value, 'Synthetic memory.');
  const { entry } = runtime.consume(value);
  const client = consoleClient(await runtime.consoleUrl(entry));
  for (const route of ['/memory/sessions', '/memory/sessions/' + client.libraryId,
    '/libraries/' + client.libraryId + '/v1/status', '/libraries/' + client.libraryId + '/v1/brain', '/v1/health']) {
    assert.equal((await fetch(new URL(route, client.url))).status, 401, route);
  }
  assert.equal((await client.api('/v1/status')).status, 200);
  assert.equal((await client.raw('/memory/sessions', { headers: { origin: 'https://untrusted.invalid' } })).status, 403);
  assert.equal(await rawRequest(new URL('/memory/sessions', client.url), { host: 'untrusted.invalid' }), 403);
  assert.equal((await client.raw('/memory/sessions/' + client.libraryId, { method: 'DELETE' })).status, 400);
  assert.equal((await client.review()).status, 200);
  const page = await fetch(client.url);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  const changed = consoleClient(await runtime.consoleUrl(runtime.view(session('other'))));
  assert.equal(changed.url.origin, client.url.origin);
  await fs.writeFile(runtime.budget.filename, '{broken');
  const damaged = await client.raw('/memory/sessions');
  assert.equal(damaged.status, 200);
  assert.ok((await damaged.json()).data.budget.error);
  assert.equal((await client.api('/v1/status')).status, 200);
});

test('deleting a library stops work and removes originals, backups and settings without touching its neighbour', async t => {
  const { ctx } = await host(t);
  const options = config();
  const preferences = new SessionSettings(ctx, options.dataRoot);
  const runtime = new DshMemoryRuntime(ctx, options, id => preferences.read(id).memoryEnabled, preferences);
  t.after(() => runtime.close());
  const first = session('first'), second = session('second');
  for (const value of [first, second]) {
    await preferences.setMemoryEnabled(value.id, true, 0);
    user(value, 'Synthetic memory for ' + value.id);
    runtime.consume(value);
  }
  const id = sessionMemoryId(first.id), neighbour = sessionMemoryId(second.id);
  const paths = libraryPaths(options.dataRoot, id);
  await fs.mkdir(paths.backupDirectory, { recursive: true });
  await fs.writeFile(path.join(paths.backupDirectory, 'synthetic.db'), 'synthetic');
  const client = consoleClient(await runtime.consoleUrl(runtime.sessions.get(first.id)));
  const result = await client.raw('/memory/sessions/' + id, { method: 'DELETE', headers: { 'x-suzu-confirm-delete': id } });
  assert.equal(result.status, 200, await result.text());
  await assert.rejects(fs.stat(paths.agentRoot), { code: 'ENOENT' });
  await assert.rejects(fs.stat(preferences.filename(first.id)), { code: 'ENOENT' });
  assert.equal(preferences.read(first.id).memoryEnabled, false);
  assert.equal(runtime.sessions.has(first.id), false);
  assert.equal(runtime.sessions.get(second.id).memory.listInputEvents({ statuses: [] }).total, 1);
  await fs.stat(libraryPaths(options.dataRoot, neighbour).databasePath);
  assert.equal((await client.api('/v1/status')).status, 404);
  assert.equal((await client.raw('/memory/sessions')).status, 200, 'the workspace survives deletion of the selected library');
  await assert.rejects(removeStoredLibrary(options.dataRoot, '../outside'));
});

test('a deleted host conversation remains listed after restart without opening its database', async t => {
  const { ctx } = await host(t);
  const options = config();
  const preferences = new SessionSettings(ctx, options.dataRoot);
  await preferences.setMemoryEnabled('removed-host-session', true, 0);
  const first = new DshMemoryRuntime(ctx, options, () => true, preferences);
  const value = session('removed-host-session'); user(value, 'Synthetic orphan.'); first.consume(value);
  await first.close();
  const reopened = new DshMemoryRuntime(ctx, options, () => false, preferences); t.after(() => reopened.close());
  const rows = await reopened.libraries();
  assert.equal(rows.length, 1); assert.equal(rows[0].orphaned, true); assert.equal(rows[0].sessionId, value.id);
  assert.equal(reopened.savedViews.size, 0);
  const client = consoleClient(await reopened.consoleUrl({ session: value }));
  const open = t.mock.method(reopened, 'libraryService', reopened.libraryService.bind(reopened));
  const responses = await Promise.all(Array.from({ length: 8 }, () => client.api('/v1/status')));
  assert.ok(responses.every(response => response.status === 200));
  assert.equal(open.mock.callCount(), 1, 'concurrent reads share one library open');
  await fs.writeFile(preferences.filename(value.id), '{broken');
  assert.equal((await reopened.libraries())[0].id, sessionMemoryId(value.id), 'damaged settings do not hide the stored library');
});

test('a disconnected data request is drained before deletion removes its database', async t => {
  const { ctx } = await host(t);
  const runtime = new DshMemoryRuntime(ctx, config(), () => true); t.after(() => runtime.close());
  const value = session(); user(value, 'Synthetic in-flight memory.');
  const { entry } = runtime.consume(value);
  const client = consoleClient(await runtime.consoleUrl(entry));
  let started, release, blocking;
  const begun = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const blocked = new Promise(resolve => { blocking = resolve; });
  t.mock.method(entry.memory, 'search', async () => { started(); await gate; return { status: 'ready' }; });
  const block = runtime.console.block.bind(runtime.console);
  t.mock.method(runtime.console, 'block', id => { const result = block(id); blocking(); return result; });
  const controller = new AbortController();
  const request = client.api('/v1/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"query":"synthetic"}', signal: controller.signal });
  await begun; controller.abort(); await assert.rejects(request);
  let finished = false;
  const deletion = runtime.deleteLibrary(client.libraryId).then(() => { finished = true; });
  await blocked;
  assert.equal((await client.api('/v1/status')).status, 409);
  await fs.stat(entry.memory.paths.databasePath);
  assert.equal(finished, false);
  release(); await deletion;
  await assert.rejects(fs.stat(entry.memory.paths.agentRoot), { code: 'ENOENT' });
});

test('deleting during model work cancels it and retains the profile-wide allowance record', async t => {
  let started;
  const begun = new Promise(resolve => { started = resolve; });
  const { ctx } = await host(t, async options => {
    started();
    await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    return textChunks('{"memories":[]}');
  });
  const options = config(), preferences = new SessionSettings(ctx, options.dataRoot);
  const runtime = new DshMemoryRuntime(ctx, options, id => preferences.read(id).memoryEnabled, preferences); t.after(() => runtime.close());
  const value = session('running-deletion'); await preferences.setMemoryEnabled(value.id, true, 0);
  user(value, 'Synthetic model input.'); assistant(value, 'Synthetic reply.');
  const work = runtime.maintain(value, { force: true }); await begun;
  const id = sessionMemoryId(value.id);
  await runtime.deleteLibrary(id);
  assert.equal((await work).status, 'paused');
  assert.equal(preferences.read(value.id).memoryEnabled, false);
  await assert.rejects(fs.stat(libraryPaths(options.dataRoot, id).agentRoot), { code: 'ENOENT' });
  assert.equal((await runtime.budget.status()).used, 1);
});

test('budget admission also cancels direct console processing before it records an input failure', async t => {
  const { ctx, adapter } = await host(t);
  const settings = config({ dailyRequestLimit: 1 });
  const runtime = new DshMemoryRuntime(ctx, settings, () => true); t.after(() => runtime.close());
  const value = session(); user(value, 'Synthetic input awaiting processing.'); assistant(value, 'Synthetic reply.');
  const { entry } = runtime.consume(value);
  await runtime.budget.reserve();
  const client = consoleClient(await runtime.consoleUrl(entry));
  await client.api('/v1/input-batches/process', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(adapter.calls.length, 0);
  assert.equal(entry.recoveryNeeded, true);
  assert.ok(entry.memory.listInputEvents({ statuses: [] }).items.every(item => item.processing_disposition !== 'quarantined'));
  settings.dailyRequestLimit = 100;
  await runtime.maintain(value, { force: true });
  assert.equal(entry.pendingEvents, 0);
});

test('compaction uses the official purpose and message structure, independent of instruction wording', () => {
  let intercept, forwarded;
  const ctx = { on(_name, listener) { intercept = listener; }, llm: { stream(options) { forwarded = options; return []; } } };
  const prompts = { nativeCompaction: new Map(), isEnabled: () => true, compactionInstruction: () => 'Custom instruction' };
  installCompactionPrompts(ctx, prompts, { batchedCompaction: false });
  const call = { purpose: 'compaction', sessionId: 'synthetic', messages: [{ role: 'user', content: [{ type: 'text', text: 'A newly worded official prompt.' }] }] };
  intercept(call, () => { throw new Error('Did not intercept'); });
  assert.equal(forwarded.messages.at(-1).content[0].text, 'Custom instruction');
  assert.equal(prompts.nativeCompaction.get('synthetic'), 'A newly worded official prompt.');
  assert.throws(() => intercept({ ...call, messages: [] }, () => []), { code: 'COMPACTION_FORMAT_UNSUPPORTED' });
  let passed = false;
  intercept({ ...call, purpose: undefined }, () => { passed = true; }); assert.equal(passed, true);
});
