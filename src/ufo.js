//=== UFO (CUfo) ============================================================
// Entity ctor sub_4397F0 (IDA:26195), init sub_439932, reset sub_43A013,
// aim sub_43A105, step sub_43A943, advance sub_43AE4A, state entry
// sub_43B01D, beam/carried draw sub_43A258 (entity, depth y+2), ground
// shadow sub_43A74A/sub_43BA1A (drawn after the puddles, before entities,
// IDA:15605). Per-tick driver = scene sub_424029 (IDA:16317-16437): the
// countdown, target pick and the per-state hooks live in update() below.
// Allocated only when level >= 5 (+8402, IDA:15052). The UFO body itself is
// never drawn: only its shadow, the LightBeam and the carried sprites.
//
// States are the original ASCII codes:
//  F 70 parked          G 71 spiral (1 tick)   H 72 spiral, re-check every 20
//  I 73 beam slides in  J 74 lift starts       K 75 / L 76 lift (alternate)
//  M 77 → N             N 78 beam retracts     O 79 Sven falls back (alien)
//  P 80 → Sven action48 Q 81 exit arc          R 82 --remaining → F
const UFO_STATE = Object.freeze({
  F: 70, G: 71, H: 72, I: 73, J: 74, K: 75, L: 76, M: 77, N: 78, O: 79, P: 80, Q: 81, R: 82,
});
const UFO_FIRST_COUNTDOWN = 520;      // sub_42006D IDA:14527 (scene +476)
const UFO_IDLE_COUNTDOWN = 1000000;   // IDA:16333 / R hook IDA:16426
const UFO_PI  = 3.1415926526;         // rdata 0x474310
const UFO_2PI = 6.2831853052;         // rdata 0x474320
const UFO_SHADOW_W = 297, UFO_SHADOW_H = 166;   // Ufo67%.bmp
const UFO_BEAM_W = 98, UFO_BEAM_H = 520;        // LightBeam2=LightBeam.raw,98,520
// Lake rect (scene +172) the shaded clouds are composited into, and the
// initial cloud position (scene +188/+192) — IDA:14310-14316.
const UFO_LAKE = { l: 399, t: 362, r: 640, b: 480 };
// Sprite records (Sven.exe .data): off_496468 sheep, off_4964C8 Sven,
// unk_496528 falling alien (entries 0/1 have no image; dir remapped first).
function ufoRecs(table, n, fallback) {
  if (typeof spriteRecord !== 'function') return fallback;
  const out = [];
  for (let d = 0; d < n; d++) {
    const r = spriteRecord(table, d);
    out.push(r && r.sprite ? { name: r.sprite, dx: r.dx, dy: r.dy, flip: r.flip ? 1 : 0, speed: r.speed } : null);
  }
  return out.every((r, i) => (r === null) === (fallback[i] === null)) ? out : fallback;
}
const UFO_SHEEP_FLY_TBL = [
  { name: 'SheepFlying02', dx: -37, dy: 21, flip: 0, speed: 0.25 },
  { name: 'SheepFlying02', dx: -34, dy: 21, flip: 1, speed: 0.25 },
  { name: 'SheepFlying01', dx: -35, dy: 14, flip: 0, speed: 0.25 },
  { name: 'SheepFlying01', dx: -35, dy: 14, flip: 1, speed: 0.25 },
];
const UFO_SVEN_FLY_TBL = [
  { name: 'SvenFlying02', dx: -35, dy: 20, flip: 0, speed: 0.25 },
  { name: 'SvenFlying02', dx: -35, dy: 18, flip: 1, speed: 0.25 },
  { name: 'SvenFlying01', dx: -30, dy: 16, flip: 0, speed: 0.25 },
  { name: 'SvenFlying01', dx: -40, dy: 16, flip: 1, speed: 0.25 },
];
const UFO_ALIEN_FALL_TBL = [
  null, null,
  { name: 'AlienFall01', dx: -47, dy: 11, flip: 0, speed: 1 },
  { name: 'AlienFall01', dx: -45, dy: 11, flip: 1, speed: 1 },
];

