#!/usr/bin/env node
// Set icon and version info on Windows exe using resedit (pure Node.js, no Wine needed).
// Usage: node scripts/set-exe-icon.js <path-to-exe> [path-to-ico]

const fs = require('fs');
const path = require('path');
const ResEdit = require('resedit');

const exePath = process.argv[2];
const icoPath = process.argv[3] || path.join(__dirname, '..', 'resources', 'icon.ico');

if (!exePath) {
  console.error('Usage: node scripts/set-exe-icon.js <exe-path> [ico-path]');
  process.exit(1);
}

if (!fs.existsSync(exePath)) {
  console.error(`Exe not found: ${exePath}`);
  process.exit(1);
}

if (!fs.existsSync(icoPath)) {
  console.error(`Icon not found: ${icoPath}`);
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));

const exeData = fs.readFileSync(exePath);
const exe = ResEdit.NtExecutable.from(exeData);
const res = ResEdit.NtExecutableResource.from(exe);

const iconData = fs.readFileSync(icoPath);
const iconFile = ResEdit.Data.IconFile.from(iconData);

ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
  res.entries, 1, 1033,
  iconFile.icons.map((icon) => icon.data),
);

const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
if (vi.length > 0) {
  const ver = vi[0];
  const parts = pkg.version.split('.').map(Number);
  const major = parts[0] || 0;
  const minor = parts[1] || 0;
  const patch = parts[2] || 0;
  ver.setFileVersion(major, minor, patch, 0);
  ver.setProductVersion(major, minor, patch, 0);
  ver.setStringValues({ lang: 1033, codepage: 1200 }, {
    ProductName: pkg.productName || pkg.name,
    FileDescription: pkg.description || '',
    FileVersion: pkg.version,
    ProductVersion: pkg.version,
    CompanyName: pkg.author?.name || pkg.author || '',
    LegalCopyright: `Copyright ${new Date().getFullYear()}`,
  });
  ver.outputToResourceEntries(res.entries);
}

res.outputResource(exe);
fs.writeFileSync(exePath, Buffer.from(exe.generate()));
console.log(`Updated icon and version info: ${exePath}`);
