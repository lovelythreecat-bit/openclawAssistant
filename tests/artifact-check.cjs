const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');
const archive=path.resolve('release/win-unpacked/resources/app.asar');
for(const name of ['dist/index.html','dist-electron/electron/main.js','dist-electron/electron/gateway.js','dist-electron/electron/store.js','dist-electron/electron/models.js','dist-electron/electron/plugins.js','dist-electron/electron/skills.js','electron/preload.cjs','assets/concepts/mascot-welcome-v1.png']) {
  const packaged=asar.extractFile(archive,path.normalize(name));
  assert.equal(packaged.equals(fs.readFileSync(name)),true,`${name} must match final source build`);
}
const entries=asar.listPackage(archive);
assert.equal(entries.some(name=>/^[/\\](\.test-data|tests|docs)[/\\]/.test(name)),false,'development data must not be packaged');
console.log('Artifact contents verified: final entry points/artwork match; no project tests, profiles or docs bundled.');
