import { SessionLogOffset } from '@deepseek-ai/dsh-session';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createMemoryService } from '@suzu-memory/service';
import { createOpenAiCompatibleEmbeddingProvider } from '@suzu-memory/providers';
import { memoryEvent, sessionMemoryId, sourceScope } from './events.mjs';
import { createDshGenerator } from './generator.mjs';
import { embeddingConfig } from './config.mjs';
import { maintenanceWindow, liveValue, validateSchedule } from './schedule.mjs';
import { createMemoryPage } from './memory-page.mjs';
import { DailyRequestBudget } from './request-budget.mjs';
import { libraryPaths, libraryExists, storedLibraryIds, removeStoredLibrary } from './library-storage.mjs';

const RAW_EMBEDDING = Symbol('memory-embedding-provider');

/** Owns live capture adapters and saved-library views. Memory owns the stored data. */
export class DshMemoryRuntime {
  constructor(ctx, config, isSessionEnabled = () => false, sessionSettings = null) {
    this.ctx = ctx;
    this.config = config;
    this.isSessionEnabled = isSessionEnabled;
    this.sessionSettings = sessionSettings;
    this.deleting = new Set();
    this.consoleOperations = new AsyncLocalStorage();
    this.budget = new DailyRequestBudget(config.dataRoot, () => config.dailyRequestLimit,
      config.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone);
    this.sessions = new Map();
    this.savedViews = new Map();
    this.closing = false;
    this.closures = new Set();
    this.embedding = null;
    this.compactions = new Map();
    this.controlSignal = new AbortController();
    this.controlLifetime = new AbortController();
    this.enabled = liveValue(config.enabled) !== false;
    this.timer = setInterval(() => { try { this.tick(); } catch (error) { this.report(error); } }, 30000);
    this.timer.unref?.();
    this.refreshEmbedding();
  }

  window(now = new Date()) { return maintenanceWindow(this.config, now); }

  enabledFor(session) { return !this.deleting.has(sessionMemoryId(session.id)) && liveValue(this.config.enabled) !== false && this.isSessionEnabled(session.id); }

  requireEnabled(session) {
    if (!this.enabledFor(session)) throw Object.assign(new Error('请先在设置中启用当前会话的 Suzu Memory。'), { code: 'MEMORY_DISABLED' });
  }

