class SpatialGrid {
  constructor(worldW, worldH, cellSize) {
    this.cellSize = cellSize;
    this.cols = Math.ceil(worldW / cellSize);
    this.rows = Math.ceil(worldH / cellSize);
    this.cells = new Array(this.cols * this.rows).fill(null).map(() => new Set());
  }
  _idx(x, y) {
    const cx = Math.max(0, Math.min(Math.floor(x / this.cellSize), this.cols - 1));
    const cy = Math.max(0, Math.min(Math.floor(y / this.cellSize), this.rows - 1));
    return cy * this.cols + cx;
  }
  add(item) {
    const idx = this._idx(item.pos.x, item.pos.y);
    item._gridIdx = idx;
    this.cells[idx].add(item);
  }
  remove(item) {
    if (item._gridIdx !== undefined) {
      this.cells[item._gridIdx].delete(item);
      item._gridIdx = undefined;
    } else {
      this.cells[this._idx(item.pos.x, item.pos.y)].delete(item);
    }
  }
  query(x, y, r, out) {
    out.length = 0;
    const x0 = Math.max(0, Math.floor((x - r) / this.cellSize));
    const y0 = Math.max(0, Math.floor((y - r) / this.cellSize));
    const x1 = Math.min(this.cols - 1, Math.floor((x + r) / this.cellSize));
    const y1 = Math.min(this.rows - 1, Math.floor((y + r) / this.cellSize));
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        for (const item of this.cells[cy * this.cols + cx]) out.push(item);
      }
    }
    return out;
  }
  clear() { for (const c of this.cells) c.clear(); }
}

/* ─────────────────────────────────────────────────────────────
   3. FOOD
───────────────────────────────────────────────────────────── */
const FOOD_TYPE = Object.freeze({
  NORMAL:   'normal',
  MAGNET:   'magnet',
  ATTACK:   'attack',
  LIFELINE: 'lifeline',
  SHIELD:   'shield',
  GHOST:    'ghost',
  MINE:     'mine',
  SPEED:    'speed',
  FIRE:     'fire',
  FREEZE:   'freeze',
});

class Food {
  constructor(x, y, color, type = FOOD_TYPE.NORMAL, ttl = null, useRainEmoji = false) {
    this.pos    = new Vector2(x, y);
    this.type   = type;
    this.radius = type === FOOD_TYPE.NORMAL ? 6 : 9;
    this.phase  = Math.random() * Math.PI * 2;
    this.ttl    = ttl;

    const colors = {
      [FOOD_TYPE.MAGNET]:   '#00ccff',
      [FOOD_TYPE.ATTACK]:   '#ff3f3f',
      [FOOD_TYPE.LIFELINE]: '#ff5f9e',
      [FOOD_TYPE.SHIELD]:   '#a0d8ff',
      [FOOD_TYPE.GHOST]:    '#c8a0ff',
      [FOOD_TYPE.MINE]:     '#ff9f40',
      [FOOD_TYPE.SPEED]:    '#ffff80',
      [FOOD_TYPE.FIRE]:     '#ff5a1f',
      [FOOD_TYPE.FREEZE]:   '#7fdfff',
    };
    this.color = colors[type] || color;
  }

  get expired() { return this.ttl !== null && this.ttl <= 0; }