const UFO_SHEEP_FLY = ufoRecs('SheepFlying', 4, UFO_SHEEP_FLY_TBL);
const UFO_SVEN_FLY = ufoRecs('SvenFlying', 4, UFO_SVEN_FLY_TBL);
// core.js 'AlienFall2' (0x496558) holds entries 2/3 only → read at d-2.
const UFO_ALIEN_FALL = (function () {
  if (typeof spriteRecord !== 'function') return UFO_ALIEN_FALL_TBL;
  const out = [null, null];
  for (let d = 2; d < 4; d++) {
    const r = spriteRecord('AlienFall2', d - 2);
    if (!r || !r.sprite) return UFO_ALIEN_FALL_TBL;
    out.push({ name: r.sprite, dx: r.dx, dy: r.dy, flip: r.flip ? 1 : 0, speed: r.speed });
  }
  return out;
})();

// LightBeam.raw (98x520 bytes), kept raw. 16-bpp path (the display is
// 16 bpp, IDA:7590): sub_41B798 case 16 (IDA:12153-12175) builds the source
// word `2113 * (v >> 4)` (565: R5 += n, G6 += 2n, B5 += n) where v > 0xBF,
// else 0; sub_41BD7E case 16 (IDA:12318-12340) blends
// `dst = src + ((dst & 0xF7DE) >> 1)` where src != 0.
let UFO_BEAM = null;
function ufoLoadBeam() {
  if (UFO_BEAM) return;
  UFO_BEAM = { raw: null };
  fetch(ASSETS + 'LightBeam.raw').then(r => r.arrayBuffer()).then(buf => {
    UFO_BEAM.raw = new Uint8Array(buf);
  });
}

class Ufo {
  constructor() {
    // sub_4397F0
    this.state = 0; this.timer = 1;
    this.dir = -1;          // +40 target sheep dir
    this.carryDir = -1;     // +44 carried Sven dir
    this.carrySven = false; // +116
    this.holes = new Set(); // map cells of type 6 ("col,row"), see addHole
    // sub_439932: shadow / beam offsets
    this.off76 = -Math.trunc(UFO_SHADOW_W / 2) - 5;   // -153
    this.off80 = -Math.trunc(UFO_SHADOW_H / 2) - 3;   // -86
    this.off84 = -UFO_BEAM_W / 2;                     // -49
    this.off88 = UFO_BEAM_W / 2 - UFO_BEAM_H;         // -471
    this.off92 = 0; this.off96 = -100;
    this.off100 = 0; this.off104 = 0; this.off108 = 0; this.off112 = 0;
    this.fallVel = 0;       // +160
    this.x = 0; this.y = 0; this.cx = 0; this.cy = 0;
    this.angle = 0; this.speed = 10; this.r = 0; this.dr = 2.5; this.squash = 0.33;
    this.depth = 0;
    this.sheepSeq = new MuSeq();  // +48
    this.svenSeq = new MuSeq();   // +52
    // Scene-side state of sub_424029: +476 countdown, +480 target,
    // dword_493E10/14 target cell (kept here as JS col/row).
    this.countdown = UFO_FIRST_COUNTDOWN;
    this.target = null; this.tCol = -1; this.tRow = -1;
    this._audio = null;
    this.reset();
    ufoLoadBeam();
    muRawImage('GameBackground.bmp'); muRawImage('CloudsShaded.bmp'); muRawImage('Ufo67%.bmp');
    this._shadow = null;
  }

  // sub_43A013 (vtable+44).
  reset() {
    this.state = UFO_STATE.F; this.timer = 1;
    this.x = 640 - this.off76 + 10; this.y = 100;
    this.angle = 3300; this.r = 500; this.speed = 10; this.dr = 2.5; this.squash = 0.33;
    this.carrySven = false; this.fallVel = 0;
    if (this._audio) this._audio.stop('beamLoop');
  }

  // Streak summon (sub_42546F IDA:16950-16953, 16989-16992): only while parked.
  summon() {
    if (this.state !== UFO_STATE.F) return false;
    this.countdown = 1;
    return true;
  }

