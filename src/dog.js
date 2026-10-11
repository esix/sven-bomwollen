//=== Dog entity (CDog, vtable off_4735C4) ===================================
// Port of the original 12-state machine. One update() call = one 20 Hz tick.
//   ctor sub_4022E0 / init sub_40248F / state reset sub_402961
//   tick sub_402A9C → transitions sub_402CD1 → state entry sub_405306
//   events sub_405C45, howl event sub_405EC7, self-push sub_405F59
//   random walk sub_403F0F, step toward Sven sub_404381, flee sub_404B48
//   anim/SFX sub_4059C9, step length sub_406050, cell enter sub_405A6A,
//   mushroom eat sub_405FC7, reset-to-home sub_4029CA.
// Fields mirror the original: state this[29] (+116), req this[32] (+128),
// queue this[33..37] (count this[38]), timer this[39] (+156), shagTicks
// this[40] (+160), chaseSteps this[41] (+164), shagCount this[31] (+124),
// caughtSven byte +181, hiddenFlag byte +180, lastBarkMs this[28] (+112).
const DOG_STATE = Object.freeze({
  INIT: 0,
  LAYDOWN: 50,        // Doglaydown, timer
  WALK: 51,           // Dogwalk random walk / approach Sven
  CHASE: 52,          // Dogrun chase after a shag press (event 32)
  RUN_ALIEN: 53,      // endless run (alien mode, event 48)
  HOWL: 54,           // Doghowl after a sheep is caught (sub_405EC7(11))
  RUN: 55,            // run toward Sven after the howl
  LAYDOWN_AFTER: 56,  // post-chase Doglaydown
  SHAGGED: 57,        // Dogshag (Sven dog-shags the lying dog)
  SHAG_CYCLE: 58,     // one dogshag cycle done
  SLEEP: 59,          // Dogsleep after the dogshag
  HIDDEN: 61,         // catcher hidden during Sven's fight anim (event 41)
});
const DOG_WALK_TICKS = 14;   // dword_4910F0
const DOG_RUN_TICKS = 10;    // dword_4910EC
let dogRunSfxToggle = true;  // byte_4913F8 (first play = DogRun1)
const dogIsMoveState = s => s >= 51 && (s <= 53 || s === 55);  // sub_402A9C

class Dog {
  constructor(col, row, game) {
    this.col = col;
    this.row = row;
    this.dir = DIR.SE;              // sub_414472 passes dir 3 (IDA:9137)
    this.homeCol = col;             // this[42..44] (sub_4022E0 IDA:742-746)
    this.homeRow = row;
    this.homeDir = this.dir;
    this.game = game;
    this.anim = new NpcAnim();      // this[6]
    this.overlay = new NpcAnim();   // this[30] (Symbols)
    this.drawFrame = 0;
    this.overlayFrame = 0;
    this.onGrid = true;             // map-object +44
    this.lastBarkMs = 0;            // this[28] = 0
    this.hiddenFlag = false;        // +180
    this.caughtSven = false;        // +181
    this.shagCount = 0;             // this[31]
    this.shagTicks = 0;             // this[40]
    this.chaseSteps = 0;            // this[41]
    this._resetState();
    this._place();
  }

  // sub_402961: empty queue, state 0, req 0, timer 1.
  _resetState() {
    this.queue = [];
    this.state = 0;
    this.req = 0;
    this.timer = 1;
  }

