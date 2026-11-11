#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { memoryBenchmarkMain } from '@suzu-memory/evaluation/benchmark-cli';

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await memoryBenchmarkMain();
}
