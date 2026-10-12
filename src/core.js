//---------------------------------------------------------------------------
// Sven Bømwøllen — JavaScript port. Core: canvas, INI parser, sprite sheets
// (chromakey, column-major frames), grid, EXE sprite-record tables, hooks.
//
// Assets are read from ./assets/ (unpacked from the original Sven.dat).
// Serve this folder with any static HTTP server (e.g. `python -m http.server`).
//---------------------------------------------------------------------------

const ASSETS = './assets/';
const canvas = document.getElementById('screen');
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;

//=== INI parsing ===========================================================
// The .ini files use `;` for comments and `Section`/`Key=Value` lines.
function parseIni(text) {
  const out = {};
  let section = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s*;.*$/, '').trimEnd();
    if (!line.trim()) continue;
    const sec = line.match(/^\[(.+)\]\s*$/);
    if (sec) { section = sec[1]; out[section] = out[section] || {}; continue; }
    const kv = line.match(/^\s*([^=]+?)\s*=\s*(.*)$/);
    if (kv && section) out[section][kv[1]] = kv[2];
  }
  return out;
}

//=== Image loading (colour key baked into PNG alpha) ========================
// Library.ini names the original BMPs; the sprites ship as PNGs of the same
// base name with the colour key already applied as alpha (converted once with
// this loader's former keying, pixel-identical in Chromium for all 147 sheets).
// The keying rule that was baked in:
// - Library.ini key field is read with sscanf("%8X") (sub_40DD58 IDA:6402) and
//   turned into a GDI COLORREF with the first two hex digits as RED
//   (IDA:6427): "619DBF" keys RGB(0x61,0x9D,0xBF) (CloudsShaded). A non-zero
//   high byte (e.g. "FF000000") means no colour key at all: SetColorKey only
//   when (key & 0xFF000000)==0 (sub_408621 IDA:3494), and sub_407FA2 blits
//   without SRCCOLORKEY otherwise (IDA:3251).
// - The display/surfaces are 16 bpp (SetDisplayMode(640,480,16), IDA:7590) and
//   the key is the surface's own readback of SetPixel(key) (sub_4021A0
//   IDA:689-724), so every pixel whose 16-bit value equals the key's is
//   transparent: compared as RGB565 (r>>3, g>>2, b>>3).
// - 565 vs 555: the EXE probes the primary format (sub_410541 IDA:7630-7644,
//   dword_49AF64); every keyed sheet gives identical transparent-pixel counts
//   under 565 and 555. Displayed colours are NOT quantised to 16 bpp
//   (R3-CMA-02: the 5/6-bit → 8-bit display expansion is hardware-dependent).
async function loadSprite(filename) {
  const img = new Image();
  // File part URL-encoded (e.g. 'Ufo67%.png'), path separators kept.
  const png = String(filename).replace(/\.bmp$/i, '.png');
  img.src = ASSETS + png.split('/').map(encodeURIComponent).join('/');
  await img.decode();

  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext('2d').drawImage(img, 0, 0);
  return c;
}

