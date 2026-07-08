const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const clients = new Map();
let waiting = [];

function getClient(id) {
  if (!clients.has(id)) clients.set(id, { id, peer: null, events: [], touched: Date.now() });
  const client = clients.get(id);
  client.touched = Date.now();
  return client;
}

function push(client, type, payload = {}) {
  client.events.push({ seq: crypto.randomUUID(), type, ...payload });
  if (client.events.length > 100) client.events.shift();
}

function disconnect(id, requeue = false) {
  const client = clients.get(id);
  if (!client) return;
  waiting = waiting.filter(x => x !== id);
  if (client.peer) {
    const peer = clients.get(client.peer);
    if (peer) { peer.peer = null; push(peer, 'peer-left'); }
    client.peer = null;
  }
  client.events = [];
  if (requeue) enqueue(id);
}

function enqueue(id) {
  const client = getClient(id);
  if (client.peer || waiting.includes(id)) return;
  const partnerId = waiting.find(other => other !== id && clients.has(other));
  if (!partnerId) {
    waiting.push(id);
    push(client, 'searching');
    return;
  }
  waiting = waiting.filter(x => x !== partnerId);
  const partner = getClient(partnerId);
  client.peer = partnerId;
  partner.peer = id;
  push(partner, 'matched', { peerId: id, initiator: true });
  push(client, 'matched', { peerId: partnerId, initiator: false });
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
  });
}

const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/health' && req.method === 'GET') {
      return json(res, 200, { status: 'ok' });
    }
    if (url.pathname === '/api/join' && req.method === 'POST') {
      const { id } = await readBody(req); if (!id) return json(res, 400, { error: 'id required' });
      enqueue(id); return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/events' && req.method === 'GET') {
      const id = url.searchParams.get('id'); const client = getClient(id);
      const events = client.events.splice(0); return json(res, 200, { events });
    }
    if (url.pathname === '/api/signal' && req.method === 'POST') {
      const { from, to, signal } = await readBody(req); const target = clients.get(to);
      if (target && target.peer === from) push(target, 'signal', { from, signal });
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/next' && req.method === 'POST') {
      const { id } = await readBody(req); disconnect(id, true); return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/leave' && req.method === 'POST') {
      const { id } = await readBody(req); disconnect(id, false); clients.delete(id); return json(res, 200, { ok: true });
    }
    let filePath = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!filePath.startsWith(PUBLIC) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath = path.join(PUBLIC, 'index.html');
    res.writeHead(200, { 'Content-Type': mime[path.extname(filePath)] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  } catch (error) { json(res, 500, { error: 'server error' }); }
});

setInterval(() => {
  const stale = Date.now() - 120000;
  for (const [id, client] of clients) if (client.touched < stale) { disconnect(id); clients.delete(id); }
}, 30000).unref();

server.listen(PORT, '0.0.0.0', () => console.log(`VOLNA запущена: http://localhost:${PORT}`));
