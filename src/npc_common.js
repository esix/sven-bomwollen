//=== NPC common helpers =====================================================
// Shared by dog.js, shepherd.js, lamb.js, game_npc.js. Loaded before them.
// Owner: dog-shepherd-lamb (see audit/OWNERSHIP.md).
//
// Grid conventions (original): row = this[12] (+48), col = this[13] (+52),
// dir = this[14] (+56); dirs 0 col+1, 1 row-1, 2 col-1, 3 row+1 (sub_415399)
// = JS DIR.NE/NW/SW/SE. Original map indices are 1-based; JS is 0-based.

// dword_491608 (read from Sven.exe): [d]=opposite, [d+4]=d-1, [d+8]=d+1.
const NPC_DIR_TABLE = [2, 3, 0, 1, 3, 0, 1, 2, 1, 2, 3, 0];
const npcOpp  = d => NPC_DIR_TABLE[d];
const npcPrev = d => NPC_DIR_TABLE[d + 4];
const npcNext = d => NPC_DIR_TABLE[d + 8];

// Entity bits in cell bytes 0 (leaving) / 1 (incoming) / 2 (present):
// sub_429D24 / sub_429C3C / sub_429E83 by object type this[10]: 5 Sven 0x01,
// 7 shepherd 0x02, 6 dog 0x04, 8 → 0x08, 1-4 sheep 0x10 (byte2 uses 0x10..0x80
// per sheep class; one JS bit). The mermaid is type 4 (sub_42A9F7(3, 4,
// aCmermaid) IDA:10935), i.e. a sheep bit.
// Code 8 is a demon sheep: sub_42FD34(8) (IDA:19964) re-codes the sheep's
// cell bits; codes 1..4 (dir+1) are restored on revert (`Sheep.cellBit`).
const CELL_SVEN = 0x01, CELL_SHEP = 0x02, CELL_DOG = 0x04, CELL_TYPE8 = 0x08, CELL_SHEEP = 0x10;

// Terrain type (byte3 low nibble), parser sub_413D74 (IDA:8860):
// ' ' '_' '.' 'a' → 1 land, '#' → 2, 'c' → 3, '&' → 4, 'p' → 5. Live mushroom
// cells are type 7 (sub_414AA1 / spawner); a UFO abduction cell is type 6
// (sheep IDA:20249, Sven IDA:24313) until the UFO 'Q' hook. Out of grid → null.
function npcTerrainType(game, col, row) {
  const map = game.mapInfo;
  if (col < 0 || col >= map.cols || row < 0 || row >= map.rows) return null;
  const t = map.terrainKind(col, row);
  if (t !== 1) return t;
  if (game.ufo && game.ufo.isHole(col, row)) return 6;
  if (game.mushroomAt(col, row)) return 7;
  return 1;
}
// `(t & 0xF) == 7 || == 1` — the land test used by every NPC cell check.
function npcIsLand(game, col, row) {
  const t = npcTerrainType(game, col, row);
  return t === 1 || t === 7;
}
// Same-region rule of every NPC candidate test (dog IDA:1419 random,
// 1572 chase, 1709 flee; shepherd IDA:22733 wander, 22874 chase): allowed iff
// cur.region == 0 || cur.region != next.region (region '_'=1 '.'=2 'a'=3).
function npcRegionOk(game, fc, fr, tc, tr) {
  return !game.mapInfo.isSameSpecialStep(fc, fr, tc, tr);
}

// Cell bytes {b0 leaving, b1 incoming, b2 present} built from live entities;
// each one's `occupancyAt(col,row)` → {present, incoming, leaving}.
// `exclude` is skipped (the asking entity itself).
function npcCellBits(game, col, row, exclude) {
  const out = { b0: 0, b1: 0, b2: 0 };
  const add = (e, bit) => {
    if (!e || e === exclude) return;
    const o = e.occupancyAt(col, row);
    if (o.present)  out.b2 |= bit;
    if (o.incoming) out.b1 |= bit;
    if (o.leaving)  out.b0 |= bit;
  };
  if (game.sven && game.sven.onGrid !== false) add(game.sven, CELL_SVEN);
  for (const s of game.sheeps || []) if (!s.caught && s.onGrid !== false) add(s, s.cellBit);
  for (const d of game.dogs || []) add(d, CELL_DOG);
  for (const s of game.shepherds || []) add(s, CELL_SHEP);
  if (game.mermaid) add(game.mermaid, CELL_SHEEP);   // type 4 (spawn incoming, emerge present)
  return out;
}

