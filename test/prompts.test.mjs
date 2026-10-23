import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import * as plugin from '../src/index.mjs';
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic';
import { SessionPrompts, CHAT_COMPACTION_PROMPT } from '../src/session-prompts.mjs';
import { DshMemoryRuntime } from '../src/runtime.mjs';
import { withFileLock } from '@deepseek-ai/dsh-atomic-write';
import { PERSONA_PREFIX_SECTION, PERSONA_SUFFIX_SECTION } from '@deepseek-ai/dsh-system-prompt';
import { host, config, textChunks, temporary } from './helpers.mjs';

const preferences = (extra = {}) => ({ personaMode: 'dsh', persona: '', compactionMode: 'dsh', compactionPrompt: '', ...extra });

test('prompt preferences persist independently and concurrent stale saves cannot overwrite a newer edit', async t => {
  const { ctx } = await host(t);
  const store = new SessionPrompts(ctx, temporary(t));
  assert.equal(store.read('../one').revision, 0);
  const results = await Promise.all([
    store.save('../one', preferences({ personaMode: 'custom', persona: '你是铃。' }), 0),
    store.save('../one', preferences({ personaMode: 'custom', persona: '另一份草稿。' }), 0),
  ]);
  assert.equal(results.filter(result => result.saved).length, 1);
  assert.equal(store.read('two').persona, '');
  assert.ok(store.filename('../one').startsWith(store.directory));
  const reads = t.mock.method(store, 'fromDisk');
  for (let index = 0; index < 100; index++) store.compactionInstruction('../one');
  assert.equal(reads.mock.calls.length, 0);
  reads.mock.restore();
  store.cache.clear();
  assert.equal(store.read('../one').revision, 1);
  assert.equal(fs.readdirSync(store.directory).filter(name => name.endsWith('.lock')).length, 0);
  await assert.rejects(store.save('two', preferences({ personaMode: 'custom' }), 0), /人设/);
  await assert.rejects(store.save('two', preferences({ persona: 'x'.repeat(32001) }), 0), /32000/);
});

test('unload cancels a pending prompt writer and drains its acquisition before returning', async t => {
  const { ctx } = await host(t);
  let store;
  const fiber = ctx.plugin({ apply(child) { store = new SessionPrompts(child, temporary(t)); } });
  await fiber;
  fs.mkdirSync(store.directory, { recursive: true });
  const locked = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const blocking = withFileLock(store.filename('waiting'), async () => { locked.resolve(); await gate.promise; });
  await locked.promise;
  const pending = store.save('waiting', preferences(), 0);
  const rejected = assert.rejects(pending, /关闭/);
  await fiber.dispose();
  await rejected;
  gate.resolve(); await blocking;
  assert.equal(store.pending.size, 0);
  assert.deepEqual(fs.readdirSync(store.directory), []);
});

async function loopHost(t, script, overrides = {}) {
  const result = await host(t, script);
  await result.ctx.plugin(SessionProjectionRegistry);
  await result.ctx.plugin(AgentRegistry);
  await result.ctx.plugin(AgentLoop, { agents: [] });
  await result.ctx.plugin(TokenMeter);
  const fiber = result.ctx.plugin(plugin, config(t, overrides));
  await fiber;
  const create = id => result.ctx.agentLoop.createAgent(result.ctx, { sessionId: SessionId(id),
    agentOptions: { provider: 'test', model: 'deepseek-test' } });
  return { ...result, create, fiber };
}

async function say(agent, text) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
  await agent.whenIdle();
}

test('saved persona replaces native persona slots only in its conversation and updates the next request', async t => {
  const { ctx, adapter, create, fiber } = await loopHost(t, () => textChunks('收到。'));
  const first = await create('persona-chat');
  const second = await create('persona-work');
  first.agent.ctx.systemPrompt.section({ name: PERSONA_PREFIX_SECTION, order: 0, text: '原会话人设' });
  first.agent.ctx.systemPrompt.section({ name: PERSONA_SUFFIX_SECTION, order: 100, text: '原会话人设附言' });
  const value = preferences({ personaMode: 'custom', persona: '你是铃，喜欢用 {{铃声}} 打招呼。' });
  const saved = await ctx.commands.execute(first.agent, '/suzu-memory-save-prompts ' + JSON.stringify({ value, revision: 0 }), [], new AbortController().signal);
  assert.equal(JSON.parse(saved.result.text).saved, true);
  await say(first.agent, '你好');
  assert.match(adapter.calls.at(-1).messages[0].content[0].text, /你是铃，喜欢用 \{\{铃声\}\} 打招呼/);
  assert.ok(!adapter.calls.at(-1).messages[0].content[0].text.includes('原会话人设'));
  await say(second.agent, '帮我处理工作');
  assert.ok(!JSON.stringify(adapter.calls.at(-1)).includes('铃声'));
  const read = await ctx.commands.execute(first.agent, '/suzu-memory-prompts', [], new AbortController().signal);
  assert.equal(JSON.parse(read.result.text).value.persona, value.persona);
  await ctx.suzuMemoryPrompts.save(first.agent.id, preferences(), 1);
  await say(first.agent, '继续');
  assert.ok(!adapter.calls.at(-1).messages[0].content[0].text.includes('铃声'));
  assert.match(adapter.calls.at(-1).messages[0].content[0].text, /原会话人设/);
  assert.ok(adapter.calls.at(-1).tools.some(tool => tool.name === 'suzu_memory_search'));
  await fiber.dispose();
  await say(second.agent, '插件卸载后继续');
  assert.ok(!(adapter.calls.at(-1).tools || []).some(tool => tool.name === 'suzu_memory_search'));
  await first.dispose(); await second.dispose();
});

