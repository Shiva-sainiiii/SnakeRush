/**
 * ═══════════════════════════════════════════════════════════════
 *  SNAKE RUSH — game.js  (Phase 4: Mega Update)
 *  Vanilla JS + HTML5 Canvas. No dependencies.
 *
 *  NEW FEATURES:
 *   ✓ Screen shake (death/kill/wall)
 *   ✓ Hit-stop on kills
 *   ✓ Kill feed (top-right canvas overlay)
 *   ✓ Combo multiplier with floating text
 *   ✓ Snake trails (ring buffer glow)
 *   ✓ Shield power-up (invincibility + aura)
 *   ✓ Ghost power-up (semi-transparent, pass bodies)
 *   ✓ Mine power-up (explosive traps)
 *   ✓ Speed Boost power-up
 *   ✓ Game modes: Classic / Time Trial
 *   ✓ AI Personality types (aggressive/coward/hunter/farmer)
 *   ✓ Flock behavior for aggressive AI
 *   ✓ Virtual joystick (touch)
 *   ✓ Gyroscope steering (optional)
 *   ✓ Achievement system (8 achievements)
 *   ✓ Persistent profile stats
 *   ✓ Daily challenge (seeded RNG)
 *   ✓ Player naming
 *   ✓ Animated electric fence border
 *   ✓ Biome zones (3x3 grid tints)
 *   ✓ Death cinematic (fade + glitch)
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

/* ─────────────────────────────────────────────────────────────
   SAFE STORAGE — thin localStorage wrapper that never throws.
   Some browsers/in-app webviews restrict or fully block
   localStorage (certain privacy modes, some embedded browsers).
   Several call sites used to call localStorage directly with no
   try-catch — including DailyChallenge.check() which runs at
   module-load time — so a blocked localStorage could throw during
   script evaluation and prevent the whole game from loading at
   all. Everything now goes through here instead, falling back to
   an in-memory Map so the game still runs (just without persistence)
   rather than crashing outright.
───────────────────────────────────────────────────────────── */
const SafeStorage = {
  _memory: new Map(),
  _ok: null,
  _available() {
    if (this._ok !== null) return this._ok;
    try {
      const k = '__snakeRush_test__';
      localStorage.setItem(k, '1');
      localStorage.removeItem(k);
      this._ok = true;
    } catch (_) { this._ok = false; }
    return this._ok;
  },
  getItem(key) {
    if (this._available()) {
      try { return localStorage.getItem(key); } catch (_) { /* fall through */ }
    }
    return this._memory.has(key) ? this._memory.get(key) : null;
  },
  setItem(key, value) {
    if (this._available()) {
      try { localStorage.setItem(key, value); return; } catch (_) { /* fall through */ }
    }
    this._memory.set(key, value);
  },
  removeItem(key) {
    if (this._available()) {
      try { localStorage.removeItem(key); return; } catch (_) { /* fall through */ }
    }
    this._memory.delete(key);
  },
};

/* ─────────────────────────────────────────────────────────────
   SETTINGS STORE
───────────────────────────────────────────────────────────── */
const Settings = {
  muted:       false,
  sensitivity: 8,
  design:      'multicolour',
  mode:        'classic',   // 'classic' | 'timetrial'
  gyro:        false,
  face:        null,        // emoji face for player's head, null = classic eyes
};

/* Persist a subset of Settings across sessions (design choice, sensitivity,
   mode) so the player doesn't have to re-pick their skin every visit. Mute
   is deliberately NOT persisted — defaulting to off each visit avoids a
   surprise blast of audio on load. */
(function loadPersistedSettings() {
  try {
    const stored = JSON.parse(SafeStorage.getItem(SETTINGS_KEY) || '{}');
    if (stored.design && typeof stored.design === 'string') Settings.design = stored.design;
    if (typeof stored.sensitivity === 'number') Settings.sensitivity = stored.sensitivity;
    if (stored.mode === 'classic' || stored.mode === 'timetrial') Settings.mode = stored.mode;
    if (typeof stored.face === 'string' || stored.face === null) Settings.face = stored.face;
  } catch(_) {}
})();

function savePersistedSettings() {
  try {
    SafeStorage.setItem(SETTINGS_KEY, JSON.stringify({
      design: Settings.design, sensitivity: Settings.sensitivity, mode: Settings.mode,
      face: Settings.face,
    }));
  } catch(_) {}
}

/* ─────────────────────────────────────────────────────────────
   SNAKE FACE EMOJIS
   Player-selectable + AI-random emoji set for snake heads. Kept as a
   flat list (not grouped) since the settings grid just needs to render
   them all as equal-weight tappable buttons.
───────────────────────────────────────────────────────────── */
const SNAKE_FACE_EMOJIS = [
  '💩','🤡','😈','👿','👽','👺','👹','💀','🤖','😺','😸','😾','😼','😹','😻',
  '🌚','🌝','🌞','🧒🏻','👶🏻','👼🏻','🧑🏻','🧓🏻','🫅🏻',
  '🐵','🦁','🐯','🐱','🐶','🐺','🐻','🐻‍❄️','🐨','🐼','🐹','🐭','🐰','🦊','🐮','🐷','🐸',
  '🎃','💸',
  '😀','😃','😄','😁','😆','😅','😂','🤣','😍','🥰','😘','😚','😙','😗','😉','😭','🤩','🥳',
  '🫠','🙃','🙂','🥲','🥹','😊','😛','😋','🤤','😏','🙂‍↕️','😌','☺️','😝','😜','🤪','🫪',
  '😔','🥺','😬','😑','🤐','🫥','😶‍🌫️','😐','😶','😡','🤬','🤨','😤','😮‍💨','🙄','😒','😠',
  '😓','😟','😥','😢','☹️','🙁','🫤','😕','😳','😲','😯','😮','😦','😧','😨','😰','🤯','😖',
  '😣','😩','😫','😵','😵‍💫','🫨','😪','😴','🫩','🤮','🤢','🥶','🥵','🥴','🤧','🤒','🤕','😷',
  '🤥','😇','🤠','🤑','🤓','😎','🥸',
];