  // Cell type 6 (byte3 & 0xF) left by an abduction: one per map cell, set
  // by the sheep (case 0x13, IDA:20249) or Sven (action 47, IDA:24313);
  // set back to type 1 by the UFO 'Q' hook (IDA:16413-16424, Sven on the
  // grid) or Sven's state-48 end (IDA:24748), whichever runs. Walkable for
  // Sven only (sub_43694C accepts kind 6).
  addHole(col, row) { this.holes.add(col + ',' + row); }
  clearHole(col, row) { this.holes.delete(col + ',' + row); }
  isHole(col, row) { return this.holes.has(col + ',' + row); }

  // sub_43A105: (re)plan the spiral/arc around (a2, a3).
  _aim(a2, a3) {
    if (this.state === UFO_STATE.F) {
      if (this._audio) this._audio.play('ufo');         // aUfo_0
      this.state = UFO_STATE.G;
    } else if (this.state > UFO_STATE.G && this.state <= UFO_STATE.I) {
      this.state = UFO_STATE.G;
    }
    this.cx = a2; this.cy = a3;
    const v8 = this.x - this.cx, v7 = this.y - this.cy;
    this.r = Math.sqrt(v8 * v8 + (v7 * v7) / (this.squash * this.squash));
    let v9 = Math.acos(v8 / this.r);
    if (v7 < 0) v9 = UFO_2PI - v9;
    const a = Math.trunc(1800.0 * v9 / UFO_PI);
    this.angle = Number.isFinite(a) ? a | 0 : 0;        // (int64)NaN → low dword 0
    if (v7 * v8 <= 0) { if (this.speed > 0) this.speed = -this.speed; }
    else if (this.speed < 0) this.speed = -this.speed;
  }
  _orbit() {
    this.angle += this.speed;
    if (this.angle < 3600) { if (this.angle < 0) this.angle = 3599; }
    else this.angle = 0;
    this.x = Math.trunc(Math.cos(this.angle * UFO_PI / 1800.0) * this.r) + this.cx;
    const v8 = this.squash * this.r;
    this.y = Math.trunc(Math.sin(this.angle * UFO_PI / 1800.0) * v8) + this.cy;
  }

  // sub_43A943 per-state step.
  _step(game) {
    switch (this.state) {
      case UFO_STATE.G: case UFO_STATE.H:
        --this.timer;
        if (this.r <= this.dr) this.r = 0; else this.r -= this.dr;
        this._orbit();
        if (this.x === this.cx && this.y === this.cy) this.timer = 0;
        break;
      case UFO_STATE.I:
        if (this.off96 >= 0) { this.off96 = 0; this.timer = 0; }
        else this.off96 += 11;
        break;
      case UFO_STATE.J: case UFO_STATE.K: case UFO_STATE.L:
        --this.timer;
        if (this.carrySven) {
          if (this.off112 + this.y + this.svenSeq.frameH(game) <= 0) { this.state = UFO_STATE.M; this.timer = 0; }
          else this.off112 -= 3;
          this.off104 -= 3;
        } else if (this.off104 + this.y + this.sheepSeq.frameH(game) <= 0) {
          this.state = UFO_STATE.M; this.timer = 0;
        } else this.off104 -= 3;
        break;
      case UFO_STATE.N:
        if (this.off96 <= -this.y - (this.off88 + UFO_BEAM_H)) this.timer = 0;
        else this.off96 -= 7;
        break;
      case UFO_STATE.O:
        this.off112 += this.fallVel;
        if (this.off112 < 0) { if (!(++this.fallVel % 3)) ++this.fallVel; }
        else { this.off112 = 0; this.timer = 0; this.fallVel = 0; }
        break;
      case UFO_STATE.P: --this.timer; break;
      case UFO_STATE.Q:
        this._orbit();
        if (this.off76 + this.x < -UFO_SHADOW_W) this.timer = 0;
        break;
      case UFO_STATE.R: --this.timer; break;
    }
    this.depth = this.y + 2;                             // vtable+28(y + 2)
  }