  //--- events --------------------------------------------------------------
  _push(v) {                                   // LABEL_28 / sub_405F59
    if (this.queue.length >= 5) return;
    if (!this.queue.length || this.queue[this.queue.length - 1] !== v) this.queue.push(v);
  }
  // sub_405C45. Codes: 0 alien end, 28 mild alert, 32 shag press, 35 dogshag
  // start, 38 dogshag stop, 41 hide catcher, 42 reset, 47, 48 alien run.
  event(code) {
    if (this.queue.length >= 5) return true;
    const v3 = this.queue.length <= 0 ? this.state : this.queue[this.queue.length - 1];
    let v5;
    switch (code) {
      case 0: v5 = 51; break;
      case 28:
        if (v3 === 51 || v3 === 52 || v3 === 55 || v3 === 59) return true;
        v5 = (v3 === 57 || v3 === 58) ? 59 : 50;
        break;
      case 32:
        if (this.caughtSven) return false;
        v5 = 52;
        break;
      case 35:
        this.queue = [57];
        return true;
      case 38:
        if (this.state !== 57 && this.state !== 58) return false;
        v5 = 50;
        break;
      case 41:
        if (!this.caughtSven) return false;
        this.queue = [61];
        this.timer = 1;
        return true;
      case 42:
        this.resetToHome();
        return false;
      case 47: v5 = 50; this.timer = 1; break;
      case 48: v5 = 53; break;
      default: return false;
    }
    this._push(v5);
    return true;
  }
  // sub_405EC7(dog, 11): a sheep entered caught state 11 (IDA:19899-19902).
  howl() {
    if (this.queue.length >= 5) return true;
    this._push(54);
    return true;
  }
  // Event 42 → vtable+48 (sub_41A353 off grid) + vtable+80 sub_4029CA.
  resetToHome() {
    const game = this.game;
    this.onGrid = false;
    this.col = this.homeCol; this.row = this.homeRow; this.dir = this.homeDir;
    // sub_414E7D: nearest free land cell around home.
    const c = game.findFreeLandCell(this.col, this.row);
    if (c) { this.col = c.col; this.row = c.row; }
    this._place();                  // sub_41A40A
    this.onGrid = true;             // vtable+44 sub_41A2F8
    this.visible = true;            // sprite +37 = 1
    this._resetState();             // sub_402961
    this.shagCount = 0;             // this[31] = 0
    this.chaseSteps = 0;            // this[41] = 0
  }

  // Dog-state half of the dogshag test in sub_43633C (IDA:24924-24927):
  // state 50/56 with timer > 1, or state 58. The caller (sven.js) does the
  // cell (land, byte2 & 4), facing and +8403 tests (IDA:24918-24923).
  canBeDogshagged() {
    return ((this.state === 50 || this.state === 56) && this.timer > 1) || this.state === 58;
  }

  _svenEvent(game, code) {
    game.npcToSven(code, this);
  }

  //--- per tick (sub_402A9C) -------------------------------------------------
  update() {
    const game = this.game;
    if (this.queue.length && this.queue[0] === 61) {
      this.hiddenFlag = true;
      this.caughtSven = false;
      this.req = 61;
      this._enter(game);
      this.queue = [];
    } else if (this.stepTick === 0) {
      if (this.timer) this.timer--;
      if (this.queue.length) {
        const q = this.queue;
        this.queue = [];
        const saved = this.state;
        let any = false, last = 0;
        for (const ev of q) {
          this.req = ev;
          if (this._transition(game)) { this.state = this.req; last = this.req; any = true; }
        }
        if (any) { this.state = saved; this.req = last; this._enter(game); }
      } else if (this._transition(game)) {
        this._enter(game);
      }
      if (dogIsMoveState(this.state)) this._startStep();       // vtable+64 sub_419ECE
    }
    if (dogIsMoveState(this.state)) this._stepSfx(game);        // vtable+68 sub_4059C9
    // Draw-time animator advance (sub_401BDE → sub_401C8E), once per tick.
    this.drawFrame = this.anim.frame;
    this.anim.advance();
    if (this.state === 57 || this.state === 58) {               // sub_405BC4
      this.overlayFrame = this.overlay.frame;
      this.overlay.advance();
    }
  }

  _stepLen() {                                                  // sub_406050
    switch (this.state) {
      case 51: return DOG_WALK_TICKS;
      case 52: case 53: case 55: case 60: return DOG_RUN_TICKS;
      default: return 1;
    }
  }

  // sub_4059C9: advance the step, then footstep SFX by animation frame.
  _stepSfx(game) {
    this._advanceStep(game);
    const f = this.anim.frame;
    if (this.state === 51) {
      if (f === 3) game.audio.play('dogwalk1');
      else if (f === 11) game.audio.play('dogwalk2');
    } else if (f === 0) {
      game.audio.play(dogRunSfxToggle ? 'dogrun1' : 'dogrun2');
      dogRunSfxToggle = !dogRunSfxToggle;
    }
  }

  // sub_405A6A: a3=0 at mid-step (entered a new cell), a3=1 at step end.
  _onCellEnter(game, end) {
    if (end) {
      if (npcTerrainType(game, this.col, this.row) !== 7) return;
      const m = game.consumeMushroomAt(this.col, this.row);
      if (!m) return;
      // sub_405FC7 by object kind (obj+104).
      switch (m.kind) {
        case 5:
          this._push(59);
          this.state = 58;
          this.timer = npcGameDiff(game).d20;
          break;
        case 9:   // sub_424FFC(9, 6)
          game.addLevelTime(-10000);
          break;
        case 10:  // sub_42A2CB(-4)
          game.addScore(-4);
          break;
      }
      return;
    }
    if (!npcIsLand(game, this.col, this.row)) return;
    const bits = npcCellBits(game, this.col, this.row, this);
    if (bits.b2 & CELL_SVEN) {
      this._push(60);               // sub_405F59(60)
      this.caughtSven = true;
    }
  }

