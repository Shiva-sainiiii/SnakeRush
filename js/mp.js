/* ═══════════════════════════════════════════════════════════════
   MULTIPLAYER CLIENT (WebRTC edition — see net.js / sim.js)

   Fully independent of the single-player Game class in game_part1-5.js.
   This file owns:
     - The lobby UI (#mp-overlay: create/join/waiting-room screens)
     - The in-match renderer (#mp-canvas) and HUD (#mp-hud)
     - Touch/mouse steering input

   No backend server — whoever creates the room ("host") runs the
   authoritative simulation (sim.js) locally and connects to every guest
   directly over WebRTC (net.js), which wraps PeerJS. A host's own input
   goes straight into its local `this.sim` (see _sendInput); a guest
   sends input over the data channel to the host instead, and both
   receive the resulting state snapshot through the same
   _handleMessage('state') path either way — host and guest render
   identically because they're consuming the same shape of payload, just
   from a different origin (a local callback vs. a network message).

   Client-side interpolation between snapshots (the host only broadcasts
   at 20 ticks/sec, so without this every snake visibly steps instead of
   gliding — see _getInterpolatedWorld) and local prediction/
   reconciliation for the player's own snake (see _advancePrediction /
   _reconcileSelf) are unchanged from the WebSocket version — neither
   cares where the snapshot came from.

   This never touches `Settings`, `window._game`, or any single-player
   state. The two modes are only connected by both being reachable from
   the same start screen.
═══════════════════════════════════════════════════════════════ */

// Must match SEGMENT_GAP on the server (server.js) — the spacing used to
// resample raw per-tick network points into evenly-spaced visual
// segments (see MP._resampleSegments). If the server's value ever
// changes, update this to match or body segment color banding will look
// subtly uneven again.
const SEGMENT_GAP_VISUAL = 12;

// Must match WORLD_W/WORLD_H on the server — used to draw the world
// boundary wall and the minimap. The server is authoritative for actual
// movement clamping; these are purely for the client to know where to
// draw the edge/map, so a mismatch wouldn't break gameplay, just make
// the boundary visual line up wrong.
const MP_WORLD_W = 4000;
const MP_WORLD_H = 4000;

// How far behind real time rendering intentionally sits. This is the
// standard fix for network jitter in real-time multiplayer: by always
// drawing what the world looked like ~100ms ago (not "right now"), there
// are normally 1-2 real snapshots already buffered on either side of the
// render target, so jitter of up to ~50ms in either direction just
// shifts which two snapshots get blended — it doesn't force any
// extrapolation-then-correction snap. Higher = smoother under bad
// networks but more visually "delayed"; 100ms is a common sweet spot.
// This delay is only applied to OTHER players + food now (see
// _predictedSelf below) — applying it to the local player too was the
// actual source of the reported input lag: every one of your own moves
// had to round-trip to the server and back before you'd see it, on top
// of this buffer.
const RENDER_DELAY_MS = 100;

// ── Local prediction constants — must exactly mirror sim.js (which
// itself mirrors single-player's game_part1.js/game_part2.js on purpose)
// so the predicted snake moves identically to how the host's simulation
// will simulate it, and multiplayer steering feels indistinguishable
// from single-player. If sim.js or single-player's tuning ever changes,
// these need updating too, or prediction error will grow every tick
// instead of staying near-zero.
//
// Full-feature mode: length grows from food and speed scales with
// length, matching single-player's Snake._calcSpeed and sim.js exactly.
const PRED_BASE_SPEED = 190;          // world units/sec — matches single-player BASE_SPEED
const PRED_BOOST_SPEED = 300;         // matches single-player BOOST_SPEED
const PRED_SEGMENT_GAP = 8;           // matches single-player SEGMENT_GAP
const PRED_EDGE_MARGIN = 10;          // matches SEGMENT_R, used for the same edge clamp the server applies
// Base body radius before species radiusMul is applied — matches
// sim.js's SIM_SEGMENT_R. Used only for full-map rendering (_drawFullMap);
// the main in-match renderer already gets its per-snake body width from
// a separate skin-drawing path that isn't part of this file's scope.
const SIM_SEGMENT_R_APPROX = 10;
// Length-based speed scaling — matches single-player's
// SPEED_SMALL_MUL/SPEED_LARGE_MUL/SPEED_SCALE_MIN/SPEED_SCALE_MAX and
// sim.js's copy of them exactly.
const PRED_SPEED_SMALL_MUL = 1.13;
const PRED_SPEED_LARGE_MUL = 0.87;
const PRED_SPEED_SCALE_MIN = 10;
const PRED_SPEED_SCALE_MAX = 80;

// How fast an outstanding reconciliation offset (see _reconcileSelf)
// bleeds toward zero, as a fraction removed per second. 8/sec means ~63%
// of any error is gone within ~125ms and it's visually settled within a
// couple hundred ms — fast enough to stay locked to the server, slow
// enough that individual corrections (arriving ~every 50ms) are never
// seen as a discrete pop, only as a continuous slide.
const RECONCILE_DECAY_PER_SEC = 8;
// Beyond this distance the gap is treated as a "real" desync (death,
// respawn, a missed collision, a long stall) rather than normal drift —
// re-seed instantly instead of sliding, since sliding a huge gap would
// just look like teleporting in slow motion.
const RECONCILE_SNAP_DIST = 220;