  // sub_43AE4A.
  _advance() {
    const S = UFO_STATE;
    switch (this.state) {
      case 0: this.state = S.F; break;
      case S.F: this.state = S.G; break;
      case S.G: this.state = S.H; break;
      case S.H: if (this.x === this.cx && this.y === this.cy) this.state = S.I; break;
      case S.I: this.state = S.J; break;
      case S.J: this.state = S.K; break;
      case S.K: this.state = S.L; break;
      case S.L: this.state = S.K; break;
      case S.M: this.state = S.N; break;
      case S.N: this.state = this.carrySven ? S.O : S.Q; break;
      case S.O: this.state = S.P; break;
      case S.P: this.state = S.Q; break;
      case S.Q: this.state = S.R; break;
      case S.R: this.state = S.F; break;
    }
    return true;
  }

  // sub_43B01D state entry.
  _enter(game) {
    const S = UFO_STATE, au = this._audio;
    this.timer = -1;
    switch (this.state) {
      case S.G:
        this.x = 640 - this.off76 + 10; this.y = 100; this.timer = 20;
        break;
      case S.H: this.timer = 20; break;
      case S.I:
        this.off92 = 0;
        this.off96 = -this.y - (this.off88 + UFO_BEAM_H);  // beam bottom at screen top
        if (au) au.play('beam');                           // aBeam_0
        break;
      case S.J:
        if (UFO_SHEEP_FLY[this.dir]) this.sheepSeq.setRecord(game, UFO_SHEEP_FLY[this.dir]);
        this.off100 = 0; this.off104 = 0; this.timer = 1;
        if (au) { au.stop('beam'); au.play('beamLoop', true); }
        break;
      case S.K: this.timer = 1; break;
      case S.L: this.timer = 1; break;
      case S.N: if (au) au.stop('beamLoop'); break;
      case S.O: {
        if (this.carryDir) { if (this.carryDir === 1) this.carryDir = 2; }
        else this.carryDir = 3;
        const rec = UFO_ALIEN_FALL[this.carryDir];
        if (rec) this.svenSeq.setRecord(game, rec);
        this.svenSeq.paused = false;
        this.svenSeq.setRange(0, 4, 6);
        this.svenSeq.setSpeed(0.3);
        this.fallVel = 1;
        let v7 = this.off112;
        for (;;) {
          v7 += this.fallVel;
          if (v7 >= 0) break;
          if (!(++this.fallVel % 3)) ++this.fallVel;
        }
        this.off112 -= v7;
        this.fallVel = 1;
        break;
      }
      case S.P: this.timer = 1; break;
      case S.Q: this._aim(-600, 100); break;
      case S.R:
        // --dword_49BA28 (remaining sheep), also on the no-target path.
        game.sheepRemainingDec();
        this.timer = 1;
        break;
    }
  }

  // Sheep vtable+92 (sub_42FFC8): 73 → action 18 (frozen, catch refused),
  // 74 → action 19 (hidden; removed 15 ticks later, cell kind 6 = addHole).
  _sheepEvent(code) {
    const t = this.target;
    if (t) t.ufoEvent(code);
  }

  // sub_43B31C: carry Sven.
  _carrySven(game, dir) {
    this.carryDir = dir;
    this.carrySven = true;
    if (UFO_SVEN_FLY[dir]) this.svenSeq.setRecord(game, UFO_SVEN_FLY[dir]);
    this.off108 = 0; this.off112 = 0;
  }

