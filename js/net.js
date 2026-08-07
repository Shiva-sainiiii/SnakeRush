// Snake Rush — WebRTC Networking (via PeerJS)
//
// Replaces the old WebSocket connection to the Render server. There is no
// backend anymore — the room's "host" (whoever taps "Create Room") runs
// the simulation locally (see sim.js) and every other player connects
// directly to the host's browser over a WebRTC data channel. PeerJS's
// free public broker is used only for the initial handshake (so two
// browsers can find each other); once connected, all game state, input,
// and snapshots travel peer-to-peer, never through a third-party server.
//
// This intentionally supports up to SIM_MAX_PLAYERS (see sim.js) real
// human peers connected to one host, not just 1-on-1 — the host holds a
// DataConnection per guest and broadcasts identically to all of them,
// the same fan-out server.js used to do over WebSocket.
//
// Room code format: reuses the existing 5-character room code style
// (see makeRoomCode below) as the PeerJS peer ID directly, prefixed so
// it can't collide with someone else's unrelated PeerJS app using the
// same public broker.

'use strict';

const Net = (() => {
  const ROOM_CODE_LEN = 5;
  const PEER_ID_PREFIX = 'snakerush-';

  // Google's public STUN servers — used only to discover each peer's
  // public IP/port for the WebRTC handshake, never touches game data.
  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  let peer = null;
  let isHost = false;
  let roomCode = '';
  // Host: peerId -> DataConnection, one per connected guest.
  // Guest: holds its single connection to the host under key 'host'.
  const conns = new Map();

  const messageHandlers = {};   // type -> [handlers]
  const lifecycleHandlers = {
    peerJoined: [],   // (peerId) — host only, fires when a guest connects
    peerLeft: [],     // (peerId) — host only, fires when a guest disconnects
    hostConnected: [], // () — guest only, fires once the data channel to the host is open
    hostDisconnected: [], // () — guest only, fires if the host connection drops; the match cannot continue
    error: [],        // (err)
  };

  function makeRoomCode() {
    // Same alphabet as server.js's old makeRoomCode — uppercase
    // letters/digits, excluding visually-ambiguous characters (0/O,
    // 1/I/L) so codes are easy to read aloud or type on a phone.
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < ROOM_CODE_LEN; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
  }

  function peerIdFromCode(code) {
    return PEER_ID_PREFIX + code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function on(type, handler) {
    (messageHandlers[type] = messageHandlers[type] || []).push(handler);
  }

  function onLifecycle(event, handler) {
    (lifecycleHandlers[event] = lifecycleHandlers[event] || []).push(handler);
  }

  function dispatch(msg, fromPeerId) {
    const list = messageHandlers[msg.type];
    if (list) list.forEach((h) => h(msg, fromPeerId));
  }

  // Send to a specific peer (host->one guest) or, with no peerId, to
  // everyone this side is connected to — for the host that means every
  // guest (broadcast); for a guest there's only ever the one connection
  // to the host, so it's equivalent to send-to-host either way.
  function send(obj, peerId) {
    if (peerId) {
      const c = conns.get(peerId);
      if (c && c.open) c.send(obj);
      return;
    }
    for (const c of conns.values()) {
      if (c.open) c.send(obj);
    }
  }

  function _attachGuestConn(peerId, conn) {
    conns.set(peerId, conn);
    conn.on('data', (data) => dispatch(data, peerId));
    conn.on('close', () => {
      conns.delete(peerId);
      lifecycleHandlers.peerLeft.forEach((h) => h(peerId));
    });
    conn.on('error', (e) => console.error('[net] guest connection error', e));
  }

  // Host: create a room and start listening for guests. Returns the
  // shareable room code immediately (before any guest has connected —
  // PeerJS's `open` event just confirms registration with the broker).
  function host() {
    isHost = true;
    roomCode = makeRoomCode();

    peer = new window.Peer(peerIdFromCode(roomCode), { config: { iceServers: ICE_SERVERS } });

    peer.on('open', () => {});

    peer.on('connection', (conn) => {
      if (conns.size >= window.SIM_MAX_PLAYERS - 1) {
        // Room's full (host + SIM_MAX_PLAYERS-1 guests) — reject
        // politely rather than silently dropping the attempt.
        conn.on('open', () => {
          conn.send({ type: 'room_full' });
          setTimeout(() => conn.close(), 500); // give the message a moment to actually send before closing
        });
        return;
      }
      conn.on('open', () => {
        _attachGuestConn(conn.peer, conn);
        lifecycleHandlers.peerJoined.forEach((h) => h(conn.peer));
      });
    });

    peer.on('error', (err) => {
      console.error('[net] host error', err);
      if (err.type === 'unavailable-id') {
        // Extremely rare collision on the public broker — retry with a
        // fresh code rather than surfacing this to the player as a
        // failure they need to act on.
        peer.destroy();
        host();
      } else {
        lifecycleHandlers.error.forEach((h) => h(err));
      }
    });

    return roomCode;
  }

  // Guest: join a room by code. onConnected/onFailed mirror the old
  // WebSocket join flow's callback shape so mp.js's calling code barely
  // has to change.
  function join(rawCode, { onConnected, onFailed } = {}) {
    const code = (rawCode || '').trim().toUpperCase();
    if (!code) { onFailed && onFailed('Enter a room code'); return; }

    isHost = false;
    roomCode = code;

    peer = new window.Peer({ config: { iceServers: ICE_SERVERS } });

    peer.on('open', () => {
      const conn = peer.connect(peerIdFromCode(code), { reliable: true });

      const failTimer = setTimeout(() => {
        if (!conn.open) {
          onFailed && onFailed("Couldn't find that room. Check the code.");
          peer.destroy();
        }
      }, 9000);

      conn.on('open', () => {
        clearTimeout(failTimer);
        conns.set('host', conn);
        conn.on('data', (data) => {
          if (data && data.type === 'room_full') {
            onFailed && onFailed('Room is full.');
            teardown();
            return;
          }
          dispatch(data, 'host');
        });
        conn.on('close', () => {
          conns.delete('host');
          lifecycleHandlers.hostDisconnected.forEach((h) => h());
        });
        conn.on('error', (e) => console.error('[net] host connection error', e));
        lifecycleHandlers.hostConnected.forEach((h) => h());
        onConnected && onConnected();
      });
    });

    peer.on('error', (err) => {
      console.error('[net] join error', err);
      clearTimeout && clearTimeout(); // no-op guard if error fires before failTimer exists
      onFailed && onFailed("Couldn't find that room. Check the code.");
    });
  }

  function teardown() {
    for (const c of conns.values()) { try { c.close(); } catch (e) {} }
    conns.clear();
    if (peer) { try { peer.destroy(); } catch (e) {} }
    peer = null;
    roomCode = '';
  }

  function getIsHost() { return isHost; }
  function getRoomCode() { return roomCode; }
  function getPeerIds() { return [...conns.keys()]; } // host: connected guest ids; guest: ['host']
  function isConnected() { return conns.size > 0; }

  return {
    on, onLifecycle, send,
    host, join, teardown,
    getIsHost, getRoomCode, getPeerIds, isConnected,
  };
})();

window.Net = Net;
