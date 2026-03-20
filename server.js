const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const rooms = new Map();

// ─── game data ────────────────────────────────────────────────────────────────

const SPECTRUMS = [
  { left: 'Cold',        right: 'Hot'        },
  { left: 'Quiet',       right: 'Loud'       },
  { left: 'Dark',        right: 'Bright'     },
  { left: 'Ugly',        right: 'Beautiful'  },
  { left: 'Bad',         right: 'Good'       },
  { left: 'Small',       right: 'Large'      },
  { left: 'Simple',      right: 'Complex'    },
  { left: 'Slow',        right: 'Fast'       },
  { left: 'Old',         right: 'Young'      },
  { left: 'Cheap',       right: 'Expensive'  },
  { left: 'Sad',         right: 'Happy'      },
  { left: 'Weak',        right: 'Strong'     },
  { left: 'Rare',        right: 'Common'     },
  { left: 'Natural',     right: 'Artificial' },
  { left: 'Boring',      right: 'Exciting'   },
  { left: 'Healthy',     right: 'Unhealthy'  },
  { left: 'Serious',     right: 'Funny'      },
  { left: 'Soft',        right: 'Hard'       },
  { left: 'Safe',        right: 'Dangerous'  },
  { left: 'Formal',      right: 'Casual'     },
  { left: 'Underrated',  right: 'Overrated'  },
  { left: 'Innocent',    right: 'Guilty'     },
  { left: 'Urban',       right: 'Rural'      },
  { left: 'Generous',    right: 'Selfish'    },
  { left: 'Realistic',   right: 'Idealistic' },
  { left: 'Traditional', right: 'Modern'     },
  { left: 'Smooth',      right: 'Rough'      },
  { left: 'Abstract',    right: 'Concrete'   },
  { left: 'Subtle',      right: 'Obvious'    },
  { left: 'Humble',      right: 'Arrogant'   },
];

const COLORS = ['#FF6B6B','#4ECDC4','#FFD93D','#7B61FF','#FF8C42','#A8E6CF','#F78FB3','#63CDDA'];

// ─── helpers ──────────────────────────────────────────────────────────────────

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({length: 4}, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
  while (rooms.has(code));
  return code;
}

function genId() { return Math.random().toString(36).slice(2, 11); }

function scoreFor(pos, target) {
  const d = Math.abs(pos - target);
  if (d <= 0.04) return 4;
  if (d <= 0.09) return 3;
  if (d <= 0.14) return 2;
  return 0;
}

function pickSpectrum(used) {
  let pool = SPECTRUMS.map((_,i) => i).filter(i => !used.includes(i));
  if (!pool.length) pool = SPECTRUMS.map((_,i) => i);
  return pool[Math.floor(Math.random() * pool.length)];
}

// ─── state view ───────────────────────────────────────────────────────────────

function viewFor(room, pid) {
  const cgPlayer = room.players[room.clueGiverIdx];
  const isClueGiver = cgPlayer?.id === pid;
  const inReveal = ['reveal', 'game_over'].includes(room.phase);

  // Target is visible to the clue giver during their active phases, and everyone on reveal
  const showTarget = (isClueGiver && ['clue_entry', 'guessing'].includes(room.phase)) || inReveal;

  const view = {
    phase:          room.phase,
    code:           room.code,
    roundNum:       room.roundNum,
    totalRounds:    room.totalRounds,
    spectrum:       room.spectrum,
    clue:           room.clue,
    isClueGiver,
    isHost:         room.players.find(p => p.id === pid)?.isHost || false,
    myId:           pid,
    clueGiverName:  cgPlayer?.name || '',
    clueGiverIdx:   room.clueGiverIdx,
    players: room.players.map(p => ({
      id:         p.id,
      name:       p.name,
      color:      p.color,
      totalScore: p.totalScore,
      isHost:     p.isHost,
      connected:  p.connected,
    })),
    guessCount:    room.guesses.length,
    totalGuessers: Math.max(0, room.players.length - 1),
    ...(showTarget ? { target: room.target } : {}),
  };

  if (inReveal) {
    view.guesses = room.guesses.map(g => ({ playerId: g.playerId, position: g.position, score: g.score }));
  } else if (room.phase === 'guessing') {
    const myGuess = room.guesses.find(g => g.playerId === pid);
    view.myGuessLocked   = !!myGuess;
    view.myGuessPosition = myGuess?.position ?? null;
  }

  return view;
}

