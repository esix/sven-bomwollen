//=== Game ==================================================================
// Scenes = the 9 scene objects of the original app, switched by sub_41179D
// (IDA:8071) through msg 0x402 (message map .rdata 0x4739D0 → 0x41179D).
// Index in the app's scene array (this[53+i]) in comments.
const GAME_STATE = Object.freeze({
  LOADING:         'loading',         // 0 sub_41DC60 (BITMAP 143/144 loading bar)
  TITLE:           'title',           // 1 sub_41E0F0 (MenuBkgnd, 5 buttons, flock)
  PLAYING:         'playing',         // 2 sub_41F643 (game scene)
  HIGHSCORES:      'highscores',      // 3 sub_426050 (TopBkgnd, name entry)
  HELP:            'help',            // 4 sub_4272D0 (HelpBkgnd)
  SETUP:           'setup',           // 5 sub_427510 (key binding, SetupBackground)
  EXIT:            'exit',            // 6 sub_4280F0 (UfoBkgnd, "ByeBye", WM_CLOSE after 9 s)
  // 7 = sub_428280 Sven.mpg movie scene: no code path switches to it (no
  // 0x402 post / vtable+76 returns 7; exit scene +96 is sub_4296B0 = WM_CLOSE),
  // so it is not ported.
  RELOAD_CONFIRM:  'reload_confirm',  // 8 sub_428E10 ("continue at level %d?")
});
// Per-scene logic tick rate (Hz). Scene base ctor sub_41C7D0 sets
// this[13]=20 (IDA:12543); scenes override it and sub_41C9F8 posts it on
// enter (msg 0x403, IDA:12610) to handler 0x410B02 which re-arms the timer.
const SCENE_TICK_HZ = Object.freeze({
  [GAME_STATE.LOADING]:        20,  // sub_41DC60 keeps base 20 (IDA:12543)
  [GAME_STATE.TITLE]:          15,  // sub_41E0F0 (IDA:13550)
  [GAME_STATE.PLAYING]:        GAME_TICK_HZ, // sub_41F643 (IDA:14345)
  [GAME_STATE.HIGHSCORES]:     15,  // sub_426050 (IDA:17297)
  [GAME_STATE.HELP]:           5,   // sub_4272D0 (IDA:17801)
  [GAME_STATE.SETUP]:          20,  // sub_427510 keeps base 20 (no override, IDA:17881-17907)
  [GAME_STATE.EXIT]:           15,  // sub_4280F0 (IDA:18284)
  [GAME_STATE.RELOAD_CONFIRM]: 15,  // sub_428E10 (IDA:18701)
});
// Max logic ticks run per display refresh. sub_410940 (IDA:7703-7704) returns
// without ticking while the primary surface's previous Flip is still pending
// (GetFlipStatus(DDGFS_ISFLIPDONE) != 0): after one tick+Flip, every further
// timer message (0x401, posted by fptc IDA:7814) before the next vblank is
// dropped. The timer itself keeps running (its phase is kept).
const MAX_CATCHUP_TICKS = 1;
// Early-fire tolerance of the tick accumulator. The original redraws ONLY on
// its free-running timeSetEvent tick (sub_410BF8 IDA:7804 → 0x401 → sub_410940
// tick+draw+Flip, IDA:7683-7731; no WM_PAINT, no OnIdle), so each image is
// held a steady number of refreshes. A 50 ms step sampled at vsync times sits
// on a frame boundary at 60/120/240 Hz; the tolerance is half the measured
// refresh interval (median of the last FRAME_SAMPLES rAF deltas), i.e. each
// timer event is assigned to the nearest refresh, capped at half a step. The
// debt is kept (accumulator may go negative), so the long-run rate is exact.
// No interpolation. FALLBACK_SLOP_MS until the first frame is measured.
const FRAME_SAMPLES = 16;
const FALLBACK_SLOP_MS = 4;
// Scene timeout this[12] in seconds (base 3600, IDA:12542); on expiry the
// scene's vtable+96 runs (sub_41CCBD IDA:12719).
const SCENE_TIMEOUT_S = Object.freeze({
  [GAME_STATE.TITLE]: 60,           // sub_41E0F0 this[12]=60 (IDA:13548) → demo game
  [GAME_STATE.EXIT]: 9,             // sub_4280F0 this[12]=9 (IDA:18285) → WM_CLOSE
});
// Key bindings = the Sven key controller sub_433A8A (5 slots, IDA:23683).
// Slot = action index of sub_433AE6: 0 NE, 1 NW, 2 SW, 3 SE, 4 action.
// Stored as KeyboardEvent.code (VK + scan code in the original).
const KEY_PRESET_1 = Object.freeze(['ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight', 'Space']); // sub_433EB1
const KEY_PRESET_2 = Object.freeze(['ArrowRight', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'Space']); // sub_433FBB
const KEYS_KEY = 'sven_keys_v1';
// sub_41D8FC (IDA:13250) / sub_420507 (IDA:14619) test tolower(VK code):
// 98 'b' = VK 'B' or VK_NUMPAD2 (0x62), 115 's' = VK 'S' or VK_F4 (0x73).
// WM_KEYDOWN's VK of a letter key follows the active layout when that layout
// is Latin (Dvorak/AZERTY: VK_B is the key labelled B → e.key); non-Latin
// layouts (Russian) map letter VKs by the US key position → e.code.
function vkLetter(e) {
  if (e.key && e.key.length === 1 && /[a-z]/i.test(e.key)) return e.key.toLowerCase();
  const m = /^Key([A-Z])$/.exec(e.code || '');
  return m ? m[1].toLowerCase() : null;
}
function vkIsBossKey(e) { return vkLetter(e) === 'b' || (e.code === 'Numpad2' && e.key === '2'); }
function vkIsMuteKey(e) { return vkLetter(e) === 's' || e.code === 'F4'; }