// Rude/menacing subset (drawn from the same list above) used for AI and
// boss snakes — they're the "enemy", so their faces lean aggressive/
// intimidating rather than the full friendly/silly range players can
// pick from for themselves.
const AI_FACE_EMOJIS = [
  '💩','🤡','😈','👿','👽','👺','👹','💀','🤖','😾',
  '😡','🤬','😤','😠','🙄','😒',
];

/* Pre-renders each emoji onto its own small offscreen canvas exactly once,
   then every future draw is a cheap drawImage() instead of a fillText().
   fillText() on canvas is comparatively expensive (font shaping/glyph
   lookup) and doing it every frame for every emoji-faced snake head would
   add up fast with many AI snakes on screen. Caching flips that to a
   single fillText per emoji ever, no matter how many frames or snakes
   reuse it. Resolution is fixed regardless of on-screen size — the head
   circle only ranges from small to boss-sized, so one crisp base texture
   scales fine via drawImage's own scaling. */
const EmojiIconCache = {
  _cache: new Map(),
  _SIZE: 64, // px, fixed render resolution per emoji tile

  get(emoji) {
    if (!emoji) return null;
    let canvas = this._cache.get(emoji);
    if (canvas) return canvas;

    const size = this._SIZE;
    canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const c = canvas.getContext('2d');
    c.clearRect(0, 0, size, size);
    c.font = `${Math.round(size * 0.82)}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    // Slight downward nudge — most emoji fonts render a touch high of
    // true vertical center against their own font metrics.
    c.fillText(emoji, size / 2, size / 2 + size * 0.06);

    this._cache.set(emoji, canvas);
    return canvas;
  },
};

/* ─────────────────────────────────────────────────────────────
   PERSISTENCE KEYS
───────────────────────────────────────────────────────────── */
const HS_KEY           = 'snakeRush_bestScore';
const TT_KEY            = 'snakeRush_timeTrial_best';
const PROFILE_KEY      = 'snakeRush_profile';
const ACHIEVEMENTS_KEY = 'snakeRush_achievements';
const PLAYER_NAME_KEY  = 'snakeRush_playerName';
const DAILY_DATE_KEY   = 'snakeRush_dailyDate';
const DAILY_SCORE_KEY  = 'snakeRush_dailyScore';
const SKINS_KEY         = 'snakeRush_unlockedSkins';
const SETTINGS_KEY      = 'snakeRush_settings';

/* ─────────────────────────────────────────────────────────────
   HIGH SCORE
───────────────────────────────────────────────────────────── */
const HighScore = {
  _cached: null,
  get() {
    if (this._cached === null)
      this._cached = parseInt(SafeStorage.getItem(HS_KEY) || '0', 10);
    return this._cached;
  },
  save(n) {
    const c = this.get();
    if (n > c) { SafeStorage.setItem(HS_KEY, String(n)); this._cached = n; }
    return this._cached;
  },
};

/* ─────────────────────────────────────────────────────────────
   PROFILE — persistent stats
───────────────────────────────────────────────────────────── */
const Profile = {
  _data: null,
  _defaults() {
    return {
      totalKills: 0, totalFoodEaten: 0, totalDeaths: 0,
      totalPlaytimeSeconds: 0, totalRuns: 0,
      bestScore: 0, bestScoreTimeTrial: 0,
    };
  },
  get() {
    if (!this._data) {
      try { this._data = JSON.parse(SafeStorage.getItem(PROFILE_KEY)) || this._defaults(); }
      catch(_) { this._data = this._defaults(); }
      // fill missing keys
      const d = this._defaults();
      for (const k of Object.keys(d)) {
        if (!(k in this._data)) this._data[k] = d[k];
      }
    }
    return this._data;
  },
  save() {
    try { SafeStorage.setItem(PROFILE_KEY, JSON.stringify(this._data)); } catch(_) {}
  },
  add(key, val = 1) { this.get()[key] += val; this.save(); },
  set(key, val) { this.get()[key] = val; this.save(); },
};

/* ─────────────────────────────────────────────────────────────
   SEEDED RNG (mulberry32)
───────────────────────────────────────────────────────────── */
function mulberry32(seed) {
  return function() {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/* ─────────────────────────────────────────────────────────────
   DAILY CHALLENGE
───────────────────────────────────────────────────────────── */
const DailyChallenge = {
  isActive: false,
  aiCount: 10,
  foodCount: 320,
  worldMod: 1.0,
  enabledPowerups: ['magnet','attack','lifeline','shield','ghost','mine','speed'],

  check() {
    const today = new Date().toDateString();
    const stored = SafeStorage.getItem(DAILY_DATE_KEY);
    if (stored !== today) {
      SafeStorage.setItem(DAILY_DATE_KEY, today);
      SafeStorage.removeItem(DAILY_SCORE_KEY);
    }
    // generate today's seed-based parameters
    const rng = mulberry32(hashStr(today));
    this.aiCount    = 8 + Math.floor(rng() * 5);     // 8-12
    this.foodCount  = 280 + Math.floor(rng() * 101); // 280-380
    this.worldMod   = 0.85 + rng() * 0.30;           // 0.85-1.15
    const allPU = ['magnet','attack','lifeline','shield','ghost','mine','speed'];
    this.enabledPowerups = allPU.filter(() => rng() > 0.3);
    if (this.enabledPowerups.length === 0) this.enabledPowerups = allPU;
  },

  saveBest(score) {
    const prev = parseInt(SafeStorage.getItem(DAILY_SCORE_KEY) || '0', 10);
    if (score > prev) SafeStorage.setItem(DAILY_SCORE_KEY, String(score));
  },
};
DailyChallenge.check();

/* ─────────────────────────────────────────────────────────────
   SNAKE NAMES
───────────────────────────────────────────────────────────── */
const NAME_ADJECTIVES = [
  'Crimson','Shadow','Neon','Silent','Blazing','Iron','Toxic','Arctic',
  'Phantom','Void','Storm','Venom','Cosmic','Frozen','Electric','Savage',
  'Ancient','Golden','Jade','Obsidian',
];
const NAME_NOUNS = [
  'Viper','Fang','Scale','Coil','Striker','Hydra','Serpent','Cobra',
  'Mamba','Python','Rattler','Asp','Boa','Anaconda','Adder','Racer',
  'King','Sidewinder','Taipan','Bushmaster',
];

function generateName(rng = Math.random.bind(Math)) {
  const adj  = NAME_ADJECTIVES[Math.floor(rng() * NAME_ADJECTIVES.length)];
  const noun = NAME_NOUNS[Math.floor(rng() * NAME_NOUNS.length)];
  return `${adj} ${noun}`;
}

function getPlayerName() {
  let name = SafeStorage.getItem(PLAYER_NAME_KEY);
  if (!name) {
    name = generateName();
    SafeStorage.setItem(PLAYER_NAME_KEY, name);
  }
  return name;
}

function setPlayerName(name) {
  SafeStorage.setItem(PLAYER_NAME_KEY, name.trim() || generateName());
}

/* ─────────────────────────────────────────────────────────────
   KILL FEED
───────────────────────────────────────────────────────────── */
class KillFeed {
  constructor() {
    this._entries = [];
    this._maxEntries = 4;
    this._fadeDuration = 4;
  }

  add(msg) {
    this._entries.unshift({ msg, age: 0 });
    if (this._entries.length > this._maxEntries)
      this._entries.length = this._maxEntries;
  }

  addKill(victimName)      { this.add(`🗡️ You killed ${victimName}`); }
  addEliminated(victimName){ this.add(`💀 ${victimName} eliminated`); }

  update(dt) {
    for (const e of this._entries) e.age += dt;
    this._entries = this._entries.filter(e => e.age < this._fadeDuration);
  }

  draw(ctx, canvasW) {
    // Offset below minimap: on narrow screens the minimap starts lower
    const isNarrow = canvasW < 480;
    const x = canvasW - 16;
    // On narrow screens the minimap is pushed down ~66px from top, so push
    // kill-feed entries below it (110px map + 8px pad + 66px offset ≈ 190)
    let y = isNarrow ? 190 : 74;
    ctx.save();
    ctx.textAlign    = 'right';
    ctx.textBaseline = 'top';
    ctx.font         = `bold ${isNarrow ? 10 : 12}px "Segoe UI", system-ui, sans-serif`;

    for (const e of this._entries) {
      const alpha = Math.max(0, 1 - (e.age / this._fadeDuration) * 1.2);
      ctx.globalAlpha  = alpha;
      ctx.shadowColor  = 'rgba(0,0,0,0.8)';
      ctx.shadowBlur   = 6;
      ctx.fillStyle    = e.msg.startsWith('🗡️') ? '#7effb2' : '#ff8888';
      ctx.fillText(e.msg, x, y);
      y += isNarrow ? 16 : 20;
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur  = 0;
    ctx.restore();
  }
}

/* ─────────────────────────────────────────────────────────────
   COMBO MULTIPLIER
───────────────────────────────────────────────────────────── */
class ComboManager {
  constructor() {
    this.count     = 0;
    this._timer    = 0;
    this._window   = 3;   // seconds
    this._floats   = [];  // floating text entries
  }

  eat(onCombo) {
    this.count++;
    this._timer = this._window;
    if (this.count >= 3) onCombo(this.count);
  }

  reset() { this.count = 0; this._timer = 0; }

  get multiplier() {
    if (this.count >= 10) return 4;
    if (this.count >= 5)  return 3;
    if (this.count >= 3)  return 2;
    return 1;
  }

  addFloat(x, y, count) {
    let msg = `x${count} COMBO`;
    if (count >= 10) msg = `x${count} MEGA COMBO!!`;
    else if (count >= 5) msg = `x${count} COMBO!`;
    this._floats.push({ x, y, age: 0, life: 1.8, msg });
  }

  update(dt) {
    if (this._timer > 0) {
      this._timer -= dt;
      if (this._timer <= 0) this.reset();
    }
    for (const f of this._floats) f.age += dt;
    this._floats = this._floats.filter(f => f.age < f.life);
  }

  draw(ctx, camX, camY) {
    ctx.save();
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    for (const f of this._floats) {
      const t     = f.age / f.life;
      const alpha = 1 - t;
      const sy    = f.y - camY - t * 60;
      const sx    = f.x - camX;
      const size  = 16 + (1 - t) * 8;

      ctx.globalAlpha = alpha;
      ctx.font        = `bold ${Math.round(size)}px "Segoe UI", system-ui, sans-serif`;
      ctx.shadowColor = '#ffd04b';
      ctx.shadowBlur  = 12;
      ctx.fillStyle   = '#ffd04b';
      ctx.fillText(f.msg, sx, sy);
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur  = 0;
    ctx.restore();
  }
}

/* ─────────────────────────────────────────────────────────────
   SCREEN SHAKE
───────────────────────────────────────────────────────────── */
class ScreenShake {
  constructor() {
    this._intensity = 0;
    this._duration  = 0;
    this._timer     = 0;
  }

  trigger(intensity, duration = 0.3) {
    if (intensity > this._intensity) {
      this._intensity = intensity;
      this._duration  = duration;
      this._timer     = duration;
    }
  }

  update(dt) {
    if (this._timer > 0) this._timer = Math.max(0, this._timer - dt);
  }

  getOffset() {
    if (this._timer <= 0) return { x: 0, y: 0 };
    const t = this._timer / this._duration;
    const mag = this._intensity * t;
    return {
      x: (Math.random() - 0.5) * mag * 2,
      y: (Math.random() - 0.5) * mag * 2,
    };
  }
}

/* ─────────────────────────────────────────────────────────────
   ACHIEVEMENT MANAGER
───────────────────────────────────────────────────────────── */
const ACHIEVEMENTS_DEF = [
  { id: 'first_blood',   name: 'First Blood',    desc: 'Get your first kill.' },
  { id: 'big_boi',       name: 'Big Boi',         desc: 'Reach length 80.' },
  { id: 'untouchable',   name: 'Untouchable',     desc: 'Survive 3 minutes without dying.' },
  { id: 'combo_king',    name: 'Combo King',      desc: 'Hit x10 combo.' },
  { id: 'exterminator',  name: 'Exterminator',    desc: 'Kill 5 snakes in one run.' },
  { id: 'speed_demon',   name: 'Speed Demon',     desc: 'Collect Speed Boost 3x in one run.' },
  { id: 'hoarder',       name: 'Hoarder',         desc: 'Eat 200 food in one run.' },
  { id: 'boss_slayer',   name: 'Boss Slayer',     desc: 'Defeat a Titan Serpent.' },
];

class AchievementManager {
  constructor() {
    this._unlocked = new Set();
    this._toasts   = [];
    this._load();
    // Catch up any skins tied to achievements already unlocked before this
    // check existed (or before the player earned them) — see
    // SkinSystem.syncWithAchievements for why this is needed.
    if (typeof SkinSystem !== 'undefined') SkinSystem.syncWithAchievements(this._unlocked);

    // Per-run counters
    this.runKills       = 0;
    this.runFood        = 0;
    this.runSpeedBoosts = 0;
    this.surviveTimer   = 0;
    this.died           = false;
  }

  _load() {
    try {
      const data = JSON.parse(SafeStorage.getItem(ACHIEVEMENTS_KEY) || '[]');
      this._unlocked = new Set(data);
    } catch(_) { this._unlocked = new Set(); }
  }

  _save() {
    try {
      SafeStorage.setItem(ACHIEVEMENTS_KEY, JSON.stringify([...this._unlocked]));
    } catch(_) {}
  }

  get unlockedCount() { return this._unlocked.size; }

  unlock(id) {
    if (this._unlocked.has(id)) return;
    const def = ACHIEVEMENTS_DEF.find(a => a.id === id);
    if (!def) return;
    this._unlocked.add(id);
    this._save();
    this._toasts.push({ name: def.name, age: 0, life: 3.5 });
    Haptics.achievement();
    // Update overlay count
    const el = document.getElementById('achievement-count');
    if (el) el.textContent = `${this._unlocked.size} / ${ACHIEVEMENTS_DEF.length}`;
    // Some skins unlock alongside a specific achievement — check now.
    if (typeof SkinSystem !== 'undefined') SkinSystem.checkAchievement(id);
  }

  resetRun() {
    this.runKills = 0; this.runFood = 0;
    this.runSpeedBoosts = 0; this.surviveTimer = 0; this.died = false;
  }

  onKill()       { this.runKills++; if (this.runKills === 1) this.unlock('first_blood'); if (this.runKills >= 5) this.unlock('exterminator'); }
  onLength(l)    { if (l >= 80) this.unlock('big_boi'); }
  onFood()       { this.runFood++; if (this.runFood >= 200) this.unlock('hoarder'); }
  onCombo10()    { this.unlock('combo_king'); }
  onSpeedBoost() { this.runSpeedBoosts++; if (this.runSpeedBoosts >= 3) this.unlock('speed_demon'); }
  onDeath()      { this.died = true; this.surviveTimer = 0; }
  onBossKill()   { this.unlock('boss_slayer'); }

  update(dt) {
    if (!this.died) {
      this.surviveTimer += dt;
      if (this.surviveTimer >= 180) this.unlock('untouchable');
    }
    for (const t of this._toasts) t.age += dt;
    this._toasts = this._toasts.filter(t => t.age < t.life);
  }

  draw(ctx, logW, logH) {
    if (this._toasts.length === 0) return;
    ctx.save();
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';

    // Scale toast width to available screen real estate
    const toastW = Math.min(320, logW - 32);
    let iy = logH - 60 - (this._toasts.length - 1) * 46;
    for (const t of this._toasts) {
      const alpha = t.age > t.life - 0.5 ? (t.life - t.age) / 0.5 : 1;
      ctx.globalAlpha = alpha;

      const w = toastW, h = 38, x = (logW - w) / 2, y = iy - h / 2;
      ctx.fillStyle   = 'rgba(5,12,20,0.92)';
      ctx.shadowColor = '#ffd04b';
      ctx.shadowBlur  = 16;
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, 8);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,208,75,0.5)';
      ctx.lineWidth   = 1.5;
      ctx.stroke();
      ctx.shadowBlur  = 0;

      ctx.fillStyle = '#ffd04b';
      // Scale font so long names don't overflow on narrow screens
      const fontSize = logW < 400 ? 11 : 13;
      ctx.font      = `bold ${fontSize}px "Segoe UI", system-ui, sans-serif`;
      ctx.fillText(`🏆 Achievement Unlocked: ${t.name}`, logW / 2, iy);
      iy += 46;
    }

    ctx.globalAlpha = 1;
    ctx.restore();
  }
}

/* ─────────────────────────────────────────────────────────────
   MINE
───────────────────────────────────────────────────────────── */
class Mine {
  constructor(x, y) {
    this.pos    = new Vector2(x, y);
    this.age    = 0;
    this.life   = 10;   // 10 second TTL
    this.radius = 14;
    this.active = true;
  }

  get expired() { return !this.active || this.age >= this.life; }

  update(dt) { this.age += dt; }

  draw(ctx, camX, camY) {
    if (this.expired) return;
    const sx = this.pos.x - camX;
    const sy = this.pos.y - camY;
    const dpr  = window._game ? window._game._dpr : 1;
    const logW = ctx.canvas.width  / dpr;
    const logH = ctx.canvas.height / dpr;
    if (sx < -40 || sx > logW + 40 || sy < -40 || sy > logH + 40) return;

    const pulse = 0.5 + 0.5 * Math.sin(Date.now() * 0.007);
    const r = this.radius + pulse * 3;
    const ttlFrac = 1 - this.age / this.life;

    ctx.save();
    ctx.globalAlpha = 0.5 + ttlFrac * 0.5;
    ctx.shadowColor = '#ff9f40';
    ctx.shadowBlur  = 16 + pulse * 10;

    // Outer glow ring
    ctx.beginPath();
    ctx.arc(sx, sy, r + 6, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,159,64,${(0.25 + pulse * 0.3).toFixed(2)})`;
    ctx.lineWidth   = 2;
    ctx.stroke();

    // Body
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle = '#cc5500';
    ctx.fill();

    // Bomb symbol
    ctx.shadowBlur  = 0;
    ctx.fillStyle   = '#fff';
    ctx.font        = `bold ${Math.round(r * 1.1)}px sans-serif`;
    ctx.textAlign   = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('💣', sx, sy + 1);

    ctx.globalAlpha = 1;
    ctx.restore();
  }
}

