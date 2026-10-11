//=== Game methods: game_level (prototype mixin) =================================
// Owner: level-flow-scoring (see audit/OWNERSHIP.md, audit/requests/level-flow-scoring.md).
// Level clock, level flow, score/lives, deaths, game over / win, high-score table.
// Game scene = sub_41F643 (vtable off_473DB4); field numbers below are its this[N].

// Level duration in seconds: game-scene ctor `*(this+48) = 90` (IDA:14344). Same
// for every level; p8352 is written by sub_4175DC but never read.
const LEVEL_DURATION_S = 90;
// Level-advance blink transition: sub_4259FF sets this[152] = 60 ticks (IDA:17077).
const LEVEL_TRANSITION_TICKS = 60;
// Game-over / win overlay hold: sub_423F9C `this[9] = GetTickCount() + 5000` (IDA:16308).
const END_HOLD_MS = 5000;

// Score.dat (sub_417D20 / sub_4179CC): dword saved level (dword_49AF9C) + 5 records
// {name, score} (sub_42A388) + key bindings. Stored here as JSON in localStorage with
// the same structure: { level, table: [{name, score} x5] } (key bindings not stored).
const SCOREDAT_KEY = 'sven_scoredat_v1';
const HIGHSCORE_CAP = 5;                          // sub_42A388 / sub_42A454: 5 entries
const HS_NAME_MAX = 10;                           // sub_426EB6 `v3 < 10`
// byte_494250 `20 2D 5F 27 22 DC D6 C4 FC F6 E4 DF` (plus alpha/digit). Names are
// byte strings (char code = byte); they are drawn through the RUSSIAN_CHARSET
// font (sub_472F04), so the high bytes show as Ь Ц Д ь ц д Я — use
// cp1251Display (core.js) when drawing.
const HS_NAME_EXTRA_CHARS = ' -_\'"\xDC\xD6\xC4\xFC\xF6\xE4\xDF';
// sub_429FBA (IDA:19255-19291), names at 0x4944F8 `53 F6 72 65 6E` / 0x494500
// `44 F6 72 74 65` — also what the shipped Score.dat holds. Displayed "Sцren"/"Dцrte".
const DEFAULT_HIGHSCORES = [
  { name: 'S\xF6ren', score: 500 },
  { name: 'D\xF6rte', score: 400 },
  { name: 'Ole',    score: 300 },
  { name: 'Ansgar', score: 200 },
  { name: 'Leif',   score: 100 },
];

function _readScoreDat() {
  let d = null;
  try {
    const raw = localStorage.getItem(SCOREDAT_KEY);
    if (raw) d = JSON.parse(raw);
  } catch { d = null; }
  // Missing file → defaults (sub_42A454) and saved level 1.
  const src = d && Array.isArray(d.table) && d.table.length === HIGHSCORE_CAP ? d.table : DEFAULT_HIGHSCORES;
  const table = src.map(e => ({
    name: _toNameBytes(e && e.name != null ? e.name : '').slice(0, 16),   // 17-byte buffer incl. NUL
    score: Math.max(0, Math.floor(Number(e && e.score) || 0)),
  }));
  const level = d && Number.isInteger(d.level) && d.level >= 1 ? d.level : 1;
  return { level, table };
}
// Stored names are byte strings; a char outside 0..255 (not producible by the
// original) is mapped back to its ANSI byte, '?' if none.
function _toNameBytes(v) {
  let out = '';
  for (const ch of String(v)) {
    if (ch.charCodeAt(0) <= 0xFF) { out += ch; continue; }
    const b = ansiByteForChar(ch);
    out += b >= 0 ? String.fromCharCode(b) : '?';
  }
  return out;
}
function _writeScoreDat(dat) {
  try { localStorage.setItem(SCOREDAT_KEY, JSON.stringify(dat)); } catch {}
}
// dword_49AF9C — the saved level (Continue offers it when > 1).
function loadProgress() { return _readScoreDat().level; }
function saveProgress(level) {
  const dat = _readScoreDat();
  dat.level = Math.max(1, Math.floor(level) || 1);
  _writeScoreDat(dat);
}
function loadHighScores() { return _readScoreDat().table; }
// sub_42A221 (IDA:19347): returns -1 if below the bottom entry; else shifts down every
// entry with a strictly lower score and inserts (ties stay above; bottom tie replaced).
function insertHighScore(name, score) {
  const dat = _readScoreDat();
  const t = dat.table;
  if (score < t[HIGHSCORE_CAP - 1].score) return -1;
  let i = HIGHSCORE_CAP - 1;
  while (i > 0 && t[i - 1].score < score) { t[i] = t[i - 1]; i--; }
  t[i] = { name: String(name).slice(0, 16), score };
  _writeScoreDat(dat);
  return i;
}
// sub_427047 (IDA:17710): name entry opens when score >= 5th score (unsigned compare).
function scoreQualifiesForLeaderboard(score) {
  return score >= loadHighScores()[HIGHSCORE_CAP - 1].score;
}
// Level clock this[10] (remaining ms, read-only view). Write through
// addLevelTime / setLevelClock.
Object.defineProperty(Game.prototype, 'levelTimeMs', {
  configurable: true,
  get() { return this._levelRemainMs || 0; },
});

