import { readWslGateway } from '../electron/wsl.js';
try {
  const config = await readWslGateway('Ubuntu-24.04');
  console.log(JSON.stringify({url:config.url,distro:config.distro,hasToken:Boolean(config.token),hasPassword:Boolean(config.password)}));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'WSL probe failed');
  process.exitCode = 1;
}