/* ─────────────────────────────────────────────────────────────
   CONSTANTS
───────────────────────────────────────────────────────────── */
// Mobile devices (especially mid-range Android/iOS) have noticeably less
// headroom than desktop for per-frame collision checks (O(snakes^2) head
// checks + O(snakes x segments) body checks) and for filling extra canvas
// pixels at high DPR. Detect coarsely via touch support + viewport width
// and trim world population accordingly — gameplay stays the same shape,
// just fewer simultaneous AI/food on the smaller/weaker screens that need it.
const _IS_MOBILE = (('ontouchstart' in window) || navigator.maxTouchPoints > 0)
                    && Math.min(window.innerWidth, window.innerHeight) < 900;

// World doubled (5500 -> 11000): at 5-6k length the AI roster also grows
// huge, and with everyone crammed into the old 5500x5500 map the per-frame
// O(nearby snakes) collision buckets and body-segment checks all had way
// more overlapping candidates to test, which is what caused the lag.
// Doubling the map spreads the same snake/food population over 4x the
// area, cutting local density (and therefore collision-check load) without
// changing any gameplay rules.
const WORLD_W       = 11000;
const WORLD_H       = 11000;
const FOOD_COUNT    = _IS_MOBILE ? 1500 : 2500;
const AI_COUNT      = _IS_MOBILE ? 9   : 14;
const SEGMENT_GAP   = 8;
const SEGMENT_R_BASE = 9;

