//=== Sven entity ===========================================================
// Port of the CSven class (ctor sub_434120, vtable off_474244). Per-tick
// logic sub_434852, request resolver sub_434A6A, state-entry setup
// sub_43707B. All timing is in integer game ticks (20 Hz, one update() call
// = one tick); fields mirror the original this[N] slots noted below.
//
// States (this[26]); requests (this[27]) use the same codes:
//   27 blink (after relocation)   28 stand          29 walk
//   30 cliff drown (splash)       31 whistle        32 shag (Sven hidden)
//   33 "may continue shag"        34 kicked by sheep (Sven hidden)
//   35 dog-shag (hidden)          36 "may continue dog-shag"
//   37/38 caught by dog/shepherd  39/40 caught (stand/walk) + Fight cloud
//   41 fight (hidden)             42 caught end (respawn home)
//   43/44/45 electrocuted by demon sheep   46 puddle splash
//   47 abducted by UFO (hidden)   48 falls back as Alien   49 time-out explode
const SVEN_STATE = Object.freeze({
  INIT: 0, BLINK: 27, STAND: 28, WALK: 29, DROWN: 30, WHISTLE: 31, SHAG: 32,
  SHAG_MORE: 33, KICKED: 34, DOGSHAG: 35, DOGSHAG_MORE: 36, CAUGHT_DOG: 37,
  CAUGHT_SHEP: 38, CAUGHT_STAND: 39, CAUGHT_WALK: 40, CAUGHT_FIGHT: 41,
  CAUGHT_END: 42, ELECTRO_IN: 43, ELECTRO: 44, ELECTRO_OUT: 45, PUDDLE: 46,
  ABDUCTED: 47, ALIEN_FALL: 48, EXPLODE: 49,
});

// Sven sprite records come from core.js SPRITE_OFFSETS (Sven.exe .data,
// tables 0x495A90..0x496008: [name, x, y, flip] per dir 0 NE, 1 NW, 2 SW,
// 3 SE, plus the table speed). Drawn with sub_401D89 mode 2:
// (anchor.x + x, anchor.y + y - frameH).
function svenRec(table, dir = 0) {
  const t = SPRITE_OFFSETS[table];
  const e = t.d.length === 1 ? t.d[0] : t.d[dir];
  return [e[0], e[1], e[2], e[3], t.speed];
}
// Frame tables (frame, ticks) for the sub_41C4ED frame-table animator.
const SVEN_WHISTLE_TABLE = [[0,4],[1,1],[2,1],[3,1],[4,2],[5,1],[6,1],[7,1],[8,1],[9,2],[10,1],[11,1],[12,1],[13,2],[14,1],[15,1],[0,2]]; // unk_495C58 (24 ticks)
const SVEN_ELECTRO_TABLE = [[0,17],[1,2],[2,2],[3,1],[4,1],[5,1],[6,9],[7,1],[8,6]];  // unk_495BB0
const SVEN_ALIENFALL_TABLE = [[6,1],[7,2],[8,2],[9,2],[10,2],[11,2],[12,13],[12,1]]; // unk_495DD0
// Library.ini frame counts (fallback before a sheet is loaded).
const SVEN_FRAMES = {
  Sven_stand01: 1, Sven_stand02: 1, Sven_walk01: 14, Sven_walk02: 14, Sven_electro01: 9, Sven_electro02: 9,
  SvenInvite01: 16, SvenInvite02: 16, SvenBlink01: 4, SvenBlink02: 4, Alien_stand01: 1, Alien_stand02: 1,
  Alien_walk01: 14, Alien_walk02: 14, AlienInvite01: 16, AlienInvite02: 16, AlienFall01: 13,
  splash: 14, Fight: 5, SvenExplode: 14, AlienExplode: 14,
};
const SVEN_OPPOSITE = [2, 3, 0, 1];                 // dword_491608
const SVEN_STEP_TICKS = 8;                          // dword_495A84
const SVEN_STEP_SCALE = Math.fround(0.75);          // flt_495A88

// The shag pools / table (sub_42EA6B, sub_42CD53) live in sheep.js.

