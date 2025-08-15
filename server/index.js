// server/index.js (CommonJS)
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

// === Constantes de juego / tiempo ===
const PLAN_MS = 40000;          // tiempo para trazar planes
const RESOLVE_MS = 5000;        // tiempo de simulación por turno
const TICK_MS = 20;             // paso fijo de simulación (50 Hz)
const BROADCAST_MS = 50;        // cada cuánto se emite estado en RESOLVE (20 Hz)

const FIELD_W = 100;            // unidades de campo (ancho)
const FIELD_H = 60;             // unidades de campo (alto)

const GOAL_W = 14;      // ancho del arco (boca), en unidades de campo
const GOAL_DEPTH = 1.8; // profundidad del arco hacia afuera del campo


const PLAYER_R = 1.2;
const BALL_R = 0.6;

const PLAYER_SPEED = 18;        // u/s
const KICK_MAX_SPEED = 35;      // u/s
const KICK_MIN_SPEED = 10;      // u/s
const BALL_DAMP_PER_SEC = 0.50; // factor multiplicativo por segundo
const WALL_BOUNCE = 0.8;

// === Servidor HTTP + socket.io ===
const app = express();
app.use(express.static('public'));
const server = http.createServer(app);
const io = new Server(server, {
  // Para producción: cambia origin a tu dominio
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 1e5 // ~100 KB por mensaje
});

// === Utilidades ===
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const norm = (x, y) => { const L = Math.hypot(x, y) || 1; return { x: x / L, y: y / L, L }; };
const decayFactor = (perSec, dt) => Math.pow(perSec, dt);

function makeRateLimiter({ limit, intervalMs }) {
  const hits = new Map(); // socket.id -> {count, ts}
  return (socket) => {
    const now = Date.now();
    const rec = hits.get(socket.id) || { count: 0, ts: now };
    if (now - rec.ts > intervalMs) { rec.count = 0; rec.ts = now; }
    rec.count += 1;
    hits.set(socket.id, rec);
    return rec.count <= limit;
  };
}
const rlSetPlan = makeRateLimiter({ limit: 4, intervalMs: 1000 }); // 4/s
const rlJoin = makeRateLimiter({ limit: 2, intervalMs: 5000 }); // 2/5s

function validRoomId(s) { return typeof s === 'string' && /^[a-zA-Z0-9_-]{1,24}$/.test(s); }
function validName(s) { return typeof s === 'string' && /^[\p{L}\p{N}\s._-]{1,16}$/u.test((s || '').trim()); }

// === Estado inicial ===
function createInitialPlayers() {
  const home = [
    { pid: 'H0', team: 'home', role: 'GK', x: 8, y: FIELD_H / 2 },
    { pid: 'H1', team: 'home', role: 'DEF', x: 20, y: FIELD_H / 3 },
    { pid: 'H2', team: 'home', role: 'DEF', x: 20, y: FIELD_H * 2 / 3 },
    { pid: 'H3', team: 'home', role: 'ATK', x: 38, y: FIELD_H / 3 },
    { pid: 'H4', team: 'home', role: 'ATK', x: 38, y: FIELD_H * 2 / 3 },
  ];
  const away = [
    { pid: 'A0', team: 'away', role: 'GK', x: FIELD_W - 8, y: FIELD_H / 2 },
    { pid: 'A1', team: 'away', role: 'DEF', x: FIELD_W - 20, y: FIELD_H / 3 },
    { pid: 'A2', team: 'away', role: 'DEF', x: FIELD_W - 20, y: FIELD_H * 2 / 3 },
    { pid: 'A3', team: 'away', role: 'ATK', x: FIELD_W - 38, y: FIELD_H / 3 },
    { pid: 'A4', team: 'away', role: 'ATK', x: FIELD_W - 38, y: FIELD_H * 2 / 3 },
  ];
  const players = {};
  [...home, ...away].forEach(p => { players[p.pid] = { ...p, r: PLAYER_R, alive: true }; });
  return players;
}

