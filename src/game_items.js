//=== Game methods: game_items (prototype mixin) =================================
// Mushrooms (spawn, pickup, sub_438C31 dispatcher), Sven mushroom mode + Saint
// timers, drown relocation helpers. Owner: mushrooms-hazards-saint
// (see audit/OWNERSHIP.md, audit/requests/mushrooms-hazards-saint.md).
//
// Timers are GetTickCount deadlines like the original (Sven [48]/[49], IDA:25795,
// 25803, 25817, 25494), read through core.js getTickCount() (uptime-like base,
// R3-MHS-01) so a double pause goes negative as in the original. Esc/boss pause converts them to remaining ms and back
// (sub_438ECF / sub_438F26, via game_level.js scenePause / sceneResume). The HUD
// reads [48]/[49] inline (game_screens.js, IDA:15724-15728 / 15856-15861).

Object.assign(Game.prototype, {
  // Sven [47]/[48]/[49] live here because the Sven object is re-created per
  // level (sub_413D74 IDA:9071); reset in GAME_INIT_HOOKS / GAME_LEVEL_HOOKS.
  _initItemState() {
    this.svenMode = 1;            // Sven [47] (sub_4343F3 init IDA:24034)
    this.svenModeEnd = -1;        // Sven [48] deadline ms (remaining ms while paused)
    this.saintEnd = -1;           // Sven [49] (ctor -1, IDA:23912)
  },

  //--- Sven mode ([47]/[48]) --------------------------------------------------
  // sub_438C31 (IDA:25795/25803/25817), sven.js state 0x26 (15 s): [48] = now + ms.
  setSvenMode(mode, ms) {
    this.svenMode = mode;
    this.svenModeEnd = getTickCount() + ms;
  },
  // this[47]=1; this[48]=-1 (e.g. IDA:24318).
  clearSvenMode() {
    this.svenMode = 1;
    this.svenModeEnd = -1;
  },

  //--- Saint ([49]) -----------------------------------------------------------
  // sub_438536 (IDA:25485-25497): only on p8401 levels (L>=4); overwrites the
  // deadline and sets the Saint-Disc visible byte (this[39]+37 = 1).
  startSaint(secs) {
    if (!(this.difficulty && this.difficulty.saintModeEnabled)) return;
    this.saintEnd = getTickCount() + 1000 * secs;
    if (this.sven) this.sven.haloHidden = false;
  },
  // sub_438ECF (IDA:25878): positive deadlines → remaining ms (may be <= 0).
  svenTimersPause() {
    const now = getTickCount();
    if (this.saintEnd > 0) this.saintEnd -= now;
    if (this.svenModeEnd > 0) this.svenModeEnd -= now;
  },
  // sub_438F26 (IDA:25900): positive remaining → deadline. A remaining value
  // <= 0 stays as is (mode then never expires by time, saint expires next tick).
  svenTimersResume() {
    const now = getTickCount();
    if (this.saintEnd > 0) this.saintEnd += now;
    if (this.svenModeEnd > 0) this.svenModeEnd += now;
  },

  //--- Sven tick part (sub_434852 IDA:24113-24126) ----------------------------
  // Called by Sven.update with this[21] (step tick). Mode expiry only when not
  // mid-step and `now > [48]`; mode 4 expiry sends dog event 0. Saint expiry
  // (`now > [49]`) hides the disc via saintActive.
  tickSvenTimers(stepTick) {
    const now = getTickCount();
    if (!stepTick && this.svenModeEnd > 0 && now > this.svenModeEnd) {
      this.svenModeEnd = -1;
      if (this.svenMode === 4) this.dogEvent(0);      // sub_405C45(dog, 0)
      this.svenMode = 1;
    }
    if (now > this.saintEnd) this.saintEnd = -1;
  },

  //--- Random mushroom spawner ------------------------------------------------
  // ONE iteration of the sub_421856 spawn loop (IDA:15540-15594). The queue
  // (scene [39]/[40], sub_42006D / sub_424E7D cases 0 and 25) is level-flow's:
  // queueMushroomSpawn(n) + their tick hook call this once per pending entry.
  spawnRandomMushroom() {
    return !!this._spawnOneRandomMushroom();
  },
  _spawnOneRandomMushroom() {
    // sub_41535A (IDA:9509): row = rand()%rows (rows = 13, map.js), col =
    // rand()%cols in the map's 1-based grid (row/col 0 is the wall ring) → JS
    // cell (r0-1, c0-1), so 0-based rows -1..11 / cols -1..14; then sub_414E7D.
    const r0 = Math.floor(Math.random() * this.mapInfo.rows);
    const c0 = Math.floor(Math.random() * this.mapInfo.cols);
    const cell = this.findFreeLandCell(c0 - 1, r0 - 1);
    if (!cell) return null;
    // sub_421316 (IDA:15185): first of the 7 slots with [26] == 0, re-armed in
    // place — it stays at its old index in this tick's sorted list (R3-SEAM-05).
    const m = this._freeMushroomSlot();
    if (!m) return null;
    // Position (vtable+16), then the kind roll, then vtable+80 (IDA:15556-15586).
    const kind = rollSpawnMushroomKind();
    const sub = MUSH_CHAR_BY_KIND[kind];
    m.place(cell.col, cell.row, sub, this.assets[MUSH_DEFS[sub].sprite]);
    return m;
  },
  _freeMushroomSlot() {
    for (let i = 0; i < MUSH_SLOTS; i++) {
      if (this.mushrooms[i].kind === 0) return this.mushrooms[i];
    }
    return null;
  },
  // sub_420C51 (IDA:15029-15039): 7 fresh slots per game-scene enter
  // (sub_4211B0), then sub_414AA1 fills them in row-major map order with the
  // Map.ini mushrooms, at most 7. sub_412880 (IDA:8745): Map.ini mushroom
  // chars count only on kind 1 with special flag 0, i.e. plain ' ' terrain.
  buildMushroomSlots(entities) {
    const slots = [];
    for (let i = 0; i < MUSH_SLOTS; i++) slots.push(new Mushroom());
    let n = 0;
    for (const e of entities) {
      if (e.kind !== 'mushroom' || n >= MUSH_SLOTS) continue;
      const ch = this.mapInfo.terrain[e.row] && this.mapInfo.terrain[e.row][e.col];
      if (ch !== ' ') continue;
      slots[n++].place(e.col, e.row, e.sub, this.assets[MUSH_DEFS[e.sub].sprite]);
    }
    return slots;
  },

  // sub_414E7D occupancy: entity bytes 0-2 set, or type 7 (mushroom). The
  // spiral itself is MapInfo.nearestFreeLandCell (core-map-audio).
  // Bytes 0-2 from every live entity (npc_common.js npcCellBits), plus kind 6.
  _itemCellOccupied(col, row) {
    if (this.mushroomAt(col, row)) return true;
    if (this.ufo && this.ufo.isHole(col, row)) return true;     // type 6 is not type 1
    const b = npcCellBits(this, col, row, null);
    return !!(b.b0 | b.b1 | b.b2);
  },
  // sub_414E7D from a JS cell → {col,row} or null.
  findFreeLandCell(col, row) {
    return this.mapInfo.nearestFreeLandCell(col, row, (c, r) => this._itemCellOccupied(c, r));
  },

  //--- Level start (GAME_LEVEL_HOOKS) ------------------------------------------
  initLevelMushrooms() {
    this._initItemState();   // Sven re-created per level: mode 1, no saint.
    // The slots are built by loadLevel (buildMushroomSlots); the 2 level-start
    // random mushrooms (sub_42006D IDA:14531-14532) are queued there too.
  },

  //--- Pickup / consumption -----------------------------------------------------
  // The cell's kind-7 pointer: one of the 7 slots (sub_4211B0).
  mushroomAt(col, row) {
    for (const m of this.mushrooms) {
      if (!m.consumed && m.col === col && m.row === row) return m;
    }
    return null;
  },
  // Removal: cell → type 1, [26]=0, vtable+80 hides it. Returns the mushroom
  // with its kind as it was, or null.
  consumeMushroomAt(col, row) {
    const m = this.mushroomAt(col, row);
    if (!m) return null;
    const eaten = { col: m.col, row: m.row, sub: m.sub, kind: m.kind };
    m.consume();
    return eaten;
  },
  // sub_43837E type-7 branch: dispatcher, then removal.
  pickUpMushroomAt(col, row) {
    const m = this.mushroomAt(col, row);
    if (!m) return false;
    this.applyMushroomKind(m.kind);
    m.consume();
    return true;
  },
  // Mermaid emerge end (IDA:11095-11102): item[26] = 0, vtable+80, cell → 1.
  destroyMushroomAt(col, row) {
    const m = this.mushroomAt(col, row);
    if (m) m.consume();
  },

  // sub_438C31 (IDA:25788) — exact dispatcher.
  applyMushroomKind(kind) {
    const saintLevel = !!(this.difficulty && this.difficulty.saintModeEnabled);   // p8401
    switch (kind) {
      case 1:
        if (this.svenMode !== 4) { this.setSvenMode(2, 10000); this.audio.play('mushMode'); }
        break;
      case 2:
        if (this.svenMode !== 4) { this.setSvenMode(3, 13000); this.audio.play('goodFlower'); }
        break;
      case 3:
        // sub_424FFC(3,5) → sub_42EF4C on every CSheep.
        // Every CSheep in the scene list, no state test (IDA:16760-16775).
        for (const sh of this.sheeps || []) sh.dampen();  // sub_42EF4C
        this.audio.play('badFlower');
        break;
      case 5:
        if (this.svenMode !== 4) { this.setSvenMode(5, 5000); this.audio.play('badFlower'); }
        break;
      case 6:
        // sub_424FFC(6,5) → sub_42EEB3 on every CSheep.
        // Every CSheep in the scene list, no state test (IDA:16777-16790).
        for (const sh of this.sheeps || []) sh.boost600(); // sub_42EEB3
        this.audio.play('goodFlower');
        break;
      case 7:
        if (saintLevel) { this.startSaint(10); this.audio.play('saintSven'); }
        else this.addScore(10);
        break;
      case 8:
        if (this.lives < 15) {
          this.lives++;
          this.audio.play('electro');                     // aLightning_2
          this.startLifeIconAnim();                       // sub_424FFC(8,5) icon drop-in (IDA:16808-16812)
        } else {
          if (saintLevel) this.startSaint(10);
          else this.addScore(10);
          this.audio.play('goodFlower');                  // aGoodflower_1
        }
        break;
      case 9:
        this.addLevelTime(20000);                         // sub_424FFC(9,5)
        this.audio.play('goodFlower');
        break;
      case 10:
        // Unreachable: nothing produces kind 10.
        this.addScore(2);
        this.audio.play('goodFlower');
        break;
    }
    return true;
  },

  //--- Drown relocation ---------------------------------------------------------
  // sub_43473D(this,1) (IDA:24072): sub_425916 → sub_414E7D → facing rand()%4.
  svenRelocateCell() {
    // sub_425916 (IDA:17027): 'a' list (≤10, row-major), random start, first with
    // Manhattan distance from the dog (scene+120) >= p8328 (sub_4175DC IDA:10208,
    // L>=20 ? 2 : 5-3L/20), else the start entry; then sub_414E7D. Both are
    // MapInfo.teleportDestFor (core-map-audio). Every level has a 'd' (sub_414472
    // IDA:9105 places the CDog there).
    const cell = this.mapInfo.teleportDestFor(this.dogs[0], this.difficulty.p8328,
      (c, r) => this._itemCellOccupied(c, r));
    return { col: cell.col, row: cell.row, facing: Math.floor(Math.random() * 4) };
  },
  // sub_434A6A case 0x1E tail (IDA:24410): sub_419C24 — wake the mermaid.
  onSvenDrownRelocated() {
    if (this.mermaid) this.mermaid.onSvenDrowned();
  },

  //--- Saint halo -------------------------------------------------------------
  // Sven's Saint-Disc sub-sprite (sub_43707B, visible while [49] > 0).
  drawSaintHalo(g) {
    if (!this.saintActive) return;
    const s = this.sven;
    if (!s || s.hideHalo) return;
    const disc = this.assets['Saint-Disc'];
    if (!disc) return;
    const { x: ax, y: ay } = s.screenPos();
    // off_495F30 / off_495F90 per-direction {dx,dy,flip} (core.js SPRITE_OFFSETS),
    // set only at Sven state entry with this[14] of that moment (e.g. IDA:25140):
    // Sven.haloDir, not the live facing (R5-SVEN-03; a UFO return flips the
    // facing in sub_438A80 IDA:25708-25716 but keeps the record).
    const o = spriteRecord('SaintDisc', s.haloDir);
    disc.drawFrame(g, 0, ax + o.dx, ay + o.dy - disc.frameH, o.flip);
  },

});

//--- Accessors (getters can't go through Object.assign) ------------------------
Object.defineProperties(Game.prototype, {
  // Sven [49] > 0 — read by dog/shepherd/sheep attack gates and the halo/HUD.
  saintActive: {
    configurable: true,
    get() { return this.saintEnd > 0; },
  },
});

GAME_INIT_HOOKS.push(function () { this._initItemState(); });
GAME_LEVEL_HOOKS.push(function () { this.initLevelMushrooms(); });
