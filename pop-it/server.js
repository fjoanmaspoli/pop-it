'use strict';
const crypto = require('crypto');
const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const PRIZE = process.env.PRIZE || 'a $50 Amazon gift card';
const MIN_TARGET = 5_000, MAX_TARGET = 20_000;   // plage du nombre secret
const TAP_COOLDOWN_MS = 950;                     // 1 tap/s (50 ms de tolérance réseau)
const CHAT_COOLDOWN_MS = 2_000;
const NEXT_ROUND_DELAY_MS = 25_000;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hourKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 13);
const dayKey  = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

/* ---------- état ---------- */
let round = null;                 // { id, target, salt, commit, taps, startedAt, popped }
let recentTaps = [];              // timestamps → taps/sec global
const players = new Map();        // pid -> { id,name,flag,tapsRound,lastTapAt,lastChatAt,ws:Set }
const chatLog = [];

let tapsAllTime   = db.prepare('SELECT COALESCE(SUM(taps),0) t FROM rounds').get().t;
let poppedAllTime = db.prepare('SELECT COUNT(*) c FROM rounds WHERE ended_at IS NOT NULL').get().c;

function newRound() {
  const target = MIN_TARGET + crypto.randomInt(MAX_TARGET - MIN_TARGET + 1);
  const salt = crypto.randomBytes(16).toString('hex');
  const startedAt = Date.now();
  const { lastInsertRowid: id } = db.prepare(
    `INSERT INTO rounds (target, salt, commit_hash, taps, started_at, prize)
     VALUES (?,?,'',0,?,?)`).run(target, salt, startedAt, PRIZE);
  const commit = sha256(`${id}:${target}:${salt}`);
  db.prepare('UPDATE rounds SET commit_hash=? WHERE id=?').run(commit, id);
  round = { id, target, salt, commit, taps: 0, startedAt, popped: false };
  for (const p of players.values()) p.tapsRound = 0;
  broadcast({ t: 'round', id, commit, prize: PRIZE, range: [MIN_TARGET, MAX_TARGET] });
  console.log(`🎈 round #${id} — commit ${commit.slice(0, 12)}…`);
}

/* ---------- helpers ---------- */
const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
function broadcast(o) {
  const m = JSON.stringify(o);
  for (const p of players.values()) for (const ws of p.ws) if (ws.readyState === 1) ws.send(m);
}
function presence() {
  const now = Date.now(); let here = 0, tapping = 0;
  for (const p of players.values()) {
    if ([...p.ws].some(w => w.readyState === 1)) {
      here++;
      if (now - p.lastTapAt < 10_000) tapping++;
    }
  }
  return { here, tapping };
}
const board = () => [...players.values()]
  .filter(p => p.tapsRound > 0)
  .sort((a, b) => b.tapsRound - a.tapsRound)
  .slice(0, 10)
  .map(p => ({ name: p.name, flag: p.flag, taps: p.tapsRound }));

const bumpUniq = (pid, kind) => {
  const q = db.prepare('INSERT OR IGNORE INTO uniq (bucket,pid,kind) VALUES (?,?,?)');
  q.run(`h:${hourKey()}`, pid, kind); q.run(`d:${dayKey()}`, pid, kind);
};

/* ---------- TAP : 1 tap = 1, max 1/s, serveur autoritaire ---------- */
function handleTap(p, ws) {
  if (round.popped) return;
  const now = Date.now();
  const since = now - p.lastTapAt;
  if (since < TAP_COOLDOWN_MS)
    return send(ws, { t: 'rejected', retryIn: TAP_COOLDOWN_MS - since });

  p.lastTapAt = now;
  p.tapsRound++;
  round.taps++;
  tapsAllTime++;
  recentTaps.push(now);
  bumpUniq(p.id, 'player');
  db.prepare(`INSERT INTO taps_hourly (hour,taps) VALUES (?,1)
              ON CONFLICT(hour) DO UPDATE SET taps=taps+1`).run(hourKey());
  db.prepare(`INSERT INTO players (id,name,flag,taps_all,first_seen,last_seen)
              VALUES (?,?,?,1,?,?)
              ON CONFLICT(id) DO UPDATE SET taps_all=taps_all+1, last_seen=excluded.last_seen`)
    .run(p.id, p.name, p.flag, now, now);

  if (round.taps >= round.target) pop(p);
}

function pop(winner) {
  round.popped = true;
  const endedAt = Date.now();
  db.prepare('UPDATE rounds SET taps=?, winner=?, ended_at=? WHERE id=?')
    .run(round.taps, winner.name, endedAt, round.id);
  db.prepare('UPDATE players SET wins=wins+1 WHERE id=?').run(winner.id);
  poppedAllTime++;
  broadcast({
    t: 'popped', round: round.id, taps: round.taps,
    winner: winner.name, flag: winner.flag, prize: PRIZE,
    durationMs: endedAt - round.startedAt,
    reveal: { target: round.target, salt: round.salt, commit: round.commit }, // preuve
  });
  setTimeout(newRound, NEXT_ROUND_DELAY_MS);
}

/* ---------- WebSocket ---------- */
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'ident') return ident(ws, m);
    if (!ws.player) return;
    if (m.t === 'tap') return handleTap(ws.player, ws);
    if (m.t === 'chat') return handleChat(ws.player, m);
  });
  ws.on('close', () => {
    const p = ws.player;
    if (p) { p.ws.delete(ws); if (!p.ws.size) players.delete(p.id); }
  });
});

