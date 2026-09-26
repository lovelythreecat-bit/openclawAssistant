import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';

let server: ViteDevServer;
let browser: Browser;
let base: string;
before(async () => {
  server = await createServer({ logLevel: 'silent', server: { host: '127.0.0.1', port: 5191, strictPort: false } });
  await server.listen();
  base = server.resolvedUrls!.local[0];
  browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

test('pointer movement drives the actual legacy eye parameter', async () => {
  const page = await browser.newPage({ bypassCSP: true, viewport: { width: 1320, height: 860 } });
  await page.addInitScript('globalThis.__name = value => value');
  await page.goto(base);
  await page.waitForSelector('[data-live2d-state="ready"]');
  await page.evaluate(() => {
    const prototype = (window as any).Live2DCubismCore.Model.prototype;
    const original = prototype.update;
    prototype.update = function () {
      const index = this.parameters.ids.indexOf('PARAM_EYE_BALL_X');
      (window as any).latestEyeX = this.parameters.values[index];
      return original.call(this);
    };
  });
  await page.mouse.move(5, 400);
  await page.waitForTimeout(700);
  const left = await page.evaluate(() => (window as any).latestEyeX);
  await page.mouse.move(1310, 400);
  await page.waitForTimeout(700);
  const right = await page.evaluate(() => (window as any).latestEyeX);
  assert.ok(right - left > 0.4, `eye parameter should follow pointer: ${left} → ${right}`);
  await page.close();
});

test('reduced motion still shows the character after resizing', async () => {
  const page = await browser.newPage({ bypassCSP: true, viewport: { width: 1320, height: 860 }, reducedMotion: 'reduce' });
  await page.addInitScript('globalThis.__name = value => value');
  await page.goto(base);
  await page.waitForSelector('[data-live2d-state="ready"]');
  await page.setViewportSize({ width: 960, height: 680 });
  await page.waitForTimeout(200);
  const screenshot = await page.locator('.live2d-stage').screenshot();
  const colored = await page.evaluate(async data => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] > pixels[i + 1] * 1.25 && pixels[i + 1] > pixels[i + 2] * 1.05 && pixels[i + 1] < 160) count++;
    }
    return count;
  }, screenshot.toString('base64'));
  assert.ok(colored > 500, `expected the character's brown hair, found ${colored} pixels`);
  await page.close();
});

test('a failed texture can be retried and closing a pending model does not break its replacement', async () => {
  const page = await browser.newPage({ bypassCSP: true, viewport: { width: 1320, height: 860 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript('globalThis.__name = value => value');
  await page.route('**/texture_02.png', route => route.abort());
  await page.goto(base);
  await page.waitForSelector('[data-live2d-state="error"]');
  await page.unroute('**/texture_02.png');
  await page.getByRole('button', { name: '重试加载角色' }).click();
  await page.waitForSelector('[data-live2d-state="ready"]', { timeout: 10000 });
  await page.getByRole('button', { name: '收起角色' }).click();
  await page.route('**/shizuku.moc3', async route => { await new Promise(resolve => setTimeout(resolve, 500)); await route.continue(); });
  await page.getByRole('button', { name: '展开角色' }).click();
  await page.waitForRequest('**/shizuku.moc3');
  await page.getByRole('button', { name: '收起角色' }).click();
  await page.getByRole('button', { name: '展开角色' }).click();
  await page.waitForSelector('[data-live2d-state="ready"]', { timeout: 10000 });
  assert.equal(await page.locator('.live2d-stage canvas').count(), 1);
  assert.deepEqual(errors, []);
  await page.close();
});

test('a runtime model exception shows retry and can recover without uncaught renderer errors', async () => {
  const page = await browser.newPage({ bypassCSP: true });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript('globalThis.__name = value => value');
  await page.goto(base);
  await page.waitForSelector('[data-live2d-state="ready"]');
  await page.evaluate(() => {
    const prototype = (window as any).Live2DCubismCore.Model.prototype;
    const original = prototype.update;
    prototype.update = function () {
      prototype.update = original;
      throw new Error('injected model update failure');
    };
  });
  await page.waitForSelector('[data-live2d-state="error"]', { timeout: 5000 });
  await page.getByRole('button', { name: '重试加载角色' }).click();
  await page.waitForSelector('[data-live2d-state="ready"]');
  assert.deepEqual(errors, []);
  await page.close();
});
