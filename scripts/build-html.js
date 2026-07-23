#!/usr/bin/env node
// Build-time HTML include/token engine. Not a templating library on purpose:
// this site is 5 flat pages, so all it needs is (a) verbatim partial includes
// and (b) simple {{token}} substitution plus one flat {{#if flag}} conditional.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PAGES_DIR = path.join(ROOT, 'src', 'pages');
const PARTIALS_DIR = path.join(ROOT, 'src', 'partials');

const INCLUDE_RE = /<!--#include partial="([^"]+)"-->/g;
const IF_RE = /\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g;
const TOKEN_RE = /\{\{(\w+)\}\}/g;

function expandIncludes(content, depth) {
  if (depth > 5) {
    throw new Error('Include recursion too deep (possible cycle)');
  }
  return content.replace(INCLUDE_RE, (_match, partialName) => {
    const partialPath = path.join(PARTIALS_DIR, partialName);
    if (!fs.existsSync(partialPath)) {
      throw new Error(`Partial not found: ${partialName} (looked in ${partialPath})`);
    }
    const partialContent = fs.readFileSync(partialPath, 'utf8');
    return expandIncludes(partialContent, depth + 1);
  });
}

function applyConditionals(content, data) {
  return content.replace(IF_RE, (_match, flag, inner) => (data[flag] ? inner : ''));
}

function substituteTokens(content, data, pageName) {
  return content.replace(TOKEN_RE, (_match, name) => {
    if (!(name in data)) {
      throw new Error(`Unresolved token {{${name}}} while building ${pageName} -- add it to the page's .data.js`);
    }
    return String(data[name]);
  });
}

function buildPage(pageFile, outDir) {
  const pageName = path.basename(pageFile, '.html');
  const pagePath = path.join(PAGES_DIR, pageFile);
  const dataPath = path.join(PAGES_DIR, `${pageName}.data.js`);

  if (!fs.existsSync(dataPath)) {
    throw new Error(`Missing data file for ${pageFile}: expected ${dataPath}`);
  }

  delete require.cache[require.resolve(dataPath)];
  const data = require(dataPath);

  let output = fs.readFileSync(pagePath, 'utf8');
  output = expandIncludes(output, 0);
  output = applyConditionals(output, data);
  output = substituteTokens(output, data, pageFile);

  const outPath = path.join(outDir, `${pageName}.html`);
  fs.writeFileSync(outPath, output);
  return outPath;
}

function main() {
  const outDirArg = process.argv[2];
  const outDir = outDirArg ? path.resolve(outDirArg) : ROOT;
  fs.mkdirSync(outDir, { recursive: true });

  const pageFiles = fs
    .readdirSync(PAGES_DIR)
    .filter((f) => f.endsWith('.html'));

  if (pageFiles.length === 0) {
    throw new Error(`No page templates found in ${PAGES_DIR}`);
  }

  const written = pageFiles.map((f) => buildPage(f, outDir));
  written.forEach((p) => console.log(`built ${path.relative(ROOT, p)}`));
}

try {
  main();
} catch (err) {
  console.error(`build-html failed: ${err.message}`);
  process.exit(1);
}
