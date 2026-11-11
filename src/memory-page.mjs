import http from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createMemoryHttpServer } from '@suzu-memory/server';
import { getMemoryConsoleAsset } from '@suzu-memory/console';

const assets = new Map([
  ['/memory/', ['index.html', 'text/html; charset=utf-8']],
  ['/memory/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/memory/renderer.js', ['renderer.js', 'text/javascript; charset=utf-8']],
  ['/memory/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/memory/base.css', ['base.css', 'text/css; charset=utf-8']],
  ['/memory/review.css', ['review.css', 'text/css; charset=utf-8']],
  ['/console/', ['review.html', 'text/html; charset=utf-8']],
]);

function json(response, status, data) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(status < 400 ? { status: 'success', data } : { status: 'error', error: data }));
}

function authenticated(request, key) {
  const value = String(request.headers.authorization || '').replace(/^Bearer /iu, '');
  return Buffer.byteLength(value) === key.length && timingSafeEqual(Buffer.from(value), Buffer.from(key));
}

/** One profile workspace; static assets contain no memory, and every data route requires a credential. */
export function createMemoryPage({ list, open, remove, budget }) {
  const key = randomBytes(32).toString('base64url');
  const handlers = new Map(), active = new Map(), blocked = new Set();
  let address;
  const server = http.createServer((request, response) => {
    void handle(request, response).catch(error => {
      if (!response.headersSent) json(response, error.code === 'LIBRARY_NOT_FOUND' ? 404 : 503,
        { code: error.code || 'MEMORY_UNAVAILABLE', message: '记忆操作未完成，请刷新后重试。' });
      else response.destroy();
    });
  });
  const urlFor = id => `${address.baseUrl}/memory/?library=${encodeURIComponent(id || '')}#key=${key}`;

  async function handle(request, response) {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'");
    // Loopback binding alone does not reject a rebound Host or a foreign Origin.
    if (request.headers.host !== `127.0.0.1:${address.port}`
      || (request.headers.origin && request.headers.origin !== address.baseUrl)
      || (['cross-site', 'same-site'].includes(request.headers['sec-fetch-site'])
        && !(request.method === 'GET' && request.headers['sec-fetch-mode'] === 'navigate' && request.headers['sec-fetch-dest'] === 'document'))) {
      json(response, 403, { code: 'ORIGIN_REFUSED', message: '不允许此来源访问。' }); return;
    }
    const url = new URL(request.url, address.baseUrl);
    if (url.origin !== address.baseUrl) { json(response, 403, { code: 'ORIGIN_REFUSED' }); return; }
    const pathname = url.pathname;
    if (request.method === 'GET') {
      const route = assets.get(pathname);
      const asset = route ? { contentType: route[1], content: readFileSync(new URL('./memory-page/' + route[0], import.meta.url)) }
        : getMemoryConsoleAsset(pathname);
      if (asset) {
        let content = asset.content;
        if (pathname === '/console/') {
          const id = url.searchParams.get('library') || '';
          if (!/^dsh-[a-f0-9]{64}$/u.test(id)) { json(response, 400, { code: 'LIBRARY_NOT_FOUND' }); return; }
          content = String(content).replace('<head>', `<head><meta name="suzu-memory-api-base" content="/libraries/${id}/">`);
        }
        response.writeHead(200, { 'content-type': asset.contentType }); response.end(content); return;
      }
    }
    if (!authenticated(request, key)) { json(response, 401, { code: 'UNAUTHORIZED', message: '请从 DSH 重新打开记忆页面。' }); return; }
    if (request.method === 'GET' && pathname === '/memory/sessions') {
      json(response, 200, { currentId: url.searchParams.get('library') || '', items: await list(), budget: await budget() }); return;
    }
    const selected = /^\/memory\/sessions\/(dsh-[a-f0-9]{64})$/u.exec(pathname);
    if (selected && request.method === 'GET') {
      if (!(await list()).some(item => item.id === selected[1])) throw Object.assign(new Error('记忆库不存在。'), { code: 'LIBRARY_NOT_FOUND' });
      json(response, 200, { url: urlFor(selected[1]) }); return;
    }
    if (selected && request.method === 'DELETE') {
      if (request.headers['x-suzu-confirm-delete'] !== selected[1]) { json(response, 400, { code: 'DELETE_CONFIRMATION_REQUIRED' }); return; }
      await remove(selected[1]);
      json(response, 200, { deleted: selected[1] }); return;
    }
    const library = /^\/libraries\/(dsh-[a-f0-9]{64})(\/v1\/.*)$/u.exec(pathname);
    if (!library) { json(response, 404, { code: 'NOT_FOUND' }); return; }
    const id = library[1];
    if (blocked.has(id)) { json(response, 409, { code: 'MEMORY_DELETING' }); return; }
    let settle;
    const done = new Promise(resolve => { settle = resolve; });
    if (!active.has(id)) active.set(id, new Set());
    active.get(id).add(done);
    try {
      if (!handlers.has(id)) {
        const opening = (async () => {
          const service = await open(id);
          if (blocked.has(id)) throw Object.assign(new Error('记忆正在删除。'), { code: 'MEMORY_DELETING' });
          const child = createMemoryHttpServer({ service, apiKey: key }).server;
          return { server: child, handle: child.listeners('request')[0] };
        })();
        handlers.set(id, opening);
        opening.catch(() => { if (handlers.get(id) === opening) handlers.delete(id); });
      }
      request.url = library[2] + url.search;
      const child = await handlers.get(id);
      await child.handle.call(child.server, request, response);
    } finally {
      active.get(id)?.delete(done);
      if (!active.get(id)?.size) active.delete(id);
      settle();
    }
  }

  return {
    server,
    urlFor,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const port = server.address().port;
      address = { port, baseUrl: `http://127.0.0.1:${port}` };
    },
    invalidate(id) { handlers.delete(id); },
    async block(id) { blocked.add(id); await Promise.all([...(active.get(id) || [])]); handlers.delete(id); },
    unblock(id) { blocked.delete(id); },
    async close() {
      if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      handlers.clear();
    },
  };
}
