/* ═══════════════════════════════════════════════════════════════
   MULTIPLAYER CLIENT (Phase 2 networking + Phase 3 render polish)

   Fully independent of the single-player Game class in game_part1-5.js.
   This file owns:
     - The WebSocket connection to the Phase-1 server (server.js)
     - The lobby UI (#mp-overlay: create/join/waiting-room screens)
     - The in-match renderer (#mp-canvas) and HUD (#mp-hud)
     - Touch/mouse steering input, sent to the server every frame

   Phase 3 additions: client-side interpolation between server snapshots
   (the server only broadcasts at 20 ticks/sec, so without this every
   snake visibly steps instead of gliding — see _getInterpolatedWorld),
   and batched rendering (one beginPath()/fill() per snake/food group
   instead of one per segment/item, which was the other real cost behind
   the reported lag).

   Visuals are still intentionally simpler than single-player (no AI,
   power-ups, or skins) because the server doesn't simulate those yet
   either — that's Phase 4, once this pass proves out smoothly.

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

// ── Local prediction constants — must exactly mirror server.js so the
// predicted snake moves identically to how the server will simulate it.
// If these ever drift out of sync with server.js, prediction error will
// grow every tick instead of staying near-zero, and RECONCILE_LERP will
// end up doing more visible correction work than it should.
const PRED_BASE_SPEED = 140;          // world units/sec — matches BASE_SPEED
const PRED_BOOST_SPEED = 260;         // world units/sec — matches BOOST_SPEED
const PRED_TURN_RATE_PER_TICK = 0.18; // matches server's per-tick turn lerp factor
const PRED_SERVER_TICK_S = 0.05;      // 20 ticks/sec — the tick length PRED_TURN_RATE_PER_TICK was tuned for
const PRED_SEGMENT_GAP = 12;          // matches SEGMENT_GAP
const PRED_EDGE_MARGIN = 10;          // matches SEGMENT_R, used for the same edge clamp the server applies

// How much of the predicted/server position gap gets closed per frame
// once a fresh snapshot arrives. A fraction (not an instant snap) so
// small, constant prediction drift (float rounding, tiny timing
// differences) corrects itself smoothly instead of visibly popping.
const RECONCILE_LERP = 0.25;
// Beyond this distance the gap is treated as a "real" desync (death,
// respawn, a missed collision, a long stall) rather than normal drift —
// snap instantly instead of lerping, since lerping a huge gap would just
// look like sliding/teleporting in slow motion.
const RECONCILE_SNAP_DIST = 220;

const MP = {
  ws: null,
  roomCode: null,
  playerId: null,
  mySnakeId: null,
  serverUrl: '',
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
      serverInput: document.getElementById('mp-server-url'),

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

    // Default server URL — pre-filled so most players never need to
    // touch it, but editable for anyone self-hosting a different server.
    this.serverUrl = SafeStorage.getItem('snakeRush_mpServerUrl') || 'wss://snakerushserver.onrender.com';
    this.el.serverInput.value = this.serverUrl;

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

    el.serverInput.addEventListener('change', () => {
      this.serverUrl = el.serverInput.value.trim();
      SafeStorage.setItem('snakeRush_mpServerUrl', this.serverUrl);
    });

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
    this.serverUrl = this.el.serverInput.value.trim() || this.serverUrl;
    SafeStorage.setItem('snakeRush_mpServerUrl', this.serverUrl);
    this._showStatus('Connecting to server… this can take up to a minute if it was asleep.');
    this._connect(() => {
      this._send({ type: 'create_room', name: getPlayerName(), skin: Settings.design });
    });
  },

  _joinRoom() {
    const code = this.el.codeInput.value.trim();
    if (code.length < 4) {
      this._showStatus('Enter the full room code your friend shared.', true);
      return;
    }
    this.serverUrl = this.el.serverInput.value.trim() || this.serverUrl;
    SafeStorage.setItem('snakeRush_mpServerUrl', this.serverUrl);
    this._showStatus('Connecting to server… this can take up to a minute if it was asleep.');
    this._connect(() => {
      this._send({ type: 'join_room', roomCode: code, name: getPlayerName(), skin: Settings.design });
    });
  },

  _connect(onOpen) {
    this._disconnect(); // ensure no stale socket lingers

    let url = this.serverUrl;
    if (!/^wss?:\/\//.test(url)) url = 'wss://' + url.replace(/^https?:\/\//, '');
    url = url.replace(/\/$/, '');

    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this._showStatus('Invalid server address.', true);
      return;
    }
    this.ws = ws;

    // Render.com free tier can take 30-60s to wake from sleep — this
    // timeout turns an otherwise-silent long wait into a clear message
    // instead of the lobby looking frozen/broken.
    const wakeTimer = setTimeout(() => {
      if (!this.connected) {
        this._showStatus('Still waking up the server (free hosting sleeps when idle) — hang tight…');
      }
    }, 6000);

    ws.addEventListener('open', () => {
      clearTimeout(wakeTimer);
      this.connected = true;
      onOpen();
    });

    ws.addEventListener('message', (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      this._handleMessage(msg);
    });

    ws.addEventListener('close', () => {
      clearTimeout(wakeTimer);
      this.connected = false;
      if (this.inMatch) {
        this._showMatchStatus('Disconnected from server.');
      }
    });

    ws.addEventListener('error', () => {
      clearTimeout(wakeTimer);
      this._showStatus("Couldn't reach the server. Check the URL in Server Settings.", true);
    });
  },

  _disconnect() {
    if (this.ws) {
      try { this.ws.close(); } catch (_) {}
      this.ws = null;
    }
    this.connected = false;
  },

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
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
        // catch up to it. See RECONCILE_LERP / RECONCILE_SNAP_DIST.
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

    this.el.hudLength.textContent = `Length: ${mine.length}`;
    this.el.hudScore.textContent = `Score: ${mine.score || 0}`;

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
  _seedPredictedSelf(snake) {
    this._predictedSelf = {
      x: snake.segments[0].x,
      y: snake.segments[0].y,
      dirX: 1, dirY: 0,
      inputDirX: 1, inputDirY: 0,
      boosting: false,
      length: snake.length,
      segments: snake.segments.map((s) => ({ x: s.x, y: s.y })),
    };
    this._lastPredictTime = performance.now();
  },

  // Advances the predicted snake by dt seconds using the exact same
  // formula server.js runs — smooth turn-toward-input, speed based on
  // boost state, then rebuild the segment trail from the new head
  // position. Called once per render frame (variable dt), unlike the
  // server which runs this at a fixed 50ms tick — the two will never be
  // pixel-identical, which is exactly what _reconcileSelf exists to fix.
  _advancePrediction(dt) {
    const p = this._predictedSelf;
    if (!p || dt <= 0) return;

    // Scale the per-tick turn-rate constant to whatever dt this frame
    // actually is, so steering feels the same regardless of frame rate
    // instead of turning faster on high-refresh screens.
    const turnRate = 1 - Math.pow(1 - PRED_TURN_RATE_PER_TICK, dt / PRED_SERVER_TICK_S);
    p.dirX += (p.inputDirX - p.dirX) * turnRate;
    p.dirY += (p.inputDirY - p.dirY) * turnRate;
    const dl = Math.hypot(p.dirX, p.dirY) || 1;
    p.dirX /= dl; p.dirY /= dl;

    const speed = (p.boosting && p.length > 6) ? PRED_BOOST_SPEED : PRED_BASE_SPEED;
    p.x = Math.min(Math.max(p.x + p.dirX * speed * dt, PRED_EDGE_MARGIN), MP_WORLD_W - PRED_EDGE_MARGIN);
    p.y = Math.min(Math.max(p.y + p.dirY * speed * dt, PRED_EDGE_MARGIN), MP_WORLD_H - PRED_EDGE_MARGIN);

    p.segments.unshift({ x: p.x, y: p.y });
    const maxSegs = Math.max(1, Math.round(p.length));
    const desiredTrailLen = maxSegs * PRED_SEGMENT_GAP;
    let acc = 0, trimAt = p.segments.length;
    for (let i = 1; i < p.segments.length; i++) {
      const a = p.segments[i - 1], b = p.segments[i];
      acc += Math.hypot(a.x - b.x, a.y - b.y);
      if (acc >= desiredTrailLen) { trimAt = i + 1; break; }
    }
    if (p.segments.length > trimAt) p.segments.length = trimAt;
  },

  // Pulls the predicted snake toward where the server says it actually
  // is. Small gaps (normal float/timing drift) close gradually over a
  // few frames via RECONCILE_LERP so the correction is invisible; large
  // gaps (death/respawn/a missed event) snap immediately since there's
  // no "real" position to smoothly slide from.
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

    const authHead = authSnake.segments[0];
    const gap = Math.hypot(authHead.x - p.x, authHead.y - p.y);

    if (gap > RECONCILE_SNAP_DIST) {
      this._seedPredictedSelf(authSnake);
      return;
    }
    if (gap < 0.5) return; // close enough, avoid doing pointless tiny corrections every tick

    p.x += (authHead.x - p.x) * RECONCILE_LERP;
    p.y += (authHead.y - p.y) * RECONCILE_LERP;
    // Nudge the trailing segments toward the server's shape too (same
    // lerp fraction), so the body doesn't visibly kink at the head while
    // the tail stays on the old predicted path.
    const segCount = Math.min(p.segments.length, authSnake.segments.length);
    for (let i = 0; i < segCount; i++) {
      p.segments[i].x += (authSnake.segments[i].x - p.segments[i].x) * RECONCILE_LERP;
      p.segments[i].y += (authSnake.segments[i].y - p.segments[i].y) * RECONCILE_LERP;
    }
  },

  // ── Input ────────────────────────────────────────────────────
  _setupInput() {
    const canvas = this.el.canvas;

    const setPointerFromEvent = (clientX, clientY) => {
      this._pointer.x = clientX;
      this._pointer.y = clientY;
    };

    canvas.addEventListener('mousemove', (e) => setPointerFromEvent(e.clientX, e.clientY));
    canvas.addEventListener('mousedown', () => { this._boosting = true; });
    window.addEventListener('mouseup', () => { this._boosting = false; });

    canvas.addEventListener('touchstart', (e) => {
      if (!this.inMatch) return;
      e.preventDefault();
      const t = e.touches[0];
      setPointerFromEvent(t.clientX, t.clientY);
      this._boosting = true;
    }, { passive: false });
    canvas.addEventListener('touchmove', (e) => {
      if (!this.inMatch) return;
      e.preventDefault();
      const t = e.touches[0];
      setPointerFromEvent(t.clientX, t.clientY);
    }, { passive: false });
    canvas.addEventListener('touchend', () => { this._boosting = false; });

    this.el.hudBoost.addEventListener('mousedown', () => { this._boosting = true; });
    this.el.hudBoost.addEventListener('mouseup', () => { this._boosting = false; });
    this.el.hudBoost.addEventListener('touchstart', (e) => { e.preventDefault(); this._boosting = true; }, { passive: false });
    this.el.hudBoost.addEventListener('touchend', () => { this._boosting = false; });
  },

  _sendInput() {
    if (!this.inMatch) return;

    // Steer toward the pointer relative to the snake's own head position
    // on screen (head is always drawn at screen-center, see _renderLoop),
    // same "move toward where you're touching" feel as single-player.
    const cx = this.el.canvas.width / this._dpr / 2;
    const cy = this.el.canvas.height / this._dpr / 2;
    const dx = this._pointer.x - cx;
    const dy = this._pointer.y - cy;
    const len = Math.hypot(dx, dy);
    if (len < 5) return; // dead zone near center, avoids jitter when finger lifts near middle

    const dirX = dx / len, dirY = dy / len;

    // Apply to the local prediction immediately — this is the actual fix
    // for input lag. Previously this function only sent the input to the
    // server and waited for it to come back in a snapshot; now the
    // player's own snake starts turning the same frame they steer.
    if (this._predictedSelf) {
      this._predictedSelf.inputDirX = dirX;
      this._predictedSelf.inputDirY = dirY;
      this._predictedSelf.boosting = this._boosting;
    }

    this._send({ type: 'input', dirX, dirY, boosting: this._boosting });
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
      this._advancePrediction(dt);
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

    // Food — single beginPath()/fill() for the whole batch instead of
    // one per food item. This was the main render-cost issue: with ~80
    // food items each doing their own beginPath+arc+fill, that's 80
    // separate draw calls every frame just for food, before snakes are
    // even drawn. Lifeline food (rare, capped at 1 on the map) is drawn
    // separately in a distinct pink so it reads as clearly special —
    // still just one extra beginPath()/fill() pair even when present.
    ctx.shadowColor = '#ffdd00';
    ctx.shadowBlur = 8;
    ctx.fillStyle = '#ffdd00';
    ctx.beginPath();
    for (const f of world.food) {
      if (f.isLifeline) continue;
      const sx = f.x - camX, sy = f.y - camY;
      if (sx < -20 || sx > logW + 20 || sy < -20 || sy > logH + 20) continue;
      ctx.moveTo(sx + 6, sy);
      ctx.arc(sx, sy, 6, 0, Math.PI * 2);
    }
    ctx.fill();
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

    // World boundary — draws the actual edge of the 4000x4000 world as a
    // visible wall whenever it's anywhere near the viewport, so hitting
    // it never comes as a surprise. This directly addresses "boundary
    // pata nahi chalti" — previously there was no indication at all that
    // an edge existed until the snake's movement got clamped there.
    this._drawWorldBoundary(ctx, camX, camY, logW, logH);

    // Minimap — small corner overview showing the whole world, every
    // snake's position, and the boundary, so "kaha hu me aur mera dost"
    // is always answerable at a glance without needing to open a
    // separate full map.
    this._drawMinimap(ctx, world, logW, logH);
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
  _drawWorldBoundary(ctx, camX, camY, logW, logH) {
    const warnDist = 260; // start showing the warning glow this far from the true edge, in world units

    const edges = [
      { side: 'left',   worldPos: 0,          near: camX < warnDist },
      { side: 'right',  worldPos: MP_WORLD_W, near: camX + logW > MP_WORLD_W - warnDist },
      { side: 'top',    worldPos: 0,          near: camY < warnDist },
      { side: 'bottom', worldPos: MP_WORLD_H, near: camY + logH > MP_WORLD_H - warnDist },
    ];

    for (const edge of edges) {
      if (!edge.near) continue;
      ctx.save();
      if (edge.side === 'left' || edge.side === 'right') {
        const screenX = edge.worldPos - camX;
        const grad = ctx.createLinearGradient(
          screenX + (edge.side === 'left' ? warnDist : -warnDist), 0,
          screenX, 0
        );
        grad.addColorStop(0, 'rgba(255,60,60,0)');
        grad.addColorStop(1, 'rgba(255,60,60,0.28)');
        ctx.fillStyle = grad;
        const rectX = edge.side === 'left' ? screenX : screenX - warnDist;
        ctx.fillRect(rectX, 0, warnDist, logH);
        ctx.strokeStyle = 'rgba(255,80,80,0.9)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(screenX, 0);
        ctx.lineTo(screenX, logH);
        ctx.stroke();
      } else {
        const screenY = edge.worldPos - camY;
        const grad = ctx.createLinearGradient(
          0, screenY + (edge.side === 'top' ? warnDist : -warnDist),
          0, screenY
        );
        grad.addColorStop(0, 'rgba(255,60,60,0)');
        grad.addColorStop(1, 'rgba(255,60,60,0.28)');
        ctx.fillStyle = grad;
        const rectY = edge.side === 'top' ? screenY : screenY - warnDist;
        ctx.fillRect(0, rectY, logW, warnDist);
        ctx.strokeStyle = 'rgba(255,80,80,0.9)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(0, screenY);
        ctx.lineTo(logW, screenY);
        ctx.stroke();
      }
      ctx.restore();
    }
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
};

document.addEventListener('DOMContentLoaded', () => MP.init());