// Sven fields read by the NPCs (Sven object = dword_49AF30 / dword_49BA50):
//   +196 saint deadline  → game.saintActive (mushrooms-hazards-saint)
//   +188 mode (1 normal, 2/3/5 mushrooms, 4 alien) → game.svenMode
//   +104 state number    → sven.state (sven-player)
//   +44  on-grid byte    → sven.onGrid (default true)
function npcSaintActive(game) { return !!game.saintActive; }
function npcSvenMode(game) { return game.svenMode; }
function npcSvenState(game) { return game.sven ? game.sven.state : -1; }
function npcSvenOnGrid(game) { return game.sven.onGrid !== false; }

// Difficulty struct dword_49AFBC = map+8328, filled once per enter by
// sub_4175DC (IDA:10200-10282). Single source: game.difficulty
// (game_level.js computeDifficulty). The NPC names are offsets from +8328.
function npcGameDiff(game) {
  const D = game.difficulty;
  return {
    d4:  D.p8332,          // +8332 dog laydown timer
    d8:  D.p8336,          // +8336 dog approach distance
    d12: D.p8340,          // +8340 dogshag symbol stage
    d16: D.p8344,          // +8344 dogshag cycles until the dog runs
    d20: D.p8348,          // +8348 mushroom-sleep timer
    d28: D.p8356,          // +8356 chase steps
    d32: D.p8360,          // +8360 chase extension
    d36: D.p8364,          // +8364 min chase steps before extending
    d44: D.p8372,          // +8372 run-after-howl steps
    d48: D.p8376,          // +8376 post-chase laydown ticks
    d52: D.p8380,          // +8380 shepherd wander budget
    dogshag: D.wolfDefeat, // +8403 (byte +75)
  };
}

// rand() % n, as in the original.
const npcRand = n => Math.floor(Math.random() * 32768) % n;

// Audio: DogBark (dog+108) / ShepherdYell (shep+156) are owned sound objects:
// +28(0,1) = looping play, +28(0,0) = one-shot (sound wrapper sub_43D206:
// a3==1 → Play with DSBPLAY_LOOPING), +32 = stop. AudioBank.play(name, loop)
// / stop(name) (core-map-audio) implement exactly that.
function npcSfxPlay(audio, key, loop) { audio.play(key, !!loop); }
function npcSfxStop(audio, key) { audio.stop(key); }

//--- Sprite animator: port of the 0x38-byte CImageSeq player ---------------
// sub_401950 ctor, sub_401B62 set sheet, sub_401EBD play(loops,from,to),
// sub_401FB0 length, sub_401C8E advance (once per drawn tick), sub_40709A
// table-entry set (sheet reset only when it changes; flip + offset always).
class NpcAnim {
  constructor() {
    this.name = null; this.sheet = null; this.count = 0;
    this.start = 0; this.end = 0; this.loops = 0;
    this.frame = -1; this.frameF = -1;
    this.speed = 1; this.done = true;
    this.flip = false; this.dx = 0; this.dy = 0;
    this.visible = false;                              // sub_401950: +37 = 0 (IDA:334)
  }
  // sub_40709A(entry): entry = {name, sheet, frames, dx, dy, flip, speed}.
  // The player resets only when the sprite changes (compared by name, i.e.
  // the sprite id); frame count falls back to Library.ini when not loaded.
  setEntry(e) {
    if (this.name !== e.name) {
      this.name = e.name;                              // sub_401B62
      this.sheet = e.sheet || null;
      this.count = e.sheet ? e.sheet.frames : e.frames;
      this.start = 0; this.end = this.count; this.loops = 0;
      this.frame = 0; this.frameF = 0; this.done = false;
      this.speed = Math.fround(e.speed);               // vtable+20
      this.visible = true;                             // sub_401B62: +37 = 1
    } else if (!this.sheet && e.sheet) {
      this.sheet = e.sheet;
    }
    this.flip = !!e.flip;                              // +48 = 0x10 → mirrored
    this.dx = e.dx; this.dy = e.dy;                    // sub_401D89 mode 2
  }
  setSpeed(s) { this.speed = Math.fround(s); }         // vtable+20 (sub_401FF0)
  // sub_401EBD(a2 loops, a3 from, a4 to).
  play(loops, from, to) {
    if (from >= 0) this.start = from >= this.count ? 0 : from;
    if (to) { if (to > 0) this.end = to >= this.count ? this.count : to; }
    else this.end = this.count;
    if (loops >= 0) this.loops = loops;
    this.frame = this.start;
    this.frameF = Math.fround(this.frame);
    return this.frame;
  }
  range() {                                            // sub_401F60
    return this.end <= this.start ? this.end + this.count - this.start : this.end - this.start;
  }
  length() {                                           // sub_401FB0
    return Math.trunc(this.range() * this.loops / this.speed);
  }
  advance() {                                          // sub_401C8E
    if (this.done) return this.frame;
    const v2 = this.frameF + this.speed;
    let v4 = Math.trunc(v2);
    const frac = Math.fround(Math.fround(v2) - v4);
    const r = this.range();
    let wrapped = false;
    if (this.end <= this.start) {
      if (v4 >= this.count) { wrapped = true; do v4 -= r; while (v4 >= this.end + this.count); }
    } else if (v4 >= this.end) {
      wrapped = true; do v4 -= r; while (v4 >= this.end);
    }
    if (wrapped && --this.loops === 0) this.done = true;
    this.frame = v4;
    this.frameF = Math.fround(v4 + frac);
    return v4;
  }
  // Draw at entity pixel (x,y): mode 2 anchor = (x+dx, y+dy-frameH).
  draw(g, x, y, frame) {
    const s = this.sheet;
    if (!s) return;
    s.drawFrame(g, frame, x + this.dx, y + this.dy - s.frameH, this.flip);
  }
}