  async refreshSession(sessionId) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    if (!this.enabledFor(entry.session)) {
      const reason = Object.assign(new Error('当前会话的记忆已关闭。'), { code: 'MEMORY_PAUSED' });
      entry.activation.abort(reason);
      entry.workController?.abort(reason);
      await entry.running;
    } else if (entry.activation.signal.aborted) {
      await entry.running;
      if (!this.enabledFor(entry.session)) return;
      entry.activation = new AbortController();
      this.scheduleArchive(entry.session);
    }
  }

  refreshSettings() {
    validateSchedule(liveValue(this.config.offPeakSchedule));
    const enabled = liveValue(this.config.enabled) !== false;
    if (this.enabled && !enabled) this.controlSignal.abort(Object.assign(new Error('Suzu Memory 已关闭。'), { code: 'MEMORY_PAUSED' }));
    if (!this.enabled && enabled) this.controlSignal = new AbortController();
    this.enabled = enabled;
    this.refreshEmbedding();
    this.tick();
  }

  workSignal(entry) {
    const policy = this.window();
    if (entry.workController && (!this.enabledFor(entry.session) || !policy.enabled || (!entry.manualWork && !policy.allowed))) {
      entry.workController.abort(Object.assign(new Error('记忆整理已暂停。'), { code: 'MEMORY_PAUSED' }));
    }
    return entry.workController?.signal;
  }

  tick() {
    if (this.closing) return;
    for (const entry of this.sessions.values()) {
      this.workSignal(entry);
      if (!this.budget.snapshot().exhausted && entry.recovered && this.enabledFor(entry.session) && !entry.running && !entry.activation.signal.aborted && this.window().allowed && (entry.pendingEvents || entry.maintenancePending)) {
        this.scheduleArchive(entry.session, { flush: entry.deferred || (this.window().offPeakOnly && entry.autoCheckedOffset < 0) });
      }
    }
  }

  refreshEmbedding() {
    const config = embeddingConfig(this.config);
    if (config === this.embeddingConfiguration) return;
    const embedding = config && config.enabled !== false ? createOpenAiCompatibleEmbeddingProvider(config) : null;
    this.embeddingConfiguration = config;
    this.embedding = embedding;
    for (const entry of this.sessions.values()) {
      entry.memory = this.memoryService(entry.identity, entry.generator, this.sessionEmbedding(entry.controller, () => entry.activation.signal));
    }
  }

  sessionEmbedding(controller, getSignal = () => undefined, provider = this.embedding) {
    if (!provider) return null;
    provider = provider[RAW_EMBEDDING] || provider;
    const optionsFor = (options = {}) => ({ ...options,
      signal: AbortSignal.any([controller.signal, this.controlSignal.signal, getSignal(), options.signal].filter(Boolean)) });
    const invoke = async (method, text, options) => {
      const routed = optionsFor(options);
      await this.reserveRequest(controller, routed.signal);
      routed.signal.throwIfAborted();
      return method(text, routed);
    };
    const embedding = Object.assign((text, options) => invoke(provider, text, options), {
      model: provider.model, dimensions: provider.dimensions,
      [RAW_EMBEDDING]: provider,
      embedMany: (texts, options) => invoke(provider.embedMany, texts, options),
    });
    return embedding;
  }

  async reserveRequest(controller, signal) {
    try { return await this.budget.reserve(signal); }
    catch (error) {
      if (!signal?.aborted) {
        if (!error.code) error.code = 'MEMORY_BUDGET_UNAVAILABLE';
        const operation = this.consoleOperations.getStore();
        operation?.abort(error);
        for (const entry of this.sessions.values()) if (entry.controller === controller && (operation || entry.workController)) {
          entry.workController?.abort(error);
          entry.recoveryNeeded = true; entry.deferred = true; entry.maintenancePending = true; entry.error = error.message;
        }
      }
      throw error;
    }
  }

  memoryService(identity, generator, embedding) {
    return createMemoryService({
      dataRoot: this.config.dataRoot, agentId: identity.agentId,
      defaults: { primaryUserId: identity.userId, userName: identity.userName,
        memoryOwner: identity.memoryOwner, companionId: identity.agentId,
        retrieval: { timeZone: this.config.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone } },
      providers: { generator, structureGenerator: generator, retrievalContextGenerator: generator, embedding },
    });
  }

  memoryIdentity(sessionId) {
    return { agentId: sessionMemoryId(sessionId), userId: 'user', userName: this.config.userName, memoryOwner: this.config.memoryOwner };
  }

  require(session) {
    this.requireEnabled(session);
    const entry = this.view(session);
    if (!entry.recovered) {
      entry.memory.recoverProcessingEvents();
      entry.memory.recoverRunningMaintenance();
      entry.recovered = true;
      this.refreshPending(entry);
      entry.maintenancePending = this.maintenanceWork(entry).pending > 0;
    }
    return entry;
  }

  /** Opening saved data never consumes the conversation or runs model work. */
  view(session) {
    if (this.closing) throw new Error('记忆插件正在退出。');
    if (this.deleting.has(sessionMemoryId(session.id))) throw Object.assign(new Error('此会话的记忆正在删除。'), { code: 'MEMORY_DELETING' });
    this.refreshEmbedding();
    let entry = this.sessions.get(session.id);
    if (entry) {
      if (entry.session !== session) throw new Error('同一会话身份同时绑定了不同的运行实例。');
      return entry;
    }
    const identity = this.memoryIdentity(session.id);
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
      getSignal: () => AbortSignal.any([this.controlSignal.signal, entry?.activation.signal].filter(Boolean)),
      timeoutMs: this.config.analysisTimeoutMs,
      maxTokens: this.config.analysisMaxTokens,
      maximumOutputCharacters: this.config.maximumOutputCharacters,
      beforeRequest: signal => this.reserveRequest(controller, signal),
    });
    const embedding = this.sessionEmbedding(controller, () => entry?.activation.signal);
    const memory = this.memoryService(identity, generator, embedding);
    memory.initialize();
    const progress = memory.getEventSourceProgress({ scope: sourceScope(session) });
    const nextOffset = Math.max(progress.consumedThroughSequence, Number(session.inheritedEventCount));
    if (nextOffset > session.seq) throw new Error('DSH 会话日志短于已保存的记忆采集进度。');
    entry = { session, identity, memory, generator,
      cursor: { nextOffset }, pendingCharacters: 0, pendingEvents: 0,
      flushThrough: 0, autoCheckedOffset: -1, pendingDirty: false, maintenancePending: false,
      controller, activation: new AbortController(), workController: null, manualWork: false, deferred: false, recoveryNeeded: false, recovered: false,
      running: null, error: null };
    if (!this.enabledFor(session)) entry.activation.abort(Object.assign(new Error('记忆运行已暂停，已有数据仍可查看与审核。'), { code: 'MEMORY_PAUSED' }));
    this.refreshPending(entry);
    entry.maintenancePending = this.maintenanceWork(entry).pending > 0;
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

  maintenanceWork(entry, lane = 'all') {
    const { work } = entry.memory.maintenanceStatus({ limit: 1, lane });
    return { pending: work.total, completed: Object.values(work.completed).reduce((sum, value) => sum + value, 0),
      total: work.allPending };
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
    if (this.closing || !this.enabledFor(session)) return;
    try { this.consume(session); }
    catch (error) { this.report(error); }
  }

  maintain(session, { force = false, lane = 'all', automatic = false, ...maintenanceOptions } = {}) {
    const { entry } = this.consume(session);
    if (force && ['all', 'semantic'].includes(lane) && maintenanceOptions.processInputEvents !== false) entry.flushThrough = Math.max(entry.flushThrough, entry.cursor.nextOffset);
    if (entry.running) {
      if (!automatic && entry.workController.signal.aborted) {
        return entry.running.then(() => this.maintain(session, { force, lane, automatic, ...maintenanceOptions }));
      }
      if (!automatic) entry.manualWork = true;
      return entry.runningLane === 'all' || entry.runningLane === lane ? entry.running
        : entry.running.then(() => this.maintain(session, { force, lane, automatic, ...maintenanceOptions }));
    }
    if (automatic && !this.window().allowed) { entry.deferred = true; return Promise.resolve({ status: 'deferred' }); }
    if (!force && !entry.pendingEvents && !entry.maintenancePending) return Promise.resolve({ status: 'idle' });
    const work = async () => {
      entry.manualWork = !automatic;
      entry.runningLane = lane;
      entry.workController = new AbortController();
      const workSignal = AbortSignal.any([entry.controller.signal, entry.activation.signal, this.controlSignal.signal, entry.workController.signal]);
      const generator = Object.assign(request => {
        this.workSignal(entry)?.throwIfAborted();
        return entry.generator({ ...request, signal: AbortSignal.any([request.signal, workSignal].filter(Boolean)) });
      }, entry.generator);
      const embedding = this.sessionEmbedding(entry.controller, () => {
        this.workSignal(entry)?.throwIfAborted(); return workSignal;
      }, entry.memory.providers.embedding);
      if (entry.recoveryNeeded) {
        entry.memory.recoverProcessingEvents({ force: true }); entry.memory.recoverRunningMaintenance({ force: true }); entry.recoveryNeeded = false;
        this.refreshPending(entry);
      }
      entry.deferred = false;
      let previousWork = null;
      do {
        this.workSignal(entry)?.throwIfAborted();
        const flushing = entry.flushThrough;
        const offset = flushing || entry.cursor.nextOffset;
        const result = await entry.memory.runMaintenance({
          ...maintenanceOptions,
          lane,
          generator, structureGenerator: generator, retrievalContextGenerator: generator,
          embeddingProvider: embedding,
          maximumInputBatches: this.config.maximumInputBatches,
          maximumTasks: this.config.maximumMaintenanceTasks,
          maximumStateRequests: this.config.maximumStateRequests,
          maximumConsolidationRuns: this.config.maximumConsolidationRuns,
          chunkPolicy: this.chunkPolicy(Boolean(flushing)),
          sourceScope: sourceScope(session, offset),
          signal: workSignal,
        });
        entry.controller.signal.throwIfAborted();
        const remaining = this.maintenanceWork(entry, lane);
        entry.maintenancePending = remaining.total > 0;
        if (result.status === 'completed-with-failures') {
          entry.error = '记忆整理尚有失败任务，可查看审核台或再次执行整理。';
          return result;
        }
        entry.error = null;
        this.refreshPending(entry);
        const last = result.semantic?.inputBatches?.at(-1);
        if (last?.status === 'skipped' && entry.flushThrough === flushing) entry.flushThrough = 0;
        if (entry.flushThrough && entry.flushThrough !== flushing) continue;
        const maintenanceProgressed = remaining.pending > 0 && (!previousWork
          || remaining.completed > previousWork.completed || remaining.pending < previousWork.pending);
        previousWork = remaining;
        if (maintenanceProgressed) continue;
        if (!['all', 'semantic'].includes(lane) || maintenanceOptions.processInputEvents === false) return result;
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
      const budgetPaused = ['MEMORY_BUDGET_EXCEEDED', 'MEMORY_BUDGET_UNAVAILABLE'].includes(entry.workController?.signal.reason?.code);
      if (budgetPaused || entry.controller.signal.reason?.code === 'MEMORY_PAUSED' || entry.workController?.signal.reason?.code === 'MEMORY_PAUSED' || entry.activation.signal.reason?.code === 'MEMORY_PAUSED' || this.controlSignal.signal.reason?.code === 'MEMORY_PAUSED') {
        entry.recoveryNeeded = true; entry.deferred = true; entry.maintenancePending = true;
        if (budgetPaused) entry.error = entry.workController.signal.reason.message;
        return { status: budgetPaused ? 'budget-exhausted' : 'paused' };
      }
      entry.error = `记忆整理未完成：${error.code || error.name}。`;
      throw error;
    }).finally(() => { entry.running = null; entry.workController = null; entry.manualWork = false; entry.runningLane = null; });
    return entry.running;
  }

  scheduleArchive(session, { flush = false } = {}) {
    if (!this.enabledFor(session) || !this.window().automatic || !this.window().enabled || this.closing) return;
    try {
      const { entry } = this.consume(session);
      if (this.budget.snapshot().exhausted) { entry.deferred = true; return; }
      if (!this.window().allowed) {
        if (flush) entry.flushThrough = Math.max(entry.flushThrough, entry.cursor.nextOffset);
        entry.deferred = Boolean(entry.pendingEvents || entry.maintenancePending || flush);
        return;
      }
      if (!entry.pendingEvents && !entry.maintenancePending && !flush) return;
      if (!flush) {
        if (entry.running || (entry.autoCheckedOffset === entry.cursor.nextOffset && !entry.maintenancePending)) return;
        if (!entry.maintenancePending && !entry.flushThrough && entry.pendingCharacters < this.config.archiveBatchCharacters && entry.pendingEvents < this.config.archiveBatchMessages) return;
      }
      entry.autoCheckedOffset = entry.cursor.nextOffset;
      void this.maintain(session, { force: flush, automatic: true }).catch(error => { if (!this.closing) this.report(error); });
    }
    catch (error) { this.report(error); }
  }

  async consoleUrl(entry) {
    if (!this.config.consoleEnabled) return null;
    await this.startConsole();
    return this.console.urlFor(entry?.session ? sessionMemoryId(entry.session.id) : '');
  }

  async conversations() {
    if (this.conversationListing) return this.conversationListing;
    this.conversationListing = (async () => {
      const controller = this.ctx.get('sessionController');
      const rows = controller ? (await controller.list({}, this.controlLifetime.signal)).items
        : this.ctx.sessions.list().map(session => ({ sessionId: session.id,
          projections: this.ctx.get('sessionProjections')?.cachedSnapshot(session) }));
      return rows.map(row => ({ id: row.sessionId, title: row.projections?.values?.title || row.sessionId }));
    })().finally(() => { this.conversationListing = null; });
    return this.conversationListing;
  }

  async libraries() {
    const [conversations, settings, stored] = await Promise.all([
      this.conversations(), this.sessionSettings?.storedSessions() || [], storedLibraryIds(this.config.dataRoot),
    ]);
    const known = new Map(conversations.map(item => [sessionMemoryId(item.id), item]));
    const identities = new Map(settings.map(item => [item.libraryId, item.id]));
    return [...new Set([...known.keys(), ...stored])].map(id => ({ id,
      sessionId: known.get(id)?.id || identities.get(id) || null,
      title: known.get(id)?.title || identities.get(id) || id.slice(0, 16),
      orphaned: !known.has(id), stored: stored.includes(id),
    }));
  }

  async libraryService(libraryId) {
    if (this.closing || this.deleting.has(libraryId) || !libraryExists(this.config.dataRoot, libraryId)) {
      throw Object.assign(new Error('记忆库不存在或正在删除。'), { code: 'LIBRARY_NOT_FOUND' });
    }
    const live = [...this.sessions.values()].find(entry => entry.identity.agentId === libraryId);
    if (live) return this.consoleService(live.session.id, () => live.memory, live.controller, libraryId);
    let saved = this.savedViews.get(libraryId);
    if (!saved) {
      const row = (await this.libraries()).find(item => item.id === libraryId);
      if (!row || this.deleting.has(libraryId)) throw Object.assign(new Error('记忆库不存在。'), { code: 'LIBRARY_NOT_FOUND' });
      const memory = this.memoryService({ agentId: libraryId, userId: 'user',
        userName: this.config.userName, memoryOwner: this.config.memoryOwner }, null, null);
      memory.initialize();
      saved = { memory, sessionId: row.sessionId, controller: new AbortController() };
      this.savedViews.set(libraryId, saved);
    }
    return this.consoleService(saved.sessionId, () => this.sessions.get(saved.sessionId)?.memory || saved.memory, saved.controller, libraryId);
  }

  consoleService(id, getMemory, controller, libraryId = sessionMemoryId(id)) {
    const service = Object.create(getMemory());
    Object.defineProperty(service, 'providers', { get: () => getMemory().providers });
    service.withRepository = (callback, options = {}) => {
      const memory = getMemory();
      const live = id ? this.ctx.sessions.get(id) || this.sessions.get(id)?.session : null;
      const scope = { owner: 'deepseek-harness', agentId: libraryId, eventUpperBound: Number(live?.seq ?? 0), clears: [] };
      if (!live) scope.eventUpperBound = memory.getEventSourceProgress({ scope }).consumedThroughSequence;
      // Budget admission cancels the owning operation before input failure counters can advance.
      const operation = this.consoleOperations.getStore() || new AbortController();
      return this.consoleOperations.run(operation, () => memory.withRepository(callback, { ...options, sourceScope: scope,
        signal: AbortSignal.any([controller.signal, operation.signal, options.signal].filter(Boolean)) }));
    };
    service.runMaintenance = options => {
      const live = id ? this.ctx.sessions.get(id) || this.sessions.get(id)?.session : null;
      if (!live) throw Object.assign(new Error('请先在 DSH 中打开此会话，再执行整理。'), { code: 'SESSION_NOT_ACTIVE' });
      return this.maintain(live, { ...options, force: true, lane: options?.lane || 'all' });
    };
    return service;
  }

  async startConsole() {
    if (this.closing) throw new Error('记忆插件正在退出。');
    if (this.consoleStarting) return this.consoleStarting;
    if (this.console) return;
    this.consoleStarting = (async () => {
      const server = createMemoryPage({ list: () => this.libraries(), open: id => this.libraryService(id),
        remove: id => this.deleteLibrary(id), budget: () => this.budget.status() });
      try {
        await server.listen();
        if (this.closing) { await server.close(); return; }
        this.console = server;
      } catch (error) { await server.close(); throw error; }
    })().finally(() => { this.consoleStarting = null; });
    return this.consoleStarting;
  }

  deleteLibrary(libraryId) {
    const task = this.removeLibrary(libraryId);
    this.closures.add(task);
    return task.finally(() => this.closures.delete(task));
  }

  async removeLibrary(libraryId) {
    libraryPaths(this.config.dataRoot, libraryId);
    if (this.deleting.has(libraryId)) throw Object.assign(new Error('记忆库正在删除。'), { code: 'MEMORY_DELETING' });
    this.deleting.add(libraryId);
    try {
      const entry = [...this.sessions.values()].find(entry => entry.identity.agentId === libraryId);
      const saved = this.savedViews.get(libraryId);
      const sessionId = entry?.session.id || saved?.sessionId || (await this.libraries()).find(item => item.id === libraryId)?.sessionId;
      if (sessionId && this.sessionSettings) {
        const settings = this.sessionSettings.read(sessionId);
        const disabled = await this.sessionSettings.setMemoryEnabled(sessionId, false, settings.revision);
        if (!disabled.saved) throw new Error('会话设置已变化，请刷新后重试删除。');
      }
      const reason = Object.assign(new Error('记忆库正在删除。'), { code: 'MEMORY_PAUSED' });
      entry?.controller.abort(reason); saved?.controller.abort(reason);
      await this.console?.block(libraryId);
      if (entry) await this.release(entry.session);
      if (saved) { await saved.memory.close(); this.savedViews.delete(libraryId); }
      await removeStoredLibrary(this.config.dataRoot, libraryId);
      await this.sessionSettings?.removeLibrary(libraryId);
    } finally { this.deleting.delete(libraryId); this.console?.unblock(libraryId); }
  }

  release(session) {
    const entry = this.sessions.get(session.id);
    if (!entry || entry.session !== session) return Promise.resolve();
    this.sessions.delete(session.id);
    this.console?.invalidate(entry.identity.agentId);
    entry.controller.abort();
    const closing = (async () => {
      await Promise.allSettled([entry.running]);
      await entry.memory.close();
    })();
    this.closures.add(closing);
    return closing.finally(() => this.closures.delete(closing));
  }

  async close() {
    this.closing = true;
    clearInterval(this.timer);
    this.controlSignal.abort();
    this.controlLifetime.abort();
    this.compactions.clear();
    await Promise.allSettled([this.consoleStarting]);
    const releases = [...this.sessions.values()].map(entry => this.release(entry.session));
    const saved = [...this.savedViews.values()].map(async entry => {
      entry.controller.abort();
      await entry.memory.close();
    });
    this.savedViews.clear();
    await Promise.all([...releases, ...saved, ...this.closures]);
    await this.console?.close();
  }
}