// Normal animator (sub_401950 object; advance sub_401C8E, range sub_401EBD,
// total sub_401FB0, image switch sub_40709A/sub_401B62).
class SvenAnim {
  constructor() {
    this.image = null; this.frames = 0; this.start = 0; this.end = 0; this.loops = 0;
    this.frame = 0; this.pos = 0; this.speed = 1; this.stopped = false; this.visible = true;
    this.flip = false; this.ax = 0; this.ay = 0;
  }
  // sub_40709A: reset only when the image changes; then flip + offsets.
  setEntry(entry, framesOf) {
    const [name, x, y, flip, speed] = entry;
    if (this.image !== name) {                       // sub_401B62
      this.image = name; this.frames = framesOf(name);
      this.start = 0; this.end = this.frames; this.loops = 0;
      this.frame = 0; this.pos = 0; this.stopped = false; this.visible = true;
      this.setSpeed(speed || 1);
    }
    this.flip = !!flip; this.ax = x; this.ay = y;
  }
  setSpeed(s) { this.speed = Math.fround(s); }
  count() { return this.end <= this.start ? this.end + this.frames - this.start : this.end - this.start; } // sub_401F60
  setRange(loops, start, end) {                      // sub_401EBD
    if (start >= 0) this.start = start >= this.frames ? 0 : start;
    if (end > 0) this.end = Math.min(end, this.frames);
    else if (end === 0) this.end = this.frames;
    if (loops >= 0) this.loops = loops;
    this.frame = this.start; this.pos = this.frame;
    return this.frame;
  }
  total() { return Math.trunc(this.count() * this.loops / this.speed); } // sub_401FB0
  advance() {                                        // sub_401C8E
    if (this.stopped || !this.image || this.count() <= 0) return;   // no image set yet
    const v = this.pos + this.speed;                 // x87 sum (unrounded)
    let f = Math.trunc(v);                           // v4 = (__int64)v2
    const frac = Math.fround(Math.fround(v) - f);    // v7 = (float)v2 - v4
    const n = this.count();
    let wrapped = false;
    if (this.end <= this.start) {
      if (f >= this.frames) { wrapped = true; do f -= n; while (f >= this.end + this.frames); }
    } else if (f >= this.end) {
      wrapped = true; do f -= n; while (f >= this.end);
    }
    if (wrapped && !--this.loops) this.stopped = true;
    this.frame = f; this.pos = Math.fround(f + frac);   // +44 float
  }
}
// Frame-table animator (sub_41C480; advance sub_41C4ED, range sub_41C6B9,
// total sub_41C760 = loops * sub_41C5D9). Speed forced to 1 (sub_41C780).
class SvenTableAnim extends SvenAnim {
  constructor() { super(); this.table = SVEN_WHISTLE_TABLE; this.idx = 0; this.sub = 0; }
  setSpeed() { this.speed = 1; }
  setTable(table) { this.table = table; this.end = table.length; this.idx = 0; this.start = 0; this.sub = 0; this.frame = table[0][0]; }
  setRange(loops, start, end) {
    const n = this.table.length;
    if (start >= 0) this.start = start >= n ? 0 : start;
    if (end > 0) this.end = Math.min(end, n);
    else if (end === 0) this.end = n;
    if (loops >= 0) this.loops = loops;
    this.idx = this.start; this.frame = this.table[this.idx][0];
    return this.frame;
  }
  total() {
    let t = 0; const n = this.table.length;
    if (this.start >= this.end) { for (let i = this.start; i < n; i++) t += this.table[i][1]; for (let i = 0; i < this.end; i++) t += this.table[i][1]; }
    else for (let i = this.start; i < this.end; i++) t += this.table[i][1];
    return this.loops * t;
  }
  advance() {
    if (this.stopped || !this.image) return;
    const n = this.table.length;
    if (++this.sub === this.table[Math.min(this.idx, n - 1)][1]) {
      this.idx++;
      if (this.end <= this.start && this.idx === n) this.idx = 0;
      if (this.idx === this.end) {
        if (--this.loops) this.idx = this.start; else this.stopped = true;
      }
      this.sub = 0;
      // UNVERIFIED: at idx == table length the original reads one entry past
      // the table; the state ends that same tick, so hold the last frame.
      this.frame = this.table[Math.min(this.idx, n - 1)][0];
    }
  }
}

class Sven {
  constructor(spawn) {
    this.col = spawn.col;          // this[13]
    this.row = spawn.row;          // this[12]
    this.facing = DIR.SW;          // this[14]; sub_434120(row, col, 2) at IDA:9071
    this.homeCol = this.col; this.homeRow = this.row; this.homeDir = this.facing; // this[43..45]
    this.game = null;              // set by GAME_LEVEL_HOOKS (game_interact.js)
    // State machine (sub_4346DA): this[26] state, this[27] request,
    // this[28..32] event inbox, this[41] countdown.
    this.state = 0; this.req = 0; this.events = []; this.timer = 1;
    // Input fields this[34] (+136 last vk), this[35] (+140 action) and the
    // +148 Space-release latch. +140/+148 live on the game controller
    // (game.svenHeldAction / game.svenActionReleased, written by handleKey /
    // gameKeyUp); see the accessors below.
    this._keyFlag = false;
    this.demo = false;             // +200 demo autopilot (sub_436173)
    this.onGrid = true;            // +44 (vtable+44 / vtable+48)
    this.target = null;            // this[46] sheep being shagged / zapping
    this.caughtByDog = false;      // +232
    // Step (sub_419ECE / sub_41A0BA): this[21] tick, this[17..20] cells.
    this.stepTick = 0;
    this.fromCol = this.col; this.fromRow = this.row; this.toCol = this.col; this.toRow = this.row;
    const p = cellToScreen(this.col, this.row);
    this.px = p.x; this.py = p.y;  // entity anchor (vtable+16 position)
    this.haloHidden = false;       // saint disc sub-sprite (+156) visibility byte, per state entry
    // Facing latched into the +156 record (off_495F30/off_495F90 [6*this[14]])
    // at state entry 27/28/29/37/38/43-45 (IDA:25140-25349); read by drawSaintHalo.
    this.haloDir = this.facing;
    // Sub-objects: main animator (+32), frame-table animator (+36),
    // current (+24), fight cloud (dword_49BB34, created in sub_434443).
    this.mainAnim = new SvenAnim();
    this.tableAnim = new SvenTableAnim();
    this.cur = this.mainAnim;
    this.fight = new SvenAnim(); this.fight.visible = false;   // sub_40702E(fight, 0)
    this.fightX = 4000; this.fightY = 4000;   // sub_406DF0 at (4000,4000) (IDA:9050-9053)
    this.fightZ = 2000;            // dword_49BB34 z: vtable+28(2000) in sub_434443 (IDA:24049)
    this.fightEntity = new SvenFightCloud(this);   // its own scene-list entry
  }

