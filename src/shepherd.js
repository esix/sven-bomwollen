//=== Shepherd ("Guy" sprites; CShepherd, vtable off_474108) =================
// Port of the original state machine. One update() call = one 20 Hz tick.
//   ctor sub_4302B0 / state reset sub_430591 / reset-to-home sub_4305F4
//   tick sub_4306AF → transitions sub_430897 → state entry sub_431E09
//   events sub_43217A, self-push sub_4322C1, wander sub_431193,
//   chase step sub_431636, footsteps sub_43204C, cell enter sub_43209B,
//   step length sub_432330 (dword_4954B8 = 16 ticks).
// Fields: state +104, req +108, queue +112.. (count +132), timer +136,
// home +140/+144/+148, hiddenFlag byte +152, caughtSven byte +153.
const SHEP_STATE = Object.freeze({
  INIT: 0,
  STAND: 63,    // Guy_Stand, timer rand()%70+100
  WANDER: 64,   // Guy_Walk, (140L/40+140)/16 steps
  CHASE: 65,    // Guy_Walk toward Sven, no timer (ends when blocked or on a catch)
  YELL: 66,     // Guy_WalkBack2/Front2 once + ShepherdYell (event 28)
  HIDDEN: 68,   // catcher hidden during Sven's fight anim (event 41)
});
const SHEP_STEP_TICKS = 16;   // dword_4954B8

class Shepherd {
  constructor(col, row, game) {
    this.col = col;
    this.row = row;
    this.dir = DIR.SE;              // sub_41467C passes dir 3
    this.homeCol = col;             // +140/+144/+148 (IDA:22296-22298)
    this.homeRow = row;
    this.homeDir = this.dir;
    this.game = game;
    this.anim = new NpcAnim();
    this.drawFrame = 0;
    this.onGrid = true;
    this.hiddenFlag = false;        // +152
    this.caughtSven = false;        // +153
    this._resetState();
    this._place();
  }

  // sub_430591: empty queue, state 0, req 0, timer 1.
  _resetState() {
    this.queue = [];
    this.state = 0;
    this.req = 0;
    this.timer = 1;
  }

  _push(v) {                                   // LABEL_13 / sub_4322C1
    if (this.queue.length >= 5) return;
    if (!this.queue.length || this.queue[this.queue.length - 1] !== v) this.queue.push(v);
  }
  // sub_43217A. Codes: 28 mild alert (yell), 32 shag press / 35 dogshag
  // (chase), 41 hide catcher, 42 reset.
  event(code) {
    if (this.queue.length >= 5) return true;
    switch (code) {
      case 28:
        this._push(66);
        return true;
      case 32:
      case 35:
        if (this.caughtSven) return false;
        this._push(65);
        return true;
      case 41:
        if (!this.caughtSven) return false;
        this.queue = [68];
        this.timer = 1;
        return true;
      case 42:
        this.resetToHome();
        return false;
      default:
        return false;
    }
  }

  // Event 42 → vtable+48 (off grid) + vtable+80 sub_4305F4.
  resetToHome() {
    const game = this.game;
    this.onGrid = false;
    this.col = this.homeCol; this.row = this.homeRow; this.dir = this.homeDir;
    const c = game.findFreeLandCell(this.col, this.row);          // sub_414E7D
    if (c) { this.col = c.col; this.row = c.row; }
    this._place();                  // sub_41A40A
    this.onGrid = true;             // vtable+44
    this.visible = true;            // sprite +37 = 1
    this._resetState();             // sub_430591
  }

  _svenEvent(game, code) {
    game.npcToSven(code, this);
  }

