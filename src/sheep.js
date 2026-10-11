//=== Sheep entity — port of CSheep ============================================
// Ctor sub_42A8B6, vtable off_47409C, init sub_42ABDF, reset sub_42AE1B.
// Per-tick sub_42AE87 (one update() call = one 20 Hz game tick), transition
// resolver sub_42B208, state entry sub_42C2C0, mood sub_42D08E.
// Field names follow the original layout (this[N] = dword index):
//   [12]/[13] row/col, [14] dir, [15]/[16] previous cell, [17]/[18] step src,
//   [19]/[20] step dst, [21] demon step tick, [22..25] step src/dst screen,
//   [29] stamina, [30] mood level, [31] love level, +128 &1 zap / &2
//   stoned (the bit sub_42CCBB and Sven case 0x22 test), [33] sub counter, [34] shag index, [35] shag SFX index,
//   [36] state, [38] requested state, [39..43]+[44] request queue,
//   [45] state timer, [46] love countdown, [47] demon count, [48] kicks,
//   +148 bit0 special sheep, [10] cell code: 1..4 = dir+1 (dword_49452C,
//   restored by sub_42FD34 on revert / attack), 8 = demon (`demonCell`).
// The original runs this logic inside the draw pass (sub_42AE87 draws and
// advances the anims); update() records what would be drawn this tick and
// draw() only blits that snapshot.

// States (sub_42C2C0 / sub_42B208 case labels).
const SHEEP_STATE = Object.freeze({
  INIT: 0, IDLE: 1, WALK: 2, CHEW: 3, CHEW_END: 4, ACCEPT: 5, SHAG: 6,
  POST_SHAG: 7, STONED: 8, KICKED: 9, SATISFIED: 10, EXPLODING: 11,
  REMOVED: 12, DEMON_TRANSFORM: 13, DEMON_RUN: 14, DEMON_ATTACK: 15,
  DEMON_ZAP: 16, DEMON_REVERT: 17, UFO_LOCK: 18, UFO_LIFT: 19, UFO_GONE: 20,
});

// MSVC rand(): 0..32767.
function sheepRand() { return Math.floor(Math.random() * 32768); }

// Sprite tables, 24-byte records {name, xoff, yoff, handle, flip, speed}
// read from Sven.exe .data, index = dir (NE, NW, SW, SE).
const SHEEP_TBL = {
  walk:     [['Sheep_walkaway', -29, 13, 0, 1.0], ['Sheep_walkaway', -43, 11, 1, 1.0],   // off_494808
             ['Sheep_walkup',   -44, 22, 0, 1.0], ['Sheep_walkup',   -28, 22, 1, 1.0]],
  chew:     [null, null,                                                                // unk_494868
             ['Sheep_chewing',  -28, 10, 0, 0.5], ['Sheep_chewing',  -29, 10, 1, 0.5]],
  kick:     [['Sven_kick02',    -66, 25, 0, 1.0], ['Sven_kick02',    -40, 25, 1, 1.0],   // off_4948C8
             ['Sven_kick01',    -36,  9, 0, 1.0], ['Sven_kick01',    -55,  9, 1, 1.0]],
  stoned:   [['Stoned02',       -54, 27, 0, 1.0], ['Stoned02',       -28, 25, 1, 1.0],   // off_494940
             ['Stoned01',       -28, 11, 0, 1.0], ['Stoned01',       -58, 11, 1, 1.0]],
  explode:   ['Sheep_exploding', -65, 18, 0, 1.0],                                      // off_494928
  demon:    [['Demon02',        -39, 14, 0, 1.0], ['Demon02',        -45, 10, 1, 1.0],   // off_494A10
             ['Demon01',        -43, 18, 0, 1.0], ['Demon01',        -47, 17, 1, 1.0]],
  demonRun: [['DemonRun02',     -39, 14, 0, 1.0], ['DemonRun02',     -45, 10, 1, 1.0],   // off_494A70
             ['DemonRun01',     -43, 18, 0, 1.0], ['DemonRun01',     -47, 17, 1, 1.0]],
  accept:   [['SheepAccept02',  -37, 14, 0, 1.0], ['SheepAccept02',  -29, 12, 1, 1.0],   // off_494C28
             ['SheepAccept01',  -28,  9, 0, 1.0], ['SheepAccept01',  -35,  9, 1, 1.0]],
  alien:    [['Alien_shag06',   -45, 12, 0, 0.8], ['Alien_shag06',   -44, 11, 1, 0.8],   // off_494DE8
             ['Alien_shag08',   -30,  9, 0, 0.8], ['Alien_shag08',   -63,  9, 1, 0.8]],
  sym:      [['Symbols',          4, -35, 0, 1.0], ['Symbols',       -28, -35, 0, 1.0],  // off_4947A8
             ['Symbols',        -26, -25, 0, 1.0], ['Symbols',         2, -25, 0, 1.0]],
  bzzzt:     ['Bzzzt',          -50, 10, 0, 1.0],                                       // off_494D90
};
// Sequenced frame tables {frame, ticks} (sub_41C480 anims).
const SHEEP_SEQ = {
  accept: [[0,4],[1,1],[2,4],[3,1],[4,1],[5,1],[6,1],[7,1],[8,1],[7,1],[6,1],[5,1],[4,1], // unk_494C88
           [5,1],[6,1],[7,1],[8,1],[7,1],[6,1],[5,1],[4,1],[5,1],[6,1],[7,1],[8,1],[7,1],
           [6,1],[5,1],[4,2],[9,1],[10,1],[0,4],[11,1]],
  demon:  [[0,4],[1,1],[2,1],[3,5],[4,4],[5,1],[6,1],[7,1],[8,2],[9,4],[10,1],[11,1],     // unk_494AD0
           [12,1],[13,2],[14,6],[15,1],[16,1],[17,1],[18,6],[19,4],[20,6],[21,1],[22,1]],
  attack: [[18,1],[19,2],[20,2],[21,3],[22,3],[21,1],[20,1],[19,1],[18,1]],               // unk_494BE0
  revert: [[18,3],[8,3],[7,3],[6,3],[5,3],[4,3],[3,3],[2,3],[1,2],[0,1],[0,1]],           // unk_494B88
  stoned: [[0,4],[1,1],[2,6],[3,1],[4,1],[5,3],[6,1],[7,1],[8,2],[9,2],[10,1],[11,1],     // unk_4949A0
           [12,3],[13,6]],
  bzzzt:  [[0,3],[1,2],[0,3],[1,2],[0,7],[1,5],[0,2],[1,1]],                               // unk_494DA8
};
// Shag composite table off_494540 (36-byte records): {name, class(dir),
// ?, xoff, yoff, flipped xoff, flipped yoff, speed 0.8, handle}.
const SHEEP_SHAG_TBL = [
  ['shag10', 3, -52,  9, -40, 10], ['shag02', 0, -50, 20, -36, 18], ['shag03', 1, -16, 19, -66, 22],
  ['shag04', 2, -40, 20, -59, 19], ['shag05', 2, -30, 10, -28, 10], ['shag06', 0, -45, 12, -44, 11],
  ['shag07', 0, -37, 13, -37, 11], ['shag08', 2, -30,  9, -63,  9], ['shag09', 3, -41, 10, -30, 10],
  ['shag11', 3, -45, 12, -28, 10], ['shag12', 0, -67, 23, -37, 11], ['shag13', 2, -30, -1, -63, -1],
  ['shag14', 1, -37, 13, -37, 11],
];
const SHEEP_SHAG_SPEED = 0.8;
// sub_42EA6B calls (IDA:21033-21143), in call order, per level.
const SHEEP_SHAG_LEVEL_CALLS = {
  1: ['02','08'], 2: ['02','03','08'], 3: ['02','03','05','08'], 4: ['02','03','06','05','08'],
  5: ['02','03','06','04','05','08'], 6: ['03','06','07','04','05','08'],
  7: ['02','06','07','04','05','09'], 8: ['03','06','12','04','08','09'],
  9: ['03','07','12','05','09','11'], 10: ['06','07','14','05','09','11'],
  11: ['02','12','14','08','09','13'], 12: ['03','06','14','04','11','13'],
  13: ['03','07','12','05','09','13'], 14: ['03','07','14','05','09','11'],
  15: ['02','06','14','04','11','13'], 16: ['03','06','12','05','08','09'],
  17: ['02','07','12','09','11','13'], 18: ['03','07','14','05','08','09'],
  19: ['02','06','12','08','09','11'], 20: ['03','12','14','05','11','13'],
};
// sub_42EA6B: class 0/1 → unk_49B688 (dir 0/1 pool), class 2/3 → unk_49B300.
const SHEEP_SHAG_POOLS = (() => {
  const north = {}, south = {};
  for (const [lvl, names] of Object.entries(SHEEP_SHAG_LEVEL_CALLS)) {
    north[lvl] = []; south[lvl] = [];
    for (const n of names) {
      const i = SHEEP_SHAG_TBL.findIndex((e, k) => k >= 1 && e[0] === 'shag' + n);  // i in 1..12
      (SHEEP_SHAG_TBL[i][1] > 1 ? south : north)[lvl].push(i);
    }
  }
  return { north, south };
})();
// SFX table dword_49471C (ShagSpecial, Shag01..11) → AUDIO_MAP keys; Mee1..3
// (dword_49477C) / Happy1..3 (dword_494794) are played by audio.js helpers.
const SHEEP_SHAG_SFX = ['shagSpecial', 'shag01', 'shag02', 'shag03', 'shag04', 'shag05',
                        'shag06', 'shag07', 'shag08', 'shag09', 'shag10', 'shag11'];