  //--- helpers -------------------------------------------------------------
  _sheet(name) { return name && this.game && this.game.assets ? this.game.assets[name] || null : null; }
  _framesOf(name) {
    const sh = this._sheet(name);
    if (sh) return sh.frames;
    const def = this.game && this.game.lib && this.game.lib.Images && this.game.lib.Images[name];
    if (def) return +def.split(',')[3];
    return SVEN_FRAMES[name] || 1;
  }
  _set(anim, entry) { anim.setEntry(entry, n => this._framesOf(n)); }
  _front(dir) { const d = DIR_DELTA[dir]; return { col: this.col + d.dc, row: this.row + d.dr }; }
  _cell(col, row) { return this.game.svenCellInfo(col, row); }
  _audio(key) { if (this.game && this.game.audio) this.game.audio.play(key); }
  _score(n) { if (this.game && this.game.addScore) this.game.addScore(n); }
  _dogEvent(code) { this.game.dogEvent(code); }        // sub_405C45(dword_49BB28, code)
  _shepEvent(code) { this.game.shepherdEvent(code); }  // sub_43217A(dword_49BB2C, code)
  _alert(code) { this._shepEvent(code); this._dogEvent(code); }
  _sheepEvent(sh, code) {                       // vtable+96: sheep sub_42FEBA, mermaid sub_419B80
    if (sh) sh.svenEvent(code);
  }
  _push(code) {                                                           // sub_438A18 inbox push
    if (this.events.length >= 5) return true;
    if (!this.events.length || this.events[this.events.length - 1] !== code) this.events.push(code);
    return true;
  }
  // Sven mode this[47] (+188) and deadline this[48] are kept by the
  // mushroom area (game.svenMode / setSvenMode / clearSvenMode, with the
  // expiry of sub_434852 IDA:24113-24120 in its tick hook).
  get mode() { return this.game.svenMode; }
  _clearMode() { this.game.clearSvenMode(); }      // this[47] = 1; this[48] = -1
  // sub_438F90: ticks per cell (dword_495A84 = 8, flt_495A88 = 0.75).
  stepTicks() {
    const m = this.mode;
    if (m === 2 || m === 4) return Math.trunc(SVEN_STEP_TICKS * SVEN_STEP_SCALE + 1.0) >> 1; // 3
    if (m === 5) return Math.trunc(SVEN_STEP_TICKS * SVEN_STEP_SCALE * 2);                   // 12
    return SVEN_STEP_TICKS;                                                                     // 8
  }
  // +136: a plain field, set by every WM_KEYDOWN incl. OS auto-repeat
  // (sub_420507 LABEL_41, IDA:14720-14731) and cleared only by the resolver;
  // keyup never touches it (sub_42082B).
  get keyFlag() { return this._keyFlag; }
  set keyFlag(v) { this._keyFlag = v; }
  get keyIdx() { return this.game.svenHeldAction; }          // +140 (game controller)
  set keyIdx(v) { this.game.svenHeldAction = v; }
  get spaceLatch() { return this.game.svenActionReleased; }   // +148
  set spaceLatch(v) { this.game.svenActionReleased = v; }
  // Cell bits (type 5 = 0x01) as other movers see Sven:
  //   present  byte2: logical cell (vtable+56/+52 at the half-step);
  //   incoming byte1: to-cell this[19..20], set at step start (sub_419ECE
  //            sub_429C3C) and kept until the next step start (sub_429E83
  //            clears it); at rest to-cell == own cell (sub_41A40A/41A2F8);
  //   leaving  byte0: from-cell this[17..18] for the whole step (sub_429E83
  //            at start .. sub_429B5A at arrival, 0x41A1CB).
  // A reversal swaps the two (sub_429E83(to) + sub_429F69(from), IDA:25083-25084).
  // vtable+48 (sub_41A353) clears all three → nothing while off the grid.
  occupancyAt(col, row) {
    const r = { present: false, incoming: false, leaving: false };
    if (!this.onGrid) return r;
    if (col === this.col && row === this.row) r.present = true;
    if (col === this.toCol && row === this.toRow) r.incoming = true;
    if (this.stepTick > 0 && col === this.fromCol && row === this.fromRow) r.leaving = true;
    return r;
  }
  get hideHalo() { return this.haloHidden; }
  screenPos() { return { x: this.px, y: this.py }; }
  get _depthY() { return this.py; }                 // depth sort by the entity anchor
  get _depthX() { return this.px; }

  //--- external events ---------------------------------------------------
  // sub_438585(code, sheep): events from a sheep (or the mermaid).
  onSheepEvent(code, sheep) {
    if (this.events.length >= 5) return true;
    let v;
    switch (code) {
      case 7: case 24:
        if (this.events.length) return true;
        v = 33; break;
      case 9: case 10: v = 28; break;
      case 11: case 18: case 19: case 26:
        if (this.target === sheep && (this.state === 32 || this.state === 33 || this.state === 34)) { v = 28; break; }
        return true;
      case 15:
        if ((this.state >= 39 && this.state <= 41) || this.state === 43 || this.state === 44) return false;
        this.target = sheep;
        v = this.state === 45 ? 44 : 43; break;
      case 16:
        if (this.state === 43 || this.state === 45) { v = 44; this.target = sheep; break; }
        if (this.state === 44) this.target = sheep;
        return false;
      case 17:
        if (this.state === 44 && this.target === sheep) { v = 45; break; }
        return false;
      default: return false;
    }
    return this._push(v);
  }
  // Dog / shepherd → Sven channel (game.npcToSven): 60 dog catch
  // (sub_4388F0), 67 shepherd catch (sub_438818), 52/58/59 dog-shag.
  onNpcEvent(code) { return code === 67 ? this.shepherdEvent(code) : this.dogEvent(code); }
  // sub_4388F0: events from the dog (52/59 → stand, 58 → may continue dog-shag, 60 → caught).
  dogEvent(code) {
    if (this.events.length >= 5) return true;
    let v;
    switch (code) {
      case 52: case 59: v = 28; break;
      case 58: v = 36; break;
      case 60:
        if ((this.state >= 39 && this.state <= 42) || this.state === 49) return false;
        v = 37; break;
      default: return false;
    }
    return this._push(v);
  }
  // sub_438818(67): caught by the shepherd.
  shepherdEvent(code) {
    if (this.events.length >= 5) return true;
    if (code !== 67) return false;
    if ((this.state >= 39 && this.state <= 42) || this.state === 49) return false;
    return this._push(38);
  }
  // sub_438BF1(row, col): UFO 'L' — abduct if Sven stands idle on that cell.
  ufoAbduct(col, row) {
    if (col !== this.col || row !== this.row) return false;
    if (this.state !== 28) return false;
    this._push(47);
    return true;
  }
  // sub_438A80(80): UFO 'P' — Sven falls back as an alien.
  ufoReturn(code = 80) {
    if (this.events.length >= 5) return true;
    if (code !== 80) return false;
    if (this.facing === 0) this.facing = 3;
    else if (this.facing === 1) this.facing = 2;
    return this._push(48);
  }
  // sub_438B37(83): level time ran out → explode (state 49). The inbox is
  // replaced, not appended.
  timeOut(code = 83) {
    if (this.events.length >= 5) return true;
    if (code !== 83) return false;
    const s = this.state;
    if ((s >= 27 && s <= 38) || (s >= 43 && s <= 46)) { this.events = [49]; return true; }
    if ((s >= 39 && s <= 42) || s === 47 || s === 48) { this.events = [49]; return false; }
    return false;
  }

