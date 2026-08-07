'use strict';

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const lobbyLogic = require('./src/lobby');
const packLoader = require('./src/packLoader');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 25 * 1024 * 1024,
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

const roundTimers = new Map();

function clearRoundTimer(code) {
  const t = roundTimers.get(code);
  if (t) {
    clearTimeout(t);
    roundTimers.delete(code);
  }
}

function broadcastLobbyState(lobby) {
  io.to(lobby.code).emit('lobby:state', {
    code: lobby.code,
    state: lobby.state,
    hostId: lobby.hostId,
    players: lobby.publicPlayerList(),
    config: lobby.config,
    round: lobby.round,
    limits: lobbyLogic.CONFIG_LIMITS,
  });
}

function sendRoundAssignment(lobby, playerId) {
  const player = lobby.players.get(playerId);
  if (!player || !player.connected) return;
  const assignment = lobby.assignments.get(playerId);
  if (!assignment) return;
  io.to(player.socketId).emit('round:you', {
    clip: assignment.clip,
    skipsUsed: assignment.skipsUsed,
    skipsAllowed: lobby.config.skipsAllowed,
    deadline: lobby.roundDeadline,
    round: lobby.round,
    maxRounds: lobby.config.maxRounds,
  });
}

function beginRoundAndNotify(lobby) {
  clearRoundTimer(lobby.code);
  for (const player of lobby.connectedPlayers()) {
    sendRoundAssignment(lobby, player.id);
  }
  broadcastLobbyState(lobby);

  const ms = lobby.config.minutesPerClip * 60 * 1000;
  const timer = setTimeout(() => {
    lobbyLogic.forceSubmitRemaining(lobby);
    broadcastLobbyState(lobby);
    sendVotingTarget(lobby);
  }, ms);
  roundTimers.set(lobby.code, timer);
}

function checkAllSubmittedAndMaybeAdvance(lobby) {
  const allSubmitted = lobby.connectedPlayers().every((p) => {
    const a = lobby.assignments.get(p.id);
    return a && a.submitted;
  });
  if (allSubmitted && lobby.state === 'DUBBING') {
    clearRoundTimer(lobby.code);
    lobbyLogic.startVoting(lobby);
    broadcastLobbyState(lobby);
    sendVotingTarget(lobby);
  }
}

function sendVotingTarget(lobby) {
  const target = lobbyLogic.currentVotingTarget(lobby);
  if (!target) {
    const result = lobbyLogic.finishVotingPhase(lobby);
    io.to(lobby.code).emit('round:results', {
      scores: result.roundScores,
      leaderboard: lobbyLogic.leaderboard(lobby),
    });
    return;
  }
  io.to(lobby.code).emit('voting:target', {
    playerId: target.playerId,
    playerName: target.playerName,
    clip: target.clip,
    recordings: target.recordings,
    index: lobby.votingIndex,
    total: lobby.votingOrder.length,
  });
}

function advanceVotingAndNotify(lobby) {
  const result = lobbyLogic.advanceVoting(lobby);
  if (result.done) {
    io.to(lobby.code).emit('round:results', {
      scores: result.roundScores,
      leaderboard: lobbyLogic.leaderboard(lobby),
    });
  } else {
    sendVotingTarget(lobby);
  }
}

function withErrorHandling(name, fn) {
  return (...args) => {
    try {
      fn(...args);
    } catch (err) {
      console.error(`[socket:${name}] Unerwarteter Fehler:`, err);
      const ack = args.find((a) => typeof a === 'function');
      if (ack) ack({ ok: false, error: `Serverfehler in "${name}": ${err.message}` });
    }
  };
}

