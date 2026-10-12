//=== Shared mermaid/UFO helpers ============================================
// Owner: mermaid-ufo. Also used by ufo.js (loaded right after this file).

// Lazy sprite access by Library.ini name. Uses game.assets when preloaded,
// otherwise loads the sheet once from the Library.ini def (file,rows,cols,
// frames,chroma) into game.assets. Returns null until loaded.
const MU_PENDING = {};
function muSheet(game, name) {
  if (!game || !name) return null;
  const a = game.assets && game.assets[name];
  if (a) return a;
  const def = game.lib && game.lib.Images && game.lib.Images[name];
  if (!def || MU_PENDING[name] || typeof loadSprite !== 'function') return null;
  const [file, rows, cols, frames, , flip] = def.split(',');
  // 6th field = flipable (sub_40C99F → byte +44; sub_407FA2 mirrors only if set).
  MU_PENDING[name] = loadSprite(file.trim())
    .then(c => { game.assets[name] = new SpriteSheet(c, +rows, +cols, +frames,
                                                     +flip.trim()); })
    .catch(() => {});
  return null;
}
// Frame count from Library.ini (CImage +48), usable before the bitmap loads.
function muFrameCount(game, name) {
  const def = game && game.lib && game.lib.Images && game.lib.Images[name];
  return def ? (+def.split(',')[3] || 1) : 1;
}
// Unkeyed bitmap → canvas (for blits that use their own key logic). The
// sprite PNGs have the colour key baked in as alpha, so the unkeyed originals
// of the bitmaps read this way ship separately as assets/raw/<name>.png.
const MU_RAW = {};
function muRawImage(file) {
  if (MU_RAW[file]) return MU_RAW[file].canvas;
  MU_RAW[file] = { canvas: null };
  const img = new Image();
  img.src = ASSETS + 'raw/' + encodeURIComponent(file.replace(/\.bmp$/i, '.png'));
  img.decode().then(() => {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    MU_RAW[file].canvas = c;
  }).catch(() => {});
  return null;
}