function createRoom(id) {
  const now = Date.now();
  return {
    id,
    phase: 'PLAN',
    phaseEndsAt: now + PLAN_MS,
    tick: 0,
    lastBroadcastAt: 0,
    field: { w: FIELD_W, h: FIELD_H, goals: { width: GOAL_W, depth: GOAL_DEPTH } },
    ball: { x: FIELD_W / 2, y: FIELD_H / 2, vx: 0, vy: 0, r: BALL_R },
    players: createInitialPlayers(),
    controllers: { home: null, away: null },
    plans: { home: {}, away: {} },
    planReady: { home: false, away: false },
    resolveCtx: null,
  };
}

const ROOMS = new Map();
function ensureRoom(roomId) {
  if (!ROOMS.has(roomId)) ROOMS.set(roomId, createRoom(roomId));
  return ROOMS.get(roomId);
}
function isRoomEmpty(room) {
  const sids = io.sockets.adapter.rooms.get(room.id);
  return !sids || sids.size === 0;
}
function maybeCleanupRoom(room) {
  if (isRoomEmpty(room)) ROOMS.delete(room.id);
}

// === Sanitización de planes ===
const MAX_PLAYERS_PER_PLAN = 5;   // 5 jugadores por equipo
const MAX_POINTS_PER_PATH = 120; // puntos por path

function sanitizePlans(room, team, plans) {
  if (!plans || typeof plans !== 'object') return {};
  const entries = Object.entries(plans).slice(0, MAX_PLAYERS_PER_PLAN);
  const out = {};
  for (const [pid, plan] of entries) {
    const p = room.players[pid];
    if (!p || p.team !== team) continue;
    const path = Array.isArray(plan.path) ? plan.path.slice(0, MAX_POINTS_PER_PATH) : [];
    const sp = path.map(pt => ({
      x: clamp(Number(pt.x), 0, room.field.w),
      y: clamp(Number(pt.y), 0, room.field.h),
    }));
    let kick = null;
    if (plan.kick && Number.isFinite(plan.kick.dx) && Number.isFinite(plan.kick.dy)) {
      const power = clamp(Number(plan.kick.power ?? 1), 0, 1);
      kick = { dx: plan.kick.dx, dy: plan.kick.dy, power };
    }
    out[pid] = { path: sp, kick };
  }
  return out;
}

// === Conexión de sockets ===
io.on('connection', (socket) => {
  socket.data = { team: 'spectator', roomId: null, name: null };

  socket.on('join_room', (payload) => {
    if (!rlJoin(socket)) return;
    const roomId = payload?.roomId;
    const name = payload?.name;

    if (!validRoomId(roomId)) return socket.emit('join_ack', { error: 'roomId invalido' });
    const safeName = validName(name) ? name.trim() : 'Player';

    const room = ensureRoom(roomId);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.name = safeName;

    if (!room.controllers.home) {
      room.controllers.home = socket.id;
      socket.data.team = 'home';
    } else if (!room.controllers.away) {
      room.controllers.away = socket.id;
      socket.data.team = 'away';
    } else {
      socket.data.team = 'spectator';
    }

    socket.emit('join_ack', { team: socket.data.team, field: room.field });
    broadcastRoom(room);
  });

  socket.on('set_plan', ({ plans }) => {
    if (!rlSetPlan(socket)) return socket.emit('plan_ack', { ok: false, error: 'rate' });
    const room = socket.data.roomId && ROOMS.get(socket.data.roomId);
    if (!room || room.phase !== 'PLAN') return;

    const team = socket.data.team;
    if (team !== 'home' && team !== 'away') return;
    const isController = room.controllers[team] === socket.id;
    if (!isController) return;

    const sanitized = sanitizePlans(room, team, plans);
    room.plans[team] = sanitized;
    room.planReady[team] = true;

    socket.emit('plan_ack', { ok: true, count: Object.keys(sanitized).length });

    // Resolución anticipada si ambos están listos
    if (room.planReady.home && room.planReady.away) {
      const now = Date.now();
      if (room.phase === 'PLAN' && now < room.phaseEndsAt) {
        advanceToResolve(room, now);
      }
    } else {
      // Avisar del estado de "plan listo" para UI
      broadcastRoom(room);
    }
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = ROOMS.get(roomId);
    if (!room) return;

    if (room.controllers.home === socket.id) {
      room.controllers.home = null;
      room.planReady.home = false;
    }
    if (room.controllers.away === socket.id) {
      room.controllers.away = null;
      room.planReady.away = false;
    }
    broadcastRoom(room);
    maybeCleanupRoom(room);
  });
});