const MP = {
  sim: null, // the local Simulation instance, set only when we're the host — see sim.js
  roomCode: null,
  playerId: null,
  mySnakeId: null,
  connected: false,
  inMatch: false,

  // Snapshot history buffer for interpolation. Rather than keeping only
  // the two most recent snapshots and racing to extrapolate right up to
  // "now" (which is what caused the forward/backward wobble whenever
  // network jitter made a snapshot arrive later or earlier than
  // expected), this keeps a short rolling history and always renders
  // slightly BEHIND real time (see RENDER_DELAY_MS below). That gives
  // normal jitter a buffer to be absorbed into — the render is always
  // interpolating between two snapshots that have both already safely
  // arrived, instead of extrapolating past the newest one and hoping the
  // next one shows up on schedule.
  _snapshotHistory: [], // [{ snakes, food, t }, ...] oldest to newest
  _serverTickMs: 50,     // matches TICK_MS on the server (20 ticks/sec), used only as a sane history-trim size

  // Locally-predicted state for the player's OWN snake only — moved every
  // render frame using the same movement formula as server.js, instead of
  // waiting for a server snapshot. This is what removes the round-trip
  // lag from your own steering: you see yourself move the instant you
  // steer, and the server snapshot (arriving ~tick-rate + network-RTT
  // later) is used only to gently correct any drift, not as the primary
  // source of your own position. Other players/food still render from
  // the delayed/interpolated snapshot — see _getInterpolatedWorld.
  _predictedSelf: null, // { x, y, dirX, dirY, inputDirX, inputDirY, boosting, length, segments }
  _lastPredictTime: 0,

  // Local input state
  _pointer: { x: 0, y: 0 },
  _boosting: false,
  // Virtual joystick state — mirrors single-player's game_part3.js touch
  // joystick (drag-relative-to-origin with a dead zone and a visible
  // thumb), which mp.js never had; it only tracked raw pointer position
  // and steered toward it directly, with touchstart also flipping boost
  // on immediately — meaning any touch to steer was also boosting.
  _joystick: { active: false, originX: 0, originY: 0, thumbX: 0, thumbY: 0, maxR: 50 },
  _joystickDir: { x: 0, y: 0 },
  _joystickTouchId: null, // which finger owns the joystick, so a 2nd finger (boost) can't hijack it
  _dpr: 1,
  _camX: 0,
  _camY: 0,

  // ── DOM refs, populated on init ──
  el: {},

  init() {
    this.el = {
      openBtn: document.getElementById('mp-open-btn'),
      overlay: document.getElementById('mp-overlay'),
      backdrop: document.getElementById('mp-backdrop'),
      closeBtn: document.getElementById('mp-close-btn'),
      status: document.getElementById('mp-status'),

      stepChoose: document.getElementById('mp-step-choose'),
      createBtn: document.getElementById('mp-create-btn'),
      joinBtn: document.getElementById('mp-join-btn'),

      stepJoin: document.getElementById('mp-step-join'),
      codeInput: document.getElementById('mp-code-input'),
      joinConfirmBtn: document.getElementById('mp-join-confirm-btn'),
      joinBackBtn: document.getElementById('mp-join-back-btn'),

      stepWaiting: document.getElementById('mp-step-waiting'),
      roomCodeDisplay: document.getElementById('mp-room-code'),
      copyCodeBtn: document.getElementById('mp-copy-code-btn'),
      playerList: document.getElementById('mp-player-list'),
      leaveBtn: document.getElementById('mp-leave-btn'),

      hud: document.getElementById('mp-hud'),
      hudRoom: document.getElementById('mp-hud-room'),
      hudScore: document.getElementById('mp-hud-score'),
      hudLength: document.getElementById('mp-hud-length'),
      hudLives: document.getElementById('mp-hud-lives'),
      hudStatus: document.getElementById('mp-hud-status'),
      hudBoost: document.getElementById('mp-hud-boost'),
      exitBtn: document.getElementById('mp-exit-btn'),

      canvas: document.getElementById('mp-canvas'),
    };

    if (!this.el.openBtn || !this.el.canvas) return; // markup missing, bail safely
    this.ctx = this.el.canvas.getContext('2d');

    this._wireUI();
  },

  _wireUI() {
    const el = this.el;

    el.openBtn.addEventListener('click', () => this._openLobby());
    el.closeBtn.addEventListener('click', () => this._closeLobby());
    el.backdrop.addEventListener('click', () => this._closeLobby());

    el.createBtn.addEventListener('click', () => this._createRoom());
    el.joinBtn.addEventListener('click', () => this._showStep('join'));
    el.joinBackBtn.addEventListener('click', () => this._showStep('choose'));
    el.joinConfirmBtn.addEventListener('click', () => this._joinRoom());

    el.codeInput.addEventListener('input', () => {
      el.codeInput.value = el.codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    });
    el.codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._joinRoom();
    });

    el.copyCodeBtn.addEventListener('click', () => this._copyRoomCode());
    el.leaveBtn.addEventListener('click', () => this._leaveRoom());
    el.exitBtn.addEventListener('click', () => this._leaveRoom());

    this._setupInput();
    this._setupResize();
  },

  // ── Lobby flow ──────────────────────────────────────────────
  _openLobby() {
    this.el.overlay.classList.remove('hidden');
    this._showStep('choose');
    this._hideStatus();
  },

  _closeLobby() {
    // Only actually disconnect if we're not already in a live match —
    // closing the lobby overlay itself shouldn't kill an active game if
    // it were ever opened for some other reason mid-match.
    if (!this.inMatch) this._disconnect();
    this.el.overlay.classList.add('hidden');
  },

  _showStep(name) {
    this.el.stepChoose.classList.toggle('hidden', name !== 'choose');
    this.el.stepJoin.classList.toggle('hidden', name !== 'join');
    this.el.stepWaiting.classList.toggle('hidden', name !== 'waiting');
  },

  _showStatus(message, isError) {
    this.el.status.textContent = message;
    this.el.status.classList.remove('hidden');
    this.el.status.classList.toggle('mp-status--error', !!isError);
  },
  _hideStatus() {
    this.el.status.classList.add('hidden');
  },

  _createRoom() {
    this._showStatus('Setting up room…');

    // Host owns the authoritative simulation now — see sim.js. It runs
    // right here on this device instead of on a Render server; Net.host()
    // just handles letting other browsers find and connect to this one.
    this.sim = new window.Simulation();
    this.mySnakeId = 'host';
    const snake = this.sim.addPlayer('host', getPlayerName(), Settings.design);
    this.sim.onState = (payload) => {
      // The host is both the simulation owner AND a player in it, so it
      // feeds the exact same state payload through the exact same
      // _handleMessage('state') path a guest's network message would —
      // there's no separate "host rendering" code path, which is what
      // keeps host and guest visually identical.
      this._handleMessage(payload);
      Net.send(payload); // broadcast to every connected guest
    };
    this.sim.start();

    const code = Net.host();
    this.roomCode = code;
    this.playerId = 'host';
    this._hideStatus();
    this.el.roomCodeDisplay.textContent = this.roomCode;
    this._showStep('waiting');
    this._seedPredictedSelf(snake);

    Net.onLifecycle('peerJoined', (peerId) => {
      const guestSnake = this.sim.addPlayer(peerId, 'Player', 'multicolour');
      // Tell the newly-connected guest who they are before the next
      // regular state broadcast — otherwise they'd have no way to know
      // which of the (possibly several) snakes in the first snapshot is
      // theirs.
      Net.send({ type: 'joined', roomCode: this.roomCode, playerId: peerId, snake: guestSnake }, peerId);
    });
    Net.onLifecycle('peerLeft', (peerId) => {
      this.sim.removePlayer(peerId);
    });
    Net.on('input', (msg, fromPeerId) => {
      this.sim.setInput(fromPeerId, Number(msg.dirX) || 0, Number(msg.dirY) || 0, !!msg.boosting);
    });
  },

  _joinRoom() {
    const code = this.el.codeInput.value.trim();
    if (code.length < 4) {
      this._showStatus('Enter the full room code your friend shared.', true);
      return;
    }
    this._showStatus('Connecting to your friend…');

    Net.on('joined', (msg) => this._handleMessage(msg));
    Net.on('state', (msg) => this._handleMessage(msg));

    Net.join(code, {
      onConnected: () => {
        this.connected = true;
        Net.send({ type: 'join_room', name: getPlayerName(), skin: Settings.design });
      },
      onFailed: (message) => {
        this._showStatus(message, true);
      },
    });

    Net.onLifecycle('hostDisconnected', () => {
      this.connected = false;
      if (this.inMatch) {
        this._showMatchStatus('Host disconnected — the match has ended.');
      }
    });
  },

  _disconnect() {
    if (this.sim) {
      this.sim.stop();
      this.sim = null;
    }
    Net.teardown();
    this.connected = false;
  },

  _send(obj) {
    // From a guest this always means "send to the host" (their only
    // connection). The host itself never calls this for its own input —
    // see _sendInput, which calls this.sim.setInput() directly instead,
    // since host and simulation are the same device and don't need a
    // network round-trip.
    Net.send(obj);
  },

  _handleMessage(msg) {
    switch (msg.type) {
      case 'joined':
        this.roomCode = msg.roomCode;
        this.playerId = msg.playerId;
        this.mySnakeId = msg.playerId;
        this._hideStatus();
        this.el.roomCodeDisplay.textContent = this.roomCode;
        this._showStep('waiting');
        // Seed prediction from the snake the server just handed back, so
        // the very first predicted frame starts from the real spawn point
        // instead of (0,0).
        if (msg.snake) this._seedPredictedSelf(msg.snake);
        break;

      case 'state': {
        // Push into the rolling history buffer, then trim anything old
        // enough that it can no longer be relevant to the render delay
        // (keep a little extra margin rather than trimming right at the
        // edge, so a brief burst of network jitter never empties the
        // buffer right when it's needed most).
        this._snapshotHistory.push({ snakes: msg.snakes, food: msg.food, t: performance.now() });
        const trimBefore = performance.now() - RENDER_DELAY_MS - this._serverTickMs * 4;
        while (this._snapshotHistory.length > 2 && this._snapshotHistory[0].t < trimBefore) {
          this._snapshotHistory.shift();
        }
        // AI snakes (Phase 4) are always present in msg.snakes, so both
        // the waiting-room list and the "did a friend join yet" check
        // must filter them out — otherwise the match would auto-start
        // the instant a single human joins, since the AI count alone
        // already satisfies ">= 2".
        const humanSnakes = msg.snakes.filter((s) => !s.isAI);
        this._updateWaitingList(humanSnakes);
        // Auto-start the match as soon as there are 2+ human players and
        // we're still sitting in the lobby overlay — matches the "starts
        // automatically once a friend joins" behavior shown in the UI.
        if (!this.inMatch && humanSnakes.length >= 2) {
          this._enterMatch();
        }
        if (this.inMatch) this._updateHud(msg.snakes);

        // Reconcile local prediction against the authoritative snapshot —
        // the server is always right; this just decides how gently we
        // catch up to it. See RECONCILE_DECAY_PER_SEC / RECONCILE_SNAP_DIST.
        const authSelf = msg.snakes.find((s) => s.id === this.mySnakeId);
        if (authSelf) this._reconcileSelf(authSelf);
        break;
      }

      case 'error':
        this._showStatus(msg.message || 'Something went wrong.', true);
        break;

      default:
        break;
    }
  },

  _updateWaitingList(snakes) {
    const list = this.el.playerList;
    if (!list) return;
    list.innerHTML = snakes.map((s) => {
      const you = s.id === this.mySnakeId ? ' (You)' : '';
      return `<div class="mp-player-row"><span class="mp-player-dot" style="background:${s.color}"></span>${s.name}${you}</div>`;
    }).join('');
  },

  _copyRoomCode() {
    if (!this.roomCode) return;
    const done = () => {
      this.el.copyCodeBtn.textContent = '✅ Copied!';
      this.el.copyCodeBtn.classList.add('mp-copied');
      setTimeout(() => {
        this.el.copyCodeBtn.textContent = '📋 Copy Code';
        this.el.copyCodeBtn.classList.remove('mp-copied');
      }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(this.roomCode).then(done).catch(done);
    } else {
      done();
    }
  },

  _leaveRoom() {
    this._disconnect();
    this.inMatch = false;
    this.roomCode = null;
    this._snapshotHistory = [];
    this._predictedSelf = null;
    this.el.hud.classList.add('hidden');
    this.el.canvas.classList.add('hidden');
    this.el.overlay.classList.remove('hidden');
    this._showStep('choose');
  },

  // ── Entering/leaving the actual match view ──────────────────
  _enterMatch() {
    this.inMatch = true;
    this.el.overlay.classList.add('hidden');
    this.el.hud.classList.remove('hidden');
    this.el.canvas.classList.remove('hidden');
    this.el.hudRoom.textContent = `Room: ${this.roomCode}`;
    this._resizeCanvas();
    if (!this._rafId) this._rafId = requestAnimationFrame(() => this._renderLoop());
    if (!this._inputTimer) this._inputTimer = setInterval(() => this._sendInput(), 50); // 20/sec, matches server tick rate
  },

  _showMatchStatus(text) {
    if (this.el.hudStatus) this.el.hudStatus.textContent = text;
  },

  _updateHud(snakes) {
    const mine = snakes.find((s) => s.id === this.mySnakeId);
    if (!mine) return;

    this.el.hudScore.textContent = `Score: ${mine.score || 0}`;
    this.el.hudLength.textContent = `Length: ${mine.length}`;

    // Lives shown as heart icons — mirrors single-player's HUD convention
    // (♥ per remaining life) rather than a plain number, so it reads at
    // a glance the same way single-player already trained the player to
    // read it.
    if (typeof mine.lives === 'number') {
      this.el.hudLives.textContent = '❤️'.repeat(Math.max(0, mine.lives));
      this.el.hudLives.classList.remove('hidden');
    } else {
      this.el.hudLives.classList.add('hidden');
    }

    if (!mine.alive) {
      if (mine.lives > 0) {
        this._showMatchStatus('💀 You died — respawning…');
      } else {
        // Out of lives — this player's run is over, but they can keep
        // watching the match (the room itself keeps going for whoever
        // still has lives left). Distinct message from the respawning
        // case so it's clear nothing more is coming for them.
        this._showMatchStatus('☠️ Out of lives — watching the rest of the match');
      }
    } else {
      this._showMatchStatus('');
    }
  },

  // Finds the two buffered snapshots that straddle "renderTime" (now
  // minus RENDER_DELAY_MS) and blends between them. Because rendering
  // deliberately lags real time by RENDER_DELAY_MS, renderTime normally
  // falls BETWEEN two snapshots that have already both safely arrived —
  // there's essentially never a need to extrapolate past the newest
  // data, which is what made the old prev/cur-only approach wobble
  // whenever a snapshot arrived a bit later than the previous fixed-
  // interval assumption expected.
  _getInterpolatedWorld() {
    const hist = this._snapshotHistory;
    if (hist.length === 0) return { snakes: [], food: [] };
    if (hist.length === 1) return hist[0];

    const renderTime = performance.now() - RENDER_DELAY_MS;

    // Find the newest snapshot at or before renderTime, and the one
    // right after it — these are the two we blend between.
    let prev = hist[0], cur = hist[hist.length - 1];
    for (let i = 0; i < hist.length - 1; i++) {
      if (hist[i].t <= renderTime && hist[i + 1].t >= renderTime) {
        prev = hist[i];
        cur = hist[i + 1];
        break;
      }
    }
    // If renderTime is newer than everything buffered (a rare case right
    // after a connection hiccup catches up), just use the two newest
    // snapshots — this naturally degrades to a short extrapolation
    // rather than crashing or freezing.
    if (renderTime > hist[hist.length - 1].t) {
      prev = hist[hist.length - 2] || hist[hist.length - 1];
      cur = hist[hist.length - 1];
    }

    const span = Math.max(1, cur.t - prev.t); // avoid divide-by-zero if two snapshots landed at the same tick
    const t = Math.max(0, Math.min(1.3, (renderTime - prev.t) / span));

    const prevById = new Map(prev.snakes.map((s) => [s.id, s]));
    const snakes = cur.snakes.map((curSnake) => {
      const prevSnake = prevById.get(curSnake.id);
      if (!prevSnake || !prevSnake.alive || !curSnake.alive) return curSnake;

      const segCount = Math.min(prevSnake.segments.length, curSnake.segments.length);
      const segments = curSnake.segments.map((seg, i) => {
        if (i >= segCount) return seg; // newly-grown segment, no previous position to blend from
        const p = prevSnake.segments[i];
        return { x: p.x + (seg.x - p.x) * t, y: p.y + (seg.y - p.y) * t };
      });
      return { ...curSnake, segments };
    });

    return { snakes, food: cur.food };
  },

  // ── Local prediction (own snake only) ───────────────────────
  // Builds the initial predicted state from a server-sent snake object
  // (used both on room join and as a hard fallback if prediction was
  // never seeded for some reason, e.g. a respawn snapshot arriving before
  // the next predict tick runs).
  // Length-based speed scaling — matches single-player's
  // Snake._calcSpeed and sim.js's simCalcSpeed exactly, so a predicted
  // snake of a given length moves at the same speed the host's
  // simulation will actually simulate it at.
  _calcPredSpeed(baseSpeed, length) {
    const t = Math.max(0, Math.min(1, (length - PRED_SPEED_SCALE_MIN) / (PRED_SPEED_SCALE_MAX - PRED_SPEED_SCALE_MIN)));
    const mul = PRED_SPEED_SMALL_MUL + (PRED_SPEED_LARGE_MUL - PRED_SPEED_SMALL_MUL) * t;
    return baseSpeed * mul;
  },

  _seedPredictedSelf(snake) {
    this._predictedSelf = {
      x: snake.segments[0].x,
      y: snake.segments[0].y,
      errX: 0, errY: 0, // pending reconciliation offset, see _reconcileSelf
      dirX: 1, dirY: 0,
      inputDirX: 1, inputDirY: 0,
      boosting: false,
      length: snake.length,
      segments: snake.segments.map((s) => ({ x: s.x, y: s.y })),
      frozen: false, // see _advancePrediction's local collision check
    };
    this._lastPredictTime = performance.now();
  },

  // Advances the predicted snake by dt seconds using the exact same
  // formula server.js runs — smooth turn-toward-input, speed based on
  // boost state, then moves the fixed segment array via spring-follow.
  // Called once per render frame (variable dt), unlike the server which
  // runs this at a fixed 50ms tick — the two will never be
  // pixel-identical, which is exactly what errX/errY exists to fix.
  //
  // Also decays any pending reconciliation offset (see _reconcileSelf)
  // by the same dt, so the correction is one continuous per-frame slide
  // instead of a series of discrete jumps every time a snapshot arrives.
  _advancePrediction(dt, otherSnakes) {
    const p = this._predictedSelf;
    if (!p || dt <= 0) return;

    // Frozen by a local collision prediction (see the check at the end
    // of this function) — hold position and wait for the server's next
    // snapshot to confirm the death (handled by _reconcileSelf) or, rarely,
    // correct a false-positive local read. Not advancing here is what
    // stops the "ghost sliding through the killer's body" look that
    // happened before: previously the predicted snake kept moving locally
    // for up to one tick (~50ms) after actually dying server-side, since
    // nothing local knew it had died yet.
    if (p.frozen) return;

    // Same lerp-toward-input formula single-player's PlayerSnake.update()
    // uses — 0.12 * dt * 60, kept unsimplified so it's easy to eyeball
    // against single-player's source and server.js's copy of it.
    const turnRate = Math.min(1, 0.12 * dt * 60);
    p.dirX += (p.inputDirX - p.dirX) * turnRate;
    p.dirY += (p.inputDirY - p.dirY) * turnRate;
    const dl = Math.hypot(p.dirX, p.dirY) || 1;
    p.dirX /= dl; p.dirY /= dl;

    // Full-feature mode: length-based speed scaling, and boost is gated
    // behind length > 6 (matching single-player/sim.js — a snake too
    // short can't afford to boost since boosting costs length there;
    // sim.js applies the same gate server-side).
    const speed = (p.boosting && p.length > 6)
      ? this._calcPredSpeed(PRED_BOOST_SPEED, p.length)
      : this._calcPredSpeed(PRED_BASE_SPEED, p.length);
    p.x = Math.min(Math.max(p.x + p.dirX * speed * dt, PRED_EDGE_MARGIN), MP_WORLD_W - PRED_EDGE_MARGIN);
    p.y = Math.min(Math.max(p.y + p.dirY * speed * dt, PRED_EDGE_MARGIN), MP_WORLD_H - PRED_EDGE_MARGIN);

    // Bleed off any outstanding reconciliation error gradually (exponential
    // decay, framerate-independent) and fold it into the drawn head
    // position only — never into p.x/p.y themselves. Keeping the raw
    // simulation and the display offset separate means the *next*
    // simulation step always continues from a clean physics state, so
    // errors can't compound frame over frame.
    if (p.errX || p.errY) {
      // Exponential decay: e^(-rate * dt). The previous version used
      // Math.pow(1 - RECONCILE_DECAY_PER_SEC, dt), which is broken —
      // RECONCILE_DECAY_PER_SEC is 8, so the base (1 - 8 = -7) is
      // negative, and a negative base raised to a fractional exponent
      // (dt is ~0.016 at 60fps) is NaN in JS. That NaN then flowed into
      // drawX/drawY every frame, and canvas arc()/fill() calls silently
      // no-op on NaN coordinates instead of throwing — which is exactly
      // why nothing rendered (snake, and anything drawn after it) with
      // no console error to point at it.
      const decay = Math.exp(-RECONCILE_DECAY_PER_SEC * dt);
      p.errX *= decay;
      p.errY *= decay;
      if (Math.hypot(p.errX, p.errY) < 0.3) { p.errX = 0; p.errY = 0; }
    }
    const drawX = p.x + p.errX;
    const drawY = p.y + p.errY;

    // Segment model — exactly matches single-player's Snake (and
    // server.js's copy of it): a FIXED array of segments, head moved
    // directly, every other segment chasing the one in front of it and
    // snapping to exactly PRED_SEGMENT_GAP away once it drifts further.
    // This spring-follow shape is what produces the correct curve on
    // sharp turns — a raw head-trail resampled by distance (the previous
    // approach here) looks close but isn't pixel-identical to it.
    if (p.segments.length === 0) p.segments.push({ x: drawX, y: drawY });
    p.segments[0].x = drawX;
    p.segments[0].y = drawY;

    const targetLen = Math.max(1, Math.round(p.length));
    if (p.segments.length < targetLen) {
      const tail = p.segments[p.segments.length - 1];
      p.segments.push({ x: tail.x, y: tail.y });
    } else if (p.segments.length > targetLen) {
      p.segments.length = targetLen;
    }

    const gapSq = PRED_SEGMENT_GAP * PRED_SEGMENT_GAP;
    for (let i = 1; i < p.segments.length; i++) {
      const seg = p.segments[i];
      const prev = p.segments[i - 1];
      const dx = prev.x - seg.x, dy = prev.y - seg.y;
      const dSq = dx * dx + dy * dy;
      if (dSq <= gapSq) continue;
      const dist = Math.sqrt(dSq);
      const t = (dist - PRED_SEGMENT_GAP) / dist;
      seg.x += dx * t;
      seg.y += dy * t;
    }

    // Local collision prediction — check the head we just moved to
    // against every other alive snake's body, using the same
    // radius-scaled hit-test sim.js's authoritative collision check
    // uses. This is what actually fixes the "hit lag" — without it, a
    // collision was only ever known once the next server snapshot
    // arrived (up to ~50ms later), during which the predicted snake kept
    // sliding through the body that killed it. This local check can't
    // be authoritative (only the host's simulation decides who really
    // died — see sim.js), but freezing immediately on a locally-detected
    // hit removes the visible delay in the common case, and
    // _reconcileSelf still corrects this local guess against the real
    // server state on the next snapshot regardless (unfreezing it again
    // if this was a false positive, e.g. two bodies briefly overlapping
    // on-screen from render-delay/interpolation without an actual
    // server-side hit).
    if (otherSnakes) {
      const headX = p.segments[0].x, headY = p.segments[0].y;
      for (const other of otherSnakes) {
        if (other.id === this.mySnakeId || !other.alive) continue;
        const hitDist = SIM_SEGMENT_R_APPROX * 1.3 * (other.radiusMul || 1); // matches sim.js's SEGMENT_R * 1.3 * radiusMul exactly — both are world units, no conversion needed
        const hitDistSq = hitDist * hitDist;
        for (let i = 3; i < other.segments.length; i++) {
          const seg = other.segments[i];
          const dx = seg.x - headX, dy = seg.y - headY;
          if (dx * dx + dy * dy < hitDistSq) {
            p.frozen = true;
            return;
          }
        }
      }
    }
  },

  // Records how far off the predicted head is from the server's
  // authoritative head as an *offset*, rather than moving the head there
  // directly. _advancePrediction bleeds this offset toward zero a little
  // every frame, so the on-screen snake does one continuous smooth slide
  // toward the correct spot instead of snapping 25% closer every time a
  // new snapshot lands (~20x/sec) — that repeated snapping was the
  // "flickering forward and back" and the body looking individually
  // jittery, since each segment was being pulled toward a different old
  // snapshot's segment independently.
  //
  // The body is never matched to the server's segments directly — it's
  // always rebuilt from the head trail in _advancePrediction, so it stays
  // one continuous curve no matter how the head offset is moving.
  _reconcileSelf(authSnake) {
    if (!authSnake.alive) {
      // Dead/respawning — nothing to predict against right now. Re-seed
      // so the moment a fresh spawn snapshot arrives, prediction picks up
      // cleanly from it instead of resuming from a stale pre-death spot.
      this._seedPredictedSelf(authSnake);
      return;
    }
    if (!this._predictedSelf) { this._seedPredictedSelf(authSnake); return; }

    const p = this._predictedSelf;
    p.length = authSnake.length; // length itself is never predicted client-side, always trust the server
    // Server confirms we're still alive — clear any local freeze from a
    // collision prediction that turned out to be a false positive (e.g.
    // two bodies briefly overlapping on-screen from render-delay without
    // an actual server-side hit), so movement resumes.
    p.frozen = false;

    const authHead = authSnake.segments[0];
    // Compare against the *simulation* position (p.x/p.y), not the
    // current drawn position — the drawn position already includes
    // whatever offset is still bleeding off from the last correction, so
    // comparing against it would double-count that same error.
    const gap = Math.hypot(authHead.x - p.x, authHead.y - p.y);

    if (gap > RECONCILE_SNAP_DIST) {
      this._seedPredictedSelf(authSnake);
      return;
    }
    if (gap < 0.5) return; // close enough, not worth a correction

    // Re-anchor the simulation to the server's position immediately
    // (so future prediction steps start from a correct baseline and
    // errors don't accumulate), but push the resulting jump entirely
    // into errX/errY so the *drawn* position doesn't move yet — only
    // _advancePrediction's per-frame decay moves it, smoothly.
    p.errX += p.x - authHead.x;
    p.errY += p.y - authHead.y;
    p.x = authHead.x;
    p.y = authHead.y;
  },

  // ── Input ────────────────────────────────────────────────────
  _setupInput() {
    const canvas = this.el.canvas;

    // Desktop/mouse: unchanged pointer-follow steering — there's no
    // touch surface to put a joystick on, so "steer toward the cursor"
    // stays the right feel here.
    const setPointerFromEvent = (clientX, clientY) => {
      this._pointer.x = clientX;
      this._pointer.y = clientY;
    };
    canvas.addEventListener('mousemove', (e) => setPointerFromEvent(e.clientX, e.clientY));
    canvas.addEventListener('mousedown', (e) => {
      if (this._isPointOnMinimap(e.clientX, e.clientY)) { this._openFullMap(); return; }
      this._boosting = true;
    });
    window.addEventListener('mouseup', () => { this._boosting = false; });

    // Touch: virtual joystick, matching single-player's game_part3.js —
    // the first finger down is claimed as the joystick and steers via
    // drag-distance-from-origin (not absolute position), with a small
    // dead zone so tiny finger tremor near the origin doesn't cause
    // jitter. A second finger is boost-only and never moves the
    // joystick, so steering and boosting can be done with two hands
    // independently instead of one touch doing both at once.
    //
    // A tap landing on the minimap opens the fullscreen map instead of
    // claiming the joystick — checked first, same priority single-player
    // gives it in game_part3.js.
    canvas.addEventListener('touchstart', (e) => {
      if (!this.inMatch) return;
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (this._isPointOnMinimap(t.clientX, t.clientY)) { this._openFullMap(); return; }
      }
      for (const t of e.changedTouches) {
        if (this._joystickTouchId === null && !this._joystick.active) {
          this._joystickTouchId = t.identifier;
          this._joystick.active = true;
          this._joystick.originX = t.clientX;
          this._joystick.originY = t.clientY;
          this._joystick.thumbX = t.clientX;
          this._joystick.thumbY = t.clientY;
          this._joystickDir = { x: 0, y: 0 };
        } else if (t.identifier !== this._joystickTouchId) {
          this._boosting = true;
        }
      }
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
      if (!this.inMatch) return;
      e.preventDefault();
      if (!this._joystick.active || this._joystickTouchId === null) return;
      let t = null;
      for (const ct of e.changedTouches) {
        if (ct.identifier === this._joystickTouchId) { t = ct; break; }
      }
      if (!t) return;

      const dx = t.clientX - this._joystick.originX;
      const dy = t.clientY - this._joystick.originY;
      const dist = Math.hypot(dx, dy);
      const maxR = this._joystick.maxR;
      const clamp = Math.min(dist, maxR);
      const nx = dist > 0 ? dx / dist : 0;
      const ny = dist > 0 ? dy / dist : 0;
      this._joystick.thumbX = this._joystick.originX + nx * clamp;
      this._joystick.thumbY = this._joystick.originY + ny * clamp;
      if (dist > 10) this._joystickDir = { x: nx, y: ny }; // dead zone — matches single-player's
    }, { passive: false });

    canvas.addEventListener('touchend', (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === this._joystickTouchId) {
          this._joystickTouchId = null;
          this._joystick.active = false;
          this._joystickDir = { x: 0, y: 0 };
        }
      }
      // Boost stays on only while some other (non-joystick) finger is still down
      const otherFingersDown = e.touches.length > (this._joystick.active ? 1 : 0);
      this._boosting = otherFingersDown;
    }, { passive: true });

    canvas.addEventListener('touchcancel', () => {
      this._joystickTouchId = null;
      this._joystick.active = false;
      this._joystickDir = { x: 0, y: 0 };
      this._boosting = false;
    }, { passive: true });

    this.el.hudBoost.addEventListener('mousedown', () => { this._boosting = true; });
    this.el.hudBoost.addEventListener('mouseup', () => { this._boosting = false; });
    this.el.hudBoost.addEventListener('touchstart', (e) => { e.preventDefault(); this._boosting = true; }, { passive: false });
    this.el.hudBoost.addEventListener('touchend', () => { this._boosting = false; });
  },

  _sendInput() {
    if (!this.inMatch) return;

    let dirX, dirY;
    if (this._joystick.active) {
      // Touch device with the joystick engaged — steer by joystick
      // direction, same as single-player.
      if (this._joystickDir.x === 0 && this._joystickDir.y === 0) return; // inside dead zone, hold current heading
      dirX = this._joystickDir.x;
      dirY = this._joystickDir.y;
    } else {
      // Desktop/mouse fallback — steer toward the pointer relative to the
      // snake's own head position on screen (head is always drawn at
      // screen-center, see _renderLoop).
      const cx = this.el.canvas.width / this._dpr / 2;
      const cy = this.el.canvas.height / this._dpr / 2;
      const dx = this._pointer.x - cx;
      const dy = this._pointer.y - cy;
      const len = Math.hypot(dx, dy);
      if (len < 5) return; // dead zone near center, avoids jitter when cursor sits near middle
      dirX = dx / len;
      dirY = dy / len;
    }

    // Apply to the local prediction immediately — this is the actual fix
    // for input lag. Previously this function only sent the input to the
    // server and waited for it to come back in a snapshot; now the
    // player's own snake starts turning the same frame they steer.
    if (this._predictedSelf) {
      this._predictedSelf.inputDirX = dirX;
      this._predictedSelf.inputDirY = dirY;
      this._predictedSelf.boosting = this._boosting;
    }

    if (this.sim) {
      // We're the host — feed input straight into the local simulation
      // instead of round-tripping it over the network to ourselves. This
      // doesn't change what the input DOES (setInput's normalization is
      // identical either way), only how it gets there.
      this.sim.setInput('host', dirX, dirY, this._boosting);
    } else {
      this._send({ type: 'input', dirX, dirY, boosting: this._boosting });
    }
    this.el.hudBoost.classList.toggle('hud-boost-active', this._boosting);
  },

  // ── Rendering ────────────────────────────────────────────────
  _setupResize() {
    const resize = () => this._resizeCanvas();
    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', resize);
  },

  _resizeCanvas() {
    const canvas = this.el.canvas;
    this._dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth, h = window.innerHeight;
    canvas.width = Math.round(w * this._dpr);
    canvas.height = Math.round(h * this._dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
  },

  _renderLoop() {
    this._rafId = requestAnimationFrame(() => this._renderLoop());
    if (!this.inMatch) return;

    const ctx = this.ctx;
    const dpr = this._dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const logW = this.el.canvas.width / dpr;
    const logH = this.el.canvas.height / dpr;

    // Interpolated snapshot — this smooths OTHER players + food, which
    // still only update every ~50ms (the server's tick rate) and would
    // otherwise visibly step between spots instead of gliding.
    const world = this._getInterpolatedWorld();

    // Advance and splice in the locally-predicted snake for the player's
    // own position — this is what actually removes input lag. Without
    // this, "world" above is the only source of your own position too,
    // which means every one of your moves waits a full network round-trip
    // plus RENDER_DELAY_MS before you'd see it.
    const now = performance.now();
    const dt = Math.min(0.1, (now - (this._lastPredictTime || now)) / 1000); // clamp so a tab-switch stall can't produce one giant leap
    this._lastPredictTime = now;
    if (this._predictedSelf) {
      this._advancePrediction(dt, world.snakes);
      const idx = world.snakes.findIndex((s) => s.id === this.mySnakeId);
      const predictedAsSnake = {
        ...(idx >= 0 ? world.snakes[idx] : {}),
        id: this.mySnakeId,
        segments: this._predictedSelf.segments,
      };
      if (idx >= 0) world.snakes[idx] = predictedAsSnake;
      else world.snakes.push(predictedAsSnake);
    }

    ctx.fillStyle = '#060907';
    ctx.fillRect(0, 0, logW, logH);

    const mine = world.snakes.find((s) => s.id === this.mySnakeId);
    // Camera centers on the player's own snake; if dead, keep the camera
    // frozen at their last known head position so the death moment is
    // still watchable rather than snapping to (0,0).
    if (mine && mine.segments[0]) { this._camX = mine.segments[0].x - logW / 2; this._camY = mine.segments[0].y - logH / 2; }
    const camX = this._camX, camY = this._camY;

    // Faint dot-grid background — matches the single-player world's own
    // texture instead of a flat void, drawn as a single tiled pattern
    // fill (one draw call) rather than per-dot, so it costs nothing
    // meaningful even though it covers the whole screen.
    this._drawBackgroundGrid(ctx, logW, logH, camX, camY);

    // Food — grouped by color, one beginPath()/fill() batch per color
    // group instead of one per food item. This keeps the original perf
    // win (avoiding ~80 separate draw calls/frame) while actually
    // rendering each food's assigned color (see SIM_FOOD_COLORS in
    // sim.js) instead of a single hardcoded yellow for every item —
    // at most 8 batches (one per color in the palette), still far
    // cheaper than one draw call per item. Lifeline food (rare, capped
    // at 1 on the map) is drawn separately afterward in a distinct pink
    // so it reads as clearly special regardless of its own color field.
    const foodByColor = new Map();
    for (const f of world.food) {
      if (f.isLifeline) continue;
      const sx = f.x - camX, sy = f.y - camY;
      if (sx < -20 || sx > logW + 20 || sy < -20 || sy > logH + 20) continue;
      const color = f.color || '#ffdd00'; // fallback for any food item that somehow lacks a color
      if (!foodByColor.has(color)) foodByColor.set(color, []);
      foodByColor.get(color).push({ sx, sy });
    }
    for (const [color, pts] of foodByColor) {
      ctx.shadowColor = color;
      ctx.shadowBlur = 8;
      ctx.fillStyle = color;
      ctx.beginPath();
      for (const { sx, sy } of pts) {
        ctx.moveTo(sx + 6, sy);
        ctx.arc(sx, sy, 6, 0, Math.PI * 2);
      }
      ctx.fill();
    }
    ctx.shadowBlur = 0;

    ctx.shadowColor = '#ff5f9e';
    ctx.shadowBlur = 16;
    ctx.fillStyle = '#ff5f9e';
    ctx.beginPath();
    for (const f of world.food) {
      if (!f.isLifeline) continue;
      const sx = f.x - camX, sy = f.y - camY;
      if (sx < -20 || sx > logW + 20 || sy < -20 || sy > logH + 20) continue;
      ctx.moveTo(sx + 9, sy);
      ctx.arc(sx, sy, 9, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.shadowBlur = 0;

    this._drawSnakes(ctx, world, camX, camY, logW, logH);

    // World boundary — single-player's "electric fence" border: animated
    // dashes running the full perimeter (so corners naturally connect —
    // it's one continuous dashed path around all 4 edges, not 4
    // independent lines), pulsing brightness, and turning red near the
    // player's own position. Replaces an earlier L-shaped
    // corner-warning-only design that only appeared near corners and
    // looked static/disconnected compared to single-player's always-on
    // animated version.
    this._drawWorldBorder(ctx, camX, camY, logW, logH);
    this._drawWallWarning(ctx, logW, logH);

    // Minimap — small corner overview showing the whole world, every
    // snake's position, and the boundary, so "kaha hu me aur mera dost"
    // is always answerable at a glance without needing to open a
    // separate full map.
    this._drawMinimap(ctx, world, logW, logH);

    // Virtual joystick — drawn last, in plain screen space (no camera
    // transform applied here, unlike single-player's version which draws
    // inside a screen-shake transform), so it stays glued to the finger
    // regardless of anything happening in the world underneath it.
    if (this._joystick.active) this._drawJoystick(ctx);
  },

  _drawJoystick(ctx) {
    const j = this._joystick;
    ctx.save();
    ctx.globalAlpha = 0.45;

    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(j.originX, j.originY, j.maxR, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.arc(j.thumbX, j.thumbY, 18, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = 1;
    ctx.restore();
  },

  // Resolves a skin ID (as sent by the server, originally from another
  // player's Settings.design) into concrete colors this renderer can use.
  // Reuses the exact same SKINS_DEF / DESIGNER_PALETTES data the single-
  // player renderer already has loaded — no separate multiplayer skin
  // data to keep in sync. Falls back to the default skin for any
  // unrecognized/missing ID (e.g. an ID for a skin added in a client
  // version this one predates) rather than crashing.
  _resolveSkin(skinId) {
    const def = (typeof SKINS_DEF !== 'undefined' && SKINS_DEF.find((s) => s.id === skinId)) || null;
    if (!def) return { kind: 'solid', body: '#39ff6a', head: '#7effb2' };

    if (def.kind === 'designer') {
      // Same auto-cycling palette single-player's designer skin uses —
      // reads the shared _designerPaletteIdx so every client viewing a
      // designer-skinned snake sees it cycle in sync.
      const idx = (typeof _designerPaletteIdx !== 'undefined') ? _designerPaletteIdx : 0;
      const pal = (typeof DESIGNER_PALETTES !== 'undefined') ? DESIGNER_PALETTES[idx] : ['#39ff6a', '#7effb2'];
      return { kind: 'palette', palette: pal, head: pal[1] || pal[0] };
    }
    return def; // 'palette' or 'solid' — used as-is, same shape SKINS_DEF already provides
  },

  // The server adds one raw point to a snake's segment array every tick
  // (20/sec) and trims by total trail distance, not by point count — so
  // the raw array holds noticeably more points than single-player's
  // evenly-12px-gapped visual segments, and a fresh point at index 0
  // every tick shifts every other point's array index by one. Coloring
  // directly off that raw index (as an early version of this file did)
  // made multicolour-style skins visibly "crawl" backward down the body
  // every frame instead of staying visually locked to physical position.
  //
  // This resamples the raw points into fixed SEGMENT_GAP-spaced dots by
  // walking cumulative distance from the head, the same visual result
  // single-player's spring-follow segment model produces natively. Each
  // resampled dot's position in the *output* list only depends on how
  // far it is from the head along the body — not on how many raw points
  // the network happened to deliver — so segment 5's color stays segment
  // 5's color regardless of tick timing or connection jitter.
  _resampleSegments(rawSegments, gap) {
    if (rawSegments.length === 0) return [];
    const out = [rawSegments[0]];
    let acc = 0;
    for (let i = 1; i < rawSegments.length; i++) {
      const a = rawSegments[i - 1], b = rawSegments[i];
      acc += Math.hypot(a.x - b.x, a.y - b.y);
      if (acc >= gap) {
        out.push(b);
        acc = 0;
      }
    }
    return out;
  },

  // Snakes — body segments batched into one path per snake (not per
  // segment), head drawn separately afterward so it's always visually
  // on top and distinguishable from the body trail.
  _drawSnakes(ctx, world, camX, camY, logW, logH) {
    for (const s of world.snakes) {
      if (!s.alive && s.id !== this.mySnakeId) continue; // don't render other players' corpses cluttering the view
      const isMe = s.id === this.mySnakeId;
      const skin = this._resolveSkin(s.skin);
      const segs = this._resampleSegments(s.segments, SEGMENT_GAP_VISUAL);

      ctx.globalAlpha = s.alive ? 1 : 0.35;

      if (skin.kind === 'palette') {
        // Palette skins cycle color by resampled-segment index — stable
        // per physical body position now (see _resampleSegments), not
        // the raw network-point index. Grouped by color bucket so each
        // color still only costs one beginPath()/fill() rather than one
        // per segment.
        const pal = skin.palette;
        for (let c = 0; c < pal.length; c++) {
          ctx.beginPath();
          let any = false;
          for (let i = segs.length - 1; i >= 1; i--) {
            if (i % pal.length !== c) continue;
            const seg = segs[i];
            const sx = seg.x - camX, sy = seg.y - camY;
            if (sx < -20 || sx > logW + 20 || sy < -20 || sy > logH + 20) continue;
            ctx.moveTo(sx + 10, sy);
            ctx.arc(sx, sy, 10, 0, Math.PI * 2);
            any = true;
          }
          if (any) { ctx.fillStyle = pal[c]; ctx.fill(); }
        }
      } else {
        // Solid skins (fatty/thin/fallback) — one flat body color, same
        // single beginPath()/fill() batching as before.
        ctx.beginPath();
        for (let i = segs.length - 1; i >= 1; i--) {
          const seg = segs[i];
          const sx = seg.x - camX, sy = seg.y - camY;
          if (sx < -20 || sx > logW + 20 || sy < -20 || sy > logH + 20) continue;
          ctx.moveTo(sx + 10, sy);
          ctx.arc(sx, sy, 10, 0, Math.PI * 2);
        }
        ctx.fillStyle = skin.body;
        ctx.fill();
      }

      // Head — bigger than body segments plus a glow and simple eye, so
      // it's immediately clear which end is the front at a glance,
      // matching how single-player's snakes always distinguish the head.
      // AI snakes get a slightly dimmer glow than real players so a
      // glance at the world can tell "friend" from "wandering AI" by
      // brightness as well as by color palette.
      const head = s.segments[0];
      if (head) {
        const headColor = skin.head || s.color;
        const hx = head.x - camX, hy = head.y - camY;
        ctx.save();
        ctx.shadowColor = headColor;
        ctx.shadowBlur = isMe ? 22 : (s.isAI ? 10 : 14);
        ctx.beginPath();
        ctx.arc(hx, hy, 13, 0, Math.PI * 2);
        ctx.fillStyle = headColor;
        ctx.fill();
        ctx.restore();

        ctx.beginPath();
        ctx.arc(hx, hy, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(10,10,10,0.9)';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(hx, hy, 1.8, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();

        // Name label above the head — AI snakes get a 🤖 prefix so
        // they're unambiguous even before noticing the color difference.
        const label = isMe ? 'You' : (s.isAI ? `🤖 ${s.name}` : s.name);
        ctx.font = '600 12px Segoe UI, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = s.isAI ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.85)';
        ctx.fillText(label, hx, hy - 24);
      }
      ctx.globalAlpha = 1;
    }
  },

  // Tiled dot-grid, drawn once per frame as a single fillRect-per-row
  // sweep rather than per-dot draw calls. Offset by the camera position
  // (mod the grid spacing) so it reads as part of the moving world
  // instead of a static screen-space overlay.
  _drawBackgroundGrid(ctx, logW, logH, camX, camY) {
    const spacing = 46;
    const offX = -(((camX % spacing) + spacing) % spacing);
    const offY = -(((camY % spacing) + spacing) % spacing);
    ctx.fillStyle = 'rgba(126,255,178,0.06)';
    for (let y = offY; y < logH + spacing; y += spacing) {
      for (let x = offX; x < logW + spacing; x += spacing) {
        ctx.fillRect(x, y, 1.5, 1.5);
      }
    }
  },

  // Draws the world's actual edge as a visible wall wherever it's near
  // the current viewport — a soft red glow gradient a couple hundred
  // units before the true edge, then a solid line exactly at the edge.
  // Only pays any drawing cost when an edge is actually close enough to
  // matter (early-outs per edge otherwise), so this is free for the vast
  // majority of a match spent away from the boundary.
  /* ANIMATED ELECTRIC FENCE BORDER — ported from single-player's
     _drawWorldBorder exactly (game_part4.js), just substituting
     MP_WORLD_W/H for single-player's world size and reading the local
     player's position from the predicted-self head instead of
     this.player.head. One continuous dashed path is distributed around
     the FULL perimeter (all 4 edges combined, not 4 independent lines),
     which is what makes corners connect naturally — the earlier
     L-shape-warning design drew each edge as its own separate strip and
     never looked "attached" at the corners the way this does.

     Perf notes (same as single-player):
     - Only draws dashes near the camera viewport, not all 200 every frame.
     - shadowBlur applied ONCE per frame instead of per-dash. */
  _drawWorldBorder(ctx, camX, camY, logW, logH) {
    const W = MP_WORLD_W, H = MP_WORLD_H;
    const x = -camX, y = -camY;
    const now = Date.now();

    let isRed = false;
    if (this._predictedSelf) {
      const hx = this._predictedSelf.x, hy = this._predictedSelf.y;
      isRed = Math.min(hx, W - hx, hy, H - hy) < 200;
    }

    const brightness = 0.5 + 0.5 * Math.sin(now * 0.005);
    const flash = 0.5 + 0.5 * Math.sin(now * 0.008);

    ctx.save();
    if (isRed) {
      ctx.strokeStyle = `rgba(255,${Math.round(50 * flash)},${Math.round(50 * flash)},${(0.5 + brightness * 0.5).toFixed(2)})`;
      ctx.shadowColor = 'rgba(255,50,50,0.8)';
    } else {
      ctx.strokeStyle = `rgba(126,255,178,${(0.2 + brightness * 0.6).toFixed(2)})`;
      ctx.shadowColor = '#7effb2';
    }
    ctx.shadowBlur = 10 + brightness * 6;
    ctx.lineWidth = 2 + brightness;

    const DASH_COUNT = 200;
    const PERIMETER = W * 2 + H * 2;
    const dashLen = 8;
    const margin = 40;

    const edges = [
      { x1: 0, y1: 0, x2: W, y2: 0 },
      { x1: W, y1: 0, x2: W, y2: H },
      { x1: W, y1: H, x2: 0, y2: H },
      { x1: 0, y1: H, x2: 0, y2: 0 },
    ];

    ctx.beginPath();
    for (const edge of edges) {
      const len = Math.sqrt((edge.x2 - edge.x1) ** 2 + (edge.y2 - edge.y1) ** 2);
      const dashCount = Math.round(DASH_COUNT * (len / PERIMETER));
      const nx = (edge.x2 - edge.x1) / len;
      const ny = (edge.y2 - edge.y1) / len;

      for (let i = 0; i < dashCount; i++) {
        const t = i / dashCount;
        const px = edge.x1 + nx * len * t;
        const py = edge.y1 + ny * len * t;
        const sx = x + px, sy = y + py;

        if (sx < -margin || sx > logW + margin || sy < -margin || sy > logH + margin) continue;

        ctx.moveTo(sx - nx * dashLen / 2, sy - ny * dashLen / 2);
        ctx.lineTo(sx + nx * dashLen / 2, sy + ny * dashLen / 2);
      }
    }
    ctx.stroke();

    ctx.restore();
  },

  // Full-screen red vignette when close to any edge — ported from
  // single-player's _drawWallWarning exactly, reading position from the
  // predicted-self head instead of this.player.head.
  _drawWallWarning(ctx, logW, logH) {
    if (!this._predictedSelf) return;
    const W = MP_WORLD_W, H = MP_WORLD_H;
    const hx = this._predictedSelf.x, hy = this._predictedSelf.y;
    const nearest = Math.min(hx, W - hx, hy, H - hy);
    const dangerZoneDist = 200; // matches single-player's DANGER_ZONE_DIST
    if (nearest >= dangerZoneDist) return;

    const intensity = (1 - nearest / dangerZoneDist) * 0.5;
    const grad = ctx.createRadialGradient(
      logW / 2, logH / 2, logH * 0.3,
      logW / 2, logH / 2, logH * 0.8
    );
    grad.addColorStop(0, 'rgba(255,40,40,0)');
    grad.addColorStop(1, `rgba(255,40,40,${intensity.toFixed(2)})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, logW, logH);
  },

  // Shared geometry for the minimap rect — used both for drawing it and
  // for hit-testing taps on it (see _isPointOnMinimap), same pattern as
  // single-player's _getMinimapRect so the tappable area always exactly
  // matches what's drawn.
  _getMinimapRect(logW, logH) {
    const isNarrow = logW < 480;
    const w = isNarrow ? 100 : 140;
    const h = isNarrow ? 100 : 140;
    const pad = isNarrow ? 8 : 14;
    const x = logW - w - pad;
    const y = (isNarrow ? 95 : 70) + pad; // clear of the HUD pill row
    return { x, y, w, h };
  },

  _isPointOnMinimap(clientX, clientY) {
    if (!this.inMatch) return false;
    const logW = window.innerWidth, logH = window.innerHeight;
    const rect = this._getMinimapRect(logW, logH);
    return clientX >= rect.x && clientX <= rect.x + rect.w &&
           clientY >= rect.y && clientY <= rect.y + rect.h;
  },

  // Opens the shared #fullmap-overlay (the same element single-player
  // uses — see index.html's window._openFullMap). That global function
  // already handles showing the overlay and starting a redraw loop; it
  // calls whichever of window._game._drawFullMap / MP._drawFullMap
  // exists depending on which mode is actually running, so this just
  // has to make sure MP._drawFullMap exists (see below) and call it.
  _openFullMap() {
    if (!this.inMatch) return;
    if (typeof window._openFullMap === 'function') window._openFullMap();
  },

  // Small always-visible corner minimap — shows the whole 4000x4000
  // world, every snake's position (color-coded, AI dimmer than
  // players), and the current viewport rectangle, directly answering
  // "where am I / where's my friend / how close is the edge" at a
  // glance without leaving gameplay.
  _drawMinimap(ctx, world, logW, logH) {
    const { x: mx, y: my, w: mw, h: mh } = this._getMinimapRect(logW, logH);
    const scaleX = mw / MP_WORLD_W, scaleY = mh / MP_WORLD_H;

    ctx.save();
    ctx.fillStyle = 'rgba(5,10,15,0.75)';
    ctx.strokeStyle = 'rgba(126,255,178,0.4)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(mx, my, mw, mh, 10) : ctx.rect(mx, my, mw, mh);
    ctx.fill();
    ctx.stroke();

    ctx.save();
    ctx.beginPath();
    ctx.rect(mx, my, mw, mh);
    ctx.clip();

    // Food — tiny dots, way too small individually to render per-type
    // detail at this zoom, same simplification single-player's minimap
    // already makes.
    ctx.fillStyle = 'rgba(255,221,0,0.5)';
    for (const f of world.food) {
      ctx.fillRect(mx + f.x * scaleX - 0.5, my + f.y * scaleY - 0.5, 1, 1);
    }

    // Snakes
    for (const s of world.snakes) {
      if (!s.alive) continue;
      const head = s.segments[0];
      if (!head) continue;
      const dotX = mx + head.x * scaleX, dotY = my + head.y * scaleY;
      const isMe = s.id === this.mySnakeId;
      ctx.beginPath();
      ctx.arc(dotX, dotY, isMe ? 4 : (s.isAI ? 2 : 3), 0, Math.PI * 2);
      ctx.fillStyle = s.isAI ? 'rgba(255,255,255,0.35)' : s.color;
      ctx.fill();
      if (isMe) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    // Current viewport rectangle
    const mine = world.snakes.find((s) => s.id === this.mySnakeId);
    if (mine) {
      ctx.strokeStyle = 'rgba(255,255,255,0.3)';
      ctx.lineWidth = 1;
      ctx.strokeRect(
        mx + this._camX * scaleX, my + this._camY * scaleY,
        logW * scaleX, logH * scaleY
      );
    }

    ctx.restore(); // clip
    ctx.restore();
  },

  // Fullscreen map — opened by tapping the small in-game minimap (see
  // _openFullMap). Draws onto the SAME #fullmap-canvas single-player's
  // _drawFullMap uses; index.html's shared redraw loop calls whichever
  // of window._game._drawFullMap / MP._drawFullMap applies. Adapted from
  // single-player's version to multiplayer's flat snake/segment data
  // (no Snake/AISnake class instances, no this.player/this.snakes) and
  // to read species/radiusMul/isBoss straight off the broadcast state
  // instead of single-player's getSegmentR() helper.
  _drawFullMap() {
    if (!this.inMatch) return;
    const canvas = document.getElementById('fullmap-canvas');
    if (!canvas) return;

    const dpr = this._dpr || 1;
    const cssW = canvas.clientWidth || 300;
    const cssH = canvas.clientHeight || 300;
    const physW = Math.round(cssW * dpr), physH = Math.round(cssH * dpr);
    if (canvas.width !== physW || canvas.height !== physH) {
      canvas.width = physW;
      canvas.height = physH;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const world = this._getInterpolatedWorld();
    // Splice in the locally-predicted self, same as the main render loop
    // does, so the player's own snake doesn't visibly lag the rest of
    // the map by RENDER_DELAY_MS.
    if (this._predictedSelf) {
      const idx = world.snakes.findIndex((s) => s.id === this.mySnakeId);
      const predictedAsSnake = { ...(idx >= 0 ? world.snakes[idx] : {}), id: this.mySnakeId, segments: this._predictedSelf.segments };
      if (idx >= 0) world.snakes[idx] = predictedAsSnake; else world.snakes.push(predictedAsSnake);
    }

    const W = MP_WORLD_W, H = MP_WORLD_H;
    const scale = Math.min(cssW / W, cssH / H);
    const offX = (cssW - W * scale) / 2;
    const offY = (cssH - H * scale) / 2;
    const toX = (wx) => offX + wx * scale;
    const toY = (wy) => offY + wy * scale;

    ctx.fillStyle = '#050a0f';
    ctx.fillRect(offX, offY, W * scale, H * scale);
    ctx.strokeStyle = 'rgba(126,255,178,0.3)';
    ctx.lineWidth = 2;
    ctx.strokeRect(offX, offY, W * scale, H * scale);

    ctx.fillStyle = 'rgba(126,255,178,0.35)';
    for (const f of world.food) {
      ctx.fillRect(toX(f.x) - 0.75, toY(f.y) - 0.75, 1.5, 1.5);
    }

    const rows = [];
    const SAMPLE_STEP = 3;
    const drawSnakeShape = (segs, color, lineWidth) => {
      if (!segs || segs.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(toX(segs[0].x), toY(segs[0].y));
      for (let i = SAMPLE_STEP; i < segs.length; i += SAMPLE_STEP) {
        ctx.lineTo(toX(segs[i].x), toY(segs[i].y));
      }
      const last = segs[segs.length - 1];
      ctx.lineTo(toX(last.x), toY(last.y));
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
    };

    for (const s of world.snakes) {
      if (!s.alive) continue;
      const isMe = s.id === this.mySnakeId;

      let color;
      if (s.isBoss) {
        const pulse = 0.5 + 0.5 * Math.sin(Date.now() * 0.006);
        color = `rgba(255,${Math.round(60 + pulse * 100)},20,1)`;
      } else if (isMe) {
        color = '#39ff6a';
      } else {
        color = s.color;
      }

      // Body thickness from the broadcast radiusMul (species size),
      // scaled by the map's zoom — matches single-player's use of
      // getSegmentR() for the same purpose, just reading the multiplier
      // straight off network state instead of a shared helper function.
      const worldRadius = SIM_SEGMENT_R_APPROX * (s.radiusMul || 1) * (s.isBoss ? 1.35 : 1);
      const bodyWidth = Math.max(isMe ? 3 : 2.5, worldRadius * 2 * scale);
      drawSnakeShape(s.segments, color, bodyWidth);

      const head = s.segments[0];
      const hx = toX(head.x), hy = toY(head.y);
      ctx.beginPath();
      if (isMe) { ctx.shadowColor = '#7effb2'; ctx.shadowBlur = 8; }
      ctx.arc(hx, hy, Math.max(isMe ? 3 : 2.5, bodyWidth * (isMe ? 0.8 : 0.7)), 0, Math.PI * 2);
      ctx.fillStyle = isMe ? '#7effb2' : color;
      ctx.fill();
      ctx.shadowBlur = 0;

      const label = s.isBoss ? '👑 ' + s.name : (isMe ? `${s.name || 'You'} (You)` : s.name);
      rows.push({
        name: label, length: s.length,
        color: s.isBoss ? '#ff3c14' : (isMe ? '#7effb2' : s.color),
        x: Math.round(head.x), y: Math.round(head.y),
        isBoss: !!s.isBoss, isPlayer: isMe,
      });

      if (isMe) {
        // Current viewport, same as single-player's full-map "you are
        // here" rectangle.
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 1.5;
        const vw = (window.innerWidth || 400) * scale;
        const vh = (window.innerHeight || 800) * scale;
        ctx.strokeRect(toX(this._camX), toY(this._camY), vw, vh);
      }
    }

    const playerRow = rows.find((r) => r.isPlayer);
    const others = rows.filter((r) => !r.isPlayer).sort((a, b) => b.length - a.length);
    const sortedRows = playerRow ? [playerRow, ...others] : others;

    this._renderFullMapList(sortedRows);
  },

  // Rebuilds the shared #fullmap-list DOM — same list element
  // single-player's _renderFullMapList targets, just fed multiplayer's
  // row data instead.
  _renderFullMapList(rows) {
    const list = document.getElementById('fullmap-list');
    if (!list) return;
    list.innerHTML = rows.map((r) => `
      <div class="fullmap-row${r.isPlayer ? ' fullmap-row-you' : ''}${r.isBoss ? ' fullmap-row-boss' : ''}">
        <span class="fullmap-row-dot" style="background:${r.color}"></span>
        <span class="fullmap-row-name">${r.name}</span>
        <span class="fullmap-row-len">${r.length}</span>
      </div>
    `).join('');
  },
};

document.addEventListener('DOMContentLoaded', () => MP.init());