// CImageSeq (sub_401950, 0x38 bytes). One advance per DRAWN tick: the
// original advances inside the draw call (sub_401BDE → vtable+28) after
// blitting, so `tickDraw()` snapshots the shown frame then advances; render
// draws `shown`. Fields: count +8, start +20, end +24, loops +28, frame +32,
// paused +36, visible +37, speed +40 (float), pos +44 (float).
class MuSeq {
  constructor() {
    this.name = null; this.count = 0; this.start = 0; this.end = 0; this.loops = 0;
    this.frame = -1; this.pos = -1; this.paused = true; this.visible = false;
    this.speed = 1; this.dx = 0; this.dy = 0; this.flip = false;
    this.shown = -1; this.table = null; this.idx = 0; this.cnt = 0;
  }
  // sub_40709A: image + speed reset only when the image changes (sub_401B62);
  // flip and mode-2 offsets always.
  setRecord(game, rec) {
    if (this.name !== rec.name) {
      this.name = rec.name;
      this.count = muFrameCount(game, rec.name);
      this.start = 0; this.end = this.count; this.loops = 0;
      this.frame = 0; this.pos = 0; this.paused = false; this.visible = true;
      this.speed = Math.fround(this.table ? 1 : rec.speed);   // sub_41C780 forces 1.0
      muSheet(game, rec.name);
    }
    this.flip = !!rec.flip; this.dx = rec.dx; this.dy = rec.dy;
  }
  setSpeed(s) { this.speed = Math.fround(s); }            // vtable+20 (sub_401FF0)
  // vtable+24: sub_401EBD (plain) / sub_41C6B9 (frame table).
  setRange(loops, start, end) {
    const n = this.table ? this.table.length : this.count;
    if (start >= 0) this.start = start >= n ? 0 : start;
    if (end) { if (end > 0) this.end = end >= n ? n : end; } else this.end = n;
    if (loops >= 0) this.loops = loops;
    if (this.table) { this.idx = this.start; this.frame = this.table[this.idx][0]; }
    else { this.frame = this.start; this.pos = Math.fround(this.frame); }
    return this.frame;
  }
  // vtable+16: sub_401FB0 (plain) / sub_41C760 (frame table) — length in ticks.
  length() {
    if (this.table) {
      let s = 0;
      if (this.start >= this.end) {
        for (let i = this.start; i < this.table.length; i++) s += this.table[i][1];
        for (let j = 0; j < this.end; j++) s += this.table[j][1];
      } else for (let k = this.start; k < this.end; k++) s += this.table[k][1];
      return this.loops * s;
    }
    const range = this.end <= this.start ? this.end + this.count - this.start : this.end - this.start;
    return Math.trunc(range * this.loops / this.speed);
  }
  // vtable+28: sub_401C8E (plain) / sub_41C4ED (frame table).
  advance() {
    if (this.paused) return;
    if (this.table) {
      const e = this.table[this.idx];
      if (++this.cnt === e[1]) {
        ++this.idx;
        if (this.end <= this.start && this.idx === this.table.length) this.idx = 0;
        if (this.idx === this.end) { if (--this.loops) this.idx = this.start; else this.paused = true; }
        this.cnt = 0;
        // When the pass ends (paused) idx = 5 reads past unk_493AC0 in the
        // original; that frame is never drawn (23 → 24 → 22 switches `cur`).
        this.frame = this.table[this.idx]?.[0];
      }
      return;
    }
    // fld/fadd/fst/_ftol (0x401CB4-0x401CC2): trunc the unrounded x87 sum;
    // only v5 is stored as float (IDA:474-477).
    const v2 = this.pos + this.speed;
    let v4 = Math.trunc(v2);
    const frac = Math.fround(Math.fround(v2) - v4);
    const range = this.end <= this.start ? this.end + this.count - this.start : this.end - this.start;
    let wrapped = false;
    if (this.end <= this.start) {
      if (v4 >= this.count) { wrapped = true; do v4 -= range; while (v4 >= this.end + this.count); }
    } else if (v4 >= this.end) {
      wrapped = true; do v4 -= range; while (v4 >= this.end);
    }
    if (wrapped && !--this.loops) this.paused = true;
    this.frame = v4;
    this.pos = Math.fround(v4 + frac);
  }
  // sub_401BDE minus the blit: remember the frame shown this tick, then advance.
  tickDraw() { this.shown = this.frame; this.advance(); }
  frameH(game) { const s = muSheet(game, this.name); return s ? s.frameH : 0; }
  // Render: mode-2 anchor (x+dx, y+dy-frameH) (sub_401D89 case 2).
  draw(g, game, x, y) {
    if (!this.visible || !this.name || this.shown < 0) return;
    const s = muSheet(game, this.name);
    if (!s) return;
    s.drawFrame(g, this.shown, x + this.dx, y + this.dy - s.frameH, this.flip);
  }
}

