// Regression suite for the JS port (replaces the old playtest/test_* scripts
// that tested pre-audit invented behaviour). Drives http://localhost:8088/
// with Playwright, pokes window.game, checks the decompile-derived behaviour.
// Usage: node test_suite.js [name,name,...]   (screenshots → $SHOTS or os.tmpdir())
const { chromium } = require('playwright');
const path = require('path');
const os = require('os');
const URL = process.env.SVEN_URL || 'http://localhost:8088/';
const SHOTS = process.env.SHOTS || os.tmpdir();
const filter = (process.argv[2] || '').split(',').filter(Boolean);

// Page-side helpers (installed after load).
function installHelpers() {
  const g = window.game;
  window.T = {
    // Put Sven idle on a cell (state 28, no step in progress).
    placeSven(col, row, dir) {
      const s = g.sven;
      s.col = col; s.row = row; s.facing = dir;
      s.fromCol = s.toCol = col; s.fromRow = s.toRow = row; s.stepTick = 0;
      const p = cellToScreen(col, row); s.px = p.x; s.py = p.y;
      s.events = []; s.state = 0; s.req = 0; s.timer = 1; s.onGrid = true;
      g.svenHeldAction = -1; g.svenActionReleased = true;
    },
    // Remove every other actor so a scenario is deterministic.
    isolate({ keepSheep = [], keepDogs = false, keepShep = false, keepMermaid = false } = {}) {
      g.sheeps = g.sheeps.filter(s => keepSheep.includes(s));
      if (!keepDogs) g.dogs = [T.inertDog(g.dogs[0])];
      if (!keepShep) g.shepherds = [];
      g.mushrooms = g.buildMushroomSlots([]); g.mushSpawnPending = 0; g.mushSpawnDelay = -1;
      g.ufo = null; if (!keepMermaid) g.mermaid = null; g.lambSpawned = true;
      g.sheepRemaining = 1000;   // dword_49BA28: no level advance
    },
    // The scene's dog (+120) always exists in the original and the port reads
    // it unguarded (svenRelocateCell → pickTeleportAnchor). Isolation swaps it
    // for an inert stand-in at the real dog's cell: no tick, no draw, no cell.
    inertDog(d) {
      const p = cellToScreen(d.col, d.row);
      return { col: d.col, row: d.row, dir: d.dir, state: 0, visible: false, _depthY: p.y, _depthX: p.x,
        update() {}, draw() {}, event() {}, howl() {}, occupancyAt() { return { present: false }; },
        canBeDogshagged() { return false; } };
    },
    placeSheep(sh, col, row, dir) {
      sh.col = col; sh.row = row; sh.dir = dir; sh.stepping = false;
      const p = cellToScreen(col, row); sh.x = p.x; sh.y = p.y;
      sh._applyTbl(sh.anim, SHEEP_TBL.walk[dir]);
      sh._applyTbl(sh.sym, SHEEP_TBL.sym[dir]);
      sh.state = 1; sh.req = 0; sh.qlen = 0; sh.timer = 10000;
    },
    snap() {
      const s = g.sven;
      return { gstate: g.gstate, tick: g.tickCount, lvl: g.levelIdx, score: g.score, lives: g.lives,
        clock: Math.round(g.levelTimeMs), sven: [s.col, s.row, s.facing, s.state], mode: g.svenMode,
        hold: g.endHoldMs };
    },
  };
}

