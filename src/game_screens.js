//=== Game methods: game_screens (prototype mixin) ===============================
// Non-game scenes, buttons, HUD and game-scene overlays.
// Owner: loop-render-hud-screens (see audit/OWNERSHIP.md).

// GDI text: CreateFontA(h, 0,0,0, 700, …, "Comic Sans MS") (face at 0x493EA8,
// IDA:14384 sub_472F04(24,…,700)). A positive LOGFONT height is the cell
// height; Comic Sans MS cell = (winAscent 2257 + winDescent 597) / 2048 em.
const GDI_FACE = '"Comic Sans MS", "Comic Sans", cursive';
const GDI_CELL_EM = (2257 + 597) / 2048;
const GDI_ASCENT = 2257 / (2257 + 597);
const CRIMSON = '#AD0D27';               // COLORREF 0x270DAD
// DrawTextA flags.
const DT_CENTER = 0x1, DT_RIGHT = 0x2, DT_VCENTER = 0x4, DT_BOTTOM = 0x8,
      DT_SINGLELINE = 0x20, DT_NOCLIP = 0x100;

// Title buttons, table off_493C60 (5 × {name, x, y, flip, cmd}).
const TITLE_BUTTONS = [
  ['BtnStart',     27, 434, 33101],
  ['BtnHelp',     165, 434, 33102],
  ['BtnTopScores',313, 434, 33103],
  ['BtnExit',     540, 434, 57665],
  ['BtnSetup',    160, 458, 33105],
];
const CMD = Object.freeze({
  START: 33101, HELP: 33102, TOPSCORES: 33103, EXIT: 57665, MAINMENU: 33104,
  SETUP: 33105, KANA: 33106, SLOT0: 33501, STDKEYS1: 33506, STDKEYS2: 33507,
});
// Setup key slots: positions dword_4942B0, sprites off_4942D8, cmds
// dword_4942EC, frame counts dword_494300, flip dword_494314, text rect
// rcSrc (0,0,100,30) at 0x494328 offset by dword_494338 (all read from Sven.exe).
const SETUP_SLOTS = [
  { x: 455, y: 80,  sprite: 'Sven_walk02', frames: 14, flip: false, tx: 440, ty: 155 },
  { x: 155, y: 80,  sprite: 'Sven_walk02', frames: 14, flip: true,  tx: 140, ty: 155 },
  { x: 155, y: 300, sprite: 'Sven_walk01', frames: 14, flip: false, tx: 140, ty: 365 },
  { x: 455, y: 300, sprite: 'Sven_walk01', frames: 14, flip: true,  tx: 440, ty: 365 },
  { x: 290, y: 155, sprite: 'shag04',      frames: 5,  flip: false, tx: 285, ty: 265 },
];
// Bushes: off_493D78 foreground (drawn after entities) and off_493DA8
// depth-sorted objects with hotspot 12-h (IDA:15090-15118, 15629-15636).
const FG_BUSHES    = [['GameBush1', 312, 389], ['GameBush4', 0, 389]];
const DEPTH_BUSHES = [['GameBush2', 363, 5], ['GameBush3', 498, 0], ['GameBush5', 10, 0]];
// sub_401C8E for a full-range (start 0, end n), loops-0 animator: the float
// sum is taken in double, truncated, the fraction kept as float, the frame
// wrapped, and the position stored back as float32 (IDA:464-505).
const TITLE_ANIM_SPEED   = Math.fround(0.6);   // 1058642330 (IDA:13932)
const HS_BUSH_ANIM_SPEED = Math.fround(0.3);   // 1050253722 (IDA:17353)
function f32AnimAdvance(pos, speed, n) {
  const v2 = pos + speed;
  const v5 = Math.fround(v2);
  let v4 = Math.trunc(v2);
  const frac = Math.fround(v5 - v4);
  if (v4 >= n) { do v4 -= n; while (v4 >= n); }
  return { frame: v4, pos: Math.fround(v4 + frac) };
}

// Title list CompareFunction (IDA:12744): z = y (vtable+32), then x (vtable+20).
function flockCompare(a, b) {
  return a.y < b.y ? -1 : a.y !== b.y ? 1 : a.x < b.x ? -1 : a.x !== b.x ? 1 : 0;
}