// dword_491608: [0..3] opposite dir, [4..7] / [8..11] side dirs.
const SHEEP_DIR_TBL = [2, 3, 0, 1, 3, 0, 1, 2, 1, 2, 3, 0];

//--- Anim objects ------------------------------------------------------------
// Plain anim: sub_401950, vtable 0x47357C.
class SheepAnim {
  constructor() {
    this.name = null; this.sheet = null; this.n = 0;
    this.start = 0; this.end = 0; this.loops = 0; this.frame = -1;
    this.frozen = true; this.visible = false;      // +36 / +37
    this.speed = 1; this.pos = -1;                 // +40 / +44 (floats)
    this.xo = 0; this.yo = 0; this.flip = false;   // +12 / +16 / +48&0x10
  }
  // sub_401B62
  setSprite(name, sheet) {
    this.name = name; this.sheet = sheet || null;
    this.n = sheet.frames;                         // *(handle+48) (IDA:419)
    this.start = 0; this.end = this.n; this.loops = 0;
    this.frame = this.start; this.pos = this.frame;
    this.frozen = false; this.visible = true;
  }
  setSpeed(s) { this.speed = Math.fround(s); }            // sub_401FF0
  // sub_401EBD (vt+24): end 0 = all frames, -1 keeps current values.
  setRange(loops, start, end) {
    if (start >= 0) this.start = start >= this.n ? 0 : start;
    if (end) { if (end > 0) this.end = end >= this.n ? this.n : end; }
    else this.end = this.n;
    if (loops >= 0) this.loops = loops;
    this.frame = this.start; this.pos = Math.fround(this.frame);
    return this.frame;
  }
  len() { return this.end <= this.start ? this.end + this.n - this.start : this.end - this.start; } // sub_401F60
  duration() { return Math.trunc(this.len() * this.loops / this.speed); }                          // sub_401FB0
  // sub_401C8E (vt+28): runs after each draw.
  advance() {
    if (this.frozen) return this.frame;
    const v2 = this.pos + this.speed;
    const v5 = Math.fround(v2);
    let v4 = Math.trunc(v2);
    const frac = Math.fround(v5 - v4);
    const len = this.len();
    let wrapped = false;
    if (this.end <= this.start) {
      if (v4 >= this.n) { wrapped = true; do v4 -= len; while (v4 >= this.end + this.n); }
    } else if (v4 >= this.end) {
      wrapped = true; do v4 -= len; while (v4 >= this.end);
    }
    if (wrapped && --this.loops === 0) this.frozen = true;
    this.frame = v4;
    this.pos = Math.fround(v4 + frac);
    return this.frame;
  }
}
// Sequenced anim: sub_41C480, vtable 0x473C14 (frame/ticks table, speed 1).
class SheepSeqAnim extends SheepAnim {
  setSeq(table) {               // the field writes before sub_40709A in sub_42C2C0
    this.seq = table; this.count = table.length; this.end = table.length;
    this.idx = 0; this.start = 0; this.tick = 0; this.frame = table[0][0];
  }
  setSpeed() { this.speed = 1; }                          // sub_41C780
  setRange(loops, start, end) {                           // sub_41C6B9
    if (start >= 0) this.start = start >= this.count ? 0 : start;
    if (end) { if (end > 0) this.end = end >= this.count ? this.count : end; }
    else this.end = this.count;
    if (loops >= 0) this.loops = loops;
    this.idx = this.start;
    this.frame = this.seq[this.idx][0];
    return this.frame;
  }
  len() {                                                 // sub_41C5D9
    let t = 0;
    if (this.start >= this.end) {
      for (let i = this.start; i < this.count; i++) t += this.seq[i][1];
      for (let j = 0; j < this.end; j++) t += this.seq[j][1];
    } else {
      for (let k = this.start; k < this.end; k++) t += this.seq[k][1];
    }
    return t;
  }
  duration() { return this.loops * this.len(); }          // sub_41C760
  advance() {                                             // sub_41C4ED
    if (this.frozen) return this.frame;
    if (++this.tick === this.seq[this.idx][1]) {
      ++this.idx;
      if (this.end <= this.start && this.idx === this.count) this.idx = 0;
      if (this.idx === this.end) {
        if (--this.loops) this.idx = this.start;
        else this.frozen = true;
      }
      this.tick = 0;
      // Past-the-end read when frozen at idx==count; the owning state always
      // ends on that tick so the value is never drawn. Keep the last frame.
      if (this.seq[this.idx]) this.frame = this.seq[this.idx][0];
    }
    return this.frame;
  }
}