//=== Sprite-sheet wrapper ==================================================
// A CImageSeq: rows × cols cels in one bitmap, frame size width/cols ×
// height/rows (sub_407B5A IDA:3120). Frames run COLUMN-major: col = f / rows,
// row = f % rows (sub_407CFE IDA:3160). Frame count = Library.ini frames field
// (+48, sub_40C99F IDA:5662). sub_407FA2 (IDA:3238): f < 0 draws nothing,
// f >= frames wraps modulo frames. Flip mirrors the cel (the original mirrors
// the whole sheet and remaps the column — pixel-identical). Flip only applies
// when the sheet is flipable (Library.ini field 6, byte +44) and so has a mirror
// surface: `a6 && byte44 && this[10]` (sub_407FA2 IDA:3245).
// Every caller passes Library.ini field 6 (all 157 [Images] entries have it).
class SpriteSheet {
  constructor(canvas, rows, cols, frames, flipable) {
    this.canvas = canvas;
    this.rows = rows;
    this.cols = cols;
    this.frames = frames;
    this.flipable = flipable;
    this.frameW = Math.floor(canvas.width  / cols);
    this.frameH = Math.floor(canvas.height / rows);
  }
  drawFrame(g, frame, dx, dy, flipH = false) {
    if (frame < 0) return;
    frame = Math.floor(frame);
    const f = frame >= this.frames ? frame % this.frames : frame;
    const c = Math.floor(f / this.rows);
    const r = f % this.rows;
    const sx = c * this.frameW;
    const sy = r * this.frameH;
    if (flipH && this.flipable === 1) {
      // DDBLTFX_MIRRORLEFTRIGHT (sub_408E6A IDA:3782, byte44 == 1).
      g.save();
      g.translate(dx + this.frameW, dy);
      g.scale(-1, 1);
      g.drawImage(this.canvas, sx, sy, this.frameW, this.frameH, 0, 0, this.frameW, this.frameH);
      g.restore();
    } else if (flipH && this.flipable) {
      // byte44 != 1 → DDBLTFX_MIRRORUPDOWN of the rows×cols area (sub_408E6A
      // IDA:3782); sub_407CFE (IDA:3165) still remaps the column only, so the
      // cel shown is source (cols-1-c, rows-1-r) upside down. No shipped
      // [Images] entry uses 2.
      const vsx = (this.cols - 1 - c) * this.frameW;
      const vsy = (this.rows - 1 - r) * this.frameH;
      g.save();
      g.translate(dx, dy + this.frameH);
      g.scale(1, -1);
      g.drawImage(this.canvas, vsx, vsy, this.frameW, this.frameH, 0, 0, this.frameW, this.frameH);
      g.restore();
    } else {
      g.drawImage(this.canvas, sx, sy, this.frameW, this.frameH, dx, dy, this.frameW, this.frameH);
    }
  }
}

//=== Iso grid math =========================================================
// Hard-coded by sub_4125FD (IDA:8395-8400) — [MapInfo] in Map.ini is never read:
//   Origin     = (-213, 310)
//   CellWidth  = (40, -30)   ; movement per +1 column
//   CellHeight = (39, 30)    ; movement per +1 row
// These produce a 2:1 isometric projection covering the 640×480 frame.
const GRID = {
  origin:     { x: -213, y: 310 },
  cellWidth:  { x:  40,  y: -30 },
  cellHeight: { x:  39,  y:  30 },
};
function cellToScreen(col, row) {
  return {
    x: GRID.origin.x + col * GRID.cellWidth.x + row * GRID.cellHeight.x,
    y: GRID.origin.y + col * GRID.cellWidth.y + row * GRID.cellHeight.y,
  };
}

//=== Map data ==============================================================
// Facings 0..3. Map.ini entity chars (sub_413D74 IDA:8875-8886, codes 1..4):
// e→NE, n→NW, w→SW, s→SE. Step deltas per sub_415399 (IDA:9512): NE col+1,
// NW row-1, SW col-1, SE row+1.
const DIR = { NE: 0, NW: 1, SW: 2, SE: 3 };
const DIR_DELTA = {
  [DIR.NE]: { dc: +1, dr:  0 },
  [DIR.NW]: { dc:  0, dr: -1 },
  [DIR.SW]: { dc: -1, dr:  0 },
  [DIR.SE]: { dc:  0, dr: +1 },
};