// Perf cap: above this many physics segments, the snake stops growing its
// actual segment array and instead grows a "girth" multiplier (thicker
// body, same segment count). This keeps _moveSegments()/collision cost
// bounded even after eating thousands of food — score/length shown in the
// UI keeps counting normally, only the simulated body length is capped.
const MAX_PHYSICS_SEGMENTS = 600;
// Girth curve tuning. The old formula was linear (+0.0018 per extra
// segment) and hit its MAX_GIRTH_MUL ceiling by ~length 3900 — so a
// length-6000 snake and a length-900,000 snake ended up the exact same
// thickness, which read as "growth just stopped". This sqrt-based curve
// keeps growing visibly across a much wider range: fast-ish early on,
// then gradually slowing, but still inching thicker even past a million
// length instead of going flat.
const MAX_GIRTH_MUL       = 3.2;
const GIRTH_CURVE_HALFLEN = 40000; // extra-length at which growth is ~halfway to max

const BASE_SPEED    = 190;
const BOOST_SPEED   = 300;
const BOOST_DRAIN   = 0.6;
const SELF_SKIP     = 8;

const SPEED_SMALL_MUL  = 1.13;
const SPEED_LARGE_MUL  = 0.87;
const SPEED_SCALE_MIN  = 10;
const SPEED_SCALE_MAX  = 80;

