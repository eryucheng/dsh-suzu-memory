import path from 'node:path';
import os from 'node:os';
import z from '@deepseek-ai/schemastery';
import { DEFAULT_LENGTH_ARCHIVE_POLICY } from '@suzu-memory/ingestion';
import { DEFAULT_GENERATION_MAX_OUTPUT_TOKENS } from '@suzu-memory/providers';
import { liveValue, validateSchedule } from './schedule.mjs';

const LIVE_KEYS = ['enabled', 'automaticMaintenance', 'offPeakOnly', 'offPeakSchedule', 'batchedCompaction', 'compactionBatchCharacters', 'compactionConcurrency'];

export const Config = z.object({
  enabled: z.boolean().default(true).volatile().description('启用 Suzu Memory；关闭后停止采集、召回、整理及提示词替换，保留已有数据。'),
  dataRoot: z.string().default('').description('记忆数据目录；留空使用当前 DSH 配置目录下的 suzu-memory。'),
  memoryOwner: z.string().default('Assistant'),
  userName: z.string().default('User'),
  timeZone: z.string().default('').description('记忆使用的时区；留空跟随系统时区，例如 Asia/Shanghai。'),
  analysisProvider: z.string().default('').description('留空沿用当前会话的模型提供者。'),
  analysisModel: z.string().default('').description('留空沿用当前会话的模型。'),
  analysisTimeoutMs: z.number().step(1).min(1000).max(600000).default(180000),
  analysisMaxTokens: z.number().step(1).min(256).max(64000).default(DEFAULT_GENERATION_MAX_OUTPUT_TOKENS),
  maximumOutputCharacters: z.number().step(1).min(1024).max(2000000).default(262144),
  automaticMaintenance: z.boolean().default(true).volatile().description('累计内容达到批次长度后在后台整理，压缩时处理剩余内容。'),
  offPeakOnly: z.boolean().default(false).volatile().description('自动整理仅在配置的波谷时段运行；立即整理不受时段限制。'),
  offPeakSchedule: z.object({
    timeZone: z.string().pattern(/\S/u).default('Asia/Shanghai'),
    weekends: z.boolean().default(true),
    windows: z.array(z.object({
      start: z.string().pattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/u).required(),
      end: z.string().pattern(/^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/u).required(),
    }).default(undefined)).min(1)
      .default([{ start: '00:00', end: '09:00' }, { start: '12:00', end: '14:00' }, { start: '18:00', end: '24:00' }]),
  }).default({}).volatile(),
  batchedCompaction: z.boolean().default(true).volatile().description('旧对话超过长度上限时分段摘要，再合并为一个压缩摘要。'),
  compactionBatchCharacters: z.union([z.const(0), z.number().step(1).min(4000).max(Number.MAX_SAFE_INTEGER)]).default(0).volatile()
    .description('每段压缩原文的可选字符上限；0 表示按压缩模型的可用上下文自动分批。'),
  compactionConcurrency: z.number().step(1).min(1).max(8).default(3).volatile()
    .description('分段压缩的最大并发请求数。'),
  archiveBatchCharacters: z.number().step(1).min(1000).max(48000).default(DEFAULT_LENGTH_ARCHIVE_POLICY.maximumCoreCharacters).description('每批正文的目标字符数。'),
  archiveBatchMessages: z.number().step(1).min(1).max(500).default(DEFAULT_LENGTH_ARCHIVE_POLICY.maximumCoreMessages).description('每批正文的完整消息条数上限；字符数或条数任一达标后分批整理。'),
  archiveContextCharacters: z.number().step(1).min(128).max(48000).default(DEFAULT_LENGTH_ARCHIVE_POLICY.maximumContextCharacters).description('前文和后续一轮各自的最大字符数。'),
  archiveRequestCharacters: z.number().step(1).min(16000).max(200000).default(DEFAULT_LENGTH_ARCHIVE_POLICY.maximumRequestCharacters).description('单次抽取请求的总字符上限，包含提示词与前后文。'),
  maximumInputBatches: z.number().step(1).min(1).max(20).default(2),
  maximumMaintenanceTasks: z.number().step(1).min(1).max(100).default(10),
  maximumStateRequests: z.number().step(1).min(1).max(100).default(10),
  maximumConsolidationRuns: z.number().step(1).min(1).max(20).default(3),
  historyBatchSize: z.number().step(1).min(1).max(1000).default(128),
  recallLimit: z.number().step(1).min(1).max(10).default(5),
  recallMaximumCharacters: z.number().step(1).min(1000).max(48000).default(12000),
  consoleEnabled: z.boolean().default(true),
  embedding: z.union([z.const(null), z.object({
    enabled: z.boolean().default(true),
    baseUrl: z.string().pattern(/^https?:\/\/\S+$/u).required(),
    model: z.string().pattern(/\S/u).required(),
    apiKey: z.string().role('secret'),
    apiKeyEnv: z.string(),
    dimensions: z.number().step(1).min(1),
    timeoutMs: z.number().step(1).min(1000).max(600000).default(30000),
  })]).default(null).volatile(),
});

export function embeddingConfig(config) {
  return typeof config.embedding?.get === 'function' ? config.embedding.get() : config.embedding;
}

export function resolveConfig(input, profileContext) {
  const config = Config(input ? { ...input, ...Object.fromEntries(LIVE_KEYS.map(key => [key, liveValue(input[key])])), embedding: embeddingConfig(input) } : input);
  validateSchedule(liveValue(config.offPeakSchedule));
  if (config.timeZone) new Intl.DateTimeFormat('en', { timeZone: config.timeZone });
  if (Boolean(config.analysisProvider) !== Boolean(config.analysisModel)) {
    throw new Error('analysisProvider 和 analysisModel 必须同时填写，或同时留空。');
  }
  return {
    ...config,
    ...Object.fromEntries(LIVE_KEYS.map(key => [key, liveValue(config[key])])),
    ...Object.fromEntries(LIVE_KEYS.filter(key => typeof input?.[key]?.get === 'function').map(key => [key, input[key]])),
    embedding: typeof input?.embedding?.get === 'function' ? input.embedding : embeddingConfig(config),
    dataRoot: path.resolve(config.dataRoot || path.join(profileContext?.dir || path.join(os.homedir(), '.dsh'), 'suzu-memory')),
  };
}
