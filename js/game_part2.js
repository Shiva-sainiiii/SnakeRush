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
});

class Food {
  constructor(x, y, color, type = FOOD_TYPE.NORMAL, ttl = null) {
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
    switch (Settings.design) {
      case 'fatty':  return Math.round(SEGMENT_R_BASE * 1.45);
      case 'thin':   return Math.round(SEGMENT_R_BASE * 0.60);
      default:       return SEGMENT_R_BASE;
    }
  }
  if (snakeOrIsPlayer && snakeOrIsPlayer.isPlayer) {
    return getSegmentR(true);
  }
  if (snakeOrIsPlayer && snakeOrIsPlayer.radiusMul) {
    return Math.round(SEGMENT_R_BASE * snakeOrIsPlayer.radiusMul);
  }
  return SEGMENT_R_BASE;
}

let _designerPaletteIdx = 0;
let _designerTimer      = 0;
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

  get length() { return this.segments.length; }
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

  eat(points = 1) { this._growBuffer += 4; this.score += points; }

  _grow() {
    if (this._growBuffer <= 0) return;
    this._growBuffer--;
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
    const isMulticolour = this.isPlayer && Settings.design === 'multicolour' && !inAttack;

    // Body
    const _dpr  = window._game ? window._game._dpr : 1;
    const _logW = ctx.canvas.width  / _dpr;
    const _logH = ctx.canvas.height / _dpr;

    if (isMulticolour) {
      for (let i = len - 1; i >= 1; i--) {
        const sx = segs[i].x - camX, sy = segs[i].y - camY;
        if (sx < -segR * 2 || sx > _logW + segR * 2 || sy < -segR * 2 || sy > _logH + segR * 2) continue;
        ctx.beginPath();
        ctx.arc(sx, sy, segR, 0, Math.PI * 2);
        ctx.fillStyle = MULTICOLOUR_PALETTE[i % MULTICOLOUR_PALETTE.length];
        ctx.fill();
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

    // Head
    const hx = segs[0].x - camX, hy = segs[0].y - camY;
    ctx.save();
    ctx.shadowColor = glowColor;
    ctx.shadowBlur  = inAttack ? 28 : (inShield ? 22 : (inSpeed ? 20 : 16));
    ctx.beginPath();
    ctx.arc(hx, hy, segR * 1.35, 0, Math.PI * 2);
    ctx.fillStyle = headFill;
    ctx.fill();
    ctx.restore();

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

    this._drawEyes(ctx, hx, hy, segR);

    if (isGhost) ctx.globalAlpha = 1;
  }

  _resolveBodyColor() {
    if (this.isPlayer && Settings.design === 'designer') return DESIGNER_PALETTES[_designerPaletteIdx][0];
    return this.bodyColor;
  }
  _resolveHeadColor() {
    if (this.isPlayer && Settings.design === 'designer') return DESIGNER_PALETTES[_designerPaletteIdx][1];
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

    this.lives          = PLAYER_LIVES;
    this.iFrameTimer    = 0;
    this.magnetTimer    = 0;
    this.attackTimer    = 0;
    this.shieldTimer    = 0;
    this.ghostTimer     = 0;
    this.mineTimer      = 0;
    this.speedBoostTimer = 0;

    this._mineDeployAcc  = 0;
    this.activeMines     = [];  // Mine objects
  }

  update(dt, camX, camY, joystickDir = null, gyroDir = null) {
    if (!this.alive) return;

    if (this.iFrameTimer   > 0) this.iFrameTimer   = Math.max(0, this.iFrameTimer   - dt);
    if (this.magnetTimer   > 0) this.magnetTimer   = Math.max(0, this.magnetTimer   - dt);
    if (this.attackTimer   > 0) this.attackTimer   = Math.max(0, this.attackTimer   - dt);
    if (this.shieldTimer   > 0) this.shieldTimer   = Math.max(0, this.shieldTimer   - dt);
    if (this.ghostTimer    > 0) this.ghostTimer    = Math.max(0, this.ghostTimer    - dt);
    if (this.speedBoostTimer > 0) this.speedBoostTimer = Math.max(0, this.speedBoostTimer - dt);
    if (this.mineTimer     > 0) this.mineTimer     = Math.max(0, this.mineTimer     - dt);

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

    const speedMul = this.speedBoostTimer > 0 ? SPEED_BOOST_MUL : 1;
    const scaledBase  = this._calcSpeed(BASE_SPEED  * speedMul);
    const scaledBoost = this._calcSpeed(BOOST_SPEED * speedMul);
    this.speed = (this.boosting && this.segments.length > 6) ? scaledBoost : scaledBase;

    if (this.boosting && this.segments.length > 6 && this.speedBoostTimer <= 0) {
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

  get invincible() { return this.iFrameTimer > 0 || this.shieldTimer > 0; }
  get isGhost()    { return this.ghostTimer > 0; }
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
    // Boss tier: weight 0 so pickSpecies() (used for normal AI spawns and
    // respawns) never rolls this by chance — it's only ever assigned
    // directly by the dedicated boss-spawn call in Game.
    id: 'titan', label: 'Titan Serpent',
    minLen: 95, maxLen: 130, radiusMul: 2.4, speedMul: 0.9,
    weight: 0,  scoreMul: 5.0,
  },
];
const SNAKE_SPECIES_TOTAL_WEIGHT = SNAKE_SPECIES.reduce((s, sp) => s + sp.weight, 0);

function pickSpecies() {
  let r = Math.random() * SNAKE_SPECIES_TOTAL_WEIGHT;
  for (const sp of SNAKE_SPECIES) {
    r -= sp.weight;
    if (r <= 0) return sp;
  }
  return SNAKE_SPECIES[SNAKE_SPECIES.length - 1];
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

    this.foodGrid = foodGrid;
    this.snakes   = snakes;
    this.state    = AI_STATE.WANDER;
    this.name     = this.isBoss ? 'Titan Serpent' : generateName();

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
  }

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
  }

  update(dt) {
    if (!this.alive) return;
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
    const dangerBody = this._bodyDangerForce(pursueTarget);

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
        // Skip the snake we're actively pursuing — otherwise closing in
        // for the kill constantly re-triggers avoidance the moment the
        // target's own body/tail is nearby (which it always will be during
        // a chase), and AVOID outranks PURSUE below, so the AI would
        // flinch away and cancel its own attack right as it got close
        // enough to land it.
        if (other === pursueTarget) continue;
        if (Vector2.distSq(this.head, other.head) > (this.BODY_SENSE_R + other.length * SEGMENT_GAP) * (this.BODY_SENSE_R + other.length * SEGMENT_GAP)) continue;
        for (const seg of other.segments) {
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
  //
  // `pursueTarget` is excluded on purpose: a snake actively attacking prey
  // needs to be willing to close in on that prey's body to land the kill.
  // Without this exclusion, aggressive/hunter AI would flinch away and
  // abandon the chase the instant the prey's tail curved nearby, making
  // them feel passive no matter how aggressive their personality was set.
  _bodyDangerForce(pursueTarget = null) {
    const DANGER_DIST = SEGMENT_R_BASE * 3.2;
    const dangerDsq = DANGER_DIST * DANGER_DIST;
    const hx = this.head.x, hy = this.head.y;
    for (const other of this.snakes) {
      if (other === this || !other.alive) continue;
      if (other === pursueTarget) continue;
      if (Vector2.distSq(this.head, other.head) > (this.BODY_SENSE_R + other.length * SEGMENT_GAP) * (this.BODY_SENSE_R + other.length * SEGMENT_GAP)) continue;
      for (let i = 1; i < other.segments.length; i++) {
        const seg = other.segments[i];
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

const FOOD_COLORS = [
  '#ff5e57','#ffa41b','#ffdd00','#7bff6a',
  '#00d2ff','#8c52ff','#ff52c0','#52ffca',
];

