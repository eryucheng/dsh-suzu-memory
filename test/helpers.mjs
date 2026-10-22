import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { LlmAdapter, createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm';
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { resolveConfig } from '../src/config.mjs';

export function temporary(t) {
  const root = path.join(process.env.DSH_SUZU_TEST_ROOT || path.join(os.tmpdir(), 'Codex', 'dsh-suzu-memory-tests'), randomUUID());
  fs.mkdirSync(root, { recursive: true });
  return root;
}

export class ScriptAdapter extends LlmAdapter {
  constructor(script) { super(); this.script = script; this.calls = []; }
  async * stream(options) {
    this.calls.push(options);
    yield* await this.script(options, this.calls.length);
  }
}

export function textChunks(text) {
  return [{ type: 'text-delta', index: 0, text },
    { type: 'usage', usage: { inputTokens: 30, cacheReadTokens: 10, cacheWriteTokens: 5, outputTokens: 20, totalTokens: 65 } },
    { type: 'finish', reason: { kind: 'stop' } }];
}

export async function host(t, script = () => textChunks('{"memories":[]}')) {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  const adapter = new ScriptAdapter(script);
  ctx.llm.registerAdapter(['test'], adapter);
  return { ctx, adapter };
}

export function config(t, overrides = {}) {
  return resolveConfig({ dataRoot: temporary(t), automaticMaintenance: false, ...overrides });
}

export function session(id = randomUUID()) {
  const value = Session.create(SessionId(id));
  value.append('request/header', { reason: 'initial', header: { config: { provider: 'test', model: 'deepseek-test' } } });
  return value;
}

export function user(value, text, turn = 1) {
  value.append('turn/start', { turn });
  value.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' });
}

export function assistant(value, text, turn = 1) {
  value.append('assistant/message', { turn, step: 1, stream: [], message: createAssistantMessage({ content: [{ type: 'text', text }], source: { kind: 'model', provider: 'test', model: 'deepseek-test' } }) }, { surfaceOp: 'append' });
}

export function eventCandidate(content = 'User 今天去了灯塔博物馆。') {
  return { kind: 'event', title: '参观灯塔博物馆', content, subjectRole: 'user', subjectName: 'User',
    actorRoles: [{ role: 'experiencer', actorRole: 'user', actorName: 'User', confidence: 1 }],
    canonicalKey: '', stateFamily: 'not_applicable', stateLabel: '', reality: 'real', evidenceMode: 'explicit',
    temporalState: 'historical', revisionAction: 'add', retentionReason: 'significant_event', eventDate: '', eventStart: '', eventEnd: '',
    confidence: 0.95, importance: 0.75, sourceRefs: ['M0001'] };
}