function broadcast(room) {
  room.players.forEach(p => {
    const ws = room.connections.get(p.id);
    if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'STATE', state: viewFor(room, p.id) }));
  });
}

function sendErr(ws, message) {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ERROR', message }));
}

// ─── round logic ──────────────────────────────────────────────────────────────

function startRound(room) {
  room.roundNum++;
  const si = pickSpectrum(room.usedSpectra);
  room.usedSpectra.push(si);
  room.spectrum    = SPECTRUMS[si];
  room.target      = 0.1 + Math.random() * 0.8;
  room.clue        = '';
  room.guesses     = [];
  room.clueGiverIdx = (room.roundNum - 1) % room.players.length;
  room.phase       = 'round_start';
  broadcast(room);
}

function checkAllGuessed(room) {
  const numGuessers = room.players.length - 1;
  if (numGuessers <= 0 || room.guesses.length < numGuessers) return false;
  room.guesses.forEach(g => {
    g.score = scoreFor(g.position, room.target);
    const p = room.players.find(p => p.id === g.playerId);
    if (p) p.totalScore += g.score;
  });
  room.phase = 'reveal';
  broadcast(room);
  return true;
}

// ─── message handler ──────────────────────────────────────────────────────────

function handleMsg(ws, msg) {
  // ── pre-room messages ──
  if (msg.type === 'CREATE_ROOM') {
    const name = (msg.name || '').trim().slice(0, 20);
    if (!name) return sendErr(ws, 'Name required');
    const pid  = genId();
    const code = genCode();
    const room = {
      code, phase: 'lobby', totalRounds: 8, roundNum: 0, clueGiverIdx: 0,
      spectrum: null, target: 0, clue: '', guesses: [], usedSpectra: [],
      players:     [{ id: pid, name, color: COLORS[0], totalScore: 0, isHost: true, connected: true }],
      connections: new Map([[pid, ws]]),
    };
    rooms.set(code, room);
    ws.pid = pid; ws.code = code;
    ws.send(JSON.stringify({ type: 'STATE', state: viewFor(room, pid) }));
    return;
  }

  if (msg.type === 'JOIN_ROOM') {
    const code = (msg.code || '').trim().toUpperCase();
    const name = (msg.name || '').trim().slice(0, 20);
    const room = rooms.get(code);
    if (!room)                      return sendErr(ws, 'Room not found — check the code.');
    if (room.phase !== 'lobby')     return sendErr(ws, 'Game already in progress.');
    if (room.players.length >= 8)   return sendErr(ws, 'Room is full (8 players max).');
    if (!name)                      return sendErr(ws, 'Name required');

    // Reconnect: if this playerId already exists in the room, reattach
    if (msg.playerId) {
      const existing = room.players.find(p => p.id === msg.playerId);
      if (existing) {
        existing.connected = true;
        room.connections.set(existing.id, ws);
        ws.pid = existing.id; ws.code = code;
        broadcast(room);
        return;
      }
    }

    if (room.players.some(p => p.name.toLowerCase() === name.toLowerCase()))
      return sendErr(ws, 'That name is already taken in this room.');

    const pid = genId();
    room.players.push({ id: pid, name, color: COLORS[room.players.length % COLORS.length], totalScore: 0, isHost: false, connected: true });
    room.connections.set(pid, ws);
    ws.pid = pid; ws.code = code;
    broadcast(room);
    return;
  }

  // ── in-room messages ──
  const room   = ws.code ? rooms.get(ws.code) : null;
  const pid    = ws.pid;
  if (!room || !pid) return;
  const player = room.players.find(p => p.id === pid);
  if (!player) return;

  switch (msg.type) {
    case 'SET_ROUNDS':
      if (!player.isHost || room.phase !== 'lobby') return;
      room.totalRounds = Math.max(2, Math.min(20, parseInt(msg.rounds) || 8));
      broadcast(room);
      break;

    case 'START_GAME':
      if (!player.isHost || room.phase !== 'lobby') return;
      if (room.players.length < 2) return sendErr(ws, 'Need at least 2 players to start.');
      startRound(room);
      break;

    case 'ADVANCE_ROUND':
      if (!player.isHost || room.phase !== 'round_start') return;
      room.phase = 'clue_entry';
      broadcast(room);
      break;

    case 'SUBMIT_CLUE': {
      if (room.phase !== 'clue_entry') return;
      if (room.players[room.clueGiverIdx]?.id !== pid) return;
      const clue = (msg.clue || '').trim().slice(0, 60);
      if (!clue) return sendErr(ws, 'Please enter a clue.');
      room.clue  = clue;
      room.phase = 'guessing';
      broadcast(room);
      break;
    }

    case 'SUBMIT_GUESS': {
      if (room.phase !== 'guessing') return;
      if (room.players[room.clueGiverIdx]?.id === pid) return;
      if (room.guesses.some(g => g.playerId === pid)) return;
      const pos = typeof msg.position === 'number' ? Math.max(0.01, Math.min(0.99, msg.position)) : null;
      if (pos === null) return;
      room.guesses.push({ playerId: pid, position: pos, score: 0 });
      if (!checkAllGuessed(room)) broadcast(room);
      break;
    }

    case 'NEXT_ROUND':
      if (!player.isHost || room.phase !== 'reveal') return;
      if (room.roundNum >= room.totalRounds) { room.phase = 'game_over'; broadcast(room); }
      else startRound(room);
      break;

    case 'PLAY_AGAIN':
      if (!player.isHost || room.phase !== 'game_over') return;
      room.players.forEach(p => p.totalScore = 0);
      room.roundNum = 0; room.usedSpectra = [];
      startRound(room);
      break;

    case 'NEW_GAME':
      if (!player.isHost) return;
      rooms.delete(room.code);
      room.connections.forEach(cws => {
        if (cws.readyState === 1) cws.send(JSON.stringify({ type: 'ROOM_CLOSED' }));
        cws.pid = null; cws.code = null;
      });
      break;
  }
}