test('DSH retains the authority of a separately configured complete system prompt', async t => {
  const { ctx } = await host(t);
  const store = new SessionPrompts(ctx, temporary(t));
  await store.save('complete', preferences({ personaMode: 'custom', persona: '会话人设' }), 0);
  ctx.systemPrompt.section({ name: 'complete-fixture', order: 0, text: '预设的完整系统提示词', complete: true });
  const assembly = await ctx.systemPrompt.assemble({ agent: { session: { id: 'complete' } } });
  assert.deepEqual(assembly.sections.map(section => section.text), ['预设的完整系统提示词']);
});

test('native scoped compaction uses the selected template while retaining its exact prefix and rollback', async t => {
  let truncated = false;
  const { ctx, adapter, create } = await loopHost(t, options => {
    if (options.purpose === 'compaction') return truncated
      ? [{ type: 'text-delta', index: 0, text: '不完整' }, { type: 'finish', reason: { kind: 'max-tokens' } }]
      : textChunks('用户最近在讨论散步，约定下周再去公园。');
    return textChunks('明白。');
  });
  adapter.resolveModel = async (provider, model) => ({ provider, id: model, name: model, context: { contextWindow: 100000 } });
  const isolated = ctx.isolate('compaction');
  await isolated.plugin(BasicCompactionEngine, { auto: false, headroomTokens: 1000, retainTokens: 0, maxTokens: 1000 });
  assert.equal(ctx.get('compaction'), undefined);
  const engine = isolated.compaction;
  const handle = await create('compact-chat');
  const agent = handle.agent;
  await ctx.suzuMemoryPrompts.save(agent.id, preferences({ compactionMode: 'chat' }), 0);
  await say(agent, '上周在公园散步，约定下周再去。'.repeat(120));
  const routed = adapter.calls.at(-1);
  const signal = new AbortController().signal;
  const result = await engine.compactNow(agent, signal);
  assert.ok(result && result.shadowedSeqs.length > 0);
  const summaryCall = adapter.calls.find(call => call.purpose === 'compaction');
  assert.equal(adapter.calls.filter(call => call.purpose === 'compaction').length, 1);
  assert.equal(summaryCall.messages.at(-1).content[0].text, CHAT_COMPACTION_PROMPT);
  assert.deepEqual(summaryCall.messages.slice(0, routed.messages.length), routed.messages);
  assert.deepEqual(summaryCall.tools, routed.tools);
  const logs = agent.session.snapshotEvents();
  assert.ok(logs.some(event => event.type === 'compaction/summary'));
  await say(agent, '现在接着聊，周末想去哪里？'.repeat(120));
  truncated = true;
  const generation = agent.session.surface.replaceGeneration;
  await assert.rejects(engine.compactNow(agent, signal), error => error.cause?.code === 'MAX_TOKENS');
  assert.equal(agent.session.surface.replaceGeneration, generation);
  const custom = '保留当前承诺和未完话题，只输出中文摘要。';
  await ctx.suzuMemoryPrompts.save(agent.id, preferences({ compactionMode: 'custom', compactionPrompt: custom }), 1);
  truncated = false;
  await engine.compactNow(agent, signal);
  assert.equal(adapter.calls.at(-1).messages.at(-1).content[0].text, custom);
  await handle.dispose();
});

test('unchanged conversations retain the original DSH compaction instruction', async t => {
  const { ctx, adapter, create } = await loopHost(t, () => textChunks('checkpoint'));
  await ctx.plugin(BasicCompactionEngine, { auto: false });
  const handle = await create('compact-native');
  await ctx.compaction.summarize({ messages: [] }, handle.agent);
  assert.match(adapter.calls.at(-1).messages.at(-1).content[0].text, /AI coding assistant/);
  await handle.dispose();
});

test('native compaction flushes a short memory tail without waiting for extraction', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const jobs = [];
  const maintain = DshMemoryRuntime.prototype.maintain;
  t.mock.method(DshMemoryRuntime.prototype, 'maintain', function (...args) {
    const work = maintain.apply(this, args); jobs.push(work); return work;
  });
  const { ctx, adapter, create } = await loopHost(t, async options => {
    if (options.purpose === 'compaction') return textChunks('保留用户的公园散步计划。');
    if (options.system?.includes('JSON Schema')) { await gate; return textChunks('{"memories":[]}'); }
    return textChunks('明白。');
  }, { automaticMaintenance: true });
  adapter.resolveModel = async (provider, model) => ({ provider, id: model, name: model, context: { contextWindow: 100000 } });
  await ctx.plugin(BasicCompactionEngine, { auto: false, headroomTokens: 1000, retainTokens: 0, maxTokens: 1000 });
  const handle = await create('compact-short-tail');
  try {
    await say(handle.agent, '上周在公园散步，约定下周再去。'.repeat(120));
    assert.equal(jobs.length, 0);
    const result = await ctx.compaction.compactNow(handle.agent, new AbortController().signal);
    assert.ok(result);
    assert.equal(jobs.length, 1);
    release(); await Promise.all(jobs);
  } finally { release(); await Promise.allSettled(jobs); await handle.dispose(); }
});
