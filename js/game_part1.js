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
   SETTINGS STORE
───────────────────────────────────────────────────────────── */
const Settings = {
  muted:       false,
  sensitivity: 8,
  design:      'multicolour',
  mode:        'classic',   // 'classic' | 'timetrial'
  gyro:        false,
};

/* ─────────────────────────────────────────────────────────────
   PERSISTENCE KEYS
───────────────────────────────────────────────────────────── */
const HS_KEY           = 'snakeRush_bestScore';
const TT_KEY           = 'snakeRush_timeTrial_best';
const PROFILE_KEY      = 'snakeRush_profile';
const ACHIEVEMENTS_KEY = 'snakeRush_achievements';
const PLAYER_NAME_KEY  = 'snakeRush_playerName';
const DAILY_DATE_KEY   = 'snakeRush_dailyDate';
const DAILY_SCORE_KEY  = 'snakeRush_dailyScore';

/* ─────────────────────────────────────────────────────────────
   HIGH SCORE
───────────────────────────────────────────────────────────── */
const HighScore = {
  _cached: null,
  get() {
    if (this._cached === null)
      this._cached = parseInt(localStorage.getItem(HS_KEY) || '0', 10);
    return this._cached;
  },
  save(n) {
    const c = this.get();
    if (n > c) { localStorage.setItem(HS_KEY, String(n)); this._cached = n; }
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
      try { this._data = JSON.parse(localStorage.getItem(PROFILE_KEY)) || this._defaults(); }
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
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify(this._data)); } catch(_) {}
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
    const stored = localStorage.getItem(DAILY_DATE_KEY);
    if (stored !== today) {
      localStorage.setItem(DAILY_DATE_KEY, today);
      localStorage.removeItem(DAILY_SCORE_KEY);
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
    const prev = parseInt(localStorage.getItem(DAILY_SCORE_KEY) || '0', 10);
    if (score > prev) localStorage.setItem(DAILY_SCORE_KEY, String(score));
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
  let name = localStorage.getItem(PLAYER_NAME_KEY);
  if (!name) {
    name = generateName();
    localStorage.setItem(PLAYER_NAME_KEY, name);
  }
  return name;
}

function setPlayerName(name) {
  localStorage.setItem(PLAYER_NAME_KEY, name.trim() || generateName());
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

    // Per-run counters
    this.runKills       = 0;
    this.runFood        = 0;
    this.runSpeedBoosts = 0;
    this.surviveTimer   = 0;
    this.died           = false;
  }

  _load() {
    try {
      const data = JSON.parse(localStorage.getItem(ACHIEVEMENTS_KEY) || '[]');
      this._unlocked = new Set(data);
    } catch(_) { this._unlocked = new Set(); }
  }

  _save() {
    try {
      localStorage.setItem(ACHIEVEMENTS_KEY, JSON.stringify([...this._unlocked]));
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
    // Update overlay count
    const el = document.getElementById('achievement-count');
    if (el) el.textContent = `${this._unlocked.size} / ${ACHIEVEMENTS_DEF.length}`;
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

const WORLD_W       = 5500;
const WORLD_H       = 5500;
const FOOD_COUNT    = _IS_MOBILE ? 380 : 620;
const AI_COUNT      = _IS_MOBILE ? 9   : 14;
const SEGMENT_GAP   = 8;
const SEGMENT_R_BASE = 9;
const BASE_SPEED    = 130;
const BOOST_SPEED   = 220;
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

// Boss Snake: seconds between Titan Serpent spawns (only one alive at a time)
const BOSS_INTERVAL = 90;

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
