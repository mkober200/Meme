'use strict';

const CONFIG_LIMITS = {
  minutesPerClip: { min: 1, max: 5, default: 2 },
  maxRounds: { min: 1, max: 10, default: 5 },
  skipsAllowed: { min: 0, max: 15, default: 3 },
};

const VOTE_POINTS = { up: 2, neutral: 1, down: 0 };

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const lobbies = new Map();

function generateCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (lobbies.has(code));
  return code;
}

function clampConfig(partial = {}) {
  const cfg = {};
  for (const key of Object.keys(CONFIG_LIMITS)) {
    const limits = CONFIG_LIMITS[key];
    const raw = partial[key];
    const num = Number.isFinite(raw) ? Math.round(raw) : limits.default;
    cfg[key] = Math.min(limits.max, Math.max(limits.min, num));
  }
  return cfg;
}

class Lobby {
  constructor(code, hostId) {
    this.code = code;
    this.hostId = hostId;
    this.createdAt = Date.now();
    this.players = new Map();
    this.config = clampConfig();
    this.state = 'LOBBY';
    this.round = 0;
    this.pack = [];
    this.usedClipIds = new Set();
    this.assignments = new Map();
    this.votingOrder = [];
    this.votingIndex = 0;
    this.votes = new Map();
    this.roundTimer = null;
    this.roundDeadline = null;
  }

  publicPlayerList() {
    return Array.from(this.players.values()).map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      score: p.score,
      isHost: p.id === this.hostId,
    }));
  }

  connectedPlayers() {
    return Array.from(this.players.values()).filter((p) => p.connected);
  }
}

function createLobby(hostName, socketId) {
  const code = generateCode();
  const lobby = new Lobby(code, null);
  const playerId = addPlayer(lobby, hostName, socketId);
  lobby.hostId = playerId;
  lobbies.set(code, lobby);
  return { lobby, playerId };
}

function addPlayer(lobby, name, socketId) {
  const playerId = `p_${Math.random().toString(36).slice(2, 10)}`;
  lobby.players.set(playerId, {
    id: playerId,
    name: (name || 'Spieler').slice(0, 24),
    socketId,
    connected: true,
    score: 0,
  });
  return playerId;
}

function joinLobby(code, name, socketId) {
  const lobby = lobbies.get(code.toUpperCase());
  if (!lobby) return { error: 'Lobby nicht gefunden. Code prüfen.' };
  if (lobby.state !== 'LOBBY') return { error: 'Runde läuft bereits. Bitte auf die nächste Lobby warten.' };
  if (lobby.players.size >= 12) return { error: 'Lobby ist voll (max. 12 Spieler).' };
  const playerId = addPlayer(lobby, name, socketId);
  return { lobby, playerId };
}

function getLobby(code) {
  return lobbies.get((code || '').toUpperCase());
}

function reconnectPlayer(lobby, playerId, socketId) {
  const player = lobby.players.get(playerId);
  if (!player) return false;
  player.connected = true;
  player.socketId = socketId;
  return true;
}

function disconnectSocket(lobby, socketId) {
  const player = Array.from(lobby.players.values()).find((p) => p.socketId === socketId);
  if (!player) return null;
  player.connected = false;
  if (lobby.hostId === player.id) {
    const next = lobby.connectedPlayers()[0];
    if (next) lobby.hostId = next.id;
  }
  return player;
}

function updateConfig(lobby, playerId, partialConfig) {
  if (lobby.hostId !== playerId) return { error: 'Nur der Host kann die Einstellungen ändern.' };
  if (lobby.state !== 'LOBBY') return { error: 'Einstellungen sind nur vor Spielstart änderbar.' };
  lobby.config = clampConfig({ ...lobby.config, ...partialConfig });
  return { config: lobby.config };
}

function pickClipForPlayer(lobby) {
  const available = lobby.pack.filter((c) => !lobby.usedClipIds.has(c.id));
  const pool = available.length > 0 ? available : lobby.pack;
  const clip = pool[Math.floor(Math.random() * pool.length)];
  if (clip) lobby.usedClipIds.add(clip.id);
  return clip;
}

