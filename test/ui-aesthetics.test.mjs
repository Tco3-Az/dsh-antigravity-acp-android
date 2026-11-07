import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { unauthCardView, connectedCardView, stripView } from '../lib/ui.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

// Regex for common emojis
const EMOJI_REGEX = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}]/u;

// Neon / hyper-saturated colors regex (e.g. #00ffff, #ff00ff, #00ff00, rgb neon, etc.)
const NEON_COLOR_REGEX = /#(00ffff|ff00ff|00ff00|ff007f|7f00ff|00ff7f|ff00aa)\b/i;

function getAllFiles(dir, exts = ['.js', '.ts', '.json', '.html', '.css', '.md']) {
  let files = [];
  const entries = readdirSync(dir);
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      files = files.concat(getAllFiles(full, exts));
    } else if (exts.some((ext) => full.endsWith(ext))) {
      files.push(full);
    }
  }
  return files;
}

test('UI Aesthetics: Zero gradients, zero neon colors, zero emojis across UI source files', (t) => {
  const uiFiles = [
    join(rootDir, 'lib', 'ui.js'),
    join(rootDir, 'src', 'ui.ts'),
    join(rootDir, 'package.json'),
  ];

  for (const filePath of uiFiles) {
    const content = readFileSync(filePath, 'utf8');

    // 1. Gradients forbidden
    assert.ok(
      !content.includes('linear-gradient'),
      `File ${filePath} must not contain 'linear-gradient'`
    );
    assert.ok(
      !content.includes('radial-gradient'),
      `File ${filePath} must not contain 'radial-gradient'`
    );

    // 2. High-saturation neon colors forbidden
    assert.ok(
      !NEON_COLOR_REGEX.test(content),
      `File ${filePath} must not contain high-saturation neon color definitions`
    );

    // 3. Emojis forbidden (Flutter Material 3 clean look)
    assert.ok(
      !EMOJI_REGEX.test(content),
      `File ${filePath} must not contain cheap emoji symbols`
    );
  }
});

test('UI Aesthetics: Text length restrictions for cards, buttons and strips (zh and en)', (t) => {
  const locales = ['zh', 'en'];

  for (const lang of locales) {
    // 1. Unauthenticated card
    const unauth = unauthCardView({ lang });
    assert.ok(
      unauth.title.length <= 16,
      `Unauth title [${lang}] length ${unauth.title.length} exceeds 16 ("${unauth.title}")`
    );

    const unauthActions = unauth.children.find((c) => c.type === 'actions');
    assert.ok(unauthActions, `Unauth card [${lang}] must have actions block`);
    for (const item of unauthActions.items) {
      assert.ok(
        item.label.length <= 10,
        `Button label [${lang}] length ${item.label.length} exceeds 10 ("${item.label}")`
      );
      assert.ok(!EMOJI_REGEX.test(item.label), `Button [${lang}] must not have emojis`);
    }

    // 2. Connected card
    const connected = connectedCardView({ lang, model: 'server-default', quotaPercent: 100 });
    assert.ok(
      connected.title.length <= 16,
      `Connected title [${lang}] length ${connected.title.length} exceeds 16 ("${connected.title}")`
    );

    // 3. Strip view
    const stripAuth = stripView({ authorized: true }, lang);
    assert.ok(
      stripAuth.text.length <= 24,
      `Authorized strip [${lang}] length ${stripAuth.text.length} exceeds 24 ("${stripAuth.text}")`
    );
    assert.ok(!EMOJI_REGEX.test(stripAuth.text), `Strip [${lang}] must not have emojis`);

    const stripUnauth = stripView({ authorized: false }, lang);
    assert.ok(
      stripUnauth.text.length <= 24,
      `Unauthorized strip [${lang}] length ${stripUnauth.text.length} exceeds 24 ("${stripUnauth.text}")`
    );
    assert.ok(!EMOJI_REGEX.test(stripUnauth.text), `Strip [${lang}] must not have emojis`);
  }
});