function handleClose(ws) {
  const { pid, code } = ws;
  if (!pid || !code) return;
  const room = rooms.get(code);
  if (!room) return;

  const player = room.players.find(p => p.id === pid);
  if (player) player.connected = false;
  room.connections.delete(pid);

  const connected = room.players.filter(p => p.connected);
  if (connected.length === 0) {
    setTimeout(() => { if (!room.players.some(p => p.connected)) rooms.delete(code); }, 60_000);
    return;
  }

  // Promote new host if host left
  if (player?.isHost) {
    player.isHost = false;
    connected[0].isHost = true;
  }

  // Adjust clue giver index if it went out of bounds
  if (room.clueGiverIdx >= room.players.length) room.clueGiverIdx = 0;

  // If a guesser disconnected mid-guessing, check if all remaining have guessed
  if (room.phase === 'guessing') checkAllGuessed(room);

  broadcast(room);
}

// ─── HTTP + WebSocket ─────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
    if (err) { res.writeHead(500); res.end('Server error'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
  ws.pid = null; ws.code = null;
  ws.on('message', data => { try { handleMsg(ws, JSON.parse(data)); } catch(e) { console.error('WS error:', e); } });
  ws.on('close', () => handleClose(ws));
  ws.on('error', err => console.error('Socket error:', err));
});

// Hourly cleanup of empty rooms
setInterval(() => { rooms.forEach((r, code) => { if (!r.players.some(p => p.connected)) rooms.delete(code); }); }, 3_600_000);

server.listen(PORT, () => {
  console.log(`\n  Wavelength  →  http://localhost:${PORT}\n`);
});