io.on('connection', (socket) => {
  socket.on('lobby:create', withErrorHandling('lobby:create', ({ name } = {}, ack) => {
    const { lobby, playerId } = lobbyLogic.createLobby(name, socket.id);
    socket.join(lobby.code);
    socket.data.code = lobby.code;
    socket.data.playerId = playerId;
    ack && ack({ ok: true, code: lobby.code, playerId, isHost: true });
    broadcastLobbyState(lobby);
  }));

  socket.on('lobby:join', withErrorHandling('lobby:join', ({ code, name } = {}, ack) => {
    const result = lobbyLogic.joinLobby(String(code || ''), name, socket.id);
    if (result.error) return ack && ack({ ok: false, error: result.error });
    const { lobby, playerId } = result;
    socket.join(lobby.code);
    socket.data.code = lobby.code;
    socket.data.playerId = playerId;
    ack && ack({ ok: true, code: lobby.code, playerId, isHost: lobby.hostId === playerId });
    broadcastLobbyState(lobby);
  }));

  socket.on('packs:list', withErrorHandling('packs:list', (_payload, ack) => {
    ack && ack(packLoader.listPacks());
  }));

  socket.on('lobby:updateConfig', withErrorHandling('lobby:updateConfig', (partialConfig, ack) => {
    const lobby = lobbyLogic.getLobby(socket.data.code);
    if (!lobby) return ack && ack({ ok: false, error: 'Keine Lobby.' });
    const result = lobbyLogic.updateConfig(lobby, socket.data.playerId, partialConfig);
    if (result.error) return ack && ack({ ok: false, error: result.error });
    ack && ack({ ok: true, config: result.config });
    broadcastLobbyState(lobby);
  }));

  socket.on('lobby:start', withErrorHandling('lobby:start', ({ packId } = {}, ack) => {
    const lobby = lobbyLogic.getLobby(socket.data.code);
    if (!lobby) return ack && ack({ ok: false, error: 'Keine Lobby gefunden (Verbindung evtl. neu aufgebaut – bitte Lobby neu erstellen).' });
    let pack;
    try {
      pack = packLoader.loadPack(packId || 'demo-open-license');
    } catch (err) {
      return ack && ack({ ok: false, error: err.message });
    }
    const result = lobbyLogic.startGame(lobby, socket.data.playerId, pack);
    if (result.error) return ack && ack({ ok: false, error: result.error });
    ack && ack({ ok: true });
    beginRoundAndNotify(lobby);
  }));

  socket.on('round:skip', withErrorHandling('round:skip', (_payload, ack) => {
    const lobby = lobbyLogic.getLobby(socket.data.code);
    if (!lobby) return ack && ack({ ok: false, error: 'Keine Lobby.' });
    const result = lobbyLogic.skipClip(lobby, socket.data.playerId);
    if (result.error) return ack && ack({ ok: false, error: result.error });
    ack && ack({ ok: true, clip: result.clip, skipsUsed: result.skipsUsed });
  }));

  socket.on('round:submit', withErrorHandling('round:submit', ({ recordings } = {}, ack) => {
    const lobby = lobbyLogic.getLobby(socket.data.code);
    if (!lobby) return ack && ack({ ok: false, error: 'Keine Lobby.' });
    const result = lobbyLogic.submitDub(lobby, socket.data.playerId, recordings);
    if (result.error) return ack && ack({ ok: false, error: result.error });
    ack && ack({ ok: true });
    broadcastLobbyState(lobby);
    checkAllSubmittedAndMaybeAdvance(lobby);
  }));

  socket.on('voting:vote', withErrorHandling('voting:vote', ({ targetPlayerId, vote } = {}, ack) => {
    const lobby = lobbyLogic.getLobby(socket.data.code);
    if (!lobby) return ack && ack({ ok: false, error: 'Keine Lobby.' });
    const result = lobbyLogic.castVote(lobby, targetPlayerId, socket.data.playerId, vote);
    if (result.error) return ack && ack({ ok: false, error: result.error });
    ack && ack({ ok: true });
    io.to(lobby.code).emit('voting:progress', {
      votesSoFar: result.votesSoFar,
      votesNeeded: result.votesNeeded,
    });
    if (result.allVoted) {
      advanceVotingAndNotify(lobby);
    }
  }));

  socket.on('game:next', withErrorHandling('game:next', (_payload, ack) => {
    const lobby = lobbyLogic.getLobby(socket.data.code);
    if (!lobby) return ack && ack({ ok: false, error: 'Keine Lobby.' });
    const result = lobbyLogic.nextRoundOrEnd(lobby, socket.data.playerId);
    if (result.error) return ack && ack({ ok: false, error: result.error });
    ack && ack({ ok: true, gameOver: result.gameOver });
    if (result.gameOver) {
      io.to(lobby.code).emit('game:over', { leaderboard: lobbyLogic.leaderboard(lobby) });
      broadcastLobbyState(lobby);
    } else {
      beginRoundAndNotify(lobby);
    }
  }));

  socket.on('disconnect', withErrorHandling('disconnect', () => {
    const lobby = lobbyLogic.getLobby(socket.data.code);
    if (!lobby) return;
    lobbyLogic.disconnectSocket(lobby, socket.id);
    if (lobbyLogic.removeLobbyIfEmpty(lobby)) {
      clearRoundTimer(lobby.code);
      return;
    }
    broadcastLobbyState(lobby);
    if (lobby.state === 'DUBBING') checkAllSubmittedAndMaybeAdvance(lobby);
    if (lobby.state === 'VOTING') {
      const target = lobbyLogic.currentVotingTarget(lobby);
      if (target) {
        const eligible = lobby.connectedPlayers().filter((p) => p.id !== target.playerId);
        const voteMap = lobby.votes.get(target.playerId);
        if (eligible.length > 0 && eligible.every((p) => voteMap.has(p.id))) {
          advanceVotingAndNotify(lobby);
        }
      }
    }
  }));
});

server.listen(PORT, () => {
  console.log(`DubClash läuft auf http://localhost:${PORT}`);
});