const H2H_UPSET_THRESHOLD = 15;

/* Power-ups & lives */
const PLAYER_LIVES       = 3;
const IFRAME_DURATION    = 2.5;
const MAGNET_DURATION    = 7;
const MAGNET_RADIUS      = 280;
const MAGNET_PULL_FORCE  = 220;

// Permanent passive magnet on the player's head — always on, much weaker
// than the power-up version above. Meant to take the edge off manually
// chasing every nearby food pellet (especially now that AI reacts faster),
// not to replace normal food-seeking. Player-only; AI snakes don't get it.
//
// Note on tuning: the player's own movement speed (130-220 with boost) is
// much faster than food's pull speed can be across most of this radius
// with a plain linear (1 - dist/radius) falloff — food near the outer edge
// gets barely any pull, so if the player is moving away from it, the food
// visually "loses the race" and looks like it's fleeing even though it's
// still technically being pulled. PASSIVE_MAGNET_MIN_STRENGTH sets a floor
// so pull is meaningful across the whole radius, not just right next to
// the head.
const PASSIVE_MAGNET_RADIUS       = 30;   // tight but actually functional (> eat radius)
const PASSIVE_MAGNET_FORCE        = 400;
const PASSIVE_MAGNET_MIN_STRENGTH = 0.7;
const ATTACK_DURATION    = 8;
const SHIELD_DURATION    = 4;
const GHOST_DURATION     = 4;
const MINE_DURATION      = 8;    // mine powerup active time
const SPEED_BOOST_DURATION = 5;
const SPEED_BOOST_MUL    = 1.4;
const MINE_DEPLOY_INTERVAL = 2;  // seconds between mine drops
const MINE_MAX           = 3;
const MINE_TRIGGER_R     = 60;
const MINE_KILL_R        = 80;