// CRT _qsort 0x458605 (MSVC 6 qsort.c, CUTOFF 8) with _shortsort 0x458759,
// in place on an array of object refs (element = one array slot). Ported
// from the disassembly: middle swapped to lo; loguy scans while <= hi and
// comp(loguy,lo) <= 0, higuy while > lo and comp(higuy,lo) >= 0; pivot to
// higuy; the smaller side is pushed (0x4586F0 `higuy-1-lo >= hi-loguy`).
// Unstable: the order of equal elements depends on the input order.
function msvcQsort(a, cmp) {
  const sw = (i, j) => { const t = a[i]; a[i] = a[j]; a[j] = t; };
  const shortsort = (lo, hi) => {             // repeated max to the end
    while (hi > lo) {
      let m = lo;
      for (let p = lo + 1; p <= hi; p++) if (cmp(a[p], a[m]) > 0) m = p;
      sw(m, hi);
      hi--;
    }
  };
  if (a.length < 2) return a;
  const stk = [];
  let lo = 0, hi = a.length - 1;
  for (;;) {
    const size = hi - lo + 1;
    if (size <= 8) shortsort(lo, hi);
    else {
      sw(lo + (size >>> 1), lo);
      let l = lo, h = hi + 1;
      for (;;) {
        do l++; while (l <= hi && cmp(a[l], a[lo]) <= 0);
        do h--; while (h > lo && cmp(a[h], a[lo]) >= 0);
        if (h < l) break;
        sw(l, h);
      }
      sw(lo, h);
      if (h - 1 - lo >= hi - l) {
        if (lo + 1 < h) stk.push(lo, h - 1);
        if (l < hi) { lo = l; continue; }
      } else {
        if (l < hi) stk.push(l, hi);
        if (lo + 1 < h) { hi = h - 1; continue; }
      }
    }
    if (!stk.length) return a;
    hi = stk.pop(); lo = stk.pop();
  }
}

class Game {
  constructor() {
    this.lib = null;
    this.map = null;
    this.assets = {};        // internalName -> SpriteSheet
    this.bg = null;
    this.level = null;
    this.sven = null;
    this.levelIdx = 1;
    this.bossScreen = false;  // base this[24] / game this[113]
    this.lastT = performance.now();
    // Fixed-timestep state (see tick()). tickCount = unpaused gameplay ticks
    // at GAME_TICK_HZ; never reset (area code may diff it).
    this._accMs = 0;
    this.tickCount = 0;
    this._frameT = null;      // last rAF timestamp (refresh-interval estimate)
    this._frameDts = [];      // last FRAME_SAMPLES rAF deltas (ms)
    this._tickFn = this.tick.bind(this);
    this.gstate = GAME_STATE.LOADING;  // boot: sub_41179D(0,0) (IDA:7837)
    this.appClosed = false;   // WM_CLOSE reached (exit scene)
    this.audio = new AudioBank();
    this.score = 0;
    this.lives = 3;           // sub_42A1D1 this[3]=3 (IDA:19341)
    // Saved level (dword_49AF9C).
    this.highestLevel = loadProgress();
    // Game scene flags.
    this.demoMode = false;    // +440 (sub_42006D IDA:14507)
    this.escDialog = false;   // this[6] Esc dialog open (sub_420507)
    this.escChoice = 0;       // this[25]: 0 "Да", 1 "Нет" (reset on enter IDA:14518)
    this.sceneExitReq = 0;    // this[5]: 1 Esc-dialog Yes, 2 demo Esc
    this.svenHeldAction = -1; // Sven ctrl +140 (sub_420507 / sub_42082B)
    this.svenActionReleased = false; // Sven ctrl +148 (sub_42082B)
    this.keyBindings = Game.loadKeyBindings();
    // Scene timeout (sub_41C9F8 this[9]/this[10]).
    this.sceneDeadline = 0;   // this[9]
    this._sceneRemainMs = 0;  // this[10] (recomputed by the timeout check)
    this._scenePauseCnt = 0;  // base pause counter this[16] (sub_41CB4E)
    // WM_ACTIVATEAPP (sub_4115B9): timer killed + scene paused while inactive.
    this._appActive = true;   // app +284
    this._suspended = false;
    // No image is flipped between a scene switch and its first timer tick.
    this._awaitFirstTick = false;
    // Scene switches / WM_CLOSE posted by a timer tick (PostMessageA 0x402 /
    // 0x10, IDA:13380, 16213, 18935, 19008): handled after the tick's Flip.
    this._inTick = false;
    this._posted = [];
    // Game-scene back surface: sub_421856 ticks and draws each list object in
    // turn (sub_41CCBD IDA:12712-12720), so the world image is built by the tick.
    this._worldCanvas = document.createElement('canvas');
    this._worldCanvas.width = 640; this._worldCanvas.height = 480;
    this._worldG = this._worldCanvas.getContext('2d');
    this._worldG.imageSmoothingEnabled = false;
    // Depth-sorted scene list of the current game tick (sub_41CDC6).
    this._drawList = null;
    this._sceneList = null;       // persistent game-scene list (CObArray)
    this._sceneListLevel = null;
    // Area extension hooks, in array order (see audit/OWNERSHIP.md).
    for (const fn of GAME_INIT_HOOKS) fn.call(this);
  }

  static loadKeyBindings() {
    try {
      const v = JSON.parse(localStorage.getItem(KEYS_KEY));
      if (Array.isArray(v) && v.length === 5) return v;
    } catch {}
    return KEY_PRESET_1.slice();
  }
  saveKeyBindings() {   // sub_41802D (setup leave, IDA:18225)
    try { localStorage.setItem(KEYS_KEY, JSON.stringify(this.keyBindings)); } catch {}
  }
  // sub_433AE6: action index for a key, -1 if unbound (searches slot 4..0).
  actionForCode(code) {
    for (let i = 4; i >= 0; i--) if (this.keyBindings[i] === code) return i;
    return -1;
  }


