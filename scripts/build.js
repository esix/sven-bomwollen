// Builds dist/: index.html + one concatenated game.js (scripts in index.html
// order; they are plain globals, so concatenation keeps behaviour) + assets/.
// Usage: node scripts/build.js
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist);

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const scriptRe = /<script src="(src\/[^"]+)"><\/script>\n?/g;
const scripts = [...html.matchAll(scriptRe)].map(m => m[1]);
if (!scripts.length) throw new Error('no <script src="src/..."> tags in index.html');

const bundle = scripts
  .map(s => `//--- ${s}\n${fs.readFileSync(path.join(root, s), 'utf8')}`)
  .join('\n;\n');
fs.writeFileSync(path.join(dist, 'game.js'), bundle);

// Replace the script tags with one tag for the bundle (at the first tag's place).
let first = true;
const outHtml = html
  .replace(/<!--[^\n]*-->\n(?=<script src="src\/)/g, '')
  .replace(scriptRe, () => (first ? (first = false, '<script src="game.js"></script>\n') : ''));
fs.writeFileSync(path.join(dist, 'index.html'), outHtml);

fs.cpSync(path.join(root, 'assets'), path.join(dist, 'assets'), { recursive: true });

console.log(`dist/: index.html, game.js (${scripts.length} sources), assets/`);