  draw(ctx, camX, camY) {
    if (this.expired) return;
    const sx = this.pos.x - camX;
    const sy = this.pos.y - camY;
    // Use logical dimensions for culling (ctx transform is dpr-scaled)
    const dpr  = window._game ? window._game._dpr : 1;
    const logW = ctx.canvas.width  / dpr;
    const logH = ctx.canvas.height / dpr;
    if (sx < -24 || sx > logW + 24 || sy < -24 || sy > logH + 24) return;

    const pulse = 0.5 + 0.5 * Math.sin(Date.now() * 0.003 + this.phase);
    const r     = this.radius + pulse * 2;

    let alpha = 1;
    if (this.ttl !== null && this.ttl < 3) alpha = Math.max(0, this.ttl / 3);
    ctx.globalAlpha = alpha;

    if (this.type === FOOD_TYPE.NORMAL) {
      ctx.shadowColor = this.color; ctx.shadowBlur = 8 + pulse * 6;
      ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = this.color; ctx.fill();
      ctx.shadowBlur = 0;
      ctx.beginPath(); ctx.arc(sx, sy, r * 0.45, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.fill();

    } else if (this.type === FOOD_TYPE.MAGNET) {
      const spin = Date.now() * 0.003;
      ctx.shadowColor = '#00ccff'; ctx.shadowBlur = 18 + pulse * 10;
      ctx.beginPath(); ctx.arc(sx, sy, r + 5, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0,200,255,0.4)'; ctx.lineWidth = 2; ctx.stroke();
      for (let i = 0; i < 6; i++) {
        const a = spin + (i / 6) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(sx + Math.cos(a) * (r + 5), sy + Math.sin(a) * (r + 5), 2, 0, Math.PI * 2);
        ctx.fillStyle = '#52ddff'; ctx.fill();
      }
      ctx.shadowBlur = 0;
      ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = '#00ccff'; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(sx, sy, r * 0.5, Math.PI, 0, false); ctx.stroke();

    } else if (this.type === FOOD_TYPE.ATTACK) {
      ctx.shadowColor = '#ff3f3f'; ctx.shadowBlur = 18 + pulse * 12;
      ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = '#ff3f3f'; ctx.fill();
      ctx.shadowBlur = 0; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(sx, sy - r * 0.7); ctx.lineTo(sx, sy + r * 0.4); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(sx - r * 0.45, sy + r * 0.1); ctx.lineTo(sx + r * 0.45, sy + r * 0.1); ctx.stroke();
      ctx.lineCap = 'butt';

    } else if (this.type === FOOD_TYPE.LIFELINE) {
      ctx.shadowColor = '#ff5f9e'; ctx.shadowBlur = 20 + pulse * 12;
      ctx.beginPath(); ctx.arc(sx, sy, r + 5, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,95,158,0.4)'; ctx.lineWidth = 2; ctx.stroke();
      ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = '#ff5f9e'; ctx.fill();
      ctx.save();
      ctx.shadowBlur = 0; ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.round(r * 1.3)}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('♥', sx, sy + 1);
      ctx.restore();

    } else if (this.type === FOOD_TYPE.SHIELD) {
      ctx.shadowColor = '#a0d8ff'; ctx.shadowBlur = 20 + pulse * 12;
      // Rotating ring
      const spin2 = Date.now() * 0.002;
      ctx.strokeStyle = `rgba(160,216,255,${(0.3 + pulse * 0.3).toFixed(2)})`;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(sx, sy, r + 5, 0, Math.PI * 2); ctx.stroke();
      for (let i = 0; i < 5; i++) {
        const a = spin2 + (i / 5) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(sx + Math.cos(a) * (r + 5), sy + Math.sin(a) * (r + 5), 2.5, 0, Math.PI * 2);
        ctx.fillStyle = '#a0d8ff'; ctx.fill();
      }
      ctx.shadowBlur = 0;
      ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = '#a0d8ff'; ctx.fill();
      ctx.save();
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.round(r * 1.2)}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('🛡️', sx, sy + 1);
      ctx.restore();

    } else if (this.type === FOOD_TYPE.GHOST) {
      ctx.shadowColor = '#c8a0ff'; ctx.shadowBlur = 18 + pulse * 10;
      ctx.beginPath(); ctx.arc(sx, sy, r + 4, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(200,160,255,${(0.25 + pulse * 0.25).toFixed(2)})`;
      ctx.lineWidth = 2; ctx.stroke();
      ctx.globalAlpha = (0.5 + pulse * 0.35) * alpha;
      ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = '#c8a0ff'; ctx.fill();
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.shadowBlur = 0; ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.round(r * 1.2)}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('👻', sx, sy + 1);
      ctx.restore();

    } else if (this.type === FOOD_TYPE.MINE) {
      ctx.shadowColor = '#ff9f40'; ctx.shadowBlur = 18 + pulse * 10;
      ctx.beginPath(); ctx.arc(sx, sy, r + 4, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,159,64,${(0.3 + pulse * 0.3).toFixed(2)})`;
      ctx.lineWidth = 2; ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = '#cc5500'; ctx.fill();
      ctx.save();
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.round(r * 1.2)}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('💣', sx, sy + 1);
      ctx.restore();

    } else if (this.type === FOOD_TYPE.SPEED) {
      ctx.shadowColor = '#ffff80'; ctx.shadowBlur = 20 + pulse * 12;
      ctx.beginPath(); ctx.arc(sx, sy, r + 4, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,255,128,${(0.3 + pulse * 0.3).toFixed(2)})`;
      ctx.lineWidth = 2; ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = '#cccc00'; ctx.fill();
      ctx.save();
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.round(r * 1.2)}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('⚡', sx, sy + 1);
      ctx.restore();

    } else if (this.type === FOOD_TYPE.FIRE) {
      // Debuff food — visually reads "danger" via a hot red/orange glow,
      // distinct from the cooler power-up colors above.
      ctx.shadowColor = '#ff5a1f'; ctx.shadowBlur = 20 + pulse * 14;
      ctx.beginPath(); ctx.arc(sx, sy, r + 4, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,90,31,${(0.35 + pulse * 0.35).toFixed(2)})`;
      ctx.lineWidth = 2; ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = '#c62800'; ctx.fill();
      ctx.save();
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.round(r * 1.2)}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('🌶️', sx, sy + 1);
      ctx.restore();

    } else if (this.type === FOOD_TYPE.FREEZE) {
      // Debuff food — cold blue/white glow signals "this will slow you
      // down", mirroring FIRE's hot glow for the opposite debuff.
      ctx.shadowColor = '#7fdfff'; ctx.shadowBlur = 20 + pulse * 14;
      ctx.beginPath(); ctx.arc(sx, sy, r + 4, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(127,223,255,${(0.35 + pulse * 0.35).toFixed(2)})`;
      ctx.lineWidth = 2; ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = '#2a9fd6'; ctx.fill();
      ctx.save();
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.round(r * 1.2)}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('🧊', sx, sy + 1);
      ctx.restore();
    }

    ctx.globalAlpha = 1;
  }
}

/* ─────────────────────────────────────────────────────────────
   4. PARTICLE POOL
───────────────────────────────────────────────────────────── */
const MAX_PARTICLES = 500;

class ParticlePool {
  constructor() {
    this._pool = [];
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this._pool.push({ active: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 0, radius: 0, color: '#fff' });
    }
  }

  burst(segments, color, countMul = 1) {
    for (let i = 0; i < segments.length; i += 4) {
      const seg = segments[i];
      const p = this._getFree();
      if (!p) break;
      const angle = Math.random() * Math.PI * 2;
      const speed = (60 + Math.random() * 120) * countMul;
      p.active = true;
      p.x = seg.x; p.y = seg.y;
      p.vx = Math.cos(angle) * speed;
      p.vy = Math.sin(angle) * speed;
      p.life = 0;
      p.maxLife = 0.6 + Math.random() * 0.5;
      p.radius = 2 + Math.random() * 4;
      p.color = color;
    }
  }

  burstAt(x, y, color, count = 20) {
    for (let i = 0; i < count; i++) {
      const p = this._getFree();
      if (!p) break;
      const angle = Math.random() * Math.PI * 2;
      const speed = 80 + Math.random() * 150;
      p.active = true;
      p.x = x; p.y = y;
      p.vx = Math.cos(angle) * speed;
      p.vy = Math.sin(angle) * speed;
      p.life = 0;
      p.maxLife = 0.5 + Math.random() * 0.6;
      p.radius = 2 + Math.random() * 5;
      p.color = color;
    }
  }

  _getFree() {
    for (const p of this._pool) if (!p.active) return p;
    return null;
  }

  update(dt) {
    for (const p of this._pool) {
      if (!p.active) continue;
      p.life += dt;
      if (p.life >= p.maxLife) { p.active = false; continue; }
      p.vx *= (1 - dt * 3); p.vy *= (1 - dt * 3);
      p.x += p.vx * dt; p.y += p.vy * dt;
    }
  }

  draw(ctx, camX, camY) {
    const dpr  = window._game ? window._game._dpr : 1;
    const logW = ctx.canvas.width  / dpr;
    const logH = ctx.canvas.height / dpr;
    for (const p of this._pool) {
      if (!p.active) continue;
      const sx = p.x - camX, sy = p.y - camY;
      if (sx < -20 || sx > logW + 20 || sy < -20 || sy > logH + 20) continue;
      const t = p.life / p.maxLife;
      ctx.globalAlpha = 1 - t;
      ctx.beginPath();
      ctx.arc(sx, sy, p.radius * (1 - t * 0.5), 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

/* ─────────────────────────────────────────────────────────────
   5. SNAKE (base class)
───────────────────────────────────────────────────────────── */
function getSegmentR(snakeOrIsPlayer = false) {
  // Backward-compatible: accepts either `true`/`false` (old call sites that
  // only cared about player-vs-AI) or an actual snake instance (new call
  // sites that want per-species thickness).
  if (snakeOrIsPlayer === true) {
    const game = window._game;
    const girth = (game && game.player && game.player._girthMul) || 1;
    const radiusMul = (game && game.player && game.player.radiusMul) || 1;
    switch (Settings.design) {
      case 'fatty':  return Math.round(SEGMENT_R_BASE * 1.45 * radiusMul * girth);
      case 'thin':   return Math.round(SEGMENT_R_BASE * 0.60 * radiusMul * girth);
      default:       return Math.round(SEGMENT_R_BASE * radiusMul * girth);
    }
  }
  if (snakeOrIsPlayer && snakeOrIsPlayer.isPlayer) {
    return getSegmentR(true);
  }
  const girth = (snakeOrIsPlayer && snakeOrIsPlayer._girthMul) || 1;
  if (snakeOrIsPlayer && snakeOrIsPlayer.radiusMul) {
    return Math.round(SEGMENT_R_BASE * snakeOrIsPlayer.radiusMul * girth);
  }
  return Math.round(SEGMENT_R_BASE * girth);
}

let _designerPaletteIdx = 0;
let _designerTimer      = 0;

// Looks up the currently selected skin definition. Falls back to the
// always-free 'multicolour' skin if the stored choice points at a skin
// that isn't actually unlocked (e.g. localStorage was partially cleared),
// so the player never ends up silently drawing a broken/undefined skin.
function getActiveSkin() {
  const def = SKINS_DEF.find(s => s.id === Settings.design);
  if (def && (!def.unlock || SkinSystem.isUnlocked(def.id))) return def;
  return SKINS_DEF[0];
}
const DESIGNER_CYCLE    = 4;

function tickDesignerPalette(dt) {
  if (Settings.design !== 'designer') return;
  _designerTimer += dt;
  if (_designerTimer >= DESIGNER_CYCLE) {
    _designerTimer = 0;
    _designerPaletteIdx = (_designerPaletteIdx + 1) % DESIGNER_PALETTES.length;
  }
}

class Snake {
  constructor(x, y, bodyColor, headColor, initLen = 8, isPlayer = false) {
    this.pos       = new Vector2(x, y);
    this.dir       = new Vector2(1, 0);
    this.speed     = BASE_SPEED;
    this.alive     = true;
    this.bodyColor = bodyColor;
    this.headColor = headColor;
    this.score     = 0;
    this.isPlayer  = isPlayer;
    this.name      = '';
    this.face      = null; // emoji face override, null = classic eyes

    this.segments = [];
    for (let i = 0; i < initLen; i++) {
      this.segments.push(new Vector2(x - i * SEGMENT_GAP, y));
    }

    this._growBuffer = 0;
    this._tmpVec     = new Vector2(0, 0);

    // Trail ring buffer: 8 recent head positions
    this._trailBuf = [];
    this._trailMax = 8;
  }

  // True length keeps counting food eaten even after the segment array
  // hits the perf cap (see _grow) — UI shows this so players still see
  // their length climbing, while the simulated body stays capped.
  get length() { return Math.max(this.segments.length, this._trueLength || this.segments.length); }
  get head()   { return this.segments[0]; }

  _applyDirection(dt) {
    const head = this.segments[0];
    head.x += this.dir.x * this.speed * dt;
    head.y += this.dir.y * this.speed * dt;
    this.pos.x = head.x;
    this.pos.y = head.y;

    // Record trail
    this._trailBuf.push({ x: head.x, y: head.y });
    if (this._trailBuf.length > this._trailMax) this._trailBuf.shift();
  }

  _moveSegments() {
    const gapSq = SEGMENT_GAP * SEGMENT_GAP;
    for (let i = 1; i < this.segments.length; i++) {
      const seg  = this.segments[i];
      const prev = this.segments[i - 1];
      const dx = prev.x - seg.x, dy = prev.y - seg.y;
      const dSq = dx * dx + dy * dy;
      if (dSq <= gapSq) continue;
      const dist = Math.sqrt(dSq);
      const t = (dist - SEGMENT_GAP) / dist;
      seg.x += dx * t;
      seg.y += dy * t;
    }
  }

  eat(points = 1) {
    this._growBuffer += 4;
    this.score += points;
    this._trueLength = (this._trueLength || this.segments.length) + 4;
  }

  _grow() {
    if (this._growBuffer <= 0) return;
    this._growBuffer--;

    // Once the physics segment array hits the perf cap, stop pushing new
    // segments (that's what made _moveSegments()/collision cost climb
    // forever on long runs) and grow girth instead — the snake keeps
    // visibly getting bigger, just via thickness instead of segment count.
    if (this.segments.length >= MAX_PHYSICS_SEGMENTS) {
      const trueLen = this._trueLength || this.segments.length;
      const extra   = Math.max(0, trueLen - MAX_PHYSICS_SEGMENTS);
      // sqrt curve — grows quickly at first, then keeps inching up across
      // a very wide length range instead of hard-plateauing early.
      const t = Math.sqrt(extra) / Math.sqrt(extra + GIRTH_CURVE_HALFLEN);
      this._girthMul = 1 + (MAX_GIRTH_MUL - 1) * t;
      return;
    }

    const segs = this.segments;
    const tail = segs[segs.length - 1];
    if (segs.length >= 2) {
      const prev = segs[segs.length - 2];
      const dx = tail.x - prev.x, dy = tail.y - prev.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      segs.push(new Vector2(tail.x + (dx / dist) * SEGMENT_GAP, tail.y + (dy / dist) * SEGMENT_GAP));
    } else {
      segs.push(new Vector2(tail.x, tail.y));
    }
  }

  _calcSpeed(baseSpeed) {
    const len = this.segments.length;
    const t   = Math.max(0, Math.min(1, (len - SPEED_SCALE_MIN) / (SPEED_SCALE_MAX - SPEED_SCALE_MIN)));
    const mul = SPEED_SMALL_MUL + (SPEED_LARGE_MUL - SPEED_SMALL_MUL) * t;
    return baseSpeed * mul;
  }

  shrink(count) {
    const minLen = 5;
    const remove = Math.min(count, this.segments.length - minLen);
    if (remove > 0) this.segments.splice(this.segments.length - remove, remove);
  }

  // Perf: shadowBlur used to be set on every trail dot (8 per snake, up to
  // ~15 snakes = 120 shadowed draws/frame). shadowBlur is one of the most
  // expensive canvas operations on mobile, and re-setting it per-dot forces
  // the renderer to recompute the blur each time even though the color and
  // radius don't need per-dot precision. Now it's set once per snake.
  _drawTrail(ctx, camX, camY) {
    const buf = this._trailBuf;
    if (buf.length < 2) return;

    // Cull the whole trail if the snake's head is nowhere near the screen —
    // cheap check using the most recent trail point.
    const dpr  = window._game ? window._game._dpr : 1;
    const logW = ctx.canvas.width  / dpr;
    const logH = ctx.canvas.height / dpr;
    const last = buf[buf.length - 1];
    const hx = last.x - camX, hy = last.y - camY;
    const pad = 60;
    if (hx < -pad || hx > logW + pad || hy < -pad || hy > logH + pad) return;

    const color = this.headColor;
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur  = 6;
    for (let i = 0; i < buf.length; i++) {
      const p = buf[i];
      const sx = p.x - camX, sy = p.y - camY;
      const alpha = (i / buf.length) * 0.35;
      const r = SEGMENT_R_BASE * (i / buf.length) * 0.8;
      if (r < 0.5) continue;
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur  = 0;
    ctx.restore();
  }

  draw(ctx, camX, camY) {
    if (!this.alive) return;

    // I-frame flicker
    if (this.iFrameTimer !== undefined && this.iFrameTimer > 0) {
      if (Math.floor(Date.now() / 62) % 2 === 0) return;
    }

    // Ghost mode semi-transparency
    const isGhost = this.ghostTimer !== undefined && this.ghostTimer > 0;
    if (isGhost) ctx.globalAlpha = 0.4;

    // Draw trail first
    this._drawTrail(ctx, camX, camY);

    const segR       = getSegmentR(this.isPlayer ? true : this);
    const segs       = this.segments;
    const len        = segs.length;
    const inAttack   = this.attackTimer !== undefined && this.attackTimer > 0;
    const inShield   = this.shieldTimer !== undefined && this.shieldTimer > 0;
    const inSpeed    = this.speedBoostTimer !== undefined && this.speedBoostTimer > 0;

    let bodyFill  = inAttack ? '#8b1a1a' : this._resolveBodyColor();
    let headFill  = inAttack ? '#ff2222' : this._resolveHeadColor();
    const glowColor = inAttack ? '#ff2222' : (inShield ? '#a0d8ff' : (inSpeed ? '#ffff80' : headFill));
    const playerSkin = this.isPlayer ? getActiveSkin() : null;
    const isMulticolour = this.isPlayer && playerSkin && playerSkin.kind === 'palette' && !inAttack;
    const isStriped = !this.isPlayer && this.stripePattern && !inAttack;

    // Body
    const _dpr  = window._game ? window._game._dpr : 1;
    const _logW = ctx.canvas.width  / _dpr;
    const _logH = ctx.canvas.height / _dpr;

    if (isMulticolour) {
      const pal = playerSkin.palette;
      for (let i = len - 1; i >= 1; i--) {
        const sx = segs[i].x - camX, sy = segs[i].y - camY;
        if (sx < -segR * 2 || sx > _logW + segR * 2 || sy < -segR * 2 || sy > _logH + segR * 2) continue;
        ctx.beginPath();
        ctx.arc(sx, sy, segR, 0, Math.PI * 2);
        ctx.fillStyle = pal[i % pal.length];
        ctx.fill();
      }
    } else if (isStriped) {
      const pattern = this.stripePattern;
      // Group segments by colour bucket first so each colour gets one
      // beginPath+fill call instead of one per segment (fewer canvas state
      // changes = cheaper on mobile than the per-segment loop below).
      for (let c = 0; c < pattern.length; c++) {
        ctx.beginPath();
        let any = false;
        for (let i = len - 1; i >= 1; i--) {
          if (i % pattern.length !== c) continue;
          const sx = segs[i].x - camX, sy = segs[i].y - camY;
          if (sx < -segR * 2 || sx > _logW + segR * 2 || sy < -segR * 2 || sy > _logH + segR * 2) continue;
          ctx.moveTo(sx + segR, sy);
          ctx.arc(sx, sy, segR, 0, Math.PI * 2);
          any = true;
        }
        if (any) { ctx.fillStyle = pattern[c]; ctx.fill(); }
      }
    } else {
      ctx.beginPath();
      for (let i = len - 1; i >= 1; i--) {
        const sx = segs[i].x - camX, sy = segs[i].y - camY;
        if (sx < -segR * 2 || sx > _logW + segR * 2 || sy < -segR * 2 || sy > _logH + segR * 2) continue;
        ctx.moveTo(sx + segR, sy);
        ctx.arc(sx, sy, segR, 0, Math.PI * 2);
      }
      ctx.fillStyle = bodyFill;
      ctx.fill();
    }

    // Centipede legs — jointed hip->knee->foot curves with an alternating
    // walk-cycle gait (see _drawCentipedeLegs/_strokeCentipedeLeg). Only
    // centipedes pay this cost; every other snake/species skips it.
    if (this.moveStyle === 'centipede') {
      this._drawCentipedeLegs(ctx, camX, camY, segR, _logW, _logH);
    }

    // Emoji face — player reads live from Settings (so switching in the
    // settings modal mid-run updates instantly), AI snakes use whatever
    // was randomly assigned to them at spawn. When active, it fully
    // replaces the colored head circle (not just the eyes) — the emoji
    // becomes the head.
    const activeFace = this.isPlayer ? Settings.face : this.face;

    // Head
    const hx = segs[0].x - camX, hy = segs[0].y - camY;
    if (!activeFace) {
      ctx.save();
      ctx.shadowColor = glowColor;
      ctx.shadowBlur  = inAttack ? 28 : (inShield ? 22 : (inSpeed ? 20 : 16));
      ctx.beginPath();
      ctx.arc(hx, hy, segR * 1.35, 0, Math.PI * 2);
      ctx.fillStyle = headFill;
      ctx.fill();
      ctx.restore();
    }

    // Attack ring
    if (inAttack) {
      const pulse = 0.5 + 0.5 * Math.sin(Date.now() * 0.01);
      ctx.save();
      ctx.strokeStyle = `rgba(255,50,50,${(0.4 + pulse * 0.4).toFixed(2)})`;
      ctx.lineWidth = 3; ctx.shadowColor = '#ff2222'; ctx.shadowBlur = 14;
      ctx.beginPath(); ctx.arc(hx, hy, segR * 1.9 + pulse * 3, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }

    // Shield aura
    if (inShield) {
      const pulse = 0.5 + 0.5 * Math.sin(Date.now() * 0.006);
      ctx.save();
      ctx.strokeStyle = `rgba(160,216,255,${(0.5 + pulse * 0.4).toFixed(2)})`;
      ctx.lineWidth = 3.5; ctx.shadowColor = '#a0d8ff'; ctx.shadowBlur = 20;
      ctx.beginPath(); ctx.arc(hx, hy, segR * 2.1 + pulse * 4, 0, Math.PI * 2); ctx.stroke();
      // Inner fill glow
      ctx.globalAlpha = 0.1 + pulse * 0.08;
      ctx.beginPath(); ctx.arc(hx, hy, segR * 2.0, 0, Math.PI * 2);
      ctx.fillStyle = '#a0d8ff'; ctx.fill();
      ctx.restore();
    }

    // Speed glow
    if (inSpeed) {
      const pulse = 0.5 + 0.5 * Math.sin(Date.now() * 0.015);
      ctx.save();
      ctx.strokeStyle = `rgba(255,255,128,${(0.4 + pulse * 0.4).toFixed(2)})`;
      ctx.lineWidth = 2.5; ctx.shadowColor = '#ffff80'; ctx.shadowBlur = 18;
      ctx.beginPath(); ctx.arc(hx, hy, segR * 1.8 + pulse * 3, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }

    // Frozen aura — player-only debuff visual: icy rings around the head
    // plus a light frost tint wash over the whole body, so "you are
    // frozen and cannot move" reads clearly at a glance, not just via a
    // stopped snake that might look like lag.
    if (this.isPlayer && this.freezeTimer > 0) {
      const pulse = 0.5 + 0.5 * Math.sin(Date.now() * 0.008);
      ctx.save();
      ctx.strokeStyle = `rgba(127,223,255,${(0.5 + pulse * 0.35).toFixed(2)})`;
      ctx.lineWidth = 3; ctx.shadowColor = '#7fdfff'; ctx.shadowBlur = 20;
      ctx.beginPath(); ctx.arc(hx, hy, segR * 2.0 + pulse * 3, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.globalAlpha = 0.22;
      ctx.beginPath();
      for (let i = len - 1; i >= 0; i--) {
        const sx = segs[i].x - camX, sy = segs[i].y - camY;
        if (sx < -segR * 2 || sx > _logW + segR * 2 || sy < -segR * 2 || sy > _logH + segR * 2) continue;
        ctx.moveTo(sx + segR, sy);
        ctx.arc(sx, sy, segR * 1.1, 0, Math.PI * 2);
      }
      ctx.fillStyle = '#bff2ff';
      ctx.fill();
      ctx.restore();
    }

    // Fire flash — brief red pulse right after eating 🌶️, so the instant
    // length loss reads as "that hurt" instead of segments silently
    // vanishing off the tail unnoticed.
    if (this.isPlayer && this.fireFlashTimer > 0) {
      const t = this.fireFlashTimer / 0.5; // 1 -> 0 over the flash duration
      ctx.save();
      ctx.globalAlpha = t * 0.5;
      ctx.strokeStyle = '#ff5a1f';
      ctx.lineWidth = 4; ctx.shadowColor = '#ff5a1f'; ctx.shadowBlur = 22;
      ctx.beginPath(); ctx.arc(hx, hy, segR * 2.2 + (1 - t) * 10, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }

    // Boss aura — a slow pulsing red/gold double ring so the Titan Serpent
    // reads as a threat from a distance. Only ever one boss on screen at a
    // time, so this is negligible extra draw cost.
    if (this.isBoss) {
      const pulse = 0.5 + 0.5 * Math.sin(Date.now() * 0.004);
      ctx.save();
      ctx.strokeStyle = `rgba(255,60,20,${(0.5 + pulse * 0.35).toFixed(2)})`;
      ctx.lineWidth = 3; ctx.shadowColor = '#ff3c14'; ctx.shadowBlur = 24;
      ctx.beginPath(); ctx.arc(hx, hy, segR * 2.2 + pulse * 5, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = `rgba(255,200,60,${(0.35 + pulse * 0.25).toFixed(2)})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(hx, hy, segR * 2.8 + pulse * 7, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }

    // Draw either the emoji face (head replacement) or classic eyes.
    if (activeFace) {
      this._drawFace(ctx, hx, hy, segR, activeFace);
    } else {
      this._drawEyes(ctx, hx, hy, segR);
    }

    if (isGhost) ctx.globalAlpha = 1;
  }

  // Draws a pre-cached emoji image centered on the head, scaled to the
  // head's current radius (so it grows with girth like the plain head
  // does). Kept upright rather than rotated to travel direction — emoji
  // faces aren't directional glyphs like an arrow, so rotating them tends
  // to look like the face is tilting/falling over rather than "looking"
  // somewhere, especially mid-turn.
  _drawFace(ctx, hx, hy, segR, emoji) {
    const img = EmojiIconCache.get(emoji);
    if (!img) { this._drawEyes(ctx, hx, hy, segR); return; }

    // Noticeably bigger than the old plain head circle (which was
    // segR * 1.35 radius = segR * 2.7 diameter) so the face reads clearly
    // as the "head" rather than blending in with the body segments. Sized
    // up further from the original 3.4x — thinner species (centipede/ant,
    // radiusMul well under 1) have a small segR, so the head needs extra
    // relative size to still look proportioned rather than lost against
    // the body width.
    const drawSize = segR * 4.2;
    ctx.drawImage(img, hx - drawSize / 2, hy - drawSize / 2, drawSize, drawSize);
  }

  // Procedural legs for the centipede species. Each leg is a bent
  // quadratic curve (hip -> knee -> foot) rather than a straight radial
  // line, so they read as jointed limbs instead of spikes. The gait
  // alternates each leg pair between a forward "reach" and a backward
  // "push" phase (like a real many-legged tripod gait: alternating sides
  // step out of sync), with the knee bulging further out mid-stride and
  // flattening at the stride extremes — that knee-bulge is what actually
  // sells "walking" rather than a uniform in/out swing. All legs are
  // still drawn in a single stroke() call (one path, many subpaths), so
  // this stays a fixed small per-frame cost regardless of body length.
  _drawCentipedeLegs(ctx, camX, camY, segR, logW, logH) {
    const segs = this.segments;
    const len  = segs.length;
    if (len < 2) return;

    const legLen  = segR * 1.5;
    const gaitSpd = 9;
    ctx.beginPath();
    for (let i = 1; i < len; i += 2) {
      const p = segs[i];
      const prev = segs[i - 1];
      const sx = p.x - camX, sy = p.y - camY;
      if (sx < -segR * 2 || sx > logW + segR * 2 || sy < -segR * 2 || sy > logH + segR * 2) continue;

      // Direction along the body at this segment, used to find the
      // perpendicular (left/right) axis the legs stick out along.
      let dx = prev.x - p.x, dy = prev.y - p.y;
      const dlen = Math.sqrt(dx * dx + dy * dy) || 1;
      dx /= dlen; dy /= dlen;
      const px = -dy, py = dx; // perpendicular unit vector

      // Phase offset travels down the body (i * 0.9) so the stride wave
      // ripples tail-ward like a real centipede's gait, and left/right
      // sides are offset by PI so they alternate rather than stepping in
      // unison (a real many-legged gait never moves both sides together).
      const phase   = this._wiggleT * gaitSpd - i * 0.9;
      const strideL = Math.sin(phase);
      const strideR = Math.sin(phase + Math.PI);

      this._strokeCentipedeLeg(ctx, sx, sy, px, py, dx, dy, legLen, strideL, +1);
      this._strokeCentipedeLeg(ctx, sx, sy, px, py, dx, dy, legLen, strideR, -1);
    }
    ctx.strokeStyle = this._resolveBodyColor();
    ctx.lineWidth = Math.max(1, segR * 0.26);
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  // Builds one jointed leg (hip -> knee -> foot) as a quadratic curve and
  // adds it as a subpath to whatever path is already open on ctx — caller
  // is responsible for beginPath()/stroke(). `side` is +1 or -1 for
  // left/right. `stride` is a -1..1 value (a sine wave from the caller)
  // driving the walk cycle:
  //   stride  1  -> leg fully forward, reaching (knee pushed forward+out)
  //   stride -1  -> leg fully back, pushing off (knee pushed back+out)
  //   stride  0  -> leg passing under the body (knee pulled in tight,
  //                 close to the body) — this is what makes it read as a
  //                 lift-and-place step rather than a rigid paddle-wheel.
  _strokeCentipedeLeg(ctx, sx, sy, px, py, dx, dy, legLen, stride, side) {
    // Knee bulges outward the most at the stride extremes and pulls in
    // tight at stride 0 — this in/out breathing of the knee, combined
    // with the fore/aft sweep, is what makes the leg look like it's
    // actually stepping rather than just swinging a straight rod.
    const outAmt  = 0.55 + 0.45 * Math.abs(stride);
    const foreAmt = stride * 0.65;

    const kneeX = sx + px * side * legLen * 0.55 * outAmt + dx * legLen * foreAmt;
    const kneeY = sy + py * side * legLen * 0.55 * outAmt + dy * legLen * foreAmt;
    const footX = sx + px * side * legLen * outAmt + dx * legLen * foreAmt * 1.3;
    const footY = sy + py * side * legLen * outAmt + dy * legLen * foreAmt * 1.3;

    ctx.moveTo(sx, sy);
    ctx.quadraticCurveTo(kneeX, kneeY, footX, footY);
  }

  _resolveBodyColor() {
    if (!this.isPlayer) return this.bodyColor;
    const skin = getActiveSkin();
    if (skin.kind === 'designer') return DESIGNER_PALETTES[_designerPaletteIdx][0];
    if (skin.kind === 'solid')    return skin.body;
    if (skin.kind === 'palette')  return skin.palette[0]; // used only as a non-multicolour fallback fill
    return this.bodyColor;
  }
  _resolveHeadColor() {
    if (!this.isPlayer) return this.headColor;
    const skin = getActiveSkin();
    if (skin.kind === 'designer') return DESIGNER_PALETTES[_designerPaletteIdx][1];
    if (skin.kind === 'solid')    return skin.head;
    if (skin.kind === 'palette')  return skin.head;
    return this.headColor;
  }

  _drawEyes(ctx, hx, hy, segR = SEGMENT_R_BASE) {
    const eyeOff  = segR * 0.55;
    const fwdDist = segR * 0.4;
    const perpX = -this.dir.y * eyeOff, perpY = this.dir.x * eyeOff;
    const fwdX  = this.dir.x * fwdDist, fwdY  = this.dir.y * fwdDist;

    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(hx + fwdX + perpX, hy + fwdY + perpY, 3.2, 0, Math.PI * 2);
    ctx.arc(hx + fwdX - perpX, hy + fwdY - perpY, 3.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#111';
    ctx.beginPath();
    ctx.arc(hx + fwdX + perpX + this.dir.x * 1.2, hy + fwdY + perpY + this.dir.y * 1.2, 1.6, 0, Math.PI * 2);
    ctx.arc(hx + fwdX - perpX + this.dir.x * 1.2, hy + fwdY - perpY + this.dir.y * 1.2, 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
}

/* ─────────────────────────────────────────────────────────────
   6. PLAYER SNAKE
───────────────────────────────────────────────────────────── */
class PlayerSnake extends Snake {
  constructor(x, y) {
    super(x, y, '#2dd87a', '#7effb2', 12, true);
    this.pointer        = new Vector2(0, 0);
    this.boosting       = false;
    this._boostDrainAcc = 0;

    // Player creature choice — 'snake' (default, no visual/stat change)
    // or 'centipede' (legs + slightly smaller body, matching the AI
    // centipede species' radiusMul so the two read consistently). Chosen
    // once at spawn time from Settings.playerSpecies so it can't change
    // mid-run just by flipping the setting (matches how AI species are
    // fixed for a snake's whole lifetime too).
    const speciesDef = Settings.playerSpecies === 'centipede' ? CENTIPEDE_SPECIES : null;
    this.moveStyle = speciesDef ? speciesDef.moveStyle : null;
    this.radiusMul = speciesDef ? speciesDef.radiusMul : 1;
    this._wiggleT  = Math.random() * 10;

    this.lives          = PLAYER_LIVES;
    this.iFrameTimer    = 0;
    this.magnetTimer    = 0;
    this.attackTimer    = 0;
    this.shieldTimer    = 0;
    this.ghostTimer     = 0;
    this.mineTimer      = 0;
    this.speedBoostTimer = 0;
    // 🧊 Freeze debuff — while > 0 the player can't move (speed forced to
    // 0) and gets the chilled visual treatment in draw(). Separate from
    // shieldTimer/ghostTimer etc. since it's a penalty, not a power-up.
    this.freezeTimer    = 0;
    // 🌶️ Fire debuff — no ongoing timer needed (the length loss is instant,
    // applied once on pickup), but this drives a brief flash/particle beat
    // right after eating so the shrink reads as "ouch" rather than silently
    // losing segments unnoticed.
    this.fireFlashTimer = 0;

    this._mineDeployAcc  = 0;
    this.activeMines     = [];  // Mine objects
  }

  update(dt, camX, camY, joystickDir = null, gyroDir = null) {
    if (!this.alive) return;

    this._wiggleT += dt;

    // Periodic animal sound for the player's selected face (e.g. 🐮 moos
    // every ~10-15s). No-op instantly for faces with no mapped sound, and
    // costs nothing extra on frames where it's not yet time to play.
    AnimalSoundManager.tick(dt, Settings.face);

    if (this.iFrameTimer   > 0) this.iFrameTimer   = Math.max(0, this.iFrameTimer   - dt);
    if (this.magnetTimer   > 0) this.magnetTimer   = Math.max(0, this.magnetTimer   - dt);
    if (this.attackTimer   > 0) this.attackTimer   = Math.max(0, this.attackTimer   - dt);
    if (this.shieldTimer   > 0) this.shieldTimer   = Math.max(0, this.shieldTimer   - dt);
    if (this.ghostTimer    > 0) this.ghostTimer    = Math.max(0, this.ghostTimer    - dt);
    if (this.speedBoostTimer > 0) this.speedBoostTimer = Math.max(0, this.speedBoostTimer - dt);
    if (this.mineTimer     > 0) this.mineTimer     = Math.max(0, this.mineTimer     - dt);
    if (this.freezeTimer   > 0) this.freezeTimer   = Math.max(0, this.freezeTimer   - dt);
    if (this.fireFlashTimer > 0) this.fireFlashTimer = Math.max(0, this.fireFlashTimer - dt);

    // Mine deployment
    if (this.mineTimer > 0 && this.activeMines.length < MINE_MAX) {
      this._mineDeployAcc += dt;
      if (this._mineDeployAcc >= MINE_DEPLOY_INTERVAL) {
        this._mineDeployAcc = 0;
        this.activeMines.push(new Mine(this.head.x, this.head.y));
      }
    }
    // Tick mines
    for (const m of this.activeMines) m.update(dt);
    this.activeMines = this.activeMines.filter(m => !m.expired);

    // Frozen solid — completely overrides normal speed calc below (still
    // lets steering update so the player isn't stuck facing one direction
    // when the freeze ends, they just can't actually travel meanwhile).
    if (this.freezeTimer > 0) {
      this.speed = 0;
    } else {
      const speedMul = this.speedBoostTimer > 0 ? SPEED_BOOST_MUL : 1;
      const scaledBase  = this._calcSpeed(BASE_SPEED  * speedMul);
      const scaledBoost = this._calcSpeed(BOOST_SPEED * speedMul);
      this.speed = (this.boosting && this.segments.length > 6) ? scaledBoost : scaledBase;
    }

    if (this.freezeTimer <= 0 && this.boosting && this.segments.length > 6 && this.speedBoostTimer <= 0) {
      this._boostDrainAcc += BOOST_DRAIN * dt;
      const toRemove = Math.floor(this._boostDrainAcc);
      if (toRemove > 0) { this.shrink(toRemove); this._boostDrainAcc -= toRemove; }
    } else {
      this._boostDrainAcc = 0;
    }

    // Steering: joystick > gyro > mouse/touch
    if (joystickDir && (joystickDir.x !== 0 || joystickDir.y !== 0)) {
      const lerpT = Math.min(1, 0.12 * dt * 60);
      this.dir = this.dir.lerp(joystickDir.normalize(), lerpT).normalize();
    } else if (gyroDir && (gyroDir.x !== 0 || gyroDir.y !== 0)) {
      const lerpT = Math.min(1, 0.10 * dt * 60);
      this.dir = this.dir.lerp(gyroDir.normalize(), lerpT).normalize();
    } else {
      const sens = Settings.sensitivity;
      const lerpBase = 0.01 + (sens / 20) * 0.21;
      const worldX = this.pointer.x + camX, worldY = this.pointer.y + camY;
      const dx = worldX - this.head.x, dy = worldY - this.head.y;
      const dSq = dx * dx + dy * dy;
      if (dSq > 100) {
        const dist = Math.sqrt(dSq);
        const desired = new Vector2(dx / dist, dy / dist);
        const lerpT = Math.min(1, lerpBase * dt * 60);
        this.dir = this.dir.lerp(desired, lerpT).normalize();
      }
    }

    this._applyDirection(dt);
    this._moveSegments();
    this._grow();
  }

  activateMagnet()     { this.magnetTimer   = MAGNET_DURATION; }
  activateAttack()     { this.attackTimer   = ATTACK_DURATION; }
  activateShield()     { this.shieldTimer   = SHIELD_DURATION; }
  activateGhost()      { this.ghostTimer    = GHOST_DURATION; }
  activateMine()       { this.mineTimer = MINE_DURATION; this._mineDeployAcc = MINE_DEPLOY_INTERVAL; }
  activateSpeedBoost() { this.speedBoostTimer = SPEED_BOOST_DURATION; }
  // 🧊 Debuff — locks speed to 0 for FREEZE_DURATION seconds (see update()).
  // Immunity/shield doesn't block this — it's a food pickup, not an attack,
  // same as how shield doesn't stop the player from eating FIRE either.
  activateFreeze()      { this.freezeTimer = FREEZE_DURATION; }
  // 🌶️ Debuff — removes a percentage of current length immediately.
  // Floors at 5 segments (same safety floor as shrink() already enforces)
  // so eating fire food can never be an instant-death exploit for a very
  // short/young snake.
  activateFireDebuff() {
    const loseCount = Math.ceil(this.segments.length * FIRE_SHRINK_FRACTION);
    this.shrink(loseCount);
    this.fireFlashTimer = 0.5;
  }

  get invincible() { return this.iFrameTimer > 0 || this.shieldTimer > 0; }
  get isGhost()    { return this.ghostTimer > 0; }
  get isFrozen()   { return this.freezeTimer > 0; }
}

/* ─────────────────────────────────────────────────────────────
   7. AI SNAKE
───────────────────────────────────────────────────────────── */
const AI_STATE = Object.freeze({
  WANDER: 'WANDER', SEEK_FOOD: 'SEEK_FOOD',
  AVOID: 'AVOID',   FLEE: 'FLEE',   PURSUE: 'PURSUE',
});

const HYSTERESIS = {
  PURSUE:    { enter: 0.12, exit: 0.40 },
  FLEE:      { enter: 0.15, exit: 0.50 },
  AVOID:     { enter: 0.05, exit: 0.20 },
  SEEK_FOOD: { enter: 0.0,  exit: 0.10 },
};

/* ─────────────────────────────────────────────────────────────
   SPECIES — visual/size/speed archetypes for AI snakes.
   Each species is a preset "body plan": how long it spawns, how thick
   its segments render, and a speed multiplier. Personality (below)
   still controls BEHAVIOR (aggressive/coward/hunter/farmer) — species
   and personality are independent axes that combine, so you can get
   e.g. an "aggressive Anaconda" or a "coward Hatchling".
   weight = relative spawn chance (higher = more common).
───────────────────────────────────────────────────────────── */
const SNAKE_SPECIES = [
  {
    id: 'hatchling', label: 'Hatchling',
    minLen: 5,  maxLen: 7,   radiusMul: 0.55, speedMul: 1.00,
    weight: 20, scoreMul: 0.6,
  },
  {
    id: 'garter', label: 'Garter Snake',
    minLen: 8,  maxLen: 13,  radiusMul: 0.72, speedMul: 1.28,
    weight: 26, scoreMul: 0.8,
  },
  {
    id: 'viper', label: 'Viper',
    minLen: 14, maxLen: 20,  radiusMul: 1.00, speedMul: 1.15,
    weight: 24, scoreMul: 1.0,
  },
  {
    id: 'python', label: 'Python',
    minLen: 26, maxLen: 36,  radiusMul: 1.35, speedMul: 0.95,
    weight: 16, scoreMul: 1.4,
  },
  {
    id: 'anaconda', label: 'Anaconda',
    minLen: 42, maxLen: 58,  radiusMul: 1.75, speedMul: 0.82,
    weight: 8,  scoreMul: 2.0,
  },
  {
    // Slow, thick, low-key mover — same segment-drawing path as a normal
    // snake, just with different stats and a duller flat color so it
    // doesn't look like a small snake. No legs/wiggle needed for this
    // one, unlike centipede/ant below.
    id: 'slug', label: 'Slug',
    minLen: 10, maxLen: 16,  radiusMul: 0.95, speedMul: 0.55,
    weight: 10, scoreMul: 0.9, moveStyle: 'slug',
  },
  {
    // Many short segments + rendered legs and a per-segment wiggle offset
    // (see _drawLegs / wiggle in Snake.draw). Faster than its size would
    // suggest, matching a real centipede's quick scuttle.
    id: 'centipede', label: 'Centipede',
    minLen: 18, maxLen: 28,  radiusMul: 0.5,  speedMul: 1.35,
    weight: 12, scoreMul: 1.1, moveStyle: 'centipede',
  },
  {
    // Tiny and fast with erratic, twitchy steering (see _applyMoveStyle in
    // AISnake.update) — reads as a skittering insect rather than a smooth
    // snake glide.
    id: 'ant', label: 'Ant',
    minLen: 4,  maxLen: 6,   radiusMul: 0.4,  speedMul: 1.6,
    weight: 14, scoreMul: 0.5, moveStyle: 'insect',
  },
  {
    // Boss tier: weight 0 so pickSpecies() (used for normal AI spawns and
    // respawns) never rolls this by chance — it's only ever assigned
    // directly by the dedicated boss-spawn call in Game.
    id: 'titan', label: 'Titan Serpent',
    minLen: 95, maxLen: 130, radiusMul: 2.4, speedMul: 0.9,
    weight: 0,  scoreMul: 5.0,
  },
];
const CENTIPEDE_SPECIES = SNAKE_SPECIES.find(sp => sp.id === 'centipede');
// Everything eligible for normal AI spawns/respawns except centipede and
// the boss (boss already excluded via weight 0, kept out of this list
// too for clarity). Weighted pick happens *within* this group.
const OTHER_SPECIES = SNAKE_SPECIES.filter(sp => sp.id !== 'centipede' && sp.id !== 'titan');
const OTHER_SPECIES_TOTAL_WEIGHT = OTHER_SPECIES.reduce((s, sp) => s + sp.weight, 0);

// Exactly half of all normal AI spawns are centipedes; the other half is
// a weighted pick across every other non-boss species (hatchling, garter,
// viper, python, anaconda, slug, ant). A flat 50/50 coin-flip is used
// rather than folding centipede into the same weighted pool, since with
// ~130 total weight points a single species' weight would need constant
// re-tuning to stay near 50% as other species' weights change — the
// coin-flip keeps it exactly 50% regardless of how the rest are tuned.
function pickSpecies() {
  if (Math.random() < 0.5) return CENTIPEDE_SPECIES;

  let r = Math.random() * OTHER_SPECIES_TOTAL_WEIGHT;
  for (const sp of OTHER_SPECIES) {
    r -= sp.weight;
    if (r <= 0) return sp;
  }
  return OTHER_SPECIES[OTHER_SPECIES.length - 1];
}

const AI_PERSONALITIES = ['aggressive', 'coward', 'hunter', 'farmer'];

class AISnake extends Snake {
  constructor(x, y, bodyColor, headColor, foodGrid, snakes, forcedSpecies = null) {
    // Species decides body plan (size + thickness + base speed multiplier);
    // spawn length is randomized within the species' adult range so AI
    // snakes appear at full size instead of always hatching as babies.
    // forcedSpecies lets the boss-spawn call bypass the weighted random
    // pick and assign the Titan Serpent tier directly.
    const species  = forcedSpecies || pickSpecies();
    const spawnLen = species.minLen + Math.floor(Math.random() * (species.maxLen - species.minLen + 1));

    super(x, y, bodyColor, headColor, spawnLen);
    this.species    = species.id;
    this.speciesLabel = species.label;
    this.speciesRef = species; // cached reference, avoids per-frame array lookup
    this.radiusMul  = species.radiusMul;
    this.scoreMul   = species.scoreMul;
    this.isBoss     = species.id === 'titan';
    // 'slug' | 'centipede' | 'insect' | undefined (undefined = normal snake
    // glide). Read by Snake.draw() for body rendering and by this class's
    // update() for steering-personality tweaks.
    this.moveStyle  = species.moveStyle || null;
    // Used by the centipede leg-wiggle and the insect jitter-walk — a
    // free-running timer rather than something tied to distance travelled,
    // so it animates even at a dead stop.
    this._wiggleT   = Math.random() * 10;

    this.foodGrid = foodGrid;
    this.snakes   = snakes;
    this.state    = AI_STATE.WANDER;
    this.name     = this.isBoss ? 'Titan Serpent' : generateName();

    // Every AI snake always has an emoji face — plain circle heads are
    // player-only now (only shown when the player has "None" selected).
    // Regular AI picks from the full player-facing list for variety;
    // Titan boss always picks from its own fixed, more menacing set.
    this.face = this.isBoss
      ? TITAN_FACE_EMOJIS[Math.floor(Math.random() * TITAN_FACE_EMOJIS.length)]
      : SNAKE_FACE_EMOJIS[Math.floor(Math.random() * SNAKE_FACE_EMOJIS.length)];

    // Assign personality (independent of species — a Garter Snake can be
    // aggressive, an Anaconda can be a coward, etc.). The boss always gets
    // its own dedicated 'boss' personality — a relentless player-hunter —
    // rather than a random roll.
    this.personality = this.isBoss
      ? 'boss'
      : AI_PERSONALITIES[Math.floor(Math.random() * AI_PERSONALITIES.length)];

    this._wanderAngle  = Math.random() * Math.PI * 2;
    this._wanderDist   = 55;
    this._wanderRadius = 30;
    this._wanderJitter = 1.2;

    // Personality-adjusted parameters
    this.FOOD_RADIUS     = 180;
    this.SNAKE_SENSE_R   = 220;
    this.BODY_SENSE_R    = 110;
    // Lookahead was 3 steps x 30 units = 90 units total — barely more than
    // one body-length, so the AI often didn't "see" a wall or a body until
    // it was nearly touching it. Longer/farther lookahead lets it react
    // like it's actually planning ahead instead of noticing at the last
    // possible instant.
    this.LOOKAHEAD_STEPS = 5;
    this.LOOKAHEAD_DIST  = 42;
    // MAX_FORCE/STEER_LERP were fixed at values tuned for gentle wandering,
    // which made every snake feel the same and slow to react even when
    // chasing or fleeing. Raised across the board; _applyPersonality()
    // further differentiates aggressive/hunter (sharper) from farmer/coward
    // (comparatively gentler) below.
    this.MAX_FORCE  = 0.20;
    this.STEER_LERP = 8.0;
    // Multiplier applied on top of STEER_LERP only during hard-priority
    // danger avoidance (see update()) — makes the "about to hit something"
    // turn noticeably snappier than everyday steering.
    this._urgentTurnMul = 1.8;
    this.pursueThreshold = 8;   // sizeDiff needed to pursue
    this.fleeThreshold   = 8;   // sizeDiff needed to flee

    // Base speed starts from the species multiplier; _applyPersonality()
    // below layers its own multiplier on top of BASE_SPEED, so we blend
    // both into a single combined multiplier applied last.
    this.speed = BASE_SPEED * species.speedMul;
    this._applyPersonality(species.speedMul);

    this._hyst = { PURSUE: 0, FLEE: 0, AVOID: 0, SEEK_FOOD: 0 };
    this._fleeTarget = null; this._pursueTarget = null; this._avoidNormal = null;
    this._nearby = []; this._nearbySnakes = [];

    // AI snakes can now pick up ATTACK food just like the player and get
    // the same temporary bite ability — see activateAttack(). This doesn't
    // touch any of the sensing/steering above, so personality, smartness
    // and defensive behavior (flee/avoid/wall/body danger) are unaffected;
    // it only adds an extra thing that can happen when they collide head
    // to body while this timer is active.
    this.attackTimer = 0;

    // Striped body pattern — gives each AI a distinct multi-colour look
    // instead of one flat body colour. Boss keeps its solid red/black look
    // (handled via forcedSpecies call site), so only assign for normal AI.
    this.stripePattern = forcedSpecies ? null : nextAIStripePattern();
  }

  activateAttack() { this.attackTimer = ATTACK_DURATION; }

  _applyPersonality(speciesSpeedMul = 1) {
    switch (this.personality) {
      case 'aggressive':
        this.pursueThreshold = 4;
        this.fleeThreshold   = 25;
        this.speed = BASE_SPEED * speciesSpeedMul * 1.08;
        // Sharpest turning of any personality — an aggressive snake that
        // corners its prey should actually be able to corner it, not
        // overshoot every turn.
        this.MAX_FORCE  = 0.26;
        this.STEER_LERP = 10.0;
        break;
      case 'coward':
        this.pursueThreshold = 30;
        this.fleeThreshold   = 4;
        this.speed = BASE_SPEED * speciesSpeedMul * 0.95;
        // Cowards still need to juke effectively when fleeing, so keep
        // turning reasonably sharp despite being slower overall.
        this.MAX_FORCE  = 0.22;
        this.STEER_LERP = 9.0;
        break;
      case 'hunter':
        this.SNAKE_SENSE_R = 380;
        this.speed = BASE_SPEED * speciesSpeedMul * 1.05;
        this.MAX_FORCE  = 0.24;
        this.STEER_LERP = 9.5;
        break;
      case 'boss':
        // Relentless: huge sense radius, barely ever flees, always willing
        // to pursue regardless of size difference (a Titan doesn't back
        // down from anything smaller than itself, and rarely meets bigger).
        this.SNAKE_SENSE_R   = 600;
        this.FOOD_RADIUS     = 260;
        this.pursueThreshold = -999; // pursue almost anything
        this.fleeThreshold   = 999;  // effectively never flees
        this.speed = BASE_SPEED * speciesSpeedMul * 1.03;
        // A Titan is big, but still needs to actually turn to chase —
        // otherwise its size becomes a liability instead of a threat.
        this.MAX_FORCE  = 0.18;
        this.STEER_LERP = 7.0;
        break;
      case 'farmer':
        this.FOOD_RADIUS   = 320;
        this.SNAKE_SENSE_R = 80;
        this.pursueThreshold = 999;
        this.speed = BASE_SPEED * speciesSpeedMul;
        // Farmers aren't fighters — leave steering at the (already raised)
        // base values rather than sharpening further.
        break;
      default:
        this.speed = BASE_SPEED * speciesSpeedMul;
    }

    // Snapshot personality-tuned base values. The time-based difficulty
    // curve (see update()) scales *from* these each frame rather than
    // mutating them in place — otherwise repeated scaling would compound
    // and drift the numbers well past their intended range.
    this._baseSenseR       = this.SNAKE_SENSE_R;
    this._baseMaxForce     = this.MAX_FORCE;
    this._baseSteerLerp    = this.STEER_LERP;
    this._basePursueThresh = this.pursueThreshold;
  }

  update(dt) {
    if (!this.alive) return;
    if (this.attackTimer > 0) this.attackTimer = Math.max(0, this.attackTimer - dt);
    this._wiggleT += dt;

    // ── Difficulty curve ───────────────────────────────────────
    // The longer a run goes, the sharper AI steering/awareness gets, so a
    // 10-minute session doesn't stay as easy as the first 30 seconds. The
    // boss is excluded — a Titan is already tuned to be maximally
    // relentless, so scaling it further would just feel unfair rather
    // than "harder in an interesting way".
    if (!this.isBoss) {
      const dt_ = (window._game && window._game._difficultyT) || 0;
      const bonus = 1 + dt_ * DIFFICULTY_MAX_BONUS;
      this.SNAKE_SENSE_R = this._baseSenseR   * bonus;
      this.MAX_FORCE     = this._baseMaxForce * bonus;
      this.STEER_LERP    = this._baseSteerLerp * bonus;
      // Pursue threshold moves the other way — lower means "willing to
      // chase smaller size advantages", i.e. more aggressive. Never push
      // it past a floor of 2 so a hard-coded 999 "never pursue" farmer
      // still stays passive rather than flipping into a hunter.
      if (this._basePursueThresh < 900) {
        this.pursueThreshold = Math.max(2, this._basePursueThresh * (1 - dt_ * 0.3));
      }
    }

    const { nearbyFood, fleeTarget, pursueTarget, avoidNormal } = this._sense();
    this.state = this._evalFSM(dt, nearbyFood, fleeTarget, pursueTarget, avoidNormal);

    // ── Priority steering ──────────────────────────────────────
    // Previously, wall-avoidance and body-avoidance forces were summed
    // together with normal wander/pursue/flee steering and THEN clamped to
    // a single MAX_FORCE. That meant a strong "turn away from the wall"
    // signal could get averaged down to near-nothing by whatever the snake
    // was already doing (chasing food, pursuing prey), so it kept drifting
    // straight into boundaries and into each other. Now, close-range wall
    // and body danger is treated as a hard override: if the snake is
    // genuinely close to a collision, that force alone drives steering
    // (at a faster turn rate), instead of being diluted into an average.
    const dangerWall = this._wallDangerForce();
    const dangerBody = this._bodyDangerForce();

    let force, lerpT;
    if (dangerWall || dangerBody) {
      // Blend the two danger sources if both are present (e.g. cornered
      // near a wall with another snake's body also close), otherwise use
      // whichever fired.
      force = dangerWall && dangerBody ? dangerWall.add(dangerBody).normalize()
            : (dangerWall || dangerBody);
      lerpT = Math.min(1, this.STEER_LERP * this._urgentTurnMul * dt);
    } else {
      let normalForce = this._computeForce(dt, nearbyFood, fleeTarget, pursueTarget, avoidNormal);
      // Soft wall/body cushioning still applies during normal steering so
      // the AI naturally curves away well before it'd ever need the hard
      // override above — the override is a last-resort safety net, not
      // the primary way snakes avoid the edge.
      const softWall = this._wallAvoidForce();
      if (softWall) normalForce = normalForce.add(softWall);
      force = normalForce.clamp(this.MAX_FORCE);
      lerpT = Math.min(1, this.STEER_LERP * dt);
    }

    this.dir = this.dir.lerp(this.dir.add(force), lerpT).normalize();

    // Insects (ants) skitter rather than glide smoothly — layer a fast,
    // small-amplitude random wobble on top of whatever the normal AI
    // steering already decided. Kept additive/small so it still actually
    // reaches food and reacts to danger correctly; it's cosmetic twitch,
    // not a replacement for real steering.
    if (this.moveStyle === 'insect') {
      const jitterAngle = Math.sin(this._wiggleT * 14) * 0.35 + Math.sin(this._wiggleT * 31) * 0.18;
      const cosA = Math.cos(jitterAngle), sinA = Math.sin(jitterAngle);
      const jx = this.dir.x * cosA - this.dir.y * sinA;
      const jy = this.dir.x * sinA + this.dir.y * cosA;
      this.dir = new Vector2(jx, jy).normalize();
    }

    const personalityMul = this.personality === 'aggressive' ? 1.08
                          : this.personality === 'coward'    ? 0.95
                          : this.personality === 'hunter'    ? 1.05
                          : this.personality === 'boss'      ? 1.03
                          : 1;
    const speciesMul = this.speciesRef ? this.speciesRef.speedMul : 1;
    this.speed = this._calcSpeed(BASE_SPEED * personalityMul * speciesMul);
    this._applyDirection(dt);
    this._moveSegments();
    this._grow();
  }

  _sense() {
    const nearbyFood = this.foodGrid.query(this.head.x, this.head.y, this.FOOD_RADIUS, this._nearby);
    let fleeTarget = null, pursueTarget = null;
    let closestFleeDistSq = Infinity, closestPursueDistSq = Infinity;

    for (const other of this.snakes) {
      if (other === this || !other.alive) continue;
      const dsq = Vector2.distSq(this.head, other.head);
      if (dsq > this.SNAKE_SENSE_R * this.SNAKE_SENSE_R) continue;
      const sizeDiff = other.length - this.length;

      // Hunter always targets player if in range and player is smaller
      if (this.personality === 'hunter' && other.isPlayer && other.length < this.length) {
        if (dsq < closestPursueDistSq) { closestPursueDistSq = dsq; pursueTarget = other; }
        continue;
      }

      if (sizeDiff > this.fleeThreshold) {
        if (dsq < closestFleeDistSq) { closestFleeDistSq = dsq; fleeTarget = other; }
      } else if (sizeDiff < -this.pursueThreshold) {
        if (dsq < closestPursueDistSq) { closestPursueDistSq = dsq; pursueTarget = other; }
      }
    }

    let avoidNormal = null;
    outerLoop:
    for (let step = 1; step <= this.LOOKAHEAD_STEPS; step++) {
      const probeX = this.head.x + this.dir.x * this.LOOKAHEAD_DIST * step;
      const probeY = this.head.y + this.dir.y * this.LOOKAHEAD_DIST * step;
      const hitRadSq = (SEGMENT_R_BASE * 2.2) * (SEGMENT_R_BASE * 2.2);
      for (const other of this.snakes) {
        if (other === this || !other.alive) continue;
        if (Vector2.distSq(this.head, other.head) > (this.BODY_SENSE_R + other.length * SEGMENT_GAP) * (this.BODY_SENSE_R + other.length * SEGMENT_GAP)) continue;
        // Sample every Nth segment instead of all of them. Stride is capped
        // at 2 (segments are SEGMENT_GAP=8px apart; the hit radius is
        // ~19.8px, so skipping at most one segment between checks still
        // guarantees nothing slips through undetected). This still roughly
        // halves the work on long bodies without any loss of detection
        // accuracy — the earlier higher-stride version risked gaps larger
        // than the hit radius on very long snakes and has been corrected.
        const segs   = other.segments;
        const stride = segs.length > 40 ? 2 : 1;
        for (let si = 1; si < segs.length; si += stride) {
          const seg = segs[si];
          const dx = probeX - seg.x, dy = probeY - seg.y;
          if (dx * dx + dy * dy < hitRadSq) {
            const dot  = -this.dir.y * dx + this.dir.x * dy;
            const sign = dot >= 0 ? 1 : -1;
            avoidNormal = new Vector2(-this.dir.y * sign, this.dir.x * sign);
            break outerLoop;
          }
        }
      }
    }

    this._fleeTarget = fleeTarget; this._pursueTarget = pursueTarget; this._avoidNormal = avoidNormal;
    return { nearbyFood, fleeTarget, pursueTarget, avoidNormal };
  }

  _evalFSM(dt, nearbyFood, fleeTarget, pursueTarget, avoidNormal) {
    const tick = (key, cond) => {
      if (cond) this._hyst[key] = Math.min(this._hyst[key] + dt, HYSTERESIS[key].enter + 0.1);
      else      this._hyst[key] = Math.max(0, this._hyst[key] - dt);
    };
    tick('AVOID',     avoidNormal  !== null);
    tick('FLEE',      fleeTarget   !== null);
    tick('PURSUE',    pursueTarget !== null);
    tick('SEEK_FOOD', nearbyFood.length > 0);

    if (this._hyst['AVOID']     >= HYSTERESIS.AVOID.enter)     return AI_STATE.AVOID;
    if (this._hyst['FLEE']      >= HYSTERESIS.FLEE.enter)      return AI_STATE.FLEE;
    if (this._hyst['PURSUE']    >= HYSTERESIS.PURSUE.enter)    return AI_STATE.PURSUE;
    if (this._hyst['SEEK_FOOD'] >= HYSTERESIS.SEEK_FOOD.enter) return AI_STATE.SEEK_FOOD;
    return AI_STATE.WANDER;
  }

  _computeForce(dt, nearbyFood, fleeTarget, pursueTarget, avoidNormal) {
    // Farmer heavily prefers food
    if (this.personality === 'farmer' && this.state !== AI_STATE.FLEE && nearbyFood.length > 0) {
      let bestDsq = Infinity, target = null;
      for (const f of nearbyFood) {
        const dsq = Vector2.distSq(this.head, f.pos);
        if (dsq < bestDsq) { bestDsq = dsq; target = f; }
      }
      if (target) return this.seek(target.pos).scale(1.2);
    }

    // Flock behavior — aggressive snakes coordinate
    if (this.personality === 'aggressive' && pursueTarget && this.state === AI_STATE.PURSUE) {
      const allies = this.snakes.filter(s =>
        s !== this && s.alive && s instanceof AISnake &&
        s.personality === 'aggressive' && s._pursueTarget === pursueTarget &&
        Vector2.distSq(this.head, s.head) < 200 * 200
      );
      if (allies.length > 0) {
        // This snake flanks (90° offset)
        const baseDir = this.pursue(pursueTarget);
        const perpAngle = baseDir.angle() + Math.PI / 2;
        return Vector2.fromAngle(perpAngle, 1).sub(this.dir);
      }
    }

    switch (this.state) {
      case AI_STATE.AVOID:    return avoidNormal  ? avoidNormal.scale(2.0)       : this.wander(dt).scale(0.6);
      case AI_STATE.FLEE:     return fleeTarget   ? this.evade(fleeTarget).scale(1.8) : this.wander(dt).scale(0.6);
      case AI_STATE.PURSUE:   return pursueTarget ? this.pursue(pursueTarget).scale(1.2) : this.wander(dt).scale(0.6);
      case AI_STATE.SEEK_FOOD: {
        let bestDsq = Infinity, target = null;
        for (const f of nearbyFood) {
          const dsq = Vector2.distSq(this.head, f.pos);
          if (dsq < bestDsq) { bestDsq = dsq; target = f; }
        }
        return target ? this.seek(target.pos).scale(1.0) : this.wander(dt).scale(0.6);
      }
      default: return this.wander(dt).scale(0.6);
    }
  }

  seek(targetPos) { return targetPos.sub(this.head).normalize().sub(this.dir); }
  flee(targetPos) { return this.seek(targetPos).scale(-1); }

  pursue(target) {
    const toTarget   = target.head.sub(this.head);
    const dist       = toTarget.length();
    const lookAheadT = Math.min(dist / (this.speed || BASE_SPEED), 1.5);
    const futurePos  = dist > 60 ? target.head.add(target.dir.scale(target.speed * lookAheadT)) : target.head;
    return this.seek(futurePos);
  }

  evade(threat) {
    const toThreat   = threat.head.sub(this.head);
    const dist       = toThreat.length();
    const lookAheadT = Math.min(dist / (this.speed || BASE_SPEED), 1.5);
    const futurePos  = dist > 60 ? threat.head.add(threat.dir.scale(threat.speed * lookAheadT)) : threat.head;
    return this.flee(futurePos);
  }

  wander(dt) {
    this._wanderAngle += (Math.random() - 0.5) * this._wanderJitter * dt * 60;
    const circleCentre = this.dir.scale(this._wanderDist);
    const displacement = Vector2.fromAngle(this._wanderAngle, this._wanderRadius);
    const target = this.head.add(circleCentre).add(displacement);
    return this.seek(target);
  }

  // Soft steering: gently curves the snake away from the boundary well
  // before it's in real danger. This alone used to be the only wall
  // defense, and it was easy for it to get averaged down to nothing when
  // combined with a strong pursue/flee force under one MAX_FORCE clamp —
  // see _wallDangerForce() below for the hard-priority backstop.
  _wallAvoidForce() {
    const world = window._GAME_WORLD;
    const W = world ? world.w : WORLD_W, H = world ? world.h : WORLD_H;
    const MARGIN_OUTER = 220, MARGIN_INNER = 80;
    let px = 0, py = 0;
    const hx = this.head.x, hy = this.head.y;
    const push = (dist) => dist < MARGIN_OUTER ? (1 - Math.max(0, (dist - MARGIN_INNER) / (MARGIN_OUTER - MARGIN_INNER))) : 0;
    px +=  push(hx); px -= push(W - hx);
    py +=  push(hy); py -= push(H - hy);
    if (px === 0 && py === 0) return null;
    const len = Math.sqrt(px * px + py * py);
    return new Vector2(px / len, py / len).scale(0.3);
  }

  // Hard priority: fires only when genuinely close to the boundary (closer
  // than the soft margin above ever lets it get under normal steering).
  // When this returns non-null, update() uses it directly instead of
  // blending it into the normal weighted-sum steering — a snake this close
  // to the wall needs to turn NOW, not "somewhat more than it was going to".
  _wallDangerForce() {
    const world = window._GAME_WORLD;
    const W = world ? world.w : WORLD_W, H = world ? world.h : WORLD_H;
    const DANGER = 70;
    const hx = this.head.x, hy = this.head.y;
    const distToEdge = Math.min(hx, W - hx, hy, H - hy);
    if (distToEdge >= DANGER) return null;

    // Steer toward world center — simple, always correct regardless of
    // which edge (or corner) triggered it.
    const cx = W / 2, cy = H / 2;
    const toCenter = new Vector2(cx - hx, cy - hy);
    if (toCenter.length() < 1e-6) return this.dir; // degenerate: already at center
    return toCenter.normalize();
  }

  // Hard priority body-collision override: fires only when a lookahead
  // probe finds another snake's segment inside a tighter, closer-range
  // radius than the FSM's AVOID state normally reacts to. This is the
  // last-resort "about to hit something" case, not the everyday steering.
  _bodyDangerForce() {
    const DANGER_DIST = SEGMENT_R_BASE * 3.2;
    const dangerDsq = DANGER_DIST * DANGER_DIST;
    const hx = this.head.x, hy = this.head.y;
    for (const other of this.snakes) {
      if (other === this || !other.alive) continue;
      if (Vector2.distSq(this.head, other.head) > (this.BODY_SENSE_R + other.length * SEGMENT_GAP) * (this.BODY_SENSE_R + other.length * SEGMENT_GAP)) continue;
      // Same safe stride as _sense()'s lookahead loop above — halves the
      // segment checks on long bodies without risking a missed detection
      // (DANGER_DIST ≈ 28.8px comfortably covers a 2-segment/16px stride).
      const segs   = other.segments;
      const stride = segs.length > 40 ? 2 : 1;
      for (let i = 1; i < segs.length; i += stride) {
        const seg = segs[i];
        const dx = hx - seg.x, dy = hy - seg.y;
        if (dx * dx + dy * dy < dangerDsq) {
          // Steer perpendicular to current heading, away from the segment.
          const away = new Vector2(dx, dy);
          const len = away.length();
          if (len < 1e-6) continue;
          return away.scale(1 / len);
        }
      }
    }
    return null;
  }
}

/* ─────────────────────────────────────────────────────────────
   8. GAME
───────────────────────────────────────────────────────────── */
let _lastAIPaletteIdx = -1;
const AI_PALETTES = [
  ['#f56a6a', '#ff9a9a'], ['#a56aff', '#d0a5ff'],
  ['#ffb347', '#ffd78a'], ['#6ae0ff', '#a8eeff'],
  ['#ff6ab8', '#ffa8d8'], ['#c8ff6a', '#e5ff9a'],
  ['#ff6a6a', '#ffaaaa'], ['#6affcc', '#a8ffe0'],
  ['#ff8c6a', '#ffba9a'], ['#6a8cff', '#9ab0ff'],
];

function randomAIPalette() {
  let idx;
  do { idx = Math.floor(Math.random() * AI_PALETTES.length); }
  while (idx === _lastAIPaletteIdx && AI_PALETTES.length > 1);
  _lastAIPaletteIdx = idx;
  return AI_PALETTES[idx];
}

let _lastStripeIdx = -1;
function nextAIStripePattern() {
  let idx;
  do { idx = Math.floor(Math.random() * AI_STRIPE_PATTERNS.length); }
  while (idx === _lastStripeIdx && AI_STRIPE_PATTERNS.length > 1);
  _lastStripeIdx = idx;
  return AI_STRIPE_PATTERNS[idx];
}

const FOOD_COLORS = [
  '#ff5e57','#ffa41b','#ffdd00','#7bff6a',
  '#00d2ff','#8c52ff','#ff52c0','#52ffca',
];