  // sub_430181: target still on its cell, visible, state not 10/11/12, not
  // frozen (flags128 & 2) — sheep.ufoTargetable(col, row).
  _valid(sh, col, row) {
    if (!sh) return false;
    return !!sh.ufoTargetable(col, row);
  }
  // CSheep on original cell (r, c) (1-based grid; r = 0 / c = 0 are border).
  _sheepAt(game, r, c) {
    const row = r - 1, col = c - 1;
    if (row < 0 || col < 0) return null;
    // Candidate iff (byte2 & 0xF0) != 0 (IDA:10126, 10155): the present bit
    // of a non-demon sheep (demon code 8 -> 0x08 is excluded); the "CSheep"
    // compare drops the mermaid. game.sheepAt models exactly that bit.
    return game.sheepAt(col, row);
  }
  // sub_416D7E: 25 random samples (rand()%Rows, rand()%Cols — 0-based on
  // the 1-based grid; Rows = 13 incl. the empty appended row, so 0-based
  // rows 0..11 and cols 0..14 are reachable, IDA:10123-10124), then a
  // forward wrap-around scan from the last sample.
  _pickTarget(game) {
    const R = game.mapInfo.rows, C = game.mapInfo.cols;
    const rnd = n => Math.floor(Math.random() * 32768) % n;
    let r = 0, c = 0;
    for (let i = 0; i < 25; ++i) {
      r = rnd(R); c = rnd(C);
      const sh = this._sheepAt(game, r, c);
      if (sh && this._valid(sh, c - 1, r - 1)) return sh;
    }
    const r0 = r, c0 = c;
    for (;;) {
      if (++c === C) { c = 0; if (++r === R) r = 0; }
      if (r === r0 && c === c0) return null;
      const sh = this._sheepAt(game, r, c);
      if (sh && this._valid(sh, c - 1, r - 1)) return sh;
    }
  }
  _aimAtTarget(game) {
    this.tCol = this.target.col; this.tRow = this.target.row;   // dword_493E14 / 493E10
    const p = cellToScreen(this.tCol, this.tRow);
    return p;
  }
  _retarget(game) {
    this.target = this._pickTarget(game);
    if (this.target) { const p = this._aimAtTarget(game); this._aim(p.x, p.y); }
    else { this.state = UFO_STATE.N; this.timer = 0; }
  }

  // sub_424029: scene per-tick driver. `dt` ignored (one call = one tick).
  update(dt, game) {
    const S = UFO_STATE;
    this._game = game;
    this._audio = game.audio || null;
    if (this.countdown > 0) --this.countdown;
    if (!this.countdown) {
      this.countdown = UFO_IDLE_COUNTDOWN;
      this.target = this._pickTarget(game);
      if (this.target) {
        const p = this._aimAtTarget(game);
        this.reset();                                   // sub_43A0DD
        this._aim(p.x, p.y);
      } else { this.state = S.N; this.timer = 0; }
    }
    // sub_43A8FE
    this._step(game);
    if (!this.timer && this._advance()) {
      this._enter(game);
      switch (this.state) {                             // hooks, IDA:16354-16429
        case S.H:
          if (!this._valid(this.target, this.tCol, this.tRow)) this._retarget(game);
          break;
        case S.I:
          if (this._valid(this.target, this.tCol, this.tRow)) {
            // sheep vtable+92(73) → sheep action 18 (frozen, uncatchable)
            this._sheepEvent(73);
            this.dir = this.target.dir;
          } else this._retarget(game);
          break;
        case S.J:
          // sheep vtable+92(74) → action 19 (hidden; 15 ticks later removed, cell type 6)
          this._sheepEvent(74);
          break;
        case S.L: {
          // sub_438BF1(Sven, row, col): Sven on the target cell AND state 28
          // → Sven action 47; carry him with his facing (Sven +56).
          const sv = game.sven;
          if (sv.ufoAbduct(this.tCol, this.tRow)) {
            this._carrySven(game, sv.facing);
            game.addScore(-10);                         // sub_42A2CB(-10) IDA:16406
          }
          break;
        }
        case S.P:
          game.sven.ufoReturn(80);                      // sub_438A80
          break;
        case S.Q:
          // Sven on the grid → the target cell's type 6 back to 1 (IDA:16413-16424).
          if (game.sven && game.sven.onGrid !== false) this.clearHole(this.tCol, this.tRow);
          break;
        case S.R:
          this.countdown = UFO_IDLE_COUNTDOWN;
          break;
      }
    }
    // Draw point of sub_43A258: carried sprites advance once per drawn tick.
    if (this.state >= S.J && this.state <= S.L) {
      if (this.carrySven) this._flyTick(this.svenSeq);
      this._flyTick(this.sheepSeq);
    } else if (this.state === S.O || this.state === S.P) {
      this.svenSeq.tickDraw();
    }
  }
  // Frames 0-14 once, then 15..20 looped at 0.15 (0x3E19999A).
  _flyTick(seq) {
    seq.tickDraw();
    if (seq.frame === 14) { seq.paused = false; seq.setRange(0, 15, 21); seq.setSpeed(0.15); }
  }