// Sprite tables (records read from Sven.exe, core.js SPRITE_OFFSETS):
// dog off_4910F8.. (loaded by sub_40248F), shepherd off_4954C0/off_495520/off_495580.
// Table names: DogLaydown DogWalk DogRun DogShag AlienDogShag DogSleep DogHowl
// DogSymbols GuyStand GuyWalk GuyWalk2.
// Frame counts from Library.ini (used when a sheet is not loaded yet).
const NPC_SPRITE_FRAMES = {
  Doglaydown01: 1, Doglaydown02: 1, Dogwalk01: 16, Dogwalk02: 16, Dogrun01: 7, Dogrun02: 7,
  Dogshag01: 5, Dogshag02: 5, Alien_dogshag01: 5, Alien_dogshag02: 5, Dogsleep01: 4, Dogsleep02: 4,
  Doghowl01: 8, Doghowl02: 8, Symbols: 20, Guy_StandBack: 1, Guy_StandFront: 1,
  Guy_WalkBack: 16, Guy_WalkFront: 16, Guy_WalkBack2: 11, Guy_WalkFront2: 19, Lamb01: 15, Lamb02: 15,
};
function npcEntry(assets, table, dir) {
  const r = spriteRecord(table, dir);
  const name = r.sprite;
  return { name, sheet: (assets && assets[name]) || null, frames: NPC_SPRITE_FRAMES[name],
           dx: r.dx, dy: r.dy, flip: r.flip, speed: r.speed };
}

