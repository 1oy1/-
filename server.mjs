import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Store } from './lib/store.mjs';
import { generateSupportReply } from './lib/support.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');
const SESSION_TTL = 8 * 60 * 60 * 1000;
const MAX_BODY = 2 * 1024 * 1024;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

function sendJson(response, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  response.end(body);
}

function sendError(response, status, message, details) {
  sendJson(response, status, { error: message, ...(details ? { details } : {}) });
}

function parseCookies(request) {
  const header = request.headers.cookie || '';
  return Object.fromEntries(header.split(';').map((part) => {
    const index = part.indexOf('=');
    if (index < 0) return ['', ''];
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([key]) => key));
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('请求内容过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('JSON 格式错误');
  }
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function sessionCookie(token, maxAge = Math.floor(SESSION_TTL / 1000)) {
  const secure = process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== 'false' ? '; Secure' : '';
  return `xy_admin=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function getAdminSession(request, sessions) {
  const token = parseCookies(request).xy_admin;
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL;
  return { token, ...session };
}

async function serveStatic(request, response, pathname) {
  let safePath = pathname === '/' ? '/index.html' : pathname === '/admin' ? '/admin.html' : pathname;
  try {
    safePath = decodeURIComponent(safePath);
  } catch {
    sendError(response, 400, '无效的路径');
    return;
  }
  const filePath = path.resolve(PUBLIC_DIR, `.${safePath}`);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendError(response, 403, '禁止访问');
    return;
  }
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error('not a file');
    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': ['.html', '.js', '.css'].includes(ext) ? 'no-cache' : 'public, max-age=86400'
    };
    response.writeHead(200, headers);
    if (request.method === 'HEAD') response.end();
    else response.end(await fs.readFile(filePath));
  } catch {
    if (!path.extname(safePath)) {
      try {
        const html = await fs.readFile(path.join(PUBLIC_DIR, 'index.html'));
        response.writeHead(200, { 'Content-Type': MIME_TYPES['.html'], 'Cache-Control': 'no-cache' });
        response.end(html);
      } catch {
        sendError(response, 404, '页面不存在');
      }
      return;
    }
    sendError(response, 404, '文件不存在');
  }
}

export async function createApp(options = {}) {
  const store = await new Store(options.dataFile || DATA_FILE).init();
  const sessions = new Map();

  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: https://images.unsplash.com; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'");

    if (!['GET', 'HEAD', 'POST', 'PUT', 'DELETE'].includes(request.method)) {
      sendError(response, 405, '不支持的请求方法');
      return;
    }

    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    try {
      if (!pathname.startsWith('/api/')) {
        await serveStatic(request, response, pathname);
        return;
      }

      if (pathname === '/api/health' && request.method === 'GET') {
        sendJson(response, 200, { ok: true, service: '星野智家', time: new Date().toISOString() });
        return;
      }

      if (pathname === '/api/config' && request.method === 'GET') {
        sendJson(response, 200, await store.getConfig());
        return;
      }

      if (pathname === '/api/products' && request.method === 'GET') {
        sendJson(response, 200, await store.listProducts(Object.fromEntries(url.searchParams)));
        return;
      }

      const productMatch = pathname.match(/^\/api\/products\/([^/]+)$/);
      if (productMatch && request.method === 'GET') {
        const product = await store.getProduct(decodeURIComponent(productMatch[1]));
        if (!product) {
          sendError(response, 404, '商品不存在');
          return;
        }
        sendJson(response, 200, product);
        return;
      }

      if (pathname === '/api/orders' && request.method === 'POST') {
        if (!sameOrigin(request)) {
          sendError(response, 403, '非法请求来源');
          return;
        }
        const order = await store.createOrder(await readJson(request));
        sendJson(response, 201, order);
        return;
      }

      if (pathname === '/api/orders/track' && request.method === 'GET') {
        const order = await store.trackOrder(url.searchParams.get('orderNo'), url.searchParams.get('phone'));
        sendJson(response, 200, order);
        return;
      }

      if (pathname === '/api/support/chat' && request.method === 'POST') {
        if (!sameOrigin(request)) {
          sendError(response, 403, '非法请求来源');
          return;
        }
        const body = await readJson(request);
        let sessionId = String(body.sessionId || '').trim().slice(0, 100);
        if (!/^[a-zA-Z0-9-]{8,100}$/.test(sessionId)) sessionId = randomBytes(16).toString('hex');
        const message = String(body.message || '').trim().slice(0, 1200);
        if (!message) {
          sendError(response, 400, '请输入咨询内容');
          return;
        }
        await store.getSupportThread(sessionId, true);
        await store.appendSupportMessage(sessionId, { sender: 'user', text: message });
        const [products, config] = await Promise.all([store.listProducts({ pageSize: 48 }), store.getConfig()]);
        const orderMatch = message.toUpperCase().match(/XY\d{12,16}/);
        const order = orderMatch ? await store.findOrderByNumber(orderMatch[0]) : null;
        const reply = generateSupportReply(message, {
          products: products.products,
          settings: config.settings,
          order
        });
        await store.appendSupportMessage(sessionId, { sender: 'bot', text: reply.text, productIds: reply.productIds });
        if (reply.escalate) {
          const threads = await store.listSupportThreads();
          const thread = threads.find((item) => item.sessionId === sessionId);
          if (thread) await store.setSupportStatus(thread.id, 'waiting');
        }
        sendJson(response, 200, { sessionId, ...reply });
        return;
      }

      if (pathname === '/api/admin/session' && request.method === 'GET') {
        const session = getAdminSession(request, sessions);
        sendJson(response, 200, { authenticated: Boolean(session), user: session ? { username: session.username } : null });
        return;
      }

      if (pathname === '/api/admin/login' && request.method === 'POST') {
        if (!sameOrigin(request)) {
          sendError(response, 403, '非法请求来源');
          return;
        }
        const body = await readJson(request);
        const username = String(body.username || '').trim().slice(0, 60);
        const password = String(body.password || '').slice(0, 200);
        const valid = await store.authenticate(username, password);
        if (!valid) {
          await new Promise((resolve) => setTimeout(resolve, 350));
          sendError(response, 401, '用户名或密码错误');
          return;
        }
        const token = randomBytes(32).toString('hex');
        sessions.set(token, { username, expiresAt: Date.now() + SESSION_TTL });
        sendJson(response, 200, { authenticated: true, user: { username } }, { 'Set-Cookie': sessionCookie(token) });
        return;
      }

      if (pathname === '/api/admin/logout' && request.method === 'POST') {
        const token = parseCookies(request).xy_admin;
        if (token) sessions.delete(token);
        sendJson(response, 200, { authenticated: false }, { 'Set-Cookie': sessionCookie('', 0) });
        return;
      }

      const session = getAdminSession(request, sessions);
      if (pathname.startsWith('/api/admin/') && !session) {
        sendError(response, 401, '请先登录后台');
        return;
      }
      if (pathname.startsWith('/api/admin/') && !['GET', 'HEAD'].includes(request.method) && !sameOrigin(request)) {
        sendError(response, 403, '非法请求来源');
        return;
      }

      if (pathname === '/api/admin/dashboard' && request.method === 'GET') {
        sendJson(response, 200, await store.dashboard());
        return;
      }

      if (pathname === '/api/admin/products' && request.method === 'GET') {
        sendJson(response, 200, { products: await store.listAdminProducts() });
        return;
      }

      if (pathname === '/api/admin/products' && request.method === 'POST') {
        sendJson(response, 201, await store.saveProduct(await readJson(request)));
        return;
      }

      const adminProductMatch = pathname.match(/^\/api\/admin\/products\/([^/]+)$/);
      if (adminProductMatch && request.method === 'PUT') {
        const body = await readJson(request);
        body.id = decodeURIComponent(adminProductMatch[1]);
        sendJson(response, 200, await store.saveProduct(body));
        return;
      }

      if (adminProductMatch && request.method === 'DELETE') {
        sendJson(response, 200, await store.deleteProduct(decodeURIComponent(adminProductMatch[1])));
        return;
      }

      if (pathname === '/api/admin/orders' && request.method === 'GET') {
        sendJson(response, 200, { orders: await store.listAdminOrders(Object.fromEntries(url.searchParams)) });
        return;
      }

      const adminOrderMatch = pathname.match(/^\/api\/admin\/orders\/([^/]+)$/);
      if (adminOrderMatch && request.method === 'PUT') {
        const body = await readJson(request);
        sendJson(response, 200, await store.updateOrderStatus(decodeURIComponent(adminOrderMatch[1]), String(body.status || ''), body));
        return;
      }

      if (pathname === '/api/admin/settings' && request.method === 'PUT') {
        sendJson(response, 200, await store.updateSettings(await readJson(request)));
        return;
      }

      if (pathname === '/api/admin/support' && request.method === 'GET') {
        sendJson(response, 200, { threads: await store.listSupportThreads() });
        return;
      }

      const adminReadMatch = pathname.match(/^\/api\/admin\/support\/([^/]+)\/read$/);
      if (adminReadMatch && request.method === 'PUT') {
        sendJson(response, 200, await store.markSupportRead(decodeURIComponent(adminReadMatch[1])));
        return;
      }

      const adminReplyMatch = pathname.match(/^\/api\/admin\/support\/([^/]+)\/reply$/);
      if (adminReplyMatch && request.method === 'POST') {
        const body = await readJson(request);
        const threads = await store.listSupportThreads();
        const thread = threads.find((item) => item.id === decodeURIComponent(adminReplyMatch[1]));
        if (!thread) {
          sendError(response, 404, '客服会话不存在');
          return;
        }
        const message = await store.appendSupportMessage(thread.sessionId, { sender: 'human', text: body.message });
        sendJson(response, 201, message);
        return;
      }

      const adminStatusMatch = pathname.match(/^\/api\/admin\/support\/([^/]+)\/status$/);
      if (adminStatusMatch && request.method === 'PUT') {
        const body = await readJson(request);
        sendJson(response, 200, await store.setSupportStatus(decodeURIComponent(adminStatusMatch[1]), String(body.status || 'open')));
        return;
      }

      sendError(response, 404, '接口不存在');
    } catch (error) {
      const message = error instanceof Error ? error.message : '服务器内部错误';
      const clientError = /不能为空|无效|不存在|不一致|库存|已下架|购物车|优惠券|手机号|地址|抬头|格式错误|过大/.test(message);
      if (!clientError) console.error(error);
      sendError(response, clientError ? 400 : 500, clientError ? message : '服务器内部错误');
    }
  });

  return { server, store, sessions };
}

const isEntry = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isEntry) {
  const { server } = await createApp();
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '0.0.0.0';
  server.listen(port, host, () => {
    console.log(`星野智家已启动：http://localhost:${port}`);
    console.log(`管理后台：http://localhost:${port}/admin.html`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
