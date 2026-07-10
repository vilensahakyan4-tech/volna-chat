const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const clients = new Map();
let waiting = [];
const ACTIVE_WINDOW_MS = 12000;
let cachedIceConfig = null;
let cachedIceConfigAt = 0;

function isActive(id) {
  const client = clients.get(id);
  return Boolean(client && Date.now() - client.touched < ACTIVE_WINDOW_MS);
}

function cleanWaiting() {
  waiting = waiting.filter((id, index, list) => list.indexOf(id) === index && isActive(id));
}

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
  cleanWaiting();
  if (client.peer || waiting.includes(id)) return;
  const partnerId = waiting.find(other => other !== id && isActive(other));
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

async function getIceConfig() {
  const fallback = {
    iceTransportPolicy: 'all',
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' }
    ]
  };

  if (cachedIceConfig && Date.now() - cachedIceConfigAt < 5 * 60 * 1000) return cachedIceConfig;

  const meteredUrl = process.env.METERED_TURN_API_URL || (
    process.env.METERED_APP_NAME && process.env.METERED_API_KEY
      ? `https://${process.env.METERED_APP_NAME}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(process.env.METERED_API_KEY)}`
      : ''
  );

  if (meteredUrl) {
    try {
      const response = await fetch(meteredUrl);
      if (response.ok) {
        const iceServers = await response.json();
        if (Array.isArray(iceServers) && iceServers.length) {
          cachedIceConfig = {
            iceTransportPolicy: process.env.TURN_FORCE_RELAY === 'true' ? 'relay' : 'all',
            iceServers
          };
          cachedIceConfigAt = Date.now();
          return cachedIceConfig;
        }
      }
    } catch (error) {}
  }

  const turnUrls = (process.env.TURN_URLS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const hasTurnCredentials = turnUrls.length && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL;

  if (hasTurnCredentials) {
    fallback.iceTransportPolicy = process.env.TURN_FORCE_RELAY === 'true' ? 'relay' : 'all';
    fallback.iceServers.push({
      urls: turnUrls,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL
    });
    return fallback;
  }

  const staticTurnSecret = process.env.STATIC_TURN_SECRET || 'openrelayprojectsecret';
  const staticTurnHost = process.env.STATIC_TURN_HOST || 'staticauth.openrelay.metered.ca';
  const username = String(Math.floor(Date.now() / 1000) + 6 * 60 * 60);
  const credential = crypto.createHmac('sha1', staticTurnSecret).update(username).digest('base64');

  return {
    iceTransportPolicy: 'relay',
    iceServers: [
      { urls: `stun:${staticTurnHost}:80` },
      {
        urls: [
          `turn:${staticTurnHost}:80`,
          `turn:${staticTurnHost}:80?transport=tcp`,
          `turn:${staticTurnHost}:443`,
          `turn:${staticTurnHost}:443?transport=tcp`,
          `turns:${staticTurnHost}:443?transport=tcp`
        ],
        username,
        credential
      }
    ]
  };
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
    if (url.pathname === '/api/ice-config' && req.method === 'GET') {
      return json(res, 200, await getIceConfig());
    }
    if (url.pathname === '/api/join' && req.method === 'POST') {
      const { id } = await readBody(req); if (!id) return json(res, 400, { error: 'id required' });
      enqueue(id); return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/events' && req.method === 'GET') {
      const id = url.searchParams.get('id'); if (!id) return json(res, 400, { error: 'id required' });
      const client = getClient(id);
      if (!client.peer && !waiting.includes(id)) enqueue(id);
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
  cleanWaiting();
}, 30000).unref();

server.listen(PORT, '0.0.0.0', () => console.log(`VOLNA запущена: http://localhost:${PORT}`));