const results = [];
function check(name, cond, info) {
  results.push({ name, ok: !!cond, info });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info !== undefined ? '  ' + JSON.stringify(info) : ''}`);
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 640, height: 480 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR ' + e.message + ' @ ' + (e.stack || '').split('\n')[1]));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text()); });
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const ticks = async n => {
    const t0 = await ev(() => game.tickCount);
    await page.waitForFunction(t => game.tickCount >= t, t0 + n, { timeout: 60000 });
  };
  const until = (fn, arg, timeout = 20000) => page.waitForFunction(fn, arg, { timeout, polling: 'raf' })
    .then(() => true, () => false);
  const shot = name => page.screenshot({ path: path.join(SHOTS, `suite_${name}.png`) });
  // T.placeSven leaves Sven in state 0; his next tick resolves 0 → 28 and clears
  // the key flag (sub_434A6A case 0/27). A keydown is edge-triggered (+136 set
  // only by WM_KEYDOWN incl. auto-repeat, R3-SV-01), so let him settle first.
  const settle = () => ticks(2);
  const tap = async key => { await page.keyboard.down(key); await ticks(2); await page.keyboard.up(key); };
  const newGame = async (lvl = 1) => {
    await ev(l => { game.switchScene('playing', 0); if (l !== 1) game.startGameFromLevel(l); }, lvl);
    await ticks(3);
  };
  const run = async (name, fn) => {
    if (filter.length && !filter.includes(name)) return;
    try { await fn(); } catch (e) { check(name + ' (exception)', false, String(e).slice(0, 300)); }
  };

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.game && game.gstate === 'title', null, { timeout: 30000 });
  await ev(installHelpers);

  await run('title', async () => {
    await ticks(0); await page.waitForTimeout(500);
    await shot('title');
    // Start button (focused) → reload scene → level 1 when the saved level <= 1.
    await ev(() => localStorage.clear());
    await ev(() => { game.highestLevel = 1; });
    await page.keyboard.press('Enter');
    check('start: Enter on title starts level 1', await until(() => game.gstate === 'playing'), await ev(() => T.snap()));
    const s = await ev(() => T.snap());
    check('start: lives 3, score 0, clock ~90 s', s.lives === 3 && s.score === 0 && s.clock > 85000 && s.clock <= 90000, s);
    const t0 = await ev(() => [game.tickCount, performance.now()]);
    await page.waitForTimeout(2000);
    const t1 = await ev(() => [game.tickCount, performance.now()]);
    const hz = (t1[0] - t0[0]) / ((t1[1] - t0[1]) / 1000);
    check('loop: game scene ticks at 20 Hz', hz > 18 && hz < 21, { hz: +hz.toFixed(2) });
    const c0 = await ev(() => game.levelTimeMs);
    await page.waitForTimeout(1000);
    const c1 = await ev(() => game.levelTimeMs);
    check('clock: wall time, 1 s per second', Math.abs((c0 - c1) - 1000) < 120, { d: c0 - c1 });
    await ticks(2);
    check('level start: 2 random mushrooms spawned (IDA:14531)', await ev(() => game.mushrooms.filter(m => !m.consumed).length) >= 1,
      await ev(() => game.mushrooms.map(m => [m.col, m.row, m.kind])));
    await shot('level1');
  });

  await run('walk', async () => {
    await newGame(1);
    await ev(() => { T.isolate(); T.placeSven(7, 6, 2); });
    await settle();
    await page.keyboard.down('ArrowUp');                 // slot 0 = NE (col+1)
    await until(() => game.sven.stepTick > 0);
    const t0 = await ev(() => game.tickCount);
    await page.keyboard.up('ArrowUp');
    await until(() => game.sven.stepTick === 0);
    const t1 = await ev(() => game.tickCount);
    const s = await ev(() => T.snap());
    check('walk: one NE step to (8,6), facing NE', s.sven[0] === 8 && s.sven[1] === 6 && s.sven[2] === 0, s);
    check('walk: step lasts 8 ticks (dword_495A84)', t1 - t0 >= 7 && t1 - t0 <= 9, { ticks: t1 - t0 });
    // Wall: no turn, no step.
    await ev(() => T.placeSven(1, 4, 2));
    await settle();
    await tap('ArrowDown');                              // SW into '#'
    await ticks(10);
    const w = await ev(() => T.snap());
    check('walk: wall refuses the step (stays, state 28)', w.sven[0] === 1 && w.sven[1] === 4 && w.sven[3] === 28, w);
  });

  await run('whistle', async () => {
    await newGame(1);
    await ev(() => { const sh = game.sheeps[0]; T.isolate({ keepSheep: [sh] }); T.placeSven(7, 6, 0); T.placeSheep(sh, 8, 6, 2); });
    await settle();
    await tap('Space');
    check('whistle: misaligned sheep → Sven state 31', await until(() => game.sven.state === 31, null, 3000));
    const ok = await until(() => game.sheeps[0].state === 5, null, 4000);
    check('whistle: after 24 ticks the sheep accepts (state 5) and takes Sven dir', ok && await ev(() => game.sheeps[0].dir === 0),
      await ev(() => [game.sheeps[0].state, game.sheeps[0].dir]));
    await shot('whistle_accept');
  });

  await run('shag', async () => {
    await newGame(1);
    await ev(() => {
      const sh = game.sheeps[0]; T.isolate({ keepSheep: [sh] }); T.placeSven(7, 6, 0); T.placeSheep(sh, 8, 6, 0);
      sh.stamina = 2990; sh.mood(0); game.score = 0;
    });
    await settle();
    const clock0 = await ev(() => game.levelEndAt);
    let first = null;
    for (let i = 0; i < 40; i++) {
      await page.keyboard.down('Space'); await ticks(2); await page.keyboard.up('Space'); await ticks(1);
      if (first === null && await ev(() => game.sven.state === 32)) { first = true; await shot('shag'); }
      if (await ev(() => game.sheeps[0].state >= 10)) break;
    }
    check('shag: aligned press → Sven 32 (hidden) + sheep 6', first === true);
    check('shag: three shags → sheep satisfied (state 10)', await ev(() => game.sheeps[0].state >= 10), await ev(() => [game.sheeps[0].state, game.sheeps[0].love, game.score]));
    await shot('shag_hearts');
    const exploded = await until(() => game.sheeps[0].state === 12, null, 15000);
    const r = await ev(c0 => ({ score: game.score, dClock: Math.round(game.levelEndAt - c0), rem: game.sheepRemaining, caught: game.sheeps[0].caught }), clock0);
    check('shag: love 7 → explosion → removed (state 12), remaining--', exploded && r.caught && r.rem === 999, r);
    check('shag: +1 per shag, +10 on catch, +10 s on the clock (IDA:20130, 16706)', r.score >= 13 && r.dClock >= 9900 && r.dClock <= 10100, r);
  });

  await run('kick', async () => {
    await newGame(1);
    await ev(() => {
      const sh = game.sheeps[0]; T.isolate({ keepSheep: [sh] }); T.placeSven(7, 6, 0); T.placeSheep(sh, 8, 6, 0);
      sh.stamina = -250; sh.moodLevel = 99; sh.mood(0); sh.stamina = -100; sh.kicks = 0; game.score = 100;   // mood 0, far from −1
    });
    await settle();
    const mood = await ev(() => game.sheeps[0].moodLevel);
    await tap('Space');
    check('kick: unhappy sheep (mood 0) refuses → Sven 34, sheep 9', await until(() => game.sven.state === 34 && game.sheeps[0].state === 9, null, 3000), { mood });
    await shot('kick');
    await until(() => game.sven.state === 28, null, 4000);
    const r = await ev(() => ({ score: game.score, facing: game.sven.facing, kicks: game.sheeps[0].kicks, pos: [game.sven.col, game.sven.row] }));
    check('kick: −4 score, kicks++, Sven stays and turns 0→3 (IDA:24527)', r.score === 96 && r.kicks === 1 && r.facing === 3 && r.pos[0] === 7, r);
  });

  await run('drown', async () => {
    await newGame(1);
    await ev(() => { T.isolate(); T.placeSven(6, 9, 2); game.score = 50; });
    await settle();
    await tap('ArrowRight');                             // SE (row+1) into the cliff 'c' (6,10)
    check('drown: cliff → Sven state 30 (splash)', await until(() => game.sven.state === 30, null, 3000));
    await ticks(4); await shot('drown_splash');
    check('drown: relocated, blink 27 → stand 28', await until(() => game.sven.state === 28, null, 4000));
    const r = await ev(() => ({ score: game.score, pos: [game.sven.col, game.sven.row], kind: game.mapInfo.terrainKind(game.sven.col, game.sven.row) }));
    check('drown: −2 score, on land near an \'a\' cell', r.score === 48 && r.kind === 1 && !(r.pos[0] === 6 && r.pos[1] === 10), r);
  });

  await run('puddle', async () => {
    await newGame(1);
    await ev(() => { T.isolate(); T.placeSven(3, 6, 0); game.score = 50; });
    await settle();
    await tap('ArrowDown');                              // SW (col-1) into 'p' (2,6)
    check('puddle: → Sven state 46', await until(() => game.sven.state === 46, null, 3000));
    await until(() => game.sven.state === 28, null, 4000);
    const r = await ev(() => ({ score: game.score, pos: [game.sven.col, game.sven.row] }));
    check('puddle: relocated, score unchanged (IDA:25356)', r.score === 50 && !(r.pos[0] === 2 && r.pos[1] === 6), r);
  });

  await run('dogcatch', async () => {
    await newGame(1);
    await ev(() => { T.isolate({ keepDogs: true }); T.placeSven(8, 4, 0); game.dogs[0].event(32); });
    check('dog: shag-press chase catches Sven → state 37..41', await until(() => game.sven.state >= 37 && game.sven.state <= 41, null, 6000),
      await ev(() => [game.sven.state, game.dogs[0].state]));
    await until(() => game.sven.state === 39); await shot('dog_fight');
    await until(() => game.sven.state === 41, null, 3000);
    const l = await ev(() => game.lives);
    check('dog: life lost at the 37-40 → 41 transition (sub_424CB8 \')\')', l === 2, { lives: l });
    const back = await until(() => game.sven.state === 28 && game.sven.col === game.sven.homeCol, null, 8000);
    const r = await ev(() => ({ sven: [game.sven.col, game.sven.row], dog: [game.dogs[0].col, game.dogs[0].row, game.dogs[0].state, game.dogs[0].visible] }));
    check('dog: after the fight Sven + dog go home (event 42)', back && r.dog[0] === 9 && r.dog[1] === 4 && r.dog[3], r);
  });

  await run('shepcatch', async () => {
    await newGame(1);
    await ev(() => { T.isolate({ keepShep: true }); T.placeSven(7, 8, 0); game.shepherds[0].event(32); });
    check('shepherd: chase catches Sven → 38..41', await until(() => game.sven.state >= 38 && game.sven.state <= 41, null, 8000),
      await ev(() => [game.sven.state, game.shepherds[0].state, game.shepherds[0].col, game.shepherds[0].row]));
    await until(() => game.sven.state === 28, null, 8000);
    check('shepherd: one life lost', await ev(() => game.lives) === 2);
  });

  await run('saint', async () => {
    await newGame(4);
    await ev(() => { T.isolate({ keepDogs: true }); T.placeSven(8, 4, 0); game.startSaint(10); game.dogs[0].event(32); });
    await ticks(60);
    const r = await ev(() => ({ st: game.sven.state, lives: game.lives, saint: game.saintActive }));
    check('saint: dog cannot catch Sven while saint (IDA:1411)', r.saint && r.lives === 3 && !(r.st >= 37 && r.st <= 42), r);
    await shot('saint_halo');
  });

  await run('mushroom', async () => {
    await newGame(1);
    await ev(() => { T.isolate(); T.placeSven(7, 6, 0); game.mushrooms[0].place(8, 6, 'v', game.assets.Mushroom); });
    await settle();
    await tap('ArrowUp');
    await until(() => game.svenMode === 2, null, 3000);
    const r = await ev(() => ({ mode: game.svenMode, left: game.svenModeEnd - getTickCount(), step: game.sven.stepTicks(), m: game.mushrooms[0].consumed }));
    check('mushroom v: picked up at step end → mode 2 for 10 s, 3 ticks/cell', r.mode === 2 && r.step === 3 && r.m && r.left > 9000 && r.left <= 10000, r);
    await shot('mushroom_icon');
    await ev(() => { game.mushrooms[1].place(9, 6, 'y', game.assets.Mushroom2); });
    await tap('ArrowUp');
    await until(() => game.svenMode === 3, null, 3000);
    check('mushroom y: mode 3 (13 s)', await ev(() => game.svenMode === 3 && game.svenModeEnd - getTickCount() > 12000));
  });

  await run('timeout', async () => {
    await newGame(1);
    await ev(() => { T.isolate(); T.placeSven(7, 6, 0); game.levelEndAt = getTickCount() + 300; });
    check('timeout: Sven explodes (state 49)', await until(() => game.sven.state === 49, null, 3000));
    await ticks(6); await shot('timeout_explode');
    check('timeout: life lost', await ev(() => game.lives) === 2);
    await until(() => game.sven.state === 28, null, 4000);
    const r = await ev(() => T.snap());
    check('timeout: Sven home, clock reset to 90 s', r.sven[0] === 7 && r.sven[1] === 6 && r.clock > 88000, r);
  });

  await run('gameover', async () => {
    await newGame(1);
    await ev(() => { localStorage.clear(); T.isolate(); game.lives = 1; game.score = 150; game.levelEndAt = getTickCount() + 200; });
    check('game over: end hold starts after the last explode', await until(() => game.endHoldMs > 0, null, 5000), await ev(() => T.snap()));
    await ticks(30); await shot('gameover');
    const frozen = await ev(() => { const s0 = game.score; game.addScore(10); return game.score === s0; });
    check('game over: score frozen (sub_423F9C)', frozen);
    check('game over: hold ends → Top Scores with name entry', await until(() => game.gstate === 'highscores', null, 8000)
      && await ev(() => game.hsEntryActive));
    await page.keyboard.type('Tester');
    await page.keyboard.press('Enter');
    await ticks(0); await page.waitForTimeout(200);
    const r = await ev(() => ({ rank: game.hsEntryRank, table: loadHighScores() }));
    check('top scores: name committed at rank 4 (150 > 100, sub_42A221)', r.rank === 4 && r.table[4].name === 'Tester' && r.table[4].score === 150, r);
    await shot('topscores');
    await page.keyboard.press('Escape');
    check('top scores: Esc → title', await until(() => game.gstate === 'title', null, 3000));
  });

  await run('escdialog', async () => {
    await newGame(1);
    await page.keyboard.press('Escape');
    // Esc = vtable+68 sub_42033E → base pause sub_41CB4E (counter this[16]),
    // not the transition counter this[17] (R2-LF-04).
    const r = await ev(() => ({ esc: game.escDialog, pause: game.basePauseCount, t: game.tickCount }));
    await page.waitForTimeout(400);
    const t2 = await ev(() => game.tickCount);
    check('esc: dialog open, base pause (this[16]), ticks stop', r.esc && r.pause === 1 && t2 === r.t, { r, t2 });
    await shot('escdialog');
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('Enter');
    check('esc: "Нет" closes the dialog and resumes', await ev(() => !game.escDialog && game.basePauseCount === 0 && game.clockPause === 0 && game.gstate === 'playing'));
    // this[25] keeps the last choice (reset only on scene enter, IDA:14524).
    await page.keyboard.press('Escape'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('Enter');
    check('esc: "Да" → title (keyup 0x411A4A)', await until(() => game.gstate === 'title', null, 3000));
  });

  await run('levelup', async () => {
    await newGame(1);
    await ev(() => { game.score = 0; game.sheepRemaining = 0; });
    check('level complete → level 2 with the 60-tick blink', await until(() => game.levelIdx === 2 && game.levelTransitionTicks > 0, null, 3000));
    await ticks(3); await shot('transition');
    const r = await ev(() => ({ score: game.score, pause: game.clockPause, saved: loadProgress() }));
    check('level complete: bonus 5*L + seconds left, clock paused, level saved', r.score >= 5 + 80 && r.pause === 1 && r.saved === 2, r);
    await until(() => game.levelTransitionTicks === 0, null, 6000);
    check('transition ends → clock resumes', await ev(() => game.clockPause === 0));
  });

  await run('demon', async () => {
    await newGame(1);
    await ev(() => {
      const sh = game.sheeps[0]; T.isolate({ keepSheep: [sh] }); T.placeSven(7, 6, 0); T.placeSheep(sh, 9, 6, 2);
      sh.timer = 100; sh.stamina = -400; game.score = 100;
    });
    check('demon: mood −1 → demon transform (13)', await until(() => game.sheeps[0].state >= 13 && game.sheeps[0].state <= 17, null, 4000),
      await ev(() => [game.sheeps[0].state, game.sheeps[0].moodLevel]));
    await until(() => game.sheeps[0].state === 14, null, 5000); await shot('demon');
    const zap = await until(() => game.sven.state === 44, null, 8000);
    await shot('electro');
    check('demon: attack + zap → Sven electrocuted (44), −50', zap && await ev(() => game.score) === 50,
      await ev(() => [game.sven.state, game.sheeps[0].state, game.score]));
    check('demon: Sven recovers (45 → 28)', await until(() => game.sven.state === 28, null, 6000));
  });

  await run('stoned', async () => {
    await newGame(8);                                    // +8404 lightningEnabled (L >= 8)
    await ev(() => {
      const sh = game.sheeps[0]; T.isolate({ keepSheep: [sh] }); T.placeSven(7, 6, 0); T.placeSheep(sh, 10, 6, 2);
      game.mushrooms[0].place(9, 6, 'y', game.assets.Mushroom2);
      sh.timer = 100; sh.stamina = -400; game.sheepRemaining = 5;
    });
    const ok = await until(() => game.sheeps[0].stoned, null, 10000);
    const r = await ev(() => ({ st: game.sheeps[0].state, rem: game.sheepRemaining, m: game.mushrooms[0].consumed }));
    check('stoned: demon eats a y mushroom on L8 → stoned, remaining-- (sub_4300DA)', ok && r.m && r.rem === 4, r);
    await ticks(5); await shot('stoned');
    // Stoned idle timer is -1 (unsigned > 1), so sub_42FDC5 still allows the
    // press; sub_42CCBB refuses (&2) → kick with the Stoned seq, and Sven does
    // not turn (case 0x22 skips the rotation on &2).
    await ev(() => { T.placeSven(7, 6, 0); const sh = game.sheeps[0]; sh.col = 8; sh.row = 6; sh.dir = 0;
      const p = cellToScreen(8, 6); sh.x = p.x; sh.y = p.y; sh.kicks = 0; });
    await settle();
    await tap('Space');
    check('stoned: aligned press → kick (state 9) with the Stoned anim', await until(() => game.sheeps[0].state === 9, null, 3000)
      && await ev(() => game.sheeps[0].cur.name.startsWith('Stoned')));
    await until(() => game.sven.state === 28, null, 4000);
    check('stoned: Sven keeps his facing after the kick', await ev(() => game.sven.facing === 0));
  });

  await run('mermaid', async () => {
    await newGame(3);
    await ev(() => { T.isolate({ keepMermaid: true }); game.onSvenDrownRelocated(); });
    check('mermaid (L3): woken by a drown, emerges after 80 ticks', await until(() => game.mermaid.state === 22, null, 8000),
      await ev(() => [game.mermaid.state, game.mermaid.col, game.mermaid.row]));
    // Sven in front of her, facing her dir 3 (SE): passes +5 each (sub_419C12).
    await ev(() => { const m = game.mermaid; T.placeSven(m.col, m.row - 1, 3); game.score = 0; m.vis200 = 100000; });
    await settle();
    await shot('mermaid');
    for (let i = 0; i < 40 && !(await ev(() => game.mermaid.state === 10 || !game.mermaid.active)); i++) {
      await page.keyboard.down('Space'); await ticks(2); await page.keyboard.up('Space'); await ticks(2);
      if (i === 1) await shot('mermaid_pass');
    }
    const passes = await ev(() => game.score);
    check('mermaid: passes give +5 each, stage 3 → hold (state 10)', passes >= 15 && passes % 5 === 0, { score: passes });
    const done = await until(() => !game.mermaid.active, null, 15000);
    await ticks(3);
    const r = await ev(() => ({ score: game.score, pending: game.mushSpawnPending, mush: game.mushrooms.filter(m => !m.consumed).length }));
    check('mermaid: completion +10 and 3 mushrooms (sub_424E7D case 25)', done && r.score >= passes + 10 && r.mush >= 3, r);
  });

  await run('ufo', async () => {
    await newGame(5);
    await ev(() => { game.ufo.countdown = 1; });
    check('ufo (L5): flies in (G/H)', await until(() => game.ufo.state >= 71, null, 3000));
    await until(() => game.ufo.state >= 72, null, 15000); await shot('ufo_shadow');
    const lift = await until(() => game.ufo.state >= 74 && game.ufo.state <= 76, null, 45000);
    await ticks(10); await shot('ufo_beam');
    check('ufo: beams up a sheep (J..L)', lift, await ev(() => [game.ufo.state, game.ufo.target && game.ufo.target.state]));
    const done = await until(() => game.ufo.state === 70 && game.ufo.countdown > 1000, null, 45000);
    check('ufo: leaves, sheep removed (cell kind 6 until Q), remaining--', done && await ev(() => game.ufo.target && game.ufo.target.caught));
  });

  await run('demo', async () => {
    await ev(() => game.switchScene('title', 0));
    await ev(() => { game.sceneDeadline = performance.now() - 1; });
    check('demo: title timeout starts the demo game', await until(() => game.gstate === 'playing' && game.demoMode && game.sven.demo, null, 3000));
    const p0 = await ev(() => [game.sven.col, game.sven.row, game.score]);
    await page.waitForTimeout(4000);
    const p1 = await ev(() => [game.sven.col, game.sven.row, game.score, game.sven.state]);
    check('demo: Sven moves by himself (sub_436173)', p0[0] !== p1[0] || p0[1] !== p1[1] || p0[2] !== p1[2], { p0, p1 });
    await shot('demo');
    await page.keyboard.press('Escape');
    check('demo: Esc → title', await until(() => game.gstate === 'title', null, 3000));
  });

  await run('scenes', async () => {
    await ev(() => game.switchScene('help', 0)); await page.waitForTimeout(300); await shot('help');
    await ev(() => game.switchScene('setup', 0)); await page.waitForTimeout(300); await shot('setup');
    check('help/setup keep the menu music scene (sub_41F0EE/sub_41F199)', await ev(() => game.audio.scene === 'menu'));
    await ev(() => game.switchScene('highscores', 0)); await page.waitForTimeout(300); await shot('highscores_title');
    check('top scores from title: no name entry', await ev(() => !game.hsEntryActive));
    await ev(() => game.switchScene('title', 0));
  });


  //--- Round-2 fixes --------------------------------------------------------
  await run('reverse', async () => {
    await newGame(1);
    const r = await ev(() => {
      T.isolate(); T.placeSven(7, 6, 0);
      const s = game.sven, out = {};
      const begin = st => { s.state = 29; s.facing = 0; s.col = 7; s.row = 6; s._stepSetup(); s.stepTick = st; };
      const half = s.stepTicks() >> 1;
      begin(half - 1); s._reverse(2);
      out.before = [s.facing, s.fromCol, s.toCol, s.stepTick];
      begin(half); s._reverse(2);
      out.atHalf = [s.facing, s.fromCol, s.toCol, s.stepTick];
      begin(half + 2); s._reverse(2);
      out.after = [s.facing, s.fromCol, s.toCol, s.stepTick];
      out.half = half;
      T.placeSven(7, 6, 0);
      return out;
    });
    check('reverse: allowed while stepTick < half (sub_436DD1)', r.before[0] === 2 && r.before[1] === 8 && r.before[2] === 7 && r.before[3] === 8 - (r.half - 1), r);
    check('reverse: refused at stepTick == half and later (own leaving bit, SV-01)',
      r.atHalf[0] === 0 && r.atHalf[1] === 7 && r.atHalf[2] === 8 && r.after[0] === 0 && r.after[3] === r.half + 2, r);
  });

  await run('sheepat', async () => {
    await newGame(1);
    const r = await ev(() => {
      const sh = game.sheeps[0]; T.isolate({ keepSheep: [sh] }); T.placeSven(3, 3, 0); T.placeSheep(sh, 8, 6, 0);
      const at = (c, rr) => game.sheepAt(c, rr) === sh;
      // Stepping (8,6) → (9,6), before the half-step: logical cell = src.
      sh.srcCol = 8; sh.srcRow = 6; sh.dstCol = 9; sh.dstRow = 6; sh.stepping = true; sh.col = 8; sh.row = 6;
      const pre = [at(8, 6), at(9, 6)];
      // After the half-step the logical cell is dst; src is only "leaving".
      sh.col = 9;
      const post = [at(8, 6), at(9, 6)];
      const bits = npcCellBits(game, 8, 6, null);
      sh.stepping = false; sh.srcCol = 9;
      const demon = (() => { sh.demonCell = true; const v = game.sheepAt(9, 6); sh.demonCell = false; return v; })();
      return { pre, post, leavingBit: bits.b0, demon: demon === null };
    });
    check('sheepAt: entering cell not seen before the half-step', r.pre[0] && !r.pre[1], r);
    check('sheepAt: leaving cell not seen after the half-step (present bit only, SEAM-02)', !r.post[0] && r.post[1] && (r.leavingBit & 0x10), r);
    check('sheepAt: demon (code 8) not a sheep', r.demon, r);
  });

  await run('tickorder', async () => {
    await newGame(5);
    await ticks(3);
    const r = await ev(() => {
      const calls = [];
      const objs = [...game.sheeps, ...game.mushrooms, ...game.lambs];
      if (game.mermaid) objs.push(game.mermaid);
      const orig = new Map();
      for (const o of objs) {
        orig.set(o, o.update);
        o.update = function (...a) { calls.push({ o: this, y: game.entityDepth(this), x: game.entityDepthX(this) }); return orig.get(this).apply(this, a); };
      }
      game.tickWorld();
      for (const [o, f] of orig) { delete o.update; if (o.update !== f) o.update = f; }
      const listTicks = game._drawList.filter(e => game._sceneListTicks(e));
      const sameOrder = calls.length === listTicks.length && calls.every((c, i) => c.o === listTicks[i]);
      let sorted = true;
      for (let i = 1; i < calls.length; i++) {
        const a = calls[i - 1], b = calls[i];
        if (a.y > b.y || (a.y === b.y && a.x > b.x)) sorted = false;
      }
      return { n: calls.length, sameOrder, sorted, types: calls.map(c => c.o.constructor.name).join(',').slice(0, 200) };
    });
    check('tick order: list objects tick in the depth-sorted list order (sub_41CDC6 + sub_41CCBD)', r.n > 3 && r.sameOrder && r.sorted, r);
  });

  await run('cadence', async () => {
    await newGame(1);
    // Stop the real rAF loop, drive Game.tick with synthetic vsync timestamps.
    await ev(() => { window.__raf = window.requestAnimationFrame; window.requestAnimationFrame = () => 0; });
    await page.waitForTimeout(200);
    const r = await ev(() => {
      const realUpd = game.updateScene, realRender = game.render;
      let ticksRun = 0;
      game.updateScene = function () { ticksRun++; };
      game.render = function () {};
      const sim = (hz, seconds, jitter) => {
        let seed = 12345;
        const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
        const period = 1000 / hz;
        let t = 1000; game.lastT = t; game._accMs = 0; ticksRun = 0;
        const frameOfTick = [];
        const frames = Math.round(seconds * hz);
        for (let f = 1; f <= frames; f++) {
          t = 1000 + f * period + (rnd() * 2 - 1) * jitter;
          const before = ticksRun;
          game.tick(t);
          for (let k = before; k < ticksRun; k++) frameOfTick.push(f);
        }
        const gaps = [];
        for (let i = 1; i < frameOfTick.length; i++) gaps.push(frameOfTick[i] - frameOfTick[i - 1]);
        return { ticks: ticksRun, expect: (t - 1000) / 50, gaps };
      };
      const out = {};
      const a = sim(60, 20, 1.5);
      out.g60 = { ticks: a.ticks, expect: a.expect, gapSet: [...new Set(a.gaps)] };
      for (const hz of [75, 120, 144]) {
        const b = sim(hz, 60, 1.0);
        out['g' + hz] = { ticks: b.ticks, expect: +b.expect.toFixed(2) };
      }
      game.updateScene = realUpd; game.render = realRender;
      return out;
    });
    await ev(() => { window.requestAnimationFrame = window.__raf; game.lastT = performance.now(); game._accMs = 0; requestAnimationFrame(game._tickFn); });
    check('cadence: 60 Hz with jitter → every tick exactly 3 frames apart (LR-01)',
      r.g60.gapSet.length === 1 && r.g60.gapSet[0] === 3 && Math.abs(r.g60.ticks - r.g60.expect) <= 1, r.g60);
    for (const hz of [75, 120, 144]) {
      const g = r['g' + hz];
      check(`cadence: ${hz} Hz long-run rate exactly 20 Hz`, Math.abs(g.ticks - g.expect) <= 1, g);
    }
    check('cadence: real loop resumes', await (async () => { const t0 = await ev(() => game.tickCount); await page.waitForTimeout(500); return (await ev(() => game.tickCount)) > t0 + 5; })());
  });

  await run('scoretable', async () => {
    await newGame(1);
    const r = await ev(() => {
      T.isolate();
      game.startScoreTableFlash();
      const seen = [];
      for (let i = 0; i < 6; i++) { game.hudTick(); seen.push(game.scoreTableDraw); }
      return seen;
    });
    check('score_table: catch flash draws frames 1,2,3 then 0 frozen (sub_42EB56)', r.join() === '1,2,3,0,0,0', r);
  });

  await run('topscores2', async () => {
    await ev(() => { localStorage.clear(); saveProgress(6); game.highestLevel = 6; });
    await ev(() => game.switchScene('title', 0));
    await ticks(0); await page.waitForTimeout(200);
    await ev(() => game.switchScene('highscores', 0));
    await page.waitForTimeout(200);
    await ev(() => game.switchScene('title', 0));
    await page.waitForTimeout(200);
    const r = await ev(() => ({ saved: loadProgress(), highest: game.highestLevel }));
    check('top scores: leaving saves Score.dat with map level 1 after the title (sub_427125 → sub_417D20)', r.saved === 1 && r.highest === 1, r);
    // Name buffer +120 persists across Top Scores entries (cleared only in the ctor).
    const n = await ev(() => {
      game.hsEntryName = 'Abc';
      game.score = 999999; game.switchScene('highscores', 1);
      const a = [game.hsEntryActive, game.hsEntryName];
      game.hsEntryActive = false; game.switchScene('title', 0);
      game.switchScene('highscores', 0);
      const b = game.hsEntryName;
      game.switchScene('title', 0);
      localStorage.clear(); game.highestLevel = 1;
      return { a, b };
    });
    check('top scores: name buffer persists across entries (R2-LF-02)', n.a[0] && n.a[1] === 'Abc' && n.b === 'Abc', n);
  });

  await run('chain', async () => {
    await newGame(1);
    const r = await ev(() => {
      const called = new Set();
      for (const sh of game.sheeps) { const f = sh.boost900; sh.boost900 = function () { called.add(this); return f.call(this); }; }
      const caught = game.sheeps[0]; caught.caught = true; caught.state = 12;
      game._chainMoodAll();
      const res = { all: game.sheeps.every(s => called.has(s)), caughtCalled: called.has(caught), n: game.sheeps.length };
      for (const sh of game.sheeps) delete sh.boost900;
      return res;
    });
    check('catch chain: boost900 on every CSheep incl. caught ones (R2-LF-03 / SEAM-07)', r.all && r.caughtCalled, r);
  });

  await run('special', async () => {
    await newGame(11);
    await ev(() => { game.sheepRemaining = 0; });
    await until(() => game.levelIdx === 12, null, 5000);
    const r12 = await ev(() => ({ L: game.levelIdx, special: game.level.entities.some(e => e.kind === 'special') }));
    await until(() => game.levelTransitionTicks === 0, null, 6000);
    await ev(() => { game.sheepRemaining = 0; });
    await until(() => game.levelIdx === 13, null, 5000);
    const r13 = await ev(() => ({ L: game.levelIdx, special: game.level.entities.some(e => e.kind === 'special') }));
    check('special sheep lag: L12 reached from L11 has none (+8405 from previous sub_4175DC, CMA-01)', r12.L === 12 && !r12.special, r12);
    check('special sheep: L13 (after L12) has one', r13.L === 13 && r13.special, r13);
  });

  await run('bossmusic', async () => {
    await ev(() => game.switchScene('title', 0));
    await page.waitForTimeout(200);
    const r = await ev(() => {
      const a = game.audio;
      const mk = () => ({ currentTime: 7, loop: true, paused: false, plays: 0,
        pause() { this.paused = true; }, play() { this.paused = false; this.plays++; return Promise.resolve(); } });
      const realMusic = a.music, realEn = a.enabled, realMuted = a.muted;
      a.music = { menu: mk(), topscore: mk(), bush: mk() };
      a.enabled = true; a.muted = false;
      const out = {};
      // Menu scenes handle B/S on WM_KEYUP (base sub_41D896 / title sub_41EF53).
      const key = (k, c) => { game.handleKey(new KeyboardEvent('keydown', { key: k, code: c }), true); game.handleKey(new KeyboardEvent('keyup', { key: k, code: c }), false); };
      key('и', 'KeyB');   // Russian layout B
      out.on = game.bossScreen; out.pausedOnBoss = a.music.menu.paused;
      a.music.menu.currentTime = 7;
      key('x', 'KeyX');
      out.off = !game.bossScreen; out.restart = a.music.menu.currentTime === 0 && !a.music.menu.paused && a.music.menu.loop;
      // Top scores: BushSound untouched by pause/resume (CMA-02).
      a.scene = 'topscore'; a.music.bush.currentTime = 7;
      a.pauseMusic(); a.resumeMusic();
      out.bushUntouched = !a.music.bush.paused && a.music.bush.currentTime === 7 && a.music.topscore.currentTime === 0;
      a.scene = 'menu';
      // Mute by physical key S on a non-Latin layout (e.code).
      key('ы', 'KeyS');
      out.muted = a.muted;
      key('ы', 'KeyS');
      out.unmuted = !a.muted;
      // Help: unmute plays MenuSound once, not looped (LR-15).
      game.switchScene('help', 0);
      key('s', 'KeyS');
      key('s', 'KeyS');
      out.helpOnce = !a.muted && a.music.menu.loop === false && a.music.menu.currentTime === 0 && !a.music.menu.paused;
      game.switchScene('title', 0);
      a.music = realMusic; a.enabled = realEn; a.muted = realMuted;
      return out;
    });
    check('boss key: KeyB on a non-Latin layout (vkLetter → e.code, R3-LRH-10)', r.on && r.off, r);
    check('boss resume restarts the scene music from the start (sub_432DBB → sub_43D206(1))', r.pausedOnBoss && r.restart, r);
    check('pause/resume leave BushSound alone (CMA-02)', r.bushUntouched, r);
    check('mute: KeyS on a non-Latin layout (vkLetter → e.code)', r.muted && r.unmuted, r);
    check('help unmute plays MenuSound once, not looped (LR-15)', r.helpOnce, r);
  });

  await run('saintshag', async () => {
    await newGame(4);
    await ev(() => {
      const sh = game.sheeps[0]; T.isolate({ keepSheep: [sh] }); T.placeSven(7, 6, 0); T.placeSheep(sh, 8, 6, 0);
      sh.stamina = 2990; sh.mood(0);
    });
    await settle();
    await page.keyboard.down('Space');
    const shag = await until(() => game.sven.state === 32, null, 3000);
    await page.keyboard.up('Space');
    const r = await ev(() => { const h0 = game.sven.hideHalo; game.startSaint(10); return { h0, h1: game.sven.hideHalo, haloHidden: game.sven.haloHidden, st: game.sven.state }; });
    check('saint started mid-shag: halo visible at once (sub_438536, MHS-01)', shag && r.h0 && !r.haloHidden, r);
  });

  await run('ufosven', async () => {
    await newGame(5);
    await ev(() => { game.dogs = [T.inertDog(game.dogs[0])]; game.shepherds = []; game.mermaid = null; game.sheepRemaining = 1000; game.ufo.countdown = 1; T.placeSven(2, 5, 0); });
    const k = await until(() => game.ufo.state === 75 || game.ufo.state === 76, null, 45000);
    const cell = await ev(() => [game.ufo.tCol, game.ufo.tRow]);
    await ev(c => T.placeSven(c[0], c[1], 0), cell);
    const abd = await until(() => game.sven.state === 47, null, 20000);
    const hole47 = await ev(c => game.ufo.isHole(c[0], c[1]), cell);
    await shot('ufo_sven');
    const back = await until(() => game.sven.state === 28 && game.sven.onGrid, null, 45000);
    await until(() => game.ufo.state === 70, null, 30000);
    const r = await ev(c => ({ hole: game.ufo.isHole(c[0], c[1]), holes: [...game.ufo.holes], type: npcTerrainType(game, c[0], c[1]), mode: game.svenMode, sven: [game.sven.col, game.sven.row] }), cell);
    check('ufo-sven: Sven idle on the target cell is abducted (47), cell type 6', k && abd && hole47, { k, abd, hole47, cell });
    check('ufo-sven: no permanent hole after the alien fall (Sven 48 end / UFO Q, MU-01)', back && !r.hole && r.type !== 6 && r.mode === 4, r);
  });

  await run('focus', async () => {
    await newGame(1);
    await ev(() => window.dispatchEvent(new Event('blur')));
    const t0 = await ev(() => ({ t: game.tickCount, p: game.basePauseCount, s: game._suspended }));
    await page.waitForTimeout(400);
    const t1 = await ev(() => game.tickCount);
    await ev(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(400);
    const t2 = await ev(() => ({ t: game.tickCount, p: game.basePauseCount, s: game._suspended }));
    check('focus loss stops ticks + scene pause (WM_ACTIVATEAPP sub_4115B9, LR-03)', t0.s && t0.p === 1 && t1 === t0.t, { t0, t1 });
    check('focus return resumes ticks', !t2.s && t2.p === 0 && t2.t > t1 + 3, t2);
  });

  await run('percent', async () => {
    const r = await ev(async () => {
      const res = await fetch(ASSETS + 'Ufo67%25.png');
      const a = game.assets['UfoShadow'];
      return { ok: res.ok, sheet: !!a, w: a ? a.canvas.width : 0 };
    });
    check('sprite file names with % load (Ufo67%.png, CMA-05)', r.ok && r.sheet && r.w > 0, r);
  });


  //--- Round-3 fixes --------------------------------------------------------
  await run('levelreset', async () => {
    await newGame(1);
    // Esc → "Нет" selected → Esc closes the dialog (choice stays 1).
    await page.keyboard.press('Escape');
    await until(() => game.escDialog, null, 2000);
    await page.keyboard.press('ArrowRight');
    const sel = await ev(() => game.escChoice);
    await page.keyboard.press('Escape');
    await until(() => !game.escDialog, null, 2000);
    const before = await ev(() => {
      game.lives = 4; game.startLifeLostAnim();   // a fly-off running at the advance
      game.sceneExitReq = 1;                       // stale exit request (+20)
      const b = { choice: game.escChoice, fly: game.lifeFly, req: game.sceneExitReq };
      game.sceneExitReq = 0;                       // (would leave the scene on Enter keyup)
      game.sheepRemaining = 0;
      return b;
    });
    await until(() => game.levelIdx === 2, null, 5000);
    const r = await ev(() => ({ L: game.levelIdx, choice: game.escChoice, dlg: game.escDialog, req: game.sceneExitReq,
      shown: game.hudLivesShown, fly: game.lifeFly, drop: game.lifeDrop, lives: game.lives }));
    check('level advance: Esc choice back to "Да" (+100 = 0, IDA:14518, R3-LF-01)', sel === 1 && before.choice === 1 && r.L === 2 && r.choice === 0 && !r.dlg, { sel, before, r });
    check('level advance: lives icons = lives−1, fly-off/drop-in cancelled (IDA:14520-14524)', before.fly === 0 && r.shown === r.lives - 1 && r.fly === -1 && r.drop === -1, { before, r });
    // Exit request (+20) cleared by the enter.
    const q = await ev(() => { game.sceneExitReq = 1; game.loadLevel(game.levelIdx, true); return game.sceneExitReq; });
    check('level enter: exit request cleared (+20 = 0, IDA:14513)', q === 0, { q });
    await until(() => game.levelTransitionTicks === 0, null, 6000);
  });

  await run('heldkey', async () => {
    await newGame(1);
    // A keydown that lands while Sven is in state 0/27 is consumed there
    // (case 0/27 clears +136); state 28 has timer −1, so a key that is only
    // HELD (+140 >= 0, no new WM_KEYDOWN) must not start a walk. The old
    // `keyFlag || svenHeldAction >= 0` getter walked here.
    const kd = (rep) => ev(r => game.handleKey(new KeyboardEvent('keydown', { key: 'ArrowUp', code: 'ArrowUp', repeat: r }), true), rep);
    await ev(() => { T.isolate(); T.placeSven(7, 6, 2); });
    await kd(false);
    await ticks(20);
    const r = await ev(() => ({ pos: [game.sven.col, game.sven.row, game.sven.facing, game.sven.state], kf: game.sven.keyFlag, held: game.svenHeldAction }));
    check('held key: no re-trigger while only held (+136 plain field, cleared by case 0/27; R3-SV-01)',
      r.pos[0] === 7 && r.pos[1] === 6 && r.pos[3] === 28 && !r.kf && r.held === 0, r);
    await kd(true);                                       // OS auto-repeat WM_KEYDOWN
    const moved = await until(() => game.sven.state === 29 || game.sven.col !== 7 || game.sven.facing !== 2, null, 2000);
    await ev(() => game.handleKey(new KeyboardEvent('keyup', { key: 'ArrowUp', code: 'ArrowUp' }), false));
    check('held key: an auto-repeat keydown re-triggers the resolver (turn/walk)', moved, await ev(() => [game.sven.col, game.sven.row, game.sven.facing, game.sven.state]));
  });

  await run('lambparents', async () => {
    await newGame(3);
    const r = await ev(() => {
      const [a, b] = game.sheeps;
      T.isolate({ keepSheep: [a, b], keepMermaid: true });
      game.mermaid = null;
      T.placeSheep(a, 4, 6, 0); T.placeSheep(b, 8, 6, 0);
      const run = () => { game.lambs = []; game.lambSpawned = false; game.spawnLambs(); return game.lambs.map(l => [l.from.x, l.from.y]); };
      const at = sh => { const p = cellToScreen(sh.col, sh.row); return [p.x, p.y - 1]; };
      // a: demon with mood 9 on the left of the row, b: mood 9 on its right.
      a.demonCell = true; a.moodLevel = 9; b.moodLevel = 9;
      const demonRow = run();
      b.moodLevel = 5;
      const demonOnly = run();
      a.demonCell = false; a.moodLevel = 9;
      const normal = run();
      return { demonRow, demonOnly, normal, aPos: at(a), bPos: at(b) };
    });
    const same = (p, q) => p[0] === q[0] && p[1] === q[1];
    check('lambs: a demon is skipped (not a parent, does not stop the scan; sub_416028 byte2 & 0xF0)',
      r.demonRow.length === 1 && same(r.demonRow[0], r.bPos) && r.demonOnly.length === 0 && r.normal.length === 1 && same(r.normal[0], r.aPos), r);
    // Mermaid: +120 = mood(stamina) (sub_42D08E via sub_42ABDF), parent if > 8.
    await newGame(3);
    await ev(() => { T.isolate({ keepMermaid: true }); game.onSvenDrownRelocated(); });
    const up = await until(() => game.mermaid.state === 22, null, 8000);
    const m = await ev(() => {
      const mm = game.mermaid; game.sheeps = [];
      const run = () => { game.lambs = []; game.lambSpawned = false; game.spawnLambs(); return game.lambs.map(l => [l.from.x, l.from.y]); };
      const p = cellToScreen(mm.col, mm.row);
      mm.mood30 = 9; const hi = run();
      mm.mood30 = 8; const lo = run();
      game.lambs = [];
      return { hi, lo, pos: [p.x, p.y - 1] };
    });
    check('lambs: emerged mermaid with mood > 8 is a parent, mood 8 is not (R3-DSL-02/SEAM-02)',
      up && m.hi.length === 1 && same(m.hi[0], m.pos) && m.lo.length === 0, m);
  });

  await run('ufodemon', async () => {
    await newGame(5);
    const r = await ev(() => {
      const sh = game.sheeps[0]; T.isolate({ keepSheep: [sh] }); T.placeSheep(sh, 8, 6, 0);
      game.ufo = new Ufo();
      const picks = [];
      sh.demonCell = true;
      for (let i = 0; i < 20; i++) picks.push(game.ufo._pickTarget(game));
      const demon = picks.every(p => p === null);
      sh.demonCell = false;
      const normal = game.ufo._pickTarget(game) === sh;
      game.ufo = null;
      return { demon, normal };
    });
    check('ufo: never targets a demon sheep (sub_416D7E byte2 & 0xF0, R3-SEAM-01)', r.demon && r.normal, r);
  });

  await run('sheepprev', async () => {
    await newGame(1);
    const r = await ev(() => {
      const out = [];
      for (let d = 0; d < 4; d++) {
        const sh = new Sheep(6, 6, d);
        const f = DIR_DELTA[d];
        out.push({ d, prev: [sh.prevCol, sh.prevRow], src: [sh.srcCol, sh.srcRow], want: [6 - f.dc, 6 - f.dr] });
      }
      return out;
    });
    check('new sheep: prev/src cell = the cell behind it (sub_419DE0 → sub_41A40A, R3-SH-01)',
      r.every(o => o.prev[0] === o.want[0] && o.prev[1] === o.want[1] && o.src[0] === o.want[0] && o.src[1] === o.want[1]), r);
  });

  await run('mushdepth', async () => {
    await newGame(1);
    const r = await ev(() => {
      T.isolate();
      game.mushrooms = game.buildMushroomSlots([]);
      const unused = game.mushrooms[1];
      const m = game.mushrooms[0];
      m.place(8, 6, 'v', game.assets.Mushroom);
      T.placeSven(8, 6, 0);
      const p = cellToScreen(8, 6);
      const list = game.buildSceneList().sort((a, b) => game.sceneCompare(a, b));
      const res = { z: game.entityDepth(m), x: game.entityDepthX(m), y: p.y, px: p.x,
        before: list.indexOf(m) < list.indexOf(game.sven),
        unused: [game.entityDepth(unused), game.entityDepthX(unused), unused.consumed],
        slots: game.mushrooms.length };
      T.placeSven(7, 6, 0);
      return res;
    });
    check('mushroom: sort key z = y − 10 (setZ 0x406DA0), x = anchor x (R3-LRH-02)', r.z === r.y - 10 && r.x === r.px && r.before, r);
    check('mushroom: 7 slots, never-used slot z 0 / x −2147483647, hidden (sub_406EB8)',
      r.slots === 7 && r.unused[0] === 0 && r.unused[1] === -2147483647 && r.unused[2], r);
  });

  await run('flockorder', async () => {
    await ev(() => game.switchScene('title', 0));
    await page.waitForTimeout(400);
    const r = await ev(() => {
      const pre = new Map(game.flock.map(o => [o, [o.y, o.x]]));
      const order = [];
      const real = game.flockStep;
      game.flockStep = function (o) { order.push(o); return real.call(this, o); };
      game.titleTick();
      delete game.flockStep;
      let sorted = true;
      for (let i = 1; i < order.length; i++) {
        const a = pre.get(order[i - 1]), b = pre.get(order[i]);
        if (a[0] > b[0] || (a[0] === b[0] && a[1] > b[1])) sorted = false;
      }
      const drawSame = game.flockDraw.length === order.length && game.flockDraw.every((d, i) => d.o === order[i] && d.y === pre.get(d.o)[0]);
      const creation = order.every((o, i) => o === game.flock[i]);
      return { n: order.length, sorted, drawSame, creation };
    });
    check('title flock: stepped and drawn in pre-step (y, x) order (sub_41CDC6 + sub_41CCBD, R3-SD-01)', r.n > 2 && r.sorted && r.drawSame, r);
  });

  await run('hsboss', async () => {
    await ev(() => game.switchScene('highscores', 0));
    await page.waitForTimeout(300);
    const r = await ev(() => {
      const a = game.audio;
      const mk = () => ({ currentTime: 7, loop: true, paused: false, plays: 0,
        pause() { this.paused = true; }, play() { this.paused = false; this.plays++; return Promise.resolve(); } });
      const realMusic = a.music, realEn = a.enabled, realMuted = a.muted, realScene = a.scene;
      a.music = { menu: mk(), topscore: mk(), bush: mk() };
      a.enabled = true; a.muted = false; a.scene = 'topscore';
      const key = (k, c) => { game.handleKey(new KeyboardEvent('keydown', { key: k, code: c }), true); game.handleKey(new KeyboardEvent('keyup', { key: k, code: c }), false); };
      key('b', 'KeyB');
      const on = { boss: game.bossScreen, top: a.music.topscore.paused, bush: a.music.bush.paused };
      key('x', 'KeyX');
      const off = { boss: game.bossScreen, top: a.music.topscore.paused, topT: a.music.topscore.currentTime, bush: a.music.bush.paused };
      a.music = realMusic; a.enabled = realEn; a.muted = realMuted; a.scene = realScene;
      return { on, off, st: game.gstate };
    });
    check('top scores boss key: stops TopScoreSound and BushSound (sub_4271F8, R3-CMA-01)', r.on.boss && r.on.top && r.on.bush, r);
    check('top scores boss off: only TopScoreSound resumes (from 0), BushSound stays off', !r.off.boss && !r.off.top && r.off.topT === 0 && r.off.bush && r.st === 'highscores', r);
    await ev(() => game.switchScene('title', 0));
  });

  await run('cadence3', async () => {
    await newGame(1);
    await ev(() => { window.__raf = window.requestAnimationFrame; window.requestAnimationFrame = () => 0; });
    await page.waitForTimeout(200);
    const r = await ev(() => {
      const realUpd = game.updateScene, realRender = game.render;
      let ticksRun = 0, renders = 0;
      game.updateScene = function () { ticksRun++; };
      game.render = function () { renders++; };
      const sim = (hz, seconds, jitter) => {
        let seed = 777;
        const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
        const period = 1000 / hz;
        let t = 1000; game.lastT = t; game._accMs = 0; game._frameT = null; game._frameDts = [];
        ticksRun = 0; renders = 0;
        const frameOfTick = []; let maxPerFrame = 0;
        const frames = Math.round(seconds * hz);
        for (let f = 1; f <= frames; f++) {
          t = 1000 + f * period + (rnd() * 2 - 1) * jitter;
          const before = ticksRun;
          game.tick(t);
          maxPerFrame = Math.max(maxPerFrame, ticksRun - before);
          for (let k = before; k < ticksRun; k++) frameOfTick.push(f);
        }
        const gaps = [];
        for (let i = 20; i < frameOfTick.length; i++) gaps.push(frameOfTick[i] - frameOfTick[i - 1]);
        return { hz, ticks: ticksRun, frames, renders, expect: +((t - 1000) / 50).toFixed(2), maxPerFrame, gapSet: [...new Set(gaps)].sort((x, y) => x - y) };
      };
      const out = [sim(60, 30, 1.5), sim(75, 30, 1.0), sim(120, 30, 0.8), sim(144, 30, 0.5), sim(240, 30, 0.3), sim(15, 20, 1.0), sim(12, 20, 1.0)];
      game.updateScene = realUpd; game.render = realRender;
      return out;
    });
    await ev(() => { window.requestAnimationFrame = window.__raf; game._rearmTimer(); requestAnimationFrame(game._tickFn); });
    const by = hz => r.find(o => o.hz === hz);
    check('cadence: at most 1 tick per refresh, render only on ticked refreshes (sub_410940 flip drop, R3-LRH-03, SD-05)',
      r.every(o => o.maxPerFrame <= 1 && o.renders === o.ticks), r.map(o => [o.hz, o.maxPerFrame, o.ticks, o.renders]));
    check('cadence: long-run exactly 20 Hz at 60/75/120/144/240 Hz', [60, 75, 120, 144, 240].every(h => Math.abs(by(h).ticks - by(h).expect) <= 1),
      r.map(o => [o.hz, o.ticks, o.expect]));
    check('cadence: steady holds 60 Hz → 3, 120 Hz → 6, 240 Hz → 12 refreshes (half-frame tolerance, R3-DSL-04)',
      by(60).gapSet.join() === '3' && by(120).gapSet.join() === '6' && by(240).gapSet.join() === '12', { 60: by(60).gapSet, 120: by(120).gapSet, 240: by(240).gapSet });
    check('cadence: below 20 Hz one tick per refresh (15/12 Hz)', [15, 12].every(h => by(h).ticks >= by(h).frames - 1 && by(h).maxPerFrame === 1),
      [by(15), by(12)].map(o => [o.hz, o.ticks, o.frames]));
    check('cadence3: real loop resumes', await (async () => { const t0 = await ev(() => game.tickCount); await page.waitForTimeout(500); return (await ev(() => game.tickCount)) > t0 + 5; })());
  });

  await run('vkletter', async () => {
    const r = await ev(() => {
      const k = (key, code) => vkLetter(new KeyboardEvent('keydown', { key, code }));
      return { ru: k('и', 'KeyB'), dvorak: k('x', 'KeyB'), dvB: k('b', 'KeyN'), upper: k('B', 'KeyB'), f4: k('F4', 'F4') };
    });
    check('vkLetter: Latin layout uses the layout letter (e.key), non-Latin the US position (e.code) (sub_420507 tolower(VK))',
      r.ru === 'b' && r.dvorak === 'x' && r.dvB === 'b' && r.upper === 'b' && r.f4 === null, r);
  });

  await run('continuemax', async () => {
    const r = await ev(() => {
      const out = {};
      for (const lv of [25, 21, 0, 20]) {
        game.highestLevel = lv;
        game.switchScene('playing', 20);
        out[lv] = game.levelIdx;
        game.switchScene('title', 0);
      }
      game.highestLevel = 1; localStorage.clear();
      return out;
    });
    check('continue: saved level beyond the level count → level 1, < 1 → 1 (sub_41281B, R3-LF-02)', r[25] === 1 && r[21] === 1 && r[0] === 1 && r[20] === 20, r);
  });

  //--- Round-4 fixes --------------------------------------------------------
  await run('map13', async () => {
    const r = await ev(() => {
      const m = game.mapInfo;
      return { rows: m.rows, cols: m.cols, last: m.terrain[12], lens: m.terrain.map(t => t.length),
        kind: [0, 5, 15].map(c => m.terrainKind ? m.terrainKind(c, 12) : null), at: m.cellAt ? m.cellAt(3, 12) : null };
    });
    check('map: 13 rows × 16 cols (sub_40B62A appends the empty default row, R4-r2-40A000-01)', r.rows === 13 && r.cols === 16 && r.lens.every(l => l === 16), r);
    check('map: the 13th row is all wall (\'#\', IDA:8549-8552)', r.last === '################', r.last);
  });

  await run('shore5', async () => {
    await newGame(3);
    const r = await ev(() => { T.isolate({ keepMermaid: true }); return game.mermaid.shoreCandidates(game); });
    const want = [[10, 10], [9, 10], [8, 10], [7, 10], [6, 9]];
    check('mermaid shore scan (sub_414C53): 5 spots (10,10),(10,9),(10,8),(10,7),(9,6) in push order (R4 r2 report)',
      r.length === 5 && want.every(([c, rr], i) => r[i].col === c && r[i].row === rr), r);
  });

  await run('mushrows', async () => {
    await newGame(1);
    const r = await ev(() => {
      const realR = Math.random, realF = game.findFreeLandCell;
      const seen = new Set();
      game.findFreeLandCell = function (c, rr) { seen.add(rr); return null; };
      for (const v of [0, 0.5, 0.9999999]) { Math.random = () => v; game._spawnOneRandomMushroom(); }
      let k = 0; Math.random = () => ((k++ * 0.137) % 1);
      for (let i = 0; i < 500; i++) game._spawnOneRandomMushroom();
      Math.random = realR; game.findFreeLandCell = realF;
      return [...seen].sort((a, b) => a - b);
    });
    check('mushroom spawn row = rand()%13 → 0-based -1..11 (sub_41535A IDA:9509)', r[0] === -1 && r[r.length - 1] === 11 && r.length === 13, r);
  });

  await run('ufo565', async () => {
    const r = await ev(() => {
      const d = new Uint8ClampedArray([255, 0, 0, 255, 255, 255, 255, 255, 100, 150, 200, 255]);
      rgb565Shadow(d);
      const w = new Uint8ClampedArray([255, 0, 0, 255]); rgb565Wash(w);
      return { red: [d[0], d[1], d[2]], white: [d[4], d[5], d[6]], mix: [d[8], d[9], d[10]], wash: [w[0], w[1], w[2]],
        shared: !/3 \* \(\(d\[i\] >> 3\)/.test(Ufo.prototype._shadowParts.toString()) && /rgb565Shadow/.test(Ufo.prototype._shadowParts.toString()) };
    });
    // 3*(c>>2) on 5/6/5 channels, expanded back: r5 31 → 21 → 173; g6 63 → 45 → 182.
    const ex = (v5) => (v5 << 3) | (v5 >> 2), ex6 = (v6) => (v6 << 2) | (v6 >> 4);
    check('UFO shadow pixel = rgb565 3*(c>>2) (sub_40A780): full red → 173', r.red.join() === '173,0,0' && r.white.join() === '173,182,173'
      && r.mix.join() === [ex(3 * ((100 >> 3) >> 2)), ex6(3 * ((150 >> 2) >> 2)), ex(3 * ((200 >> 3) >> 2))].join(), r);
    check('UFO shadow uses the shared core.js helper (no local copy)', r.shared, r);
    await newGame(5);
    const p = await ev(() => {
      const s = game.ufo._shadowParts(game);
      const raw = muRawImage('GameBackground.bmp');
      const c = document.createElement('canvas'); c.width = 640; c.height = 480;
      const x = c.getContext('2d'); x.drawImage(raw, 0, 0);
      const pts = [[100, 100], [320, 240], [500, 50]];
      const bgp = pts.map(([px, py]) => Array.from(x.getImageData(px, py, 1, 1).data));
      const shp = pts.map(([px, py]) => Array.from(s.composite.getContext('2d').getImageData(px, py, 1, 1).data));
      const want = bgp.map(v => { const a = new Uint8ClampedArray(v); rgb565Shadow(a); return Array.from(a.slice(0, 3)); });
      return { bgp, shp, want };
    });
    check('UFO shadow composite pixels = rgb565Shadow(background)', p.shp.every((v, i) => v[3] === 0 || v.slice(0, 3).join() === p.want[i].join()), p);
  });

  await run('qsortref', async () => {
    const r = await ev(() => {
      // Reference: MSVC 6 qsort.c / _shortsort, byte pointers over a width-4 array.
      function refQsort(arr, comp) {
        const W = 4, mem = arr.slice();
        const at = (p) => mem[p / W], sw = (p, q) => { const t = mem[p / W]; mem[p / W] = mem[q / W]; mem[q / W] = t; };
        const c = (p, q) => comp(at(p), at(q));
        if (mem.length < 2) return mem;
        const lostk = [], histk = []; let stkptr = 0;
        let lo = 0, hi = W * (mem.length - 1);
        for (;;) {
          const size = (hi - lo) / W + 1;
          if (size <= 8) {
            let h = hi;
            while (h > lo) { let max = lo; for (let p = lo + W; p <= h; p += W) if (c(p, max) > 0) max = p; sw(max, h); h -= W; }
          } else {
            const mid = lo + Math.floor(size / 2) * W;
            sw(mid, lo);
            let loguy = lo, higuy = hi + W;
            for (;;) {
              do loguy += W; while (loguy <= hi && c(loguy, lo) <= 0);
              do higuy -= W; while (higuy > lo && c(higuy, lo) >= 0);
              if (higuy < loguy) break;
              sw(loguy, higuy);
            }
            sw(lo, higuy);
            if (higuy - 1 - lo >= hi - loguy) {
              if (lo + W < higuy) { lostk[stkptr] = lo; histk[stkptr] = higuy - W; ++stkptr; }
              if (loguy < hi) { lo = loguy; continue; }
            } else {
              if (loguy < hi) { lostk[stkptr] = loguy; histk[stkptr] = hi; ++stkptr; }
              if (lo + W < higuy) { hi = higuy - W; continue; }
            }
          }
          --stkptr;
          if (stkptr >= 0) { lo = lostk[stkptr]; hi = histk[stkptr]; } else return mem;
        }
      }
      let seed = 12345; const rnd = (n) => { seed = (seed * 214013 + 2531011) >>> 0; return (seed >>> 16) % n; };
      const cmp = (a, b) => (a.z < b.z ? -1 : a.z !== b.z ? 1 : a.x < b.x ? -1 : a.x !== b.x ? 1 : 0);
      let same = 0, total = 0, unstable = 0;
      for (let t = 0; t < 400; t++) {
        const n = 1 + rnd(40);
        const a = Array.from({ length: n }, (_, i) => ({ id: i, z: rnd(6), x: rnd(3) }));
        const ref = refQsort(a, cmp).map(o => o.id).join();
        const got = msvcQsort(a.slice(), cmp).map(o => o.id).join();
        const stable = a.slice().sort(cmp).map(o => o.id).join();
        total++; if (ref === got) same++; if (ref !== stable) unstable++;
      }
      return { same, total, unstable };
    });
    check('msvcQsort = reference MSVC6 qsort.c permutation incl. ties (400 random lists)', r.same === r.total, r);
    check('reference qsort is not stable on these inputs (ties really exercised)', r.unstable > 0, r);
  });

  await run('scenelist', async () => {
    await newGame(5);
    await ticks(2);
    const r = await ev(() => {
      const g = game;
      const kind = (e) => e instanceof Sheep ? 'sheep' : e instanceof Mermaid ? 'mermaid' : e === g.sven.fightEntity ? 'fight'
        : e === g.sven ? 'sven' : e instanceof Dog ? 'dog' : e instanceof Shepherd ? 'shep' : e instanceof Mushroom ? 'mush'
        : e === g.ufo ? 'ufo' : (g.depthBushes || []).includes(e) ? 'bush' : e instanceof Lamb ? 'lamb' : '?';
      const built = g.buildSceneList().map(kind);
      const runs = []; for (const k of built) if (!runs.length || runs[runs.length - 1][0] !== k) runs.push([k, 1]); else runs[runs.length - 1][1]++;
      const persist = g._sceneList.length === built.length && g.buildSceneList().every(e => g._sceneList.includes(e));
      // Persistence: the next sort starts from the previous order.
      const before = g._sceneList.slice();
      const L = g._syncSceneList();
      const kept = L.length === before.length && L.every((e, i) => e === before[i]);
      // Lamb appended at the end (sub_41D171 → sub_467E51), removal keeps the order (RemoveAt).
      const lamb = new Lamb('Lamb01', g.assets.Lamb01, false, 0, 0, { x: 300, y: 200 }, { x: 310, y: 210 }, 3);
      g.lambs.push(lamb);
      const L2 = g._syncSceneList();
      const appended = L2[L2.length - 1] === lamb && L2.slice(0, -1).every((e, i) => e === before[i]);
      lamb.done = true; g._lambCleanup();
      const removed = !g.lambs.includes(lamb) && g._sceneList.length === before.length && g._sceneList.every((e, i) => e === before[i]);
      return { runs, persist, kept, appended, removed };
    });
    // L5 with 30 sheep: stamina 2400..2999 each (sub_42ABDF) → pool often > 90 %
    // at the start, so lambs may already be appended after the bushes.
    const order = r.runs.map(x => x[0]).join(',').replace(/,lamb$/, '');
    check('scene list insertion order: sheep, mermaid, fight, sven, dog, shep, 7 mush, ufo, 3 bushes, then lambs (sub_420C51)',
      order === 'sheep,mermaid,fight,sven,dog,shep,mush,ufo,bush' && r.runs.find(x => x[0] === 'mush')[1] === 7 && r.runs.find(x => x[0] === 'bush')[1] === 3, r.runs);
    check('scene list persistent across ticks (same members, previous order kept)', r.persist && r.kept, r);
    check('lamb appended at the end, removal keeps the others\' order (sub_424B7F)', r.appended && r.removed, r);
  });

  await run('syskeys', async () => {
    await ev(() => game.switchScene('title', 0));
    await page.waitForTimeout(200);
    const r = await ev(() => {
      const send = (o) => { window.dispatchEvent(new KeyboardEvent('keydown', o)); window.dispatchEvent(new KeyboardEvent('keyup', o)); };
      game.focusButton(0);
      send({ key: 'ArrowRight', code: 'ArrowRight', altKey: true });
      const altArrow = game.btnFocus;
      send({ key: 'F10', code: 'F10' });
      const f10 = game.btnFocus;
      send({ key: 'Alt', code: 'AltLeft', altKey: true });
      const alt = game.btnFocus;
      send({ key: 'ArrowRight', code: 'ArrowRight', altKey: true, ctrlKey: true });   // AltGr = WM_KEYDOWN
      const altGr = game.btnFocus;
      game.focusButton(0);
      send({ key: 'ArrowRight', code: 'ArrowRight' });
      const plain = game.btnFocus;
      game.focusButton(0);
      return { altArrow, f10, alt, altGr, plain, st: game.gstate };
    });
    check('Alt+arrow, F10 and Alt never reach a scene (WM_SYSKEYDOWN swallowed, R4-r2-40A000-04)', r.altArrow === 0 && r.f10 === 0 && r.alt === 0 && r.st === 'title', r);
    check('plain arrow and Ctrl+Alt (AltGr) still reach the scene', r.plain === 1 && r.altGr === 1, r);
    await newGame(1);
    await ev(() => T.placeSven(5, 5, 1));
    await settle();
    const s = await ev(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true }));
      return { flag: game.sven._keyFlag };
    });
    await ticks(3);
    const s2 = await ev(() => { window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true })); return [game.sven.col, game.sven.row, game.sven.facing]; });
    check('Alt+arrow in game: Sven does not turn or walk', !s.flag && s2.join() === '5,5,1', { s, s2 });
  });

  await run('musicblur', async () => {
    // Help: MenuSound keeps looping (this[8] = 0, its vtable+68 does not pause it).
    await ev(() => game.switchScene('help', 0));
    const r = await ev(() => {
      const a = game.audio;
      const mk = () => ({ currentTime: 3.5, loop: true, paused: false, muted: false, pauses: 0,
        pause() { this.paused = true; this.pauses++; }, play() { this.paused = false; return Promise.resolve(); } });
      const real = a.music; a.music = { menu: mk(), topscore: mk(), bush: mk() };
      window.dispatchEvent(new Event('blur'));
      const off = { muted: a.music.menu.muted, paused: a.music.menu.paused, t: a.music.menu.currentTime, pauses: a.music.menu.pauses };
      window.dispatchEvent(new Event('focus'));
      const on = { muted: a.music.menu.muted, paused: a.music.menu.paused, t: a.music.menu.currentTime };
      a.music = real;
      game.switchScene('title', 0);
      return { off, on };
    });
    check('focus loss mutes the music without pausing/rewinding (R4-r7-439000-01)', r.off.muted && !r.off.paused && r.off.pauses === 0 && r.off.t === 3.5, r);
    check('focus return unmutes the music at its position', !r.on.muted && !r.on.paused && r.on.t === 3.5, r);
  });

  await run('mojibake', async () => {
    await ev(() => localStorage.clear());
    await ev(() => game.switchScene('highscores', 0));
    await page.waitForTimeout(300);
    const r = await ev(() => {
      const t = loadHighScores();
      const drawn = [];
      const real = game.drawText;
      game.drawText = function (s, ...rest) { drawn.push(s); return real.call(this, s, ...rest); };
      game.drawHighScores();
      game.drawText = real;
      return { bytes: t.slice(0, 2).map(e => Array.from(e.name, c => c.charCodeAt(0))), disp: t.slice(0, 2).map(e => cp1251Display(e.name)),
        drawn: drawn.filter(s => /S.ren|D.rte/.test(s)).map(s => s.split(' ')[0]) };
    });
    check('default names are bytes 53 F6 72 65 6E / 44 F6 72 74 65 (0x4944F8)', r.bytes[0].join() === '83,246,114,101,110' && r.bytes[1].join() === '68,246,114,116,101', r.bytes);
    check('default names display "Sцren"/"Dцrte" (RUSSIAN_CHARSET, sub_472F04)', r.disp.join() === 'Sцren,Dцrte' && r.drawn.join() === 'Sцren,Dцrte', r);
    // Legacy localStorage (pre-round-4, Unicode strings) migrates to the same bytes.
    const m = await ev(() => {
      localStorage.setItem(SCOREDAT_KEY, JSON.stringify({ level: 4, table: [
        { name: 'Sören', score: 900 }, { name: 'Цой', score: 800 }, { name: 'Ole', score: 300 }, { name: 'Ansgar', score: 200 }, { name: 'Leif€', score: 100 }] }));
      const t = loadHighScores();
      const out = { lvl: loadProgress(), names: t.map(e => Array.from(e.name, c => c.charCodeAt(0).toString(16)).join(' ')), disp: t.map(e => cp1251Display(e.name)) };
      localStorage.clear();
      return out;
    });
    check('legacy localStorage names migrate to bytes (ö → F6 "ц", Ц → D6, € → 80)', m.lvl === 4 && m.names[0] === '53 f6 72 65 6e' && m.disp[0] === 'Sцren'
      && m.names[1] === 'd6 ee e9' && m.disp[1] === 'Цой' && m.names[4].endsWith('80'), m);
  });

  await run('nameentry', async () => {
    await ev(() => { localStorage.clear(); game.switchScene('highscores', 0); });
    await page.waitForTimeout(200);
    const r = await ev(() => {
      game.hsEntryActive = true; game.hsEntryName = ''; game.bossScreen = false;
      const key = (k, extra = {}) => { const o = { key: k, ...extra }; game.handleKey(new KeyboardEvent('keydown', o), true); game.handleKey(new KeyboardEvent('keyup', o), false); };
      key('ö'); key('ц'); key('Ö'); key('Ц'); key('ß'); key('Я'); key('a', { ctrlKey: true }); key('é'); key('A');
      const bytes = Array.from(game.hsEntryName, c => c.charCodeAt(0).toString(16));
      const disp = cp1251Display(game.hsEntryName);
      game.hsEntryName = ''; game.hsEntryActive = false;
      return { bytes, disp };
    });
    check('name entry: German ö and Russian ц both store byte 0xF6 and display "ц" (R4-DT-02)', r.bytes[0] === 'f6' && r.bytes[1] === 'f6' && r.disp.slice(0, 2) === 'цц', r);
    check('name entry: Ö/Ц → 0xD6 "Ц", ß/Я → 0xDF "Я"; Ctrl+A and é rejected; A accepted', r.bytes.join() === 'f6,f6,d6,d6,df,df,41' && r.disp === 'ццЦЦЯЯA', r);
  });

  await run('demounbound', async () => {
    await newGame(1);
    const r = await ev(() => {
      const s = game.sven, kb = game.keyBindings.slice();
      const realCell = s._cell, realPath = s._demoPath;
      s._cell = () => ({ type: 1 });
      s.stepTick = 0; s.state = 28;
      const res = {};
      for (const [label, path] of [['fwd', [{ dir: s.facing, depth: 0 }]], ['turn', [{ dir: (s.facing + 1) % 4, depth: 0 }]]]) {
        s._demoPath = () => path;
        game.keyBindings = kb.slice();
        s._keyFlag = false; s._demoTick(); const bound = [s.keyIdx, s._keyFlag];
        game.keyBindings = kb.slice(); game.keyBindings[s.keyIdx] = null;
        s._keyFlag = false; s._demoTick(); const unbound = [s.keyIdx, s._keyFlag];
        res[label] = { bound, unbound };
      }
      s._cell = realCell; s._demoPath = realPath; game.keyBindings = kb;
      return res;
    });
    check('demo autopilot: unbound key slot → +136 = 0, no action (sub_436173, R4-r6-432000-01)',
      r.fwd.bound[0] === 4 && r.fwd.bound[1] === true && r.fwd.unbound[1] === false && r.turn.bound[1] === true && r.turn.unbound[1] === false, r);
  });

  await run('exitmute', async () => {
    const r = await ev(() => {
      const a = game.audio;
      game.switchScene('exit', 0);
      const mk = () => ({ currentTime: 2, paused: false, pauses: 0, plays: 0, pause() { this.paused = true; this.pauses++; }, play() { this.plays++; this.paused = false; return Promise.resolve(); } });
      const real = a.music, realEn = a.enabled; a.music = { menu: mk(), topscore: mk(), bush: mk() }; a.enabled = true;
      const m0 = a.muted;
      const key = (k, c) => { game.handleKey(new KeyboardEvent('keydown', { key: k, code: c }), true); game.handleKey(new KeyboardEvent('keyup', { key: k, code: c }), false); };
      key('s', 'KeyS'); const m1 = a.muted;
      key('s', 'KeyS'); const m2 = a.muted;
      const menu = a.music.menu;
      a.music = real; a.enabled = realEn;
      const st = game.gstate;
      return { m0, m1, m2, pauses: menu.pauses, plays: menu.plays, st };
    });
    await ev(() => { game.appClosed = false; game.switchScene('title', 0); });
    check('exit scene: mute key only toggles the flag (sub_41DADE/sub_41DB07 on this[8]=0, R4-r5-428000-02)', r.st === 'exit' && r.m1 === !r.m0 && r.m2 === r.m0 && r.pauses === 0 && r.plays === 0, r);
  });

  await run('helptitle', async () => {
    const r = await ev(() => {
      const a = game.audio, real = a.playAmbient, calls = [];
      a.playAmbient = function (w) { calls.push(w); return real.call(this, w); };
      const out = {};
      game.switchScene('help', 0); calls.length = 0; game.switchScene('title', 0); out.help = calls.slice(); out.helpScene = a.scene;
      game.switchScene('setup', 0); calls.length = 0; game.switchScene('title', 0); out.setup = calls.slice();
      game.switchScene('highscores', 0); calls.length = 0; game.switchScene('title', 0); out.hs = calls.slice();
      a.playAmbient = real;
      return out;
    });
    check('title from Help/Setup does not (re)start MenuSound (sub_41F0EE this[8]=0, R4-41E000-01)', r.help.length === 0 && r.setup.length === 0 && r.helpScene === 'menu', r);
    check('title from Top Scores starts MenuSound', r.hs.includes('menu'), r);
  });

  await run('loadbar', async () => {
    const p2 = await context.newPage();
    const errs = [];
    p2.on('pageerror', e => errs.push(e.message));
    await p2.route('**/src/boot.js', async (route) => {
      const res = await route.fetch();
      const body = await res.text();
      const patch = `window.__bar = []; (function(){ const o = Game.prototype._drawLoadingBar;
        Game.prototype._drawLoadingBar = function (c, t) { const v = o.call(this, c, t);
          window.__bar.push([c, t, this.gstate, Array.from(ctx.getImageData(320, 240, 1, 1).data.slice(0, 3))]); return v; }; })();\n`;
      await route.fulfill({ response: res, body: patch + body });
    });
    await p2.goto(URL, { waitUntil: 'load' });
    await p2.waitForFunction(() => window.game && game.gstate === 'title', null, { timeout: 60000 });
    const r = await p2.evaluate(() => {
      const b = window.__bar, total = b[0][1];
      const pre = b.slice(0, -1);
      const mono = pre.every((x, i) => i === 0 || x[0] >= pre[i - 1][0]);
      const imgs = Object.keys(game.lib.Images).filter(k => /^[A-Za-z]/.test(k)).filter(k => !game.assets[k]).length;
      return { n: b.length, total, first: b[0][0], prev: b[b.length - 2][0], last: b[b.length - 1][0],
        lastPx: b[b.length - 1][3], prevPx: b[b.length - 2][3], mono, sameTotal: b.every(x => x[1] === total), imgs };
    });
    await p2.close();
    // Total 7805 counts the ';' lines (R5-VER-01 UNVERIFIED, core.js iniSectionRawLines);
    // the alpha lines sum to 7358. The final 0x7FFFFFFF step wraps cur negative
    // past the signed clamp (0x411F88-0x411FAE) → split out of range, black only
    // (sub_41DDBB IDA:13479-13505, R5-VER-02).
    check('loading bar: 0 → monotonic → 7358/7805, then the 0x7FFFFFFF step wraps negative (R5-VER-02)',
      r.first === 0 && r.mono && r.sameTotal && r.total === 7805 && r.prev === 7358
      && r.last === ((7358 + 0x7FFFFFFF) | 0) && errs.length === 0, r);
    check('loading bar: last frame black (both BltFasts fail), the one before is not',
      r.lastPx.every(v => v === 0) && r.prevPx.some(v => v > 0), r);
    check('loading: every Library.ini [Images] entry loaded (none missing)', r.imgs === 0, r.imgs);
  });

  //--- Round 5 ----------------------------------------------------------------
  await run('posted', async () => {
    // R5-LOOP-01: the end-hold expiry posts 0x402 (sub_423CEE IDA:16207-16213);
    // the posting tick runs on (hudTick, +308) and is flipped with the old
    // scene, the switch is handled after it. this[114] stays set (R5-LIM-05).
    await newGame(1);
    await ev(() => {
      localStorage.clear(); T.isolate(); game.lives = 0; game.startEndHold();
      window.__rl = []; const o = game.render;
      game.render = function (now) { __rl.push({ gs: this.gstate, hud: this.hudFrame, posted: this._posted.length, hold: this.endHoldMs });
        return o.call(this, now); };
      game.levelEndAt = getTickCount() + 150;
    });
    const ok = await until(() => game.gstate === 'highscores', null, 5000);
    const r = await ev(() => { delete game.render; const l = __rl, i = l.findIndex(x => x.posted > 0);
      return { i, at: l[i], prev: l[i - 1], after: l[i + 1] || null, gs: game.gstate }; });
    check('posted: the posting tick is drawn in the game scene with the hold up, +308 advanced, switch after it',
      ok && r.i > 0 && r.at.gs === 'playing' && r.at.hold > 0 && r.at.hud === r.prev.hud + 1 && r.gs === 'highscores'
      && (!r.after || r.after.gs === 'highscores'), r);
    await ev(() => game.switchScene('title', 0));
  });

  await run('interleave', async () => {
    // R5-LOOP-02: tick+draw per list object (sub_41CCBD) gives the same image as
    // drawing everything after the ticks when no object draws before another moves.
    await newGame(1);
    await ticks(10);
    const r = await ev(async () => {
      const g = game, out = [];
      for (let k = 0; k < 20; k++) {
        const t0 = g.tickCount;
        await new Promise(res => { const f = () => (g.tickCount > t0 ? res() : requestAnimationFrame(f)); f(); });
        const c = document.createElement('canvas'); c.width = 640; c.height = 480; const x = c.getContext('2d');
        x.fillStyle = '#000'; x.fillRect(0, 0, 640, 480); g.drawLake(x); x.drawImage(g.bg, 0, 0); g.drawPuddles(x);
        if (g.ufo) g.ufo.drawUnder(x, g);
        for (const e of g._drawList) if (g._sceneListVisible(e)) { e.draw(x); if (e === g.sven) g.drawSaintHalo(x); }
        const a = x.getImageData(0, 0, 640, 480).data, w = g._worldG.getImageData(0, 0, 640, 480).data;
        let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== w[i]) d++;
        out.push(d);
      }
      return out;
    });
    check('interleave: world image = old tick-all-then-draw image over 20 normal L1 ticks', r.every(d => d === 0), r);
  });

  await run('lifeicons', async () => {
    // R5-SCA-06: icon animations start at the event (sub_424CB8 ')' / sub_423CEE /
    // sub_42546F / sub_424FFC(8)), not from a per-tick lives poll.
    await newGame(1);
    const r = await ev(() => {
      T.isolate(); const g = game;
      g.lives = 3; g.hudResetLives();
      g.catchDeathPending = false; g.onSvenCaught();               // 3 → 2: fly-off
      const lost = { fly: g.lifeFly, shown: g.hudLivesShown, x: g.lifeFlyX, y: g.lifeFlyY };
      g.lives = 3; g.hudResetLives(); g.lives++; g.startLifeIconAnim(); // as sub_42546F: 4 → drop-in
      const gain = { drop: g.lifeDrop, shown: g.hudLivesShown, x: g.lifeDropX };
      // Same-tick gain then loss: both run (no netting), the fly-off starts at the drop-in icon.
      g.lives--; if (g.lives > 0) g.startLifeLostAnim();
      const both = { fly: g.lifeFly, drop: g.lifeDrop, x: g.lifeFlyX, shown: g.hudLivesShown };
      g.catchDeathPending = false;
      return { lost, gain, both, poll: /_hudLivesSeen/.test(Game.prototype.hudTick.toString()) };
    });
    check('lifeicons: catch → fly-off at once (shown = lives-1, x = 37*1+7, y = 445)',
      r.lost.fly === 0 && r.lost.shown === 1 && r.lost.x === 44 && r.lost.y === 445, r);
    check('lifeicons: gain → drop-in (shown = lives-2), gain+loss in one tick → fly-off from the drop-in, no hudTick poll',
      r.gain.drop === 0 && r.gain.shown === 2 && r.gain.x === 81 && r.both.fly === 0 && r.both.drop === -1 && r.both.x === 81 && !r.poll, r);
  });

  await run('ctrlh', async () => {
    // R5-VER-03: Ctrl+H = WM_CHAR 0x08 (backspace), Ctrl+Backspace = 0x7F (rejected).
    await ev(() => { localStorage.clear(); game.switchScene('highscores', 0); });
    await page.waitForTimeout(200);
    const r = await ev(() => {
      game.hsEntryActive = true; game.hsEntryName = 'ABC'; game.bossScreen = false;
      const key = (k, code, extra = {}) => { const o = { key: k, code, ...extra }; game.handleKey(new KeyboardEvent('keydown', o), true); game.handleKey(new KeyboardEvent('keyup', o), false); };
      key('h', 'KeyH', { ctrlKey: true }); const a = game.hsEntryName;
      key('Backspace', 'Backspace', { ctrlKey: true }); const b = game.hsEntryName;
      key('р', 'KeyH', { ctrlKey: true }); const c = game.hsEntryName;      // Russian layout, same key
      key('Backspace', 'Backspace'); const d = game.hsEntryName;
      game.hsEntryName = ''; game.hsEntryActive = false;
      return [a, b, c, d];
    });
    check('ctrlh: Ctrl+H deletes, Ctrl+Backspace does nothing, Backspace deletes', r.join() === 'AB,AB,A,', r);
    await ev(() => game.switchScene('title', 0));
  });

  await run('pending7', async () => {
    // R5-SCA-03: _snprintf(Str, 7u, "%d") (IDA:17603) → at most 7 characters.
    await ev(() => { localStorage.clear(); game.switchScene('highscores', 0); });
    await page.waitForTimeout(200);
    const r = await ev(() => {
      const o = game.drawText, seen = [];
      game.drawText = function (t, ...a) { seen.push(t); return o.call(this, t, ...a); };
      const res = [];
      for (const v of [123456, 1234567, 12345678]) { game.hsEntryScore = v; seen.length = 0; game.drawHighScores(); res.push(seen.find(t => /^\d+$/.test(t) && t.startsWith('123'))); }
      delete game.drawText; game.hsEntryScore = -1;
      return res;
    });
    check('pending7: pending score drawn with at most 7 characters', r.join() === '123456,1234567,1234567', r);
    await ev(() => game.switchScene('title', 0));
  });

  await run('beam565', async () => {
    // R5-MU-07: LightBeam on 16 bpp (sub_41BD7E case 16 IDA:12318-12340):
    // v > 0xBF → dst = ((dst & 0xF7DE) >> 1) + 2113 * (v >> 4), expanded 565 → 888.
    await ev(() => ufoLoadBeam());
    await until(() => UFO_BEAM && UFO_BEAM.raw, null, 10000);
    const r = await ev(() => {
      const c = document.createElement('canvas'); c.width = UFO_BEAM_W + 20; c.height = UFO_BEAM_H + 20; const x = c.getContext('2d');
      const cols = [[128, 128, 128], [255, 255, 255], [0, 0, 0], [200, 40, 90]];
      const res = [];
      for (const [R, G, B] of cols) {
        x.fillStyle = `rgb(${R},${G},${B})`; x.fillRect(0, 0, c.width, c.height);
        Ufo.prototype._drawBeam.call({ x: 10, y: 10, off84: 0, off88: 0, off92: 0, off96: 0 }, x);
        const img = x.getImageData(10, 10, UFO_BEAM_W, UFO_BEAM_H).data;
        const dst = ((R >> 3) << 11) | ((G >> 2) << 5) | (B >> 3);
        let bad = 0, hit = 0;
        for (let i = 0; i < UFO_BEAM_W * UFO_BEAM_H; i++) {
          const v = UFO_BEAM.raw[i];
          let w = dst;
          if (v > 0xBF) { w = (((dst & 0xF7DE) >> 1) + 2113 * (v >> 4)) & 0xFFFF; hit++; }
          const r5 = w >> 11, g6 = (w >> 5) & 63, b5 = w & 31;
          const want = v > 0xBF ? [(r5 << 3) | (r5 >> 2), (g6 << 2) | (g6 >> 4), (b5 << 3) | (b5 >> 2)] : [R, G, B];
          if (img[i * 4] !== want[0] || img[i * 4 + 1] !== want[1] || img[i * 4 + 2] !== want[2]) bad++;
        }
        res.push({ bad, hit });
      }
      return res;
    });
    check('beam565: every beam pixel = ((dst&0xF7DE)>>1) + 2113*(v>>4) on 4 backgrounds', r.every(o => o.bad === 0 && o.hit > 0), r);
  });

  await run('halodir', async () => {
    // R5-SVEN-03: the Saint-Disc record is set at state entry (sub_43707B
    // IDA:25160); sub_438A80 (UFO 'P') flips this[14] without re-setting it.
    await newGame(4);
    await ev(() => { T.isolate(); T.placeSven(7, 6, 0); game.startSaint(10); });
    await settle();
    const r = await ev(() => {
      const s = game.sven, d0 = s.haloDir;
      s.ufoReturn(80);                                   // facing 0 → 3, no state entry yet
      const disc = game.assets['Saint-Disc'], o = disc.drawFrame; let call = null;
      disc.drawFrame = function (g, f, dx, dy, fl) { call = [dx, dy, !!fl]; };
      game.drawSaintHalo(game._worldG); delete disc.drawFrame;
      const p = s.screenPos(), want = spriteRecord('SaintDisc', 0), other = spriteRecord('SaintDisc', 3);
      return { d0, facing: s.facing, haloDir: s.haloDir, call, want: [p.x + want.dx, p.y + want.dy - disc.frameH, !!want.flip],
        other: [p.x + other.dx, p.y + other.dy - disc.frameH, !!other.flip] };
    });
    check('halodir: UFO return flips facing 0→3, the halo keeps the entry direction 0', r.d0 === 0 && r.facing === 3 && r.haloDir === 0
      && r.call && r.call.join() === r.want.join() && r.want.join() !== r.other.join(), r);
  });

  await run('catch60', async () => {
    // R5-sheep-02: sub_425311 keeps entries with t >= now - 60000 (IDA:16856-16858).
    await newGame(1);
    const r = await ev(() => {
      const g = game, real = window.getTickCount, T0 = real();
      window.getTickCount = () => T0;
      const run = (age) => {
        g.catchBuffer = []; for (let i = 0; i < 9; i++) g.catchBuffer.push({ id: { i }, t: T0 - age });
        const s0 = g.score, sa0 = g.saintEnd; g.recordCatch({});
        return { len: g.catchBuffer.length, fired: g.score !== s0 || g.saintEnd !== sa0 };
      };
      const a = run(60000), b = run(60001);
      window.getTickCount = real; g.catchBuffer = [];
      return { a, b, src: /getTickCount\(\)/.test(Game.prototype.recordCatch.toString()) };
    });
    check('catch60: an entry exactly 60000 ms old still counts (10th catch fires), 60001 is dropped; GetTickCount clock',
      r.a.fired && r.a.len === 0 && !r.b.fired && r.b.len === 1 && r.src, r);
  });

  await run('rearm', async () => {
    // R5-LIM-01: a level advance re-runs sub_41C9F8 → 0x403(this[13]) (IDA:12610):
    // the 20 Hz timer is re-armed (next tick a full period later).
    await newGame(1);
    await ev(() => { T.isolate(); window.__ra = []; const o = game._rearmTimer;
      game._rearmTimer = function () { __ra.push({ lvl: this.levelIdx, inTick: this._inTick }); return o.call(this); };
      game.sheepRemaining = 0; });
    const ok = await until(() => game.levelIdx === 2, null, 5000);
    const r = await ev(() => { delete game._rearmTimer; return __ra; });
    check('rearm: level advance re-arms the timer inside the tick, after loading level 2', ok && r.length === 1 && r[0].lvl === 2 && r[0].inTick, r);
  });

  check('no page errors', errors.length === 0, errors.slice(0, 10));
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  await browser.close();
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