//=== In-game Mermaid (CMermaid) ============================================
// Ctor sub_418F20 (IDA:10932) on the CSheep base sub_42A9F7(dir 3);
// vtable off_473B3C: +36 tick sub_41902E, +40 init sub_418F8F, +80
// catchable sub_419D10, +96 event sub_419B80, +100 sub_42EB56, +104
// sub_419C12 (= 5). Created only when level >= 3 (+8400, IDA:8958-8977).
// Woken ONLY by Sven's drown handler (sub_434A6A case 0x1E → sub_419C24,
// IDA:24409-24410). State numbers are the original this[36] values.
const MERM_STATE = Object.freeze({
  DORMANT:  0,   // inactive (byte +196 = 0) or waiting/searching after wake
  HOLD:    10,   // catch stage >= 3: waits 4×20 ticks for stage 7
  DONE:    11,   // Sheep_exploding (completed catch)
  GONE:    12,   // → hide, inactive
  EMERGE:  21,   // mermaidJump, 12 ticks
  VISIBLE: 22,   // mermaidStand idle, catchable
  PASS:    23,   // mermaidFuck pass (frame table unk_493AC0)
  PASS_END:24,   // 1 tick, catchable, → 22
  DIVE:    26,   // mermaidExplode, 28 ticks (visible timeout)
});
// Sprite records off_493A60..off_493AE8 (read from Sven.exe .data).
const MERM_REC_TBL = {
  stand:      { name: 'mermaidStand',      dx: -40, dy: 21, flip: 0, speed: 1 },    // off_493A60
  jump:       { name: 'mermaidJump',       dx: -44, dy: 45, flip: 0, speed: 1 },    // off_493A78
  pass:       { name: 'mermaidFuck',       dx: -48, dy: 28, flip: 0, speed: 1 },    // off_493A90
  alienPass:  { name: 'Alien_mermaidfuck', dx: -48, dy: 28, flip: 0, speed: 1 },    // off_493AA8
  explode:    { name: 'mermaidExplode',    dx: -65, dy: 18, flip: 0, speed: 0.5 },  // off_493AE8
  exploding:  { name: 'Sheep_exploding',   dx: -65, dy: 18, flip: 0, speed: 1 },    // off_494928
  symbol:     { name: 'Symbols',           dx: 2,   dy: -25, flip: 0, speed: 1 },   // off_4947A8[3]
};
const MERM_REC = (() => {
  if (typeof spriteRecord !== 'function') return MERM_REC_TBL;
  const map = { stand: ['MermaidStand', 0], jump: ['MermaidJump', 0], pass: ['MermaidFuck', 0],
    alienPass: ['AlienMermaidFuck', 0], explode: ['MermaidExplode', 0], exploding: ['SheepExploding', 0],
    symbol: ['SheepSymbols', 3] };
  const out = {};
  for (const k in map) {
    const r = spriteRecord(map[k][0], map[k][1]);
    out[k] = r && r.sprite ? { name: r.sprite, dx: r.dx, dy: r.dy, flip: r.flip ? 1 : 0, speed: r.speed } : MERM_REC_TBL[k];
  }
  return out;
})();
// Pass frame table unk_493AC0: (frame, ticks).
const MERM_PASS_TABLE = [[0, 3], [1, 1], [2, 2], [3, 1], [4, 1]];
const MERM_WAKE_TICKS = 80;      // sub_419C24 IDA:11310
const MERM_RETRY_TICKS = 5;      // no shore cell, IDA:11064
const MERM_VISIBLE_TICKS = 120;  // IDA:11094
const MERM_DEADBEEF = -559038737;

class Mermaid {
  constructor(mapInfo) {
    this.mapInfo = mapInfo;
    this.col = -1; this.row = -1;
    this.dir = 3;                 // sub_42A9F7(3, …)
    this.active = false;          // +196
    this.state = 0;               // this[36]
    this.req = 0;                 // this[38]
    this.timer = 1;               // this[45] (sub_42AE1B)
    this.p29 = 0;                 // +116 stamina (set at level build); read as `stamina`
    this.mood30 = -1;             // +120
    this.stage31 = 0;             // +124
    this.c184 = -1;               // +184 stage countdown
    this.vis200 = -1;             // +200 visible timeout
    this.flags128 = 0;            // bit 2 never set for the mermaid
    this.flag148 = 0;             // byte +148 bit 0
    this.visible = false;         // sub_40702E
    this.onGrid = false;          // present bits / byte +44
    this._placed = false;         // setPos not yet called: z 0, x -2147483647 (sub_406EB8)
    this.cellIncoming = false;    // incoming bit from spawn
    this.body = new MuSeq();      // +32 plain seq
    this.tableSeq = new MuSeq();  // +36 frame-table seq (sub_41C480)
    this.tableSeq.table = MERM_PASS_TABLE;
    this.cur = this.body;         // +24
    this.sym = new MuSeq();       // +104 mood symbol
    this.symShown = false;
    const game = mapInfo && mapInfo._game;
    for (const k in MERM_REC) muSheet(game, MERM_REC[k].name);
  }
  _sheepCount(game) { return game.sheepCount; }     // dword_49BA24
  get _game() { return this.mapInfo && this.mapInfo._game; }