  async load() {
    const libText = await (await fetch(ASSETS + 'Library.ini')).text();
    this.lib = parseIni(libText);
    const mapIni = parseIni(await (await fetch(ASSETS + 'Map.ini')).text());
    this.mapInfo = new MapInfo(mapIni);
    this.mapInfo._game = this;        // back-reference (dword_49BA2C cap)
    this.mapIni = mapIni;

    // Loading scene (sub_41DDBB, IDA:13442) uses EXE BITMAP 143/144
    // (sub_409071, IDA:13436-13437).
    const bw  = new Image(); bw.src  = ASSETS + 'rsrc_143.png';
    const col = new Image(); col.src = ASSETS + 'rsrc_144.png';
    await bw.decode(); await col.decode();
    this._loadingBwImg  = bw;
    this._loadingColImg = col;
    // sub_40E61E: 0x405(1, total) with total = GetPrivateProfileSectionA return
    // of [Images] + [Sounds] (sound on) (IDA:6736-6751); every loaded line whose
    // first char is alpha sends 0x405(2, strlen+1) (images IDA:6795, then
    // sounds IDA:6853); the end sends 0x7FFFFFFF (IDA:6952). RawBitmaps send
    // nothing. UNVERIFIED: whether the section return counts `;` comment lines
    // (core.js iniSectionRawLines counts them; Wine's PROFILE_GetSection skips
    // them, Windows behaviour not confirmed).
    const imgSec = iniSectionRawLines(libText, 'Images');
    const sndSec = iniSectionRawLines(libText, 'Sounds');
    const total = imgSec.total + sndSec.total;
    let cur = 0;
    const isAlpha = (l) => /^[A-Za-z]/.test(l);       // _ismbcalpha(*Str)
    // Progress handler 0x411ED5: drains the key messages; WM_KEYUP VK_ESCAPE
    // → 2 → throw → WM_CLOSE (sub_4102D3 catch 0x4104BE). Returns false then.
    // Handler 0x411F88-0x411FAE: 32-bit add, then a signed `cur > total` clamp,
    // so the final 0x7FFFFFFF step wraps cur negative and is not clamped.
    const progress = (n) => {
      cur = (cur + n) | 0;
      if (cur > total) cur = total;
      if (this._loadEscUp && !this.appClosed) this.closeApp();
      if (this.appClosed) return false;
      this._drawLoadingBar(cur, total);
      return true;
    };
    this._drawLoadingBar(0, total);
    // Every [Images] line, in file order (sub_40DD58 / sub_40C99F per line).
    for (const line of imgSec.lines) {
      if (!isAlpha(line)) continue;
      const name = line.slice(0, line.indexOf('=')).trim();
      const def = this.lib.Images[name];
      // Library.ini def: file,rows,cols,frames,key,flipable.
      // Field 6 = flipable (sub_40C99F byte +44; sub_407FA2 mirrors only if set).
      // A failed load throws 1005 and aborts the app (IDA:6772-6790): the
      // rejection propagates out of load().
      const [file, rows, cols, frames, , flip] = def.split(',');
      this.assets[name] = new SpriteSheet(
        await loadSprite(file.trim()), +rows, +cols, +frames, +flip.trim());
      if (!progress(line.length + 1)) return;
    }

    this.bg     = this.assets['GameBkgnd'].canvas;
    this.menuBg = this.assets['MenuBkgnd'].canvas;
    this.titleSheet = this.assets['Title'];
    this.puddleSheets = [1,2,3,4,5,6,7].map(i => this.assets[`Puddle0${i}`]);
    // [Sounds] lines in file order; a line advances once its file is ready
    // (lines whose file the port does not load count as ready). audio.load
    // reports each ready AUDIO_MAP key (request filed if unsupported).
    const sndLines = sndSec.lines.filter(isAlpha).map(l => ({
      len: l.length, file: l.slice(l.indexOf('=') + 1).trim().toLowerCase() }));
    const jsFiles = new Set(Object.values(AUDIO_MAP).map(f => f.toLowerCase()));
    const ready = new Set();
    let sc = 0;
    const soundStep = () => {
      while (sc < sndLines.length && !this.appClosed
             && (!jsFiles.has(sndLines[sc].file) || ready.has(sndLines[sc].file))) {
        progress(sndLines[sc].len + 1);
        ++sc;
      }
    };
    await this.audio.load((key) => {
      if (AUDIO_MAP[key]) ready.add(AUDIO_MAP[key].toLowerCase());
      soundStep();
    });
    if (this.appClosed) return;
    for (const f of jsFiles) ready.add(f);
    soundStep();
    if (!progress(0x7FFFFFFF)) return;            // IDA:6952
    this.initScenes();                       // game_screens.js (sub_41E34D etc.)
    // End of app init sub_4110BE: sub_41179D(1,0) → title (IDA:8006).
    this.switchScene(GAME_STATE.TITLE, 0);
  }


  //--- Input ---------------------------------------------------------------
  // The original routes WM_KEYDOWN to the scene's vtable+28, WM_KEYUP to the
  // app handler 0x411A4A (Esc/Enter scene changes, then scene vtable+32),
  // WM_CHAR to vtable+36 (message map .rdata 0x473928-0x473958).
  handleKey(e, down) {
    if (this.appClosed) return;
    if (this.gstate === GAME_STATE.LOADING) {
      // 0x411ED5 (0x411F54-0x411F68): only WM_KEYUP VK_ESCAPE matters; it is
      // seen at the next progress message (see load). Other keys discarded.
      if (!down && e.key === 'Escape') this._loadEscUp = true;
      return;
    }
    if (down) this.audio.enable();          // browser autoplay gate
    if (down) this.onKeyDown(e); else this.onKeyUp(e);
  }

  // Base vtable+80 sub_41D8FC (IDA:13240): boss screen / mute for menu scenes.
  // Returns true if the key was consumed.
  baseSceneKey(e) {
    if (this.bossScreen) {
      if (e.key !== 'Escape') { this.setBossScreen(false); return true; }
      return false;
    }
    if (vkIsBossKey(e)) { this.setBossScreen(true); return true; }
    if (vkIsMuteKey(e)) { this.toggleMuteKey(); return true; }
    return false;
  }
  // 's' (IDA:13304-13310 / 14684-14690): byte_49AFCC toggled; mute-on calls
  // scene vtable+56, mute-off vtable+52.
  toggleMuteKey() {
    const st = this.gstate;
    // Exit scene: base +52 sub_41DADE / +56 sub_41DB07 act only on this[8],
    // which is 0 there (sub_4281AF IDA:18304): only byte_49AFCC toggles; a
    // MenuSound still looping (Setup timeout → exit) is left alone.
    if (st === GAME_STATE.EXIT) { this.audio.muted = !this.audio.muted; return; }
    const helpOrSetup = st === GAME_STATE.HELP || st === GAME_STATE.SETUP;
    // Help/setup +52 (sub_4274A2 / sub_428044) = sub_40F34C(MenuSound): played
    // once, not looped. The arg asks audio.js for that (request LR-15).
    const muted = this.audio.toggleMute(helpOrSetup);
    // Title +56 sub_41F56F also stops Cards (aCards_1).
    if (muted && st === GAME_STATE.TITLE) this.audio.stop('easteregg');
  }