Object.assign(Game.prototype, {

  //--- Text ---------------------------------------------------------------
  // DrawTextA emulation for a single line in rect [l,t,r,b] with LOGFONT
  // height h (bold Comic Sans MS).
  gdiFont(h) { return `bold ${(h / GDI_CELL_EM).toFixed(2)}px ${GDI_FACE}`; },
  gdiTextWidth(text, h) {
    ctx.save(); ctx.font = this.gdiFont(h);
    const w = ctx.measureText(text).width; ctx.restore();
    return w;
  },
  drawText(text, l, t, r, b, flags, h, color) {
    ctx.save();
    ctx.font = this.gdiFont(h);
    ctx.fillStyle = color;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    if (!(flags & DT_NOCLIP)) { ctx.beginPath(); ctx.rect(l, t, r - l, b - t); ctx.clip(); }
    const w = ctx.measureText(text).width;
    let x = l;
    if (flags & DT_CENTER) x = l + Math.trunc((r - l - w) / 2);
    else if (flags & DT_RIGHT) x = r - w;
    let top = t;
    if (flags & DT_VCENTER) top = t + Math.trunc((b - t - h) / 2);
    else if (flags & DT_BOTTOM) top = b - h;
    ctx.fillText(text, x, top + h * GDI_ASCENT);
    ctx.restore();
  },


  //--- Loading scene (sub_41DDBB, IDA:13442) -------------------------------
  // Black fill, then BITMAP 143 (b/w) rows [0,split) and BITMAP 144 (colour)
  // rows [split,H) centred, split = H*(total-cur)/total in int32 (imul/idiv).
  // The final 0x7FFFFFFF step leaves cur wrapped negative (game.js load), so
  // split is out of range: both BltFast source rects are invalid and fail,
  // only the black fill shows.
  _drawLoadingBar(current, total) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 640, 480);
    const bw  = this._loadingBwImg;
    const col = this._loadingColImg;
    const W = bw.naturalWidth, H = bw.naturalHeight;     // 180 × 337
    const dx = Math.trunc((640 - W) / 2);                // InflateRect (IDA:13479)
    const dy = Math.trunc((480 - H) / 2);
    const split = Math.trunc(Math.imul(H, (total - current) | 0) / total);
    if (split < 0 || split > H) return;
    if (split > 0) ctx.drawImage(bw, 0, 0, W, split, dx, dy, W, split);
    if (split < H) ctx.drawImage(col, 0, split, W, H - split, dx, dy + split, W, H - split);
  },


  //--- Scene objects (created once, like the app init sub_4110BE) ---------
  initScenes() {
    const mk = (name, x, y, cmd, ranges) => ({
      name, x, y, cmd, sheet: this.assets[name], ranges,
      state: 0, pressed: false, visible: true, anim: 0,
    });
    // Frame ranges [from, to) per state: normal (+52), hover (+60),
    // pressed (+68), focused (+84). sub_41E34D / sub_427351 / sub_4262C2 / sub_42775D.
    const titleR = { n: [0, 1], h: [0, 1], p: [2, 3], f: [1, 2] };
    const helpR  = { n: [0, 1], h: [0, 1], p: [1, 2], f: [1, 2] };
    this.sceneButtons = {
      [GAME_STATE.TITLE]: TITLE_BUTTONS.map(([n, x, y, c]) => mk(n, x, y, c, titleR)),
      [GAME_STATE.HELP]:  [mk('BtnMainMenuHelp', 23, 446, CMD.MAINMENU, helpR)],     // off_494260
      [GAME_STATE.HIGHSCORES]: [mk('BtnMainMenuHelp', 24, 447, CMD.MAINMENU, titleR)], // off_494180
      [GAME_STATE.SETUP]: [                                                           // off_494360
        mk('BtnMainMenuHelp', 23, 446, CMD.MAINMENU, helpR),
        mk('BtnStandardKeys1', 50, 198, CMD.STDKEYS1, helpR),
        mk('BtnStandardKeys2', 514, 198, CMD.STDKEYS2, helpR),
      ],
    };
    this.btnFocus = -1;                       // scene this[23]
    // Setup slot buttons (sub_42775D IDA:18000-18040): normal [0,1),
    // hover [0,frames) animated, pressed [0,1).
    this.setupSlots = SETUP_SLOTS.map((s, i) => Object.assign(
      mk(s.sprite, s.x, s.y, CMD.SLOT0 + i, { n: [0, 1], h: [0, s.frames], p: [0, 1], f: [0, 1] }),
      { flip: s.flip, tx: s.tx, ty: s.ty }));
    this.setupWaitSlot = 0;                   // this[45]: slot index + 1, 0 = none
    this.setupBlink = 0;                      // this+184
    this.reloadChoice = 20;                   // reload this[29] (ctor IDA:18703)
    this.exitTicks = -1;                      // exit this[11] (ctor IDA:18286)
    // Title (sub_41E0F0 / sub_41E34D).
    this.kanaIdx = 1;                         // this[27] (IDA:13542)
    this.kanaCard = null;                     // this[28]
    this.kanaPause = 0;                       // dword_49AFF0
    this.kanaReady = false;                   // +128
    this.flockOffscreen = false;              // +129
    // sub_401950 animators: +44 float position, +32 int frame (drawn, then
    // advanced by sub_401C8E). Title speed 0.6f (IDA:13932), HighScoreBush
    // 0.3f (IDA:17353); full range, loops 0.
    this.titleFrame = Math.fround(0); this.titleFrameIdx = 0;
    this.hsBushFrame = Math.fround(0); this.hsBushFrameIdx = 0;
    this.hsCaret = 0;                         // top-scores this[37]
    this.initFlock();
    // Game scene HUD state (sub_41F643 ctor IDA:14309-14330).
    this.cloudX = 190; this.cloudY = 376; this.cloudCnt = 30;   // +188/+192/+196
    this.cloudDrawX = this.cloudX; this.cloudDrawY = this.cloudY;
    this.hudFrame = -1;                       // +308
    this.hudSaintMs = 0; this.hudModeMs = 0;  // [49]/[48] - GetTickCount() of this tick (hudTick)
    // score_table anim this[57] (dword_49BA18): frozen at frame 0, range
    // (1,0,1) (IDA:14864-14867); speed 1.0 (sub_401950 this[10]=1.0f).
    this.scoreTableFrame = 0;                 // anim this[8]
    this.scoreTableRun = false;               // !byte +36
    this.scoreTableDraw = 0;
    this.hudLivesShown = 0;                   // +272 (this[68])
    this.lifeDrop = -1; this.lifeDropX = 0; this.lifeDropY = 0; // +276/+280/+284
    this.lifeFly = -1;  this.lifeFlyX = 0;  this.lifeFlyY = 0;  // +288/+292/+296
    this.puddleRoll = [];
    this.depthBushes = DEPTH_BUSHES.map(([n, x, y]) => {
      const sh = this.assets[n];
      const h = sh ? sh.frameH : 0;
      return { _depthX: x, _depthY: y + h - 12, draw: (g) => { if (sh) sh.drawFrame(g, 0, x, y, false); } };
    });
  },


  //--- Buttons (sub_401000 objects) ---------------------------------------
  currentButtons() { return (this.sceneButtons && this.sceneButtons[this.gstate]) || []; },
  focusButton(i) { this.btnFocus = i; },       // sub_41D69B
  // Base keydown sub_41D855: ← prev (wrap), → next (wrap).
  navKey(e) {
    const n = this.currentButtons().length;
    if (!n) return;
    if (e.key === 'ArrowLeft')  this.btnFocus = this.btnFocus <= 0 ? n - 1 : this.btnFocus - 1;
    if (e.key === 'ArrowRight') this.btnFocus = this.btnFocus + 1 >= n ? 0 : this.btnFocus + 1;
  },
  // sub_41D896: Enter/Space → command of the focused button.
  activateFocusedButton() {
    const b = this.currentButtons()[this.btnFocus];
    if (b) this.runCommand(b.cmd);
  },
  buttonFrame(b, focused) {
    const r = focused ? b.ranges.f : b.state === 1 ? b.ranges.h : b.state === 2 ? b.ranges.p : b.ranges.n;
    const span = Math.max(1, r[1] - r[0]);
    const a = b.drawAnim ?? b.anim;           // frame of the last tick (see buttonsTick)
    return r[0] + (span > 1 ? Math.floor(a) % span : 0);
  },
  drawButton(b, focused) {
    if (!b.visible || !b.sheet) return;
    b.sheet.drawFrame(ctx, this.buttonFrame(b, focused), b.x, b.y, !!b.flip);
  },
  drawButtons() {
    const list = this.currentButtons();
    for (let i = 0; i < list.length; i++) this.drawButton(list[i], i === this.btnFocus);
  },
  // sub_401BDE (IDA:433-461): draw the current frame, then advance it.
  buttonsTick() {
    for (const b of this.currentButtons()) { b.drawAnim = b.anim; b.anim += 1; }
  },
  // Mouse (WM_MOUSEMOVE/LBUTTONDOWN/UP → sub_40124A / sub_4013E3, state
  // machine sub_40158D). type: 'move' | 'down' | 'up'.
  // Returns {inside, cmd}: cmd = the WM_COMMAND to post (state reached 4).
  // sub_401655 on every state change: the frame is kept if inside the new
  // range, else set to its start (anim counter 0 is equivalent here).
  buttonMouse(b, type, x, y) {
    if (!b.visible || !b.sheet) return { inside: false, cmd: 0 };
    const inside = x >= b.x && x < b.x + b.sheet.frameW && y >= b.y && y < b.y + b.sheet.frameH;
    let s;
    if (type === 'move') s = inside ? (b.pressed ? 2 : 1) : (b.pressed ? 1 : 0);
    else if (type === 'down') { b.pressed = inside; s = inside ? 2 : 0; }
    else { s = (b.pressed && inside) ? 4 : 0; b.pressed = false; }
    let cmd = 0;
    if (s !== b.state) {
      if (s === 4) { b.state = 1; cmd = b.cmd; }
      else b.state = s;
      b.anim = 0;
      // Flock Sven: sub_40AC20 copies the state-0 range +52/+56 = (0, 8)
      // (sub_401171) into states 1-3 (this[15..20], IDA:4766-4771), so
      // every state change is vtable+24(0,0,8): range [0,8), unfrozen
      // (sub_401655 v4[36] = 0), current frame kept (0 <= f < 8).
      if (this.flockSven && b === this.flockSven.btn) this.flockSven.idle = false;
    }
    return { inside, cmd };
  },
  // Commands are PostMessage'd (handled after the mouse handler returns).
  onMouse(type, x, y) {
    if (this.appClosed) return;
    const posted = [];
    // sub_41D32F (IDA:13006): no input under the boss screen; one shared flag
    // (sub_4013E3 IDA:160-176): only the first button reaching state 4 posts.
    if (!this.bossScreen) {
      for (const b of this.currentButtons()) {
        const r = this.buttonMouse(b, type, x, y);
        if (r.cmd && !posted.length) posted.push(r.cmd);
      }
    }
    // Setup sub_427EAE (IDA:18176-18191): slots 4..0 via sub_40124A, no boss
    // check, each posts its own command.
    if (this.gstate === GAME_STATE.SETUP) {
      for (let i = 4; i >= 0; i--) {
        const r = this.buttonMouse(this.setupSlots[i], type, x, y);
        if (r.cmd) posted.push(r.cmd);
      }
    }
    // Title sub_41F0A4: the flock member wearing Main_Sven gets the mouse
    // (sub_40124A) after sub_41D32F, without the boss check.
    if (this.gstate === GAME_STATE.TITLE && this.flockSven) {
      const r = this.buttonMouse(this.flockSven.btn, type, x, y);
      if (r.cmd) posted.push(r.cmd);
    }
    for (const c of posted) this.runCommand(c);
  },

  // WM_COMMAND handlers (message map .rdata 0x473898-0x473A48).
  runCommand(cmd) {
    switch (cmd) {
      case CMD.START:     this.switchScene(GAME_STATE.RELOAD_CONFIRM, 0); return; // 0x411DFC → 8
      case CMD.HELP:      this.switchScene(GAME_STATE.HELP, 0); return;           // → 4
      case CMD.TOPSCORES: this.switchScene(GAME_STATE.HIGHSCORES, 0); return;     // → 3
      case CMD.EXIT:      this.switchScene(GAME_STATE.EXIT, 0); return;           // → 6
      case CMD.MAINMENU:  this.switchScene(GAME_STATE.TITLE, 0); return;          // → 1
      case CMD.SETUP:     this.switchScene(GAME_STATE.SETUP, 0); return;          // → 5
      case CMD.KANA:      if (this.gstate === GAME_STATE.TITLE) this.kanaClick(); return; // sub_41F20C
    }
    if (this.gstate === GAME_STATE.SETUP && cmd >= CMD.SLOT0 && cmd <= CMD.STDKEYS2) this.setupCommand(cmd);
  },


  //--- Title scene (sub_41E0F0 / sub_41E34D / sub_41E1FF) ------------------
  // Flock: sub_40B36F(Main_whitesheep, Main_Sven, 33106, 500 steps, (-170,120))
  // and 2 × 3 groups × 3 objects (sub_40AB73 / sub_40AC20 / sub_40ADA8).
  initFlock() {
    const R = (n) => Math.floor(Math.random() * n);
    const flock = [];
    // rand() order (IDA:13774-13800 / 13878-13898): start dy, start dx, end
    // dy, end dx, the frame roll in vtable+44 (sub_40AC20), then the delay.
    const add = (sx, sy, ex, ey, waitFn) => {
      const o = { sx, sy, ex, ey, x: sx, y: sy, state: 1, wait: 0, step: 0, leader: null,
                  flip: sx < ex, sven: false, frame: R(8), idle: false };
      o.wait = waitFn();
      o.btn = { x: 0, y: 0, cmd: CMD.KANA, sheet: null, state: 0, pressed: false, visible: true, anim: 0 };
      flock.push(o);
      return o;
    };
    // Group 1 (IDA:13760-13830): start (555,-75), end (-220,295), per group
    // += (120,155), per member += (50,-45); jitter start (+r175, -r140),
    // end (-r175, +r140); delay rand()%35+1.
    let a = [555, -75, -220, 295];
    for (let i = 0; i < 3; i++) {
      let [s0, s1, e0, e1] = a;
      const grp = [];
      for (let j = 0; j < 3; j++) {
        const sy = s1 - R(140), sx = s0 + R(175);
        const ey = e1 + R(140), ex = e0 - R(175);
        grp.push(add(sx, sy, ex, ey, () => R(35) + 1));
        s0 += 50; s1 -= 45; e0 += 50; e1 -= 45;
      }
      for (let j = 0; j < 3; j++) grp[j].leader = grp[(j + 2) % 3];
      a = [a[0] + 120, a[1] + 155, a[2] + 120, a[3] + 155];
    }
    // Group 2 (IDA:13833-13915): start (-183,-90), end (697,305), per group
    // += (73,155), per member += (-70,-65); jitter start (-r175,-r140),
    // end (+r175,+r140); delay 17*(rand()%19) + rand()%35 + 1.
    a = [-183, 65 - 155, 697, 460 - 155];
    for (let i = 0; i < 3; i++) {
      let [s0, s1, e0, e1] = a;
      const grp = [];
      for (let j = 0; j < 3; j++) {
        const sy = s1 - R(140), sx = s0 - R(175);
        const ey = e1 + R(140), ex = e0 + R(175);
        grp.push(add(sx, sy, ex, ey, () => { const r35 = R(35); return 17 * R(19) + r35 + 1; }));
        s0 -= 70; s1 -= 65; e0 -= 70; e1 -= 65;
      }
      for (let j = 0; j < 3; j++) grp[j].leader = grp[(j + 2) % 3];
      a = [a[0] + 73, a[1] + 155, a[2] + 73, a[3] + 155];
    }
    // sub_41CDC6 right after the 18 adds (IDA:13927).
    msvcQsort(flock, flockCompare);
    this.flock = flock;
    this.flockSven = null;                    // dword_49AF50
  },
  // One flock object tick, sub_40ADA8 (IDA:4788). Steps = dword_49355C = 500,
  // distance window dword_49AF48/4C = (-170, 120).
  flockStep(o) {
    const N = 500, R = (n) => Math.floor(Math.random() * n);
    if (o.state === 2) {
      o.x = Math.trunc((o.step * o.ex + (N - o.step) * o.sx) / N);
      o.y = Math.trunc(((N - o.step) * o.sy + o.step * o.ey) / N);
      if (++o.step <= N) {
        const dx = o.leader.x - o.x, dy = o.leader.y - o.y;
        const closeX = o.flip ? (dx > 0 && dx < 170) : (-170 < dx && dx < 0);
        const closeY = dy > 0 && dy < 120;
        if (closeX || closeY) { o.state = 1; o.idle = true; o.frame = 3; o.wait = R(50) + 20; }
      } else {
        o.step = 0; o.state = 1; o.wait = R(120) + 20;
        o.x = o.sx; o.y = o.sy;
        // sub_401B62 sprite swap: frame reset to 0, anim running (IDA ~4870).
        if (o === this.flockSven) { o.sven = false; this.flockSven = null; o.frame = 0; o.idle = false; }
        else if (!this.flockSven && R(3) === 0) { o.sven = true; this.flockSven = o; o.frame = 0; o.idle = false; }
      }
    }
    if (--o.wait === 0) {
      const dx = o.leader.x - o.x, dy = o.leader.y - o.y;
      const farX = o.flip ? (dx < 0 || dx > 170) : (dx < -170 || dx > 0);
      const farY = dy < 0 || dy > 120;
      if (o.state === 1) {
        // 1→2: +36 = 0; vtable+24(0,0,0) → frame 0, running.
        if (farX && farY) { o.state = 2; o.idle = false; o.wait = -1; o.frame = 0; }
        else o.wait = R(50) + 20;
      } else if (o.state === 2) {
        o.state = 1; o.idle = true; o.frame = 3; o.wait = R(50) + 20;
      }
    }
  },

  titleEnter(prev) {             // sub_41F0EE (IDA:14063)
    this.setMapLevel(1);         // sub_4127C2(map, 1) (IDA:14074)
    this.kanaReady = true;
    this.flockOffscreen = true;
    // sub_41F0EE (IDA:14077-14081): this[8] = 0 around sub_41C9F8 for a2 == 4
    // or 5 → MenuSound is not (re)started from help/setup, but stays this[8]
    // for later +52/+72 (unmute / boss resume).
    if (prev !== GAME_STATE.HELP && prev !== GAME_STATE.SETUP) this.audio.playAmbient('menu');
    else this.audio.scene = 'menu';
    this.focusButton(0);         // BtnStart (33101)
  },
  titleLeave(next) {             // sub_41F199 (IDA:14089)
    this.setMapLevel(1);         // sub_4127C2(map, this[26]) with this[26] = [2079] = 1 (IDA:14099)
    // Leaving to help/setup keeps MenuSound playing; other scenes set their own.
    this.audio.stop('easteregg');           // aCards
    this.kanaCard = null;                   // sub_41F424
    this.kanaReady = true;
  },
  // Title keydown sub_41EDFD (IDA:13954): 0 Start, 1 Help, 2 Top, 3 Exit, 4 Setup.
  titleNavKey(e) {
    const f = this.btnFocus;
    switch (e.key) {
      case 'ArrowLeft':
        if (f === 0) this.btnFocus = 3; else if (f !== 4) this.navKey(e);
        break;
      case 'ArrowUp':   if (f === 4) this.btnFocus = 1; break;
      case 'ArrowRight':
        if (f === 3) this.btnFocus = 0; else if (f !== 4) this.navKey(e);
        break;
      case 'ArrowDown': if (f === 1) this.btnFocus = 4; break;
    }
  },
  // Title keyup sub_41EF53 (IDA:14009): E Exit, H/F1 Help, T TopScores
  // ('S' is taken by mute in sub_41D8FC first).
  // VK codes 'E', 'H', 'p' (VK_F1), 'T' (layout VK, see vkLetter in game.js).
  titleKeyUp(e) {
    if (this.baseSceneKey(e)) return;
    const c = vkLetter(e);
    if (c === 'e') { this.focusButton(3); this.runCommand(CMD.EXIT); }
    else if (c === 'h' || e.code === 'F1') { this.focusButton(1); this.runCommand(CMD.HELP); }
    else if (c === 't') { this.focusButton(2); this.runCommand(CMD.TOPSCORES); }
    else if (e.key === 'Enter' || e.key === ' ') this.activateFocusedButton();
  },
  titleTick() {                  // sub_41E1FF (IDA:13576)
    // sub_41CDC6 qsort (CompareFunction: z = y, then x) of the pre-step
    // positions, then sub_41CCBD: vtable+36 of each object in that order =
    // sub_40B342 → sub_406FE0 (draw the frame, then advance) → sub_40ADA8 (step).
    // The title list (the 18 flock objects, add order IDA:13805/13901) is
    // persistent and qsorted in place (CRT _qsort, msvcQsort in game.js).
    const list = msvcQsort(this.flock, flockCompare).slice();
    const draw = [];
    for (const o of list) {
      draw.push({ o, x: o.x, y: o.y, frame: o.frame, sven: o.sven, flip: o.flip });
      if (!o.idle) o.frame++;                 // idle range (1,3,4) holds frame 3
      this.flockStep(o);
    }
    this.flockDraw = draw;
    const s = this.flockSven;
    if (s) {
      // Hit rect at the current position (sub_4013E3 rect from pos, hotspot (-30,-46)).
      const sh = this.assets['Main_Sven'];
      Object.assign(s.btn, { x: s.x - 30, y: s.y - 46, sheet: sh });
      if (s.x < -30 || s.x > 680 || s.y < -50 || s.y > 530) this.flockOffscreen = true;
    }
    this.titleFrameDraw = this.titleFrameIdx;    // sub_401BDE: draw, then advance
    const ta = f32AnimAdvance(this.titleFrame, TITLE_ANIM_SPEED, this.titleSheet ? this.titleSheet.frames : 1);
    this.titleFrame = ta.pos; this.titleFrameIdx = ta.frame;
    this.kanaTick();
    this.buttonsTick();
  },
  kanaClick() {                  // sub_41F20C (IDA:14111)
    if (!(this.kanaReady && this.flockOffscreen && this.kanaIdx <= 6)) return;
    this.kanaReady = false;
    this.flockOffscreen = false;
    // sub_41F26F (IDA:14132): pre-increment, wrap to 01 when the card is missing.
    ++this.kanaIdx;
    let card;
    for (;;) {
      card = this.assets[`KanaCard${String(this.kanaIdx).padStart(2, '0')}`];
      if (card) break;
      this.kanaIdx = 1;
    }
    this.kanaCard = card;
    this.kanaX = Math.trunc((640 - card.frameW) / 2);
    this.kanaY = -card.frameH;
    this.kanaDraw = null;                     // drawn first by the next kanaTick
    this.kanaT = 0;
    this.audio.play('easteregg');            // aCards_0 (muted check inside play)
  },
  kanaTick() {                   // sub_41F443 (IDA:14211)
    const c = this.kanaCard;
    this.kanaDraw = null;
    if (!c) return;
    this.kanaDraw = { card: c, x: this.kanaX, y: this.kanaY };   // drawn, then moved
    if (this.kanaPause <= 0) {
      const t = ++this.kanaT;
      const p = (((((t * 0.000007 - 0.0015) * t + 0.1207) * t - 4.4381) * t + 69.875) * t - 114.85);
      this.kanaY = Math.trunc(p) - Math.trunc(c.frameH / 2);
      if (t === 48) this.kanaPause = 20;
      if (Math.trunc(c.frameH / 2) + this.kanaY > 480) { this.kanaCard = null; this.kanaReady = true; }
    } else {
      --this.kanaPause;
    }
  },
  drawTitle() {
    ctx.drawImage(this.menuBg, 0, 0);
    // Flock in the order and with the frames of the last titleTick.
    const sheepS = this.assets['Main_whitesheep'], svenS = this.assets['Main_Sven'];
    for (const d of this.flockDraw || []) {
      const sh = d.sven ? svenS : sheepS;
      if (!sh) continue;
      // Hotspot (-30,-46) (sub_40AC20 sub_401D89), flip flag 0x10 when moving right.
      sh.drawFrame(ctx, Math.floor(d.frame) % sh.frames, d.x - 30, d.y - 46, d.flip);
    }
    // Title sprite at (200,145) (sub_401BDE, IDA:13594).
    if (this.titleSheet) this.titleSheet.drawFrame(ctx, (this.titleFrameDraw ?? this.titleFrameIdx), 200, 145, false);
    const k = this.kanaDraw;                  // sub_41F443 (IDA:14215)
    if (k) k.card.drawFrame(ctx, 0, k.x, k.y, false);
    this.drawButtons();
  },


  //--- Help scene (sub_4272D0, 5 Hz) ---------------------------------------
  // Help this[8] = 0: music is only stopped by the leaving scene (sub_41CAD4
  // IDA:12627). From the title MenuSound keeps playing (sub_41F199 skips
  // 4/5); Top Scores (3600 s timeout) stops its sounds in sub_427125.
  helpEnter(prev) {
    if (prev !== GAME_STATE.TITLE) this.audio.playAmbient(null);
    this.focusButton(0);
  },
  drawHelpScene() {
    const help = this.assets['HelpBkgnd'];
    if (help) ctx.drawImage(help.canvas, 0, 0);
    this.drawButtons();
  },


  //--- Setup scene (sub_427510 / sub_42775D / sub_427A13) -----------------
  setupEnter() {
    this.setupWaitSlot = 0;
    this.focusButton(0);
    // SetupBackground has no music arg (IDA:17974): MenuSound continues from the title.
  },
  setupCommand(cmd) {            // sub_427F15 (IDA:18171)
    const menu = this.sceneButtons[GAME_STATE.SETUP][0];
    if (cmd >= CMD.SLOT0 && cmd < CMD.SLOT0 + 5) { this.setupWaitSlot = cmd - CMD.SLOT0 + 1; return; }
    this.keyBindings = (cmd === CMD.STDKEYS1 ? KEY_PRESET_1 : KEY_PRESET_2).slice();
    this.setupWaitSlot = 0;
    menu.visible = true;                      // sub_40702E(btn, 1)
  },
  // Setup keyup sub_427D74 (IDA:18129).
  setupKeyUp(e) {
    if (this.baseSceneKey(e)) return;
    if (!this.setupWaitSlot) {
      if (e.key === 'Enter' || e.key === ' ') this.activateFocusedButton();
      return;
    }
    const code = e.code || e.key;
    const menu = this.sceneButtons[GAME_STATE.SETUP][0];
    const w = this.setupWaitSlot - 1;
    for (let i = 0; i < 5; i++) {
      if (i !== w && this.keyBindings[i] === code) {
        // Duplicate: this slot takes the key, the other one is cleared and
        // becomes the slot being bound; main-menu button hidden.
        this.keyBindings[w] = code;
        this.keyBindings[i] = null;
        this.setupWaitSlot = i + 1;
        menu.visible = false;
        return;
      }
    }
    this.keyBindings[w] = code;
    this.setupWaitSlot = 0;
    menu.visible = true;
  },
  setupTick() {
    if (--this.setupBlink <= -6) this.setupBlink = 15;   // this+184
    this.buttonsTick();
    for (const b of this.setupSlots) { b.drawAnim = b.anim; b.anim += 1; }
  },
  // GetKeyNameTextA stand-in (Windows key names); unbound = string 0x3EE "...".
  keyDisplayName(code) {
    if (!code) return '...';
    const named = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
      Space: 'Space', Enter: 'Enter', NumpadEnter: 'Num Enter', Tab: 'Tab', Backspace: 'Backspace',
      ShiftLeft: 'Shift', ShiftRight: 'Right Shift', ControlLeft: 'Ctrl', ControlRight: 'Right Ctrl',
      AltLeft: 'Alt', AltRight: 'Right Alt', Insert: 'Insert', Delete: 'Delete', Home: 'Home',
      End: 'End', PageUp: 'Page Up', PageDown: 'Page Down', CapsLock: 'Caps Lock',
      Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'",
      Backquote: '`', Backslash: '\\', IntlBackslash: '\\', Comma: ',', Period: '.', Slash: '/',
      NumpadAdd: 'Num +', NumpadSubtract: 'Num -', NumpadMultiply: 'Num *', NumpadDivide: 'Num /',
      NumpadDecimal: 'Num Del', NumLock: 'Num Lock', ScrollLock: 'Scroll Lock', Pause: 'Pause',
      MetaLeft: 'Left Windows', MetaRight: 'Right Windows', ContextMenu: 'Application',
      PrintScreen: 'Prnt Scrn', Escape: 'Esc' };
    // F1..F12 fall through as their code ("F1"…, same as GetKeyNameTextA).
    // US-layout strings; the Russian-layout strings are UNVERIFIED.
    if (named[code]) return named[code];
    let m = /^Key([A-Z])$/.exec(code); if (m) return m[1];
    m = /^Digit(\d)$/.exec(code); if (m) return m[1];
    m = /^Numpad(\d)$/.exec(code); if (m) return 'Num ' + m[1];
    return code;
  },
  drawSetup() {
    const bg = this.assets['SetupBackground'];
    if (bg) ctx.drawImage(bg.canvas, 0, 0);
    this.drawButtons();
    for (let i = 4; i >= 0; i--) this.drawButton(this.setupSlots[i], false);
    for (let j = 0; j < 5; j++) {
      const s = this.setupSlots[j];
      if (this.setupWaitSlot - 1 === j && this.setupBlink <= 0) continue;
      this.drawText(this.keyDisplayName(this.keyBindings[j]), s.tx, s.ty, s.tx + 100, s.ty + 30,
                    DT_CENTER | DT_SINGLELINE | DT_NOCLIP, 24, CRIMSON);   // 0x121
    }
  },


  //--- Top scores scene (sub_426050 / sub_4262C2 / sub_42676B) ------------
  highScoresEnter(arg) {         // sub_427047 (IDA:17702)
    this.enterHighScores(arg === 1);
    this.hsCaret = 0;
    this.audio.playAmbient('topscore');      // TopScoreSound + BushSound
    this.focusButton(0);
  },
  // Keyup sub_426F9A (IDA:17669).
  highScoresKeyUp(e) {
    if (this.hsEntryActive) {
      if (e.key === 'Enter') this.highScoreKey('Enter');
      return;
    }
    if (this.baseSceneKey(e)) return;
    this.runCommand(CMD.MAINMENU);             // any other key → button 0
  },
  highScoresTick() {
    this.hsBushDraw = this.hsBushFrameIdx;   // sub_401BDE: draw, then advance (IDA:17533)
    const bushS = this.assets['HighScoreBush'];
    const ba = f32AnimAdvance(this.hsBushFrame, HS_BUSH_ANIM_SPEED, bushS ? bushS.frames : 1);
    this.hsBushFrame = ba.pos; this.hsBushFrameIdx = ba.frame;
    this.buttonsTick();
    if (this.hsEntryActive) {
      // Caret (IDA:17631-17639): shown while --this[37] >= 0; reset to 2 below -2.
      this.hsCaretOn = --this.hsCaret >= 0;
      if (this.hsCaret < -2) this.hsCaret = 2;
    }
  },
  drawHighScores() {
    const bg = this.assets['TopBkgnd'];
    if (bg) ctx.drawImage(bg.canvas, 0, 0);
    const bush = this.assets['HighScoreBush'];
    if (bush) bush.drawFrame(ctx, (this.hsBushDraw ?? this.hsBushFrameIdx), 447, 345, false);
    this.drawButtons();
    if (this.hsEntryActive) {
      const slot = this.assets['TopBackSlot'];
      if (slot) slot.drawFrame(ctx, 0, 258, 327, false);
    }
    // Rows (IDA:17562-17595): Comic Sans 22, rect (435,150,630,180), offset
    // (dx,32) per row with dx = -12, -15, -21, -30.
    const list = loadHighScores();
    let l = 435, t = 150, r = 630, b = 180, dx = -12;
    let color = '#000';
    for (let i = 0; i < 5; i++) {
      const e = list[i];
      color = i === this.hsEntryRank ? CRIMSON : '#000';
      const s = String(e.score);
      this.drawText(s, l, t, r, b, DT_RIGHT | DT_BOTTOM | DT_SINGLELINE | DT_NOCLIP, 22, color); // 0x12A
      const w = Math.ceil(this.gdiTextWidth(s, 22));
      this.drawText(`${cp1251Display(e.name)} . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .`,
                    l, t, r - (w + 10), b, DT_BOTTOM | DT_SINGLELINE, 22, color);   // 0x28
      l += dx; r += dx; t += 32; b += 32;
      dx += -3 * (i + 1);
    }
    if (this.hsEntryScore >= 0) {
      // _snprintf(Str, 7u, "%d") (IDA:17603): 7 characters, unterminated when
      // the number has >= 7. UNVERIFIED: the stack bytes DrawTextA reads past
      // them (Str[7], then a RECT) for >= 1e6.
      this.drawText(String(this.hsEntryScore).slice(0, 7), 244, 50, 600, 360, DT_RIGHT | DT_SINGLELINE, 22, color); // 0x22
    }
    if (this.hsEntryActive) {
      const txt = cp1251Display(this.hsEntryName || '') + (this.hsCaretOn ? '|' : '');
      this.drawText(txt, 265, 327, 487, 360, DT_SINGLELINE, 22, color);           // 0x20
    }
  },


  //--- Exit scene (sub_4280F0 / sub_4281AF / sub_4281D8) ------------------
  // Exit this[8] = 0 (sub_4281AF IDA:18304). The title leave stops MenuSound
  // (sub_41F199, next scene not 4/5); from Setup (3600 s timeout) it keeps playing.
  exitEnter(prev) {
    if (prev === GAME_STATE.TITLE) this.audio.playAmbient(null);
  },
  exitTick() {
    // sub_41CCBD --this[11]; at -13 play ByeBye unless muted (IDA:18315).
    if (--this.exitTicks === -13) this.audio.play('byebye');
  },
  drawExit() {
    const bg = this.assets['UfoBkgnd'];
    if (bg) ctx.drawImage(bg.canvas, 0, 0);
  },


  //--- "Continue at level N?" scene (sub_428E10 / sub_429160) -------------
  reloadEnter() {
    this.audio.playAmbient(null);            // ReloadBackground has no music arg
  },
  reloadReady() { return this.highestLevel > 1; },   // dword_49AF9C > 1
  reloadTick() {                 // sub_429160 (IDA:18816)
    if (this.reloadChoice !== 10 && this.reloadChoice !== 20) this.reloadChoice = 20;
    // dword_49AF9C <= 1: this+116 = 0, post 0x402(2, 0) — start at level 1
    // (IDA:18929-18935). The 0 stays until the next visit's first tick.
    if (!this.reloadReady()) { this.reloadChoice = 0; this.switchScene(GAME_STATE.PLAYING, 0); }
  },
  // Keydown sub_429591 (IDA:18941).
  reloadKeyDown(e) {
    if (e.key === 'Enter') {
      if (this.reloadChoice === 10) this.reloadChoice = 0;
      const arg = this.reloadChoice;
      this.reloadChoice = 20;
      this.switchScene(GAME_STATE.PLAYING, arg);
    } else if (e.key === 'ArrowLeft') {      // 0x25
      this.reloadChoice = this.reloadChoice === 20 ? 10 : 20;
    } else if (e.key === 'ArrowRight') {     // 0x27
      this.reloadChoice = this.reloadChoice === 10 ? 20 : 10;
    }
  },
  drawReloadConfirm() {
    if (!this.reloadReady()) return;
    const bg = this.assets['ReloadBackground'];
    if (bg) ctx.drawImage(bg.canvas, 0, 0);
    if (this.reloadChoice === 10) { const s = this.assets['ReloadYes']; if (s) s.drawFrame(ctx, 0, 111, 124, false); }
    else { const s = this.assets['ReloadNo']; if (s) s.drawFrame(ctx, 0, 321, 144, false); }
    const F = DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOCLIP;   // 0x125
    this.drawText(`Продолжить на уровне ${this.highestLevel}?`, 220, 120, 420, 140, F, 24, '#000');
    this.drawText('Начать заново', 170, 375, 270, 395, F, 24, this.reloadChoice === 20 ? '#000' : CRIMSON);
    this.drawText('Конечно дальше', 370, 375, 470, 395, F, 24, this.reloadChoice === 10 ? '#000' : CRIMSON);
  },


  //--- Game scene overlays -------------------------------------------------
  drawBossScreen() {
    const bs = this.assets['BossScreeen'];
    if (bs) ctx.drawImage(bs.canvas, 0, 0);
  },

  // Esc dialog sub_421480 (IDA:15231): EscBackground + 3 strings, font 24.
  drawEscDialog() {
    const bg = this.assets['EscBackground'];
    if (bg) ctx.drawImage(bg.canvas, 0, 0);
    const F = DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOCLIP;   // 0x125
    this.drawText('Прервать развлечение?', 220, 130, 420, 150, F, 24, '#000');
    this.drawText('Да, именно', 170, 350, 270, 370, F, 24, this.escChoice ? '#000' : CRIMSON);
    this.drawText('Нет, только не это', 370, 350, 470, 370, F, 24, this.escChoice === 1 ? CRIMSON : '#000');
  },

  // Level transition (sub_4259FF IDA:17062, tick IDA:16184-16191): one full
  // scene tick+draw (vtable+16) into surface 150, a copy washed out by
  // sub_409C44 (16-bit: ((p & 0xF7DE) >> 1) + 0x7BEF) into 151, then this[152]
  // = 60; shown by (cnt/5)%2 ? 150 : 151.
  startLevelTransition() {
    this.levelTransitionTicks = 0;
    const oldWorld = this._transOldWorldValid;    // set by the calling tick
    this.tickWorld();
    this.draw();
    this._transOldWorldValid = oldWorld;
    const a = document.createElement('canvas'); a.width = 640; a.height = 480;
    a.getContext('2d').drawImage(canvas, 0, 0);
    const b = document.createElement('canvas'); b.width = 640; b.height = 480;
    const img = ctx.getImageData(0, 0, 640, 480);
    rgb565Wash(img.data);                         // sub_40A930 (core.js)
    b.getContext('2d').putImageData(img, 0, 0);
    this._transBuf = { normal: a, washed: b };
    this.levelTransitionTicks = LEVEL_TRANSITION_TICKS;
    this._transFirstFrame = true;     // the tick that started it flips its own image
    this._transLastFrame = false;
  },
  // Image of the tick that completed the level (sub_421856 continues after
  // sub_423EA9): old level background + list, then bushes and HUD (new state).
  drawLevelTransitionFirst() {
    if (this._transOldWorldValid && this._transOldWorld) {
      ctx.drawImage(this._transOldWorld, 0, 0);
      this.drawForegroundBushes();
      this.drawHud();
    } else if (this._transBuf) {
      ctx.drawImage(this._transBuf.normal, 0, 0);
    }
  },
  drawLevelTransition() {
    if (!this._transBuf) return;
    const src = (Math.floor(this.levelTransitionTicks / 5) % 2) ? this._transBuf.normal : this._transBuf.washed;
    ctx.drawImage(src, 0, 0);
  },

  // Lake: Blt COLORFILL 0xFFD282 into (399,362)-(640,480), then Clouds at
  // (+188,+192) (IDA:15514-15522). g = the game-scene world surface.
  drawLake(g) {
    g.fillStyle = '#82D2FF';
    g.fillRect(399, 362, 241, 118);
    this.assets['Clouds'].drawFrame(g, 0, this.cloudDrawX, this.cloudDrawY, false);
  },
  // Clouds (IDA:15520-15532): drawn at +188/+192, then the 30-tick move.
  cloudTick() {
    this.cloudDrawX = this.cloudX; this.cloudDrawY = this.cloudY;
    if (!--this.cloudCnt) {
      this.cloudCnt = 30;
      --this.cloudX;
      if (!(++this.cloudY % 6)) ++this.cloudY;
      if (this.cloudY > 480) { this.cloudX = 440; this.cloudY = 76; }
    }
  },

  // sub_42EB56 (IDA:21637-21642): dword_49BA18 +36 = 0; vtable+24(1,1,1) =
  // sub_401EBD: loops 1, start 1, end 1, frame 1 → frames 1,2,3 then wraps
  // to 0 and freezes (sub_401C8E). Called by sheep.js / mermaid.js.
  startScoreTableFlash() {
    this.scoreTableFrame = 1;
    this.scoreTableRun = true;
  },

  // HUD block of sub_421856 (IDA:15637-15681, normal branch only), run after
  // the list, the clock and the level-end check of the same tick.
  hudTick() {
    // score_table +228 via sub_401BDE: draw the current frame, then advance
    // by 1.0 unless frozen (IDA:15642).
    this.scoreTableDraw = this.scoreTableFrame;
    if (this.scoreTableRun) {
      if (++this.scoreTableFrame >= this.assets['score_table'].frames) { this.scoreTableFrame = 0; this.scoreTableRun = false; }
    }
    // Icon motion (IDA:15659-15676); positions drawn are the pre-move ones.
    const ih = this.assets['SvenIcon'].frameH;
    this.lifeFlyDraw = this.lifeFly >= 0 ? { x: this.lifeFlyX, y: this.lifeFlyY } : null;
    if (this.lifeFly >= 0) {
      this.lifeFlyX += 3;
      this.lifeFlyY += Math.trunc(this.lifeFly++ / 2) - 4;
      if (this.lifeFlyY > ih + 480) this.lifeFly = -1;
    }
    this.lifeDropDraw = this.lifeDrop >= 0 ? { x: this.lifeDropX, y: this.lifeDropY } : null;
    this.lifeCountDraw = this.hudLivesShown;
    if (this.lifeDrop >= 0) {
      this.lifeDropY += 20;
      ++this.lifeDrop;
      if (this.lifeDropY >= 445) { this.lifeDrop = -1; ++this.hudLivesShown; }
    }
    // Saint / mode icon timers, read once per tick (IDA:15724-15728,
    // 15856-15861): [49]/[48] <= 0 → 0, else field - GetTickCount(). While
    // paused the field holds the remaining ms, so this is hugely negative.
    this.hudSaintMs = this.saintEnd > 0 ? this.saintEnd - getTickCount() : 0;
    this.hudModeMs = this.svenModeEnd > 0 ? this.svenModeEnd - getTickCount() : 0;
    ++this.hudFrame;                                         // +308 (IDA:15683)
  },
  // Game enter (IDA:14518-14522): icons = lives-1, no animation.
  hudResetLives() {
    this.hudLivesShown = this.lives - 1;                   // IDA:14518-14520
    if (this.hudLivesShown === -1) this.hudLivesShown = 0;
    this.lifeFly = -1; this.lifeDrop = -1;
    this.lifeFlyDraw = this.lifeDropDraw = null;
    this.lifeCountDraw = this.hudLivesShown;
  },
  // Life lost (sub_423CEE IDA:16217-16234 / sub_424CB8 ')' IDA:16626-16649).
  // Called at the event, only when lives > 0 (callers test it).
  startLifeLostAnim() {
    this.hudLivesShown = this.lives - 1;
    this.lifeFly = 0;
    if (this.lifeDrop === -1) { this.lifeFlyX = 37 * this.hudLivesShown + 7; this.lifeFlyY = 445; }
    else { this.lifeFlyX = this.lifeDropX; this.lifeFlyY = this.lifeDropY; this.lifeDrop = -1; }
  },
  // Life gained (sub_424FFC case 8 IDA:16808 / sub_42546F IDA:16995).
  startLifeIconAnim() {
    this.hudLivesShown = this.lives - 2;      // no clamp (IDA:16809 / 16984)
    this.lifeDrop = 0;
    this.lifeDropX = 37 * this.hudLivesShown + 7;
    this.lifeDropY = -this.assets['SvenIcon'].frameH;
  },

  // Puddles: table dword_49B070, ≤10, top-left = cell − (45,20)
  // (sub_414871 IDA:9244), sprite off_493DF0[rand()%7] per level (IDA:15046).
  rollPuddles() {
    this.puddleRoll = this.mapInfo.puddles.slice(0, 10).map(p => {
      const s = cellToScreen(p.col, p.row);
      return { x: s.x - 45, y: s.y - 20, sheet: this.puddleSheets[Math.floor(Math.random() * 7)] };
    });
  },
  drawPuddles(g = ctx) {
    for (let i = this.puddleRoll.length - 1; i >= 0; i--) {   // i = 9..0 (IDA:15598)
      const p = this.puddleRoll[i];
      if (p.sheet) p.sheet.drawFrame(g, 0, p.x, p.y, false);
    }
  },
  drawForegroundBushes() {
    for (const [n, x, y] of FG_BUSHES) {
      const s = this.assets[n];
      if (s) s.drawFrame(ctx, 0, x, y, false);
    }
  },

  // HUD + end overlay + text, sub_421856 IDA:15637-16180.
  drawHud() {
    const clk = this.assets['clock'];
    if (clk) clk.drawFrame(ctx, 0, 18, 5, false);              // +200 at (18,5)
    // score_table at (497,11) via sub_401BDE (frame of this tick, see hudTick).
    const st = this.assets['score_table'];
    if (st) st.drawFrame(ctx, this.scoreTableDraw, 497, 11, false);
    // Lives: this[68] icons at (37i+7, 445) + fly-off / drop-in.
    const ico = this.assets['SvenIcon'];
    if (ico) {
      const n = this.lifeCountDraw ?? this.hudLivesShown;
      for (let i = 0; i < n; i++) ico.drawFrame(ctx, 0, 37 * i + 7, 445, false);
      if (this.lifeFlyDraw)  ico.drawFrame(ctx, 0, this.lifeFlyDraw.x, this.lifeFlyDraw.y, false);
      if (this.lifeDropDraw) ico.drawFrame(ctx, 0, this.lifeDropDraw.x, this.lifeDropDraw.y, false);
    }
    // Status icons, right-aligned from (630,450), gap 10 (+300/+304/+312).
    let x = 640 - 10;
    const y = 480 - 30;
    const blinkOn = Math.trunc(this.hudFrame / 10) % 2 === 0;
    const icon = (sheet, msLeft, frame) => {
      if (!sheet) return;
      if (msLeft >= 3000 || blinkOn) sheet.drawFrame(ctx, frame, x - sheet.frameW, y - sheet.frameH, false);
      x -= 10 + sheet.frameW;
    };
    if (this.saintActive) icon(this.assets['Saint-Disc'], this.hudSaintMs, 0);
    const mode = this.svenMode;
    const left = this.hudModeMs;
    if (mode === 2) icon(this.assets['Mushroom'], left, 0);
    else if (mode === 3) icon(this.assets['Mushroom2'], left, 0);
    else if (mode === 4) icon(this.assets['PlanetIcon'], left, this.hudFrame % 2);
    // GameOver / GameWon overlay while the end hold is up (this[114] > 0).
    const hold = this.endHoldMs > 0;
    const t = this.levelTimeMs;               // this+40: ms left of the hold
    if (hold) {
      const pic = this.assets[this.gameWon ? 'GameWon' : 'GameOver'];
      if (pic) pic.drawFrame(ctx, 0, 105, 111, false);              // +316/+320
      if (this.gameWon) {
        let e = null;
        if (!(t <= 2800 || t >= 4000)) e = ['SvenEyesWon', 341, 187];
        else if (!(t <= 2200 || t > 2800)) e = ['SvenEyesWon2', 341, 188];
        else if (t > 1000 && t <= 2200) e = ['SvenEyesWon', 341, 187];
        if (e && this.assets[e[0]]) this.assets[e[0]].drawFrame(ctx, 0, e[1], e[2], false);
      } else if ((t > 1400 && t < 1500) || (t > 1200 && t < 1300)
              || (t > 3400 && t < 3500) || (t > 3200 && t < 3300)) {
        const eyes = this.assets['SvenEyes'];
        if (eyes) eyes.drawFrame(ctx, 0, 345, 208, false);          // +340/+344
      }
    }
    // Text (IDA:16113-16177).
    let secs = hold ? Math.trunc((this.endHoldMs + 998) / 1000) : Math.trunc((t + 999) / 1000);
    const mm = Math.trunc(secs / 60), ss = secs % 60;
    const F = DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOCLIP;   // 0x125
    this.drawText(`${mm}:${String(ss).padStart(2, '0')}`, 35, 31, 70, 56, F, 24, CRIMSON);
    this.drawText(String(this.score), 552, 25, 610, 40,
                  DT_RIGHT | DT_VCENTER | DT_SINGLELINE | DT_NOCLIP, 24, CRIMSON);   // 0x126
    this.drawText(`Уровень:${String(this.levelIdx).padStart(2, ' ')}`, 550, 450, 635, 475,
                  DT_RIGHT | DT_BOTTOM | DT_SINGLELINE | DT_NOCLIP, 24, CRIMSON);    // 0x12A
    if (hold) this.drawText(String(this.score), 248, 298, 382, 329, F, 32, CRIMSON); // +324, font +436
  },
});

// Cloud scroll position (scene +188/+192), read by the UFO shadow (mermaid-ufo).
Object.defineProperty(Game.prototype, 'cloudPos', {
  get() { return { x: this.cloudX, y: this.cloudY }; },
  configurable: true,
});

// Every game-scene enter sub_42006D, new game, continue, demo AND level
// advance (sub_423EA9 → vtable+60(2, +440), IDA:16269-16271); runs before
// sub_4259FF (IDA:14533) like the unconditional resets: puddles re-rolled
// (sub_420C51), Sven demo flag +200 (IDA:14503), Esc dialog closed and exit
// request cleared (+24/+20, IDA:14512-14513), Esc choice "Да" (+100,
// IDA:14518), life icons = lives - 1 with fly-off/drop-in cancelled
// (+288/+276/+272, IDA:14520-14524), then sub_41C9F8 re-arms the timer.
GAME_LEVEL_HOOKS.push(function () {
  this.rollPuddles();
  if (this.sven) this.sven.demo = this.demoMode;
  this.escDialog = false;
  this.sceneExitReq = 0;
  this.escChoice = 0;
  this.hudResetLives();
  this._rearmTimer();
});