const POWERUP_SPAWN_RATE     = 0.004;
// ATTACK (red) food used to share POWERUP_SPAWN_RATE with magnet. Split
// into its own rate and raised — needed more often to fight/defend against
// the huge snakes that show up once lengths climb into the thousands.
const ATTACK_SPAWN_RATE      = 0.009;
const LIFELINE_SPAWN_RATE    = 0.002;
const SHIELD_SPAWN_RATE      = 0.003;
const GHOST_SPAWN_RATE       = 0.003;
const MINE_SPAWN_RATE        = 0.003;
const SPEED_SPAWN_RATE       = 0.003;
const LIFELINE_MAX_ON_MAP    = 1;
const SHIELD_MAX_ON_MAP      = 1;
const GHOST_MAX_ON_MAP       = 1;
const MINE_MAX_ON_MAP        = 1;
const SPEED_MAX_ON_MAP       = 1;

const NEAR_SNAKE_RADIUS  = 100;
const DANGER_ZONE_DIST   = 250;

// Boss Snake: seconds between Titan Serpent spawns (only one alive at a
// time). Randomized within a range each time instead of a fixed interval,
// so a player can't predict exactly when the next Titan will show up.
const BOSS_INTERVAL_MIN = 70;
const BOSS_INTERVAL_MAX = 110;
function rollBossInterval() {
  return BOSS_INTERVAL_MIN + Math.random() * (BOSS_INTERVAL_MAX - BOSS_INTERVAL_MIN);
}

/* ─────────────────────────────────────────────────────────────
   DIFFICULTY CURVE — the longer a run goes, the sharper/more
   aggressive AI steering becomes, so long sessions don't stay easy
   forever. Ramps in gradually over DIFFICULTY_RAMP_SECONDS and caps
   out at DIFFICULTY_MAX_BONUS so it stays fair rather than becoming
   impossible.
───────────────────────────────────────────────────────────── */
const DIFFICULTY_RAMP_SECONDS = 480; // 8 minutes to reach max difficulty
const DIFFICULTY_MAX_BONUS    = 0.35; // up to +35% sense radius / force / turn speed

// Returns 0..1 based on how far into the difficulty ramp the run is.
function getDifficultyT(elapsedSeconds) {
  return Math.max(0, Math.min(1, elapsedSeconds / DIFFICULTY_RAMP_SECONDS));
}

/* ─────────────────────────────────────────────────────────────
   RANDOM EVENTS — occasional short-lived world events to keep long
   sessions feeling fresh. Rolled periodically during a run; only one
   event runs at a time.
───────────────────────────────────────────────────────────── */
const RANDOM_EVENT_CHECK_INTERVAL = 45;  // how often to roll for a new event
const RANDOM_EVENT_CHANCE         = 0.35; // chance per check once eligible
const RANDOM_EVENT_MIN_GAP        = 60;  // minimum seconds between events
const FOOD_RAIN_COUNT             = 40;
const FOOD_RAIN_DURATION          = 8;
const DOUBLE_SCORE_DURATION       = 15;

/* Designer palette */
const DESIGNER_PALETTES = [
  ['#a855f7', '#d8b4fe'],
  ['#f97316', '#fdba74'],
  ['#06b6d4', '#67e8f9'],
  ['#ec4899', '#f9a8d4'],
  ['#84cc16', '#bef264'],
];

const MULTICOLOUR_PALETTE = [
  '#ff5e57','#ffa41b','#ffdd00','#7bff6a',
  '#00d2ff','#8c52ff','#ff52c0','#52ffca',
];

/* ─────────────────────────────────────────────────────────────
   SKINS — the 4 original styles are free from the start; the rest
   unlock via achievements or score milestones so returning players
   have something new to chase. Each skin is either a flat body
   colour+head pair (solid), or a repeating segment palette like the
   built-in Multicolour style (palette).
───────────────────────────────────────────────────────────── */
const SKINS_DEF = [
  { id: 'multicolour', name: 'Multicolour', kind: 'palette', palette: MULTICOLOUR_PALETTE,
    head: '#ffffff', unlock: null },
  { id: 'fatty',       name: 'Fatty',       kind: 'solid', body: '#7bff6a', head: '#c8ffc0',
    unlock: null },
  { id: 'thin',        name: 'Thin',        kind: 'solid', body: '#52ffca', head: '#c8fff0',
    unlock: null },
  { id: 'designer',    name: 'Designer',    kind: 'designer',
    unlock: null },

  { id: 'crimson',     name: 'Crimson Fang', kind: 'palette',
    palette: ['#ff2b2b', '#ff6a3b', '#ffb23b'], head: '#ffdede',
    unlock: { type: 'achievement', id: 'first_blood', label: 'Get your first kill' } },
  { id: 'toxic',       name: 'Toxic Coil',   kind: 'palette',
    palette: ['#7bff2b', '#c6ff3b', '#2bffb2'], head: '#e8ffe0',
    unlock: { type: 'achievement', id: 'exterminator', label: 'Kill 5 snakes in one run' } },
  { id: 'royal',       name: 'Royal Serpent', kind: 'palette',
    palette: ['#8c52ff', '#c052ff', '#5271ff'], head: '#f0e0ff',
    unlock: { type: 'achievement', id: 'boss_slayer', label: 'Defeat a Titan Serpent' } },
  { id: 'gilded',      name: 'Gilded Legend', kind: 'palette',
    palette: ['#ffd23b', '#ffea8a', '#fff6c9'], head: '#fffbe0',
    unlock: { type: 'score', value: 5000, label: 'Score 5,000+ in one run' } },
];

