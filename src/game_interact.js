//=== Game methods: game_interact (prototype mixin) ==============================
// Glue between Game and the Sven state machine (sven.js): map/entity cell
// query and level attach. Owner: sven-player
// (see audit/OWNERSHIP.md).

Object.assign(Game.prototype, {

  // Map cell as Sven's code sees it (cell byte 3 type + occupancy).
  // type: 0 unknown char, 1 ground (' ', '_', '.', 'a'), 2 '#', 3 'c' cliff,
  // 4 '&' bush, 5 'p' puddle, 6 UFO landing (Sven abducted), 7 item cell.
  svenCellInfo(col, row) {
    const mi = this.mapInfo;
    let type = 2;
    if (row >= 0 && row < mi.rows && col >= 0 && col < mi.cols) {
      switch (mi.terrain[row][col]) {
        case ' ': type = 1; break;
        case '_': case '.': case 'a': type = 1; break;
        case '#': type = 2; break;
        case '&': type = 4; break;
        case 'c': type = 3; break;
        case 'p': type = 5; break;
        default:  type = 0; break;
      }
    }
    // Type 6 = UFO abduction cell (sheep IDA:20250, Sven IDA:24313); type 7 = item (sub_414AA1).
    if (type === 1 && this.ufo && this.ufo.isHole(col, row)) type = 6;
    else if (type === 1 && this.mushroomAt(col, row)) type = 7;
    // Cell ptr under (byte2 & 0xF0) != 0 (sub_43694C IDA:25032, sub_43633C,
    // sub_4154B6): present bit of a sheep (codes 1-4) or the mermaid (code 4)
    // on its logical cell only; a cell only reserved (byte0/byte1) or holding
    // a demon (code 8, byte2 0x08) gives no sheep, just `occupied`.
    let sheep = this.sheepAt(col, row);
    const mm = this.mermaid;                                              // CMermaid extends CSheep
    if (!sheep && mm && mm.occupancyAt(col, row).present) sheep = mm;
    let dog = null;                                                       // cell byte2 & 4
    for (const d of this.dogs) if (d.occupancyAt(col, row).present) { dog = d; break; }
    const occupied = !!sheep || !!dog || this.isNpcBlocking(col, row);
    return { type, sheep, dog, occupied };
  },

});

// Attach Sven to the game each level (the Sven object is re-created per level).
GAME_LEVEL_HOOKS.push(function () {
  this.sven.game = this;
  this.svenActionReleased = true;   // Sven ctor: +148 = 1 (sub_434120)
  this.svenHeldAction = -1;         // init sub_434443: +140 = -1 (IDA:24038)
});
