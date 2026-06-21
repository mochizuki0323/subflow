#!/usr/bin/env node
// electron-builder afterPack hook: set exe icon and version info on Windows builds
// without requiring Wine/rcedit.
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const exeName = context.packager.appInfo.productFilename + '.exe';
  const exePath = path.join(context.appOutDir, exeName);

  if (!fs.existsSync(exePath)) {
    console.warn(`afterPack: exe not found at ${exePath}`);
    return;
  }

  const icoPath = path.join(__dirname, '..', 'resources', 'icon.ico');
  if (!fs.existsSync(icoPath)) {
    console.warn(`afterPack: icon not found at ${icoPath}`);
    return;
  }

  const ResEdit = require('resedit');
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

  // Derive company name from package.json author ("Name <email>" → "Name");
  // without this CompanyName/LegalCopyright keep Electron's default ("GitHub, Inc.").
  const companyName = (typeof pkg.author === 'string'
    ? pkg.author.replace(/\s*<[^>]*>\s*$/, '').trim()
    : (pkg.author && pkg.author.name) || '') || pkg.productName || pkg.name;

  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  if (vi.length > 0) {
    const ver = vi[0];
    const parts = pkg.version.split('.').map(Number);
    ver.setFileVersion(parts[0] || 0, parts[1] || 0, parts[2] || 0, 0);
    ver.setProductVersion(parts[0] || 0, parts[1] || 0, parts[2] || 0, 0);
    ver.setStringValues({ lang: 1033, codepage: 1200 }, {
      CompanyName: companyName,
      ProductName: pkg.productName || pkg.name,
      FileDescription: pkg.description || '',
      FileVersion: pkg.version,
      ProductVersion: pkg.version,
      LegalCopyright: `Copyright © ${companyName}`,
    });
    ver.outputToResourceEntries(res.entries);
  }

  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  console.log(`afterPack: set icon and version info on ${exeName}`);
};