  //--- per tick (sub_4306AF) -------------------------------------------------
  update() {
    const game = this.game;
    if (this.queue.length && this.queue[0] === 68) {
      this.hiddenFlag = true;
      this.caughtSven = false;
      this.req = 68;
      this._enter(game);
      this.queue = [];
    } else if (this.stepTick === 0) {
      if (this.timer) this.timer--;
      if (this.queue.length) {
        const q = this.queue;
        this.queue = [];
        let any = false, last = 0;
        for (const ev of q) {
          this.req = ev;
          // The shepherd keeps the new state (unlike the dog), so the
          // entry below sees it as its previous state (IDA:22476-22486).
          if (this._transition(game)) { any = true; last = this.req; this.state = last; }
        }
        if (any) { this.req = last; this._enter(game); }
      } else if (this._transition(game)) {
        this._enter(game);
      }
    }
    if (this.state === 65 || this.state === 64) {
      if (this.stepTick === 0) this._startStep();               // vtable+64
      this._stepSfx(game);                                      // vtable+68 sub_43204C
    }
    this.drawFrame = this.anim.frame;
    this.anim.advance();
  }

  _stepLen() { return SHEP_STEP_TICKS; }                        // sub_432330

  _stepSfx(game) {                                              // sub_43204C
    this._advanceStep(game);
    const f = this.anim.frame;
    if (f === 1) game.audio.play('shepwalk1');
    else if (f === 9) game.audio.play('shepwalk2');
  }

  // sub_43209B: at step end, Sven present in the new cell → self-push 67.
  _onCellEnter(game, end) {
    if (!end || !npcIsLand(game, this.col, this.row)) return;
    const bits = npcCellBits(game, this.col, this.row, this);
    if (bits.b2 & CELL_SVEN) {
      this._push(67);
      this.caughtSven = true;
    }
  }

  //--- step choices ----------------------------------------------------------
  _svenStateBlocks(game) {
    const s = npcSvenState(game);
    return s === 39 || s === 40 || s === 41 || s === 42;
  }
  // sub_431636: step toward Sven. Returns 65, or 63 when stuck / on a catch.
  _chaseStep(game) {
    const svenOk = bits => !npcSaintActive(game) && npcSvenMode(game) !== 4
      && npcSvenState(game) !== 48 && !this._svenStateBlocks(game)
      && !(bits.b1 & CELL_DOG) && !(bits.b1 & CELL_TYPE8);
    let fallback = -1, dir = -1;
    for (const d of npcTowardDirs(this, game.sven)) {
      const c = npcCandidate(game, this, d, svenOk);
      if (!c) continue;
      if (c.col !== this.prevCol || c.row !== this.prevRow) { dir = d; break; }
      fallback = d;
    }
    if (dir === -1) {
      if (fallback === -1) return 63;
      dir = fallback;
    }
    this.dir = dir;
    // Catch test on the chosen cell (IDA:22900-22924).
    const dd = DIR_DELTA[dir];
    const tc = this.col + dd.dc, tr = this.row + dd.dr;
    const bits = npcCellBits(game, tc, tr, this);
    if (!(npcIsLand(game, tc, tr) && ((bits.b2 & CELL_SVEN) || (bits.b1 & CELL_SVEN)))) return 65;
    if (this.caughtSven || npcSaintActive(game)) return 65;
    if (this._svenStateBlocks(game)) return 65;
    if (bits.b1 & CELL_DOG) return 65;
    if (bits.b1 & CELL_TYPE8) return 65;
    this._svenEvent(game, 67);      // sub_438818(67) on Sven
    this.caughtSven = true;
    return 63;
  }
  // sub_431193: weighted wander over [d, d-1, d+1, opposite].
  _wanderStep(game) {
    const svenOk = bits => !(npcSaintActive(game) || npcSvenMode(game) === 4 || npcSvenState(game) === 48)
      && !(bits.b1 & CELL_DOG) && !(bits.b1 & CELL_TYPE8);
    const d = this.dir;
    const valid = [d, npcPrev(d), npcNext(d), npcOpp(d)].filter(c => npcCandidate(game, this, c, svenOk));
    const r = npcRand(100);
    let i;
    switch (valid.length) {
      case 1: i = 0; break;
      case 2: i = r >= 95 ? 1 : 0; break;
      case 3: i = r < 45 ? 0 : r < 90 ? 1 : 2; break;
      case 4: i = r < 75 ? 0 : r < 85 ? 1 : r < 95 ? 2 : 3; break;
      default: return 63;
    }
    this.dir = valid[i];
    return 64;
  }