//=== Sprite placement records ==============================================
// The original's 24-byte records {char* name, int dx, int dy, CImageSeq*,
// int flip, float animSpeed}, read from Sven.exe .data. sub_40709A →
// sub_401D89(mode 2) draws the cel top-left at (pos.x + dx, pos.y + dy -
// frameH) where pos is the entity's screen point (cellToScreen of its cell,
// plus any step interpolation). 4-entry tables are indexed by facing
// (NE, NW, SW, SE); each entry is [sprite, dx, dy, flip]; speed = animSpeed.
// null entry = record with no sprite (the original keeps the current one).
const SPRITE_OFFSETS = {
  // Dog 0x4910F8..
  DogLaydown:    { at: 0x4910F8, speed: 1,   d: [['Doglaydown02',-39,13,1],['Doglaydown02',-37,11,0],['Doglaydown01',-37,10,1],['Doglaydown01',-36,10,0]] },
  DogWalk:       { at: 0x491158, speed: 1,   d: [['Dogwalk02',-39,13,1],['Dogwalk02',-35,15,0],['Dogwalk01',-38,19,1],['Dogwalk01',-37,19,0]] },
  DogRun:        { at: 0x4911B8, speed: 1,   d: [['Dogrun02',-39,13,1],['Dogrun02',-35,15,0],['Dogrun01',-38,19,1],['Dogrun01',-37,19,0]] },
  DogShag:       { at: 0x491218, speed: 1,   d: [['Dogshag02',-69,13,1],['Dogshag02',-37,11,0],['Dogshag01',-37,10,1],['Dogshag01',-36,10,0]] },
  DogSleep:      { at: 0x491278, speed: 1,   d: [['Dogsleep02',-39,13,1],['Dogsleep02',-37,11,0],['Dogsleep01',-37,10,1],['Dogsleep01',-36,10,0]] },
  DogHowl:       { at: 0x4912D8, speed: 0.4, d: [['Doghowl02',-39,13,1],['Doghowl02',-37,11,0],['Doghowl01',-37,10,1],['Doghowl01',-36,10,0]] },
  AlienDogShag:  { at: 0x491338, speed: 1,   d: [['Alien_dogshag02',-69,13,1],['Alien_dogshag02',-37,11,0],['Alien_dogshag01',-37,10,1],['Alien_dogshag01',-36,10,0]] },
  DogSymbols:    { at: 0x491398, speed: 1,   d: [['Symbols',4,-35,0],['Symbols',-28,-35,0],['Symbols',-26,-25,0],['Symbols',2,-25,0]] },
  // Sheep 0x4947A8..
  SheepSymbols:  { at: 0x4947A8, speed: 1,   d: [['Symbols',4,-35,0],['Symbols',-28,-35,0],['Symbols',-26,-25,0],['Symbols',2,-25,0]] },
  SheepWalk:     { at: 0x494808, speed: 1,   d: [['Sheep_walkaway',-29,13,0],['Sheep_walkaway',-43,11,1],['Sheep_walkup',-44,22,0],['Sheep_walkup',-28,22,1]] },
  SheepChew:     { at: 0x494868, speed: 0.5, d: [null, null, ['Sheep_chewing',-28,10,0],['Sheep_chewing',-29,10,1]] },  // used at IDA:20310
  SvenKick:      { at: 0x4948C8, speed: 1,   d: [['Sven_kick02',-66,25,0],['Sven_kick02',-40,25,1],['Sven_kick01',-36,9,0],['Sven_kick01',-55,9,1]] },
  SheepExploding:{ at: 0x494928, speed: 1,   d: [['Sheep_exploding',-65,18,0]] },
  SheepStoned:   { at: 0x494940, speed: 1,   d: [['Stoned02',-54,27,0],['Stoned02',-28,25,1],['Stoned01',-28,11,0],['Stoned01',-58,11,1]] },
  Demon:         { at: 0x494A10, speed: 1,   d: [['Demon02',-39,14,0],['Demon02',-45,10,1],['Demon01',-43,18,0],['Demon01',-47,17,1]] },
  DemonRun:      { at: 0x494A70, speed: 1,   d: [['DemonRun02',-39,14,0],['DemonRun02',-45,10,1],['DemonRun01',-43,18,0],['DemonRun01',-47,17,1]] },
  SheepAccept:   { at: 0x494C28, speed: 1,   d: [['SheepAccept02',-37,14,0],['SheepAccept02',-29,12,1],['SheepAccept01',-28,9,0],['SheepAccept01',-35,9,1]] },
  Bzzzt:         { at: 0x494D90, speed: 1,   d: [['Bzzzt',-50,10,0]] },
  AlienShag:     { at: 0x494DE8, speed: 0.8, d: [['Alien_shag06',-45,12,0],['Alien_shag06',-44,11,1],['Alien_shag08',-30,9,0],['Alien_shag08',-63,9,1]] },
  // Shepherd 0x4954C0..
  GuyStand:      { at: 0x4954C0, speed: 1,   d: [['Guy_StandBack',-39,13,1],['Guy_StandBack',-37,11,0],['Guy_StandFront',-37,10,1],['Guy_StandFront',-36,10,0]] },
  GuyWalk:       { at: 0x495520, speed: 1,   d: [['Guy_WalkBack',-39,13,1],['Guy_WalkBack',-35,15,0],['Guy_WalkFront',-38,19,1],['Guy_WalkFront',-37,19,0]] },
  GuyWalk2:      { at: 0x495580, speed: 1,   d: [['Guy_WalkBack2',-75,9,1],['Guy_WalkBack2',-47,7,0],['Guy_WalkFront2',-44,5,1],['Guy_WalkFront2',-41,5,0]] },
  // Sven 0x495A90..
  SvenStand:     { at: 0x495A90, speed: 1,   d: [['Sven_stand02',-29,13,0],['Sven_stand02',-27,11,1],['Sven_stand01',-27,10,0],['Sven_stand01',-26,10,1]] },
  SvenWalk:      { at: 0x495AF0, speed: 1,   d: [['Sven_walk02',-39,13,0],['Sven_walk02',-35,15,1],['Sven_walk01',-38,19,0],['Sven_walk01',-37,19,1]] },
  SvenElectro:   { at: 0x495B50, speed: 1,   d: [['Sven_electro02',-66,11,0],['Sven_electro02',-37,10,1],['Sven_electro01',-35,7,0],['Sven_electro01',-61,7,1]] },
  SvenInvite:    { at: 0x495BF8, speed: 1,   d: [['SvenInvite02',-32,14,0],['SvenInvite02',-38,12,1],['SvenInvite01',-38,9,0],['SvenInvite01',-30,9,1]] },
  SvenBlink:     { at: 0x495CE0, speed: 0.4, d: [['SvenBlink02',-29,13,0],['SvenBlink02',-27,11,1],['SvenBlink01',-27,10,0],['SvenBlink01',-26,10,1]] },
  Fight:         { at: 0x495D40, speed: 1,   d: [['Fight',-100,30,0]] },
  Splash:        { at: 0x495D58, speed: 1,   d: [['splash',-55,13,0]] },
  AlienFall:     { at: 0x495D70, speed: 1,   d: [[null,-66,11,0],[null,-36,9,1],['AlienFall01',-33,7,0],['AlienFall01',-48,7,1]] },
  AlienStand:    { at: 0x495E10, speed: 1,   d: [['Alien_stand02',-29,13,0],['Alien_stand02',-27,11,1],['Alien_stand01',-27,10,0],['Alien_stand01',-26,10,1]] },
  AlienWalk:     { at: 0x495E70, speed: 1,   d: [['Alien_walk02',-39,13,0],['Alien_walk02',-35,15,1],['Alien_walk01',-38,19,0],['Alien_walk01',-37,19,1]] },
  AlienInvite:   { at: 0x495ED0, speed: 1,   d: [['AlienInvite02',-32,14,0],['AlienInvite02',-38,12,1],['AlienInvite01',-38,9,0],['AlienInvite01',-30,9,1]] },
  SaintDisc:     { at: 0x495F30, speed: 1,   d: [['Saint-Disc',-6,-40,0],['Saint-Disc',-26,-40,1],['Saint-Disc',-20,-30,0],['Saint-Disc',4,-30,1]] },  // 0x495F90 identical
  SvenExplode:   { at: 0x495FF0, speed: 0.5, d: [['SvenExplode',-65,18,0]] },
  AlienExplode:  { at: 0x496008, speed: 0.5, d: [['AlienExplode',-65,18,0]] },
  SheepFlying:   { at: 0x496468, speed: 0.25,d: [['SheepFlying02',-37,21,0],['SheepFlying02',-34,21,1],['SheepFlying01',-35,14,0],['SheepFlying01',-35,14,1]] },
  SvenFlying:    { at: 0x4964C8, speed: 0.25,d: [['SvenFlying02',-35,20,0],['SvenFlying02',-35,18,1],['SvenFlying01',-30,16,0],['SvenFlying01',-40,16,1]] },
  AlienFall2:    { at: 0x496558, speed: 1,   d: [['AlienFall01',-47,11,0],['AlienFall01',-45,11,1]] },  // 2-entry table
  // Single records (not per facing)
  Mushroom:      { at: 0x4931D8, speed: 1,   d: [['Mushroom',-5,-2,0]] },
  Mushroom2:     { at: 0x4931F0, speed: 1,   d: [['Mushroom2',-12,-3,0]] },
  Mushroom4:     { at: 0x493208, speed: 1,   d: [['Mushroom4',-12,-3,0]] },
  Mushroom3:     { at: 0x493220, speed: 1,   d: [['Mushroom3',-12,-3,0]] },
  Mushroom5:     { at: 0x493238, speed: 1,   d: [['Mushroom5',-12,-3,0]] },
  Flower:        { at: 0x493250, speed: 1,   d: [['Flower',-7,-3,0]] },
  MermaidStand:  { at: 0x493A60, speed: 1,   d: [['mermaidStand',-40,21,0]] },
  MermaidJump:   { at: 0x493A78, speed: 1,   d: [['mermaidJump',-44,45,0]] },
  MermaidFuck:   { at: 0x493A90, speed: 1,   d: [['mermaidFuck',-48,28,0]] },
  AlienMermaidFuck:{ at: 0x493AA8, speed: 1, d: [['Alien_mermaidfuck',-48,28,0]] },
  MermaidExplode:{ at: 0x493AE8, speed: 0.5, d: [['mermaidExplode',-65,18,0]] },
  GameBush5:     { at: 0x493DD8, speed: 1,   d: [['GameBush5',10,0,0]] },
};
// Record for a table + facing (single-record tables ignore dir).
function spriteRecord(table, dir = 0) {
  const t = SPRITE_OFFSETS[table];
  if (!t) return null;
  const e = t.d.length === 1 ? t.d[0] : t.d[dir];
  return e ? { sprite: e[0], dx: e[1], dy: e[2], flip: !!e[3], speed: t.speed } : null;
}
// sub_401D89 mode 2: top-left of the cel for entity screen point (x, y).
function spriteTopLeft(x, y, rec, frameH) {
  return { x: x + rec.dx, y: y + rec.dy - frameH };
}