  //--- per tick: sub_434852 -------------------------------------------------
  update() {
    if (!this.game) return false;                   // attached by GAME_LEVEL_HOOKS
    // The original advances only the drawn animators (sub_401BDE on this[6]
    // and the fight cloud). All three advance here every tick: equivalent,
    // since every switch back to an animator resets it (setTable/setRange or
    // the image change in state 28).
    this.mainAnim.advance(); this.tableAnim.advance(); this.fight.advance();
    --this.timer;
    // Mode (this[47]/[48], only when !this[21]) and saint (this[49]) expiry,
    // IDA:24113-24126; the timers live in game_items.js.
    this.game.tickSvenTimers(this.stepTick);
    if (this.demo) this._demoTick();               // sub_436173
    let ok = false;
    if (this.events.length) {
      let any = false, last = 0;
      const evs = this.events;
      // i < this[33]: a relocation inside the loop (sub_4346DA) zeroes it.
      for (let i = 0; i < evs.length && this.events === evs; i++) {
        this.req = evs[i];
        ok = this._resolve();
        if (ok) { this.state = this.req; last = this.req; any = true; }
      }
      if (any) { this.req = last; this._enter(); }
      this.events = [];
    } else {
      if (this.keyFlag || this.timer === 0) ok = this._resolve();
      if (ok) this._enter();
    }
    if (this.state === 29 || this.state === 40) {
      if (!this.stepTick) this._stepSetup();       // vtable+64 sub_419ECE
      this._stepAdvance();                          // vtable+68 sub_41A0BA
    }
    return ok;
  }

