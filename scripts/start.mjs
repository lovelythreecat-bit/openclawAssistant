import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const run = (command,args,options={}) => new Promise((resolve,reject) => {
  const child = spawn(command,args,{cwd:root,stdio:'inherit',windowsHide:true,...options});
  child.once('error',reject);
  child.once('exit',code => code === 0 ? resolve() : reject(new Error(`Process exited ${code}`)));
});
try {
  await run(process.execPath,['node_modules/typescript/bin/tsc','--noEmit','-p','tsconfig.json']);
  await run(process.execPath,['node_modules/typescript/bin/tsc','-p','tsconfig.electron.json']);
  await run(process.execPath,['node_modules/vite/bin/vite.js','build']);
  const environment = {...process.env};
  delete environment.ELECTRON_RUN_AS_NODE;
  await run(require('electron'),['.'],{env:environment});
} catch(error) {
  console.error('库洛启动失败：',error.message);
  process.exitCode=1;
}
