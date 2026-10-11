//=== Mushroom power-ups ====================================================
// Map.ini chars (parser sub_412880 IDA:8745-8772): v=1 y=2 z=3 x=4 t=5 u=6
// (object field +104 = "kind" = sub_438C31 dispatcher case).
// Sprite + offsets from the EXE table unk_4931C0 (24-byte {name,dx,dy,id,flip,speed}),
// drawn with sub_401D89 mode 2: x = anchor.x+dx, y = anchor.y+dy-frameH.
const MUSH_DEFS = {
  v: { kind: 1, sprite: 'Mushroom',  dx: -5,  dy: -2 },  // Spanish fly   (case 1)
  y: { kind: 2, sprite: 'Mushroom2', dx: -12, dy: -3 },  // GoodFlower    (case 2)
  z: { kind: 3, sprite: 'Mushroom4', dx: -12, dy: -3 },  // BadFlower     (case 3)
  x: { kind: 4, sprite: 'Mushroom3', dx: -12, dy: -3 },  // surprise: rerolled at spawn
  t: { kind: 5, sprite: 'Mushroom5', dx: -12, dy: -3 },  // slow          (case 5)
  u: { kind: 6, sprite: 'Flower',    dx: -7,  dy: -3 },  // GoodFlower_0  (case 6)
};
const MUSH_CHAR_BY_KIND = ['', 'v', 'y', 'z', 'x', 't', 'u'];
// 7 pre-allocated mushroom objects shared by Map.ini + random spawns (sub_4211B0 IDA:15133).
const MUSH_SLOTS = 7;

// rand() % 100 / 10 — the decile roll used by sub_406C6F and sub_421856.
function mushDecile() {
  return Math.floor(Math.floor(Math.random() * 100) / 10);
}

// sub_421856 IDA:15560-15585: kind of a randomly spawned mushroom.
// v 20%, y 20%, z 10%, x 20%, t 10%, u 20%.
function rollSpawnMushroomKind() {
  switch (mushDecile()) {
    case 0: case 1: return 1;
    case 2: case 3: return 2;
    case 4:         return 3;
    case 5: case 6: return 4;
    case 7:         return 5;
    default:        return 6;   // 8, 9
  }
}

// sub_406C6F IDA:2617-2650: 'x' (kind 4) is resolved once, when the object is
// set up; the Mushroom3 sprite stays. Case 0xA is never produced.
function rollSurpriseMushroomKind() {
  switch (mushDecile()) {
    case 0: case 1: return 1;
    case 2: case 3: return 2;
    case 4:         return 3;
    case 5:         return 7;
    case 6:         return 8;
    case 7:         return 5;
    case 8:         return 9;
    default:        return 6;   // 9
  }
}

// One of the 7 pooled mushroom slot objects (sub_4211B0 IDA:15134-15178):
// created per game-scene enter by sub_420C51 and kept in the scene list for
// the whole level (IDA:15029-15039), visible or not. A slot is re-armed in
// place by place() (Map.ini sub_414AA1 / spawner IDA:15550-15590); eating it
// only hides it (kind 0, vtable+80), so it keeps its position and sort key.
class Mushroom {
  // A never-used slot; place() arms it. `sub` = map char (selects the sprite),
  // `kind` = resolved dispatcher case.
  constructor() {
    // sub_406EB8 (IDA:2691-2706): z = 0, x = y = -2147483647; [26] = 0
    // (IDA:15165); animator sub_401950: no sprite, stopped (byte36 = 1), hidden.
    this.col = -1;
    this.row = -1;
    this.sub = null;
    this.sprite = null;
    this.def = null;
    this.kind = 0;
    this.consumed = true;            // !animator byte37 (hidden)
    this._z = 0;                     // this[3] (vtable+32 sort key)
    this._x = -2147483647;           // this[4] (CompareFunction tie key)
    this._spriteName = null;         // animator sprite (a3[1])
    this._animRunning = false;       // !animator byte36
    this.animTick = 0;               // animator frame this[8]
    this._shownFrame = 0;            // frame blitted by the last vtable+36
  }
  // setPos vtable+16 (sub_401800) → setZ override 0x406DA0: z = y - 10.
  // Then [26] = kind and vtable+80 = sub_406C6F: sub_40709A(unk_4931C0[kind])
  // resets the animator (sub_401B62: frame 0, running) only when the sprite
  // changes, so a reused Mushroom3 slot keeps its phase; sub_40702E(1) shows
  // it; kind 4 ('x') is rerolled after the sprite is set.
  place(col, row, sub, sprite) {
    const p = cellToScreen(col, row);
    this.col = col;
    this.row = row;
    this._x = p.x;
    this._z = p.y - 10;
    this.sub = sub;
    const def = MUSH_DEFS[sub];
    this.def = def || null;
    this.kind = def ? def.kind : 0;
    this.sprite = sprite;
    if (def && def.sprite !== this._spriteName) {
      this._spriteName = def.sprite;
      this.animTick = 0;
      this._animRunning = true;
    }
    this.consumed = false;
    if (this.kind === 4) this.kind = rollSurpriseMushroomKind();   // sub_406C6F
  }
  // Sort keys read by Game.entityDepth / entityDepthX (z = y - 10, R3-LRH-02).
  get _depthY() { return this._z; }
  get _depthX() { return this._x; }
  // Scene-list vtable+36 = sub_406FE0 → sub_401BDE: blit the current frame
  // (only if visible), then advance the animator unless stopped — hidden slots
  // keep animating. Sprite speed 1.0 (unk_4931C0) = one frame per call; only
  // Mushroom3 has >1 frame (drawFrame wraps modulo the frame count).
  update() {
    this._shownFrame = this.animTick;
    if (this._animRunning) this.animTick++;
  }
  // Removal (cell → land, [26]=0, vtable+80 → sub_40702E(0) hides it).
  consume() {
    this.consumed = true;
    this.kind = 0;
  }
  draw(g) {
    if (this.consumed || !this.sprite || !this.def) return;
    const p = cellToScreen(this.col, this.row);
    const rec = spriteRecord(this.def.sprite);                     // unk_4931C0 record
    this.sprite.drawFrame(g, this._shownFrame, p.x + rec.dx,
                          p.y + rec.dy - this.sprite.frameH, false);
  }
}
