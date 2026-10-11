'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 3000);
const MAX_PER_ROOM = Number(process.env.MAX_PER_ROOM || 8);
const PUBLIC_DIR = path.join(__dirname, 'public');
const ROOM_RE = /^[a-z0-9][a-z0-9-]{2,39}$/;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ICE servers sent to browsers. STUN is enough for most networks.
// Set TURN_URLS (comma separated), TURN_USERNAME and TURN_CREDENTIAL to add a relay
// for people behind strict firewalls.
function iceConfig() {
  const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URLS) {
    iceServers.push({
      urls: process.env.TURN_URLS.split(',').map((s) => s.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || '',
    });
  }
  return { iceServers };
}

const server = http.createServer((req, res) => {
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(self), microphone=(self), display-capture=(self)',
  };

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400, headers);
    return res.end('Bad request');
  }

  if (pathname.includes('\0')) {
    res.writeHead(400, headers);
    return res.end('Bad request');
  }

  if (pathname === '/healthz') {
    res.writeHead(200, headers);
    return res.end('ok');
  }
  if (pathname === '/config') {
    res.writeHead(200, { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(iceConfig()));
  }

  if (pathname === '/') pathname = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, headers);
    return res.end('Forbidden');
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, headers);
      return res.end('Not found');
    }
    res.writeHead(200, {
      ...headers,
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

// rooms: code -> Map(id -> ws)
const rooms = new Map();

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg, exceptId) {
  const members = rooms.get(room);
  if (!members) return;
  for (const [id, peer] of members) {
    if (id !== exceptId) send(peer, msg);
  }
}

function cleanName(value) {
  const name = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 30);
  return name || 'Guest';
}

function cleanState(s) {
  return { cam: !!(s && s.cam), mic: !!(s && s.mic), screen: !!(s && s.screen) };
}

function leave(ws) {
  if (!ws.room) return;
  const members = rooms.get(ws.room);
  const room = ws.room;
  ws.room = null;
  if (!members) return;
  members.delete(ws.id);
  if (members.size === 0) {
    rooms.delete(room);
  } else {
    broadcast(room, { type: 'peer-left', id: ws.id });
  }
}

wss.on('connection', (ws) => {
  ws.id = crypto.randomBytes(6).toString('hex');
  ws.room = null;
  ws.name = 'Guest';
  ws.state = cleanState();
  ws.isAlive = true;
  ws.chatTokens = 5;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'join') {
      if (ws.room) return;
      const code = String(msg.room || '').toLowerCase();
      if (!ROOM_RE.test(code)) {
        return send(ws, { type: 'error', reason: 'bad-code', message: 'Room codes use letters, numbers and dashes, 3 to 40 characters.' });
      }
      let members = rooms.get(code);
      if (members && members.size >= MAX_PER_ROOM) {
        return send(ws, { type: 'error', reason: 'full', message: `This room is full (${MAX_PER_ROOM} people).` });
      }
      if (!members) {
        members = new Map();
        rooms.set(code, members);
      }
      ws.name = cleanName(msg.name);
      ws.room = code;
      const peers = [...members.values()].map((p) => ({ id: p.id, name: p.name, state: p.state }));
      members.set(ws.id, ws);
      send(ws, { type: 'joined', id: ws.id, peers });
      broadcast(code, { type: 'peer-joined', peer: { id: ws.id, name: ws.name, state: ws.state } }, ws.id);
      return;
    }

    if (!ws.room) return;
    const members = rooms.get(ws.room);
    if (!members) return;

    switch (msg.type) {
      case 'signal': {
        const target = members.get(String(msg.to));
        if (target && msg.data && typeof msg.data === 'object') {
          send(target, { type: 'signal', from: ws.id, data: msg.data });
        }
        break;
      }
      case 'state': {
        ws.state = cleanState(msg.state);
        broadcast(ws.room, { type: 'state', id: ws.id, state: ws.state }, ws.id);
        break;
      }
      case 'chat': {
        const text = String(msg.text || '').trim().slice(0, 2000);
        if (!text || ws.chatTokens <= 0) break;
        ws.chatTokens -= 1;
        broadcast(ws.room, { type: 'chat', from: ws.id, name: ws.name, text, ts: Date.now() });
        break;
      }
      default:
        break;
    }
  });

  ws.on('close', () => leave(ws));
  ws.on('error', () => leave(ws));
});

// Chat rate limit: refill one message per second, up to 5.
setInterval(() => {
  for (const members of rooms.values()) {
    for (const ws of members.values()) ws.chatTokens = Math.min(5, ws.chatTokens + 1);
  }
}, 1000).unref();

// Drop connections that stopped answering pings.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
heartbeat.unref();

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Codecall running on http://localhost:${PORT}`);
  });
}

module.exports = { server, wss, rooms };