  //--- sub_434A6A: resolve the request against the current state -----------
  _resolve() {
    const g = this.game;
    switch (this.req) {
      case 37: case 38: {                           // '%' / '&': caught by dog / shepherd
        const s = this.state;
        const byDog = this.req === 37;
        if (s === 32 || s === 34 || s === 43 || s === 44 || s === 45) { this._sheepEvent(this.target, this.req); this.target = null; }
        else if (!byDog && s === 35) this._dogEvent(38);
        else if (s === 39 || s === 40 || s === 41 || s === 46) this.req = 0;
        this._placeFight(byDog, 2000);              // vtable+28(2000) (IDA:24270/24308)
        return this.req !== 0;
      }
      case 47:                                      // '/': abducted by the UFO
        this.onGrid = false;                        // vtable+48
        if (g.ufo) g.ufo.addHole(this.col, this.row);  // cell type 6, ptr 0 (IDA:24313)
        this._dogEvent(47);
        this._clearMode();
        return true;
      case 49:                                      // '1': time-out bomb
        if ((this.state >= 39 && this.state <= 42) || this.state === 47 || this.state === 48) { this.req = 0; return false; }
        this._dogEvent(28); this._shepEvent(28);
        if (this.target) { this._sheepEvent(this.target, 28); this.target = null; }
        this.onGrid = false;                        // vtable+48
        return true;
    }
    let ok = true;
    const key = this.keyIdx;                        // v62
    const ret = () => {                             // LABEL_182
      const r = this.req;
      if (r === 30 || r === 31 || (r >= 39 && r <= 42) || r === 46) this.timer = -1000000;
      return ok;
    };
    switch (this.state) {
      case 0: case 27:
        this.req = 28; this.keyFlag = false; return ret();
      case 28:
        if (this.req === 43 || this.req === 47) return ret();
        this.req = 0;
        if (key === 4) { this.req = this._spaceAction(); this.keyFlag = false; this.keyIdx = -1; }
        else if (key === -1) ok = false;
        else this.req = this._turnOrWalk(key);
        return ret();
      case 29:
        if (this.req !== 30 && this.req !== 46) {
          if (key === -1) { this.keyFlag = false; ok = false; }
          else if (key === 4) ok = false;           // Space is ignored while walking
          else this.req = this._turnOrWalk(key);
          if (!ok) ok = this.req === 28;
        }
        return ret();
      case 30:                                      // cliff drown finished
        if (this.timer) ok = false;
        else {
          this._relocate(true);                     // vtable+48, vtable+80(1) = sub_43473D(1)
          this.req = 27;
          g.onSvenDrownRelocated();                 // sub_419C24
        }
        this.keyFlag = false;
        return ret();
      case 31:                                      // whistle
        if (this.req === 43) return ret();
        if (key !== 4 && key !== -1) { this.req = this._turnOrWalk(key); return ret(); } // LABEL_30
        this.keyFlag = false;
        if (this.timer) ok = false;
        else {
          this.req = 28;
          const f = this._front(this.facing);
          const info = this._cell(f.col, f.row);
          const sh = (info.type === 7 || info.type === 1) ? info.sheep : null;
          if (sh && sh.dir !== this.facing && this._sheepMay(sh)) this._sheepEvent(sh, 31);
        }
        return ret();
      case 32:                                      // shag
        if (this.req !== 33) {
          if (this.req !== 28) {
            if (key === -1 || key === 4) ok = false;
            else {                                   // walked away mid-shag
              this.req = this._turnOrWalk(key);
              this._sheepEvent(this.target, 29);
              this.target = null; this.keyFlag = false;
              this._alert(28);
            }
            return ret();
          }
          this._alert(28); this.target = null;      // LABEL_92
          return ret();
        }
        if (key !== 4) {
          if (key === -1) { this.req = 28; this.keyFlag = false; }
          else this.req = this._turnOrWalk(key);
          this._alert(28); this.target = null;      // LABEL_92
          return ret();
        }
        if (this.spaceLatch) {                      // Space released and pressed again → chain
          this._sheepShagOk(this.target);           // vtable+84 (result ignored)
          this.req = 32; this.spaceLatch = false;
          this._sheepEvent(this.target, 32);
          this._alert(32);
        } else {
          this._alert(28); this.req = 28; this.target = null;
        }
        this.keyIdx = -1; this.keyFlag = false;
        return ret();
      case 33: case 36:
        this.req = 28; return ret();
      case 34:                                      // kicked by the sheep
        if (this.req === 28) {
          const t = this.target;
          if (!(t && t.stoned)) {                   // (target+128 & 2) == 0
            if (this.facing === 1) this.facing = 2;
            else if (this.facing === 0) this.facing = 3;
          }
          this.target = null;
        }
        this.keyFlag = false;
        if (!this.req) ok = false;
        return ret();
      case 35:                                      // dog-shag
        if (this.req === 36) {
          if (key === 4) {
            if (this.spaceLatch) {
              this._dogEvent(35); this._shepEvent(35);
              this.req = 35; this.spaceLatch = false; this.keyIdx = -1;
            } else { this._alert(28); this.req = 28; }
          } else {
            if (key === -1) { this.req = 28; this.keyFlag = false; }
            else this.req = this._turnOrWalk(key);
            this._alert(28);
          }
        } else if (this.req !== 43 && this.req !== 28) ok = false;
        return ret();
      case 37: case 38: case 39: case 40:           // caught: fight cloud
        if (this.timer) { this.req = 0; ok = false; }
        else {
          this.req = 41;
          this._dogEvent(41); this._shepEvent(41);
          g.onSvenCaught();                          // sub_424CB8(41)
          ok = true;
        }
        this._placeFight();
        this.keyFlag = false;
        return ret();
      case 41:
        if (this.timer) { this.req = 0; ok = false; }
        else { this.req = 42; ok = true; }
        this._placeFight();
        this.keyFlag = false;
        return ret();
      case 42:
        if (!this.timer) {
          g.onSvenCatchAnimDone();                   // sub_424CB8(42)
          this.onGrid = false;                       // vtable+48 (IDA:24671)
          if (g.lives > 0) {
            this._relocate(false);                   // sub_43473D(this, 0): home
            this._clearMode();
            this._set(this.cur, svenRec('SvenStand', this.facing));
          }
        }
        this.req = 0; ok = false; this.keyFlag = false;
        return ret();
      case 43:
        this.keyFlag = false;
        if (this.req === 44) this._score(-50);
        else { this.req = 0; ok = false; }
        return ret();
      case 44:
        this.keyFlag = false;
        if (this.req !== 45) {
          if (this.req === 44) this._score(-20);
          this.req = 0; ok = false;
        }
        return ret();
      case 45:
        this.keyFlag = false;
        if (this.timer) { this.req = 0; ok = false; }
        else { this.req = 28; this.target = null; }
        return ret();
      case 46:                                      // puddle splash finished
        this.req = 0;
        if (this.timer) ok = false;
        else { this._relocate(true); this.req = 27; } // no score, no mermaid
        this.keyFlag = false;
        return ret();
      case 47:
        if (this.req !== 48) { ok = false; this.req = 0; }
        return ret();
      case 48:                                      // alien fall finished
        if (this.timer) { this.keyFlag = false; this.req = 0; return false; }
        if (g.ufo) g.ufo.clearHole(this.col, this.row);   // cell back to type 1 (IDA:24748)
        this.onGrid = true;                          // vtable+44
        g.setSvenMode(4, 15000);                     // this[47] = 4, this[48] = now + 15 s
        this.req = 28;
        this._dogEvent(48);
        return ret();
      case 49:                                      // explosion finished
        if (this.timer) { this.req = 0; ok = false; }
        else {
          this._relocate(false);                     // sub_43473D(this, 0)
          this._clearMode();
          this.req = 28;
          g.onSvenExplodeDone();                     // sub_424CB8(49)
        }
        return ret();
      default:
        ok = false; return ret();
    }
  }