  // Level build part: sub_42ABDF (IDA:19724-19733) then sub_418F8F. Called
  // from the GAME_LEVEL_HOOKS entry below (sheep count known by then).
  onLevelBuilt(game) {
    const n = this._sheepCount(game);                // dword_49BA24
    const v15 = n >= 30 ? 2400 : Math.trunc((2400 * n + 600 * (30 - n)) / 30);
    this.p29 = Math.floor(Math.random() * 32768) % (3000 - v15) + v15;
    game.pool += this.p29;                           // dword_49BA20 += this[29]
    this.sym.setRecord(game, MERM_REC.symbol);
    this._mood(game, 1);
    this.cur = this.body;
    this.body.setRecord(game, MERM_REC.jump);        // sub_418F8F
    this.body.paused = true;
    this.active = false;
    this.visible = false;
    this.vis200 = -1;
  }

  // sub_419C24: wake (only from Sven's drown, only if inactive).
  onSvenDrowned() {
    if (this.active) return;
    this.active = true;
    this.state = 0; this.req = 0;
    this.vis200 = -1;
    this.timer = MERM_WAKE_TICKS;
  }

  // sub_419D10 (vtable+80).
  isCatchable() { return this.state === 22 || this.state === 24; }
  // sub_419B80 (vtable+96): Sven events. 32 = catch pass; 29/37/38 abort pass.
  onEvent(ev) {
    if (this.req) return true;
    switch (ev) {
      case 29: case 37: case 38:
        if (this.state === 23) this.req = 22;
        return true;
      case 31: return true;
      case 32: this.req = 23; return true;
      default: return false;
    }
  }
  // sub_419C12 (vtable+104): +5 per pass in every mode.
  scoreValue() { return 5; }
  // Sven-side names (sven.js, same as CSheep): vt+80, vt+84 (sub_419D50
  // returns 1), vt+96.
  canInteract() { return this.isCatchable(); }
  canShag() { return true; }
  svenEvent(code) { return this.onEvent(code); }

  // Cell occupancy (sub_429C3C at spawn .. vtable+48 at 11/26).
  // Spawn sets the incoming bit (sub_429C3C(15,1) → byte1 0x10); emerge end
  // sets present (vtable+52 sub_42FE7B → sub_429D24(type 4, 1)); vtable+48
  // (sub_41A353) clears both at 11/26 entry. The mermaid never steps.
  occupancyAt(col, row) {
    const here = this.col === col && this.row === row;
    return { present: here && this.onGrid, incoming: here && this.cellIncoming, leaving: false };
  }
  // Sort keys: z = vt+32 (this[3]), x = vt+20 (this[4]). Before the first
  // shore pick these are the base-ctor values (sub_406EB8: z 0, x
  // -2147483647); setPos sub_419CA0 then sets z = y (case 0, IDA:11058).
  depthY() { return this._placed ? cellToScreen(this.col, this.row).y : 0; }
  get _depthX() { return this._placed ? cellToScreen(this.col, this.row).x : -2147483647; }
  // Drawn (sub_407058 visible flag). game.js uses this for the draw list.
  isOnField() { return this.active && this.visible; }
  // CSheep +116 as read by the demo path search sub_4154B6 (IDA:9677, 9757).
  get stamina() { return this.p29; }

  // sub_414C53: water cell (byte3&0xF == 3) at original (r,c), r = Rows-1..1,
  // c = Cols-1..0 (1-based grid; Rows = 13 incl. the empty appended row, so
  // r = 12 is terrain Row11 and the empty row is never scanned);
  // candidate = cell one row up, type 1 or 7, cell bytes 0-2 all zero.
  shoreCandidates(game) {
    const m = this.mapInfo;
    const list = [];
    for (let r = m.rows - 1; r > 0; --r) {
      for (let c = m.cols - 1; c >= 0; --c) {
        const R = r - 1, C = c - 1;                  // JS 0-based water cell
        if (R < 0 || C < 0 || m.terrain[R][C] !== 'c') continue;
        const ar = R - 1;
        if (ar < 0) continue;
        const ch = m.terrain[ar][C];
        if (ch !== ' ' && ch !== '_' && ch !== '.' && ch !== 'a') continue;
        if (game.ufo && game.ufo.isHole(C, ar)) continue;   // type 6
        if (this._cellBusy(game, C, ar)) continue;
        list.push({ col: C, row: ar });
      }
    }
    return list;
  }
  _cellBusy(game, col, row) {
    const b = npcCellBits(game, col, row, this);
    return !!(b.b0 | b.b1 | b.b2);
  }

