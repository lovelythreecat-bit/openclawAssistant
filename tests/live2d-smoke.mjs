import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const packaged = process.argv.includes('--packaged');
const noWebGL = process.argv.includes('--no-webgl');
const artifacts = resolve('.test-data/live2d');
await mkdir(artifacts, { recursive: true });
const env = { ...process.env, KURO_USER_DATA: resolve('.test-data', `live2d-${Date.now()}`), KURO_SKIP_AUTO_CONNECT: '1' };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({
    executablePath: packaged ? resolve('release/win-unpacked/Kuro.exe') : require('electron'),
    args: [...(packaged ? [] : [resolve('.')]), ...(noWebGL ? ['--disable-webgl'] : [])], env,
  });
  const page = await app.firstWindow({ timeout: 20000 });
  page.setDefaultTimeout(20000);
  const errors = [];
  const remoteRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) remoteRequests.push(request.url()); });
  if (noWebGL) {
    // Electron may fall back to software WebGL despite GPU flags. Simulate the
    // actual unavailable API so this exercises the renderer's failure path.
    await page.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...args) {
        if (String(type).includes('webgl')) return null;
        return getContext.call(this, type, ...args);
      };
    });
    await page.reload();
  }
  await page.waitForSelector('.app-shell');
  await page.waitForSelector(`[data-live2d-state="${noWebGL ? 'error' : 'ready'}"]`, { timeout: 20000 });
  if (noWebGL) {
    assert.equal(await page.getByRole('button', { name: '重试加载角色' }).count(), 1);
    assert.equal(await page.getByRole('textbox', { name: '发送给库洛的消息' }).isVisible(), true);
    await page.getByRole('button', { name: '收起角色' }).click();
    assert.equal(await page.locator('.live2d-stage').count(), 0);
  } else {
    const canvas = page.locator('.live2d-stage canvas');
    const first = await canvas.screenshot();
    await page.mouse.move(50, 100);
    await page.waitForTimeout(450);
    const second = await canvas.screenshot();
    assert.equal(first.equals(second), false, 'the actual model canvas must animate');
    await page.getByRole('button', { name: '和 Shizuku 打招呼' }).click();
    await page.waitForSelector('[data-live2d-motion="Tap"]');
    await page.waitForSelector('[data-live2d-motion="Idle"]', { timeout: 6000 });
    const stage = await page.locator('.live2d-stage').boundingBox();
    const x = stage.x + stage.width / 2;
    const y = stage.y + stage.height / 2;
    for (const [dx, dy, motion] of [[0, -60, 'FlickUp'], [65, 0, 'Flick3']]) {
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + dx, y + dy, { steps: 5 });
      await page.mouse.up();
      await page.waitForSelector(`[data-live2d-motion="${motion}"]`);
      await page.waitForSelector('[data-live2d-motion="Idle"]', { timeout: 6000 });
    }
    await page.evaluate(() => {
      const canvas = document.querySelector('.live2d-stage canvas');
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      const draw = gl.drawElements.bind(gl);
      window.live2dDrawCalls = 0;
      gl.drawElements = (...args) => { window.live2dDrawCalls++; return draw(...args); };
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
    assert.equal(await page.getByRole('button', { name: '和 Shizuku 打招呼' }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '和 Shizuku 打招呼' }).getAttribute('title'), '已按系统设置减少动态效果');
    const draws = await page.evaluate(() => window.live2dDrawCalls);
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => window.live2dDrawCalls), draws, 'reduced motion must stop draw calls');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.screenshot({ path: resolve(artifacts, packaged ? 'packaged.png' : 'desktop.png') });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 680));
    await page.waitForFunction(() => innerWidth <= 960);
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await page.getByRole('button', { name: '发送消息', exact: true }).evaluate(el => el.getBoundingClientRect().bottom <= innerHeight), true);
    await page.screenshot({ path: resolve(artifacts, 'compact.png') });
    await page.getByRole('textbox', { name: '发送给库洛的消息' }).fill('保留这个草稿');
    await page.getByRole('button', { name: '收起角色' }).click();
    assert.equal(await page.locator('.live2d-stage canvas').count(), 0);
    assert.equal(await page.getByRole('textbox', { name: '发送给库洛的消息' }).inputValue(), '保留这个草稿');
    await page.screenshot({ path: resolve(artifacts, 'static-character.png') });
    await page.reload();
    await page.getByRole('button', { name: '展开角色' }).waitFor();
    assert.equal(await page.locator('.live2d-stage canvas').count(), 0);
    for (let i = 0; i < 2; i++) {
      await page.getByRole('button', { name: '展开角色' }).click();
      await page.waitForSelector('[data-live2d-state="ready"]');
      assert.equal(await page.locator('.live2d-stage canvas').count(), 1);
      await page.getByRole('button', { name: '收起角色' }).click();
    }
    await page.getByRole('button', { name: '展开角色' }).click();
    await page.waitForSelector('[data-live2d-state="ready"]');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    assert.equal(await page.locator('.live2d-stage canvas').count(), 0);
    await page.getByRole('button', { name: '聊天', exact: true }).click();
    await page.waitForSelector('[data-live2d-state="ready"]');
  }
  assert.deepEqual(errors, [], 'no uncaught renderer errors');
  assert.deepEqual(remoteRequests, [], 'model and runtime must load offline');
  console.log(`Live2D ${noWebGL ? 'WebGL fallback' : packaged ? 'packaged' : 'desktop'} smoke passed`);
} finally { await app?.close(); }
