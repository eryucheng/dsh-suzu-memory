import path from 'node:path';
import os from 'node:os';
import z from '@deepseek-ai/schemastery';

export const Config = z.object({
  dataRoot: z.string().default('').description('记忆数据目录；留空使用当前 DSH 配置目录下的 suzu-memory。'),
  memoryOwner: z.string().default('Assistant'),
  userName: z.string().default('User'),
  analysisProvider: z.string().default('').description('留空沿用当前会话的模型提供者。'),
  analysisModel: z.string().default('').description('留空沿用当前会话的模型。'),
  analysisTimeoutMs: z.number().step(1).min(1000).max(600000).default(180000),
  analysisMaxTokens: z.number().step(1).min(256).max(64000).default(16384),
  maximumOutputCharacters: z.number().step(1).min(1024).max(2000000).default(262144),
  automaticMaintenance: z.boolean().default(true),
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
  const config = Config(input ? { ...input, embedding: embeddingConfig(input) } : input);
  if (Boolean(config.analysisProvider) !== Boolean(config.analysisModel)) {
    throw new Error('analysisProvider 和 analysisModel 必须同时填写，或同时留空。');
  }
  return {
    ...config,
    embedding: typeof input?.embedding?.get === 'function' ? input.embedding : embeddingConfig(config),
    dataRoot: path.resolve(config.dataRoot || path.join(profileContext?.dir || path.join(os.homedir(), '.dsh'), 'suzu-memory')),
  };
}
