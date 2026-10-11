//=== Game methods: game_npc (prototype mixin) ===================================
// Dog / shepherd / lamb glue. Owner: dog-shepherd-lamb (audit/OWNERSHIP.md).
Object.assign(Game.prototype, {

  //--- NPC events -------------------------------------------------------------
  // Sven → dog sub_405C45(dword_49BB28, code) / shepherd sub_43217A(code).
  dogEvent(code)      { for (const d of this.dogs) d.event(code); },
  shepherdEvent(code) { for (const s of this.shepherds) s.event(code); },
  // sub_405EC7(dog, 11): a sheep entered caught state 11 (IDA:19899-19902).
  dogHowl() { for (const d of this.dogs) d.howl(); },
  // Dog/shepherd → Sven: sub_4388F0(code) from the dog (60 caught, 58 dogshag
  // cycle, 59, 52 dogshag over) and sub_438818(67) from the shepherd.
  npcToSven(code) { this.sven.onNpcEvent(code); },

  //--- Lambs (sub_424735 + sub_416028) ----------------------------------------
  // Called once per level by the pool trigger (IDA:15506-15511, +30 score is
  // the caller's). Parents = first and last sheep met when scanning every row
  // and every column, if the sheep's mood level (+120) > 8, without
  // duplicates. Each lamb runs from its parent to the nearest '&' cell.
  spawnLambs() {
    this.lambSpawned = true;                     // this[121] = parent count (IDA:16479)
    const map = this.mapInfo;
    // sub_416028 (IDA:9918/9947/9979/10024): a cell is "met" iff it is land
    // (type 1/7) and (byte2 & 0xF0) != 0, i.e. a non-demon present sheep
    // (demon code 8 -> byte2 0x08 is skipped, not a stopper) or the emerged
    // mermaid (CSheep subclass, code 4 -> 0x80). The object is cell+4; its
    // +120 is tested > 8. The mermaid's +120 is her stamina mood (sub_42ABDF
    // -> sub_42D08E(1), IDA:19733), so she can be a parent.
    const cellSheep = (r, c) => {
      if (!npcIsLand(this, c, r)) return null;
      const sh = this.sheepAt(c, r);
      if (sh) return sh;
      const mm = this.mermaid;
      return mm && mm.occupancyAt(c, r).present ? mm : null;
    };
    const parents = [];
    const mood120 = o => (o instanceof Mermaid ? o.mood30 : o.moodLevel);
    const consider = sh => { if (mood120(sh) > 8 && !parents.includes(sh)) parents.push(sh); };
    // Rows (i = row), first from the left, then last from the right (m > j).
    for (let r = 0; r < map.rows; r++) {
      let j = 0;
      for (; j < map.cols; j++) { const sh = cellSheep(r, j); if (sh) { consider(sh); break; } }
      for (let m = map.cols - 1; m > j; m--) { const sh = cellSheep(r, m); if (sh) { consider(sh); break; } }
    }
    // Columns.
    for (let c = 0; c < map.cols; c++) {
      let j = 0;
      for (; j < map.rows; j++) { const sh = cellSheep(j, c); if (sh) { consider(sh); break; } }
      for (let m = map.rows - 1; m > j; m--) { const sh = cellSheep(m, c); if (sh) { consider(sh); break; } }
    }
    // '&' cells (terrain type 4), row-major; nearest by squared distance,
    // strict '<' from a (300,300) sentinel (1-based coords in the original).
    const exits = [];
    for (let r = 0; r < map.rows; r++)
      for (let c = 0; c < map.cols; c++)
        if (map.terrain[r][c] === '&') exits.push({ r: r + 1, c: c + 1 });
    for (const sh of parents) {
      const r1 = sh.row + 1, c1 = sh.col + 1;
      let br = 300, bc = 300;
      for (const e of exits) {
        if ((e.c - c1) ** 2 + (e.r - r1) ** 2 < (bc - c1) ** 2 + (br - r1) ** 2) { br = e.r; bc = e.c; }
      }
      const sp = cellToScreen(sh.col, sh.row);
      const tp = cellToScreen(bc - 1, br - 1);
      const sx = sp.x, sy = sp.y - 1;           // --v29[1] (IDA:16489)
      let name, flip, ox, oy;
      if (sx >= tp.x) {
        if (sy >= tp.y) { name = 'Lamb02'; flip = true;  ox = -22; oy = -30; }
        else            { name = 'Lamb01'; flip = false; ox = -27; oy = -20; }
      } else if (sy >= tp.y) { name = 'Lamb02'; flip = false; ox = -16; oy = -30; }
      else                   { name = 'Lamb01'; flip = true;  ox = -12; oy = -20; }
      const jx = npcRand(40) - 20;               // IDA:16521-16522
      const jy = npcRand(30) - 15;
      const dur = npcRand(5) + 15;               // key duration (ticks)
      this.lambs.push(new Lamb(name, this.assets[name] || null, flip, ox, oy,
        { x: sx, y: sy }, { x: tp.x + jx, y: tp.y + jy }, dur));
    }
  },

  //--- Occupancy -------------------------------------------------------------
  // Sven's move test, entity part of sub_43694C (IDA:24993-25050): a land
  // cell is enterable only if bytes 0/1/2 (leaving/incoming/present) are all
  // zero, i.e. no other entity is in, entering or leaving it. Lambs are tweens
  // and never block.
  isNpcBlocking(col, row) {
    const b = npcCellBits(this, col, row, this.sven);
    return !!(b.b0 || b.b1 || b.b2);
  },

});

// sub_424B7F (lamb cleanup) runs inline in Game.tickWorld before the
// GAME_TICK_HOOKS (IDA:15611 before GameSound IDA:15613).