  //--- step choices ----------------------------------------------------------
  _svenStateBlocks(game) {
    const s = npcSvenState(game);
    return s === 39 || s === 40 || s === 41 || s === 42;
  }
  // Catch test after a chosen chase/flee step (chase IDA:1596-1612, flee IDA:1730-1750).
  _catchTest(game) {
    const d = DIR_DELTA[this.dir];
    const tc = this.col + d.dc, tr = this.row + d.dr;
    if (!npcIsLand(game, tc, tr)) return;
    const bits = npcCellBits(game, tc, tr, this);
    if (!((bits.b2 & CELL_SVEN) || (bits.b1 & CELL_SVEN))) return;
    if (this.caughtSven || npcSaintActive(game)) return;
    if (this._svenStateBlocks(game)) return;
    if (bits.b1 & CELL_SHEP) return;
    if (bits.b1 & CELL_TYPE8) return;
    this._svenEvent(game, 60);      // sub_4388F0(60) on Sven
    this.caughtSven = true;
  }
  _svenCellOk(game, checkState) {
    return bits => !npcSaintActive(game)
      && !(checkState && this._svenStateBlocks(game))
      && !(bits.b1 & CELL_SHEP) && !(bits.b1 & CELL_TYPE8);
  }
  // Pick from candidate dirs, skipping the previous cell unless it is the
  // only option (IDA:1584-1590).
  _pickAvoidingPrev(game, dirs, svenOk) {
    let fallback = -1;
    for (const dir of dirs) {
      const c = npcCandidate(game, this, dir, svenOk);
      if (!c) continue;
      if (c.col !== this.prevCol || c.row !== this.prevRow) return dir;
      fallback = dir;
    }
    return fallback;
  }
  // sub_404381(a2): step toward Sven. false (and req 50) when stuck.
  _chaseStep(game, resetPrev) {
    if (resetPrev) { this.prevCol = -1; this.prevRow = -1; }
    const dir = this._pickAvoidingPrev(game, npcTowardDirs(this, game.sven), this._svenCellOk(game, true));
    if (dir === -1) { this.req = 50; return false; }
    this.dir = dir;
    this._catchTest(game);
    return true;
  }
  // sub_404B48: flee (Sven mode 0). Returns 51 or 50.
  _fleeStep(game) {
    const t = npcTowardDirs(this, game.sven);   // [major, minor, ~minor, ~major]
    const dirs = [t[3], t[2], t[1], t[0]];
    const dir = this._pickAvoidingPrev(game, dirs, this._svenCellOk(game, true));
    if (dir === -1) return 50;
    this.dir = dir;
    this._catchTest(game);
    return 51;
  }
  // sub_403F0F: weighted random walk over [d+1, d-1, d, opposite].
  _randomStep(game) {
    const d = this.dir;
    const cands = [npcNext(d), npcPrev(d), d, npcOpp(d)];
    const ok = this._svenCellOk(game, false);
    const valid = cands.filter(c => npcCandidate(game, this, c, ok));
    const r = npcRand(100);
    let i;
    switch (valid.length) {
      case 1: i = 0; break;
      case 2: i = r >= 95 ? 1 : 0; break;
      case 3: i = r < 45 ? 0 : r < 90 ? 1 : 2; break;
      case 4: i = r < 40 ? 0 : r < 80 ? 1 : r < 95 ? 2 : 3; break;
      default: return 50;
    }
    this.dir = valid[i];
    return 51;
  }

