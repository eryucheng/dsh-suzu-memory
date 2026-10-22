import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

for (const directory of ['src', 'scripts', 'test']) {
  for (const item of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (item.isFile() && item.name.endsWith('.mjs')) execFileSync(process.execPath, ['--check', join(item.parentPath, item.name)], { stdio: 'inherit' });
  }
}