// === Broadcast ===
function broadcastRoom(room) {
  io.to(room.id).emit('room_state', {
    phase: room.phase,
    phaseEndsAt: room.phaseEndsAt,
    tick: room.tick,
    field: room.field,
    ball: room.ball,
    players: room.players,
    controllers: room.controllers,
    planReady: room.planReady
  });
}

// === Simulación ===
function startResolve(room) {
  const moveCtx = {};
  const allPlans = { ...room.plans.home, ...room.plans.away };
  for (const pid of Object.keys(room.players)) {
    const pl = allPlans[pid];
    moveCtx[pid] = { path: pl?.path || [], idx: 0 };
  }
  room.resolveCtx = { moveCtx, kickUsed: new Set() };
}

function stepRoom(room, dt) {
  const { players, field, ball } = room;
  const { moveCtx, kickUsed } = room.resolveCtx || {};
  if (!moveCtx) return;

  // Mover jugadores por waypoints
  for (const [pid, p] of Object.entries(players)) {
    const ctx = moveCtx[pid];
    if (!ctx || !ctx.path.length) continue;
    let remain = PLAYER_SPEED * dt;
    while (remain > 0 && ctx.idx < ctx.path.length) {
      const tgt = ctx.path[ctx.idx];
      const dx = tgt.x - p.x, dy = tgt.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d < 1e-3) { ctx.idx++; continue; }
      if (d <= remain) { p.x = tgt.x; p.y = tgt.y; ctx.idx++; remain -= d; }
      else { const u = norm(dx, dy); p.x += u.x * remain; p.y += u.y * remain; remain = 0; }
      p.x = clamp(p.x, 0, field.w); p.y = clamp(p.y, 0, field.h);
    }
  }

  // Patada si jugador toca la pelota y tiene kick planificado
  const plans = { ...room.plans.home, ...room.plans.away };
  for (const p of Object.values(players)) {
    const dx = ball.x - p.x, dy = ball.y - p.y;
    const dist = Math.hypot(dx, dy);
    const sumR = p.r + ball.r;
    if (dist <= sumR) {
      const myPlan = plans[p.pid];
      const canKick = myPlan?.kick && !kickUsed.has(p.pid);
      if (canKick) {
        const { dx: kx, dy: ky, power } = myPlan.kick;
        const v = norm(kx, ky);
        const speed = KICK_MIN_SPEED + (KICK_MAX_SPEED - KICK_MIN_SPEED) * clamp(power, 0, 1);
        ball.vx = v.x * speed; ball.vy = v.y * speed;
        // Empujar la pelota fuera de la interpenetración
        const push = norm(dx, dy);
        ball.x = p.x + push.x * (sumR + 0.01);
        ball.y = p.y + push.y * (sumR + 0.01);
        kickUsed.add(p.pid);
      }
    }
  }



  // Mover pelota + fricción
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;

  const f = decayFactor(BALL_DAMP_PER_SEC, dt);
  ball.vx *= f;
  ball.vy *= f;

  // Rebotes con bordes y arcos
  const goalTop = (field.h - GOAL_W) / 2;
  const goalBot = (field.h + GOAL_W) / 2;
  const inLeftMouth = (ball.y >= goalTop && ball.y <= goalBot) && (ball.x <= 0 + ball.r);
  const inRightMouth = (ball.y >= goalTop && ball.y <= goalBot) && (ball.x >= field.w - ball.r);

  // 1) Ejes Y: siempre paredes superior/inferior del rectángulo del campo
  if (ball.y < ball.r) { ball.y = ball.r; ball.vy = -ball.vy * WALL_BOUNCE; }
  if (ball.y > field.h - ball.r) { ball.y = field.h - ball.r; ball.vy = -ball.vy * WALL_BOUNCE; }

  // 2) Eje X: si NO está en la boca del arco, rebotar en línea de fondo
  if (!inLeftMouth && ball.x < ball.r) {
    ball.x = ball.r;
    ball.vx = -ball.vx * WALL_BOUNCE;
  }
  if (!inRightMouth && ball.x > field.w - ball.r) {
    ball.x = field.w - ball.r;
    ball.vx = -ball.vx * WALL_BOUNCE;
  }

  // 3) Si está en la boca, permitir entrar hasta el fondo de la red y rebotar ahí
  if (inLeftMouth) {
    const netX = -GOAL_DEPTH; // plano de la red del arco izquierdo
    if (ball.x < netX + ball.r) {
      ball.x = netX + ball.r;
      ball.vx = -ball.vx * WALL_BOUNCE;
    }
    // postes (arriba/abajo de la boca): rebotar contra los postes "virtuales"
    const postTopY = goalTop;
    const postBotY = goalBot;
    // limitar para que no se "escape" por arriba/abajo dentro del arco
    if (ball.y < postTopY + ball.r) { ball.y = postTopY + ball.r; ball.vy = -ball.vy * WALL_BOUNCE; }
    if (ball.y > postBotY - ball.r) { ball.y = postBotY - ball.r; ball.vy = -ball.vy * WALL_BOUNCE; }
  }

  if (inRightMouth) {
    const netX = field.w + GOAL_DEPTH; // plano de la red del arco derecho
    if (ball.x > netX - ball.r) {
      ball.x = netX - ball.r;
      ball.vx = -ball.vx * WALL_BOUNCE;
    }
    const postTopY = goalTop;
    const postBotY = goalBot;
    if (ball.y < postTopY + ball.r) { ball.y = postTopY + ball.r; ball.vy = -ball.vy * WALL_BOUNCE; }
    if (ball.y > postBotY - ball.r) { ball.y = postBotY - ball.r; ball.vy = -ball.vy * WALL_BOUNCE; }
  }

}

