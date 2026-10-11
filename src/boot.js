//=== Boot ==================================================================
const game = new Game();
window.game = game; // expose for e2e tests
// Keys the browser would otherwise act on (scrolling, focus moves).
const BOOT_BLOCK_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'Backspace', 'Tab', 'F1']);
// WM_SYSKEYDOWN / WM_SYSCHAR (0x411C87 / 0x411C94) are swallowed and
// WM_SYSKEYUP is not in the message map: F10, Alt and any key pressed or
// released while Alt is held (without Ctrl; Ctrl+Alt = AltGr gives
// WM_KEYDOWN) never reach a scene. No preventDefault (DefWindowProc).
function bootIsSysKey(e) {
  return e.key === 'F10' || e.code === 'F10' || e.key === 'Alt'
      || (e.altKey && !e.ctrlKey);
}
window.addEventListener('keydown', e => {
  if (bootIsSysKey(e)) return;
  if (BOOT_BLOCK_KEYS.has(e.key)) e.preventDefault();
  game.handleKey(e, true);
});
window.addEventListener('keyup', e => {
  if (bootIsSysKey(e)) return;
  if (BOOT_BLOCK_KEYS.has(e.key)) e.preventDefault();
  game.handleKey(e, false);
});
// Mouse → scene buttons (WM_MOUSEMOVE / WM_LBUTTONDOWN / WM_LBUTTONUP,
// message map .rdata 0x473838-0x473868).
function bootMouse(type, e) {
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) * (canvas.width  / rect.width);
  const y = (e.clientY - rect.top)  * (canvas.height / rect.height);
  if (type === 'down') game.audio.enable();
  game.onMouse(type, x, y);
}
// WM_ACTIVATEAPP (message map 0x1C → sub_4115B9): window focus / tab visibility.
window.addEventListener('blur',  () => game.appActivate(false));
window.addEventListener('focus', () => game.appActivate(true));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) game.appActivate(false);
  else if (document.hasFocus()) game.appActivate(true);
});
canvas.addEventListener('mousemove', e => bootMouse('move', e));
canvas.addEventListener('mousedown', e => { if (e.button === 0) bootMouse('down', e); });
canvas.addEventListener('mouseup',   e => { if (e.button === 0) bootMouse('up', e); });
game.load().then(() => requestAnimationFrame(game._tickFn))
           .catch(err => { console.error(err); });