GAME_INIT_HOOKS.push(function () {
  this.levelEndAt = 0;            // this[9]  deadline (getTickCount() ms)
  this._levelRemainMs = 0;        // this[10] remaining ms
  this.clockPause = 0;            // this[17] pause counter (transition / time-out)
  this.basePauseCount = 0;        // this[16] base pause counter (Esc / boss, sub_41CB4E)
  // Map +8405 special-sheep byte: written only by sub_4175DC (IDA:10273), which runs
  // AFTER the Map.ini parse sub_412880 (IDA:14501-14502), so the parse sees the
  // previous level's value. Persists for the app run (map object never re-created).
  // UNVERIFIED: value at app start. The map is operator new(0x20E4) (IDA:7871) →
  // HeapAlloc flags 0 (not zeroed); its ctor sub_4123DC never writes +8405 and the
  // only writer is sub_4175DC (IDA:10271/10273), so it is leftover heap data.
  // Matters only for a Continue at a saved level 12-20 as the first game enter
  // of the session. Assumed 0 (fresh heap page).
  this.mapSpecialFlag = false;
  this.mapLevel = 1;              // map [2079]/[2080] (sub_4127C2); title sets 1
  this.levelTransitionTicks = 0;  // this[152]
  this.endHoldMs = 0;             // this[114] (>0 = game-over / win overlay up)
  this.gameWon = false;           // this[115]
  this.catchDeathPending = false; // byte +468
  this.mushSpawnDelay = -1;       // this[39]
  this.mushSpawnPending = 0;      // this[40]
  this.chainBuffer = [];          // this[143..148] / this[149]
  this._timeSfxLast = -1;         // dword_493E0C
  this.hsEntryActive = false;     // Top Scores scene +144
  this.hsEntryName = '';          // +120 buffer; cleared only in the scene ctor sub_426050 (IDA:17285)
  this.hsEntryScore = -1;         // +136
  this.hsEntryRank = -1;          // +140
});

