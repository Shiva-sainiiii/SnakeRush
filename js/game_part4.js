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

  // Shared geometry for the small in-game minimap — used both by
  // _drawMinimap() below and by the canvas tap/click handlers (in
  // game_part3.js) that detect a tap on the minimap to open the
  // fullscreen map. Keeping this in one place means the tappable area
  // always exactly matches what's drawn, even as responsive sizing
  // changes on narrow screens.
  _getMinimapRect(logW, logH) {
    const isNarrow   = logW < 480;
    const MAP_W      = isNarrow ? 110 : 150;
    const MAP_H      = isNarrow ? 110 : 150;
    const MAP_PAD    = isNarrow ? 8 : 14;
    const MAP_X      = logW - MAP_W - MAP_PAD;
    const HUD_CLEARANCE = isNarrow ? 95 : 70;
    const MAP_Y      = HUD_CLEARANCE + MAP_PAD;
    return { x: MAP_X, y: MAP_Y, w: MAP_W, h: MAP_H };
  },

  _drawMinimap(logW, logH) {
    const { ctx } = this;

    // ── Responsive minimap sizing ─────────────────────────────
    // On narrow portrait phones (< 480px wide) shrink the minimap so it
    // cannot collide with the HUD pill or overflow the right edge.
    const { x: MAP_X, y: MAP_Y, w: MAP_W, h: MAP_H } = this._getMinimapRect(logW, logH);

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
      if (s.isBoss) {
        // Pulsing highlight so the Titan's location reads at a glance
        // instead of blending in with the regular AI dots.
        const pulse = 0.5 + 0.5 * Math.sin(Date.now() * 0.006);
        ctx.fillStyle = `rgba(255,${Math.round(60 + pulse * 100)},20,1)`;
      } else {
        ctx.fillStyle = s.headColor;
      }
      ctx.beginPath();
      // Boss dot uses a flat bump rather than the full 2.4x radiusMul —
      // on a 150px minimap that would swallow nearby dots entirely.
      const dotR = s.isBoss ? 5.5 : 2.5 * (s.radiusMul || 1);
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

    // Small expand hint so the minimap reads as tappable — drawn outside
    // the clip region above so it isn't cut off by the rounded corners.
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = 'rgba(126,255,178,0.9)';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText('⤢', MAP_X + MAP_W - 4, MAP_Y + MAP_H - 3);
    ctx.restore();
  },

  // Fullscreen map — opened by tapping the small in-game minimap. Draws
  // the entire world on a larger dedicated canvas (#fullmap-canvas, not
  // the main game canvas) and rebuilds the snake-list panel underneath
  // it. Called from a requestAnimationFrame loop owned by the inline
  // script in index.html, only while the overlay is open, so this never
  // costs anything during normal gameplay.
  _drawFullMap() {
    const canvas = document.getElementById('fullmap-canvas');
    if (!canvas) return;

    // Match the canvas's backing-store resolution to its actual on-screen
    // CSS size (it's flex-sized by the panel layout, so this can change
    // as the overlay opens/resizes) — same dpr-scaling approach as the
    // main game canvas.
    const dpr  = this._dpr || 1;
    const cssW = canvas.clientWidth  || 300;
    const cssH = canvas.clientHeight || 300;
    const physW = Math.round(cssW * dpr), physH = Math.round(cssH * dpr);
    if (canvas.width !== physW || canvas.height !== physH) {
      canvas.width  = physW;
      canvas.height = physH;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const W = this._worldW, H = this._worldH;
    // Letterbox-fit the (square) world into whatever aspect ratio the
    // canvas element actually has, centered, so it's never stretched.
    const scale = Math.min(cssW / W, cssH / H);
    const offX = (cssW - W * scale) / 2;
    const offY = (cssH - H * scale) / 2;
    const toX = (wx) => offX + wx * scale;
    const toY = (wy) => offY + wy * scale;

    // Background + border
    ctx.fillStyle = '#050a0f';
    ctx.fillRect(offX, offY, W * scale, H * scale);
    ctx.strokeStyle = 'rgba(126,255,178,0.3)';
    ctx.lineWidth = 2;
    ctx.strokeRect(offX, offY, W * scale, H * scale);

    // Food — drawn as tiny dots, far too small individually to render
    // per-type detail at this zoom level, same simplification the small
    // minimap already makes.
    ctx.fillStyle = 'rgba(126,255,178,0.35)';
    for (const f of this.foods) {
      if (f.expired) continue;
      ctx.fillRect(toX(f.pos.x) - 0.75, toY(f.pos.y) - 0.75, 1.5, 1.5);
    }

    // Snakes — drawn as their actual body shape (a stroked path through
    // the segment chain) rather than just a head dot, so length/shape is
    // visible at a glance on the full map. List rows are collected
    // alongside drawing so both stay in sync and we only walk
    // this.snakes once.
    const rows = [];

    // Segments are sampled rather than every single one drawn — at this
    // zoom level (whole 11000x11000 world in a phone-sized canvas)
    // individual segments are sub-pixel anyway, and a long snake can have
    // 100+ segments; sampling keeps this cheap regardless of snake count
    // or length while still tracing the true shape/curve of the body.
    const SAMPLE_STEP = 3;

    const drawSnakeShape = (s, color, lineWidth) => {
      const segs = s.segments;
      if (!segs || segs.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(toX(segs[0].x), toY(segs[0].y));
      for (let i = SAMPLE_STEP; i < segs.length; i += SAMPLE_STEP) {
        ctx.lineTo(toX(segs[i].x), toY(segs[i].y));
      }
      // Always include the true tail end even if it fell between samples,
      // so the drawn length always matches the snake's actual length.
      const last = segs[segs.length - 1];
      ctx.lineTo(toX(last.x), toY(last.y));
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
    };

    for (let i = 1; i < this.snakes.length; i++) {
      const s = this.snakes[i];
      if (!s.alive) continue;

      let color;
      if (s.isBoss) {
        const pulse = 0.5 + 0.5 * Math.sin(Date.now() * 0.006);
        color = `rgba(255,${Math.round(60 + pulse * 100)},20,1)`;
      } else {
        color = s.headColor;
      }
      // Reuse the same getSegmentR() helper the real game uses for body
      // thickness (accounts for species radiusMul, girth-from-length, and
      // skin design), scaled down by the map's zoom factor, with a floor
      // so thin/far-away snakes stay visible at this zoom level.
      const worldRadius = getSegmentR(s) * (s.isBoss ? 1.35 : 1);
      const bodyWidth = Math.max(2.5, worldRadius * 2 * scale);
      drawSnakeShape(s, color, bodyWidth);

      // Small head dot at the front so direction/head position is still
      // clearly distinguishable from the rest of the body trail.
      const hx = toX(s.head.x), hy = toY(s.head.y);
      ctx.beginPath();
      ctx.arc(hx, hy, Math.max(2.5, bodyWidth * 0.7), 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      rows.push({
        name: s.isBoss ? '👑 ' + s.name : s.name,
        length: s.length,
        color: s.isBoss ? '#ff3c14' : s.headColor,
        x: Math.round(s.head.x), y: Math.round(s.head.y),
        isBoss: s.isBoss, isPlayer: false,
      });
    }

    if (this.player && this.player.alive) {
      const worldRadius = getSegmentR(this.player);
      const bodyWidth = Math.max(3, worldRadius * 2 * scale);
      drawSnakeShape(this.player, '#39ff6a', bodyWidth);

      const px = toX(this.player.head.x), py = toY(this.player.head.y);
      ctx.fillStyle = '#7effb2'; ctx.shadowColor = '#7effb2'; ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(px, py, Math.max(3, bodyWidth * 0.8), 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      // Player's current viewport, so it's clear where on the map they
      // actually are relative to everything else.
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1.5;
      const vw = (window.innerWidth  || 400) * scale;
      const vh = (window.innerHeight || 800) * scale;
      ctx.strokeRect(toX(this.camX), toY(this.camY), vw, vh);

      rows.unshift({
        name: (this.player.name || 'You') + ' (You)',
        length: this.player.length,
        color: '#7effb2',
        x: Math.round(this.player.head.x), y: Math.round(this.player.head.y),
        isBoss: false, isPlayer: true,
      });
    }

    // Sort everyone except the player by length, longest first — the
    // player row is pinned to the very top via unshift() above regardless
    // of their own length, so it's always easy to find at a glance.
    const playerRow = rows[0] && rows[0].isPlayer ? rows.shift() : null;
    rows.sort((a, b) => b.length - a.length);
    if (playerRow) rows.unshift(playerRow);

    this._renderFullMapList(rows);
  },

  // Rebuilds the #fullmap-list DOM from the row data collected in
  // _drawFullMap(). Kept as a full innerHTML rebuild rather than a diffed
  // update — the list is at most ~15 rows and only re-renders while the
  // overlay is open, so the cost is negligible and the code stays simple.
  _renderFullMapList(rows) {
    const list = document.getElementById('fullmap-list');
    if (!list) return;

    if (rows.length === 0) {
      list.innerHTML = '<div class="fullmap-row">No snakes on the map</div>';
      return;
    }

    let html = '';
    for (const r of rows) {
      const cls = r.isPlayer ? ' fullmap-row--player' : (r.isBoss ? ' fullmap-row--boss' : '');
      const safeName = String(r.name).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
      html += `<div class="fullmap-row${cls}">` +
        `<span class="fullmap-dot" style="background:${r.color}"></span>` +
        `<span class="fullmap-row-name">${safeName}</span>` +
        `<span class="fullmap-row-len">${r.length}</span>` +
        `<span class="fullmap-row-pos">${r.x}, ${r.y}</span>` +
        `</div>`;
    }
    list.innerHTML = html;
  }
});