class Sheep {
  // Original ctor sub_42A8B6(row, col, dir, cellCode); init(game) = vt+40
  // sub_42ABDF. Sheets come from game.assets by their Library.ini names.
  constructor(col, row, dir, special = false) {
    this.col = col; this.row = row; this.dir = dir;   // [13] / [12] / [14]
    this.special = special;                           // +148 bit0 (set by the level hook)
    // sub_419DE0 -> sub_41A2C8 -> sub_41A40A: [15]/[16] = sub_415399 neighbour
    // in dword_491608[dir] (the cell behind), [17]/[18] = [15]/[16]. An
    // off-range neighbour is -1 there; it never equals an in-bounds candidate
    // either way, so the bounds test is not modelled.
    const behind = DIR_DELTA[SHEEP_DIR_TBL[dir]];
    this.prevRow = row + behind.dr; this.prevCol = col + behind.dc;  // [15]/[16]
    this.srcRow = this.prevRow; this.srcCol = this.prevCol;          // [17]/[18]
    this.dstRow = row; this.dstCol = col;             // [19]/[20]
    this.stepTick = 0;                                // [21]
    this.stepping = false;                            // src+dst cells both held (sub_42FB11 .. sub_429B5A)
    // [22..25] = screen pos of [17]/[18] and of the own cell (sub_41A40A IDA:11548-11565).
    { const a = cellToScreen(this.srcCol, this.srcRow), b = cellToScreen(col, row);
      this.srcX = a.x; this.srcY = a.y; this.dstX = b.x; this.dstY = b.y; }
    this.x = 0; this.y = 0;                           // +16/+20 screen position
    this.stamina = 0;                                 // [29] +116
    this.moodLevel = -1;                              // [30] +120
    this.love = 0;                                    // [31] +124
    this.zap = false;                                 // +128 &1 (Bzzzt drawn)
    this.stoned = false;                              // +128 &2
    this.sub = 0;                                     // [33] +132
    this.shagIdx = -1;                                // [34] +136
    this.shagSfx = -1;                                // [35] +140
    this.loveT = -1;                                  // [46] +184
    this.demonCount = 0;                              // [47] +188
    this.kicks = 0;                                   // [48] +192
    this.demonCell = false;                           // [10]==8 (sub_42FD34(8))
    this.caught = false;                              // off the grid for good (state 12 / 20)
    this.game = null;
    this.anim = new SheepAnim();                      // this[8]
    this.seqAnim = new SheepSeqAnim();                // this[9]
    this.cur = this.anim;                             // this[6]
    this.sym = new SheepAnim();                       // this[26] +104
    this._draw = null;
    this._reset();
  }

  // sub_42AE1B
  _reset() {
    this.qlen = 0; this.queue = [0, 0, 0, 0, 0];
    this.state = 0; this.req = 0; this.timer = 1;
  }

  // vt+40 sub_42ABDF (IDA:19646). Called from the level hook (game_sheep.js).
  init(game) {
    this.game = game;
    const p = cellToScreen(this.col, this.row);
    this.x = p.x; this.y = p.y;
    this.cur = this.anim;
    this._applyTbl(this.anim, SHEEP_TBL.walk[this.dir]);
    const n = game.sheepCount;                       // dword_49BA24
    const lb = n >= 30 ? 2400 : Math.trunc((2400 * n + 600 * (30 - n)) / 30);
    this.stamina = sheepRand() % (3000 - lb) + lb;
    game.pool += this.stamina;                       // dword_49BA20 += this[29]
    this._applyTbl(this.sym, SHEEP_TBL.sym[this.dir]);
    this.mood(1);
    this._reset();
    return true;
  }

