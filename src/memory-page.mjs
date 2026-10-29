import { readFileSync } from 'node:fs';

const assets = new Map([
  ['/memory/', ['index.html', 'text/html; charset=utf-8']],
  ['/memory/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/memory/renderer.js', ['renderer.js', 'text/javascript; charset=utf-8']],
  ['/memory/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/memory/base.css', ['base.css', 'text/css; charset=utf-8']],
  ['/memory/review.css', ['review.css', 'text/css; charset=utf-8']],
  ['/console/', ['review.html', 'text/html; charset=utf-8']],
]);

/** Mount adapter assets beside the existing Memory HTTP API and review console. */
export function mountMemoryPage(server, conversations) {
  const handlers = server.listeners('request');
  for (const handler of handlers) server.removeListener('request', handler);
  server.on('request', (request, response) => {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    if (request.method === 'GET' && conversations && (pathname === '/memory/sessions' || pathname.startsWith('/memory/sessions/'))) {
      void (async () => {
        try {
          const data = pathname === '/memory/sessions'
            ? { currentId: conversations.sessionId, items: await conversations.list() }
            : { url: await conversations.open(decodeURIComponent(pathname.slice('/memory/sessions/'.length))) };
          response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          response.end(JSON.stringify({ status: 'success', data }));
        } catch (error) {
          response.writeHead(error.code === 'SESSION_NOT_FOUND' ? 404 : 503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          response.end(JSON.stringify({ status: 'error', error: { code: error.code || 'SESSION_UNAVAILABLE', message: '会话暂不可访问，请刷新后重试。' } }));
        }
      })();
      return;
    }
    const route = assets.get(pathname);
    if (request.method === 'GET' && route) {
      response.writeHead(200, { 'content-type': route[1], 'cache-control': 'no-cache' });
      response.end(readFileSync(new URL('./memory-page/' + route[0], import.meta.url)));
    } else for (const handler of handlers) handler.call(server, request, response);
  });
}