  //--- transitions (sub_402CD1) ---------------------------------------------
  _transition(game) {
    const D = npcGameDiff(game);
    let ok = true;
    const own = () => npcOwnCellHasSven(game, this);
    const done = () => {                                         // LABEL_252
      if (this.req === 54 || this.req === 57 || this.req === 53) this.timer = -1000000;
      return ok;
    };
    const catchHere = () => {                                    // LABEL_170
      this._svenEvent(game, 60);
      this.caughtSven = true;
      this.req = 0;
      ok = false;
      return done();
    };
    // Shared flag block of states 51/52/53: still on Sven → LABEL_202.
    const caughtBlock = () => {
      if (!this.caughtSven) return false;
      if (own()) { this._svenEvent(game, 60); this.req = 50; return true; }
      this.caughtSven = false;
      this.req = 0;
      return false;
    };
    switch (this.state) {
      case 0:
        this.req = 50;
        return done();
      case 50:
        if (this.req !== 54) {
          if (this.req === 52 || this.req === 53) this._chaseStep(game, true);
          else if (this.req === 57) this.shagCount = 0;
          else if (!this.timer) this.req = this._randomStep(game);
          else { this.req = 0; ok = false; }
        }
        return done();
      case 51:
        if (caughtBlock()) return done();
        if (own()) return catchHere();
        if (this.req !== 54) {
          if (this.req === 52 || this.req === 53) this._chaseStep(game, true);
          else if (this.timer) {
            if (npcSvenMode(game) && npcSvenOnGrid(game)) {
              const s = game.sven;
              if (Math.abs(s.row - this.row) + Math.abs(s.col - this.col) >= D.d8) {
                this.req = this._randomStep(game);
              } else if (this._chaseStep(game, false)) {
                this.req = 51;
              }
            } else {
              this.req = this._fleeStep(game);
            }
          } else {
            this.req = 50;
          }
        }
        return done();
      case 52:
        if (caughtBlock()) return done();
        if (own()) return catchHere();
        if (this.req === 54) { this.chaseSteps = 0; this._chaseStep(game, true); return done(); }
        if (this.req === 53) { this._chaseStep(game, true); this.chaseSteps = 0; return done(); }
        if (this.timer) {
          if (this.req === 50) return done();
        } else if (this.req === 51 || !this.req) {
          this.req = 56;
          this.chaseSteps = 0;
          return done();
        }
        if (this.req === 52) {
          // Repeated event 32: extend by +32 after >= +36 chase steps (IDA:1165-1169).
          if (this._chaseStep(game, false) && this.chaseSteps >= D.d36) this.timer += D.d32;
        } else if (this.req === 50) {
          this.chaseSteps = 0;
        } else if (this._chaseStep(game, false)) {
          this.req = 52;
        } else {
          this.chaseSteps = 0;
        }
        return done();
      case 53:
        if (caughtBlock()) return done();
        if (own()) {
          this._svenEvent(game, 60);
          this.req = 0;
          this.caughtSven = true;
          ok = false;
        } else if (this.req === 51) {
          this.req = 56;
        } else if (this._chaseStep(game, false)) {
          this.req = 53;
        }
        return done();
      case 54:
        if (this.timer) { this.req = 0; ok = false; }
        else if (this._chaseStep(game, true) && this.req !== 53) this.req = 55;
        return done();
      case 55:
        if (caughtBlock()) return done();
        if (own()) return catchHere();
        if (this.req === 53) {
          this._chaseStep(game, true);
        } else if (this.req === 54) {
          if (this._chaseStep(game, false)) { this.req = 55; this.timer = D.d44; }
        } else if (this.timer || (this.req !== 51 && this.req)) {
          if (this._chaseStep(game, false)) this.req = 55;
        } else {
          this.req = 56;
        }
        return done();
      case 56:
        if (this.req === 57) this.shagCount = 0;
        else if (!this.timer) this.req = this._randomStep(game);
        else { this.req = 0; ok = false; }
        return done();
      case 57:
        if (this.req !== 50) {
          if (this.timer) { this.req = 0; ok = false; }
          else {
            this._svenEvent(game, 58);  // sub_4388F0(58)
            this.req = 58;
            game.addScore(3);           // sub_42A2CB(3)
            this.shagCount++;
          }
        }
        return done();
      case 58:
        switch (this.req) {
          case 0: this.req = 59; break;
          case 54: this._svenEvent(game, 59); this.req = 59; break;
          case 57: case 59: break;
          default: this.req = 59; break;
        }
        if (this.shagCount >= D.d16) {
          this._chaseStep(game, true);
          this.req = (npcSvenMode(game) === 4 ? 1 : 0) + 52;
          this._svenEvent(game, 52);
        }
        return done();
      case 59:
        if (this.timer) { this.req = 0; ok = false; }
        else if (this.req === 53) this._chaseStep(game, true);
        else this.req = this._randomStep(game);
        return done();
      case 61:
        if (this.req !== 50) { this.req = 0; ok = false; }
        return done();
      default:
        ok = false;
        return done();
    }
  }

