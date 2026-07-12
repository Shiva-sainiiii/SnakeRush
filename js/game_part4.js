/* ─────────────────────────────────────────────────────────────
   GAME CLASS — RENDER METHODS
   (attached to Game.prototype; Game itself is defined in game.part3a.js)
───────────────────────────────────────────────────────────── */
Object.assign(Game.prototype, {
  /* ── RENDER ─────────────────────────────────────────────── */
  _render() {
    const { ctx, canvas } = this;
    // Logical (CSS) pixel dimensions — all draw calls use these because
    // ctx.setTransform(dpr,0,0,dpr,0,0) is in effect from _setupResize.
    const logW = canvas.width  / this._dpr;
    const logH = canvas.height / this._dpr;

    const shake = this.shake ? this.shake.getOffset() : { x: 0, y: 0 };

    ctx.save();
    ctx.translate(shake.x, shake.y);

    ctx.clearRect(-10, -10, logW + 20, logH + 20);

    this._drawBackground(logW, logH);
    this._drawWorldBorder();
    this._drawBiomes();

    if (this.player && this.player.alive && this.player.magnetTimer > 0) this._drawMagnetAura();

    ctx.save();
    for (const food of this.foods) food.draw(ctx, this.camX, this.camY);
    ctx.restore();

    // Draw mines
    if (this.player && this.player.activeMines) {
      for (const mine of this.player.activeMines) mine.draw(ctx, this.camX, this.camY);
    }

    for (const snake of this.snakes) snake.draw(ctx, this.camX, this.camY);

    this.particles.draw(ctx, this.camX, this.camY);

    if (this._mode === 'arena') this._drawArenaPulse(logW, logH);
    this._drawMinimap(logW, logH);
    if (this.player && this.player.alive) this._drawWallWarning(logW, logH);

    // Joystick
    if (this._joystick && this._joystick.active) this._drawJoystick(ctx);

    ctx.restore();

    // Canvas-space overlays (not shaken)
    this.killFeed.draw(ctx, logW);
    this.combo.draw(ctx, this.camX, this.camY);
    this.achievements.draw(ctx, logW, logH);
  },

  _drawJoystick(ctx) {
    const j = this._joystick;
    ctx.save();
    ctx.globalAlpha = 0.45;

    // Outer ring
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.arc(j.originX, j.originY, j.maxR, 0, Math.PI * 2);
    ctx.stroke();

    // Inner thumb
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.arc(j.thumbX, j.thumbY, 18, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = 1;
    ctx.restore();
  },

  _drawMagnetAura() {
    const { ctx } = this;
    const hx = this.player.head.x - this.camX, hy = this.player.head.y - this.camY;
    const pulse = 0.5 + 0.5 * Math.sin(Date.now() * 0.004);
    ctx.save();
    ctx.strokeStyle = `rgba(0,200,255,${(0.12 + pulse * 0.12).toFixed(2)})`;
    ctx.lineWidth   = 2;
    ctx.setLineDash([8, 6]);
    ctx.lineDashOffset = -Date.now() * 0.05;
    ctx.shadowColor = '#00ccff'; ctx.shadowBlur = 10;
    ctx.beginPath(); ctx.arc(hx, hy, MAGNET_RADIUS, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  },

  _drawBackground(logW, logH) {
    const { ctx } = this;
    ctx.fillStyle = '#050a0f';
    ctx.fillRect(-10, -10, logW + 20, logH + 20);

    const gridSpacing = 40;
    if (!this._bgTile ||
        this._bgTile.width  !== logW  + gridSpacing * 2 ||
        this._bgTile.height !== logH + gridSpacing * 2) {
      const tw = logW  + gridSpacing * 2;
      const th = logH + gridSpacing * 2;
      const oc  = new OffscreenCanvas(tw, th);
      const oc2 = oc.getContext('2d');
      oc2.fillStyle = 'rgba(80,140,200,0.11)';
      for (let x = 0; x < tw; x += gridSpacing) {
        for (let y = 0; y < th; y += gridSpacing) {
          oc2.beginPath(); oc2.arc(x, y, 1.2, 0, Math.PI * 2); oc2.fill();
        }
      }
      this._bgTile = oc;
    }

    const offX = (-(this.camX % gridSpacing) + gridSpacing) % gridSpacing;
    const offY = (-(this.camY % gridSpacing) + gridSpacing) % gridSpacing;
    ctx.drawImage(this._bgTile, offX - gridSpacing, offY - gridSpacing);
  },

  _drawBiomes() {
    const { ctx } = this;
    const W = this._worldW, H = this._worldH;
    const bw = W / 3, bh = H / 3;
    ctx.save();
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        const biome = BIOMES[row * 3 + col];
        const wx = col * bw - this.camX;
        const wy = row * bh - this.camY;
        ctx.fillStyle = biome.color;
        ctx.fillRect(wx, wy, bw, bh);
      }
    }
    ctx.restore();
  },

  /* ANIMATED ELECTRIC FENCE BORDER
     Perf notes:
     - Only draws border dashes near the camera viewport (world is
       5500x5500, screen shows a tiny slice) instead of all 200 every frame.
     - shadowBlur applied ONCE per frame instead of per-dash (200x fewer
       shadow evaluations -- shadowBlur is one of the most expensive canvas
       ops on mobile GPUs and was a major cause of lag). */
  _drawWorldBorder() {
    const { ctx } = this;
    const W = this._worldW, H = this._worldH;
    const x = -this.camX, y = -this.camY;
    const now = Date.now();
    const logW = this.canvas.width  / this._dpr;
    const logH = this.canvas.height / this._dpr;

    let isRed = false;
    if (this.player && this.player.alive) {
      const hx = this.player.head.x, hy = this.player.head.y;
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
    ctx.lineWidth  = 2 + brightness;

    const DASH_COUNT = 200;
    const PERIMETER   = W * 2 + H * 2;
    const dashLen     = 8;
    const margin      = 40;

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
        const t  = i / dashCount;
        const px = edge.x1 + nx * len * t;
        const py = edge.y1 + ny * len * t;
        const sx = x + px, sy = y + py;

        // Cull dashes outside the viewport -- key fix, since previously all
        // 200 were drawn even though only a handful are ever visible.
        if (sx < -margin || sx > logW + margin || sy < -margin || sy > logH + margin) continue;

        ctx.moveTo(sx - nx * dashLen / 2, sy - ny * dashLen / 2);
        ctx.lineTo(sx + nx * dashLen / 2, sy + ny * dashLen / 2);
      }
    }
    ctx.stroke();

    ctx.restore();
  },

  _drawArenaPulse(logW, logH) {
    const { ctx } = this;
    const pulse = 0.5 + 0.5 * Math.sin(Date.now() * 0.003);
    const alpha = pulse * 0.08;
    ctx.save();
    ctx.fillStyle = `rgba(255,40,40,${alpha.toFixed(3)})`;
    ctx.fillRect(0, 0, logW, logH);
    ctx.restore();
  },

  _drawWallWarning(logW, logH) {
    const { ctx } = this;
    if (!this.player.alive) return;
    const W = this._worldW, H = this._worldH;
    const hx = this.player.head.x, hy = this.player.head.y;
    const nearest = Math.min(hx, W - hx, hy, H - hy);
    if (nearest >= DANGER_ZONE_DIST) return;

    const intensity = (1 - nearest / DANGER_ZONE_DIST) * 0.5;
    const grad = ctx.createRadialGradient(
      logW / 2, logH / 2, logH * 0.3,
      logW / 2, logH / 2, logH * 0.8
    );
    grad.addColorStop(0, 'rgba(255,40,40,0)');
    grad.addColorStop(1, `rgba(255,40,40,${intensity.toFixed(2)})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, logW, logH);
  },

  _drawMinimap(logW, logH) {
    const { ctx } = this;

    // ── Responsive minimap sizing ─────────────────────────────
    // On narrow portrait phones (< 480px wide) shrink the minimap so it
    // cannot collide with the HUD pill or overflow the right edge.
    const isNarrow   = logW < 480;
    const MAP_W      = isNarrow ? 110 : 150;
    const MAP_H      = isNarrow ? 110 : 150;
    // Keep minimap clear of the safe-area right edge
    const safeRight  = 0; // canvas ctx is already in logical coords; CSS safe-area handled by body padding
    const MAP_PAD    = isNarrow ? 8 : 14;
    const MAP_X      = logW - MAP_W - MAP_PAD;
    // Top: push below safe-area inset + HUD height headroom
    // HUD can wrap to multiple rows with powerups, so use a larger clearance
    // Safer estimate: safe-area + 80px for HUD + gaps
    const HUD_CLEARANCE = isNarrow ? 95 : 70;
    const MAP_Y      = HUD_CLEARANCE + MAP_PAD;

    const W = this._worldW, H = this._worldH;
    const SCALE_X = MAP_W / W, SCALE_Y = MAP_H / H;

    ctx.save();
    ctx.fillStyle   = 'rgba(5,10,15,0.7)';
    ctx.strokeStyle = 'rgba(126,255,178,0.25)';
    ctx.lineWidth   = 1;
    ctx.beginPath(); ctx.roundRect(MAP_X, MAP_Y, MAP_W, MAP_H, 14); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.roundRect(MAP_X, MAP_Y, MAP_W, MAP_H, 14); ctx.clip();

    ctx.fillStyle = 'rgba(126,255,178,0.3)';
    for (const f of this.foods) {
      if (f.expired) continue;
      ctx.fillRect(MAP_X + f.pos.x * SCALE_X - 0.5, MAP_Y + f.pos.y * SCALE_Y - 0.5, 1.5, 1.5);
    }

    for (let i = 1; i < this.snakes.length; i++) {
      const s = this.snakes[i];
      if (!s.alive) continue;
      ctx.fillStyle = s.headColor;
      ctx.beginPath();
      const dotR = 2.5 * (s.radiusMul || 1);
      ctx.arc(MAP_X + s.head.x * SCALE_X, MAP_Y + s.head.y * SCALE_Y, dotR, 0, Math.PI * 2);
      ctx.fill();
    }

    if (this.player && this.player.alive) {
      ctx.fillStyle = '#7effb2'; ctx.shadowColor = '#7effb2'; ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.arc(MAP_X + this.player.head.x * SCALE_X, MAP_Y + this.player.head.y * SCALE_Y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur  = 0; ctx.strokeStyle = 'rgba(255,255,255,0.2)'; ctx.lineWidth = 1;
      ctx.strokeRect(
        MAP_X + this.camX * SCALE_X,
        MAP_Y + this.camY * SCALE_Y,
        logW * SCALE_X,
        logH * SCALE_Y
      );
    }

    ctx.restore();
  }
});