  //--- helpers ---------------------------------------------------------------
  _asset(name) { return (this.game && this.game.assets && this.game.assets[name]) || null; }
  // sub_40709A: switch sprite only if it changed, then flip + mode-2 offsets.
  _applyTbl(a, e) {
    if (!e) return;
    if (a.name !== e[0]) { a.setSprite(e[0], this._asset(e[0])); a.setSpeed(e[4]); }
    a.flip = !!e[3];
    this._offsets(a, e[1], e[2]);
  }
  // sub_401D89 mode 2: draw at (pos.x + x, pos.y + y - frameH).
  _offsets(a, x, y) { a.xo = x; a.yo = y - (a.sheet ? a.sheet.frameH : 0); }
  _sfx(key) { if (this.game && this.game.audio && key) this.game.audio.play(key); }
  // sub_438585(code, sheep): sheep → Sven notification (Sven-side port).
  _svenEv(code) {
    const s = this.game && this.game.sven;
    if (s) s.onSheepEvent(code, this);
  }
  // Sven fields read through dword_49BA10: +48 row, +52 col, +56 dir,
  // +104 state, +188 mode, +196 saint countdown.
  _sv() {
    const s = this.game.sven;
    return {
      row: s.row, col: s.col, dir: s.facing,
      state: s.state,                                // Sven +104
      mode: this.game.svenMode,                      // Sven +188
      saint: this.game.saintActive ? 1 : 0,          // Sven +196 > 0
    };
  }
  // Depth key = anchor (x, y) (base setPos sub_401800 sets z from y).
  get _depthY() { return this.y; }
  get _depthX() { return this.x; }
  // Face-Sven formula (IDA:19956-19962, 20211-20217, 21895-21901).
  _dirToSven() {
    const sv = this._sv();
    const dc = sv.col - this.col, dr = sv.row - this.row;
    if (Math.abs(dc) <= Math.abs(dr)) return dr <= 0 ? 1 : 3;
    return dc <= 0 ? 2 : 0;
  }
  // sub_415399 neighbour.
  _nb(dir, row = this.row, col = this.col) {
    const d = DIR_DELTA[dir];
    return { col: col + d.dc, row: row + d.dr };
  }
  _inBounds(c, r) {
    const m = this.game.mapInfo;
    return c >= 0 && r >= 0 && c < m.cols && r < m.rows;
  }
  // Cell kind 1 (land) or 7 (land holding an item); kind 6 (UFO hole) is not.
  _kindLand(c, r) { return npcIsLand(this.game, c, r); }
  // Cell byte3 bits 4-5 equal and non-zero → step refused (IDA:21998, 21957).
  _sameSpecial(fc, fr, tc, tr) { return this.game.mapInfo.isSameSpecialStep(fc, fr, tc, tr); }
  _bits(c, r) { return npcCellBits(this.game, c, r, this); }           // cell bytes 0..2
  _svenAt(c, r) {                                  // cell byte1&1 / byte2&1
    const b = this._bits(c, r);
    return !!((b.b1 | b.b2) & CELL_SVEN);
  }
  _cellEmpty(c, r) { return !this.game.sheepCellOccupied(c, r, this); }   // bytes 0..2 == 0
  _mushAt(c, r) { return this.game.mushroomAt(c, r); }
  // Cell bytes this sheep holds (bit = code this[10]: 1-4 → 0x10, 8 → 0x08):
  //   present  byte2: logical cell (vt+56 / vt+52 at the half-step, IDA:19977-19993);
  //   incoming byte1: dst this[19..20] from step start (sub_42FB11 sub_429C3C,
  //            IDA:22039) until the next step start; at rest dst == own cell
  //            (parser sub_429C3C(15,1), IDA:8646);
  //   leaving  byte0: src while stepping (sub_429E83 .. sub_429B5A).
  // Off the grid (caught: vt+48 sub_41A353) → none.
  occupancyAt(c, r) {
    const o = { present: false, incoming: false, leaving: false };
    if (this.caught) return o;
    o.present = this.col === c && this.row === r;
    o.incoming = this.dstCol === c && this.dstRow === r;
    o.leaving = this.stepping && this.srcCol === c && this.srcRow === r;
    return o;
  }
  // Cell bit of this[10]: demon code 8 (sub_42FD34(8)) → 0x08, else 0x10.
  get cellBit() { return this.demonCell ? CELL_TYPE8 : CELL_SHEEP; }

  //--- vtable entries used by other entities ---------------------------------
  // vt+88 sub_43006C: push a requested state (max 5, no consecutive dup).
  request(s) {
    if (this.qlen >= 5) return true;
    if (!this.qlen || this.queue[this.qlen - 1] !== s) this.queue[this.qlen++] = s;
    return true;
  }
  // vt+96 sub_42FEBA: Sven events.
  svenEvent(a2) {
    if (this.qlen >= 5) return true;
    let v4;
    switch (a2) {
      case 28: case 29: case 37: case 38:
        if (this.state === 6 || (this.state > 14 && this.state <= 17)) { v4 = 1; break; }
        return true;
      case 31: v4 = 5; break;
      case 32: v4 = 6; break;
      case 34: v4 = 9; break;
      default: return false;
    }
    if (!this.qlen || this.queue[this.qlen - 1] !== v4) this.queue[this.qlen++] = v4;
    return true;
  }
  // vt+92 sub_42FFC8: UFO events 73 → 18 (lock), 74 → 19 (lift).
  ufoEvent(a2) {
    if (this.qlen >= 5) return true;
    let v3;
    if (a2 === 73) v3 = 18;
    else if (a2 === 74) v3 = 19;
    else return false;
    if (!this.qlen || this.queue[this.qlen - 1] !== v3) this.queue[this.qlen++] = v3;
    return true;
  }
  // vt+80 sub_42FDC5: may Sven whistle at / shag / kick this sheep?
  canInteract() {
    switch (this.state) {
      case 1: case 3: case 4:
        if ((this.timer >>> 0) <= 1) return false;     // unsigned compare
        // falls through
      case 7:
        for (let i = 0; i < this.qlen; i++) if (this.queue[i] === 2 || this.queue[i] === 13) return false;
        return true;
      default:
        return false;
    }
  }
  // vt+84 sub_42CCBB(svenMode): true = shag (event 32), false = kick (34).
  canShag(mode) {
    if (mode === 3) {
      if (this.stoned) return false;
      if (this.moodLevel < 0) this.stamina = 0;
      return true;
    }
    return mode === 4
      || (this.moodLevel > 0 && !this.stoned)
      || this.kicks >= this.game.difficulty.p8396;   // dword_49AFBC+68 = 3L/20+1
  }
  // sub_430181: UFO target validity.
  ufoTargetable(col, row) {
    if (col !== this.col || row !== this.row) return false;
    if (!this.cur.visible) return false;
    if (this.state === 10 || this.state === 11 || this.state === 12) return false;
    return !this.stoned;
  }
  // Mushroom / combo stamina helpers (called for every CSheep by the scene).
  boost900() {                                       // sub_42EE43
    if (this.moodLevel > 0) {
      if (this.moodLevel >= 10) return false;
      this.stamina = this.stamina + 900 >= 3000 ? 3000 : this.stamina + 900;
    } else this.stamina = sheepRand() % 300 + 900;
    return true;
  }
  boost600() {                                       // sub_42EEB3
    if (this.moodLevel > 0) {
      if (this.moodLevel >= 10) return false;
      this.stamina = this.stamina + 600 >= 3000 ? 3000 : this.stamina + 600;
    } else this.stamina = 600;
    return true;
  }
  minus600() {                                       // sub_42EF15
    if (this.moodLevel <= 0) return false;
    if (this.stamina > 600) this.stamina -= 600;
    return true;
  }
  dampen() {                                         // sub_42EF4C
    if (this.moodLevel <= 0) return false;
    if (this.stamina > 600) this.stamina = sheepRand() % 300 + 600;
    return true;
  }
  calm() {                                           // sub_42EF8B
    if (this.moodLevel > 1) return false;
    this.stamina = sheepRand() % 300 + 900;
    return true;
  }