//=== Fixed-timestep + extension hooks =======================================
// Gameplay (game scene) logic rate: sub_41F643 sets +52 = 20 (IDA:14345),
// also the scene-base default this[13]=20 (IDA:12543). Per-scene rates are in
// SCENE_TICK_HZ (game.js). Each scene's logic runs exactly once per tick;
// game.tickCount counts unpaused gameplay ticks.
const GAME_TICK_HZ = 20;
// Hook arrays let area files extend Game without editing game.js. Each entry
// is a function invoked as fn.call(game, ...). Hooks run in array order, i.e.
// script load order (index.html) then push order within a file.
//  GAME_INIT_HOOKS  — end of the Game constructor (assets not loaded yet).
//  GAME_TICK_HOOKS  — every unpaused PLAYING tick (not during the level
//                     transition), after all entity updates. Runs during
//                     the end hold too (endHoldMs > 0): check it yourself.
//  GAME_LEVEL_HOOKS — end of Game.loadLevel(idx), args (idx); entities exist.
// GetTickCount() stand-in for absolute deadlines (Sven [48]/[49]): system
// uptime, never near 0, so `deadline - now` applied twice (double pause,
// sub_438ECF IDA:25878) is negative as in the original. 0x10000000 ms ≈ 3.1
// days keeps it positive in int32 terms. GetTickCount is a whole-ms DWORD, so
// the value is an integer (R5-LIM-06); the level clock, the catch chain and the
// chew/Mee throttles (dword_49BA38/3C) read it too.
function getTickCount() { return Math.floor(performance.now()) + 0x10000000; }