//--- Grid walker: port of the CMapObject step (sub_419ECE / sub_41A0BA) ----
// Mixed into Dog and Shepherd. Fields: col,row,dir, prevCol/prevRow
// (this+60/64), stepTick (this[21]), from/to cells and pixels.
const NpcWalker = {
  // sub_41A40A: place on the current cell; prev cell = the one behind.
  _place() {
    this.stepTick = 0;
    const b = DIR_DELTA[npcOpp(this.dir)];
    this.prevCol = this.col + b.dc; this.prevRow = this.row + b.dr;
    this.fromCol = this.col; this.fromRow = this.row;
    this.toCol = this.col; this.toRow = this.row;
    this.inCol = this.col; this.inRow = this.row;      // incoming bit set by sub_41A2F8
    this.leaving = false;
    const p = cellToScreen(this.col, this.row);
    this.fromPx = p; this.toPx = p; this.px = { x: p.x, y: p.y };
  },
  // sub_419ECE: start a step in this.dir.
  _startStep() {
    this.fromCol = this.col; this.fromRow = this.row;  // this[17..18]
    const d = DIR_DELTA[this.dir];
    this.toCol = this.col + d.dc; this.toRow = this.row + d.dr;  // this[19..20]
    this.leaving = true;                               // sub_429E83 on the current cell
    this.inCol = this.toCol; this.inRow = this.toRow;  // sub_429C3C(type,1) on the target
    this.fromPx = cellToScreen(this.fromCol, this.fromRow);
    this.toPx = cellToScreen(this.toCol, this.toRow);
  },
  // sub_41A0BA: one tick of the step. len = vtable+72.
  _advanceStep(game) {
    const len = this._stepLen();
    this.stepTick++;
    const t = this.stepTick;
    this.px = {
      x: Math.trunc((t * this.toPx.x + (len - t) * this.fromPx.x) / len),
      y: Math.trunc(((len - t) * this.fromPx.y + t * this.toPx.y) / len),
    };
    if (t === Math.trunc(len / 2)) {
      this.prevCol = this.fromCol; this.prevRow = this.fromRow;   // this[15..16]
      this.col = this.toCol; this.row = this.toRow;               // vtable+56/+52
      this._onCellEnter(game, false);                             // vtable+76(cell, 0)
    } else if (t >= len) {
      this.leaving = false;                                       // sub_429B5A(type, 0)
      this.stepTick = 0;
      this._onCellEnter(game, true);                              // vtable+76(cell, 1)
    }
  },
  // Cell bytes this NPC contributes (see npcCellBits).
  occupancyAt(col, row) {
    return {
      present:  this.onGrid !== false && this.col === col && this.row === row,
      incoming: this.onGrid !== false && this.inCol === col && this.inRow === row,
      // byte0 on the from-cell for the whole step (sub_429E83 .. sub_429B5A).
      leaving:  this.onGrid !== false && this.leaving && this.fromCol === col && this.fromRow === row,
    };
  },
  depthY() { return this.px ? this.px.y : cellToScreen(this.col, this.row).y; },
  // Game.entityDepth/entityDepthX overrides (loop area): the pixel anchor.
  get _depthY() { return this.depthY(); },
  get _depthX() { return this.px ? this.px.x : cellToScreen(this.col, this.row).x; },
};
function npcMixWalker(cls) {
  for (const k of Object.getOwnPropertyNames(NpcWalker)) {
    Object.defineProperty(cls.prototype, k, Object.getOwnPropertyDescriptor(NpcWalker, k));
  }
}

// Candidate test shared by dog/shepherd moves: neighbour in `dir` exists,
// is land, and is either empty (b2==0 && b1==0) or Sven's cell accepted by
// `svenOk(bits)`; plus the same-region rule. Returns {col,row,bits} or null.
function npcCandidate(game, self, dir, svenOk) {
  const d = DIR_DELTA[dir];
  const tc = self.col + d.dc, tr = self.row + d.dr;
  if (!npcIsLand(game, tc, tr)) return null;
  const bits = npcCellBits(game, tc, tr, self);
  const empty = !bits.b2 && !bits.b1;
  const hasSven = (bits.b2 & CELL_SVEN) || (bits.b1 & CELL_SVEN);
  if (!empty && !(hasSven && svenOk(bits))) return null;
  if (!npcRegionOk(game, self.col, self.row, tc, tr)) return null;
  return { col: tc, row: tr, bits };
}
// The asking NPC's own cell holds Sven present (b2&1) or leaving (b0&1).
function npcOwnCellHasSven(game, self) {
  if (!npcIsLand(game, self.col, self.row)) return false;
  const bits = npcCellBits(game, self.col, self.row, self);
  return !!((bits.b2 & CELL_SVEN) || (bits.b0 & CELL_SVEN));
}
// sub_404381/sub_431636 direction order toward Sven: [major toward,
// minor toward, minor away, major away]; ties → row axis.
function npcTowardDirs(self, sven) {
  const dc = sven.col - self.col, dr = sven.row - self.row;
  const major = Math.abs(dc) <= Math.abs(dr) ? (dr <= 0 ? 1 : 3) : (dc <= 0 ? 2 : 0);
  const minor = Math.abs(dc) <= Math.abs(dr) ? (dc <= 0 ? 2 : 0) : (dr <= 0 ? 1 : 3);
  return [major, minor, npcOpp(minor), npcOpp(major)];
}
// Face Sven, major axis, ties → row axis (dog '6' IDA:1829-1841, shepherd 'B' IDA:22950-22956).
function npcFaceSven(self, sven) {
  const dc = sven.col - self.col, dr = sven.row - self.row;
  return Math.abs(dc) <= Math.abs(dr) ? (dr <= 0 ? 1 : 3) : (dc <= 0 ? 2 : 0);
}
