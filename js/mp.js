/* ═══════════════════════════════════════════════════════════════
   MULTIPLAYER CLIENT (Phase 2)

   Fully independent of the single-player Game class in game_part1-5.js.
   This file owns:
     - The WebSocket connection to the Phase-1 server (server.js)
     - The lobby UI (#mp-overlay: create/join/waiting-room screens)
     - The in-match renderer (#mp-canvas) and HUD (#mp-hud)
     - Touch/mouse steering input, sent to the server every frame

   Deliberate scope for Phase 2: prove the networking + server-
   authoritative simulation works end-to-end with real players. Visuals
   are intentionally simple (plain snakes, plain food circles) because
   the server doesn't simulate AI/power-ups/skins yet either — adding
   fancier client-side visuals for things the server can't back would
   just be misleading. Phase 3 brings those into the server, and this
   file's render code will grow to match.

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

  // Latest world snapshot from the server. Rendered as-is — no client-
  // side prediction/interpolation in Phase 2 (that's a Phase 3 polish
  // item once the basic sync is proven out).
  world: { snakes: [], food: [] },

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
      this._send({ type: 'create_room', name: getPlayerName() });
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
      this._send({ type: 'join_room', roomCode: code, name: getPlayerName() });
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
        this.world = msg;
        this._updateWaitingList(msg.snakes);
        // Auto-start the match as soon as there are 2+ players and we're
        // still sitting in the lobby overlay — matches the "starts
        // automatically once a friend joins" behavior shown in the UI.
        if (!this.inMatch && msg.snakes.length >= 2) {
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
    const mine = this.world.snakes.find((s) => s.id === this.mySnakeId);
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

    ctx.fillStyle = '#060907';
    ctx.fillRect(0, 0, logW, logH);

    const mine = this.world.snakes.find((s) => s.id === this.mySnakeId);
    // Camera centers on the player's own snake; if dead, keep the camera
    // frozen at their last known head position so the death moment is
    // still watchable rather than snapping to (0,0).
    if (mine && mine.segments[0]) { this._camX = mine.segments[0].x - logW / 2; this._camY = mine.segments[0].y - logH / 2; }
    const camX = this._camX, camY = this._camY;

    // Food
    ctx.fillStyle = '#ffdd00';
    for (const f of this.world.food) {
      const sx = f.x - camX, sy = f.y - camY;
      if (sx < -20 || sx > logW + 20 || sy < -20 || sy > logH + 20) continue;
      ctx.beginPath();
      ctx.arc(sx, sy, 6, 0, Math.PI * 2);
      ctx.fill();
    }

    // Snakes
    for (const s of this.world.snakes) {
      if (!s.alive && s.id !== this.mySnakeId) continue; // don't render other players' corpses cluttering the view
      ctx.globalAlpha = s.alive ? 1 : 0.35;
      ctx.fillStyle = s.color;
      for (const seg of s.segments) {
        const sx = seg.x - camX, sy = seg.y - camY;
        if (sx < -20 || sx > logW + 20 || sy < -20 || sy > logH + 20) continue;
        ctx.beginPath();
        ctx.arc(sx, sy, 10, 0, Math.PI * 2);
        ctx.fill();
      }
      // Name label above the head
      if (s.segments[0]) {
        const hx = s.segments[0].x - camX, hy = s.segments[0].y - camY;
        ctx.font = '600 12px Segoe UI, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillText(s.id === this.mySnakeId ? 'You' : s.name, hx, hy - 22);
      }
      ctx.globalAlpha = 1;
    }
  },
};

document.addEventListener('DOMContentLoaded', () => MP.init());
