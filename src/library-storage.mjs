import path from 'node:path';
import { existsSync } from 'node:fs';
import { readdir, lstat, realpath, rm } from 'node:fs/promises';
import { resolveMemoryServicePaths } from '@suzu-memory/service';

export function libraryPaths(dataRoot, id) {
  if (!/^dsh-[a-f0-9]{64}$/u.test(id)) throw Object.assign(new Error('无效的记忆库。'), { code: 'LIBRARY_NOT_FOUND' });
  return resolveMemoryServicePaths({ dataRoot, agentId: id });
}

export function libraryExists(dataRoot, id) {
  return existsSync(libraryPaths(dataRoot, id).databasePath);
}

export async function storedLibraryIds(dataRoot) {
  const parent = path.dirname(libraryPaths(dataRoot, 'dsh-' + '0'.repeat(64)).agentRoot);
  let entries;
  try { entries = await readdir(parent, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return entries.filter(item => item.isDirectory() && /^dsh-[a-f0-9]{64}$/u.test(item.name)).map(item => item.name);
}

export async function removeStoredLibrary(dataRoot, id) {
  const { agentRoot } = libraryPaths(dataRoot, id);
  try {
    const stat = await lstat(agentRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('记忆库目录不是普通目录，未执行删除。');
    const [parent, target] = await Promise.all([realpath(path.dirname(agentRoot)), realpath(agentRoot)]);
    if (target !== path.join(parent, id)) throw new Error('记忆库目录超出预期位置，未执行删除。');
    await rm(agentRoot, { recursive: true, force: true });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
