# Sven Bømwøllen — JavaScript port

A faithful port of the 2002 game *Sven Bømwøllen* (Phenomedia AG) to the browser.

## Usage

```
npm install
npm start          # dev server at http://localhost:8088/ (no caching)
npm run build      # build into dist/ (index.html, game.js, assets/)
npm run serve:dist # serve dist/ at http://localhost:8088/
npm test           # regression suite (Playwright; needs the dev server running)
```

Add `?debug` to the URL for debug keys (N/P/R level, L life, T clock, G grid, H panel).

## Layout

- `index.html` — page and script load order
- `src/` — game sources (plain `<script>` globals, no modules)
- `assets/` — sprites, sounds and INI data unpacked from the original `Sven.dat`
- `scripts/` — dev server and build
- `tests/` — Playwright regression suite
