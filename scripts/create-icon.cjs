const { app, nativeImage } = require('electron');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const source = path.join(projectRoot, 'assets', 'concepts', 'shizuku-icon.png');
const destination = path.join(projectRoot, 'assets', 'concepts', 'kuro.ico');

function pngToIco(png) {
  const headerSize = 6;
  const entrySize = 16;
  const dataOffset = headerSize + entrySize;
  const ico = Buffer.alloc(dataOffset + png.length);

  ico.writeUInt16LE(0, 0); // Reserved.
  ico.writeUInt16LE(1, 2); // ICO image type.
  ico.writeUInt16LE(1, 4); // One image.
  ico.writeUInt8(0, 6); // 0 means 256 pixels.
  ico.writeUInt8(0, 7);
  ico.writeUInt8(0, 8); // No indexed color palette.
  ico.writeUInt8(0, 9);
  ico.writeUInt16LE(1, 10); // Color planes.
  ico.writeUInt16LE(32, 12); // Bits per pixel.
  ico.writeUInt32LE(png.length, 14);
  ico.writeUInt32LE(dataOffset, 18);
  png.copy(ico, dataOffset);
  return ico;
}

app.whenReady().then(() => {
  const original = nativeImage.createFromPath(source);
  if (original.isEmpty()) throw new Error(`Could not read packaging icon source: ${source}`);
  const resized = original.resize({ width: 256, height: 256, quality: 'best' });
  const png = resized.toPNG();
  if (png.length === 0) throw new Error('Electron produced an empty packaging icon');

  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, pngToIco(png));
  console.log(`Created ${path.relative(projectRoot, destination)} from 256x256 PNG data`);
  app.quit();
}).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  app.exit(1);
});