const SkinSystem = {
  _unlocked: null,

  _load() {
    if (this._unlocked) return this._unlocked;
    try {
      const stored = JSON.parse(SafeStorage.getItem(SKINS_KEY) || '[]');
      this._unlocked = new Set(stored);
    } catch(_) { this._unlocked = new Set(); }
    // Free skins are always unlocked, even on a fresh profile.
    for (const s of SKINS_DEF) if (!s.unlock) this._unlocked.add(s.id);
    return this._unlocked;
  },

  _save() {
    try { SafeStorage.setItem(SKINS_KEY, JSON.stringify([...this._unlocked])); } catch(_) {}
  },

  isUnlocked(id) { return this._load().has(id); },

  unlock(id) {
    this._load();
    if (this._unlocked.has(id)) return false;
    this._unlocked.add(id);
    this._save();
    return true;
  },

  // Called whenever an achievement unlocks or a run's score is finalized —
  // checks if any skin's unlock condition is now met.
  checkAchievement(achievementId) {
    for (const s of SKINS_DEF) {
      if (s.unlock && s.unlock.type === 'achievement' && s.unlock.id === achievementId) {
        if (this.unlock(s.id)) this._announce(s);
      }
    }
  },
  checkScore(score) {
    for (const s of SKINS_DEF) {
      if (s.unlock && s.unlock.type === 'score' && score >= s.unlock.value) {
        if (this.unlock(s.id)) this._announce(s);
      }
    }
  },

  // Retroactive sync: AchievementManager.unlock() early-returns when an
  // achievement is already unlocked, so it never re-fires checkAchievement
  // for achievements a player had already earned before a new skin was
  // tied to them (or before this skin system existed at all). Without
  // this, those players would need to somehow trigger the achievement's
  // "first time" condition again — e.g. get a "first" kill despite
  // already having 50 — which is effectively impossible. Called once at
  // startup against whatever achievements are already unlocked. Silent
  // (no toast) since this isn't a new accomplishment, just catching up
  // bookkeeping that should've already been in sync.
  syncWithAchievements(unlockedAchievementIds) {
    let changed = false;
    for (const s of SKINS_DEF) {
      if (s.unlock && s.unlock.type === 'achievement' && unlockedAchievementIds.has(s.unlock.id)) {
        if (this.unlock(s.id)) changed = true;
      }
    }
    return changed;
  },

  _announce(skin) {
    // Reuses the achievement toast queue if present so the unlock shows
    // up the same way achievement pop-ups do, without a second UI system.
    const mgr = window._game && window._game.achievements;
    if (mgr && mgr._toasts) mgr._toasts.push({ name: `🎨 Skin Unlocked: ${skin.name}`, age: 0, life: 3.5 });
    // Let the UI (skin selector grid) know so it can drop the lock icon
    // immediately, even if the settings modal is open right now.
    window.dispatchEvent(new CustomEvent('snakeRushSkinUnlocked', { detail: { skinId: skin.id } }));
  },
};

/* AI striped body patterns — each is a repeating colour sequence applied
   segment-by-segment (like the player's multicolour design), giving each
   AI snake a distinct visual identity instead of one flat body colour.
   Head colour is picked separately per-snake (see randomAIPalette) so the
   head still reads clearly against the striped body. */
const AI_STRIPE_PATTERNS = [
  ['#ff3b3b', '#ffd23b'],                         // red / yellow
  ['#ffd23b', '#3ba6ff', '#3bffa0'],               // yellow / blue / green
  ['#ff3ba0', '#3b3bff'],                          // pink / blue
  ['#3bffcf', '#ff8a3b'],                          // teal / orange
  ['#b23bff', '#3bff5e'],                          // purple / green
  ['#ff3b3b', '#ffffff'],                          // red / white
  ['#3bd6ff', '#ffe23b', '#ff3b7a'],                // cyan / yellow / pink
  ['#7cff3b', '#3b5eff', '#ff3b3b'],                // green / blue / red
  ['#ff9a3b', '#3bffdd'],                          // amber / aqua
  ['#ff3bd6', '#3bff8a', '#ffe23b'],                // magenta / green / yellow
];

/* Biome definitions (3x3 grid) */
const BIOMES = [
  { name: 'Void',      color: 'rgba(0,0,0,0.04)' },
  { name: 'Neon City', color: 'rgba(0,255,255,0.025)' },
  { name: 'Deep Ocean',color: 'rgba(0,40,200,0.035)' },
  { name: 'Lava',      color: 'rgba(220,40,0,0.03)' },
  { name: 'Forest',    color: 'rgba(0,180,0,0.03)' },
  { name: 'Ice',       color: 'rgba(160,220,255,0.03)' },
  { name: 'Desert',    color: 'rgba(210,140,0,0.03)' },
  { name: 'Storm',     color: 'rgba(100,0,200,0.03)' },
  { name: 'Plasma',    color: 'rgba(220,0,180,0.03)' },
];

/* ─────────────────────────────────────────────────────────────
   1. VECTOR2
───────────────────────────────────────────────────────────── */
class Vector2 {
  constructor(x = 0, y = 0) { this.x = x; this.y = y; }
  add(v)     { return new Vector2(this.x + v.x, this.y + v.y); }
  sub(v)     { return new Vector2(this.x - v.x, this.y - v.y); }
  scale(s)   { return new Vector2(this.x * s, this.y * s); }
  dot(v)     { return this.x * v.x + this.y * v.y; }
  lengthSq() { return this.x * this.x + this.y * this.y; }
  length()   { return Math.sqrt(this.lengthSq()); }
  normalize() {
    const l = this.length();
    return l > 0.0001 ? this.scale(1 / l) : new Vector2(0, 0);
  }
  clamp(maxLen) {
    const l = this.length();
    return l > maxLen ? this.scale(maxLen / l) : new Vector2(this.x, this.y);
  }
  lerp(v, t) {
    return new Vector2(this.x + (v.x - this.x) * t, this.y + (v.y - this.y) * t);
  }
  angle() { return Math.atan2(this.y, this.x); }
  static fromAngle(a, mag = 1) { return new Vector2(Math.cos(a) * mag, Math.sin(a) * mag); }
  static distSq(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y;
    return dx * dx + dy * dy;
  }
  static dist(a, b) { return Math.sqrt(Vector2.distSq(a, b)); }
}

