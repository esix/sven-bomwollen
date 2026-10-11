//=== Lamb (CTween created by sub_424735) ====================================
// A lamb is a one-shot pixel tween, not a grid entity: sub_41D171 creates a
// CTween (sub_439360) with one key {target, duration} (sub_43950E). Each tick
// sub_43955A does `--remaining` and interpolates
//   pos = ((dur - rem) * to + rem * from) / dur      (integer division)
// and snaps to `to` when rem reaches 0. sub_424B7F then deletes the finished
// tween. CTweens set no cell bits, so lambs block nothing (no col/row here).
// Sprite: Lamb01/Lamb02 at default speed 1.0 (sub_401950), offset mode 1
// (sub_401D89 a4=1: x+dx, y+dy, no frame-height anchor), flip via +48 = 16.
class Lamb {
  constructor(name, sheet, flip, offX, offY, from, to, dur) {
    this.anim = new NpcAnim();
    this.anim.setEntry({ name, sheet, frames: NPC_SPRITE_FRAMES[name], dx: offX, dy: offY, flip, speed: 1 });
    this.from = { x: from.x, y: from.y };
    this.to = { x: to.x, y: to.y };
    this.dur = dur;
    this.remaining = dur;            // CTween this[15]
    this.pos = { x: from.x, y: from.y };
    this.drawPos = this.pos;         // where this tick blitted (this[4..5] before the move)
    this.drawFrame = 0;
    this.done = false;
  }
  // One tick (sub_43955A): blit at the current position first, then move.
  // sub_424B7F (`this[15] <= 0`, IDA:16582) deletes the tween right after
  // the draw list of the same tick (IDA:15611), so `done` is set right after
  // the move; the tick's _drawList (built earlier) still holds this tick's
  // blit, so the tween is drawn exactly `dur` times.
  update() {
    this.drawPos = this.pos;
    this.drawFrame = this.anim.frame;
    this.anim.advance();
    if (--this.remaining) {
      const r = this.remaining, d = this.dur;
      this.pos = {
        x: Math.trunc(((d - r) * this.to.x + r * this.from.x) / d),
        y: Math.trunc(((d - r) * this.to.y + r * this.from.y) / d),
      };
    } else {
      this.pos = { x: this.to.x, y: this.to.y };
    }
    this.done = this.remaining <= 0;
  }
  // z/x of the list sort (vtable+32 / +20 of off_4742AC): the position set
  // at the end of the previous sub_43955A, i.e. `pos` when the sort runs.
  get _depthY() { return this.pos.y; }
  get _depthX() { return this.pos.x; }
  draw(g) {
    const s = this.anim.sheet;
    if (!s) return;
    s.drawFrame(g, this.drawFrame, this.drawPos.x + this.anim.dx, this.drawPos.y + this.anim.dy, this.anim.flip);
  }
}