  // Tick: sub_41902E (IDA:10963). `dt` ignored (one call = one 20 Hz tick).
  update() {
    const game = this._game;
    if (!this.active || !game) return;
    if (!(this.flags128 & 2) && this.state !== 6 && --this.p29 >= 0) game.pool -= 1;   // --dword_49BA20
    if (this.c184 > 0) { this.timer = this.c184--; this.vis200 = -1; }
    if (this.c184 === 0) {
      this.vis200 = -1;
      if (++this.stage31 < 7) { this.c184 = 20; this.timer = this.c184 + 1; }
      else this.req = 11;
    }
    if (this.vis200 > 0) --this.vis200;
    if (this.vis200 === 0) { this.req = 26; this.timer = 1; }
    --this.timer;
    let v7 = false;
    if (this.req || !this.timer) v7 = this._decide(game);
    if (v7) this._enter(game);
    // Draw point: body (if visible), mood update, symbol in 10/22..24.
    if (this.visible) this.cur.tickDraw();
    this._mood(game, 0);
    this.symShown = this.state === 10 || (this.state > 21 && this.state <= 24);
    if (this.symShown) this.sym.tickDraw();
  }

  // sub_438585(code, this): tell Sven (pass done → 33 / 28; 11, 26 end his catch).
  _notifySven(game, code) {
    const s = game.sven;
    if (s) s.onSheepEvent(code, this);
  }

  // sub_419295 (IDA:11021).
  _decide(game) {
    const st = this.state, rq = this.req;
    if (!((rq !== 11 || st === 11 || st === 12) && (rq !== 26 || st === 26 || st === 12))) {
      this._notifySven(game, rq);
      return true;
    }
    switch (st) {
      case 0: {
        const cands = this.shoreCandidates(game);
        if (cands.length) {
          const p = cands[Math.floor(Math.random() * 32768) % cands.length];
          this.col = p.col; this.row = p.row;
          this._placed = true;                          // vt+16 setPos (sub_419CA0)
          this.cellIncoming = true;                     // sub_429C3C(15, 1)
          this.visible = true;                          // sub_40702E(this, 1)
          this.req = 21;
          return true;
        }
        this.req = 0;
        this.timer = MERM_RETRY_TICKS;
        return false;
      }
      case 10:
        this.req = 0;
        return false;
      case 11:
        if (!this.timer) {
          this.req = 12;
          this.flag148 &= ~1;
          if (this.c184 === MERM_DEADBEEF) {
            this.c184 = -1;
            const n = this._sheepCount(game);
            const v3 = n >= 30 ? 2400 : Math.trunc((2400 * n + 600 * (30 - n)) / 30);
            this.p29 = Math.floor(Math.random() * 32768) % (3000 - v3) + v3;
            game.pool += this.p29;
            this.mood30 = -1;
            this.stage31 = -1;
            this._mood(game, 0);
            this._completed(game);                      // sub_424E7D(scene, 25)
          }
          return true;
        }
        this.req = 0;
        return false;
      case 21:
        this.req = 22;
        this.vis200 = MERM_VISIBLE_TICKS;
        this.onGrid = true;                             // byte +44 = 1, present bits (vtable+52)
        // Runtime item on her cell (type 7) is destroyed (IDA:11095-11102).
        if (game.mushroomAt(this.col, this.row)) game.destroyMushroomAt(this.col, this.row);
        return true;
      case 22:
        if (this.req === 23) return true;
        if (this.req !== 2) return true;
        this.req = 0; this.p29 = 100; this._mood(game, 0);
        return false;
      case 23:
        if (!this.req) {
          this._pass(game);                             // vtable+100 = sub_42EB56
          this.timer = -1000000;
          if (this.stage31 < 3) { this._notifySven(game, 24); this.req = 24; }
          else { this._notifySven(game, 10); this.req = 10; }
        }
        return true;
      case 24:
        if (!this.req) {
          this.req = 22;
          if (!(this.flag148 & 1)) this.flag148 |= 1;
        }
        return true;
      case 26:
        if (this.timer) { this.req = 0; return false; }
        this.req = 12;
        this.flag148 &= ~1;
        return true;
      default:
        return true;
    }
  }