  //--- state entry (sub_405306) ---------------------------------------------
  // Bark when within 20 cells² and > 4000 ms since the last (IDA:1810-1819).
  _barkCheck(game) {
    const s = game.sven;
    const dr = this.row - s.row, dc = this.col - s.col;
    const now = getTickCount();      // GetTickCount (this[28] = 0 vs uptime: first bark not held back)
    if (dr * dr + dc * dc <= 20 && now - this.lastBarkMs > 4000) {
      npcSfxPlay(game.audio, 'bark', false);
      this.lastBarkMs = now;
    }
  }
  _enter(game) {
    const A = game.assets;
    const D = npcGameDiff(game);
    const prev = this.state;
    switch (this.req) {
      case 50:
        this.anim.setEntry(npcEntry(A, 'DogLaydown', this.dir));
        npcSfxStop(game.audio, 'bark');
        if (prev) { if (prev !== 50) this.timer = D.d4; }
        else this.timer = 60;
        break;
      case 51:
        this.anim.setEntry(npcEntry(A, 'DogWalk', this.dir));
        npcSfxStop(game.audio, 'bark');
        if (prev !== 51) this.timer = Math.trunc(140 / DOG_WALK_TICKS);
        break;
      case 52:
        this.chaseSteps++;
        this.anim.setEntry(npcEntry(A, 'DogRun', this.dir));
        if (prev === 50 || prev === 51 || prev === 56 || prev === 58) this.timer = D.d28;
        else if (prev !== 52) this.timer = 0;
        this._barkCheck(game);
        break;
      case 53:
        this.anim.setEntry(npcEntry(A, 'DogRun', this.dir));
        this.timer = 1000000;
        break;
      case 54:
        this.dir = npcFaceSven(this, game.sven);
        this.anim.setEntry(npcEntry(A, 'DogHowl', this.dir));
        this.anim.play(2, -1, -1);
        npcSfxPlay(game.audio, 'bark', true);          // DogBark +28(0,1): looped
        this.timer = this.anim.length();
        break;
      case 55:
        this.anim.setEntry(npcEntry(A, 'DogRun', this.dir));
        if (prev === 54) {
          this.timer = D.d44;
          npcSfxStop(game.audio, 'bark');
        } else if (prev !== 55) {
          this.timer = 0;
        }
        this._barkCheck(game);
        break;
      case 56:
        this.anim.setEntry(npcEntry(A, 'DogLaydown', this.dir));
        npcSfxStop(game.audio, 'bark');
        this.timer = D.d48;
        break;
      case 57:
        this.anim.setEntry(npcEntry(A, npcSvenMode(game) === 4 ? 'AlienDogShag' : 'DogShag', this.dir));
        this.anim.done = false;
        this.anim.play(1, -1, -1);
        npcSfxPlay(game.audio, 'dogShag', false);      // DogShag +28(0,0)
        this.timer = this.anim.length() - 1;
        this.shagTicks += this.timer + 1;
        this.overlay.setEntry(npcEntry(A, 'DogSymbols', this.dir));
        this.overlay.setSpeed(0.3);                    // 0x3E99999A
        if (this.shagCount > D.d12) {
          if (this.shagCount <= D.d16) { this.overlay.done = false; this.overlay.play(0, 11, 14); }
        } else {
          this.overlay.done = false;
          this.overlay.play(0, 0, 3);
        }
        break;
      case 58:
        this.timer = 1;
        break;
      case 59:
        this.anim.setEntry(npcEntry(A, 'DogSleep', this.dir));
        this.anim.done = false;
        this.anim.play(0, 0, 0);
        this.anim.setSpeed(0.15);                      // 0x3E19999A
        this.timer = 3 * this.shagTicks;
        this.shagTicks = 0;
        break;
      case 61:
        this.visible = false;
        npcSfxStop(game.audio, 'bark');
        this.timer = -1;
        break;
    }
    this.state = this.req;
    this.req = 0;
  }

  // Sprite +37 of this[6]: hidden by sub_40702E, re-shown by any sheet
  // change (sub_40709A → sub_401B62).
  get visible() { return this.anim.visible; }
  set visible(v) { this.anim.visible = v; }

  draw(g) {
    if (!this.visible) return;
    this.anim.draw(g, this.px.x, this.px.y, this.drawFrame);
    if (this.state === 57 || this.state === 58) this.overlay.draw(g, this.px.x, this.px.y, this.overlayFrame);
  }
}
npcMixWalker(Dog);
