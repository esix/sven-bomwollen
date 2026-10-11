// Map.ini loader — sub_4125FD (levels), sub_412880 (terrain + entities).
// Terrain comes only from [Terrain]; [LevelNN] rows only place entities.
// Terrain char → cell kind (cell byte 3 low nibble, IDA:8517-8566):
//   ' ' '_' '.' 'a' → 1 land, '#' → 2 wall, 'c' → 3 cliff, '&' → 4 bush,
//   'p' → 5 puddle; missing chars read as '#' (IDA:8549-8552).
// "Special" flag (byte 3 bits 4-5): '_' → 1, '.' → 2, 'a' → 3, else 0. A move
// whose source and target cells carry the same non-zero flag is rejected by
// every mover (Sven sub_43694C IDA:25013, sheep sub_42F3ED IDA:21957/21998,
// sub_42F992, shepherd IDA:22733/22874, dog IDA:1419/1572/1709).
const TERRAIN_KIND = { ' ': 1, '_': 1, '.': 1, 'a': 1, '#': 2, 'c': 3, '&': 4, 'p': 5 };
const SPECIAL_FLAG = { '_': 1, '.': 2, 'a': 3 };

class MapInfo {
  constructor(ini) {
    // [MapInfo] is never read: sub_4125FD hard-codes 12/16 (IDA:8393-8394)
    // and sub_412880 overwrites them with the [Terrain] array (IDA:8520-8521).
    // sub_40B62A (IDA:5118-5134) reads Row00, Row01, … and on the first
    // missing key still appends the empty default string before stopping, so
    // rows = (number of RowNN) + 1 = 13; cols = longest row strlen (16).
    // The extra row is '' → every cell reads '#' (IDA:8549-8552).
    this.terrain = [];
    for (let r = 0; ; r++) {
      const v = ini.Terrain[`Row${String(r).padStart(2, '0')}`];
      this.terrain.push(v === undefined ? '' : v);
      if (v === undefined) break;
    }
    this.rows = this.terrain.length;
    this.cols = Math.max(...this.terrain.map((t) => t.length));
    this.terrain = this.terrain.map((t) => t.padEnd(this.cols, '#'));
    // sub_4125FD (IDA:8405-8417): levels 1.. are read until the first missing
    // section, at most 20.
    let n = 0;
    while (n < 20 && ini[`Level${String(n + 1).padStart(2, '0')}`]) n++;
    this.levelCount = n;
    // Puddle list sub_414871 and 'a' list sub_4149C4: row-major scan, at most
    // 10 entries each (dword_49B160 / dword_49B164 = 10, IDA:15043-15045).
    this.puddles = [];
    this.teleportDests = [];
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const ch = this.terrain[r][c];
        if (ch === 'p' && this.puddles.length < 10) this.puddles.push({ col: c, row: r });
        if (ch === 'a' && this.teleportDests.length < 10) this.teleportDests.push({ col: c, row: r });
      }
    }
  }
  _ch(col, row) {
    if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) return '#';
    return this.terrain[row][col];
  }
  // Cell kind 1..5 (out of the grid = 2, the border ring is walls, IDA:8523).
  // An unknown in-grid char leaves the cleared kind 0 (`default: continue`,
  // IDA:8542/8607).
  terrainKind(col, row) {
    return TERRAIN_KIND[this._ch(col, row)] || 0;
  }
  // Special flag 0..3 of a cell ('_'=1, '.'=2, 'a'=3).
  specialFlag(col, row) {
    return SPECIAL_FLAG[this._ch(col, row)] || 0;
  }
  // Shared walk rule (IDA:25013-25017): true when a step from (fc,fr) to
  // (tc,tr) is forbidden because both cells have the same non-zero special
  // flag ('_'→'_', '.'→'.', 'a'→'a'). All movers must call this.
  isSameSpecialStep(fc, fr, tc, tr) {
    const f = this.specialFlag(fc, fr);
    return f !== 0 && f === this.specialFlag(tc, tr);
  }
  // sub_4127C2 (IDA:8434): a2 < 1 → [2079]=[2080]=1 and returns false (JS
  // returns that written level 1, used only by game.js startGameFromLevel);
  // a2 past the last level → nothing written, null (end of game).
  validLevelOrNull(target) {
    let lvl = target;
    if (lvl < 1) lvl = 1;
    if (lvl > this.levelCount) return null;
    return lvl;
  }
  // sub_425916 (IDA:17026-17058): start at a random index of the 'a' list,
  // walk it cyclically and take the first cell with Manhattan distance to the
  // dog >= threshold; none → the random start cell. The dog (scene +120) always
  // exists; an empty list is `rand() % 0` in the original (every level has 'a').
  // threshold = **(scene+112) = map +8328 = p8328 (IDA:8003 `v8[28] =
  // this[49] + 8328`); game.svenRelocateCell passes difficulty.p8328.
  pickTeleportAnchor(dog, threshold) {
    const list = this.teleportDests;
    const start = Math.floor(Math.random() * list.length);
    let idx = start;
    for (let i = 0; i < list.length; i++) {
      if (idx === list.length) idx = 0;
      const d = list[idx];
      const dist = Math.abs(dog.row - d.row) + Math.abs(dog.col - d.col);
      if (dist >= threshold) return { col: d.col, row: d.row };
      idx++;
    }
    return { col: list[start].col, row: list[start].row };
  }
  // sub_414E7D (IDA:9370-9496): square spiral from (col,row) — check the
  // current cell, then walk col+ / row- / col- / row+ legs, each extended by
  // one per lap until all four grid edges are hit — returning the first cell
  // of kind 1 with no entity on it (IDA:9426-9428 tests kind 7 or 1 with
  // bytes 0-2 empty but throws only when kind != 7, so only kind 1 succeeds).
  // isOccupied(col,row) must report sheep/dog/shepherd/Sven/lamb/mushroom
  // presence. Returns null if none. The catch funclet at 0x41531F stores the
  // tested cell (row [ebp-0x18], col [ebp-0x14]) and returns 1.
  nearestFreeLandCell(col, row, isOccupied) {
    // Original works on 1-based (row i, col j) with the wall ring at 0 and
    // rows+1/cols+1; translate.
    let r = row + 1, c = col + 1;
    let maxC = c, minR = r, minC = c, maxR = r, done = 0;
    const ok = (rr, cc) => {
      const c0 = cc - 1, r0 = rr - 1;
      if (this.terrainKind(c0, r0) !== 1) return false;
      return !(isOccupied && isOccupied(c0, r0));
    };
    do {
      if (maxC >= this.cols) done |= 1;
      else { ++maxC; do { if (ok(r, c)) return { col: c - 1, row: r - 1 }; ++c; } while (c < maxC); }
      if (minR <= 0) done |= 2;
      else { --minR; do { if (ok(r, c)) return { col: c - 1, row: r - 1 }; --r; } while (r > minR); }
      if (minC <= 0) done |= 4;
      else { --minC; do { if (ok(r, c)) return { col: c - 1, row: r - 1 }; --c; } while (c > minC); }
      if (maxR >= this.rows) done |= 8;
      else { ++maxR; do { if (ok(r, c)) return { col: c - 1, row: r - 1 }; ++r; } while (r < maxR); }
    } while (done !== 15);
    return null;
  }
  // Sven's teleport/drown relocation, sub_43473D(this, 1) (IDA vtable+80):
  // anchor via sub_425916, then sub_414E7D; facing = rand()%4 is the caller's.
  teleportDestFor(dog, threshold, isOccupied) {
    const a = this.pickTeleportAnchor(dog, threshold);
    return this.nearestFreeLandCell(a.col, a.row, isOccupied) || a;
  }
}