  //--- per tick: sub_42AE87 --------------------------------------------------
  update() {
    const g = this.game;
    if (!g) return;
    this._draw = null;
    if (!this.cur.visible) return;                   // sub_407058
    if (!this.stoned && this.state !== 6 && --this.stamina >= 0) g.pool--;   // IDA:19772
    if (this.loveT > 0) --this.loveT;
    if (!this.loveT) {
      if (++this.love < 7) this.loveT = 20;
      else { this.queue[0] = 11; if (!this.qlen) ++this.qlen; }
    }
    let ok = false;
    const prev = this.state;
    if (!this.stepTick) {
      if (this.timer) --this.timer;
      if (this.qlen) {
        let any = false, last = 0;
        for (let i = 0; i < this.qlen; ++i) {
          this.req = this.queue[i];
          if (this._transition()) { this.state = this.req; last = this.req; any = true; }
        }
        if (any) { this.req = last; this._enter(); }
        for (let j = 0; j < this.qlen; ++j) this.queue[j] = 0;
        this.qlen = 0;
      } else {
        if (!this.timer) ok = this._transition();
        if (ok) this._enter();
      }
      if (this.state === 14 || (this.state === 2 && prev !== 2)) this._startStep();   // vt+64
    }
    if (this.state === 14) this._demonStep();                                        // vt+68
    // Draw pass: body (sub_406FE0), Bzzzt (bit1), mood, symbol.
    const d = { body: this._snap(this.cur), bz: null, sym: null };
    this.cur.advance();
    if (this.zap) {
      const bz = g.sheepBzzzt();
      if (bz) { d.bz = this._snap(bz); bz.advance(); }
    }
    this.mood(0);
    const st = this.state;
    if (st !== 2 && (st <= 12 || st > 17)) {
      d.sym = this._snap(this.sym);
      this.sym.advance();
    }
    this._draw = d;
  }
  _snap(a) {
    if (!a.visible || !a.sheet) return null;
    return { sheet: a.sheet, frame: a.frame, x: this.x + a.xo, y: this.y + a.yo, flip: a.flip };
  }

  //--- sub_42B208: accept / reject a transition --------------------------------
  _transition() {
    let v29 = true;
    switch (this.req) {
      case 8: break;                                   // state 29 never applies to sheep
      case 11:
        if (this.state === 11 || this.state === 12 || this.stoned || this.state === 18) {
          this.req = 0;
          if (this.state === 18) return false;
          break;
        }
        this._svenEv(11);
        this.game.dogHowl();                           // sub_405EC7(dword_49BA14, 11)
        return true;
      case 18: this._svenEv(18); return true;
      case 19: this._svenEv(19); return true;
    }
    // LABEL_15
    switch (this.state) {
      case 0:
        this.req = 1;
        break;
      case 1:
        switch (this.req) {
          case 0:
            if (this.timer) return false;
            this.sub = 0;
            if (!(sheepRand() % 3) && (this.dir === 2 || this.dir === 3)) { this.req = 3; this.sub = 0; }
            else { if (sheepRand() % 3) this.dir = sheepRand() % 4; this.req = 1; }
            break;
          case 2: v29 = this._walkCheck(); break;              // LABEL_51
          case 5: case 6: case 9: case 15: case 18: break;
          case 13:
            if (this.game.sheepDemons >= 3) { this.req = 0; v29 = false; }
            else {
              ++this.game.sheepDemons;                         // dword_49BA2C
              this.dir = this._dirToSven();
              this.demonCell = true;                           // sub_42FD34(8)
            }
            break;
          default: this.req = 1; break;
        }
        break;
      case 2:
        if (this.timer) { this.req = 0; v29 = false; }
        else if (++this.sub === 1) {
          // First half done: logical cell moves to dst, eat item, midpoint.
          this.prevRow = this.srcRow; this.prevCol = this.srcCol;
          this.row = this.dstRow; this.col = this.dstCol;
          this._eatAt(this.col, this.row);
          this.x = Math.trunc((this.srcX + this.dstX) / 2);
          this.y = Math.trunc((this.srcY + this.dstY) / 2);
          this.req = 2;
        } else {
          this.sub = 0;
          this.stepping = false;                               // sub_429B5A(src)
          const p = cellToScreen(this.col, this.row);
          this.x = p.x; this.y = p.y;
          this.req = this.stoned ? 8 : 1;
        }
        break;
      case 3:
        if (this.req) {
          switch (this.req) {
            case 2: v29 = this._walkCheck(); if (this.req === 2) this.sub = 0; break;
            case 5: case 6: case 9: this.sub = 0; break;
            default: break;
          }
        } else if (++this.sub >= 3) { this.sub = 0; this.req = 4; }
        else this.req = 3;
        break;
      case 4:
        switch (this.req) {
          case 2: v29 = this._walkCheck(); break;
          case 5: case 6: case 9: break;
          default: this.req = 1; break;
        }
        break;
      case 5:
        if (this.timer) { this.req = 0; v29 = false; } else this.req = 1;
        break;
      case 6:
        if (!this.req) {
          this._shagResult();                                  // vt+100 sub_42EB56
          this.timer = -1000000;
          if (this.love < 3) { this._svenEv(7); this.req = 7; }
          else { this._svenEv(10); this.req = 10; }
        }
        break;
      case 7:
        if (!this.req) this.req = 1;
        break;
      case 9:
        if (this.req) break;
        ++this.kicks;
        this.stamina = sheepRand() % 300 + 600;
        this.mood(0);
        this._svenEv(9);
        this.game.addScore(-4);                                // sub_42A2CB(-4)
        this.state = 4; this.req = 0; this.timer = 1;
        return false;
      case 10:
        this.req = 0; v29 = false;
        break;
      case 11:
        if (this.timer) { this.req = 0; v29 = false; }
        else {
          this.caught = true;                                  // sub_429D24/sub_429C3C: cell cleared
          this.req = 12;
          this.game.addLevelTime(10000);                       // sub_424E7D(11)
          this.game.addScore(10);                              // sub_42A2CB(10)
          this.game.catchChain(this);                          // sub_42546F
          this.timer = -1000000;
        }
        break;
      case 13:
        if (!this.timer) this.req = this._path();              // LABEL_69
        else { this.req = 0; v29 = false; }
        break;
      case 14:
        if (this.timer) {
          if (this.req === 8) {
            this.game.sheepRemainingDec();                     // --dword_49BA28
            this.stoned = true; this.zap = false;
            this.demonCell = false;                            // sub_42FD34(dword_49452C[dir])
            this.req = 1;
            this.stamina = sheepRand() % 300 + 600;
            this.mood(0);
          } else this.req = this._path();                      // LABEL_69
        } else {
          this.demonCell = false;
          this.req = 17;
        }
        break;
      case 15:
        if (this.timer) { this.req = 0; v29 = false; }
        else { this.req = 16; this._svenEv(16); }
        break;
      case 16:
        if (!this.timer) {
          this.req = 1;
          this._svenEv(17);
          this.zap = false;
          this.game.sheepGlobalCalm();                         // sub_424E7D(16)
          break;
        }
        this.req = 0;
        return false;
      case 17:
        if (this.timer) { this.req = 0; return false; }
        --this.game.sheepDemons;
        this.req = 1;
        if (this.demonCount >= 2) {
          this.stamina = sheepRand() % 300 + 1200;
          this.mood(0);
          this.demonCount = 0;
        }
        break;
      case 18:
        this.req = 0; v29 = false;
        break;
      case 19:
        if (this.timer) { this.req = 0; v29 = false; }
        else {
          this.caught = true;                                  // vt+48: off the grid
          if (this.game.ufo) this.game.ufo.addHole(this.col, this.row);   // cell kind 6 (IDA:20250)
          this.req = 20;
        }
        break;
      case 20:
        this.req = 0; v29 = false;
        break;
      default:
        break;
    }
    // LABEL_94
    if (this.req === 15) {
      if (this._attackGate()) {
        this.dir = this._dirToSven();
        this._svenEv(15);
      } else {
        this.req = 17;
        this.stamina = Math.trunc(this.sym.len() / this.sym.speed) * (sheepRand() % 2 + 1) - 600;
        this.mood(0);
      }
    }
    return v29;
  }

