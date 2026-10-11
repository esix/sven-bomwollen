//=== Debug controls (not in the original) ==================================
// Active only with ?debug in the page URL; otherwise this file does nothing.
// Keys act only during a running game level (not the demo, Esc dialog, level
// transition or end hold) and are swallowed there, so they never reach Sven:
//   N  next level        P  previous level     R  restart level
//   L  +1 life           T  clock back to 90 s G  grid overlay
//   H  show/hide the debug panel
// Level jumps go through the normal level-complete path (sub_423EA9 →
// transition) with the score frozen for that tick, so no bonus is added.
// Like a real level change they save the level to Score.dat (Continue).
(function () {
  if (!new URLSearchParams(location.search).has('debug')) return;

  const DEBUG_KEYS = {
    KeyN: g => g._dbgJump(g.levelIdx + 1),
    KeyP: g => g._dbgJump(Math.max(1, g.levelIdx - 1)),
    KeyR: g => g._dbgJump(g.levelIdx),
    KeyL: g => { g.lives++; g.startLifeIconAnim(); },
    KeyT: g => { g._dbgReq = { clock: true }; },
    KeyG: g => { g._dbgGrid = !g._dbgGrid; },
    KeyH: () => { panel.hidden = !panel.hidden; },
  };

  const panel = document.createElement('pre');
  panel.style.cssText = 'position:fixed;left:8px;top:8px;margin:0;padding:6px 8px;' +
    'font:12px/1.4 monospace;color:#0f0;background:rgba(0,0,0,.7);' +
    'pointer-events:none;z-index:10;white-space:pre';
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(panel));

  Object.assign(Game.prototype, {
    _dbgActive() {
      return this.gstate === GAME_STATE.PLAYING && !this.demoMode && !this.escDialog
          && !this.bossScreen && !this.endHoldMs && !(this.levelTransitionTicks > 0);
    },
    // Applied at the next tick (hook below), before the level-complete check.
    _dbgJump(target) {
      if (target > this.mapInfo.levelCount) target = null;    // past the last level → win
      this._dbgReq = { jump: target };
    },
  });

  const handleKey = Game.prototype.handleKey;
  Game.prototype.handleKey = function (e, down) {
    const act = DEBUG_KEYS[e.code];
    if (act && !e.ctrlKey && !e.metaKey && this._dbgActive()) {
      if (down && !e.repeat) act(this);
      return;
    }
    handleKey.call(this, e, down);
  };

  GAME_TICK_HOOKS.push(function () {
    // Not during the end hold: sub_423F9C froze the score for real there.
    if (this._dbgUnfreeze) { if (!this.endHoldMs) this.scoreFrozen = false; this._dbgUnfreeze = false; }
    const req = this._dbgReq;
    this._dbgReq = null;
    if (!req || this.endHoldMs) return;
    if (req.clock) {
      if (!this.clockPause) this.setLevelClock(LEVEL_DURATION_S * 1000);
      return;
    }
    // afterLevelComplete loads levelIdx + 1; null = no next level (game won).
    this.levelIdx = req.jump === null ? this.mapInfo.levelCount : req.jump - 1;
    if (!this.scoreFrozen) { this.scoreFrozen = true; this._dbgUnfreeze = true; }
    this.sheepRemaining = 0;
  });

  // Cell lattice: lines between neighbouring cell anchors, "col,row" labels.
  const draw = Game.prototype.draw;
  Game.prototype.draw = function () {
    draw.call(this);
    if (!this._dbgGrid || !this.level) return;
    const rows = this.mapInfo.rows, cols = this.mapInfo.cols;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,0,.5)';
    ctx.fillStyle = '#ff0';
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    ctx.beginPath();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const p = cellToScreen(c, r);
        if (c + 1 < cols) { const q = cellToScreen(c + 1, r); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); }
        if (r + 1 < rows) { const q = cellToScreen(c, r + 1); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); }
      }
    }
    ctx.stroke();
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const p = cellToScreen(c, r);
        ctx.fillText(`${c},${r}`, p.x, p.y + 3);
      }
    ctx.restore();
  };

  function updatePanel() {
    const g = window.game;
    if (g && !panel.hidden) {
      const lines = [`DEBUG  state ${g.gstate}`];
      if (g.gstate === GAME_STATE.PLAYING && g.level) {
        const s = g.sven;
        lines.push(
          `level ${g.levelIdx}/${g.mapInfo.levelCount}${g.demoMode ? ' (demo)' : ''}`,
          `score ${g.score}  lives ${g.lives}`,
          `clock ${(g._levelRemainMs / 1000).toFixed(1)} s${g.clockPause ? ' (paused)' : ''}`,
          `sheep left ${g.sheepRemaining}`,
          s ? `sven ${s.col},${s.row}  state ${s.state}` : '');
      }
      lines.push('', 'N next  P prev  R restart', 'L +life  T clock  G grid  H hide');
      panel.textContent = lines.join('\n');
    }
    requestAnimationFrame(updatePanel);
  }
  requestAnimationFrame(updatePanel);
})();
