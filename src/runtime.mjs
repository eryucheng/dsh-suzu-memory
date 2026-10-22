import { SessionLogOffset } from '@deepseek-ai/dsh-session';
import { createMemoryService } from '@suzu-memory/service';
import { createOpenAiCompatibleEmbeddingProvider } from '@suzu-memory/providers';
import { createMemoryHttpServer } from '@suzu-memory/server';
import { memoryEvent, sessionMemoryId, sourceScope } from './events.mjs';
import { createDshGenerator } from './generator.mjs';

/** Owns adapters only for live DSH sessions. The Memory service owns all memory data. */
export class DshMemoryRuntime {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
    this.sessions = new Map();
    this.closing = false;
    this.closures = new Set();
    this.embedding = null;
    if (config.embedding) {
      const { apiKeyEnv, ...embedding } = config.embedding;
      const apiKey = embedding.apiKey || (apiKeyEnv ? process.env[apiKeyEnv] : '');
      if (!apiKey) throw new Error('请配置 Embedding API Key 或 apiKeyEnv。');
      this.embedding = createOpenAiCompatibleEmbeddingProvider({ ...embedding, apiKey });
    }
  }

  require(session) {
    if (this.closing) throw new Error('记忆插件正在退出。');
    let entry = this.sessions.get(session.id);
    if (entry) {
      if (entry.session !== session) throw new Error('同一会话身份同时绑定了不同的运行实例。');
      return entry;
    }
    const agentId = sessionMemoryId(session.id);
    const identity = { agentId, userId: 'user', userName: this.config.userName, memoryOwner: this.config.memoryOwner };
    const controller = new AbortController();
    const generator = createDshGenerator({
      llm: this.ctx.llm,
      resolveRoute: () => {
        const route = session.requestHeader()?.config;
        const provider = this.config.analysisProvider || route?.provider;
        const model = this.config.analysisModel || route?.model;
        if (!provider || !model) throw Object.assign(new Error('当前会话尚未选择可用的分析模型。'), { code: 'MEMORY_MODEL_UNAVAILABLE' });
        return { provider, model };
      },
      signal: controller.signal,
      timeoutMs: this.config.analysisTimeoutMs,
      maxTokens: this.config.analysisMaxTokens,
      maximumOutputCharacters: this.config.maximumOutputCharacters,
    });
    const embedding = this.embedding && Object.assign((text, options = {}) => this.embedding(text, {
      ...options, signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal,
    }), { model: this.embedding.model, dimensions: this.embedding.dimensions });
    if (embedding) embedding.embedMany = (texts, options = {}) => this.embedding.embedMany(texts, {
      ...options, signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal,
    });
    const memory = createMemoryService({
      dataRoot: this.config.dataRoot, agentId,
      defaults: { primaryUserId: identity.userId, userName: identity.userName, memoryOwner: identity.memoryOwner, companionId: agentId },
      providers: { generator, structureGenerator: generator, retrievalContextGenerator: generator, embedding },
    });
    memory.initialize();
    memory.recoverProcessingEvents();
    memory.recoverRunningMaintenance();
    const progress = memory.getEventSourceProgress({ scope: sourceScope(session) });
    const nextOffset = Math.max(progress.consumedThroughSequence, Number(session.inheritedEventCount));
    if (nextOffset > session.seq) throw new Error('DSH 会话日志短于已保存的记忆采集进度。');
    entry = { session, identity, memory, generator,
      cursor: { nextOffset, maintenancePending: memory.listInputEvents({ statuses: ['pending', 'processing'], limit: 1 }).total > 0 },
      controller, running: null, console: null, consoleStarting: null, error: null };
    this.sessions.set(session.id, entry);
    return entry;
  }

  /** Reads only the unconsumed half-open sequence range, then saves its receipt. */
  consume(session) {
    const entry = this.require(session);
    const upper = Number(session.seq);
    let inserted = 0;
    while (entry.cursor.nextOffset < upper) {
      const end = Math.min(upper, entry.cursor.nextOffset + this.config.historyBatchSize);
      const events = session.snapshotEvents(SessionLogOffset(entry.cursor.nextOffset), SessionLogOffset(end));
      const converted = [];
      for (const event of events) {
        const convertedEvent = memoryEvent(session, event, entry.identity);
        if (convertedEvent) converted.push(convertedEvent);
      }
      const receipt = entry.memory.appendEventSources({ scope: sourceScope(session, end), events: converted });
      inserted += receipt.inserted;
      entry.cursor = { nextOffset: end, maintenancePending: entry.cursor.maintenancePending || converted.length > 0 };
    }
    return { entry, inserted };
  }

  report(error) {
    this.ctx.logger.warn(`Suzu Memory: ${error.code || error.name || 'ERROR'}: ${error.message}`);
  }

  observe(session) {
    if (this.closing) return;
    try { this.consume(session); }
    catch (error) { this.report(error); }
  }

  maintain(session, { force = false } = {}) {
    const { entry } = this.consume(session);
    if (entry.running) return entry.running;
    if (!force && !entry.cursor.maintenancePending) return Promise.resolve({ status: 'idle' });
    const work = async () => {
      do {
        const offset = entry.cursor.nextOffset;
        const result = await entry.memory.runMaintenance({
          generator: entry.generator, structureGenerator: entry.generator, retrievalContextGenerator: entry.generator,
          embeddingProvider: entry.memory.providers.embedding,
          maximumInputBatches: this.config.maximumInputBatches,
          maximumTasks: this.config.maximumMaintenanceTasks,
          maximumStateRequests: this.config.maximumStateRequests,
          maximumConsolidationRuns: this.config.maximumConsolidationRuns,
          sourceScope: sourceScope(session, offset),
          signal: entry.controller.signal,
        });
        entry.controller.signal.throwIfAborted();
        if (result.status === 'completed-with-failures') {
          entry.error = '记忆整理尚有失败任务，可查看审核台或再次执行整理。';
          return result;
        }
        entry.error = null;
        if (entry.cursor.nextOffset === offset) {
          const pending = entry.memory.listInputEvents({ statuses: ['pending'], limit: 1 }).total;
          const progressed = result.semantic?.inputBatches?.some(batch => ['processed', 'quarantined'].includes(batch.status));
          if (pending > 0 && progressed) continue;
          if (pending > 0) return result;
          entry.cursor.maintenancePending = false;
          return result;
        }
      } while (!entry.controller.signal.aborted);
    };
    entry.running = work().catch(error => {
      entry.error = `记忆整理未完成：${error.code || error.name}。`;
      throw error;
    }).finally(() => { entry.running = null; });
    return entry.running;
  }

  idle(session) {
    if (!this.config.automaticMaintenance || this.closing) return;
    try { void this.maintain(session).catch(error => { if (!this.closing) this.report(error); }); }
    catch (error) { this.report(error); }
  }

  async consoleUrl(entry) {
    if (!this.config.consoleEnabled) return null;
    if (entry.consoleStarting) return entry.consoleStarting;
    if (entry.console) return entry.console.url;
    entry.consoleStarting = (async () => {
      const service = Object.create(entry.memory);
      service.withRepository = (callback, options = {}) => entry.memory.withRepository(callback, {
        ...options, sourceScope: sourceScope(entry.session),
        signal: options.signal ? AbortSignal.any([entry.controller.signal, options.signal]) : entry.controller.signal,
      });
      const server = createMemoryHttpServer({ service });
      try {
        const address = await server.listen({ host: '127.0.0.1', port: 0 });
        if (entry.controller.signal.aborted) { await server.close(); return null; }
        entry.console = { server, url: `${address.baseUrl}/console/` };
        return entry.console.url;
      } catch (error) { await server.close(); throw error; }
    })().finally(() => { entry.consoleStarting = null; });
    return entry.consoleStarting;
  }

  release(session) {
    const entry = this.sessions.get(session.id);
    if (!entry || entry.session !== session) return Promise.resolve();
    this.sessions.delete(session.id);
    entry.controller.abort();
    const closing = (async () => {
      await Promise.allSettled([entry.running, entry.consoleStarting]);
      if (entry.console) await entry.console.server.close();
    })();
    this.closures.add(closing);
    return closing.finally(() => this.closures.delete(closing));
  }

  async close() {
    this.closing = true;
    const releases = [...this.sessions.values()].map(entry => this.release(entry.session));
    await Promise.all([...releases, ...this.closures]);
  }
}