  // Fight cloud at the midpoint between Sven and his catcher (vtable+12 of
  // dword_49BB34 with (catcher.pos + sven.pos) / 2, IDA:24586-24660).
  // z (vtable+28): 2000 from the '%'/'&' resolve, else (cases 0x25-0x29)
  // max(catcher z (vtable+32), this[3]) + 2 (IDA:24606-24614, 24643-24651).
  _placeFight(byDog = this.caughtByDog, z) {
    const g = this.game;
    const by = byDog ? g.dogs[0] : g.shepherds[0];  // dword_49BB28 / dword_49BB2C
    const cp = by ? by.px : { x: this.px, y: this.py };
    this.fightX = Math.trunc((cp.x + this.px) / 2);
    this.fightY = Math.trunc((cp.y + this.py) / 2);
    if (z === undefined) {
      const cz = by ? g.entityDepth(by) : this.py;
      z = Math.max(cz, this.py) + 2;
    }
    this.fightZ = z;
  }

  //--- sub_43707B: state entry ----------------------------------------------
  _enter() {
    const dir = this.facing;
    const alien = this.mode === 4;
    const main = this.mainAnim, tbl = this.tableAnim;
    let timer = -1;
    switch (this.req) {
      case 27:                                      // blink after relocation
        this.cur = main;
        this._set(main, svenRec('SvenBlink', dir));
        main.visible = true;
        this.haloDir = dir;                          // off_495F30 (IDA:25140)
        if (alien) main.setRange(4, 2, 4); else main.setRange(4, 0, 2);
        this.haloHidden = false;
        timer = main.total();                        // 2*4/0.4f = 19 ticks
        break;
      case 28:
        this.cur = main;
        this._set(main, svenRec(alien ? 'AlienStand' : 'SvenStand', dir));
        this.haloDir = dir;                          // off_495F30 (IDA:25160)
        main.visible = true;
        this.haloHidden = false;
        break;
      case 29:
        this.cur = main;
        this._set(main, svenRec(alien ? 'AlienWalk' : 'SvenWalk', dir));
        this.haloDir = dir;                          // off_495F90 (IDA:25171)
        main.visible = true;
        if (this.mode === 2 || this.mode === 4) main.setSpeed(2.0 / SVEN_STEP_SCALE);
        else main.setSpeed((this.mode === 5 ? 0.5 : 1.0) / SVEN_STEP_SCALE);
        this.haloHidden = false;
        break;
      case 30: {                                    // cliff splash (on the current animator)
        const a = this.cur;
        this._set(a, svenRec('Splash'));
        a.ax += 55; a.ay += 37;                      // sub_401D89(..., x+55, y+37, 1)
        a.stopped = false; a.setRange(1, -1, -1);
        this.haloHidden = true;
        timer = a.total();                           // 14 ticks
        this._score(-2);
        this._audio('splash');                       // aSplash_1
        break;
      }
      case 31:                                      // whistle
        this.cur = tbl;
        tbl.setTable(SVEN_WHISTLE_TABLE);
        this._set(tbl, svenRec(alien ? 'AlienInvite' : 'SvenInvite', dir));
        tbl.stopped = false; tbl.setRange(1, 0, 0); tbl.setSpeed(1);
        timer = tbl.total();                         // 24 ticks
        this._audio('whistle');                      // aWhistle_0
        break;
      case 32: case 34: case 35:                    // sheep / dog draws the composite
        this.cur.visible = false; this.haloHidden = true;
        break;
      case 37: case 38: {
        this.cur = main;
        this.caughtByDog = this.req === 37;
        if (this.state === 29) {                    // unreachable: events set this[26] first
          this.req = 40;
          this._set(main, svenRec(alien ? 'AlienWalk' : 'SvenWalk', dir));
        } else {
          this.req = 39;
          this._set(main, svenRec(alien ? 'AlienStand' : 'SvenStand', dir));
        }
        this.haloDir = dir;                          // off_495F90 (IDA:25267)
        main.visible = true;
        main.setSpeed(this.mode === 2 || this.mode === 4 ? 2.0 : 1.0);
        this.fightZ = 2000;                          // vtable+28(2000) (IDA:25273)
        this._set(this.fight, svenRec('Fight'));
        this.fight.visible = true; this.fight.stopped = false;
        this.fight.setSpeed(1); this.fight.setRange(1, -1, -1);
        timer = this.fight.total();                  // 5 ticks
        this._audio('svenFight');                    // aSvenfight_1
        break;
      }
      case 41:
        this.cur.visible = false; this.haloHidden = true;
        this.fight.stopped = false; this.fight.setRange(11, -1, -1);
        timer = this.fight.total();                  // 55 ticks
        break;
      case 42:
        this.fight.visible = false;
        timer = 1;
        break;
      case 43: case 44: case 45:                    // electrocuted by a demon sheep
        this.cur = tbl;
        tbl.setTable(SVEN_ELECTRO_TABLE);
        this._set(tbl, svenRec('SvenElectro', dir));
        this.haloDir = dir;                          // off_495F30 (IDA:25313/25331/25349)
        tbl.visible = true;
        if (this.req === 43) { tbl.stopped = true; tbl.setRange(1, 0, 1); timer = -1000000; }
        else if (this.req === 44) { tbl.stopped = false; tbl.setRange(0, 1, 3); timer = -1000000; }
        else { tbl.stopped = false; tbl.setRange(1, 3, 0); timer = tbl.total(); }   // 19 ticks
        break;
      case 46: {                                    // puddle splash
        const a = this.cur;
        this._set(a, svenRec('Splash'));
        a.stopped = false; a.setRange(1, -1, -1);
        this.haloHidden = true;
        timer = a.total();
        this._audio('splash');                       // aSplash_2, no score change
        break;
      }
      case 47:                                      // IDA:25365-25370
        this.px += 1000; this.py -= 2000;            // x += 1000, y/z -= 2000 (halo follows, off-screen)
        this.cur.visible = false;                    // sub_40702E(this, 0) on this[6]
        break;
      case 48: {                                    // falls back as an alien
        const p = cellToScreen(this.col, this.row);
        this.px = p.x; this.py = p.y;                // vtable+16
        this.cur.visible = true;                     // sub_40702E(this, 1) on the old this[6]
        this.cur = tbl;
        tbl.setTable(SVEN_ALIENFALL_TABLE);
        this._set(tbl, svenRec('AlienFall', dir));
        tbl.stopped = false; tbl.setRange(1, 0, 7);
        timer = tbl.total() + 5;                     // 24 + 5 ticks
        this._audio('alienReturn');                  // aAlienreturn
        break;
      }
      case 49:                                      // time-out explosion
        this.cur = main;
        this._set(main, svenRec(alien ? 'AlienExplode' : 'SvenExplode'));
        main.visible = true;
        main.stopped = false; main.setRange(1, 0, 0);
        this.haloHidden = true;
        this._audio('bomb');                         // aBomb_0
        timer = main.total();                        // 14/0.5 = 28 ticks
        break;
    }
    this.timer = timer;
    this.state = this.req;
    this.req = 0;
  }