function ident(ws, m) {
  const id = String(m.id || '').slice(0, 64); if (!id) return;
  const name = String(m.name || 'anon').replace(/[<>]/g, '').slice(0, 20);
  const flag = String(m.flag || '🏳️').slice(0, 8);
  let p = players.get(id);
  if (!p) { p = { id, name, flag, tapsRound: 0, lastTapAt: 0, lastChatAt: 0, ws: new Set() }; players.set(id, p); }
  else { p.name = name; p.flag = flag; }
  p.ws.add(ws); ws.player = p;
  bumpUniq(id, 'visitor');
  send(ws, {
    t: 'init',
    you: { name, flag, tapsRound: p.tapsRound },
    round: { id: round.id, taps: round.taps, commit: round.commit, prize: PRIZE,
             range: [MIN_TARGET, MAX_TARGET], startedAt: round.startedAt },
    tapsAllTime, poppedAllTime, chat: chatLog.slice(-50), board: board(),
  });
}

function handleChat(p, m) {
  const now = Date.now();
  if (now - p.lastChatAt < CHAT_COOLDOWN_MS) return;
  p.lastChatAt = now;
  const text = String(m.text || '').trim().slice(0, 240); if (!text) return;
  const msg = { t: 'chat', name: p.name, flag: p.flag, text, at: now };
  chatLog.push(msg); if (chatLog.length > 50) chatLog.shift();
  broadcast(msg);
}

/* ---------- boucles temps réel ---------- */
setInterval(() => {
  const cut = Date.now() - 1000;
  while (recentTaps.length && recentTaps[0] < cut) recentTaps.shift();
  broadcast({ t: 'count', n: round.taps, cps: recentTaps.length, all: tapsAllTime });
}, 300);
setInterval(() => broadcast({ t: 'board', rows: board(), ...presence() }), 2_000);
setInterval(() => db.prepare('UPDATE rounds SET taps=? WHERE id=?').run(round.taps, round.id), 5_000);

/* ---------- API reporting (page /stats) ---------- */
app.get('/api/stats', (req, res) => {
  const now = Date.now();
  const hours = [...Array(24)].map((_, i) => hourKey(now - (23 - i) * 3600e3));
  const days  = [...Array(7)].map((_, i) => dayKey(now - (6 - i) * 86400e3));

  const tapsHour = Object.fromEntries(
    db.prepare('SELECT hour,taps FROM taps_hourly WHERE hour>=?').all(hours[0]).map(r => [r.hour, r.taps]));
  const umap = {};
  for (const r of db.prepare(`SELECT bucket,kind,COUNT(*) c FROM uniq WHERE bucket>='d:' GROUP BY bucket,kind`).all())
    umap[r.bucket + '|' + r.kind] = r.c;

  const perHour = hours.map(h => ({ label: h, taps: tapsHour[h] || 0,
    visitors: umap[`h:${h}|visitor`] || 0, players: umap[`h:${h}|player`] || 0 }));
  const perDay = days.map(d => ({ label: d,
    taps: Object.entries(tapsHour).filter(([h]) => h.startsWith(d)).reduce((a, [, v]) => a + v, 0),
    visitors: umap[`d:${d}|visitor`] || 0, players: umap[`d:${d}|player`] || 0 }));

  const distinct = (kind, like, gte) => db.prepare(
    `SELECT COUNT(DISTINCT pid) c FROM uniq WHERE kind=? AND bucket LIKE ? AND bucket>=?`)
    .get(kind, like, gte).c;

  res.json({
    now: { ...presence(), cps: recentTaps.length, roundTaps: round.taps, roundId: round.id },
    allTime: { taps: tapsAllTime, popped: poppedAllTime,
      visitors7d: distinct('visitor', 'd:%', 'd:' + days[0]),
      players7d:  distinct('player',  'd:%', 'd:' + days[0]) },
    h24: { taps: perHour.reduce((a, r) => a + r.taps, 0),
      visitors: distinct('visitor', 'h:%', 'h:' + hours[0]),
      players:  distinct('player',  'h:%', 'h:' + hours[0]), perHour },
    d7: { taps: perDay.reduce((a, r) => a + r.taps, 0),
      visitors: distinct('visitor', 'd:%', 'd:' + days[0]),
      players:  distinct('player',  'd:%', 'd:' + days[0]), perDay },
    rounds: db.prepare(`SELECT id,taps,winner,prize,started_at,ended_at,target,salt,commit_hash
                        FROM rounds WHERE ended_at IS NOT NULL ORDER BY id DESC LIMIT 10`).all(),
  });
});

/* ---------- widget embarquable ---------- */
app.get('/embed', (req, res) => res.send(`<!doctype html><meta name="viewport" content="width=device-width">
<body style="margin:0;background:#0b0b0d;color:#ffd23f;font:800 20px system-ui;display:grid;place-items:center;height:100vh">
<div>🎈 <span id="n">…</span> taps</div>
<script>const ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host);
ws.onopen=()=>ws.send(JSON.stringify({t:'ident',id:'embed-'+Math.random(),name:'embed',flag:''}));
ws.onmessage=e=>{const m=JSON.parse(e.data);
if(m.t==='init')n.textContent=m.round.taps.toLocaleString();
if(m.t==='count')n.textContent=m.n.toLocaleString()};<\/script></body>`));

newRound();
server.listen(PORT, () => console.log(`🎈 POP! → http://localhost:${PORT} · stats → /stats`));