class Game {
  constructor() {
    this.canvas  = document.getElementById('game-canvas');
    this.ctx     = this.canvas.getContext('2d');

    // ── High-DPI / Retina scaling ──────────────────────────────
    // _dpr: the device pixel ratio we committed to on the last resize.
    // All coordinate logic (pointer, camera, joystick) continues to use
    // CSS / logical pixels. Only the backing buffer is scaled up.
    // Cap at 2x: iPhones/high-end Android report devicePixelRatio 3, which
    // means 9x the raw pixels to fill every frame vs 1x. 2x is still crisp
    // (indistinguishable in a fast-moving action game) and cuts GPU fill
    // work substantially — this was a major mobile lag contributor.
    this._dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.overlay      = document.getElementById('overlay');
    this.scoreDisplay = document.getElementById('score-display');
    this.finalScore   = document.getElementById('final-score');
    this.startBtn     = document.getElementById('start-btn');
    this.hudNameScore = document.getElementById('hud-name-score');
    // backward compat for existing HUD wiring (tickloop uses hud-score via window._game.player)
    this.hudScore     = this.hudNameScore;
    this.hudLength    = document.getElementById('hud-length');

    this._heartEls = [
      document.getElementById('heart-1'),
      document.getElementById('heart-2'),
      document.getElementById('heart-3'),
    ];

    this.hudBestScore = document.getElementById('hud-best-score');

    this.pauseBtn     = document.getElementById('pause-btn');
    this.pauseOverlay = document.getElementById('pause-overlay');
    this.resumeBtn    = document.getElementById('resume-btn');
    this.restartBtn   = document.getElementById('restart-btn');
    this.exitBtn      = document.getElementById('exit-btn');

    this.camX = 0; this.camY = 0;
    this.running = false;
    this.paused  = false;
    this.snakes  = [];
    this.foods   = [];
    this.foodGrid  = null;
    this.particles = new ParticlePool();
    this.audio     = new AudioManager();
    this.killFeed  = new KillFeed();
    this.combo     = new ComboManager();
    this.shake     = new ScreenShake();
    this.achievements = new AchievementManager();

    this._lastTime     = 0;
    this._rafId        = null;
    this._boundLoop    = this._loop.bind(this);
    this._foodQueryBuf = [];
    this._killList     = [];

    // Hit-stop
    this._hitStopTimer = 0;

    // Mode
    this._mode = 'classic';
    this._ttTimer = 120;   // Time Trial countdown
    this._worldW = WORLD_W;
    this._worldH = WORLD_H;

    // Run stats (for achievements)
    this._runStartTime = 0;

    // Joystick state
    this._joystick = {
      active: false,
      originX: 0, originY: 0,
      thumbX: 0,  thumbY: 0,
      maxR: 50,
    };
    this._joystickDir = new Vector2(0, 0);

    // Gyro state
    this._gyroDir = new Vector2(0, 0);
    this._gyroListening = false;

    window._GAME_WORLD = { w: WORLD_W, h: WORLD_H };

    this._setupResize();
    this._setupInput();
    this._setupSettings();
    this._setupPlayerName();
    this._setupStats();
    this._updateAchievementCount();
    this.startBtn.addEventListener('click', () => this.startGame());
    window._game = this;

    // Show daily badge if applicable
    this._checkDaily();
  }

  /* ── DAILY CHALLENGE ────────────────────────────────────── */
  _checkDaily() {
    const badge = document.getElementById('daily-badge');
    if (DailyChallenge.isActive && badge) badge.classList.remove('hidden');
  }