// === Transiciones de fase ===
function advanceToResolve(room, now) {
  if (room.phase !== 'PLAN') return;
  startResolve(room);
  room.phase = 'RESOLVE';
  room.phaseEndsAt = now + RESOLVE_MS;
  io.to(room.id).emit('phase_change', { phase: room.phase, phaseEndsAt: room.phaseEndsAt });
  broadcastRoom(room);
}

/** Bucle principal */
setInterval(() => {
  const now = Date.now();
  for (const room of ROOMS.values()) {
    // Cambio por tiempo
    if (now >= room.phaseEndsAt) {
      if (room.phase === 'PLAN') {
        advanceToResolve(room, now);
      } else {
        // Volver a PLAN
        room.phase = 'PLAN';
        room.phaseEndsAt = now + PLAN_MS;
        room.tick += 1;
        room.plans = { home: {}, away: {} };
        room.planReady = { home: false, away: false };
        room.resolveCtx = null;
        io.to(room.id).emit('phase_change', { phase: room.phase, phaseEndsAt: room.phaseEndsAt });
        broadcastRoom(room);
      }
    }

    // Simulación y broadcast durante RESOLVE
    if (room.phase === 'RESOLVE' && room.resolveCtx) {
      stepRoom(room, TICK_MS / 1000);
      if (now - room.lastBroadcastAt >= BROADCAST_MS) {
        broadcastRoom(room);
        room.lastBroadcastAt = now;
      }
    }
  }
}, TICK_MS);

// === Arranque ===
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server on :${PORT}`));