  //--- space: sub_43633C ----------------------------------------------------
  _sheepMay(sh) { return !!sh.canInteract(); }     // vtable+80: sheep sub_42FDC5, mermaid sub_419D10
  _sheepShagOk(sh) {                                // vtable+84: sheep sub_42CCBB, mermaid sub_419D50
    return !!sh && !!sh.canShag(this.mode);
  }
  _spaceAction() {
    if (!this.spaceLatch) return 28;
    const f = this._front(this.facing);
    const info = this._cell(f.col, f.row);
    const t = info.type;
    if ((t === 7 || t === 1) && info.sheep) {
      const sh = info.sheep;
      if (!this._sheepMay(sh)) return 28;
      if (sh.dir !== this.facing) return 31;        // misaligned → whistle
      this.target = sh; this.spaceLatch = false;
      if (this._sheepShagOk(sh)) {
        this._sheepEvent(sh, 32);
        this._shepEvent(32); this._dogEvent(32);
        return 32;
      }
      this._sheepEvent(sh, 34);                     // refused: sheep kicks (state 9)
      return 34;
    }
    if ((t === 7 || t === 1) && info.dog) {         // dog-shag (L>=6, map+8403, IDA:24907-24928)
      const dog = info.dog;
      const g = this.game;
      // dog half (state 50/56 with timer > 1, or 58): dog.canBeDogshagged
      if (dog.dir === this.facing && g.difficulty.wolfDefeat && dog.canBeDogshagged()) {
        this._dogEvent(35); this._shepEvent(35);
        this.spaceLatch = false;
        return 35;
      }
    }
    return 28;
  }

  //--- walking: sub_4367B3 / sub_43694C / sub_436DD1 ------------------------
  _turnOrWalk(dir) {
    if (this.state === 29 && this.stepTick) return this._reverse(dir);
    return this._walkTest(dir);
  }
  _sameZone(fc, fr, tc, tr) {                       // ((b3>>4)&3) equal and non-zero
    return this.game.mapInfo.isSameSpecialStep(fc, fr, tc, tr);
  }
  _walkTest(dir) {
    const f = this._front(dir);
    const info = this._cell(f.col, f.row);
    const t = info.type;
    if (((t === 7 || t === 1) && !info.occupied) || t === 3 || t === 5 || t === 6) {
      if (this._sameZone(this.col, this.row, f.col, f.row)) return 28;   // '_'→'_', '.'→'.', 'a'→'a'
      this.facing = dir;
      return 29;
    }
    if (t === 2 || t === 4) return 28;                  // wall / bush: no turn, no sound
    if ((t === 7 || t === 1) && info.sheep) { this.facing = dir; return 28; }
    if ((t === 7 || t === 1) && info.dog) { if (info.dog.dir === dir) this.facing = dir; return 28; }
    return 28;
  }
  // sub_436DD1. From the half-step on, the from-cell test (IDA:25070) always
  // sees Sven's own leaving bit (byte0 & 1, set by sub_419ECE, cleared only
  // at arrival), so it returns 29 and the `this[21] == v10/2` switch-back
  // is dead code: reversal only happens while stepTick < half.
  _reverse(dir) {
    if (dir === SVEN_OPPOSITE[this.facing]) {
      const v4 = this.stepTicks();
      if (this.stepTick >= (v4 >> 1)) return 29;
      this.facing = dir;
      this.stepTick = v4 - this.stepTick;
      let t = this.fromCol; this.fromCol = this.toCol; this.toCol = t;
      t = this.fromRow; this.fromRow = this.toRow; this.toRow = t;
    }
    return 29;                                      // other directions wait for arrival
  }
  _stepSetup() {                                    // sub_419ECE
    this.fromCol = this.col; this.fromRow = this.row;
    const f = this._front(this.facing);
    this.toCol = f.col; this.toRow = f.row;
  }
  _stepAdvance() {                                  // sub_41A0BA
    const v4 = this.stepTicks();
    const t = ++this.stepTick;
    const a = cellToScreen(this.fromCol, this.fromRow), b = cellToScreen(this.toCol, this.toRow);
    this.px = Math.trunc((t * b.x + (v4 - t) * a.x) / v4);
    this.py = Math.trunc(((v4 - t) * a.y + t * b.y) / v4);
    if (t === (v4 >> 1)) {                          // logical cell switches at the half-step
      this.col = this.toCol; this.row = this.toRow;
    } else if (t >= v4) {
      this.stepTick = 0;
      this._arrive();
    }
  }
  _arrive() {                                       // sub_43837E(cell, 1)
    const info = this._cell(this.col, this.row);
    if (info.type === 3) { this._push(30); return; }
    if (info.type === 5) { this._push(46); return; }
    if (info.type === 7) this.game.pickUpMushroomAt(this.col, this.row);   // sub_438C31
    this._push(28);
  }

