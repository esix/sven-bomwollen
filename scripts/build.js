// Builds dist/: index.html + one minified game.js (the sources in index.html
// order, concatenated and wrapped in one IIFE — they are plain globals that
// only reach each other by name, and boot.js exports window.game) + assets/.
// Usage: node scripts/build.js
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist);

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const scriptRe = /<script src="(src\/[^"]+)"><\/script>\n?/g;
const scripts = [...html.matchAll(scriptRe)].map(m => m[1]);
if (!scripts.length) throw new Error('no <script src="src/..."> tags in index.html');

const source = scripts
  .map(s => fs.readFileSync(path.join(root, s), 'utf8'))
  .join('\n;\n');
const { code } = esbuild.transformSync(source, {
  format: 'iife',
  minify: true,
  target: 'es2020',
  charset: 'utf8',
  legalComments: 'none',
});
fs.writeFileSync(path.join(dist, 'game.js'), code);

// Replace the script tags with one tag for the bundle (at the first tag's place).
let first = true;
const outHtml = html
  .replace(/<!--[^\n]*-->\n(?=<script src="src\/)/g, '')
  .replace(scriptRe, () => (first ? (first = false, '<script src="game.js"></script>\n') : ''));
fs.writeFileSync(path.join(dist, 'index.html'), outHtml);

fs.cpSync(path.join(root, 'assets'), path.join(dist, 'assets'), { recursive: true });

const kb = (n) => `${Math.round(n / 1024)} KB`;
console.log(`dist/: index.html, game.js (${scripts.length} sources, ${kb(source.length)} → ${kb(code.length)}), assets/`);
