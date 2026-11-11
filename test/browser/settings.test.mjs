import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import Projection from '@deepseek-ai/dsh-session-projection';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createMemoryService } from '@suzu-memory/service';
import * as plugin from '../../src/index.mjs';
import { resolveConfig } from '../../src/config.mjs';
import { sessionMemoryId } from '../../src/events.mjs';
import { host, config } from '../helpers.mjs';

const close = server => !server.listening ? Promise.resolve()
  : new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

test('settings clicks persist per conversation; paused memory still supports graph, review and library switching', { timeout: 60000 }, async t => {
  const { ctx, adapter } = await host(t, () => { throw new Error('Browsing must not call a model.'); });
  const settings = config();
  let snapshot = { value: { ...settings }, status: 'ready', writable: true, revision: 0 };
  await ctx.plugin(Projection); await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] });
  await ctx.plugin({ inject: plugin.inject, apply(child) {
    return plugin.apply(child, { ...settings, enabled: { get: () => snapshot.value.enabled !== false } });
  } });
  const agents = new Map();
  const fixtures = [
    { sessionId: 'browser-museum', conversationTitle: 'Museum conversation', title: 'Lighthouse museum', query: 'Lighthouse',
      content: 'We visited the lighthouse museum on Saturday. We spent the morning in the navigation gallery, comparing old sea charts and learning how the keepers signalled ships through fog. Before leaving, we bought a brass compass from the museum shop.',
      source: 'I bought a brass compass at the lighthouse museum gift shop.' },
    { sessionId: 'browser-cat', conversationTitle: 'Cat conversation', title: 'Cedar the cat', query: 'Cedar',
      content: 'The cat is named Cedar. We adopted him after visiting the shelter together, where he slept beside the window and watched the garden birds. At home he prefers a quiet spot on the sofa, and his favourite toy is a small green felt mouse.',
      source: 'Cedar likes the small green felt mouse more than his other toys.' },
  ];
  for (const fixture of fixtures) {
    const handle = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId(fixture.sessionId), agentOptions: { provider: 'test', model: 'test' } });
    agents.set(fixture.sessionId, handle.agent); t.after(() => handle.dispose());
    const memory = createMemoryService({ dataRoot: settings.dataRoot, agentId: sessionMemoryId(fixture.sessionId) });
    try { memory.withRepository(repository => {
      const saved = repository.upsertMemory({ id: 'saved-fact', agentId: memory.agentId,
        kind: 'event', layer: 'episodic', title: fixture.title, content: fixture.content, subjectRole: 'user', subjectKey: 'user' });
      const source = repository.upsertSource({ id: 'raw-evidence', agentId: memory.agentId,
        sourceKind: 'conversation', externalId: 'original-message', speaker: 'User', content: fixture.source });
      repository.linkSource(saved.id, source.id, 'evidence', { authority: 'subject_firsthand' });
    });
      const node = memory.brainSnapshot().nodes.find(item => item.id === 'saved-fact');
      assert.ok(node);
      assert.notEqual(node.preview, fixture.content, 'The full detail must contain information absent from the graph preview.');
    } finally { await memory.close(); }
  }
  ctx.provide('sessionController', { list: async () => ({ items: fixtures.map(fixture => ({
    sessionId: fixture.sessionId, projections: { values: { title: fixture.conversationTitle } },
  })) }) });
  const sessions = { phase: 'ready', ids: [...agents.keys()],
    byId: Object.fromEntries(fixtures.map(fixture => [fixture.sessionId, { displayTitle: fixture.conversationTitle }])) };
  const compiled = await build({ entryPoints: [fileURLToPath(new URL('./client-host.js', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'browser', external: ['/client.js'] });
  const bridgeErrors = [];
  let consolePort;
  const bridge = http.createServer(async (request, response) => {
    try {
      const json = value => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)); };
      if (request.url === '/') { response.setHeader('content-type', 'text/html'); response.end('<div id="root"></div><script type="module" src="/host.js"></script>'); return; }
      if (request.url === '/host.js' || request.url === '/client.js') {
        response.setHeader('content-type', 'text/javascript');
        response.end(request.url === '/host.js' ? compiled.outputFiles[0].contents : fs.readFileSync(new URL('../../src/client.js', import.meta.url))); return;
      }
      if (request.url === '/api/bootstrap') { json({ snapshot, sessions }); return; }
      if (request.method !== 'POST' || !['/api/config', '/api/command'].includes(request.url)) {
        response.writeHead(404); response.end(); return;
      }
      const body = []; for await (const chunk of request) body.push(chunk);
      const value = JSON.parse(Buffer.concat(body));
      if (request.url === '/api/config') {
        if (value.revision !== snapshot.revision) { json({ accepted: false }); return; }
        const next = structuredClone(snapshot.value);
        for (const operation of value.operations) {
          assert.equal(operation.op, 'set'); assert.equal(operation.path.length, 1);
          next[operation.path[0]] = operation.value;
        }
        snapshot = { ...snapshot, value: resolveConfig(next), revision: snapshot.revision + 1 };
        ctx.emit('loader/volatile-update'); json({ accepted: true, snapshot }); return;
      }
      if (request.url === '/api/command') {
        const agent = agents.get(value.sessionId);
        assert.ok(agent, 'Commands target a known conversation.');
        const result = await ctx.commands.execute(agent, value.command, [], new AbortController().signal);
        if (result.result.kind === 'success') {
          const output = JSON.parse(result.result.text);
          if (output.consoleUrl) consolePort = Number(new URL(output.consoleUrl).port);
        }
        json({ ok: true, value: result }); return;
      }
      response.writeHead(404); response.end();
    } catch (error) { bridgeErrors.push(error); response.writeHead(500); response.end('Test host failed.'); }
  });
  t.after(() => close(bridge));
  const bridgePort = await listen(bridge), address = `http://127.0.0.1:${bridgePort}/`;
  const browserServer = await chromium.launchServer({ headless: true, ...(process.env.SUZU_BROWSER_CHANNEL ? { channel: process.env.SUZU_BROWSER_CHANNEL } : {}) });
  t.after(() => browserServer.close());
  const browser = await chromium.connect(browserServer.wsEndpoint()); t.after(() => browser.close());
  const browserPort = Number(new URL(browserServer.wsEndpoint()).port);
  t.after(async () => {
    for (const port of [bridgePort, browserPort, consolePort].filter(Boolean)) {
      const probe = net.createServer();
      await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve); });
      await close(probe);
    }
  });
  const browserContext = await browser.newContext(), errors = [];
  browserContext.on('page', opened => opened.on('pageerror', error => errors.push(error.message)));
  const page = await browserContext.newPage();
  try {
    await page.goto(address);
    const master = page.getByRole('checkbox', { name: '插件总开关', exact: true });
    const sessionSwitch = page.getByRole('checkbox', { name: '启用此会话的 Suzu Memory', exact: true });
    await sessionSwitch.waitFor(); await page.waitForFunction(() => !document.querySelector('.suzu-check input').disabled);
    assert.equal(await master.isEnabled(), true, 'The ready settings form allows editing its master switch.');
    assert.equal(await sessionSwitch.isChecked(), false);
    await sessionSwitch.click();
    await page.waitForFunction(() => document.querySelector('.suzu-check input').checked && !document.querySelector('.suzu-check input').disabled);
    assert.equal(ctx.suzuMemorySettings.read('browser-museum').memoryEnabled, true);
    const persona = page.getByRole('heading', { name: '人设', exact: true }).locator('..');
    await persona.getByRole('combobox', { name: /^人设/u }).selectOption('custom');
    await persona.getByRole('textbox', { name: /^人设内容/u }).fill('A calm museum guide.');
    await persona.getByRole('button', { name: '保存', exact: true }).click();
    await persona.getByRole('status').waitFor();
    assert.equal(ctx.suzuMemorySettings.read('browser-museum').persona, 'A calm museum guide.');
    assert.equal(ctx.suzuMemorySettings.read('browser-cat').personaMode, 'dsh');
    const conversation = page.getByRole('combobox').first();
    await conversation.selectOption('browser-cat');
    await page.waitForFunction(() => !document.querySelector('.suzu-check input').disabled);
    assert.equal(await sessionSwitch.isChecked(), false);
    await persona.locator('select:enabled').first().waitFor();
    assert.equal(await persona.getByRole('combobox', { name: /^人设/u }).inputValue(), 'dsh');
    await conversation.selectOption('browser-museum');
    await persona.getByRole('textbox', { name: /^人设内容/u }).waitFor();
    assert.equal(await persona.getByRole('textbox', { name: /^人设内容/u }).inputValue(), 'A calm museum guide.');
    const controls = page.getByRole('heading', { name: '运行与费用', exact: true }).locator('..');
    for (const enabled of [false, true, false]) {
      await master.setChecked(enabled);
      await controls.getByRole('button', { name: '保存', exact: true }).click();
      await controls.getByRole('status').waitFor();
      await page.reload(); await master.waitFor();
      assert.equal(await master.isChecked(), enabled);
      assert.equal(await master.isEnabled(), true, 'The master switch remains editable while disabled.');
      assert.equal(snapshot.value.enabled, enabled);
    }
    const [workbench] = await Promise.all([
      page.waitForEvent('popup'),
      page.getByRole('link', { name: '打开记忆图谱与审核台', exact: true }).click(),
    ]);
    await workbench.waitForLoadState('domcontentloaded');
    consolePort = Number(new URL(workbench.url()).port);
    const openDetail = async fixture => {
      await workbench.locator('#search').fill(fixture.query);
      const [response] = await Promise.all([
        workbench.waitForResponse(response => response.request().method() === 'GET'
          && new URL(response.url()).pathname === `/libraries/${sessionMemoryId(fixture.sessionId)}/v1/memories/saved-fact`),
        workbench.locator('#matches').getByRole('button', { name: fixture.title, exact: true }).click(),
      ]);
      assert.equal(response.status(), 200);
      const payload = await response.json();
      assert.equal(payload.data.memory.content, fixture.content);
      assert.ok(payload.data.sources.some(source => source.speaker === 'User' && source.content === fixture.source));
      await workbench.waitForFunction(content => document.querySelector('#detail .content').textContent === content, fixture.content);
      await workbench.locator('#sources').getByText(`User: ${fixture.source}`, { exact: true }).waitFor();
    };
    await openDetail(fixtures[0]);
    await workbench.locator('#review-tab').click();
    await workbench.frameLocator('iframe').getByRole('heading', { name: '审核队列', exact: true }).waitFor();
    await workbench.frameLocator('iframe').getByText(sessionMemoryId('browser-museum'), { exact: true }).waitFor();
    await workbench.locator('#conversation').selectOption(sessionMemoryId('browser-cat'));
    await workbench.waitForURL(url => url.searchParams.get('library') === sessionMemoryId('browser-cat') && url.hash === '#review');
    await workbench.frameLocator('iframe').getByText(sessionMemoryId('browser-cat'), { exact: true }).waitFor();
    await workbench.locator('#graph-tab').click();
    await openDetail(fixtures[1]);
    await workbench.locator('#search').fill(fixtures[0].query);
    assert.equal(await workbench.locator('#matches').getByRole('button', { name: 'Lighthouse museum', exact: true }).count(), 0);
    assert.deepEqual(errors, []); assert.deepEqual(bridgeErrors, []); assert.equal(adapter.calls.length, 0);
  } catch (error) {
    throw bridgeErrors.length ? new AggregateError([...bridgeErrors, error], 'Browser test host failed.') : error;
  }
});
