#!/usr/bin/env node
// Rebuilds the root HTML pages whenever anything in src/ changes (pages,
// partials or *.data.js). Each rebuild runs build-html.js in a fresh process
// so edited .data.js files aren't served stale from the require cache.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');
const BUILD_SCRIPT = path.join(__dirname, 'build-html.js');

function build() {
  const result = spawnSync(process.execPath, [BUILD_SCRIPT], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error('build failed, waiting for the next change...');
  }
}

let timer = null;
fs.watch(SRC_DIR, { recursive: true }, (_event, filename) => {
  clearTimeout(timer);
  // Editors often write a file in several steps; wait for them to settle.
  timer = setTimeout(() => {
    console.log(`\nchanged: ${filename}`);
    build();
  }, 100);
});

build();
console.log(`watching ${path.relative(ROOT, SRC_DIR)}/ for changes...`);