  //--- transitions (sub_430897) ---------------------------------------------
  _transition(game) {
    let ok = true;
    const own = () => npcOwnCellHasSven(game, this);
    const done = () => {                                         // LABEL_131
      if (this.req === 66) this.timer = -1000000;
      return ok;
    };
    const chaseReset = () => {                                   // LABEL_51
      this.prevCol = -1; this.prevRow = -1;
      this.req = this._chaseStep(game);
    };
    const catchHere = () => {                                    // LABEL_49
      this._svenEvent(game, 67);
      this.caughtSven = true;
      this.req = 0;
      ok = false;
      return done();
    };
    const caughtBlock = () => {                                  // LABEL_29
      if (!this.caughtSven) return false;
      if (own()) { this._svenEvent(game, 67); this.req = 63; return true; }
      this.caughtSven = false;
      this.req = 0;
      return false;
    };
    switch (this.state) {
      case 0:
        this.req = 63;
        return done();
      case 63:
        if (this.req === 65) chaseReset();
        else if (this.req === 64) this.req = this._wanderStep(game);
        else if (this.req !== 66) {
          if (!this.timer) this.req = this._wanderStep(game);
          else { this.req = 0; ok = false; }
        }
        return done();
      case 64:
        if (caughtBlock()) return done();
        if (own()) return catchHere();
        if (this.req === 65) chaseReset();
        else if (this.req !== 66) {
          if (this.req === 64 || this.timer) this.req = this._wanderStep(game);
          else this.req = 63;
        }
        return done();
      case 65:
        if (caughtBlock()) return done();
        if (own()) return catchHere();
        if (this.req !== 66) this.req = this.req === 64 ? this._wanderStep(game) : this._chaseStep(game);
        return done();
      case 66:
        if (this.req === 65) {
          this.req = this._chaseStep(game);
        } else if (this.caughtSven) {
          if (own()) {
            this.caughtSven = false;
            this._svenEvent(game, 67);
            this.caughtSven = true;
            this.req = 63;
          } else {
            ok = false;
          }
        } else if (this.timer) {
          this.req = 0;
          ok = false;
        } else {
          this.req = 63;
        }
        return done();
      case 68:
        if (this.req !== 63) { this.req = 0; ok = false; }
        return done();
      default:
        ok = false;
        return done();
    }
  }

  //--- state entry (sub_431E09) ---------------------------------------------
  _enter(game) {
    const A = game.assets;
    const prev = this.state;
    switch (this.req) {
      case 63:
        this.anim.setEntry(npcEntry(A, 'GuyStand', this.dir));
        if (prev !== 63) this.timer = npcRand(70) + 100;
        break;
      case 64:
        this.anim.setEntry(npcEntry(A, 'GuyWalk', this.dir));
        if (prev !== 64) this.timer = Math.trunc(npcGameDiff(game).d52 / SHEP_STEP_TICKS);
        break;
      case 65:
        this.anim.setEntry(npcEntry(A, 'GuyWalk', this.dir));
        break;
      case 66:
        this.dir = npcFaceSven(this, game.sven);
        this.anim.setEntry(npcEntry(A, 'GuyWalk2', this.dir));
        this.anim.done = false;
        this.anim.play(1, -1, -1);
        this.timer = this.anim.length();
        npcSfxPlay(game.audio, 'yell', false);    // ShepherdYell +28(0,0)
        break;
      case 68:
        this.visible = false;
        npcSfxStop(game.audio, 'yell');
        this.timer = -1;
        break;
    }
    this.state = this.req;
    this.req = 0;
  }

  // Sprite +37: hidden by sub_40702E, re-shown by any sheet change
  // (sub_40709A → sub_401B62).
  get visible() { return this.anim.visible; }
  set visible(v) { this.anim.visible = v; }

  draw(g) {
    if (!this.visible) return;
    this.anim.draw(g, this.px.x, this.px.y, this.drawFrame);
  }
}
npcMixWalker(Shepherd);