/* ─────────────────────────────────────────────────────────────
   1b. AUDIO MANAGER
───────────────────────────────────────────────────────────── */
/* ─────────────────────────────────────────────────────────────
   HAPTICS — short vibration bursts for key moments (kill, death,
   powerup, hit). Mobile-only in practice (navigator.vibrate isn't
   supported on iOS Safari or desktop Chrome), and always no-ops
   safely where unsupported rather than throwing.
───────────────────────────────────────────────────────────── */
const Haptics = {
  _supported: typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function',
  _pattern(p) {
    if (!this._supported) return;
    try { navigator.vibrate(p); } catch (_) {}
  },
  eat()       { this._pattern(8); },
  powerup()   { this._pattern([10, 30, 10]); },
  kill()      { this._pattern([15, 40, 15]); },
  hit()       { this._pattern(35); },
  death()     { this._pattern([60, 60, 90]); },
  achievement(){ this._pattern([10, 20, 10, 20, 25]); },
};

class AudioManager {
  constructor() {
    this._ctx = null;
    this._buffers = {};
    this._bgNode = null;
    this._panicNode = null;
    this._runNode = null;
    this._ready = false;
    this._bgPlaying = false;
    this._panicOn = false;
    this._runOn = false;
    this._nearCooldown = 0;
    this._biteCooldown = 0;
    this._tracks = {
  bg:        'assets/bgmusic.mp3',
  eat:       'assets/eat.mp3',
  panic:     'assets/panic.mp3',
  gameover:  'assets/gameover.mp3',
  magnet:    'assets/magnet.mp3',
  run:       'assets/run.mp3',
  enemybite: 'assets/enemybite.mp3',
  nearsnake: 'assets/nearsnake.mp3',
  kill:      'assets/kill.mp3',
  lifeline:  'assets/lifeline.mp3',
  bossroar:  'assets/bossroar.mp3',
  bosskill:  'assets/bosskill.mp3',
};
    const unlock = () => {
      this._init();
      window.removeEventListener('click', unlock);
      window.removeEventListener('touchstart', unlock);
    };
    window.addEventListener('click', unlock, { once: true });
    window.addEventListener('touchstart', unlock, { once: true });
  }

  async _init() {
    if (this._ctx) return;
    try {
      this._ctx = new (window.AudioContext || window.webkitAudioContext)();
      await Promise.all(Object.entries(this._tracks).map(([n, u]) => this._load(n, u)));
      this._ready = true;
      this.playBg();
    } catch(e) { console.warn('[AudioManager] init failed:', e); }
  }

  async _load(name, url) {
    try {
      const resp = await fetch(url);
      const arr  = await resp.arrayBuffer();
      this._buffers[name] = await this._ctx.decodeAudioData(arr);
    } catch(e) { console.warn(`[AudioManager] failed to load ${name}:`, e); }
  }

  get _canPlay() { return this._ready && !Settings.muted; }

  _play(name, loop = false, volume = 1) {
    if (!this._canPlay || !this._buffers[name]) return null;
    const src  = this._ctx.createBufferSource();
    const gain = this._ctx.createGain();
    src.buffer      = this._buffers[name];
    src.loop        = loop;
    gain.gain.value = volume;
    src.connect(gain);
    gain.connect(this._ctx.destination);
    src.start(0);
    return src;
  }

  playBg() {
    if (!this._canPlay || this._bgPlaying) return;
    this._bgNode    = this._play('bg', true, 0.35);
    this._bgPlaying = !!this._bgNode;
  }
  stopBg() {
    if (this._bgNode) { try { this._bgNode.stop(); } catch(_) {} }
    this._bgNode = null; this._bgPlaying = false;
  }
  playEat()  { this._play('eat', false, 0.7); }
  playMagnet() {
    const n = this._play('magnet', false, 0.8);
    if (n) { try { n.stop(this._ctx.currentTime + 4); } catch(_) {} }
  }
  playKill() { this._play('kill', false, 0.9); }
  playLifeline() {
    const n = this._play('lifeline', false, 0.85);
    if (n) { try { n.stop(this._ctx.currentTime + 4); } catch(_) {} }
  }
  playEnemyBite() {
    if (this._biteCooldown > 0) return;
    this._play('enemybite', false, 0.9);
    this._biteCooldown = 0.8;
  }
  playNearSnake() {
    if (this._nearCooldown > 0) return;
    this._play('nearsnake', false, 0.6);
    this._nearCooldown = 1.5;
  }
  playGameOver() {
    this.stopBg(); this.stopPanic(); this.stopRun();
    this._play('gameover', false, 0.9);
  }
  playBossRoar() { this._play('bossroar', false, 0.9); }
  playBossKill() { this._play('bosskill', false, 1.0); }
  startPanic() {
    if (this._panicOn) return;
    this._panicNode = this._play('panic', true, 0.55);
    this._panicOn = !!this._panicNode;
  }
  stopPanic() {
    if (this._panicNode) { try { this._panicNode.stop(); } catch(_) {} }
    this._panicNode = null; this._panicOn = false;
  }
  startRun() {
    if (this._runOn) return;
    this._runNode = this._play('run', true, 0.5);
    this._runOn = !!this._runNode;
  }
  stopRun() {
    if (this._runNode) { try { this._runNode.stop(); } catch(_) {} }
    this._runNode = null; this._runOn = false;
  }
  tickCooldowns(dt) {
    if (this._biteCooldown > 0) this._biteCooldown = Math.max(0, this._biteCooldown - dt);
    if (this._nearCooldown > 0) this._nearCooldown = Math.max(0, this._nearCooldown - dt);
  }
  applyMuteSetting() {
    if (Settings.muted) {
      this.stopBg(); this.stopPanic(); this.stopRun();
    } else {
      this.playBg();
      const game = window._game;
      if (game) {
        if (game._inDangerZone) this.startRun();
        if (game.player && game.player.lives === 1 && game.player.alive) this.startPanic();
      }
    }
  }
}

/* ─────────────────────────────────────────────────────────────
   2. SPATIAL GRID
───────────────────────────────────────────────────────────── */