  onKeyDown(e) {
    const st = this.gstate;
    if (st === GAME_STATE.PLAYING) { this.gameKeyDown(e); return; }
    if (st === GAME_STATE.HIGHSCORES) {
      // WM_CHAR → sub_426EB6 (name entry characters / Backspace).
      if (this.hsEntryActive && !this.bossScreen) {
        // Ctrl+key (without Alt = AltGr) yields a control-code WM_CHAR (or
        // none), which sub_426EB6 rejects except 0x08: Ctrl+H gives WM_CHAR 8
        // = Backspace (IDA:17643-17662), Ctrl+Backspace gives 0x7F (rejected).
        const ctl = e.ctrlKey && !e.altKey;
        if (e.key === 'Backspace') { if (!ctl) this.highScoreChar('\b'); e.preventDefault(); }
        else if (ctl) { if (vkLetter(e) === 'h') this.highScoreChar('\b'); }
        else if (e.key && e.key.length === 1) this.highScoreChar(e.key);
      }
      if (!this.hsEntryActive) this.navKey(e);          // base sub_41D855
      return;
    }
    if (st === GAME_STATE.TITLE)  { this.titleNavKey(e); return; }   // sub_41EDFD
    if (st === GAME_STATE.SETUP)  { if (!this.setupWaitSlot) this.navKey(e); return; } // sub_427D4F
    if (st === GAME_STATE.RELOAD_CONFIRM) { this.reloadKeyDown(e); return; }       // sub_429591
    if (st === GAME_STATE.HELP)   { this.navKey(e); return; }
  }

  onKeyUp(e) {
    const st = this.gstate;
    // App handler 0x411A4A (disassembly 0x411A4A-0x411C3D).
    if (st === GAME_STATE.PLAYING) {
      if ((e.key === 'Enter' && this.sceneExitReq === 1)
          || ((e.key === 'Enter' || e.key === 'Escape') && this.sceneExitReq === 2)) {
        // vtable+76 sub_425B00 → 1 (title) or 3 when the end hold is up;
        // arg vtable+84 sub_425B40 = this[15] = 1.
        this.switchScene(this.bossScreen ? null
          : (this.endHoldMs > 0 ? GAME_STATE.HIGHSCORES : GAME_STATE.TITLE), 1);
        return;
      }
      this.gameKeyUp(e);
      return;
    }
    if (e.key === 'Escape' && st !== GAME_STATE.RELOAD_CONFIRM) {
      const next = this.sceneEscTarget();    // scene vtable+76
      if (next === 'close') this.closeApp();
      else if (next) this.switchScene(next, 0);
      return;
    }
    if (st === GAME_STATE.TITLE)  { this.titleKeyUp(e); return; }       // sub_41EF53
    if (st === GAME_STATE.HIGHSCORES) { this.highScoresKeyUp(e); return; } // sub_426F9A
    if (st === GAME_STATE.SETUP)  { this.setupKeyUp(e); return; }       // sub_427D74
    if (st === GAME_STATE.HELP || st === GAME_STATE.EXIT) {             // base sub_41D896
      if (this.baseSceneKey(e)) return;
      if (e.key === 'Enter' || e.key === ' ') this.activateFocusedButton();
    }
  }

  // vtable+76 for non-game scenes; null = -5 (stay).
  sceneEscTarget() {
    if (this.gstate === GAME_STATE.EXIT) return 'close';      // sub_428240 → -6 always
    if (this.bossScreen) return null;                         // -5
    switch (this.gstate) {
      case GAME_STATE.TITLE:      return GAME_STATE.EXIT;     // sub_41F5B0 → 6
      case GAME_STATE.HIGHSCORES: return this.hsEntryActive ? null : GAME_STATE.TITLE; // sub_427260
      case GAME_STATE.SETUP:      return this.setupWaitSlot ? null : GAME_STATE.TITLE; // sub_428080
      default:                    return GAME_STATE.TITLE;    // sub_41DB70 → 1
    }
  }

  // Game scene WM_KEYDOWN sub_420507 (IDA:14606).
  gameKeyDown(e) {
    if (this.escDialog) {
      switch (e.key) {
        case 'Enter':
          if (this.escChoice === 0) this.sceneExitReq = 1;
          // fall through
        case 'Escape':
          this.escDialog = false;
          this.gameResume();                  // vtable+72 sub_420365
          break;
        case 'ArrowLeft':  if (this.escChoice === 1) this.escChoice = 0; break;
        case 'ArrowRight': if (this.escChoice === 0) this.escChoice = 1; break;
      }
      return;
    }
    if (this.bossScreen) {
      if (e.key !== 'Escape') this.setBossScreen(false);
      return;
    }
    if (e.key === 'Escape') {
      if (this.demoMode) { this.sceneExitReq = 2; this.escDialog = false; }
      else { this.escDialog = true; }
      this.audio.stopGameSfx();               // vtable+56 sub_42038C
      this.gamePause();                       // vtable+68 sub_42033E
    } else if (vkIsBossKey(e)) {
      this.setBossScreen(true);               // this[113] + vtable+56/+68
    } else if (vkIsMuteKey(e)) {
      this.toggleMuteKey();
    }
    // LABEL_41 (IDA:14720-14731): every keydown reaches the Sven controller:
    // +136 = key, +140 = sub_433AE6(key); not during the end hold (this[114])
    // or in demo (Sven +200). Sven resolves it on its next tick (sub_434852).
    if (this.sven && !(this.endHoldMs > 0) && !this.demoMode) {
      this.sven.keyFlag = true;               // +136
      this.svenHeldAction = this.actionForCode(e.code || e.key);   // +140
    }
  }

  // Game scene WM_KEYUP sub_42082B (IDA:14739).
  gameKeyUp(e) {
    const code = e.code || e.key;
    if (this.endHoldMs > 0) {
      if (e.key === 'Enter') this.skipEndHold();   // 0x402(3, this[15])
      return;
    }
    if (this.sven && !this.demoMode) {
      const action = this.actionForCode(code);
      if (action === 4) this.svenActionReleased = true;          // +148 = 1
      else if (action === this.svenHeldAction) this.svenHeldAction = -1;
    }
  }

  // Game scene pause/resume (vtable+68 sub_42033E / +72 sub_420365): Sven
  // timers (sub_438ECF/sub_438F26) + base pause with its own counter this[16]
  // (game_level.js scenePause/sceneResume).
  gamePause()  { this.scenePause(); }
  gameResume() { this.sceneResume(); }

  // Boss key: this[24] (game this[113]) set, then vtable+56 and vtable+68;
  // any non-Esc key clears it and calls vtable+72 (sub_41D8FC / sub_420507).
  setBossScreen(on) {
    this.bossScreen = on;
    if (on) { this.sceneStopSound(); this.activeScenePause(); }
    else this.activeSceneResume();
  }