  //--- sub_42C2C0: enter the requested state -----------------------------------
  _enter() {
    const v1 = this.req;
    switch (v1) {
      case 1: case 10:
        this._idleEnter();
        break;
      case 2: {
        if (!this.sub) this._applyTbl(this.cur, SHEEP_TBL.walk[this.dir]);
        const a = this.cur;
        a.frozen = false;
        a.setRange(1, 0, 0);
        this.timer = a.duration();
        break;
      }
      case 3: {
        if (!this.sub) this._applyTbl(this.cur, SHEEP_TBL.chew[this.dir]);
        const a = this.cur;
        a.frozen = false;
        a.setRange(1, 0, 12);
        this.timer = a.duration();
        this.game.audio.playChewThrottled();                   // dword_49BA38, 2000 ms
        break;
      }
      case 4: {
        const a = this.cur;
        a.setSpeed(1.0);
        a.frozen = false;
        a.setRange(1, 12, 20);
        this.timer = a.duration();
        break;
      }
      case 5:
        this._seqStart(SHEEP_SEQ.accept, SHEEP_TBL.accept[this.dir], 0);
        this.timer = this.cur.duration();
        this.dir = this._sv().dir;                             // sheep dir := Sven dir
        break;
      case 6:
        this.kicks = 0;
        this._shagSprite();                                    // sub_42CD53
        this.timer = this.cur.duration() - 1;
        break;
      case 7:
        this.timer = 1;
        break;
      case 8:
        this.game.sheepRemainingDec();
        this.req = 1;
        this.stoned = true;                                    // LABEL_3
        this._idleEnter();
        break;
      case 9:
        if (this.stoned) {
          this.cur = this.seqAnim;
          this.seqAnim.setSeq(SHEEP_SEQ.stoned);
          this._applyTbl(this.seqAnim, SHEEP_TBL.stoned[this.dir]);
          this.cur.setSpeed(1.0);
        } else {
          this.cur = this.anim;
          this._applyTbl(this.anim, SHEEP_TBL.kick[this.dir]);
        }
        this.cur.frozen = false;
        this.cur.setRange(1, 0, 0);
        this.timer = this.cur.duration() - 1;
        this._sfx('kick');                                     // dword_49BA30 Kick
        break;
      case 11:
        this._applyTbl(this.cur, SHEEP_TBL.explode);
        this.cur.frozen = false;
        this.cur.setRange(1, -1, -1);
        this.timer = this.cur.duration();
        this._sfx('sheepExplode');                             // dword_49BA40
        break;
      case 12:
        this.y -= 2000;
        this.cur.visible = false;                              // sub_40702E(0)
        this.caught = true;
        this.game.sheepRemainingDec();
        this.timer = -1000000;
        return false;                                          // state stays (IDA:20414)
      case 13:
        this._seqStart(SHEEP_SEQ.demon, SHEEP_TBL.demon[this.dir], 19);
        this.timer = this.cur.duration();
        this._sfx('devil');                                    // aDevil_0
        ++this.demonCount;
        break;
      case 14:
        this.cur = this.anim;
        this._applyTbl(this.anim, SHEEP_TBL.demonRun[this.dir]);
        this._applyTbl(this.sym, SHEEP_TBL.sym[this.dir]);
        this.cur.setSpeed(1.0);
        this.cur.frozen = false;
        this.cur.setRange(0, 0, 0);
        if (this.state !== 14) this.timer = 5;
        break;
      case 15:
        this.special = false;                                  // +148 &= ~1
        this.zap = false;
        this._seqStart(SHEEP_SEQ.attack, SHEEP_TBL.demon[this.dir], 0);
        this.timer = this.cur.duration();
        break;
      case 16:
        this.zap = true;
        this.demonCount = 0;
        this._sfx('electro');                                  // aLightning_1 (Lightning.mp3)
        // falls through to LABEL_38
      case 17:
        this._seqStart(SHEEP_SEQ.revert, SHEEP_TBL.demon[this.dir], 10);
        this.timer = this.cur.duration();
        break;
      case 18:
        this.stoned = true;                                    // LABEL_3
        this._idleEnter();
        break;
      case 19:
        this.y -= 2000;
        this.timer = 15;
        break;
      case 20:
        this.cur.visible = false;
        this.caught = true;
        this.timer = -1000000;
        break;
      default:
        break;
    }
    this.state = this.req;
    this.req = 0;
    return true;
  }
  // LABEL_4 (states 1, 10, 18 and 8).
  _idleEnter() {
    this._applyTbl(this.sym, SHEEP_TBL.sym[this.dir]);
    this.sym.visible = true;
    this.cur = this.anim;
    this._applyTbl(this.anim, SHEEP_TBL.walk[this.dir]);
    this.anim.frozen = true;
    this.anim.setRange(1, 0, 1);
    if (this.stoned) { this.sym.frozen = true; this.timer = -1; }
    else this.timer = sheepRand() % 200 + 100;
    this.shagSfx = -1;                                         // +140 = -1
  }
  // Sequenced-anim state setup used by states 5, 13, 15, 16/17.
  _seqStart(seq, tbl, end) {
    this.cur = this.seqAnim;
    this.seqAnim.setSeq(seq);
    this._applyTbl(this.seqAnim, tbl);
    this.seqAnim.frozen = false;
    this.seqAnim.setRange(1, 0, end);
    if (seq === SHEEP_SEQ.accept) this.seqAnim.setSpeed(1.0);
  }

