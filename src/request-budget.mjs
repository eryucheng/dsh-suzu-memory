import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import { liveValue } from './schedule.mjs';

/** Counts admitted Memory calls across conversations and plugin restarts. */
export class DailyRequestBudget {
  constructor(dataRoot, limit, timeZone, now = () => new Date()) {
    this.filename = path.join(dataRoot, 'request-budget.json');
    this.limit = limit;
    this.now = now;
    this.formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    this.cached = null;
  }

  day() {
    const parts = Object.fromEntries(this.formatter.formatToParts(this.now()).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  async read() {
    let value;
    try { value = JSON.parse(await readFile(this.filename, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (value !== undefined && (value?.version !== 1 || !/^\d{4}-\d{2}-\d{2}$/u.test(value.day)
      || !Number.isSafeInteger(value.count) || value.count < 0)) throw new Error('模型调用预算记录已损坏。');
    return value?.day === this.day() ? value : { version: 1, day: this.day(), count: 0 };
  }

  snapshot() {
    const limit = Number(liveValue(this.limit()) || 0);
    const used = this.cached?.day === this.day() ? this.cached.count : 0;
    return { day: this.day(), used, limit, exhausted: limit > 0 && used >= limit };
  }

  async status() {
    try { this.cached = await this.read(); return this.snapshot(); }
    catch { return { ...this.snapshot(), error: '预算记录不可读，模型调用已暂停。' }; }
  }

  async reserve(signal) {
    signal?.throwIfAborted();
    await mkdir(path.dirname(this.filename), { recursive: true });
    return withFileLock(this.filename, async () => {
      signal?.throwIfAborted();
      this.cached = await this.read();
      if (this.snapshot().exhausted) throw Object.assign(new Error('今日记忆模型调用次数已达上限，待处理内容已保留。'), { code: 'MEMORY_BUDGET_EXCEEDED' });
      const next = { ...this.cached, count: this.cached.count + 1 };
      await writeFileAtomic(this.filename, JSON.stringify(next) + '\n', { mode: 0o600 });
      this.cached = next;
      return this.snapshot();
    }, { signal, waitMs: 10000 });
  }
}