class Level {
  // key = 'LevelNN'. Port of the entity pass of sub_412880 (IDA:8670-8792):
  // entities are read only where the terrain kind is 1. specialFlag = map +8405
  // as it is at parse time, i.e. from the PREVIOUS sub_4175DC (it runs after
  // the parse, IDA:14501-14502); the caller passes it.
  constructor(mapInfo, ini, key, specialFlag = false) {
    this.mapInfo = mapInfo;
    this.entities = [];   // { kind, col, row, dir? }
    this.svenSpawn = null;
    const sec = ini[key];
    if (!sec) throw new Error('No section ' + key);
    const specialAllowed = !!specialFlag;       // `if (*(this+8405))` (IDA:8663/8667)
    let haveSpecial = false, haveDog = false, haveShep = false;
    const sheep = (c, r, dir, isSpecialChar) => {
      // Only the first 'S'/'W' with +8405 set becomes the special sheep
      // (+8260/+8264, IDA:8786); others are ordinary sheep with that facing.
      const special = isSpecialChar && specialAllowed && !haveSpecial;
      if (special) haveSpecial = true;
      this.entities.push({ kind: special ? 'special' : 'sheep', col: c, row: r, dir });
    };
    // sub_40B741 → sub_40B62A: the LevelNN array also ends with an empty
    // row; rows past it are never reached (the 13th terrain row is '#').
    for (let r = 0; r < mapInfo.rows; r++) {
      const row = (sec[`Row${String(r).padStart(2, '0')}`] || '').padEnd(mapInfo.cols, '#');
      for (let c = 0; c < mapInfo.cols; c++) {
        if (mapInfo.terrainKind(c, r) !== 1) continue;
        const ch = row[c];
        switch (ch) {
          case 'e': case 'E': sheep(c, r, DIR.NE, false); break;
          case 'n': case 'N': sheep(c, r, DIR.NW, false); break;
          case 'w': sheep(c, r, DIR.SW, false); break;
          case 's': sheep(c, r, DIR.SE, false); break;
          case 'W': sheep(c, r, DIR.SW, true); break;   // LABEL_58
          case 'S': sheep(c, r, DIR.SE, true); break;   // LABEL_61
          // f/d/m: only the first occurrence counts (IDA:8697-8745).
          case 'f': if (!this.svenSpawn) this.svenSpawn = { col: c, row: r }; break;
          case 'd': if (!haveDog)  { haveDog = true;  this.entities.push({ kind: 'dog', col: c, row: r }); } break;
          case 'm': if (!haveShep) { haveShep = true; this.entities.push({ kind: 'shepherd', col: c, row: r }); } break;
          // Mushrooms only on cells whose special flag is 0 (IDA:8745) —
          // e.g. Level20 'v' on a '_' cell is never placed.
          case 't': case 'u': case 'v': case 'x': case 'y': case 'z':
            if (mapInfo.specialFlag(c, r) === 0)
              this.entities.push({ kind: 'mushroom', sub: ch, col: c, row: r });
            break;
        }
      }
    }
  }
}
