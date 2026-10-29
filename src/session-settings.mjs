import { Service } from '@deepseek-ai/cordis';
import { PERSONA_PREFIX_SECTION, PERSONA_SUFFIX_SECTION, renderPrompt } from '@deepseek-ai/dsh-system-prompt';
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { sessionMemoryId } from './events.mjs';

export const CHAT_COMPACTION_PROMPT = `将上方对话整理为可供继续交流的简洁摘要，使用对话的主要语言。
保留以下仍然相关的内容：
- 正在讨论的话题、最近发生的事情，以及对话推进到哪里。
- 双方明确表达的态度、感受、偏好、称呼与关系变化；区分原话、事实与推测。
- 已经达成的约定、用户的要求和纠正、尚未回答的问题及未完成的事项。
- 继续当前交流所必需的细节；涉及工作时保留必要的路径、标识和准确数值。
按对话中明确的人物、时间和来源叙述，临时感受保留其情境范围。
已有摘要作为较早背景：合并有效内容，更新变化，去掉过时和重复信息。
只输出承接当前对话所需的摘要。`;

const EMPTY = Object.freeze({ version: 1, revision: 0, memoryEnabled: false, personaMode: 'dsh', persona: '',
  compactionMode: 'dsh', compactionPrompt: '' });
const MAX_PROMPT_LENGTH = 32000;
const NATIVE_VIEW = Symbol('native-prompt-view');
const OFFICIAL_COMPACTION_REFERENCE = readFileSync(new URL('./prompts/dsh-compaction-rc3.txt', import.meta.url), 'utf8').trim();

export function validatePromptSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['memoryEnabled', 'personaMode', 'persona', 'compactionMode', 'compactionPrompt'].includes(key))) {
    throw new Error('无效的会话提示词配置。');
  }
  if (!['dsh', 'custom'].includes(value.personaMode)
    || !['dsh', 'chat', 'custom'].includes(value.compactionMode)) throw new Error('无效的提示词模式。');
  for (const key of ['persona', 'compactionPrompt']) {
    if (typeof value[key] !== 'string' || value[key].length > MAX_PROMPT_LENGTH) throw new Error('提示词最长为 32000 字符。');
  }
  if (value.personaMode === 'custom' && !value.persona.trim()) throw new Error('请填写本会话的人设。');
  if (value.compactionMode === 'custom' && !value.compactionPrompt.trim()) throw new Error('请填写压缩提示词。');
  if (value.memoryEnabled !== undefined && typeof value.memoryEnabled !== 'boolean') throw new Error('无效的会话记忆开关。');
  return { ...Object.fromEntries(['personaMode', 'persona', 'compactionMode', 'compactionPrompt'].map(key => [key, value[key]])),
    ...(value.memoryEnabled === undefined ? {} : { memoryEnabled: value.memoryEnabled }) };
}

/** Owns per-conversation opt-in and prompt preferences. */
export class SessionSettings extends Service {
  constructor(ctx, dataRoot, profileEnabled = () => true) {
    super(ctx, 'suzuMemorySettings');
    this.directory = path.join(dataRoot, 'session-settings');
    this.cache = new Map();
    this.nativeCompaction = new Map();
    this.profileEnabled = profileEnabled;
    this.lifetime = new AbortController();
    this.pending = new Set();
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('会话提示词服务已关闭。'));
      await Promise.allSettled([...this.pending]);
      this.cache.clear();
      this.nativeCompaction.clear();
    });
    ctx.on('agent/disposed', ({ agent }) => { this.cache.delete(agent.session.id); this.nativeCompaction.delete(agent.session.id); });
    ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      const result = await next();
      if (!context.agent || context[NATIVE_VIEW] || !this.isEnabled(context.agent.session.id)) return result;
      const settings = this.read(context.agent.session.id);
      if (settings.personaMode !== 'custom') return result;
      // Replace the native persona slots after scoped providers have assembled.
      // Guidance, tools, contexts and native complete-prompt authority are retained.
      result.sections = result.sections.map(section => section.name === PERSONA_PREFIX_SECTION
        ? { ...section, text: settings.persona, interpolate: false }
        : section.name === PERSONA_SUFFIX_SECTION ? { ...section, text: '' } : section);
      return result;
    });
  }

  isEnabled(sessionId) { return this.profileEnabled() && this.read(sessionId).memoryEnabled; }

  async nativeView(agent, signal) {
    const assembly = await agent.ctx.systemPrompt.assemble({ agent, scope: agent, signal, [NATIVE_VIEW]: true });
    const personaSections = assembly.sections.filter(section => [PERSONA_PREFIX_SECTION, PERSONA_SUFFIX_SECTION].includes(section.name));
    return {
      persona: renderPrompt({ ...assembly, sections: personaSections }),
      systemPrompt: renderPrompt(assembly),
      compaction: this.nativeCompaction.get(agent.session.id) || OFFICIAL_COMPACTION_REFERENCE,
      compactionSource: this.nativeCompaction.has(agent.session.id) ? 'session' : '0.2.1-rc.3',
    };
  }

  filename(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('缺少会话。');
    return path.join(this.directory, `${sessionMemoryId(sessionId)}.json`);
  }

  fromDisk(sessionId) {
    let text;
    try { text = readFileSync(this.filename(sessionId), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return EMPTY; throw error; }
    const value = JSON.parse(text);
    if (value.version !== 1 || value.sessionId !== sessionId
      || !Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error('会话提示词配置已损坏。');
    const { version, revision, sessionId: storedId, ...preferences } = value;
    return Object.freeze({ version, revision, memoryEnabled: false, ...validatePromptSettings(preferences) });
  }

  read(sessionId) {
    if (!this.cache.has(sessionId)) this.cache.set(sessionId, this.fromDisk(sessionId));
    return this.cache.get(sessionId);
  }

  save(sessionId, preferences, revision, signal) {
    return this.write(sessionId, () => validatePromptSettings(preferences), revision, signal);
  }

  setMemoryEnabled(sessionId, enabled, revision, signal) {
    return this.write(sessionId, () => {
      if (typeof enabled !== 'boolean') throw new Error('无效的会话记忆开关。');
      return { memoryEnabled: enabled };
    }, revision, signal);
  }

  write(sessionId, change, revision, signal) {
    const combined = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    const task = this.persist(sessionId, change, revision, combined);
    this.pending.add(task);
    return task.finally(() => this.pending.delete(task));
  }

  async persist(sessionId, change, revision, signal) {
    signal.throwIfAborted();
    const patch = change();
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('无效的配置版本。');
    await mkdir(this.directory, { recursive: true });
    return withFileLock(this.filename(sessionId), async () => {
      signal?.throwIfAborted();
      const current = this.fromDisk(sessionId);
      if (current.revision !== revision) {
        this.cache.set(sessionId, current);
        return { saved: false, value: current };
      }
      const next = Object.freeze({ ...current, ...patch, version: 1, revision: revision + 1 });
      await writeFileAtomic(this.filename(sessionId), JSON.stringify({ ...next, sessionId }) + '\n', { mode: 0o600 });
      this.cache.set(sessionId, next);
      this.ctx.emit('suzu-memory/session-settings-changed', sessionId);
      this.ctx.emit('system-prompt/change');
      return { saved: true, value: next };
    }, { signal, waitMs: 10000 });
  }

  compactionInstruction(sessionId) {
    const settings = this.read(sessionId);
    return settings.compactionMode === 'chat' ? CHAT_COMPACTION_PROMPT
      : settings.compactionMode === 'custom' ? settings.compactionPrompt : null;
  }
}