  // sub_419825 (IDA:11168).
  _enter(game) {
    switch (this.req) {
      case 10: case 22:
        this.cur = this.body;
        this.body.setRecord(game, MERM_REC.stand);
        this.body.paused = true;
        this.body.setRange(1, 0, 1);
        this.sym.visible = true;
        this.timer = -1;
        break;
      case 11:
        this.onGrid = false; this.cellIncoming = false; // vtable+48
        this.cur = this.body;
        this.body.setRecord(game, MERM_REC.exploding);
        this.c184 = MERM_DEADBEEF;
        this.body.paused = false;
        this.body.setRange(1, -1, -1);
        this.timer = this.body.length();
        // dword_49BA40 = ExplodingSheep (assigned IDA:21488-21523), +28(0,0) = play.
        if (game.audio) game.audio.play('sheepExplode');
        break;
      case 12:
        this.visible = false;                           // sub_40702E(this, 0)
        this.state = 0;
        this.active = false;
        return false;
      case 21:
        this.cur.setRecord(game, MERM_REC.jump);
        this.cur.paused = false;
        this.cur.setRange(1, -1, -1);
        this.timer = this.cur.length();                 // 12 ticks
        break;
      case 23: {
        const t = this.tableSeq;
        this.cur = t;
        t.idx = 0; t.start = 0; t.end = MERM_PASS_TABLE.length; t.cnt = 0;
        t.frame = MERM_PASS_TABLE[0][0];
        t.setRecord(game, this._svenMode(game) === 4 ? MERM_REC.alienPass : MERM_REC.pass);
        t.paused = false;
        t.setRange(1, -1, -1);
        this.timer = t.length() - 1;                    // 8 - 1
        break;
      }
      case 24:
        this.timer = 1;
        break;
      case 26:
        this.onGrid = false; this.cellIncoming = false; // vtable+48
        this.cur = this.body;
        this.body.setRecord(game, MERM_REC.explode);
        this.vis200 = MERM_DEADBEEF;
        this.body.paused = false;
        this.body.setRange(1, -1, -1);
        this.timer = this.body.length();                // 14 / 0.5 = 28
        break;
    }
    this.state = this.req;
    this.req = 0;
    return true;
  }

  // Sven +188 mode (1 normal, 2/3/5 mushrooms, 4 alien).
  _svenMode(game) { return game.svenMode; }
  _moodOf(p) { return p > 0 ? Math.trunc(10 * p / 3000) + 1 : Math.trunc(-10 * p / -3000); }

  // sub_42EB56 (vtable+100), one completed pass.
  _pass(game) {
    const mode = this._svenMode(game);
    game.addScore(this.scoreValue(mode));             // sub_42A2CB(vtable+104) = +5
    const v4 = this.stage31;
    if (v4) {
      if (v4 === 1) {
        if (mode < 2 || mode > 3) this.stage31++;
        else { this.stage31 = 3; this.c184 = 20; }
      } else if (v4 === 2) {
        this.stage31++; this.c184 = 20;
      }
      return;
    }
    this._stamina(game, mode);                          // sub_42ED53
    if (this._moodOf(this.p29) >= 10) {
      if (mode === 4) { this.stage31 = 3; this.c184 = 20; }
      else this.stage31 = 1;
      game.recordCatch(this);                         // sub_425311
      // dword_49BA18 score_table anim: +36 = 0, setRange(1,1,1) (IDA:21637-21642).
      if (game.startScoreTableFlash) game.startScoreTableFlash();
    }
  }
  // sub_42ED53.
  _stamina(game, mode) {
    let v3 = this.p29;
    switch (mode) {
      case 1: case 5: v3 += 600; break;
      case 2: v3 += 1200; break;
      case 3:
        if (this.mood30 > 0) {
          v3 = 3000;
          if (this.mood30 >= 10) { this.stage31 = 3; this.c184 = 20; }
        } else v3 = 600;
        break;
      case 4: v3 = 3000; break;
    }
    if (v3 > 3000) v3 = 3000;
    game.pool += v3 - this.p29;
    if (game.pool > game.poolMax) game.pool = game.poolMax;
    this.p29 = v3;
  }
  // sub_424E7D case 25 (IDA:16726-16729): +10 and 3 random mushrooms.
  _completed(game) {
    game.queueMushroomSpawn(3);
    game.addScore(10);
  }