function startGame(lobby, playerId, pack) {
  if (lobby.hostId !== playerId) return { error: 'Nur der Host kann das Spiel starten.' };
  if (lobby.connectedPlayers().length < 1) return { error: 'Mindestens 1 Spieler wird benötigt.' };
  if (!pack || pack.length === 0) return { error: 'Kein Clip-Pack geladen.' };
  lobby.pack = pack;
  lobby.usedClipIds.clear();
  lobby.round = 0;
  for (const p of lobby.players.values()) p.score = 0;
  return beginRound(lobby);
}

function beginRound(lobby) {
  lobby.round += 1;
  lobby.state = 'DUBBING';
  lobby.assignments.clear();
  lobby.votes.clear();
  lobby.votingOrder = [];
  lobby.votingIndex = 0;

  for (const player of lobby.connectedPlayers()) {
    const clip = pickClipForPlayer(lobby);
    lobby.assignments.set(player.id, {
      clip,
      skipsUsed: 0,
      cuts: [],
      submitted: false,
    });
  }

  lobby.roundDeadline = Date.now() + lobby.config.minutesPerClip * 60 * 1000;
  return { ok: true };
}

const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const MAX_CUSTOM_CLIP_SECONDS = 600;

function useCustomClip(lobby, playerId, input) {
  const assignment = lobby.assignments.get(playerId);
  if (!assignment) return { error: 'Keine aktive Zuweisung.' };
  if (lobby.state !== 'DUBBING') return { error: 'Eigene Clips lassen sich nur während der Aufnahmephase setzen.' };

  const youtubeId = extractYoutubeId(String(input.youtubeId || ''));
  if (!youtubeId) return { error: 'Keine gültige YouTube-Video-ID/URL erkannt.' };

  const startTime = Number(input.startTime);
  const endTime = Number(input.endTime);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime < 0 || endTime <= startTime) {
    return { error: 'Start-/Endzeit ungültig (Ende muss nach Start liegen).' };
  }
  if (endTime - startTime > MAX_CUSTOM_CLIP_SECONDS) {
    return { error: `Clip darf maximal ${MAX_CUSTOM_CLIP_SECONDS / 60} Minuten lang sein.` };
  }

  assignment.clip = {
    id: `custom-${Math.random().toString(36).slice(2, 10)}`,
    title: 'Eigener Clip',
    youtubeId,
    startTime,
    endTime,
    custom: true,
  };
  assignment.cuts = [];
  return { clip: assignment.clip };
}

function extractYoutubeId(raw) {
  const trimmed = raw.trim();
  if (YOUTUBE_ID_RE.test(trimmed)) return trimmed;
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtube\.com\/embed\/|youtu\.be\/|youtube\.com\/shorts\/)([A-Za-z0-9_-]{11})/,
  ];
  for (const re of patterns) {
    const m = trimmed.match(re);
    if (m) return m[1];
  }
  return null;
}

function skipClip(lobby, playerId) {
  const assignment = lobby.assignments.get(playerId);
  if (!assignment) return { error: 'Keine aktive Zuweisung.' };
  if (lobby.state !== 'DUBBING') return { error: 'Skippen ist nur während der Aufnahmephase möglich.' };
  if (assignment.skipsUsed >= lobby.config.skipsAllowed) {
    return { error: 'Keine Skips mehr übrig.' };
  }
  assignment.skipsUsed += 1;
  assignment.clip = pickClipForPlayer(lobby);
  assignment.cuts = [];
  return { clip: assignment.clip, skipsUsed: assignment.skipsUsed };
}

function submitDub(lobby, playerId, cuts) {
  const assignment = lobby.assignments.get(playerId);
  if (!assignment) return { error: 'Keine aktive Zuweisung.' };
  if (assignment.submitted) return { error: 'Bereits abgegeben.' };
  assignment.cuts = Array.isArray(cuts) ? cuts.slice().sort((a, b) => a.t - b.t) : [];
  assignment.submitted = true;

  const allSubmitted = lobby.connectedPlayers().every((p) => {
    const a = lobby.assignments.get(p.id);
    return a && a.submitted;
  });

  if (allSubmitted) {
    startVoting(lobby);
    return { allSubmitted: true };
  }
  return { allSubmitted: false };
}