  /* ── PLAYER NAME ────────────────────────────────────────── */
  _setupPlayerName() {
    const display = document.getElementById('player-name-display');
    const input   = document.getElementById('player-name-input');
    if (!display || !input) return;

    display.textContent = getPlayerName();

    display.addEventListener('click', () => {
      input.value = getPlayerName();
      display.classList.add('hidden');
      input.classList.remove('hidden');
      input.focus();
      input.select();
    });

    const commit = () => {
      const n = input.value.trim() || getPlayerName();
      setPlayerName(n);
      display.textContent = n;
      input.classList.add('hidden');
      display.classList.remove('hidden');
    };

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') { input.classList.add('hidden'); display.classList.remove('hidden'); }
    });
  }

  /* ── STATS PANEL ────────────────────────────────────────── */
  _setupStats() {
    const toggle = document.getElementById('stats-toggle');
    const body   = document.getElementById('stats-body');
    const arrow  = toggle ? toggle.querySelector('.stats-arrow') : null;
    if (toggle) {
      toggle.addEventListener('click', () => {
        body.classList.toggle('hidden');
        if (arrow) arrow.classList.toggle('open', !body.classList.contains('hidden'));
        if (!body.classList.contains('hidden')) this._updateStats();
      });
    }
  }

  _updateStats() {
    const p = Profile.get();
    const set = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };
    set('stat-runs',          p.totalRuns);
    set('stat-kills',         p.totalKills);
    set('stat-food',          p.totalFoodEaten);
    set('stat-deaths',        p.totalDeaths);
    set('stat-time',          `${Math.floor(p.totalPlaytimeSeconds / 60)}m ${Math.floor(p.totalPlaytimeSeconds % 60)}s`);
    set('stat-best-classic',  p.bestScore);
    set('stat-best-tt',       p.bestScoreTimeTrial);
  }

  _updateAchievementCount() {
    const el = document.getElementById('achievement-count');
    if (el) el.textContent = `${this.achievements.unlockedCount} / ${ACHIEVEMENTS_DEF.length}`;
  }

  /* ── RESIZE ─────────────────────────────────────────────── */
  _setupResize() {
    // _resizeCanvas: sets the canvas *buffer* size to CSS size × dpr so
    // every pixel in the backing store maps to exactly one physical pixel.
    // All game-logic coordinates remain in CSS (logical) pixels — we only
    // scale the ctx transform once after each resize.
    const _resizeCanvas = () => {
      // Re-read dpr each time (can change when dragging between monitors)
      this._dpr = Math.min(window.devicePixelRatio || 1, 2);

      // Logical (CSS) dimensions — what all coordinate math uses
      const logW = window.innerWidth;
      const logH = window.innerHeight;

      // Physical buffer dimensions
      const physW = Math.round(logW * this._dpr);
      const physH = Math.round(logH * this._dpr);

      // Only reallocate if the buffer size actually changed (avoids
      // unnecessary work on orientation events that fire multiple times)
      if (this.canvas.width !== physW || this.canvas.height !== physH) {
        this.canvas.width  = physW;
        this.canvas.height = physH;
      }

      // Scale the ctx so every draw call uses logical pixels
      this.ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);

      // Invalidate the cached background tile so it is regenerated at the
      // correct logical size after the next render tick
      this._bgTile = null;
    };

    // Debounce: orientation changes fire several resize events in quick
    // succession; wait 120 ms after the last one before reacting.
    let _resizeTimer = null;
    const _debouncedResize = () => {
      clearTimeout(_resizeTimer);
      _resizeTimer = setTimeout(_resizeCanvas, 120);
    };

    window.addEventListener('resize', _debouncedResize);
    // Also listen for explicit orientation-change events (Safari)
    window.addEventListener('orientationchange', _debouncedResize);

    // Run immediately so the canvas is correctly sized before the first frame
    _resizeCanvas();
  }

  /* ── INPUT ──────────────────────────────────────────────── */
  _setupInput() {
    // ── Pause / Resume / Restart / Exit ──────────────────────
    if (this.pauseBtn) {
      this.pauseBtn.addEventListener('click', () => {
        if (this.running) this.pauseGame();
      });
    }
    if (this.resumeBtn)  this.resumeBtn.addEventListener('click', () => this.resumeGame());
    if (this.restartBtn) this.restartBtn.addEventListener('click', () => this.restartGame());
    if (this.exitBtn)    this.exitBtn.addEventListener('click', () => this.exitToMenu());

    // Auto-pause when the tab/app goes into the background, so the snake
    // doesn't keep moving (and potentially die) with no input while the
    // player isn't looking at the screen.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.running && !this.paused) this.pauseGame();
    });
    window.addEventListener('blur', () => {
      if (this.running && !this.paused) this.pauseGame();
    });
    document.addEventListener('keydown', e => {
      if ((e.key === 'Escape' || e.key === 'p' || e.key === 'P') && this.running) {
        if (this.paused) this.resumeGame(); else this.pauseGame();
      }
    });

    this._pointer = new Vector2(window.innerWidth / 2, window.innerHeight / 2);
    const isTouchDevice = 'ontouchstart' in window;

    this.canvas.addEventListener('mousemove', e => {
      this._pointer.x = e.clientX;
      this._pointer.y = e.clientY;
    });

    this.canvas.addEventListener('mousedown',  () => { if (this.running && !this.paused && this.player) this.player.boosting = true;  });
    this.canvas.addEventListener('mouseup',    () => { if (this.player) this.player.boosting = false; });
    this.canvas.addEventListener('mouseleave', () => { if (this.player) this.player.boosting = false; });

    if (isTouchDevice) {
      // ── Multi-touch fix ─────────────────────────────────────
      // Each finger has a stable e.touches[i].identifier that persists
      // across events until that finger lifts. We lock the FIRST finger
      // that touches down as the "joystick finger" and remember its id.
      // Any OTHER finger that touches down afterwards is treated purely
      // as a boost trigger — it never re-centers or moves the joystick.
      // This stops the joystick from jumping/fluctuating when the player
      // adds a second finger to boost while steering.
      this._joystickTouchId = null;

      // NOTE: touchstart MUST be { passive: false } so that the browser
      // does not emit a console warning about "Ignored attempt to cancel
      // a touchstart event with cancelable=false".  The canvas already has
      // touch-action:none in CSS which lets us call preventDefault safely.
      this.canvas.addEventListener('touchstart', e => {
        // Don't intercept taps on the overlay/menu, or while paused
        if (!this.running || this.paused) return;
        e.preventDefault(); // prevent click-delay ghost tap on iOS

        for (const t of e.changedTouches) {
          if (this._joystickTouchId === null && !this._joystick.active) {
            // First finger down → claim it as the joystick finger
            this._joystickTouchId = t.identifier;
            this._joystick.active  = true;
            this._joystick.originX = t.clientX;
            this._joystick.originY = t.clientY;
            this._joystick.thumbX  = t.clientX;
            this._joystick.thumbY  = t.clientY;
            this._joystickDir = new Vector2(0, 0);
          } else if (t.identifier !== this._joystickTouchId) {
            // Any additional finger = boost only, joystick untouched
            if (this.player) this.player.boosting = true;
          }
        }
      }, { passive: false }); // <-- non-passive so preventDefault works

      this.canvas.addEventListener('touchmove', e => {
        e.preventDefault(); // suppress scroll / rubber-banding
        if (!this._joystick.active || this._joystickTouchId === null) return;

        // Only move the joystick using the finger that owns it
        let t = null;
        for (const ct of e.changedTouches) {
          if (ct.identifier === this._joystickTouchId) { t = ct; break; }
        }
        if (!t) return;

        const dx = t.clientX - this._joystick.originX;
        const dy = t.clientY - this._joystick.originY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const maxR = this._joystick.maxR;
        const clamp = Math.min(dist, maxR);
        const nx = dist > 0 ? dx / dist : 0;
        const ny = dist > 0 ? dy / dist : 0;
        this._joystick.thumbX = this._joystick.originX + nx * clamp;
        this._joystick.thumbY = this._joystick.originY + ny * clamp;
        if (dist > 10) this._joystickDir = new Vector2(nx, ny);
      }, { passive: false });

      this.canvas.addEventListener('touchend', e => {
        // Check whether the joystick's own finger was among those lifted
        for (const t of e.changedTouches) {
          if (t.identifier === this._joystickTouchId) {
            this._joystickTouchId = null;
            this._joystick.active = false;
            this._joystickDir = new Vector2(0, 0);
          }
        }
        // Boost stays on as long as any non-joystick finger remains down
        if (this.player) {
          const otherFingersDown = e.touches.length > (this._joystick.active ? 1 : 0);
          this.player.boosting = otherFingersDown;
        }
      }, { passive: true });

      this.canvas.addEventListener('touchcancel', () => {
        this._joystickTouchId = null;
        this._joystick.active = false;
        this._joystickDir = new Vector2(0, 0);
        if (this.player) this.player.boosting = false;
      }, { passive: true });

    } else {
      // Desktop fallback touch (e.g. Chrome DevTools device emulation)
      this.canvas.addEventListener('touchstart', e => {
        const t = e.touches[0];
        this._pointer.x = t.clientX; this._pointer.y = t.clientY;
        if (this.running && this.player) this.player.boosting = true;
      }, { passive: true });
      this.canvas.addEventListener('touchmove', e => {
        e.preventDefault();
        const t = e.touches[0];
        this._pointer.x = t.clientX; this._pointer.y = t.clientY;
      }, { passive: false });
      this.canvas.addEventListener('touchend', () => {
        if (this.player) this.player.boosting = false;
      }, { passive: true });
    }
  }

  _setupGyro() {
    if (this._gyroListening) return;
    const start = () => {
      window.addEventListener('deviceorientation', e => {
        if (!Settings.gyro) return;
        const gamma = Math.max(-45, Math.min(45, e.gamma || 0));
        const beta  = Math.max(-45, Math.min(45, (e.beta || 0) - 30)); // offset for natural hold
        this._gyroDir = new Vector2(gamma / 45, beta / 45);
      });
      this._gyroListening = true;
    };

    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      DeviceOrientationEvent.requestPermission().then(r => { if (r === 'granted') start(); }).catch(() => {});
    } else {
      start();
    }
  }

  /* ── SETTINGS UI ────────────────────────────────────────── */
  _setupSettings() {
    // Mute toggle
    const muteBtn = document.getElementById('setting-mute');
    muteBtn.addEventListener('click', () => {
      Settings.muted = !Settings.muted;
      muteBtn.textContent = Settings.muted ? 'OFF' : 'ON';
      muteBtn.classList.toggle('active', !Settings.muted);
      muteBtn.setAttribute('aria-pressed', String(Settings.muted));
      this.audio.applyMuteSetting();
    });

    // Sensitivity slider
    const sensSlider = document.getElementById('setting-sensitivity');
    const sensVal    = document.getElementById('sensitivity-val');
    sensSlider.value = Settings.sensitivity;
    sensVal.textContent = Settings.sensitivity;
    sensSlider.addEventListener('input', () => {
      Settings.sensitivity = parseInt(sensSlider.value, 10);
      sensVal.textContent  = Settings.sensitivity;
    });

    // Design buttons
    const designBtns = document.querySelectorAll('.design-btn');
    designBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        designBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        Settings.design = btn.dataset.design;
      });
    });

    // Mode buttons
    const modeBtns = document.querySelectorAll('.mode-btn');
    const modeDescEl = document.getElementById('mode-desc');
    const modeDescs = {
      classic:   'Eat food, grow big, outlast 10 AI snakes. 3 lives.',
      timetrial: '120 second sprint. No lives. Eat as much as possible.',
    };
    modeBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        modeBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        Settings.mode = btn.dataset.mode;
        if (modeDescEl) modeDescEl.textContent = modeDescs[Settings.mode] || '';
      });
    });

    // Gyro toggle — only show on touch devices
    if ('ontouchstart' in window) {
      const gyroRow = document.getElementById('gyro-row');
      const gyroBtn = document.getElementById('setting-gyro');
      if (gyroRow) gyroRow.style.display = '';
      if (gyroBtn) {
        gyroBtn.addEventListener('click', () => {
          Settings.gyro = !Settings.gyro;
          gyroBtn.textContent = Settings.gyro ? 'ON' : 'OFF';
          gyroBtn.classList.toggle('active', Settings.gyro);
          if (Settings.gyro) this._setupGyro();
        });
      }
    }
  }

  /* ── START / RESET ──────────────────────────────────────── */
  startGame() {
    this.overlay.classList.add('hidden');
    this.scoreDisplay.style.display = 'none';
    const bestDisplay = document.getElementById('best-score-display');
    if (bestDisplay) bestDisplay.style.display = 'none';
    const titleEl = document.getElementById('overlay-title');
    if (titleEl) { titleEl.classList.remove('victory'); titleEl.textContent = '🐍 SNAKE RUSH'; }
    this.startBtn.textContent = 'Play Again';

    this._heartEls.forEach(el => el.classList.remove('lost'));

    // Mode setup
    this._mode = Settings.mode;
    let worldW = WORLD_W, worldH = WORLD_H;
    let foodCount = FOOD_COUNT, aiCount = AI_COUNT;

    if (DailyChallenge.isActive) {
      foodCount = DailyChallenge.foodCount;
      aiCount   = DailyChallenge.aiCount;
      worldW    = Math.round(WORLD_W * DailyChallenge.worldMod);
      worldH    = Math.round(WORLD_H * DailyChallenge.worldMod);
    }

    if (this._mode === 'timetrial') {
      foodCount = 400; aiCount = 0;
      this._ttTimer = 120;
    }

    this._worldW = worldW;
    this._worldH = worldH;
    window._GAME_WORLD = { w: worldW, h: worldH };

    this.foodGrid = new SpatialGrid(worldW, worldH, 360);
    this.snakes   = [];
    this.player   = new PlayerSnake(worldW / 2, worldH / 2);
    this.player.name = getPlayerName();
    this.snakes.push(this.player);

    for (let i = 0; i < aiCount; i++) {
      const [body, head] = randomAIPalette();
      let x, y, tries = 0;
      do {
        x = 300 + Math.random() * (worldW - 600);
        y = 300 + Math.random() * (worldH - 600);
        tries++;
      } while (Vector2.distSq({ x, y }, this.player.head) < 500 * 500 && tries < 8);
      this.snakes.push(new AISnake(x, y, body, head, this.foodGrid, this.snakes));
    }

    this.foods = [];
    this._lifelineCount  = 0;
    this._shieldCount    = 0;
    this._ghostCount     = 0;
    this._mineCount      = 0;
    this._speedCount     = 0;

    for (let i = 0; i < foodCount; i++) this._spawnFood();

    _designerPaletteIdx = 0;
    _designerTimer      = 0;

    this.audio.stopBg(); this.audio.stopPanic(); this.audio.stopRun();
    this.audio.playBg();
    this.audio._nearCooldown = 0;
    this.audio._biteCooldown = 0;

    this._inDangerZone  = false;
    this._nearSnakeLast = false;
    this._hitStopTimer  = 0;
    this._runStartTime  = performance.now();

    // Boss Snake (Titan Serpent) timer — first one arrives at BOSS_INTERVAL
    // seconds in, then again every BOSS_INTERVAL after the previous one
    // dies, capped to one boss alive at a time. Skipped in Time Trial (a
    // short focused sprint) and Daily Challenge (keeps that mode's
    // difficulty predictable for fair seeded-run comparison).
    this._bossEligible = this._mode === 'classic' && !DailyChallenge.isActive;
    this._bossTimer    = BOSS_INTERVAL;
    this._bossActive   = null;

    this.killFeed  = new KillFeed();
    this.combo.reset();
    this.shake     = new ScreenShake();
    this.achievements.resetRun();

    Profile.add('totalRuns');

    this.running   = true;
    this._lastTime = performance.now();
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = requestAnimationFrame(this._boundLoop);
  }

  /* ── FOOD SPAWNING ───────────────────────────────────────── */
  _spawnFood(forceType = null, x = null, y = null) {
    const W = this._worldW || WORLD_W, H = this._worldH || WORLD_H;
    const fx  = x  ?? (50 + Math.random() * (W - 100));
    const fy  = y  ?? (50 + Math.random() * (H - 100));
    const col = FOOD_COLORS[Math.floor(Math.random() * FOOD_COLORS.length)];

    let type = forceType;
    if (!type) {
      const roll = Math.random();
      const daily = DailyChallenge.isActive ? DailyChallenge.enabledPowerups : null;
      const ok = (name) => !daily || daily.includes(name);

      if      (roll < LIFELINE_SPAWN_RATE && this._lifelineCount < LIFELINE_MAX_ON_MAP && ok('lifeline'))    type = FOOD_TYPE.LIFELINE;
      else if (roll < LIFELINE_SPAWN_RATE + POWERUP_SPAWN_RATE && ok('magnet'))                              type = FOOD_TYPE.MAGNET;
      else if (roll < LIFELINE_SPAWN_RATE + POWERUP_SPAWN_RATE * 2 && ok('attack'))                          type = FOOD_TYPE.ATTACK;
      else if (roll < LIFELINE_SPAWN_RATE + POWERUP_SPAWN_RATE * 2 + SHIELD_SPAWN_RATE
               && this._shieldCount < SHIELD_MAX_ON_MAP && ok('shield'))                                     type = FOOD_TYPE.SHIELD;
      else if (roll < LIFELINE_SPAWN_RATE + POWERUP_SPAWN_RATE * 2 + SHIELD_SPAWN_RATE + GHOST_SPAWN_RATE
               && this._ghostCount < GHOST_MAX_ON_MAP && ok('ghost'))                                        type = FOOD_TYPE.GHOST;
      else if (roll < LIFELINE_SPAWN_RATE + POWERUP_SPAWN_RATE * 2 + SHIELD_SPAWN_RATE + GHOST_SPAWN_RATE + MINE_SPAWN_RATE
               && this._mineCount < MINE_MAX_ON_MAP && ok('mine'))                                           type = FOOD_TYPE.MINE;
      else if (roll < LIFELINE_SPAWN_RATE + POWERUP_SPAWN_RATE * 2 + SHIELD_SPAWN_RATE + GHOST_SPAWN_RATE + MINE_SPAWN_RATE + SPEED_SPAWN_RATE
               && this._speedCount < SPEED_MAX_ON_MAP && ok('speed'))                                        type = FOOD_TYPE.SPEED;
      else                                                                                                    type = FOOD_TYPE.NORMAL;
    }

    const f = new Food(fx, fy, col, type);
    this.foods.push(f);
    this.foodGrid.add(f);
    if (type === FOOD_TYPE.LIFELINE) this._lifelineCount++;
    if (type === FOOD_TYPE.SHIELD)   this._shieldCount++;
    if (type === FOOD_TYPE.GHOST)    this._ghostCount++;
    if (type === FOOD_TYPE.MINE)     this._mineCount++;
    if (type === FOOD_TYPE.SPEED)    this._speedCount++;
    return f;
  }

  _removeFood(food) {
    this.foodGrid.remove(food);
    if (food.type === FOOD_TYPE.LIFELINE) this._lifelineCount--;
    if (food.type === FOOD_TYPE.SHIELD)   this._shieldCount--;
    if (food.type === FOOD_TYPE.GHOST)    this._ghostCount--;
    if (food.type === FOOD_TYPE.MINE)     this._mineCount--;
    if (food.type === FOOD_TYPE.SPEED)    this._speedCount--;
    const idx = this.foods.indexOf(food);
    if (idx !== -1) {
      this.foods[idx] = this.foods[this.foods.length - 1];
      this.foods.pop();
    }
  }

  /* ── MAIN LOOP ──────────────────────────────────────────── */
  _loop(timestamp) {
    if (!this.running) return;

    // Re-apply the DPI scale transform on every frame.
    // canvas.width changes reset ctx.setTransform to identity, so after a
    // debounced resize the very next frame would draw at 1× until the next
    // explicit setTransform call.  Calling it here (cheaply) keeps rendering
    // crisp regardless of when the resize fires relative to rAF.
    this.ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);

    if (this.paused) {
      // Keep lastTime fresh so that resuming doesn't produce one huge dt
      // jump (which would look like the snake teleporting forward).
      this._lastTime = timestamp;
      this._render(); // keep last frame visible under the pause panel
      this._rafId = requestAnimationFrame(this._boundLoop);
      return;
    }

    const rawDt = (timestamp - this._lastTime) / 1000;
    const dt    = Math.min(rawDt, 0.1);
    this._lastTime = timestamp;

    // Hit-stop: skip update
    if (this._hitStopTimer > 0) {
      this._hitStopTimer = Math.max(0, this._hitStopTimer - dt);
    } else {
      this._update(dt);
    }
    this._render();
    this._rafId = requestAnimationFrame(this._boundLoop);
  }

  /* ── UPDATE ─────────────────────────────────────────────── */
  _update(dt) {
    tickDesignerPalette(dt);
    this.audio.tickCooldowns(dt);
    this.killFeed.update(dt);
    this.combo.update(dt);
    this.shake.update(dt);
    this.achievements.update(dt);

    // Boss Snake timer
    if (this._bossEligible) {
      if (this._bossActive && !this._bossActive.alive) this._bossActive = null;
      if (!this._bossActive) {
        this._bossTimer -= dt;
        if (this._bossTimer <= 0) {
          this._spawnBoss();
          this._bossTimer = BOSS_INTERVAL;
        }
      }
    }

    // Time Trial countdown
    if (this._mode === 'timetrial') {
      this._ttTimer -= dt;
      if (this._ttTimer <= 0) {
        this._ttTimer = 0;
        this._timeTrialEnd();
        return;
      }
    }

    if (this.player.alive) {
      this.player.pointer.x = this._pointer.x;
      this.player.pointer.y = this._pointer.y;
      const jd = this._joystick.active ? this._joystickDir : null;
      const gd = Settings.gyro ? this._gyroDir : null;
      this.player.update(dt, this.camX, this.camY, jd, gd);

      // Achievement checks
      this.achievements.onLength(this.player.length);
    }

    // AI
    for (let i = 1; i < this.snakes.length; i++) this.snakes[i].update(dt);

    // Camera — must use LOGICAL pixel dimensions, not canvas.width/height
    // (canvas.width is now physW = logW × dpr; dividing by dpr gives logW)
    if (this.player.alive) {
      const logW = this.canvas.width  / this._dpr;
      const logH = this.canvas.height / this._dpr;
      const targetX = this.player.head.x - logW / 2;
      const targetY = this.player.head.y - logH / 2;
      const camT = Math.min(1, 7 * dt);
      this.camX += (targetX - this.camX) * camT;
      this.camY += (targetY - this.camY) * camT;
    }

    // Danger zone audio
    if (this.player.alive) {
      const hx = this.player.head.x, hy = this.player.head.y;
      const W = this._worldW, H = this._worldH;
      const nearest = Math.min(hx, W - hx, hy, H - hy);
      const inDanger = nearest < DANGER_ZONE_DIST;
      if (inDanger && !this._inDangerZone)  { this._inDangerZone = true;  this.audio.startRun(); }
      if (!inDanger && this._inDangerZone)  { this._inDangerZone = false; this.audio.stopRun(); }

      // Screen shake near wall
      if (nearest < 80) this.shake.trigger(3, 0.1);
    }

    // Near snake audio
    if (this.player.alive) {
      const nearSq = NEAR_SNAKE_RADIUS * NEAR_SNAKE_RADIUS;
      let anyNear = false;
      for (let i = 1; i < this.snakes.length; i++) {
        if (!this.snakes[i].alive) continue;
        if (Vector2.distSq(this.player.head, this.snakes[i].head) < nearSq) { anyNear = true; break; }
      }
      if (anyNear) this.audio.playNearSnake();
    }

    // Magnet pull — power-up magnet (strong, timed) takes priority; when
    // it's not active, the player's permanent passive magnet (weak, always
    // on) still gently pulls in food that's already very close.
    if (this.player.alive) {
      const usingPowerup = this.player.magnetTimer > 0;
      const radius = usingPowerup ? MAGNET_RADIUS : PASSIVE_MAGNET_RADIUS;
      const pullForce = usingPowerup ? MAGNET_PULL_FORCE : PASSIVE_MAGNET_FORCE;

      this.foodGrid.query(this.player.head.x, this.player.head.y, radius, this._foodQueryBuf);
      for (const food of this._foodQueryBuf) {
        if (food.type !== FOOD_TYPE.NORMAL) continue;
        const dx = this.player.head.x - food.pos.x, dy = this.player.head.y - food.pos.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        let strength = (1 - dist / radius) * pullForce * dt;
        // Cap the step to the remaining distance so a strong pull force
        // can never overshoot past the head in one frame — without this,
        // food that's very close would fly through to the far side and
        // get yanked back next frame, repeating every frame and looking
        // like it's being repelled instead of pulled in.
        if (strength > dist) strength = dist;
        this.foodGrid.remove(food);
        food.pos.x += (dx / dist) * strength;
        food.pos.y += (dy / dist) * strength;
        this.foodGrid.add(food);
      }
    }

    // Mine collision check
    if (this.player.activeMines) {
      for (const mine of this.player.activeMines) {
        for (let i = 1; i < this.snakes.length; i++) {
          const ai = this.snakes[i];
          if (!ai.alive) continue;
          if (Vector2.dist(mine.pos, ai.head) < MINE_TRIGGER_R) {
            // Explosion
            mine.active = false;
            this.particles.burstAt(mine.pos.x, mine.pos.y, '#ff9f40', 30);
            this.shake.trigger(6, 0.25);
            this.audio.playKill();
            // Kill anything in radius
            for (let j = 1; j < this.snakes.length; j++) {
              const victim = this.snakes[j];
              if (!victim.alive) continue;
              if (Vector2.dist(mine.pos, victim.head) < MINE_KILL_R) {
                this._killSnake(victim, true);
              }
            }
            break;
          }
        }
      }
    }

    // Food TTL garbage collection
    {
      const toRemove = [];
      for (const food of this.foods) {
        if (food.ttl === null) continue;
        food.ttl -= dt;
        if (food.ttl <= 0) toRemove.push(food);
      }
      for (const food of toRemove) this._removeFood(food);
    }

    // Food collision
    const eaten = [];
    for (const snake of this.snakes) {
      if (!snake.alive) continue;
      const isPlayer = snake === this.player;
      const queryR   = isPlayer ? 40 : 30;
      this.foodGrid.query(snake.head.x, snake.head.y, queryR, this._foodQueryBuf);

      for (const food of this._foodQueryBuf) {
        const dsq  = Vector2.distSq(snake.head, food.pos);
        const rSum = getSegmentR(isPlayer ? true : snake) + food.radius;
        if (dsq >= rSum * rSum) continue;

        if (isPlayer) {
          if (food.type === FOOD_TYPE.MAGNET) {
            this.player.activateMagnet(); this.audio.playMagnet();
            eaten.push(food); this._spawnFood(FOOD_TYPE.NORMAL); continue;
          }
          if (food.type === FOOD_TYPE.ATTACK) {
            this.player.activateAttack();
            eaten.push(food); this._spawnFood(FOOD_TYPE.NORMAL); continue;
          }
          if (food.type === FOOD_TYPE.SHIELD) {
            this.player.activateShield(); this.audio.playMagnet();
            eaten.push(food); this._spawnFood(FOOD_TYPE.NORMAL); continue;
          }
          if (food.type === FOOD_TYPE.GHOST) {
            this.player.activateGhost(); this.audio.playMagnet();
            eaten.push(food); this._spawnFood(FOOD_TYPE.NORMAL); continue;
          }
          if (food.type === FOOD_TYPE.MINE) {
            this.player.activateMine(); this.audio.playMagnet();
            eaten.push(food); this._spawnFood(FOOD_TYPE.NORMAL); continue;
          }
          if (food.type === FOOD_TYPE.SPEED) {
            this.player.activateSpeedBoost(); this.audio.playMagnet();
            this.achievements.onSpeedBoost();
            eaten.push(food); this._spawnFood(FOOD_TYPE.NORMAL); continue;
          }
          if (food.type === FOOD_TYPE.LIFELINE) {
            if (this.player.lives < PLAYER_LIVES) {
              this.player.lives++;
              this._updateLivesHUD();
              this.audio.playLifeline();
              eaten.push(food);
            }
            continue;
          }
        }

        const comboMul = isPlayer ? this.combo.multiplier : 1;
        const mult = (1 + Math.floor(snake.length / 20)) * comboMul;
        snake.eat(mult);
        eaten.push(food);

        if (isPlayer) {
          this.audio.playEat();
          Profile.add('totalFoodEaten');
          this.achievements.onFood();
          this.combo.eat((count) => {
            this.combo.addFloat(this.player.head.x, this.player.head.y, count);
            if (count >= 10) this.achievements.onCombo10();
          });
        }
      }
    }

    for (const f of eaten) {
      this._removeFood(f);
      if (f.type === FOOD_TYPE.NORMAL) this._spawnFood();
    }

    // Wall collision
    const W = this._worldW, H = this._worldH;
    for (const snake of this.snakes) {
      if (!snake.alive) continue;
      const h = snake.head;
      if (h.x < 0 || h.x > W || h.y < 0 || h.y > H) {
        this._killSnake(snake);
        if (snake === this.player) this.shake.trigger(12, 0.4);
      }
    }

    // Snake vs snake
    this._checkSnakeCollisions();

    // Particles
    this.particles.update(dt);

    // Respawn dead AI
    for (let i = 1; i < this.snakes.length; i++) {
      if (!this.snakes[i].alive) {
        const [body, head] = randomAIPalette();
        // Keep respawns a fair distance from the player — bigger species
        // (Python/Anaconda) get a larger exclusion radius so they never
        // pop into existence right on top of the player for a cheap hit.
        let x, y, tries = 0;
        do {
          x = 300 + Math.random() * (W - 600);
          y = 300 + Math.random() * (H - 600);
          tries++;
        } while (
          this.player && this.player.alive &&
          Vector2.distSq({ x, y }, this.player.head) < 500 * 500 &&
          tries < 8
        );
        this.snakes[i] = new AISnake(x, y, body, head, this.foodGrid, this.snakes);
      }
    }

    // Panic audio
    if (this._mode !== 'timetrial') {
      if (this.player.alive && this.player.lives === 1) this.audio.startPanic();
      else this.audio.stopPanic();
    }

    // HUD
    if (this.player.alive) {
      const pname = this.player.name || getPlayerName();
      if (this.hudNameScore) this.hudNameScore.textContent = `${pname}: ${this.player.score}`;
      if (this.hudLength) this.hudLength.textContent = `Length: ${this.player.length}`;
      if (this.hudBestScore) this.hudBestScore.textContent = `Best: ${HighScore.get()}`;
      this._updateLivesHUD();
    }

    // Playtime
    Profile.add('totalPlaytimeSeconds', dt);
  }

  /* ── BOSS SNAKE ─────────────────────────────────────────── */
  _spawnBoss() {
    const W = this._worldW, H = this._worldH;
    const titanSpecies = SNAKE_SPECIES.find(s => s.id === 'titan');
    if (!titanSpecies) return;

    // Spawn far from the player (bigger exclusion radius than normal AI
    // respawns — a Titan appearing near the player should feel like an
    // event, not an ambush).
    let x, y, tries = 0;
    do {
      x = 300 + Math.random() * (W - 600);
      y = 300 + Math.random() * (H - 600);
      tries++;
    } while (
      this.player && this.player.alive &&
      Vector2.distSq({ x, y }, this.player.head) < 900 * 900 &&
      tries < 10
    );

    const boss = new AISnake(x, y, '#7a1010', '#ff3c14', this.foodGrid, this.snakes, titanSpecies);
    this.snakes.push(boss);
    this._bossActive = boss;

    // Announcement — reuses the kill-feed's existing toast rendering so
    // there's no new UI plumbing needed. Uses the raw add() (not
    // addKill/addEliminated) since those wrap text with their own
    // "you killed X" / "X eliminated" phrasing.
    this.killFeed.add('⚠️ A Titan Serpent has awoken!');
    this.shake.trigger(8, 0.3);
    this.audio.playBossRoar();
  }

  _updateLivesHUD() {
    const lives = this.player.lives;
    this._heartEls.forEach((el, i) => {
      if (i < lives) el.classList.remove('lost');
      else           el.classList.add('lost');
    });
    // In time trial, hide hearts
    const hudLives = document.getElementById('hud-lives');
    if (hudLives) hudLives.style.visibility = this._mode === 'timetrial' ? 'hidden' : '';
  }

  /* ── PAUSE / RESUME / RESTART / EXIT ────────────────────── */
  pauseGame() {
    if (!this.running || this.paused) return;
    this.paused = true;
    // Freeze any held input so the snake doesn't keep boosting/turning
    // once we resume, based on stale touch/mouse state.
    if (this.player) this.player.boosting = false;
    this._joystick.active = false;
    this._joystickTouchId = null;
    this.audio.stopRun();
    // Background music keeps playing softly; panic loop pauses with the game.
    this.audio.stopPanic();
    if (this.pauseOverlay) this.pauseOverlay.classList.remove('hidden');
  }

  resumeGame() {
    if (!this.running || !this.paused) return;
    this.paused = false;
    if (this.pauseOverlay) this.pauseOverlay.classList.add('hidden');
    // Re-sync lastTime right away too (loop also does this defensively).
    this._lastTime = performance.now();
  }

  restartGame() {
    if (this.pauseOverlay) this.pauseOverlay.classList.add('hidden');
    this.paused = false;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this.audio.stopBg(); this.audio.stopPanic(); this.audio.stopRun();
    this.startGame();
  }

  exitToMenu() {
    if (this.pauseOverlay) this.pauseOverlay.classList.add('hidden');
    this.paused  = false;
    this.running = false;
    this._inDangerZone = false;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this.audio.stopBg(); this.audio.stopPanic(); this.audio.stopRun();

    this.scoreDisplay.style.display = 'none';
    const bestDisplay = document.getElementById('best-score-display');
    if (bestDisplay) bestDisplay.style.display = 'none';
    const titleEl = document.getElementById('overlay-title');
    if (titleEl) { titleEl.classList.remove('victory'); titleEl.textContent = '🐍 SNAKE RUSH'; }
    this.startBtn.textContent = 'Play Again';
    this.overlay.classList.remove('hidden');
  }

  _flashLifeLost() {
    document.body.classList.remove('life-lost-flash');
    void document.body.offsetWidth;
    document.body.classList.add('life-lost-flash');
  }

  _respawnPlayer() {
    const p = this.player;
    const W = this._worldW, H = this._worldH;
    const safeX = W / 2 + (Math.random() - 0.5) * 400;
    const safeY = H / 2 + (Math.random() - 0.5) * 400;
    p.segments = [];
    for (let i = 0; i < 12; i++) p.segments.push(new Vector2(safeX - i * SEGMENT_GAP, safeY));
    p.pos.x = safeX; p.pos.y = safeY;
    p.dir   = new Vector2(1, 0);
    p.alive = true;
    p._growBuffer = 0;
    p.magnetTimer = 0; p.attackTimer = 0; p.shieldTimer = 0;
    p.ghostTimer  = 0; p.mineTimer   = 0; p.speedBoostTimer = 0;
    p.iFrameTimer = IFRAME_DURATION;
    this.audio.playLifeline();
  }

  /* ── KILL SNAKE ─────────────────────────────────────────── */
  _killSnake(snake, triggeredByPlayer = false) {
    if (!snake.alive) return;

    if (snake === this.player) {
      if (this.player.invincible) {
        // Shield breaks
        if (this.player.shieldTimer > 0) {
          this.player.shieldTimer = 0;
          this.shake.trigger(4, 0.2);
        }
        return;
      }

      if (this._mode === 'timetrial') {
        snake.alive = false;
        this.particles.burst(snake.segments, snake.headColor);
        this.audio.playGameOver();
        this.shake.trigger(12, 0.4);
        this.achievements.onDeath();
        this._runGameOver();
        return;
      }

      this.player.lives--;
      this._updateLivesHUD();
      this._flashLifeLost();
      this.shake.trigger(12, 0.4);
      this.achievements.onDeath();
      Profile.add('totalDeaths');

      if (this.player.lives <= 0) {
        snake.alive = false;
        this.particles.burst(snake.segments, snake.headColor);
        this.audio.playGameOver();
        this._runGameOver();
      } else {
        this._respawnPlayer();
      }
      return;
    }

    // AI death
    snake.alive = false;
    this.particles.burst(snake.segments, snake.headColor);

    if (snake.isBoss) {
      this._bossActive = null;
      this.shake.trigger(16, 0.5);

      if (triggeredByPlayer) {
        this.audio.playBossKill();
        this._hitStopTimer = 0.12;
        this.killFeed.add('🏆 You slew the Titan Serpent!');
        // Direct score bonus on top of the food it drops below — killing
        // a boss should feel like a headline event, not just "one more
        // snake down".
        if (this.player.alive) this.player.score += 500;
        Profile.add('totalKills');
        this.achievements.onBossKill();
      } else {
        this.audio.playBossKill();
        this.killFeed.add('💀 The Titan Serpent has fallen');
      }
    } else {
      this.shake.trigger(6, 0.25);
      if (triggeredByPlayer) {
        this.audio.playKill();
        this._hitStopTimer = 0.08;
        const label = snake.speciesLabel ? `${snake.speciesLabel} ${snake.name || ''}`.trim() : (snake.name || 'Unknown');
        this.killFeed.addKill(label);
        Profile.add('totalKills');
        this.achievements.onKill();
      } else {
        const label = snake.speciesLabel ? `${snake.speciesLabel} ${snake.name || ''}`.trim() : (snake.name || 'Unknown');
        this.killFeed.addEliminated(label);
      }
    }

    // Drop food from dead snake
    const W = this._worldW, H = this._worldH;
    for (let i = 0; i < snake.segments.length; i += 3) {
      const seg = snake.segments[i];
      if (seg.x > 10 && seg.x < W - 10 && seg.y > 10 && seg.y < H - 10) {
        const col = FOOD_COLORS[Math.floor(Math.random() * FOOD_COLORS.length)];
        const ttl = 10 + Math.random() * 5;
        const f   = new Food(seg.x + (Math.random() - 0.5) * 10, seg.y + (Math.random() - 0.5) * 10, col, FOOD_TYPE.NORMAL, ttl);
        this.foods.push(f);
        this.foodGrid.add(f);
      }
    }
  }

  /* ── SNAKE VS SNAKE ─────────────────────────────────────── */
  // Perf: this used to allocate a fresh Map + 2 Sets + per-bucket arrays +
  // string keys EVERY frame (60x/sec), which is heavy GC pressure and a
  // major cause of stutter with a full roster of AI snakes. Now everything
  // is pooled on `this` and cleared/reused in place, and bucket keys are
  // plain integers instead of template-string concatenations.
  _checkSnakeCollisions() {
    if (!this._killSet) {
      this._killSet        = new Set();
      this._playerKillSet  = new Set();
      this._shatterList    = [];
      this._checkedPairs   = new Set();
      this._headBuckets    = new Map();
    }
    const killSet       = this._killSet;        killSet.clear();
    const playerKillSet = this._playerKillSet;   playerKillSet.clear();
    const shatterList   = this._shatterList;     shatterList.length = 0;
    const checkedPairs  = this._checkedPairs;    checkedPairs.clear();
    const headBuckets   = this._headBuckets;
    for (const arr of headBuckets.values()) arr.length = 0;

    const playerInAttack = this.player.alive && this.player.attackTimer > 0;

    const BUCKET_SIZE = 1100;
    // Pack (bx,by) into a single integer key instead of a template string —
    // avoids string allocation for every snake x every neighboring cell.
    // Uses multiplication rather than bitwise shift: JS bitwise ops coerce
    // to signed 32-bit ints, and shifting a large offset left by 16 can
    // silently overflow/flip sign. Multiplication keys stay exact in
    // float64 for all values used here.
    const BUCKET_OFFSET = 64; // world is 5500x5500 / 1100 = 5 buckets per axis; ±1 neighbor search needs a small safe margin
    const BUCKET_MOD    = 100000;
    for (let a = 0; a < this.snakes.length; a++) {
      const sa = this.snakes[a];
      if (!sa.alive) continue;
      const bx = Math.floor(sa.head.x / BUCKET_SIZE);
      const by = Math.floor(sa.head.y / BUCKET_SIZE);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const key = (bx + dx + BUCKET_OFFSET) * BUCKET_MOD + (by + dy + BUCKET_OFFSET);
          let arr = headBuckets.get(key);
          if (!arr) { arr = []; headBuckets.set(key, arr); }
          arr.push(a);
        }
      }
    }

    for (let a = 0; a < this.snakes.length; a++) {
      const sa = this.snakes[a];
      if (!sa.alive || killSet.has(sa)) continue;
      if (sa === this.player && this.player.invincible) continue;

      const bx = Math.floor(sa.head.x / BUCKET_SIZE);
      const by = Math.floor(sa.head.y / BUCKET_SIZE);
      const selfKey = (bx + BUCKET_OFFSET) * BUCKET_MOD + (by + BUCKET_OFFSET);
      const candidates = headBuckets.get(selfKey);
      if (!candidates) continue;

      for (const b of candidates) {
        if (a === b) continue;
        // Pack the pair (lo,hi) into one integer instead of a string join —
        // this loop runs for every nearby snake pair every frame. Snake
        // count is always small (<20), so hi fits comfortably under the
        // multiplier with no collision risk.
        const lo = a < b ? a : b, hi = a < b ? b : a;
        const pairKey = lo * 10000 + hi;
        if (checkedPairs.has(pairKey)) continue;
        checkedPairs.add(pairKey);

        const sb = this.snakes[b];
        if (!sb.alive || killSet.has(sb)) continue;

        const headDsq = Vector2.distSq(sa.head, sb.head);
        if (headDsq > 1000 * 1000) continue;

        // Species-aware head collision radius: average of both snakes'
        // actual rendered thickness, so an Anaconda's much bigger head
        // reaches/gets-reached at a proportionally bigger distance.
        const rA = getSegmentR(sa.isPlayer ? true : sa);
        const rB = getSegmentR(sb.isPlayer ? true : sb);
        const avgR = (rA + rB) / 2;
        const HEAD_DSQ = (avgR * 2.8) * (avgR * 2.8);

        if (headDsq <= HEAD_DSQ) {
          if (a < b) {
            const sizeDiff = sa.segments.length - sb.segments.length;
            if (sizeDiff > H2H_UPSET_THRESHOLD) {
              killSet.add(sb); if (sa === this.player) playerKillSet.add(sb);
            } else if (sizeDiff < -H2H_UPSET_THRESHOLD) {
              killSet.add(sa); if (sb === this.player) playerKillSet.add(sa);
            } else {
              killSet.add(sa); killSet.add(sb);
            }
          }
          continue;
        }

        // Head-vs-body (sa → sb): hit radius uses sb's body thickness
        const killDsqB = (getSegmentR(sb.isPlayer ? true : sb) * 1.8) ** 2;
        for (let s = 1; s < sb.segments.length; s++) {
          if (Vector2.distSq(sa.head, sb.segments[s]) >= killDsqB) continue;
          // Ghost: skip body collision
          if (sa === this.player && this.player.isGhost) break;
          if (sa === this.player && playerInAttack && sb !== this.player) {
            shatterList.push({ snake: sb, fromIndex: s });
          } else if (sb === this.player && sa !== this.player && !this.player.invincible) {
            this.audio.playEnemyBite();
            killSet.add(sa);
          } else {
            killSet.add(sa);
          }
          break;
        }

        // Head-vs-body (sb → sa): hit radius uses sa's body thickness
        const killDsqA = (getSegmentR(sa.isPlayer ? true : sa) * 1.8) ** 2;
        for (let s = 1; s < sa.segments.length; s++) {
          if (Vector2.distSq(sb.head, sa.segments[s]) >= killDsqA) continue;
          if (sb === this.player && this.player.isGhost) break;
          if (sb === this.player && playerInAttack && sa !== this.player) {
            shatterList.push({ snake: sa, fromIndex: s });
          } else if (sa === this.player && sb !== this.player && !this.player.invincible) {
            this.audio.playEnemyBite();
            killSet.add(sb);
          } else {
            killSet.add(sb);
          }
          break;
        }
      }
    }

    for (const s of killSet) this._killSnake(s, playerKillSet.has(s));

    const W = this._worldW, H = this._worldH;
    for (const { snake, fromIndex } of shatterList) {
      if (!snake.alive) continue;
      const MIN_SURVIVE = 5;
      if (fromIndex <= MIN_SURVIVE) {
        this._killSnake(snake, true); continue;
      }
      const severed = snake.segments.splice(fromIndex);
      this.particles.burst(severed, snake.headColor);
      this.audio.playKill();
      for (let i = 0; i < severed.length; i += 2) {
        const seg = severed[i];
        if (seg.x > 10 && seg.x < W - 10 && seg.y > 10 && seg.y < H - 10) {
          const col = FOOD_COLORS[Math.floor(Math.random() * FOOD_COLORS.length)];
          const f = new Food(seg.x + (Math.random() - 0.5) * 8, seg.y + (Math.random() - 0.5) * 8, col, FOOD_TYPE.NORMAL, 10 + Math.random() * 5);
          this.foods.push(f);
          this.foodGrid.add(f);
        }
      }
    }
  }

  /* ── GAME OVER FLOW ─────────────────────────────────────── */
  _runGameOver() {
    this.running = false;
    this._inDangerZone = false;

    const score = this.player.score;
    const elapsed = (performance.now() - this._runStartTime) / 1000;

    // Persist
    const best = HighScore.save(score);
    const p = Profile.get();
    if (score > p.bestScore) { p.bestScore = score; Profile.save(); }

    if (DailyChallenge.isActive) DailyChallenge.saveBest(score);
    if (this._mode === 'timetrial') {
      const prevBest = parseInt(localStorage.getItem(TT_KEY) || '0', 10);
      if (score > prevBest) localStorage.setItem(TT_KEY, String(score));
      const profBest = Profile.get();
      if (score > profBest.bestScoreTimeTrial) { profBest.bestScoreTimeTrial = score; Profile.save(); }
    }

    this._showGameOverCinematic(() => {
      this.finalScore.textContent = score;
      const bestEl = document.getElementById('best-score-value');
      if (bestEl) bestEl.textContent = best;
      const bestDisplay = document.getElementById('best-score-display');
      if (bestDisplay) bestDisplay.style.display = 'block';
      this.scoreDisplay.style.display = 'block';
      this.overlay.classList.remove('hidden');
    });
  }

  _timeTrialEnd() {
    this.running = false;
    this._inDangerZone = false;
    this.audio.playGameOver();

    const score = this.player.score;
    const prevBest = parseInt(localStorage.getItem(TT_KEY) || '0', 10);
    if (score > prevBest) localStorage.setItem(TT_KEY, String(score));
    const p = Profile.get();
    if (score > p.bestScoreTimeTrial) { p.bestScoreTimeTrial = score; Profile.save(); }

    const titleEl = document.getElementById('overlay-title');
    if (titleEl) { titleEl.classList.remove('victory'); titleEl.textContent = `⏱ TIME'S UP!`; }

    this.finalScore.textContent = score;
    const bestEl = document.getElementById('best-score-value');
    if (bestEl) bestEl.textContent = prevBest > score ? prevBest : score;
    const bestDisplay = document.getElementById('best-score-display');
    if (bestDisplay) bestDisplay.style.display = 'block';
    this.scoreDisplay.style.display = 'block';
    this.overlay.classList.remove('hidden');
  }

  /* ── DEATH CINEMATIC ────────────────────────────────────── */
  _showGameOverCinematic(onComplete) {
    this.audio.playGameOver();

    const canvas = this.canvas;
    const ctx    = this.ctx;
    let startTime = null;
    const DURATION = 1200; // ms

    const animate = (ts) => {
      if (!startTime) startTime = ts;
      const elapsed = ts - startTime;
      const t = Math.min(elapsed / DURATION, 1);

      // Logical dimensions for UI placement
      const logW = canvas.width  / this._dpr;
      const logH = canvas.height / this._dpr;

      // Redraw last frame (world) then overlay fade
      this._render();

      ctx.fillStyle = `rgba(0,0,0,${t * 0.85})`;
      ctx.fillRect(0, 0, logW, logH);

      if (t > 0.3) {
        const textAlpha = Math.min(1, (t - 0.3) / 0.4);
        const glitch    = Math.floor(elapsed / 60) % 2 === 0 ? (Math.random() - 0.5) * 16 : 0;
        ctx.save();
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        // Scale font relative to screen width so it's readable on all devices
        const fontSize = Math.max(36, Math.min(72, logW * 0.14));
        ctx.font         = `bold ${Math.round(fontSize)}px "Segoe UI", system-ui, sans-serif`;
        ctx.globalAlpha  = textAlpha;
        ctx.fillStyle    = '#ff2222';
        ctx.shadowColor  = '#ff0000';
        ctx.shadowBlur   = 30;
        ctx.fillText('GAME OVER', logW / 2 + glitch, logH / 2);
        ctx.restore();
      }

      if (elapsed < DURATION) {
        requestAnimationFrame(animate);
      } else {
        onComplete();
      }
    };

    requestAnimationFrame(animate);
  }

}