  // sub_42D08E (mood symbol), the base-class routine as reached by CMermaid.
  _mood(game, a2) {
    if (this.flags128 & 2) return;
    const old = this.mood30;
    const v27 = this.stage31 < 3 ? this._moodOf(this.p29) : this.stage31 + 10;
    if (v27 === this.mood30) return;
    this.mood30 = v27;
    if (this.mood30 < 10) this.stage31 = 0;
    const s = this.sym, au = game.audio;
    // Cases 1/2 also push action 2 into the CSheep queue (vtable+88 =
    // sub_43006C); CMermaid never drains that queue, so it has no effect.
    switch (v27) {
      case -3: this.p29 = 0; break;
      case -1: {
        s.paused = false; s.setRange(0, 12, 14); s.setSpeed(0.1);
        const v3 = Math.floor(Math.random() * 32768) % 2;
        const len = s.end <= s.start ? s.end + s.count - s.start : s.end - s.start;
        this.p29 = Math.trunc(len / s.speed) * (v3 + 1) - 600;
        this.mood30 = this._moodOf(this.p29);
        break;
      }
      case 0:
        s.paused = false; s.setRange(0, 11, 13); s.frame = 13; s.pos = 13; s.setSpeed(0.1);
        this.p29 = 1 - (300 - Math.floor(Math.random() * 32768) % 100);
        break;
      case 1:
        s.paused = false; s.setRange(0, 11, 13); s.frame = 13; s.pos = 13; s.setSpeed(0.1);
        if (au && au.playMeeThrottled) au.playMeeThrottled();
        break;
      case 2:
        s.paused = false; s.setRange(0, 9, 11); s.setSpeed(0.2);
        if (au && au.playMeeThrottled) au.playMeeThrottled();
        break;
      case 3: s.paused = false; s.setRange(0, 9, 11); s.setSpeed(0.1); break;
      case 4: case 5: case 6: s.paused = false; s.setRange(0, 6, 9); s.setSpeed(0.1); break;
      case 7: s.paused = true; s.setRange(1, 5, 6); s.setSpeed(1); break;
      case 8: s.paused = true; s.setRange(1, 4, 5); s.setSpeed(1); break;
      case 9: s.paused = true; s.setRange(1, 3, 4); s.setSpeed(1); break;
      case 11: case 12:
        if (!a2 && v27 > old && au && au.playHappy) au.playHappy();
        // fallthrough
      case 10: s.paused = false; s.setRange(0, 0, 3); s.setSpeed(0.1); break;
      case 13: s.paused = false; s.setRange(1, 14, 20); s.setSpeed(0.25); break;
      case 14: s.paused = false; s.setRange(0, 18, 20); s.setSpeed(0.25); break;
      case 15: case 16: s.setSpeed(0.25); break;
      case 17: s.visible = false; break;
    }
  }

  draw(g) {
    const game = this._game;
    if (!this.active || !this.visible || !game) return;
    const p = cellToScreen(this.col, this.row);
    this.cur.draw(g, game, p.x, p.y);
    if (this.symShown) this.sym.draw(g, game, p.x, p.y);
  }
}

// Mermaid init (sub_42ABDF + sub_418F8F) runs after the sheep in the map
// loader (IDA:8958 > 8848), so its stamina must be added after the sheep
// area's level hook resets the pool: register at Game construction, when
// every script's top-level GAME_LEVEL_HOOKS pushes are already in.
let MERM_HOOKED = false;
GAME_INIT_HOOKS.push(function () {
  if (MERM_HOOKED) return;
  MERM_HOOKED = true;
  GAME_LEVEL_HOOKS.push(function () { if (this.mermaid) this.mermaid.onLevelBuilt(this); });
});
