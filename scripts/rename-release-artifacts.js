#!/usr/bin/env node
/**
 * electron-builder uses arch name "x64" in filenames; rename to "amd64" for clarity.
 */
const fs = require('fs');
const path = require('path');

const release = path.join(__dirname, '..', 'release');
if (!fs.existsSync(release)) {
  process.exit(0);
}
for (const name of fs.readdirSync(release)) {
  if (!name.includes('-x64.') && !name.includes('-x64-')) continue;
  const next = name.replace(/-x64/g, '-amd64');
  if (next !== name) {
    fs.renameSync(path.join(release, name), path.join(release, next));
    console.log('artifact rename:', name, '->', next);
  }
}