  //--- sub_43473D: relocate (true = random 'a' cell, false = home) ---------
  _relocate(random) {
    const g = this.game;
    // vtable+48: Sven leaves the grid first, so the searches ignore him.
    this.onGrid = false;
    this.col = -1; this.row = -1; this.stepTick = 0;
    let col = this.homeCol, row = this.homeRow, dir = this.homeDir;
    if (random) {
      const d = g.svenRelocateCell();                // sub_425916 + sub_414E7D + rand()%4
      col = d.col; row = d.row; dir = d.facing;
    } else {
      const c = g.findFreeLandCell(col, row);         // sub_414E7D
      if (c) { col = c.col; row = c.row; }
    }
    this.col = col; this.row = row; this.facing = dir;
    const p = cellToScreen(col, row);                 // sub_41A40A
    this.px = p.x; this.py = p.y;
    this.fromCol = this.toCol = col; this.fromRow = this.toRow = row;
    this.cur.visible = true;
    this.onGrid = true;                               // vtable+44
    this.events = []; this.state = 0; this.req = 0; this.timer = 1;   // sub_4346DA
    this.keyIdx = -1;
  }

  //--- demo autopilot: sub_436173 (+200 set, title-timeout demo game) ------
  _demoTick() {
    if (this.stepTick) return false;
    if (this.state === 32) {
      this.spaceLatch = true;
      if (this.events[0] !== 33) return false;
      // +136 = bound VK of slot 4 (dword_49AFB8+36), 0 when unbound (IDA:24838).
      if (!(Math.floor(Math.random() * 32768) % 5)) { this._keyFlag = this._slotBound(4); this.keyIdx = 4; return true; }
    }
    let i = 0;
    for (; i <= 3; i++) {
      const f = this._front(i);
      const t = this._cell(f.col, f.row).type;
      if (t !== 2 && t !== 4) break;
    }
    if (i > 3) return false;
    const path = this._demoPath(10);
    if (!path.length) return false;
    const n = path[0];
    this.keyIdx = (n.depth || n.dir !== this.facing) ? n.dir : 4;
    this._keyFlag = this._slotBound(this.keyIdx);   // +136 = slot's VK (IDA:24816, 24821)
    return true;
  }
  // dword_49AFB8 slot VK != 0; Setup leaves a slot unbound (null) when its key
  // is rebound elsewhere (sub_427D74 IDA:18150-18155).
  _slotBound(i) { return this.game.keyBindings[i] != null; }
  // sub_4154B6(map, row, col, 10, list): breadth-first list of free cells
  // (depth <= 10, first step dir inherited) plus sheep reached from behind
  // (sheep.dir == step dir) scored by stamina (+116); free-cell entries are
  // then dropped and the rest stably sorted by stamina, lowest first.
  _demoPath(maxDepth) {
    const list = [];
    const step = (c, r, d) => ({ col: c + DIR_DELTA[d].dc, row: r + DIR_DELTA[d].dr });
    const look = (p, d) => {
      if (p.col === this.col && p.row === this.row) return null;   // Sven's own cell bit
      const info = this._cell(p.col, p.row);
      if (info.type !== 1 && info.type !== 7) return null;
      if (!info.occupied) return { free: true };
      const sh = info.sheep;
      if (sh && sh.dir === d && (sh.stamina | 0) > 0) return { free: false, score: sh.stamina | 0 };
      return null;
    };
    for (let k = 0; k <= 3; k++) {
      const p = step(this.col, this.row, k), o = look(p, k);
      if (!o) continue;
      list.push(o.free ? { col: p.col, row: p.row, depth: 1, dir: k, score: -1 }
                       : { col: p.col, row: p.row, depth: 0, dir: k, score: o.score });
    }
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      if (n.score > 0) continue;
      for (let m = 0; m <= 3; m++) {
        const p = step(n.col, n.row, m), o = look(p, m);
        if (!o) continue;
        if (o.free) {
          if (n.depth < maxDepth && !list.some(x => x.col === p.col && x.row === p.row))
            list.push({ col: p.col, row: p.row, depth: n.depth + 1, dir: n.dir, score: -1 });
        } else list.push({ col: p.col, row: p.row, depth: n.depth, dir: n.dir, score: o.score });
      }
    }
    return list.filter(n => n.score !== -1).sort((a, b) => a.score - b.score);
  }

  //--- draw: main sprite (sub_4384C0). The saint disc sub-sprite is drawn
  // by game.drawSaintHalo (reads hideHalo/screenPos). The fight cloud is a
  // separate depth-sorted object (`fightEntity`, z = fightZ).
  _blit(g, anim, x, y) {
    const sh = this._sheet(anim.image);
    if (!sh || !anim.visible) return;
    sh.drawFrame(g, anim.frame, x + anim.ax, y + anim.ay - sh.frameH, anim.flip);
  }
  draw(g) {
    this._blit(g, this.cur, this.px, this.py);
  }
}

// dword_49BB34: the fight cloud, its own scene-list object (sub_434443
// sub_467E51); sorted by its z (vtable+28) then x like every list object.
class SvenFightCloud {
  constructor(sven) { this.sven = sven; }
  get _depthY() { return this.sven.fightZ; }
  get _depthX() { return this.sven.fightX; }
  draw(g) {
    const s = this.sven;
    s._blit(g, s.fight, s.fightX, s.fightY);
  }
}