  // Scene vtable+56 (stop sounds).
  sceneStopSound() {
    switch (this.gstate) {
      case GAME_STATE.PLAYING: this.audio.stopGameSfx(); return;      // sub_42038C
      case GAME_STATE.TITLE:   this.audio.stop('easteregg'); return;  // sub_41F56F (this[8] stop: +68 below)
      case GAME_STATE.HELP:                                           // sub_4274BD
      case GAME_STATE.SETUP:   this.audio.pauseMusic(); return;       // sub_42805F: stop MenuSound
      // Top scores sub_4271F8 (IDA:17760-17773): stop TopScoreSound this[8],
      // BushSound this[27] and GameSound this[39]. Resume (+72, base sub_41CBB4)
      // restarts only this[8], so BushSound stays off until the next enter.
      case GAME_STATE.HIGHSCORES: this.audio.stopHighScoreSounds(); return;
    }
  }
  // Scene vtable+68: game sub_42033E, others base sub_41CB4E (IDA:12640).
  activeScenePause() {
    if (this.gstate === GAME_STATE.PLAYING) { this.gamePause(); return; }
    if (this._scenePauseCnt < 0) this._scenePauseCnt = 0;
    if (!this._scenePauseCnt) {
      if (this.sceneHasSound()) this.audio.pauseMusic();             // this[8] +36
      this._sceneRemainMs = this.sceneDeadline - performance.now();  // this[10] = this[9] - now
    }
    ++this._scenePauseCnt;
  }
  // Scene vtable+72: game sub_420365, others base sub_41CBB4 (IDA:12656).
  activeSceneResume() {
    if (this.gstate === GAME_STATE.PLAYING) { this.gameResume(); return; }
    if (this._scenePauseCnt < 0) this._scenePauseCnt = 0;
    if (this._scenePauseCnt > 0) {
      if (this.sceneHasSound()) this.audio.resumeMusic();            // !byte_49AFCC && this[8]: +40
      this.sceneDeadline = this._sceneRemainMs + performance.now();  // this[9] = this[10] + now
      --this._scenePauseCnt;
    }
  }
  // Scene sound this[8] (sub_41CE9A 4th arg): MenuSound (title, IDA:13725),
  // TopScoreSound (IDA:17348); 0 for help, setup, exit, reload, game.
  sceneHasSound() {
    return this.gstate === GAME_STATE.TITLE || this.gstate === GAME_STATE.HIGHSCORES;
  }

  // WM_ACTIVATEAPP sub_4115B9 (IDA:8012-8068). Off: scene 0 (loading) or 7 →
  // WM_CLOSE, else kill the timer (sub_410BF8(-1)) and vtable+68. On: re-arm
  // the timer and vtable+72 (scene index > 0 only).
  appActivate(on) {
    if (this.appClosed || on === this._appActive) return;
    this._appActive = on;
    // DirectSound SetCooperativeLevel(DSSCL_NORMAL) (IDA:27684), buffers made
    // without GLOBALFOCUS/STICKYFOCUS (dwFlags 0x100E2, IDA:27768): the app's
    // sound buffers are inaudible while its window is inactive, and keep
    // playing. The MP3 music buffers use the same flags (sub_43C855
    // IDA:27770), so music is focus-muted too (not paused).
    this._setSfxAudible(on);
    if (!on) {
      // Loading (scene 0): the original posts WM_CLOSE. Not ported: a blur
      // during the asset download would end the web page. Loading has no tick.
      if (this.gstate === GAME_STATE.LOADING) return;
      this._suspended = true;
      this.activeScenePause();
    } else if (this._suspended) {
      this._suspended = false;
      this._accMs = 0;                 // timer re-armed: first tick one period later
      this.lastT = performance.now();
      this.activeSceneResume();
    }
  }
  // SFX bus (audio.js masterGain) and the scene music elements (which bypass
  // it; audio.setMusicAudible mutes without pause/rewind, R4-r7-439000-01).
  _setSfxAudible(on) {
    const g = this.audio.masterGain;
    if (g) g.gain.value = on ? 1 : 0;
    this.audio.setMusicAudible(on);
  }


  //--- Scene manager ------------------------------------------------------
  // sub_41179D (IDA:8071): leave old scene (vtable+64), enter new (vtable+60)
  // with (previous, arg). `arg` = lParam of msg 0x402.
  // From inside a timer tick the switch is only posted (0x402 PostMessageA,
  // IDA:13380 / 16213 / 18935): the tick finishes and flips first (tick()).
  // Input handlers run between ticks, where posting and handling coincide.
  switchScene(next, arg = 0) {
    if (!next || this.appClosed) return;
    if (this._inTick) { this._posted.push({ next, arg }); return; }
    const prev = this.gstate;
    this.leaveScene(prev, next);
    this.gstate = next;
    this._rearmTimer();                    // timer killed and re-armed (sub_410BF8)
    // sub_41179D kills the timer (IDA:8097); the screen keeps the old image
    // until the new scene's first timer tick flips one.
    this._awaitFirstTick = true;
    this._drawList = null;
    this.bossScreen = false;
    this._scenePauseCnt = 0;               // sub_41C9F8 this[16] = 0 (IDA:12616)
    this.enterScene(next, prev, arg);
    // Base enter sub_41C9F8 (IDA:12594): deadline = now + this[12] s.
    this._sceneRemainMs = 1000 * (SCENE_TIMEOUT_S[next] || 3600);
    this.sceneDeadline = performance.now() + this._sceneRemainMs;
    this._updateCursor();
  }

  leaveScene(st, next) {
    switch (st) {
      case GAME_STATE.PLAYING:   // sub_4202CA (IDA:14543)
        this.audio.stopGameSfx();
        this.escDialog = false;
        this.sceneExitReq = 0;
        this.leaveGameScene();
        break;
      case GAME_STATE.TITLE:     this.titleLeave(next); break;      // sub_41F199
      case GAME_STATE.HIGHSCORES: this.leaveHighScores(); break;     // sub_427125
      case GAME_STATE.SETUP:     this.setupWaitSlot = 0; this.saveKeyBindings(); break;  // sub_427FFD
    }
  }