const GAME_INIT_HOOKS  = [];
const GAME_TICK_HOOKS  = [];
const GAME_LEVEL_HOOKS = [];

//=== Text bytes (RUSSIAN_CHARSET) ==========================================
// Every game font is created through the patched CreateFontA thunk sub_472F04
// (`mov eax,0xCC; mov [esp+0x24],eax; jmp CreateFontA`), i.e. RUSSIAN_CHARSET,
// so DrawTextA shows every byte as its cp1251 character on any Windows.
// Byte strings are JS strings with char codes 0..255 (one char = one byte).
// 0x98 is unassigned in cp1251 and maps to U+0098.
const CP1251_HIGH = 'ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—\u0098™љ›њќћџ ЎўЈ¤Ґ¦§Ё©Є«¬­®Ї°±Ііґµ¶·ё№є»јЅѕїАБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя';
// cp1252 0x80..0x9F (unassigned bytes map to the same-valued C1 control).
const CP1252_C1 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ';
// Byte string → the characters the original draws (cp1251 decode).
function cp1251Display(bytes) {
  let out = '';
  for (const ch of String(bytes)) {
    const b = ch.charCodeAt(0);
    out += b >= 0x80 && b <= 0xFF ? CP1251_HIGH[b - 0x80] : ch;
  }
  return out;
}
// One Unicode character (e.key) → the ANSI byte WM_CHAR delivers for it, or
// -1. WM_CHAR of an ANSI window carries the byte in the active keyboard
// layout's code page: Cyrillic letters come from a Russian layout (cp1251),
// everything else is taken as a Western layout (cp1252, the German release).
function ansiByteForChar(ch) {
  const u = String(ch).charCodeAt(0);
  if (u < 0x80) return u;
  const i1251 = u >= 0x0400 && u <= 0x04FF || u === 0x2116 ? CP1251_HIGH.indexOf(ch) : -1;
  if (i1251 >= 0) return 0x80 + i1251;
  const i1252 = CP1252_C1.indexOf(ch);
  if (i1252 >= 0) return 0x80 + i1252;
  if (u >= 0xA0 && u <= 0xFF) return u;
  return -1;
}