  // sub_42CD53: shag composite sprite + SFX.
  _shagSprite() {
    const sv = this._sv();
    if (sv.mode === 4) {
      this.cur = this.anim;
      this._applyTbl(this.anim, SHEEP_TBL.alien[this.dir]);
      this.cur.frozen = false;
      this.cur.setRange(1, -1, -1);
    } else {
      let e;
      if (this.special && (this.dir === 2 || this.dir === 3)) {
        this.shagIdx = 0; this.shagSfx = 0;
        e = SHEEP_SHAG_TBL[0];
      } else {
        let lvl = Math.min(this.game.levelIdx | 0, 44);
        const pools = this.dir > 1 ? SHEEP_SHAG_POOLS.south : SHEEP_SHAG_POOLS.north;
        // Rows 0..44 of unk_49B300/49B688 are zero-filled except levels 1..20.
        let list = pools[lvl] || [];
        while (!list.length && lvl > 0) { --lvl; list = pools[lvl] || []; }   // IDA:20593-20597
        const cnt = list.length;
        if (this.shagIdx === -1 || this.shagIdx >= cnt) this.shagIdx = sheepRand() % cnt;
        e = SHEEP_SHAG_TBL[list[this.shagIdx]];
      }
      const sheet = this._asset(e[0]);
      if (!sheet) return false;                                // if (!v9[8]) return 0
      this.cur = this.anim;
      this.anim.setSprite(e[0], sheet);
      if (e[1] === this.dir) { this.anim.flip = false; this._offsets(this.anim, e[2], e[3]); }
      else { this.anim.flip = true; this._offsets(this.anim, e[4], e[5]); }
      this.anim.frozen = false;
      this.anim.setRange(1, -1, -1);
      this.anim.setSpeed(SHEEP_SHAG_SPEED);
    }
    let key;
    if (sv.mode !== 4 && this.special && (this.dir === 2 || this.dir === 3)) key = SHEEP_SHAG_SFX[0];
    else {
      if (this.shagSfx === -1) this.shagSfx = sheepRand() % 11 + 1;
      key = SHEEP_SHAG_SFX[this.shagSfx];
    }
    this._sfx(key);
    return true;
  }

  // vt+100 sub_42EB56: shag completed.
  _shagResult() {
    const mode = this._sv().mode;
    this.game.addScore(Sheep.shagScore(mode));               // vt+104 sub_42ECF3
    const v4 = this.love;
    if (v4) {
      if (v4 === 1) {
        if (mode < 2 || mode > 3) this.love++;
        else { this.love = 3; this.loveT = 20; }
      } else if (v4 === 2) {
        this.love++; this.loveT = 20;
      }
    } else {
      this._refill(mode);                                      // sub_42ED53
      const v1 = this.stamina > 0 ? Math.trunc(10 * this.stamina / 3000) + 1
                                  : (Math.trunc(-10 * this.stamina / -3000) | 0);
      if (v1 >= 10) {
        if (mode === 4) { this.love = 3; this.loveT = 20; }
        else this.love = 1;
        this.game.recordCatch(this);                           // sub_425311
        // dword_49BA18 = score_table anim (scene[57]): unfreeze (+36 = 0),
        // setRange(1,1,1) → frames 1..3 once (IDA:21637-21642).
        if (this.game.startScoreTableFlash) this.game.startScoreTableFlash();
      }
    }
  }
  // sub_42ECF3
  static shagScore(mode) {
    switch (mode) { case 1: case 5: return 1; case 2: return 3; case 3: return 5; case 4: return 15; default: return 0; }
  }
  // sub_42ED53: first-shag stamina refill, delta added to the pool.
  _refill(mode) {
    let v3 = this.stamina;
    switch (mode) {
      case 1: case 5: v3 += 600; break;
      case 2: v3 += 1200; break;
      case 3:
        if (this.moodLevel > 0) {
          v3 = 3000;
          if (this.moodLevel >= 10) { this.love = 3; this.loveT = 20; }
        } else v3 = 600;
        break;
      case 4: v3 = 3000; break;
      default: break;
    }
    if (v3 > 3000) v3 = 3000;
    const delta = v3 - this.stamina;
    this.game.pool += delta;
    if (this.game.pool > this.game.poolMax) this.game.pool = this.game.poolMax;
    this.stamina = v3;
    return delta;
  }

  //--- sub_42D08E: mood level + Symbols anim -----------------------------------
  mood(a2) {
    if (this.stoned) return true;
    const v28 = this.moodLevel;
    let v27;
    if (this.love < 3) {
      v27 = this.stamina > 0 ? Math.trunc(10 * this.stamina / 3000) + 1
                             : (Math.trunc(-10 * this.stamina / -3000) | 0);
    } else v27 = this.love + 10;
    if (v27 === this.moodLevel) return true;
    this.moodLevel = v27;
    if (this.moodLevel < 10) this.love = 0;
    const s = this.sym;
    const rng = (loops, a, b, spd, frozen = false) => {
      s.frozen = frozen; s.setRange(loops, a, b); if (spd != null) s.setSpeed(spd);
    };
    const bleat = () => {
      if (this.state !== 6 && this.state !== 7 && !this.qlen) this.request(2);
      this.game.audio.playMeeThrottled();                      // dword_49BA3C, 3000 ms
    };
    switch (v27) {
      case -3:
        this.stamina = 0;
        if (this.state === 1) this.request(13);
        break;
      case -1:
        if (this.state === 1) this.request(13);
        rng(0, 12, 14, 0.1);
        this.stamina = Math.trunc(s.len() / s.speed) * (sheepRand() % 2 + 1) - 600;
        this.moodLevel = this.stamina > 0 ? Math.trunc(10 * this.stamina / 3000) + 1
                                          : (Math.trunc(-10 * this.stamina / -3000) | 0);
        break;
      case 0:
        rng(0, 11, 13, null);
        s.frame = 13; s.pos = 13;
        s.setSpeed(0.1);
        this.stamina = 1 - (300 - sheepRand() % 100);
        break;
      case 1:
        rng(0, 11, 13, null);
        s.frame = 13; s.pos = 13;
        s.setSpeed(0.1);
        bleat();
        break;
      case 2: rng(0, 9, 11, 0.2); bleat(); break;
      case 3: rng(0, 9, 11, 0.1); break;
      case 4: case 5: case 6: rng(0, 6, 9, 0.1); break;
      case 7: rng(1, 5, 6, 1.0, true); break;
      case 8: rng(1, 4, 5, 1.0, true); break;
      case 9: rng(1, 3, 4, 1.0, true); break;
      case 10: rng(0, 0, 3, 0.1); break;
      case 11: case 12:
        if (!a2 && v27 > v28) {
          this.game.audio.playHappy();
        }
        rng(0, 0, 3, 0.1);
        break;
      case 13: rng(1, 14, 20, 0.25); break;
      case 14: rng(0, 18, 20, 0.25); break;
      case 15: case 16: s.setSpeed(0.25); break;
      case 17: s.visible = false; break;
      default: return true;
    }
    return true;
  }