  // Legacy name: true while sub_43A258 draws something.
  isOnField() {
    const s = this.state, S = UFO_STATE;
    return s === S.I || s === S.N || (s >= S.J && s <= S.L) || s === S.O || s === S.P;
  }
  depthY() { return this.depth; }
  // vtable+20 = 0x401860 returns this[4] (x): the z-tie key of CompareFunction.
  get _depthX() { return this.x; }

  // sub_43A258 — depth-sorted entity draw (depth = y + 2).
  draw(g) {
    const game = this._game;
    const S = UFO_STATE, s = this.state;
    if (!game) return;
    if (s >= S.J && s <= S.L) {
      if (this.carrySven) this.svenSeq.draw(g, game, this.x + this.off108, this.y + this.off112);
      this.sheepSeq.draw(g, game, this.x + this.off100, this.y + this.off104);
      this._drawBeam(g);
    } else if (s === S.I || s === S.N) {
      this._drawBeam(g);
    } else if (s === S.O || s === S.P) {
      this.svenSeq.draw(g, game, this.x + this.off108, this.y + this.off112);
    }
  }
  // sub_40FE25 → sub_41BD7E case 16, clipped to the surface. The 565 blend
  // is done per pixel here (core.js rgb565Apply's 565→888 expansion, local:
  // the per-pixel n does not fit its per-channel callbacks).
  _drawBeam(g) {
    if (!UFO_BEAM || !UFO_BEAM.raw) return;
    const v = UFO_BEAM.raw;
    const bx = this.x + this.off84 + this.off92, by = this.y + this.off88 + this.off96;
    const x0 = Math.max(bx, 0), y0 = Math.max(by, 0);
    const x1 = Math.min(bx + UFO_BEAM_W, g.canvas.width), y1 = Math.min(by + UFO_BEAM_H, g.canvas.height);
    if (x0 >= x1 || y0 >= y1) return;
    const w = x1 - x0, img = g.getImageData(x0, y0, w, y1 - y0), d = img.data;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const s = v[(y - by) * UFO_BEAM_W + (x - bx)];
        if (s <= 0xBF) continue;                      // source word 0
        const n = s >> 4, i = ((y - y0) * w + (x - x0)) * 4;
        const r5 = (d[i] >> 4) + n, g6 = (d[i + 1] >> 3) + 2 * n, b5 = (d[i + 2] >> 4) + n;
        d[i] = (r5 << 3) | (r5 >> 2); d[i + 1] = (g6 << 2) | (g6 >> 4); d[i + 2] = (b5 << 3) | (b5 >> 2);
      }
    }
    g.putImageData(img, x0, y0);
  }

  // sub_43A74A — ground shadow, drawn after the puddles and before the
  // entity pass (IDA:15605). States G H I J K L N O P Q.
  drawShadow(g, game) {
    const S = UFO_STATE, s = this.state;
    if (!(s >= S.G && s <= S.L) && !(s >= S.N && s <= S.Q)) return;
    const sh = this._shadowParts(game);
    if (!sh) return;
    const sx = this.x + this.off76, sy = this.y + this.off80;
    const o = sh.work, oc = sh.workCtx;
    oc.globalCompositeOperation = 'source-over';
    oc.clearRect(0, 0, UFO_SHADOW_W, UFO_SHADOW_H);
    // 1. Shadow overlaps the lake rect: fill the overlap with CloudsShaded's
    //    key 0x619DBF, blit CloudsShaded at the cloud scroll position.
    const il = Math.max(sx, UFO_LAKE.l), it = Math.max(sy, UFO_LAKE.t);
    const ir = Math.min(sx + UFO_SHADOW_W, UFO_LAKE.r), ib = Math.min(sy + UFO_SHADOW_H, UFO_LAKE.b);
    if (il < ir && it < ib) {
      oc.fillStyle = '#619DBF';
      oc.fillRect(il - sx, it - sy, ir - il, ib - it);
      const cp = game.cloudPos || { x: 190, y: 376 };
      oc.drawImage(sh.clouds, cp.x - sx, cp.y - sy);
    }
    // 2. Pre-darkened static scene, keyed by its bottom-right pixel.
    oc.drawImage(sh.composite, -sx, -sy);
    // 3. Silhouette blitted with black key: black = scene shows through,
    //    magenta keyed out at the final blit. Ufo67% has no other colours,
    //    so the `edge` canvas (non-black, non-magenta pixels) stays empty.
    oc.globalCompositeOperation = 'destination-in';
    oc.drawImage(sh.inside, 0, 0);
    oc.globalCompositeOperation = 'source-over';
    oc.drawImage(sh.edge, 0, 0);
    // 4. Onto the frame.
    g.drawImage(o, sx, sy);
  }
  // Loop-render's hook name (called after the puddles, before the entities).
  drawUnder(g, game) { this.drawShadow(g, game || this._game); }
  // Build (once per level) the sub_43B668 composite: GameBkgnd over its key
  // colour, the puddle records, darkened by sub_409A59 (16 bpp: 3*((p&0xE79C)>>2)),
  // key = bottom-right pixel; and the Ufo67% masks.
  _shadowParts(game) {
    if (this._shadow) return this._shadow;
    const bg = muRawImage('GameBackground.bmp'), clouds = muRawImage('CloudsShaded.bmp'), sil = muRawImage('Ufo67%.bmp');
    if (!bg || !clouds || !sil) return null;
    const comp = document.createElement('canvas'); comp.width = 640; comp.height = 480;
    const cc = comp.getContext('2d');
    cc.drawImage(bg, 0, 0);
    // The puddle records in ascending order (sub_43B668 IDA:27223 i = 0..n-1;
    // only the scene draw IDA:15599 runs 9..0).
    for (const p of game.puddleRoll || []) if (p.sheet) p.sheet.drawFrame(cc, 0, p.x, p.y, false);
    const id = cc.getImageData(0, 0, 640, 480), d = id.data;
    // 16-bpp surface: sub_40A780 `3 * ((p & 0xE79C) >> 2)` = 3*(c>>2) on the
    // 5/6/5-bit channels (core.js rgb565Shadow, shared with the wash).
    rgb565Shadow(d);
    for (let i = 3; i < d.length; i += 4) d[i] = 255;
    const k = (639 + 479 * 640) * 4, kr = d[k], kg = d[k + 1], kb = d[k + 2];
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] === kr && d[i + 1] === kg && d[i + 2] === kb) d[i + 3] = 0;
    }
    cc.putImageData(id, 0, 0);
    const mk = () => { const c = document.createElement('canvas'); c.width = UFO_SHADOW_W; c.height = UFO_SHADOW_H; return c; };
    const inside = mk(), edge = mk();
    const sc = mk().getContext('2d'); sc.drawImage(sil, 0, 0);
    const sd = sc.getImageData(0, 0, UFO_SHADOW_W, UFO_SHADOW_H).data;
    const ic = inside.getContext('2d'), ec = edge.getContext('2d');
    const ii = ic.createImageData(UFO_SHADOW_W, UFO_SHADOW_H), ei = ec.createImageData(UFO_SHADOW_W, UFO_SHADOW_H);
    for (let i = 0; i < sd.length; i += 4) {
      const r = sd[i], gg = sd[i + 1], b = sd[i + 2];
      if (r === 0 && gg === 0 && b === 0) { ii.data[i + 3] = 255; }
      else if (!(r === 255 && gg === 0 && b === 255)) {
        ei.data[i] = r; ei.data[i + 1] = gg; ei.data[i + 2] = b; ei.data[i + 3] = 255;
      }
    }
    ic.putImageData(ii, 0, 0); ec.putImageData(ei, 0, 0);
    const work = mk();
    this._shadow = { composite: comp, clouds, inside, edge, work, workCtx: work.getContext('2d') };
    return this._shadow;
  }
}

// Preload the carried-sprite sheets as soon as a UFO level is built.
GAME_LEVEL_HOOKS.push(function () {
  if (!this.ufo) return;
  for (const t of [UFO_SHEEP_FLY, UFO_SVEN_FLY, UFO_ALIEN_FALL])
    for (const r of t) if (r) muSheet(this, r.name);
});
