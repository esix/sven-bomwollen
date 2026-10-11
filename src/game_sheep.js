//=== Game methods: game_sheep (prototype mixin) =================================
// Scene-side glue for the CSheep port (sheep.js). Owner: see audit/OWNERSHIP.md.
// Globals of the original kept on the Game instance:
//   sheepCount     dword_49BA24  sheep placed by the level parser
//   sheepRemaining dword_49BA28  decremented at state 12 / 8 / demon-stoned / UFO 'R'
//   poolMax        dword_49BA1C  3000 * sheepCount
//   pool           dword_49BA20  sum of stamina, -1 per draining sheep per tick
//   sheepDemons    dword_49BA2C  concurrent demon cap (< 3)
// (Chew / Mee throttles dword_49BA38 / dword_49BA3C live in audio.js.)
Object.assign(Game.prototype, {

  // sub_425311 (IDA:16846): 10 "sheep reached mood 10" events inside 60 s
  // (same entity within 3 s ignored) → Saint 15 s on L>=4 (+8401) else +10.
  // Called from Sheep._shagResult (sub_42EB56 IDA:21636) and the mermaid.
  recordCatch(entity) {
    const nowMs = getTickCount();             // GetTickCount (sub_425311)
    if (this.catchBuffer.length
        && this.catchBuffer[0].id === entity
        && nowMs - this.catchBuffer[0].t < 3000) {
      return;
    }
    this.catchBuffer = this.catchBuffer.filter(e => nowMs - e.t <= 60000);
    this.catchBuffer.unshift({ id: entity, t: nowMs });
    if (this.catchBuffer.length >= 10) {
      this.catchBuffer = [];
      if (this.difficulty.saintModeEnabled) {
        this.startSaint(15);             // sub_438536(15)
        this.audio.play('saintSven');    // aSvensaint_0
      } else {
        this.addScore(10);               // sub_42A2CB(10)
      }
    }
  },

  // Cell bytes 0..2 non-zero (sub_42F992 walk test, IDA:21995): any
  // entity present, incoming or leaving (npc_common.js npcCellBits: Sven,
  // sheep, mermaid, dogs, shepherds; see their occupancyAt). `exclude` =
  // the mover itself. Lambs are CTweens with no cell (sub_424735).
  sheepCellOccupied(col, row, exclude) {
    const b = npcCellBits(this, col, row, exclude);
    return !!(b.b0 | b.b1 | b.b2);
  },

  // The sheep in a cell (Sven's front-cell lookup for sub_43633C /
  // sub_434A6A case 0x1F): cell ptr under (byte2 & 0xF0) != 0, i.e. the
  // present bit, which exists only on the logical cell (vt+56/+52 at the
  // half-step). A demon (code 8 → byte2 0x08) is not in 0xF0.
  sheepAt(col, row) {
    for (const s of this.sheeps) {
      if (s.demonCell) continue;
      if (s.occupancyAt(col, row).present) return s;
    }
    return null;
  },

  // --dword_49BA28 (IDA:20363, 20412, 20146; UFO 'R' IDA:27051).
  sheepRemainingDec() {
    this.sheepRemaining--;
  },

  // sub_424E7D(16) (IDA:16714): sub_42EF8B on every CSheep after a demon zap.
  sheepGlobalCalm() {
    for (const s of this.sheeps) s.calm();
  },

  // dword_49BA0C: one shared Bzzzt anim (sub_41C480, seq unk_494DA8,
  // record off_494D90 (-50,10)); created at scene init (IDA:21155-21178),
  // advanced by every zapping sheep's draw.
  sheepBzzzt() {
    if (!this._sheepBzzzt) {
      const sheet = this.assets && this.assets['Bzzzt'];
      if (!sheet) return null;
      const a = new SheepSeqAnim();
      a.setSeq(SHEEP_SEQ.bzzzt);
      a.setSprite('Bzzzt', sheet);          // sub_407122 → sub_401B62: end = 2 sprite frames
      a.setSpeed(1);
      a.flip = false;
      a.xo = SHEEP_TBL.bzzzt[1];
      a.yo = SHEEP_TBL.bzzzt[2] - sheet.frameH;
      this._sheepBzzzt = a;
    }
    return this._sheepBzzzt;
  },
});

// Scene-lifetime globals.
GAME_INIT_HOOKS.push(function () {
  this.sheepCount = 0;
  this.sheepRemaining = 0;
  this.sheepDemons = 0;
  this._sheepBzzzt = null;
});

// Level spawn: sub_412880 IDA:8797-8800 (counts, poolMax, demon cap),
// sub_413D74 IDA:8848 (pool = 0), IDA:8925-8936 (per-sheep vt+40 init,
// +148 bit0 only on the first S/W cell in row-major order when +8405).
GAME_LEVEL_HOOKS.push(function () {
  this.sheepCount = this.sheeps.length;              // dword_49BA24
  this.sheepRemaining = this.sheepCount;             // dword_49BA28
  this.poolMax = 3000 * this.sheepCount;             // dword_49BA1C
  this.sheepDemons = 0;                              // dword_49BA2C
  this.pool = 0;                                     // dword_49BA20
  let firstSpecial = true;
  for (const s of this.sheeps) {
    if (s.special) { s.special = firstSpecial; firstSpecial = false; }
    s.init(this);                                    // sub_42ABDF
  }
});
