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

const MP = {
  ws: null,
  roomCode: null,
  playerId: null,
  mySnakeId: null,
  serverUrl: '',
  connected: false,
  inMatch: false,

  // Snapshot buffer for interpolation. The server broadcasts at 20
  // ticks/sec (every 50ms), but the screen renders at 60fps — without
  // interpolation, every snake would visibly "jump" between positions
  // instead of gliding, which reads as lag even though the network
  // itself is fine. We keep the two most recent snapshots and blend
  // between them based on elapsed time, the same technique any
  // real-time multiplayer game uses for this exact problem.
  _prevSnapshot: null,   // { snakes, food, t } — older snapshot
  _curSnapshot: null,    // { snakes, food, t } — newest snapshot
  _serverTickMs: 50,     // matches TICK_MS on the server (20 ticks/sec)

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
      hudLength: document.getElementById('mp-hud-length'),
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
        break;

      case 'state':
        // Shift the buffer: what was "current" becomes "previous", and
        // this new message becomes "current". Rendering blends between
        // the two using elapsed wall-clock time (see _getInterpolatedWorld).
        this._prevSnapshot = this._curSnapshot;
        this._curSnapshot = { snakes: msg.snakes, food: msg.food, t: performance.now() };
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
        break;

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
    if (mine) {
      this.el.hudLength.textContent = `Length: ${mine.length}`;
      if (!mine.alive) this._showMatchStatus('💀 You died — watching the match');
      else this._showMatchStatus('');
    }
  },

  // Blends between _prevSnapshot and _curSnapshot based on how much wall-
  // clock time has passed since _curSnapshot arrived, relative to the
  // server's own tick interval. This is what turns 20 discrete
  // server updates/sec into smooth 60fps motion on screen instead of
  // visible steps every ~50ms.
  _getInterpolatedWorld() {
    const cur = this._curSnapshot;
    if (!cur) return { snakes: [], food: [] };
    const prev = this._prevSnapshot;
    if (!prev) return cur; // first snapshot ever — nothing to blend from yet

    const elapsed = performance.now() - cur.t;
    // Clamp slightly past 1.0 (not just to 1.0) so brief network hiccups
    // don't cause a visible stall right as the next snapshot is due —
    // the snake keeps extrapolating its last known heading a little
    // rather than freezing dead still.
    const t = Math.min(1.3, elapsed / this._serverTickMs);

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
    if (!this.inMatch || !this._curSnapshot) return;
    const mine = this._curSnapshot.snakes.find((s) => s.id === this.mySnakeId);
    if (!mine || !mine.alive) return;

    // Steer toward the pointer relative to the snake's own head position
    // on screen (head is always drawn at screen-center, see _renderLoop),
    // same "move toward where you're touching" feel as single-player.
    const cx = this.el.canvas.width / this._dpr / 2;
    const cy = this.el.canvas.height / this._dpr / 2;
    const dx = this._pointer.x - cx;
    const dy = this._pointer.y - cy;
    const len = Math.hypot(dx, dy);
    if (len < 5) return; // dead zone near center, avoids jitter when finger lifts near middle

    this._send({ type: 'input', dirX: dx / len, dirY: dy / len, boosting: this._boosting });
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

    // Interpolated snapshot — this is the single fix that removes most
    // of the perceived "lag": without it, positions only update every
    // ~50ms (the server's tick rate) and every snake visibly steps
    // between spots instead of gliding, even though the network itself
    // is working fine.
    const world = this._getInterpolatedWorld();

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
    // even drawn.
    ctx.shadowColor = '#ffdd00';
    ctx.shadowBlur = 8;
    ctx.fillStyle = '#ffdd00';
    ctx.beginPath();
    for (const f of world.food) {
      const sx = f.x - camX, sy = f.y - camY;
      if (sx < -20 || sx > logW + 20 || sy < -20 || sy > logH + 20) continue;
      ctx.moveTo(sx + 6, sy);
      ctx.arc(sx, sy, 6, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.shadowBlur = 0;

    this._drawSnakes(ctx, world, camX, camY, logW, logH);
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

  // Snakes — body segments batched into one path per snake (not per
  // segment), head drawn separately afterward so it's always visually
  // on top and distinguishable from the body trail.
  _drawSnakes(ctx, world, camX, camY, logW, logH) {
    for (const s of world.snakes) {
      if (!s.alive && s.id !== this.mySnakeId) continue; // don't render other players' corpses cluttering the view
      const isMe = s.id === this.mySnakeId;
      const skin = this._resolveSkin(s.skin);

      ctx.globalAlpha = s.alive ? 1 : 0.35;

      if (skin.kind === 'palette') {
        // Palette skins cycle color by segment index — same visual
        // approach as single-player's multicolour/crimson/toxic/royal/
        // gilded skins. Grouped by color bucket so each color still only
        // costs one beginPath()/fill() rather than one per segment.
        const pal = skin.palette;
        for (let c = 0; c < pal.length; c++) {
          ctx.beginPath();
          let any = false;
          for (let i = s.segments.length - 1; i >= 1; i--) {
            if (i % pal.length !== c) continue;
            const seg = s.segments[i];
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
        for (let i = s.segments.length - 1; i >= 1; i--) {
          const seg = s.segments[i];
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
};

document.addEventListener('DOMContentLoaded', () => MP.init());