  //--- walking / demon movement ------------------------------------------------
  // sub_42F992: can the sheep step in its facing? (refusal clears req)
  _walkCheck() {
    const t = this._nb(this.dir);
    const ok = this._inBounds(t.col, t.row) && this._kindLand(t.col, t.row) && this._cellEmpty(t.col, t.row);
    if (!ok) { this.req = 0; return false; }
    if (this._sameSpecial(this.col, this.row, t.col, t.row)) { this.req = 0; return false; }
    return true;
  }
  // vt+64 sub_42FB11: start of a walk step (state 2) or demon step (state 14).
  _startStep() {
    if (this.state !== 2 && this.state !== 14) return;
    this.srcRow = this.row; this.srcCol = this.col;
    const t = this._nb(this.dir);
    this.dstRow = t.row; this.dstCol = t.col;
    this.stepping = true;
    if (this.state === 2) this.sub = 0;
    const a = cellToScreen(this.srcCol, this.srcRow);
    const b = cellToScreen(this.dstCol, this.dstRow);
    this.srcX = a.x; this.srcY = a.y; this.dstX = b.x; this.dstY = b.y;
  }
  // vt+68 sub_41A0BA: demon step, 8 ticks (vt+72 = dword_49453C), linear.
  _demonStep() {
    const v4 = 8;
    ++this.stepTick;
    this.x = Math.trunc((this.stepTick * this.dstX + (v4 - this.stepTick) * this.srcX) / v4);
    this.y = Math.trunc(((v4 - this.stepTick) * this.srcY + this.stepTick * this.dstY) / v4);
    if (this.stepTick === v4 / 2) {
      this.prevRow = this.srcRow; this.prevCol = this.srcCol;
      this.row = this.dstRow; this.col = this.dstCol;
      this._arrive();
    } else if (this.stepTick >= v4) {
      this.stepping = false;                                   // sub_429B5A(src)
      this.stepTick = 0;
      this._arrive();
    }
  }
  // vt+76 sub_42F337: arrival hook.
  _arrive() {
    this._eatAt(this.col, this.row);
    if (this.demonCell) this.request(14);
  }
  // Cell kind 7 → sub_4300DA, cell back to kind 1, item removed (IDA:19984-19992).
  _eatAt(c, r) {
    if (!this._mushAt(c, r)) return;
    const m = this.game.consumeMushroomAt(c, r);
    const kind = m && m.kind;
    if (kind === 2 && this.game.difficulty.lightningEnabled) this.request(8);   // sub_4300DA, +8404
  }
  // sub_42F3ED: demon pathing toward Sven. Returns 14 (step), 15 (attack), 17 (revert).
  _path() {
    const sv = this._sv();
    const dc = sv.col - this.col, dr = sv.row - this.row;
    const v23 = Math.abs(dc) <= Math.abs(dr) ? (dr <= 0 ? 1 : 3) : (dc <= 0 ? 2 : 0);
    const v20 = Math.abs(dc) <= Math.abs(dr) ? (dc <= 0 ? 2 : 0) : (dr <= 0 ? 1 : 3);
    const cand = [v23, v20, SHEEP_DIR_TBL[v20], SHEEP_DIR_TBL[v23]];
    let v30 = -1, i;
    for (i = 0; i < 4; ++i) {
      const t = this._nb(cand[i]);
      if (!this._inBounds(t.col, t.row)) continue;
      const land = this._kindLand(t.col, t.row);
      if (land && this._svenAt(t.col, t.row)) {
        const b1 = this._bits(t.col, t.row).b1;
        if (!(b1 & CELL_SHEP) && !(b1 & CELL_DOG) && !(sv.state >= 39 && sv.state <= 42)) {  // byte1&2, &4
          this.dir = this._dirToSven();
          this.demonCell = false;
          return 15;
        }
      }
      const tb = land ? this._bits(t.col, t.row) : null;
      if (land && !tb.b2 && !tb.b1) {                          // !v26[2] && !v26[1] (IDA:21954)
        if (!this._sameSpecial(this.col, this.row, t.col, t.row)) {
          if (t.row !== this.prevRow || t.col !== this.prevCol) break;
          v30 = cand[i];
        }
      }
    }
    if (i === 4) {
      if (v30 === -1) { this.demonCell = false; return 17; }
      this.dir = v30;
    } else this.dir = cand[i];
    return 14;
  }
  // sub_42EFBE: may the demon attack Sven? (front or side cell, Sven idle/zapped)
  _attackGate() {
    const st = this.state;
    if (st !== 1) {
      if (st <= 12 || st > 14) return false;
      if (this.req !== 15) return false;
    }
    if (this.moodLevel > 0) return false;
    const sv = this._sv();
    if (sv.saint > 0 || sv.mode === 4 || sv.state === 48) return false;
    if (sv.state !== 28 && sv.state !== 43 && sv.state !== 44) return false;
    for (const d of [this.dir, SHEEP_DIR_TBL[this.dir + 8], SHEEP_DIR_TBL[this.dir + 4]]) {
      const t = this._nb(d);
      // (byte2 & 1) != 0 only (IDA:21831/21836/21841).
      if (this._inBounds(t.col, t.row) && this._kindLand(t.col, t.row)
          && (this._bits(t.col, t.row).b2 & CELL_SVEN)) return true;
    }
    return false;
  }

  //--- render: blit what the last tick drew ------------------------------------
  draw(g) {
    const d = this._draw;
    if (!d) return;
    for (const p of [d.body, d.bz, d.sym]) {
      if (p) p.sheet.drawFrame(g, p.frame, p.x, p.y, p.flip);
    }
  }
}