  enterScene(st, prev, arg) {
    switch (st) {
      case GAME_STATE.TITLE:      this.titleEnter(prev); break;       // sub_41F0EE
      case GAME_STATE.PLAYING:    this.gameEnter(arg); break;         // sub_42006D
      case GAME_STATE.HIGHSCORES: this.highScoresEnter(arg); break;   // sub_427047
      case GAME_STATE.HELP:       this.helpEnter(prev); break;        // sub_4272D0 enter (base)
      case GAME_STATE.SETUP:      this.setupEnter(); break;
      case GAME_STATE.EXIT:       this.exitEnter(prev); break;        // sub_4281AF
      case GAME_STATE.RELOAD_CONFIRM: this.reloadEnter(); break;      // sub_429160
    }
  }

  // Game scene enter sub_42006D. arg: 0 new game, 20 continue at the saved
  // level, 1 demo (title timeout 0x402(-3,1)).
  gameEnter(arg) {
    this.demoMode = arg === 1;
    this.escDialog = false;
    this.escChoice = 0;
    this.sceneExitReq = 0;
    this.bossScreen = false;
    this.svenHeldAction = -1;
    this.audio.playAmbient('game');
    const lvl = arg === 20 ? this.highestLevel : 1;
    this.startGameFromLevel(lvl);
  }

  // sub_42006D a3 == 20 → sub_41281B(map, [2081]) (IDA:14497-14500, 8454-8470):
  // a level < 1 becomes 1; a level >= 1 + level count is not written, so the
  // [2079]/[2080] = 1 of the title leave stays → level 1.
  startGameFromLevel(lvl) {
    const v = Math.trunc(lvl);
    const start = Number.isFinite(v) ? (this.mapInfo.validLevelOrNull(v) ?? 1) : 1;
    this.audio.enable();
    // level-flow: sub_42006D a2 != 2 part. The HUD lives / Esc / exit resets
    // and Sven +200 run from the GAME_LEVEL_HOOKS entry (game_screens.js).
    this.beginGame(start);
  }

