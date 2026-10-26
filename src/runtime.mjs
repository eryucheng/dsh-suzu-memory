import { SessionLogOffset } from '@deepseek-ai/dsh-session';
import { createMemoryService } from '@suzu-memory/service';
import { createOpenAiCompatibleEmbeddingProvider } from '@suzu-memory/providers';
import { createMemoryHttpServer } from '@suzu-memory/server';
import { memoryEvent, sessionMemoryId, sourceScope } from './events.mjs';
import { createDshGenerator } from './generator.mjs';
import { embeddingConfig } from './config.mjs';

/** Owns adapters only for live DSH sessions. The Memory service owns all memory data. */
export class DshMemoryRuntime {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
    this.sessions = new Map();
    this.closing = false;
    this.closures = new Set();
    this.embedding = null;
    this.refreshEmbedding();
  }

  refreshEmbedding() {
    const config = embeddingConfig(this.config);
    if (config === this.embeddingConfiguration) return;
    const embedding = config && config.enabled !== false ? createOpenAiCompatibleEmbeddingProvider(config) : null;
    this.embeddingConfiguration = config;
    this.embedding = embedding;
    for (const entry of this.sessions.values()) {
      entry.memory = this.memoryService(entry.session, entry.identity, entry.generator, this.sessionEmbedding(entry.controller));
    }
  }

  sessionEmbedding(controller) {
    const provider = this.embedding;
    if (!provider) return null;
    const optionsFor = (options = {}) => ({ ...options,
      signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal });
    const embedding = Object.assign((text, options) => provider(text, optionsFor(options)), {
      model: provider.model, dimensions: provider.dimensions,
      embedMany: (texts, options) => provider.embedMany(texts, optionsFor(options)),
    });
    return embedding;
  }

  memoryService(session, identity, generator, embedding) {
    return createMemoryService({
      dataRoot: this.config.dataRoot, agentId: sessionMemoryId(session.id),
      defaults: { primaryUserId: identity.userId, userName: identity.userName,
        memoryOwner: identity.memoryOwner, companionId: sessionMemoryId(session.id),
        retrieval: { timeZone: this.config.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone } },
      providers: { generator, structureGenerator: generator, retrievalContextGenerator: generator, embedding },
    });
  }

  require(session) {
    if (this.closing) throw new Error('记忆插件正在退出。');
    this.refreshEmbedding();
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
    const embedding = this.sessionEmbedding(controller);
    const memory = this.memoryService(session, identity, generator, embedding);
    memory.initialize();
    memory.recoverProcessingEvents();
    memory.recoverRunningMaintenance();
    const progress = memory.getEventSourceProgress({ scope: sourceScope(session) });
    const nextOffset = Math.max(progress.consumedThroughSequence, Number(session.inheritedEventCount));
    if (nextOffset > session.seq) throw new Error('DSH 会话日志短于已保存的记忆采集进度。');
    entry = { session, identity, memory, generator,
      cursor: { nextOffset }, pendingCharacters: 0, pendingEvents: 0,
      flushThrough: 0, autoCheckedOffset: -1, pendingDirty: false,
      controller, running: null, console: null, consoleStarting: null, error: null };
    this.refreshPending(entry);
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
      let receipt;
      try { receipt = entry.memory.appendEventSources({ scope: sourceScope(session, end), events: converted }); }
      catch (error) { entry.pendingDirty = true; throw error; }
      inserted += receipt.inserted;
      if (receipt.inserted > 0) {
        entry.pendingCharacters += converted.reduce((sum, event) => sum + event.content.text.length, 0);
        entry.pendingEvents += converted.length;
      }
      entry.cursor.nextOffset = end;
    }
    if (entry.pendingDirty) this.refreshPending(entry);
    return { entry, inserted };
  }

  refreshPending(entry) {
    const pending = entry.memory.listInputEvents({ statuses: ['pending', 'processing'], limit: 500, sourceOrder: true });
    entry.pendingEvents = pending.total;
    entry.pendingCharacters = pending.items.reduce((sum, event) => sum + String(event.content?.text || '').length, 0);
    entry.pendingDirty = false;
  }

  chunkPolicy(flush) {
    return { maximumCoreCharacters: this.config.archiveBatchCharacters,
      maximumCoreMessages: this.config.archiveBatchMessages,
      maximumContextCharacters: this.config.archiveContextCharacters,
      maximumRequestCharacters: this.config.archiveRequestCharacters, flush,
      resolveReply: row => {
        const source = row.metadata?.eventSource;
        if (source?.sender?.kind !== 'agent' || source.dsh?.replyComplete === false) return null;
        return { id: source.dsh?.turn === undefined ? source.eventId : `${source.dsh.sessionId}:${source.dsh.turn}`,
          complete: true, lastEventId: source.eventId };
      },
    };
  }

  report(error) {
    this.ctx.logger.warn(`Suzu Memory: ${error.code || error.name || 'ERROR'}: ${error.message}`);
  }

  observe(session) {
    if (this.closing) return;
    try { this.consume(session); }
    catch (error) { this.report(error); }
  }

  maintain(session, { force = false, lane = 'all' } = {}) {
    const { entry } = this.consume(session);
    if (force) entry.flushThrough = Math.max(entry.flushThrough, entry.cursor.nextOffset);
    if (entry.running) return entry.running;
    if (!force && !entry.pendingEvents) return Promise.resolve({ status: 'idle' });
    const work = async () => {
      do {
        const flushing = entry.flushThrough;
        const offset = flushing || entry.cursor.nextOffset;
        const result = await entry.memory.runMaintenance({
          lane,
          generator: entry.generator, structureGenerator: entry.generator, retrievalContextGenerator: entry.generator,
          embeddingProvider: entry.memory.providers.embedding,
          maximumInputBatches: this.config.maximumInputBatches,
          maximumTasks: this.config.maximumMaintenanceTasks,
          maximumStateRequests: this.config.maximumStateRequests,
          maximumConsolidationRuns: this.config.maximumConsolidationRuns,
          chunkPolicy: this.chunkPolicy(Boolean(flushing)),
          sourceScope: sourceScope(session, offset),
          signal: entry.controller.signal,
        });
        entry.controller.signal.throwIfAborted();
        if (result.status === 'completed-with-failures') {
          entry.error = '记忆整理尚有失败任务，可查看审核台或再次执行整理。';
          return result;
        }
        entry.error = null;
        this.refreshPending(entry);
        const last = result.semantic?.inputBatches?.at(-1);
        if (last?.status === 'skipped' && entry.flushThrough === flushing) entry.flushThrough = 0;
        if (entry.flushThrough && entry.flushThrough !== flushing) continue;
        if (last?.status === 'waiting') {
          if (entry.cursor.nextOffset !== offset
            && (entry.pendingCharacters >= this.config.archiveBatchCharacters || entry.pendingEvents >= this.config.archiveBatchMessages)) continue;
          return result;
        }
        if (!entry.pendingEvents) { entry.flushThrough = 0; return result; }
        if (entry.cursor.nextOffset === offset) {
          const progressed = result.semantic?.inputBatches?.some(batch => ['processed', 'quarantined'].includes(batch.status));
          if (progressed) continue;
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

  scheduleArchive(session, { flush = false } = {}) {
    if (!this.config.automaticMaintenance || this.closing) return;
    try {
      const { entry } = this.consume(session);
      if (!entry.pendingEvents) return;
      if (!flush) {
        if (entry.running || entry.autoCheckedOffset === entry.cursor.nextOffset) return;
        if (!entry.flushThrough && entry.pendingCharacters < this.config.archiveBatchCharacters && entry.pendingEvents < this.config.archiveBatchMessages) return;
      }
      entry.autoCheckedOffset = entry.cursor.nextOffset;
      void this.maintain(session, { force: flush }).catch(error => { if (!this.closing) this.report(error); });
    }
    catch (error) { this.report(error); }
  }

  async consoleUrl(entry) {
    if (!this.config.consoleEnabled) return null;
    if (entry.consoleStarting) return entry.consoleStarting;
    if (entry.console) return entry.console.url;
    entry.consoleStarting = (async () => {
      const service = Object.create(entry.memory);
      Object.defineProperty(service, 'providers', { get: () => entry.memory.providers });
      service.withRepository = (callback, options = {}) => entry.memory.withRepository(callback, {
        ...options, sourceScope: sourceScope(entry.session),
        signal: options.signal ? AbortSignal.any([entry.controller.signal, options.signal]) : entry.controller.signal,
      });
      service.runMaintenance = options => options?.lane === 'embedding' || options?.processInputEvents === false
        || !['all', 'semantic', undefined].includes(options?.lane)
        ? entry.memory.runMaintenance({ ...options, sourceScope: sourceScope(entry.session), signal: entry.controller.signal })
        : this.maintain(entry.session, { force: true, lane: options?.lane || 'all' });
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
      await entry.memory.close();
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