//=== 16-bit surface colour math ============================================
// The display is SetDisplayMode(640,480,16) (IDA:7590); per-pixel effects run
// on the 16-bit words. Modelled as RGB565 (565 vs 555 is hardware-dependent,
// see loadSprite above). Applied in place to ImageData RGBA bytes; f5 maps a
// 5-bit R/B channel, f6 the 6-bit G channel; result expanded back to 8 bits.
function rgb565Apply(d, f5, f6) {
  for (let i = 0; i < d.length; i += 4) {
    const r5 = f5(d[i] >> 3), g6 = f6(d[i + 1] >> 2), b5 = f5(d[i + 2] >> 3);
    d[i] = (r5 << 3) | (r5 >> 2); d[i + 1] = (g6 << 2) | (g6 >> 4); d[i + 2] = (b5 << 3) | (b5 >> 2);
  }
}
// UFO shadow darken, sub_409A59 → sub_40A780 `3 * ((p & 0xE79C) >> 2)`:
// per channel 3*(c>>2).
function rgb565Shadow(d) { const f = (c) => 3 * (c >> 2); rgb565Apply(d, f, f); }
// Level-transition wash, sub_409C44 → sub_40A930 `((p & 0xF7DE) >> 1) + 0x7BEF`:
// per channel (c>>1) + 15 (R/B) / + 31 (G).
function rgb565Wash(d) { rgb565Apply(d, (c) => (c >> 1) + 15, (c) => (c >> 1) + 31); }

//=== Library.ini section lines (loading-bar weights) =======================
// sub_40E61E: total = GetPrivateProfileSectionA([Images]) + ([Sounds] when
// sound is on) return values (IDA:6736-6751); each loaded line whose first
// byte is alpha then advances by strlen(line)+1 (IDA:6795 / 6853), and the
// end sends 0x7FFFFFFF (clamped). Returns { lines: [raw 'key=value' text],
// total } where total = Σ(len+1) over all returned lines.
// UNVERIFIED: that GetPrivateProfileSectionA also returns ';' comment lines
// (the loader's _ismbcalpha skip suggests so); blank lines are not returned.
function iniSectionRawLines(text, section) {
  const lines = [];
  let inSec = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    const m = line.match(/^\[(.+)\]$/);
    if (m) { inSec = m[1].toLowerCase() === String(section).toLowerCase(); continue; }
    if (inSec && line) lines.push(line);
  }
  return { lines, total: lines.reduce((s, l) => s + l.length + 1, 0) };
}