  // App WM_CLOSE (exit scene sub_4296B0 / -6 from vtable+76). Posted
  // (PostMessageA 0x10, IDA:19008) when it comes from a tick.
  closeApp() {
    if (this._inTick) { this._posted.push({ next: 'close' }); return; }
    this.appClosed = true;
    this.audio.stopAmbient();
    this.audio.stopGameSfx();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 640, 480);
    canvas.style.cursor = 'default';
  }

  _updateCursor() {
    // sub_41E090 wait cursor (loading); sub_425AE0 / sub_429690 hide it
    // (game, exit, reload); base sub_41DB50 arrow.
    const st = this.gstate;
    canvas.style.cursor = st === GAME_STATE.LOADING ? 'wait'
      : (st === GAME_STATE.PLAYING || st === GAME_STATE.EXIT
         || st === GAME_STATE.RELOAD_CONFIRM) ? 'none' : 'default';
  }


  //--- Loop ---------------------------------------------------------------
  sceneTickHz() {
    return SCENE_TICK_HZ[this.gstate];
  }

  // requestAnimationFrame callback. Fixed-timestep driver: each scene's
  // logic runs off a timer at the scene's rate (timeSetEvent(1000/rate),
  // sub_410BF8 via handler 0x410B02; rate posted by sub_41C9F8, IDA:12610).
  tick(now) {
    if (this.appClosed) return;
    this._noteFrame(now);
    let elapsed = now - this.lastT;
    this.lastT = now;
    if (this._suspended) { requestAnimationFrame(this._tickFn); return; }   // timer killed
    if (!(elapsed > 0)) elapsed = 0;
    this._accMs += elapsed;
    // Period = integer 1000/rate (sub_410BF8 IDA:7804): 50 / 66 / 200 ms.
    const stepMs = Math.trunc(1000 / this.sceneTickHz());
    const slop = this._tickSlopMs(stepMs);
    // Timer events due by this refresh; all are consumed (free-running timer),
    // at most MAX_CATCHUP_TICKS of them tick, the rest are dropped.
    let due = 0;
    if (this._accMs >= stepMs - slop) {
      due = Math.floor((this._accMs - (stepMs - slop)) / stepMs) + 1;
      this._accMs -= due * stepMs;
    }
    const run = Math.min(due, MAX_CATCHUP_TICKS);
    this._inTick = true;
    try {
      for (let i = 0; i < run; i++) {
        this.updateScene(stepMs / 1000, now);
        if (this.appClosed || this._suspended) break;
      }
    } finally { this._inTick = false; }
    if (this.appClosed) return;
    // The image is drawn and flipped only by a timer tick (sub_410940): input
    // handlers between ticks change fields only, shown by the next tick.
    if (run > 0) this.render(now);
    // Messages the tick posted, handled after its Flip (sub_41179D / WM_CLOSE).
    while (this._posted.length && !this.appClosed) {
      const p = this._posted.shift();
      if (p.next === 'close') this.closeApp(); else this.switchScene(p.next, p.arg);
    }
    if (this.appClosed) return;
    requestAnimationFrame(this._tickFn);
  }
  // Refresh-interval estimate (median of the last FRAME_SAMPLES rAF deltas).
  _noteFrame(now) {
    const prev = this._frameT;
    this._frameT = now;
    if (prev === null) return;
    const d = now - prev;
    if (!(d > 0)) return;
    this._frameDts.push(d);
    if (this._frameDts.length > FRAME_SAMPLES) this._frameDts.shift();
  }
  _tickSlopMs(stepMs) {
    const n = this._frameDts.length;
    if (!n) return FALLBACK_SLOP_MS;
    const s = this._frameDts.slice().sort((a, b) => a - b);
    const med = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
    return Math.min(med / 2, stepMs / 2);
  }
  // sub_410BF8 kill + timeSetEvent(1000/rate) (via 0x403, handler 0x410B02):
  // the next tick comes one full period after this moment. Run by every scene
  // enter (sub_41C9F8 IDA:12610), including a level advance (sub_42006D ends
  // in sub_41C9F8).
  _rearmTimer() {
    this._accMs = 0;
    this.lastT = performance.now();
  }

  // Draw dispatcher, run once after each timer tick (no state changes here).
  render(now) {
    if (this._suspended || this._awaitFirstTick) return;
    // Exit scene sub_4281D8 has no vtable+24 boss check (boss never drawn).
    if (this.bossScreen && this.gstate !== GAME_STATE.EXIT
        && !(this.gstate === GAME_STATE.HIGHSCORES && this.hsEntryActive)) {
      this.drawBossScreen();           // vtable+24 sub_41DAAB / game +452
      return;
    }
    switch (this.gstate) {
      case GAME_STATE.LOADING:        return;
      case GAME_STATE.TITLE:          this.drawTitle();          return;
      case GAME_STATE.HIGHSCORES:     this.drawHighScores();     return;
      case GAME_STATE.HELP:           this.drawHelpScene();      return;
      case GAME_STATE.SETUP:          this.drawSetup();          return;
      case GAME_STATE.EXIT:           this.drawExit();           return;
      case GAME_STATE.RELOAD_CONFIRM: this.drawReloadConfirm();  return;
    }
    // Game scene sub_421856 (IDA:15488-15495, 16184-16191).
    if (this.escDialog || this.sceneExitReq === 1) { this.drawEscDialog(); return; }
    if (this._transFirstFrame) { this.drawLevelTransitionFirst(); return; }
    // The tick that brings +608 to 0 still draws (0/5)%2 → washed (IDA:16186-16191).
    if (this.levelTransitionTicks > 0 || this._transLastFrame) { this.drawLevelTransition(); return; }
    this.draw();
  }

  // One logic tick of the current scene. Switches it starts are posted
  // (switchScene / closeApp while _inTick), so the whole tick runs.
  updateScene(dt, now) {
    this._awaitFirstTick = false;
    if (this.gstate === GAME_STATE.PLAYING) { this.updateGameplay(dt, now); return; }
    // vtable+24 returns 1: scene tick skipped (not the exit scene, sub_4281D8).
    if (this.bossScreen && this.gstate !== GAME_STATE.EXIT) return;
    switch (this.gstate) {
      case GAME_STATE.TITLE:      this.titleTick(); break;          // sub_41E1FF
      case GAME_STATE.HIGHSCORES: this.highScoresTick(); break;     // sub_42676B
      case GAME_STATE.SETUP:      this.setupTick(); break;          // sub_427A13
      case GAME_STATE.EXIT:       this.exitTick(); break;           // sub_4281D8
      case GAME_STATE.HELP:       this.buttonsTick(); break;        // sub_42742D
      case GAME_STATE.RELOAD_CONFIRM: this.reloadTick(); break;     // sub_429160
    }
    // Base timeout (sub_41CCBD IDA:12715-12720): this[10] = this[9] - now;
    // < 0 → vtable+96.
    if (!this.appClosed && this.gstate !== GAME_STATE.LOADING) {
      this._sceneRemainMs = this.sceneDeadline - performance.now();
      if (this._sceneRemainMs < 0) this.sceneTimeout();
    }
  }

  sceneTimeout() {
    switch (this.gstate) {
      // Title: 0x402(this[14]=-3 → next scene 2, this[15]=1) = demo game.
      case GAME_STATE.TITLE:          this.switchScene(GAME_STATE.PLAYING, 1); return;
      case GAME_STATE.EXIT:           this.closeApp(); return;   // sub_4296B0
      case GAME_STATE.RELOAD_CONFIRM: this.closeApp(); return;   // sub_4296B0
      // Base sub_41DBA0: 0x402(-3, 0) = next scene index (after 3600 s).
      case GAME_STATE.HIGHSCORES:     this.switchScene(GAME_STATE.HELP, 0); return;
      case GAME_STATE.HELP:           this.switchScene(GAME_STATE.SETUP, 0); return;
      case GAME_STATE.SETUP:          this.switchScene(GAME_STATE.EXIT, 0); return;
    }
  }

  // One 20 Hz gameplay tick (game scene sub_421856, IDA:15486-15628).
  updateGameplay(dt, now) {
    // +452 boss screen / +24,+20 Esc dialog: only that is drawn, nothing ticks.
    if (this.bossScreen || this.escDialog || this.sceneExitReq === 1) return;
    // Gameplay tick counter: counts unpaused game-scene ticks (20 Hz).
    this.tickCount++;
    this._transFirstFrame = false;
    // +608 level-transition blink: only the transition runs (IDA:16184-16191).
    if (this.levelTransitionTicks > 0) {
      this.tickLevelTransition();
      this._transLastFrame = this.levelTransitionTicks === 0;
      return;
    }
    this._transLastFrame = false;
    this.tickWorld(dt);
  }

  // Members of the game scene's list this[1], in the original insertion
  // order: sub_420C51 → sub_413D74 sheep (map scan, row-major, IDA:8946)
  // then the mermaid (IDA:8983); Sven's init sub_434443 adds the Fight cloud
  // dword_49BB34 (IDA:24047) before Sven itself (IDA:14999); dog (15011),
  // shepherd (15023), the 7 mushroom slots (15037), the UFO (15080), the 3
  // depth bushes (15125); lambs sub_41D171 (IDA:12997) when they spawn.
  buildSceneList() {
    const L = [];
    for (const sh of this.sheeps) L.push(sh);
    if (this.mermaid) L.push(this.mermaid);
    if (this.sven) {
      if (this.sven.fightEntity) L.push(this.sven.fightEntity);
      L.push(this.sven);
    }
    for (const dog of this.dogs) L.push(dog);
    for (const shep of this.shepherds) L.push(shep);
    for (const m  of this.mushrooms) L.push(m);
    if (this.ufo) L.push(this.ufo);
    for (const b of this.depthBushes || []) L.push(b);
    for (const lb of this.lambs || []) L.push(lb);
    return L;
  }
  // The persistent list (CObArray, sorted in place every tick so each sort
  // starts from the previous order). Rebuilt when a level is (re)loaded
  // (sub_42006D → sub_420C51); objects that appeared since (lambs) are
  // appended (sub_467E51), objects gone are removed keeping the order
  // (RemoveAt, lamb cleanup sub_424B7F).
  _syncSceneList() {
    if (!this._sceneList || this._sceneListLevel !== this.level) {
      this._sceneList = this.buildSceneList();
      this._sceneListLevel = this.level;
      return this._sceneList;
    }
    const want = this.buildSceneList();
    const wantSet = new Set(want);
    const L = this._sceneList.filter(e => wantSet.has(e));
    const have = new Set(L);
    for (const e of want) if (!have.has(e)) L.push(e);
    this._sceneList = L;
    return L;
  }
  // CompareFunction (IDA:12744): z (vtable+32) then x (vtable+20); -1/0/1.
  sceneCompare(a, b) {
    const za = this.entityDepth(a), zb = this.entityDepth(b);
    if (za < zb) return -1;
    if (za !== zb) return 1;
    const xa = this.entityDepthX(a), xb = this.entityDepthX(b);
    return xa < xb ? -1 : (xa !== xb ? 1 : 0);
  }
  _lambCleanup() {
    if (!this.lambs || !this.lambs.length) return;
    const gone = this.lambs.filter(l => l.done);
    if (!gone.length) return;
    this.lambs = this.lambs.filter(l => !l.done);
    if (this._sceneList) {
      const g = new Set(gone);
      this._sceneList = this._sceneList.filter(e => !g.has(e));
    }
  }
  // Objects whose list vtable+36 runs logic (sub_41CCBD): sheep sub_42AE87,
  // mushrooms, mermaid sub_41902E, lamb tweens sub_43955A. Sven/dog/shepherd/
  // UFO logic runs in their controllers (IDA:15497-15505).
  _sceneListTicks(e) {
    return e instanceof Sheep || e instanceof Mushroom || e instanceof Lamb || e === this.mermaid;
  }
  // Draw filter of the list objects (hidden objects draw nothing).
  _sceneListVisible(e) {
    if (e instanceof Sheep) return !e.caught;
    if (e instanceof Mushroom) return !e.consumed;
    if (e === this.mermaid || e === this.ufo) return e.isOnField();
    return true;
  }

  // The scene tick proper (sub_421856 normal branch). Also run once by the
  // level transition setup (sub_4259FF calls vtable+16 into surface 150).
  // Ticks and draws in the original's interleaved order: the world image
  // (lake, clouds, background, puddles, UFO beam, list) is built into
  // _worldCanvas here, each list object drawn right after its own tick;
  // bushes and HUD are drawn by draw() from this tick's HUD fields.
  tickWorld(dt = 1 / GAME_TICK_HZ) {
    const g = this._worldG;
    // IDA:15497-15505: Sven sub_434852, dog sub_402A9C, shepherd sub_4306AF,
    // UFO driver sub_424029.
    this.sven.update();
    for (const dog of this.dogs) dog.update();
    for (const shep of this.shepherds) shep.update();
    if (this.ufo) this.ufo.update(dt, this);
    // IDA:15506-15511: pool > 90 % (once per level, +484) → +30 and lambs.
    if (!this.lambSpawned && Math.trunc(100 * this.pool / this.poolMax) > 90) {
      this.addScore(30);
      this.spawnLambs();
    }
    // sub_41CDC6 (IDA:15513): qsort of the scene list with the positions of
    // this moment (after Sven/dog/shepherd moved, before the list objects).
    const list = this._syncSceneList();
    msvcQsort(list, (a, b) => this.sceneCompare(a, b));
    this._drawList = list.slice();             // this tick's order (tick + draw)
    // Full clear: invisible (GameBkgnd has no key pixels outside the lake).
    g.fillStyle = '#000';
    g.fillRect(0, 0, 640, 480);
    this.cloudTick();                          // clouds drawn, then moved (IDA:15514-15532)
    this.drawLake(g);                          // lake fill + Clouds at the pre-move position
    // IDA:15535-15597: re-arms one of the 7 pooled slot objects (items.js), which
    // keeps its old index in this tick's list (z = y - 10 from the next sort).
    this.tickMushroomSpawner();
    g.drawImage(this.bg, 0, 0);                // GameBkgnd this[7] +36 (IDA:15596-15597)
    this.drawPuddles(g);                       // dword_49B070 i = 9..0 (IDA:15598-15603)
    if (this.ufo) this.ufo.drawUnder(g, this); // sub_43A74A if +472 (IDA:15604)
    // sub_41CCBD (IDA:15609, 12709-12720): vtable+36 of every list object in
    // the sorted order = its tick, then its draw; then the level clock
    // (vtable+96 on expiry).
    for (const e of this._drawList) {
      if (this._sceneListTicks(e)) e.update();
      if (this._sceneListVisible(e)) {
        e.draw(g);
        // Saint-Disc is Sven's sub-sprite (game_items.js, off_495F30).
        if (e === this.sven) this.drawSaintHalo(g);
      }
    }
    this.tickLevelClock();
    // IDA:15612-15613: lamb cleanup sub_424B7F (finished CTweens removed
    // from the list) before the GameSound countdown (IDA:15614-15624).
    this._lambCleanup();
    // An expired end hold only posted 0x402 (sub_423CEE IDA:16207-16213, this[114]
    // kept until the next enter IDA:14514): the tick continues with the hold up.
    // Area hooks (see audit/OWNERSHIP.md): the GameSound chirp (audio.js).
    for (const fn of GAME_TICK_HOOKS) fn.call(this);
    // Level complete (IDA:15626-15628) loads the next level and renders its
    // first frame (sub_4259FF); the frame flipped by this tick still shows the
    // old level's background and list (drawn by sub_41CCBD before), with the
    // bushes and HUD drawn after. Keep that part of the old level.
    if (!this.endHoldMs && this.sheepRemaining === 0 && !(this.levelTransitionTicks > 0)) {
      if (!this._transOldWorld) {
        this._transOldWorld = document.createElement('canvas');
        this._transOldWorld.width = 640; this._transOldWorld.height = 480;
      }
      this._transOldWorld.getContext('2d').drawImage(this._worldCanvas, 0, 0);
      this._transOldWorldValid = true;
    } else {
      this._transOldWorldValid = false;
    }
    this.tickLevelEnd();                       // IDA:15626-15628, Time SFX IDA:16113
    this.hudTick();                            // HUD block IDA:15637-15683 (score_table, lives, +308)
  }


  // Depth key: CompareFunction (IDA:12744) sorts by z (vtable+32, the
  // anchor y; base setPos sub_401800 sets z from y) then by x. Classes with a
  // setZ override expose _depthY/_depthX (e.g. Mushroom z = y - 10, 0x406DA0).
  entityDepth(e) {
    return e._depthY !== undefined ? e._depthY : e.depthY();
  }
  entityDepthX(e) {
    return e._depthX;
  }


  // Game scene draw, in the order of sub_421856 (IDA:15513-16180).
  draw() {
    this.drawWorld();
    this.drawForegroundBushes();           // off_493D78 (IDA:15629-15636)
    this.drawHud();                        // clock, score, lives, icons, end overlay, text
  }
  // Lake, clouds, background, puddles, UFO beam and the sorted list, as built
  // by this tick's tickWorld.
  drawWorld() {
    ctx.drawImage(this._worldCanvas, 0, 0);
  }
}