function forceSubmitRemaining(lobby) {
  for (const [playerId, assignment] of lobby.assignments.entries()) {
    if (!assignment.submitted) {
      assignment.submitted = true;
    }
  }
  startVoting(lobby);
}

function startVoting(lobby) {
  lobby.state = 'VOTING';
  lobby.votingOrder = lobby.connectedPlayers().map((p) => p.id);
  lobby.votingIndex = 0;
  for (const playerId of lobby.votingOrder) {
    lobby.votes.set(playerId, new Map());
  }
}

function currentVotingTarget(lobby) {
  const targetId = lobby.votingOrder[lobby.votingIndex];
  if (!targetId) return null;
  const player = lobby.players.get(targetId);
  const assignment = lobby.assignments.get(targetId);
  return { playerId: targetId, playerName: player ? player.name : '?', clip: assignment.clip, cuts: assignment.cuts };
}

function castVote(lobby, targetPlayerId, voterId, vote) {
  if (lobby.state !== 'VOTING') return { error: 'Aktuell keine Abstimmung aktiv.' };
  if (targetPlayerId === voterId) return { error: 'Eigene Einreichung kann nicht bewertet werden.' };
  const current = lobby.votingOrder[lobby.votingIndex];
  if (current !== targetPlayerId) return { error: 'Diese Einreichung wird gerade nicht bewertet.' };
  if (!['up', 'down', 'neutral'].includes(vote)) return { error: 'Ungültige Stimme.' };

  const voteMap = lobby.votes.get(targetPlayerId);
  voteMap.set(voterId, vote);

  const eligibleVoters = lobby.connectedPlayers().filter((p) => p.id !== targetPlayerId);
  const allVoted = eligibleVoters.every((p) => voteMap.has(p.id));

  return { allVoted, votesSoFar: voteMap.size, votesNeeded: eligibleVoters.length };
}

function advanceVoting(lobby) {
  lobby.votingIndex += 1;
  if (lobby.votingIndex >= lobby.votingOrder.length) {
    return finishVotingPhase(lobby);
  }
  return { done: false };
}

function finishVotingPhase(lobby) {
  const roundScores = new Map();
  for (const [targetId, voteMap] of lobby.votes.entries()) {
    let points = 0;
    for (const vote of voteMap.values()) points += VOTE_POINTS[vote] ?? 0;
    roundScores.set(targetId, points);
    const player = lobby.players.get(targetId);
    if (player) player.score += points;
  }
  lobby.state = 'ROUND_RESULTS';
  lobby.lastRoundScores = roundScores;
  return { done: true, roundScores: Object.fromEntries(roundScores) };
}

function nextRoundOrEnd(lobby, playerId) {
  if (lobby.hostId !== playerId) return { error: 'Nur der Host kann fortfahren.' };
  if (lobby.round >= lobby.config.maxRounds) {
    lobby.state = 'GAME_OVER';
    return { gameOver: true };
  }
  beginRound(lobby);
  return { gameOver: false };
}

function leaderboard(lobby) {
  return lobby
    .publicPlayerList()
    .sort((a, b) => b.score - a.score);
}

function removeLobbyIfEmpty(lobby) {
  if (lobby.connectedPlayers().length === 0) {
    lobbies.delete(lobby.code);
    return true;
  }
  return false;
}

module.exports = {
  CONFIG_LIMITS,
  VOTE_POINTS,
  createLobby,
  joinLobby,
  getLobby,
  reconnectPlayer,
  disconnectSocket,
  updateConfig,
  startGame,
  skipClip,
  useCustomClip,
  submitDub,
  forceSubmitRemaining,
  currentVotingTarget,
  castVote,
  advanceVoting,
  nextRoundOrEnd,
  leaderboard,
  removeLobbyIfEmpty,
  clampConfig,
};