Object.assign(Game.prototype, {

  // sub_4175DC (IDA:10194-10283). Base +8328 = dword_49AFBC; offsets in names.
  // The ONE difficulty table (map +8328, filled once per enter): stored in
  // game.difficulty by loadLevel before any entity is built; NPCs read it there.
  computeDifficulty(L) {
    const clmp = (v, c) => (L >= 20 ? c : v);
    const v16 = clmp(16 - Math.floor(14*L/20), 2);
    return {
      p8328: clmp(5 - Math.floor(3*L/20), 2),
      p8332: L > 20 ? 40 : 100 - Math.floor(60*L/20),       // dog timer +156 (sub_405306 IDA:1782)
      p8336: Math.floor(9*L/20) + 4,
      p8340: v16,
      p8344: Math.floor(v16 / 2) + v16,
      p8348: 140,                                            // read by dog (IDA:2149)
      p8352: clmp(120 - Math.floor(140*L/40), 50),           // written only; level time is 90 s (IDA:14344)
      p8356: Math.floor(9*L/20) + 8,
      p8360: 2,                                              // read by dog (IDA:1168)
      p8364: 20,                                             // read by dog (IDA:1167)
      p8368: 10,
      p8372: Math.floor(17*L/20) + 8,
      p8376: 20 * clmp(4 - Math.floor(3*L/20), 1),
      p8380: Math.floor(140*L/40) + 140,
      p8384: clmp(15 - Math.floor(10*L/20), 5),              // catch chain +1 life window (sub_42546F)
      p8388: clmp(20 - Math.floor(10*L/20), 10),             // catch chain UFO/mood window
      p8392: clmp(25 - Math.floor(10*L/20), 15),             // catch chain mood window
      p8396: Math.floor(3*L/20) + 1,
      mermaidEnabled:    L >= 3,    // +8400
      saintModeEnabled:  L >= 4,    // +8401 (sub_425311 / sub_438536)
      extraEntity:       L >= 5,    // +8402 UFO (CUfo, IDA:15052)
      wolfDefeat:        L >= 6,    // +8403 read in sub_43633C (IDA:24925): Sven into lying/sleeping dog
      lightningEnabled:  L >= 8,    // +8404 gates sub_4300DA case 2
      specialSheep:      L >= 12,   // +8405 (IDA:8662-8669)
    };
  },

  // Game scene enter (sub_42006D) + entity build (sub_420C51). `advance` = entered
  // with a2 == 2 (next level): runs sub_4259FF (blink transition) instead of StartSound.
  loadLevel(idx, advance = false) {
    this.setMapLevel(idx);                                       // sub_4127C2 / sub_41281B
    const key = `Level${String(idx).padStart(2, '0')}`;
    // sub_412880 (Map parse) runs before sub_4175DC (IDA:14501-14502): the parse
    // reads the +8405 left by the previous computation.
    this.level = new Level(this.mapInfo, this.mapIni, key, this.mapSpecialFlag);
    this.difficulty = this.computeDifficulty(idx);
    this.mapSpecialFlag = this.difficulty.specialSheep;          // +8405 (IDA:10273)
    // All 20 shipped levels have an 'f' (Map.ini). Without one the original
    // builds Sven at map +8236/+8240 = -1 (reset IDA:8834-8835); not ported.
    if (!this.level.svenSpawn) throw new Error(`${key}: no 'f' cell`);
    this.sven = new Sven(this.level.svenSpawn);                   // sub_434120(row, col, 2) IDA:9071
    this.sheeps = this.level.entities
      .filter(e => e.kind === 'sheep' || e.kind === 'special')
      // W/S spawn sheep; +148 bit0 needs the parse-time +8405 (map.js) AND the
      // current +8405 at spawn (sub_413D74 IDA:8935).
      .map(e => new Sheep(e.col, e.row, e.dir, e.kind === 'special' && this.difficulty.specialSheep));
    this.dogs = this.level.entities.filter(e => e.kind === 'dog')
      .map(e => new Dog(e.col, e.row, this));                     // sub_4022E0
    this.shepherds = this.level.entities.filter(e => e.kind === 'shepherd')
      .map(e => new Shepherd(e.col, e.row, this));                // sub_4302B0
    // The 7 mushroom slots with the Map.ini mushrooms (sub_4211B0 + sub_414AA1,
    // game_items.js); the 2 random level-start mushrooms are queued below.
    this.mushrooms = this.buildMushroomSlots(this.level.entities);
    // Mermaid spawns ONLY from level 3+ (+8400, sub_4175DC IDA:10267).
    this.mermaid = this.difficulty.mermaidEnabled ? new Mermaid(this.mapInfo) : null;
    // UFO on L>=5 (+8402, CUfo allocated at IDA:15052).
    this.ufo = this.difficulty.extraEntity ? new Ufo() : null;
    this.levelIdx = idx;
    // sub_42006D resets (IDA:14514-14530): this[114], this[115], byte +468,
    // sub_425311 count +568, sub_42546F count +596.
    this.endHoldMs = 0;
    this.gameWon = false;
    this.catchDeathPending = false;
    this.catchBuffer = [];
    this.chainBuffer = [];
    // this[39] = 1; this[40] = 2 — two random mushrooms on the first tick (IDA:14531-14532).
    this.mushSpawnDelay = 1;
    this.mushSpawnPending = 2;
    // +484 lamb latch (IDA:14519). Pool/poolMax are set by the sheep level
    // hook (sub_412880 / sub_413D74 / sub_42ABDF, game_sheep.js).
    this.lambSpawned = false;
    this.lambs = [];
    // Clock: sub_4259FF (advance) / sub_41C9F8 both set this[9] = now + 90 s and
    // sub_41C9F8 clears the pause counters this[16] and this[17] (IDA:12600-12601,
    // 12616-12617, 17069); a demo left by Esc never resumes its base pause.
    this.clockPause = 0;
    this.basePauseCount = 0;
    this.setLevelClock(LEVEL_DURATION_S * 1000);
    this.levelTransitionTicks = 0;
    // Area extension hooks (core.js GAME_LEVEL_HOOKS), in array order. They
    // run on every enter (new game, Continue and advance) before sub_4259FF, i.e.
    // where sub_42006D's unconditional resets IDA:14512-14524 sit (lives icons
    // +272/+276/+288, Esc dialog/choice, exit request — R3-LF-01).
    for (const fn of GAME_LEVEL_HOOKS) fn.call(this, idx);
    if (advance) this.startLevelTransition();      // sub_4259FF (IDA:14533)
  },

  // sub_42006D with a2 != 2 (new game or continue, IDA:14476-14482, 14533-14536):
  // score 0, lives 3, unfreeze score; StartSound only here, never between levels.
  beginGame(lvl) {
    this.score = 0;
    this.lives = 3;
    this.scoreFrozen = false;
    this.loadLevel(lvl, false);
    this.audio.play('start');
  },

  //--- Level clock (wall time, GetTickCount) -------------------------------------
  // sub_41C9F8 (IDA:12603): this[10] = ms; this[9] = now + ms.
  setLevelClock(ms) {
    this._levelRemainMs = ms;
    this.levelEndAt = getTickCount() + ms;
  },
  // Map [2079]/[2080] = n (sub_4127C2 IDA:8447; title enter/leave pass 1,
  // IDA:14074/14099). levelIdx mirrors [2079], mapLevel [2080].
  setMapLevel(n) {
    this.levelIdx = n;
    this.mapLevel = n;
  },
  // Base scene pause sub_41CB4E (IDA:12640): separate counter this[16]; the
  // first pause freezes this[10] = this[9] - now (scene sound +36 is audio's).
  basePause() {
    if (this.basePauseCount < 0) this.basePauseCount = 0;
    if (!this.basePauseCount) this._levelRemainMs = this.levelEndAt - getTickCount();
    this.basePauseCount++;
  },
  // Base scene resume sub_41CBB4 (IDA:12656): this[9] = this[10] + now.
  baseResume() {
    if (this.basePauseCount < 0) this.basePauseCount = 0;
    if (this.basePauseCount > 0) {
      this.levelEndAt = this._levelRemainMs + getTickCount();
      this.basePauseCount--;
    }
  },
  // Game scene vtable+68 sub_42033E (IDA:14560): Sven timers (sub_438ECF), then base pause.
  scenePause() {
    if (this.sven) this.svenTimersPause();
    this.basePause();
  },
  // Game scene vtable+72 sub_420365 (IDA:14569): Sven timers (sub_438F26), then base resume.
  sceneResume() {
    if (this.sven) this.svenTimersResume();
    this.baseResume();
  },
  // sub_41CC23 (IDA:12672): first pause freezes this[10].
  pauseLevelClock() {
    if (this.clockPause < 0) this.clockPause = 0;
    if (!this.clockPause) this._levelRemainMs = this.levelEndAt - getTickCount();
    this.clockPause++;
  },
  // sub_41CC6F (IDA:12684): this[9] = this[10] + now.
  resumeLevelClock() {
    if (this.clockPause < 0) this.clockPause = 0;
    if (this.clockPause <= 0) return false;
    this.levelEndAt = this._levelRemainMs + getTickCount();
    this.clockPause--;
    return true;
  },
  // sub_424E7D case 11 (+10000, IDA:16706) / sub_424FFC case 9 (±, IDA:16816-16826):
  // this[9] += ms, clamped to >= now. this[10] follows on the next clock tick.
  addLevelTime(ms) {
    const now = getTickCount();
    this.levelEndAt += ms;
    if (this.levelEndAt < now) this.levelEndAt = now;
  },

  // Random-mushroom spawner (IDA:15535-15597), run before the objects tick.
  tickMushroomSpawner() {
    if (this.mushSpawnDelay > 0) this.mushSpawnDelay--;
    if (this.mushSpawnDelay === 0) {
      while (this.mushSpawnPending > 0) {
        this.spawnRandomMushroom();
        this.mushSpawnPending--;
      }
      this.mushSpawnDelay = -1;
    }
  },
  // Clock part of sub_41CCBD (IDA:12709-12714): unpaused → this[10] = this[9] - now;
  // < 0 → vtable+96 (sub_423CEE).
  tickLevelClock() {
    if (this.clockPause) return;
    this._levelRemainMs = this.levelEndAt - getTickCount();
    if (this._levelRemainMs < 0) this.onLevelTimeout();
  },
  // Level complete `if (!this[114] && !dword_49BA28) sub_423EA9(this)` (IDA:15626-15628),
  // then the Time SFX of the HUD text pass (IDA:16113-16125): every new whole
  // second <= 10, including 0, not during the end hold.
  tickLevelEnd() {
    if (!this.endHoldMs && this.sheepRemaining === 0) {
      this.afterLevelComplete();
      if (this.levelTransitionTicks > 0) return;
    }
    const sec = Math.trunc((this._levelRemainMs + 999) / 1000);
    if (this.endHoldMs || sec > 10) {
      this._timeSfxLast = -1;
    } else if (sec !== this._timeSfxLast) {
      this.audio.play('time');
      this._timeSfxLast = sec;
    }
  },

  // One transition tick (IDA:16186-16187): --this[152]; at 0 resume the clock (vtable+92).
  tickLevelTransition() {
    if (this.levelTransitionTicks <= 0) return;
    if (--this.levelTransitionTicks === 0) this.resumeLevelClock();
  },

  //--- Score / random mushrooms -------------------------------------------------
  // sub_42A2CB (IDA:19369-19390). Frozen → no-op; clamp at 0; positive delta: Points
  // chime when score/10 rises, one mushroom spawn when score/50 rises (once per call).
  addScore(delta) {
    if (this.scoreFrozen) return this.score;
    const oldTens  = Math.floor(this.score / 10);
    const oldFifty = Math.floor(this.score / 50);
    this.score += delta;
    if (this.score < 0) this.score = 0;
    if (delta > 0) {
      if (Math.floor(this.score / 10) > oldTens) this.audio.play('points');
      if (Math.floor(this.score / 50) > oldFifty) this.queueMushroomSpawn(1);  // sub_424E7D(0)
    }
    return this.score;
  },

  // sub_424E7D case 0 (n=1, IDA:16698) / case 25 (n=3, IDA:16726): this[39]=1; this[40]+=n.
  queueMushroomSpawn(n) {
    this.mushSpawnDelay = 1;
    this.mushSpawnPending += n;
  },

  //--- Catch chain (sub_42546F, IDA:16892-17023) --------------------------------
  // Called on every sheep catch (IDA:20131) with id = the sheep's this[1], the
  // object serial dword_49AF3C++ (sub_406EB8); the Sheep object is used here.
  // Equivalent identity.
  catchChain(id) {
    const now = getTickCount();
    const b = this.chainBuffer;              // newest first, at most 2 entries
    if (b.length && b[0].id === id && now - b[0].t < 3000) return false;
    if (b.length < 2) {
      b.unshift({ id, t: now });
      return true;
    }
    const d = now - b[1].t;                  // time since the older stored catch
    const p = this.difficulty;
    if (d <= 1000 * p.p8384) {
      if (this.lives < 15) {
        this.lives++;
        this.audio.play('electro');          // aLightning_0 = Lightning.mp3
        this.startLifeIconAnim();            // lives-icon drop-in this[68..71] (IDA:16984-16987)
      } else if (!this._chainUfoSummon()) {
        this._chainMoodAll();
      }
      this.chainBuffer = [];
    } else if (d <= 1000 * p.p8388) {
      if (!this._chainUfoSummon()) this._chainMoodAll();
      this.chainBuffer = [];
    } else if (d <= 1000 * p.p8392) {
      this._chainMoodAll();
      this.chainBuffer = [];
    } else {
      b[1] = b[0];
      b[0] = { id, t: now };
    }
    return true;
  },
  // `this[118] && *(this[118]+56) == 70` → this[119] = 1 (UFO comes next tick).
  _chainUfoSummon() {
    return !!(this.ufo && this.ufo.summon());
  },
  // sub_42EE43 on every CSheep in the scene list (IDA:16936-16944), with no state
  // test: caught sheep stay in the list (state 12, IDA:20407-20414).
  _chainMoodAll() {
    for (const sh of this.sheeps) sh.boost900();
  },

  //--- Deaths (sub_424CB8 / sub_423CEE) ------------------------------------------
  // sub_424CB8 ')' (IDA:16626-16649), from Sven caught state 0x25-0x28.
  onSvenCaught() {
    if (this.lives > 0) this.lives--;
    if (this.lives) {
      this.startLifeLostAnim();            // this[68], [72..74], [69] (IDA:16626-16649)
      this.catchDeathPending = true;
    }
  },

  // sub_424CB8 '*' (IDA:16651-16663), from Sven state 0x2A. Sven resets
  // himself home and clears his mushroom mode (IDA:24668-24676).
  onSvenCatchAnimDone() {
    this.catchDeathPending = false;
    if (this.lives <= 0) { this.startEndHold(); return; }
    for (const d of this.dogs) d.event(42);        // sub_405C45(dog, 42)
    for (const s of this.shepherds) s.event(42);   // sub_43217A(42)
    this.resumeLevelClock();                       // vtable+92
    this.levelEndAt = getTickCount() + LEVEL_DURATION_S * 1000;
  },

  // sub_424CB8 '1' (IDA:16664-16673), from Sven time-out explode state 0x31.
  onSvenExplodeDone() {
    if (this.lives > 0) {
      this.resumeLevelClock();
      this.levelEndAt = getTickCount() + LEVEL_DURATION_S * 1000;
    } else {
      this.startEndHold();
    }
  },

  // sub_423CEE (IDA:16196-16254) — the scene timer ran out (vtable+96).
  onLevelTimeout() {
    // Hold expired: 0x402(this[14], this[15]); this[14] = demo ? 1 : 3 (IDA:14504-14506).
    if (this.endHoldMs) { this._leaveEndHold(this.demoMode ? GAME_STATE.TITLE : GAME_STATE.HIGHSCORES); return; }
    if (this.lives > 0) this.lives--;
    if (this.lives > 0) this.startLifeLostAnim();   // IDA:16219-16234
    this.audio.play('alarm');
    // sub_438B37(83): Sven queues the SvenExplode action (0x31).
    const queued = this.sven.timeOut(83);
    if (queued || this.catchDeathPending) { this.pauseLevelClock(); return; }
    if (this.lives <= 0) { this.startEndHold(); return; }
    this.levelEndAt = getTickCount() + LEVEL_DURATION_S * 1000;
  },

  //--- Level complete / game over / win -----------------------------------------
  // sub_423EA9 (IDA:16257-16282).
  afterLevelComplete() {
    const remain = this.levelEndAt - getTickCount();   // v3 = this[9] - GetTickCount()
    this.addScore(5 * this.levelIdx);
    if (remain > 0) this.addScore(Math.trunc(remain / 1000));
    const next = this.mapInfo.validLevelOrNull(this.levelIdx + 1);   // sub_4127C2
    if (next !== null) {
      // vtable+64 leave (sub_4202CA saves [2080] = next level), vtable+60 enter (a2=2),
      // vtable+88 pause the clock for the transition.
      this.setMapLevel(next);                              // sub_4127C2(L+1) (IDA:16269)
      this.audio.stopGameSfx();                            // leave sub_4202CA → vtable+56
      this.leaveGameScene();
      // Leave sub_41CAD4 SendMessage 0x403(0) kills the timer (IDA:12634); enter
      // sub_41C9F8 posts 0x403(this[13]) (IDA:12610) → SetTimer after this tick
      // (sub_410BF8): loadLevel's GAME_LEVEL_HOOKS entry (game_screens.js) runs
      // _rearmTimer. This tick still draws (game.js tick renders after run).
      this.loadLevel(next, true);
      this.pauseLevelClock();
      return;
    }
    this.startEndHold();
    this.gameWon = true;                                    // this[115] = 1 after sub_423F9C
  },

  // sub_423F9C (IDA:16299-16314): freeze the clock display, 5 s hold, freeze the
  // score, GameOverSfx (this[115] is still 0 here, so the win plays it too).
  startEndHold() {
    const now = getTickCount();
    let held = Math.trunc(this.levelEndAt - now);
    if (held < 0) held = 1;                               // `(int)this[114] < 0` (IDA:16304)
    this.endHoldMs = held;
    this.resumeLevelClock();
    this.levelEndAt = now + END_HOLD_MS;
    this.scoreFrozen = true;
    if (!this.gameWon) this.audio.play('gameover');
  },

  // Enter during the hold (sub_42082B IDA:14749-14758): post 0x402(3, this[15]=1).
  skipEndHold() {
    if (this.endHoldMs) this._leaveEndHold(GAME_STATE.HIGHSCORES);
  },
  // sub_423CEE (IDA:16207-16212) only posts 0x402; this[114] stays set until
  // the next enter clears it (IDA:14514, loadLevel).
  _leaveEndHold(next) {
    this.switchScene(next, 1);     // leave = sub_4202CA (saves), enter Top Scores with entry
  },

  // sub_4202CA (IDA:14544-14556) → sub_417D20: save the CURRENT level (no max),
  // not in demo (+440).
  leaveGameScene() {
    if (this.demoMode) return;
    this.saveScoreDat();
  },
  // sub_417D20 (IDA:10442-10444): write map [2080]; [2081] = dword_49AF9C = [2080].
  saveScoreDat() {
    saveProgress(this.mapLevel);
    this.highestLevel = this.mapLevel;
  },

  //--- Top Scores scene name entry (sub_426050) ---------------------------------
  // sub_427047 (IDA:17698-17726). fromGame = entered with a3 != 0. The name
  // buffer +120 is NOT cleared here (only in the ctor sub_426050, IDA:17285).
  // The `*(this+116)+40` skip byte is the key-binding object's +0x28, only ever
  // written 0 (sub_433EB1 / sub_433FBB) — dead branch, not ported.
  enterHighScores(fromGame) {
    this.hsEntryRank = -1;
    if (fromGame) {
      this.hsEntryScore = this.score;
      this.hsEntryActive = scoreQualifiesForLeaderboard(this.score);
    } else {
      this.hsEntryScore = -1;
      this.hsEntryActive = false;
    }
  },
  // sub_426EB6 (WM_CHAR): Backspace deletes; alpha/digit/byte_494250 appends, max 10.
  // The char is the WM_CHAR byte (ansiByteForChar: German Ü→0xDC, Russian Ь→0xDC, …),
  // sign-extended (movsx) into _ismbcalpha/_ismbcdigit, so only ASCII letters/digits
  // pass those; a high byte is accepted only via _mbschr(byte_494250) (IDA:17635-17660).
  highScoreChar(ch) {
    if (!this.hsEntryActive) return false;
    if (ch === 'Backspace' || ch === '\b') {
      if (this.hsEntryName.length > 0) this.hsEntryName = this.hsEntryName.slice(0, -1);
      return true;
    }
    if (typeof ch !== 'string' || ch.length !== 1) return false;
    const b = ansiByteForChar(ch);
    if (b <= 0) return false;
    const c = String.fromCharCode(b);
    if (/^[A-Za-z0-9]$/.test(c) || HS_NAME_EXTRA_CHARS.includes(c)) {
      if (this.hsEntryName.length < HS_NAME_MAX) this.hsEntryName += c;
      return true;
    }
    return false;
  },
  // sub_426F9A (keydown): while entry is active, Enter commits a non-empty name and
  // every key is consumed; otherwise returns false (normal scene keys apply).
  highScoreKey(key) {
    if (!this.hsEntryActive) return false;
    if (key === 'Enter' && this.hsEntryName.length > 0) {
      this.hsEntryRank = insertHighScore(this.hsEntryName, this.hsEntryScore);
      this.hsEntryActive = false;
    }
    return true;
  },
  // sub_427125 (IDA:17728-17740): commit a pending entry, then save Score.dat
  // (sub_417D20) with the current map level — 1 after a title visit.
  leaveHighScores() {
    if (this.hsEntryActive) {
      this.hsEntryRank = insertHighScore(this.hsEntryName, this.hsEntryScore);
      this.hsEntryActive = false;
    }
    this.saveScoreDat();
  },
});
