import { execFile } from 'node:child_process';
import { validateSettings } from './settings.js';
import type { PluginInfo, PluginList, MutationResult } from '../src/management-types.js';

export interface PluginExecution {file:string;args:string[];input:string;timeout:number;windowsHide:boolean;maxBuffer:number}
export type PluginExecutor = (execution:PluginExecution) => Promise<{stdout:string;stderr:string}>;

// Only this fixed program crosses the WSL boundary. All user input remains argv data.
const PLUGIN_PROGRAM = String.raw`
import json, os, pathlib, re, selectors, shlex, signal, subprocess, sys, time
SERVICE = 'openclaw-gateway.service'
LIMIT = 2 * 1024 * 1024
def run(args, env=None, cwd=None, timeout=15):
    child = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env, cwd=cwd, start_new_session=True)
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ)
    chunks, size, deadline = [], 0, time.monotonic() + timeout
    try:
        while selector.get_map():
            if time.monotonic() >= deadline: raise ValueError('TIMEOUT')
            for key, _ in selector.select(min(0.2, max(0, deadline-time.monotonic()))):
                data = os.read(key.fd, 65536)
                if not data:
                    selector.unregister(key.fileobj)
                    continue
                size += len(data)
                if size > LIMIT: raise ValueError('OUTPUT_LIMIT')
                chunks.append(data)
        code = child.wait(timeout=max(0.1,deadline-time.monotonic()))
        if code: raise ValueError('COMMAND_FAILED')
        return b''.join(chunks).decode('utf-8', errors='replace')
    finally:
        selector.close()
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
        child.stdout.close()
def bind(port):
    properties = run(['systemctl','--user','show',SERVICE,'-p','MainPID','-p','ExecStart'])
    values = dict(line.split('=',1) for line in properties.splitlines() if '=' in line)
    pid = int(values.get('MainPID','0'))
    if pid <= 1: raise ValueError('ENVIRONMENT_MISMATCH')
    proc = pathlib.Path('/proc')/str(pid)
    if proc.stat().st_uid != os.getuid(): raise ValueError('ENVIRONMENT_MISMATCH')
    executable = (proc/'exe').resolve(strict=True)
    if str(executable).startswith('/mnt/') or executable.name not in ('node','nodejs'): raise ValueError('ENVIRONMENT_MISMATCH')
    match = re.search(r'argv\[\]=(.*?)(?:\s;|;)', values.get('ExecStart',''))
    args = shlex.split(match.group(1)) if match else []
    if len(args) < 3 or pathlib.Path(args[0]).resolve() != executable or 'gateway' not in args: raise ValueError('ENVIRONMENT_MISMATCH')
    # Profile/config command-line overrides cannot safely be inferred from process environment.
    if any(arg in ('--dev','--profile','--config') or arg.startswith(('--profile=','--config=')) for arg in args[2:]): raise ValueError('ENVIRONMENT_MISMATCH')
    entry = pathlib.Path(args[1]).resolve(strict=True)
    if not entry.is_file() or str(entry).startswith('/mnt/'): raise ValueError('ENVIRONMENT_MISMATCH')
    root = next((parent for parent in entry.parents if (parent/'package.json').is_file()), None)
    if root is None or json.loads((root/'package.json').read_text()).get('name') != 'openclaw': raise ValueError('ENVIRONMENT_MISMATCH')
    if entry.relative_to(root).as_posix() not in ('openclaw.mjs','dist/index.js','dist/entry.js'): raise ValueError('ENVIRONMENT_MISMATCH')
    sockets = set()
    for fd in (proc/'fd').iterdir():
        try:
            link = os.readlink(fd)
            if link.startswith('socket:['): sockets.add(link[8:-1])
        except OSError: pass
    bound = False
    for table in ('tcp','tcp6'):
        for line in (proc/'net'/table).read_text().splitlines()[1:]:
            fields = line.split()
            if len(fields)>9 and fields[3]=='0A' and int(fields[1].split(':')[-1],16)==port and fields[9] in sockets: bound=True
    if not bound: raise ValueError('ENVIRONMENT_MISMATCH')
    env = dict(item.split('=',1) for item in (proc/'environ').read_bytes().decode().split('\0') if '=' in item)
    cwd = str((proc/'cwd').resolve(strict=True))
    return [str(executable),str(entry)],env,cwd
try:
    action, port = sys.argv[1],int(sys.argv[2])
    cli, env, cwd = bind(port)
    if action == 'list':
        output = run(cli+['plugins','list','--json'],env,cwd,45)
        for key,value in env.items():
            if len(value)>=4 and re.search(r'token|secret|password|api.?key',key,re.I): output=output.replace(value,'[已隐藏]')
        print(output)
    elif action == 'install':
        source = sys.argv[3]
        if re.match(r'^[A-Za-z]:[\\/]',source): source=run(['wslpath','-u',source]).strip()
        if source.startswith('/'):
            target=pathlib.Path(source).resolve(strict=True)
            if not target.is_dir() and not (target.is_file() and str(target).lower().endswith(('.zip','.tgz','.tar.gz','.tar'))): raise ValueError('INVALID_SOURCE')
            source=str(target)
        run(cli+['plugins','install',source],env,cwd,145)
        print(json.dumps({'ok':True}))
    elif action == 'restart':
        run(['systemctl','--user','restart',SERVICE],timeout=100)
        # Service start success is not yet RPC readiness; the desktop reconnects separately.
        print(json.dumps({'ok':True}))
    else: raise ValueError('INVALID_SOURCE')
except Exception as error:
    code = str(error) if str(error) in ('ENVIRONMENT_MISMATCH','INVALID_SOURCE','TIMEOUT','OUTPUT_LIMIT','COMMAND_FAILED') else 'ENVIRONMENT_MISMATCH'
    print(json.dumps({'error':code}))
`;

const execute:PluginExecutor = execution => new Promise((resolve,reject) => {
  const child = execFile(execution.file,execution.args,{
    windowsHide:execution.windowsHide,timeout:execution.timeout,maxBuffer:execution.maxBuffer,encoding:'utf8',
  },(error,stdout,stderr) => error ? reject(new Error('插件操作失败，请检查 WSL 环境或稍后重试。')) : resolve({stdout,stderr}));
  child.stdin?.on('error',() => undefined);
  child.stdin?.end(execution.input);
});

function validateSource(value:unknown):string {
  if (typeof value !== 'string' || !value.trim() || value.length>4096 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('插件来源无效。');
  const source=value.trim();
  if (/^[A-Za-z]:[\\/]/.test(source) || source.startsWith('/') && !source.startsWith('//')) return source;
  if (/^(?:(?:npm|clawhub):)?(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-zA-Z0-9][a-zA-Z0-9._+-]*)?$/.test(source)) return source;
  throw new Error('插件来源仅支持 npm/ClawHub 包名、Windows 或 WSL 绝对路径。');
}

function parseOutput(output:string):Record<string,unknown> {
  // CLI logs may surround a pretty-printed JSON object; scan balanced objects, respecting strings.
  for (let start=0;start<output.length;start++) {
    if(output[start]!=='{') continue;
    let depth=0,quoted=false,escape=false;
    for(let end=start;end<output.length;end++) {
      const char=output[end];
      if(quoted) { if(escape) escape=false; else if(char==='\\') escape=true; else if(char==='"') quoted=false; continue; }
      if(char==='"') quoted=true;
      else if(char==='{') depth++;
      else if(char==='}' && --depth===0) {
        try { const value=JSON.parse(output.slice(start,end+1)); if(value && ('plugins' in value || 'error' in value || 'ok' in value)) return value; } catch { /* keep searching */ }
        break;
      }
    }
  }
  throw new Error('插件列表或操作结果格式无效。');
}
const publicText=(value:unknown,max=500):string => typeof value==='string' ? value.replace(/[\x00-\x1f\x7f]/g,' ').slice(0,max) : '';
export function createPluginManager(getSettings:()=>{distro:string;url:string},executor:PluginExecutor=execute) {
  let busy=false;
  async function request(action:'list'|'install'|'restart',source?:string) {
    const settings=validateSettings(getSettings());
    const port=new URL(settings.url).port || (settings.url.startsWith('wss:')?'443':'80');
    let stdout:string;
    try { ({stdout}=await executor({file:'wsl.exe',args:['-d',settings.distro,'--','python3','-',action,port,...(source?[source]:[])],input:PLUGIN_PROGRAM,timeout:180000,windowsHide:true,maxBuffer:2*1024*1024})); }
    catch { throw new Error('插件操作失败，请检查 WSL 环境或稍后重试。'); }
    const result=parseOutput(stdout);
    if(result.error) {
      const messages:Record<string,string>={ENVIRONMENT_MISMATCH:'无法绑定当前网关的 WSL 服务、Linux 安装与端口；请确认发行版及 openclaw-gateway.service 正在运行。',INVALID_SOURCE:'插件来源不存在或不是支持的目录/归档。',TIMEOUT:'插件操作超时，请检查网关环境与网络。',OUTPUT_LIMIT:'插件输出超出限制，操作已停止。',COMMAND_FAILED:'插件操作失败；请在对应 WSL 环境检查插件依赖、安装来源或服务状态。'};
      throw new Error(messages[String(result.error)] || '插件操作失败。');
    }
    return {result,distro:settings.distro};
  }
  async function mutate(action:'install'|'restart',source?:string):Promise<MutationResult> {
    if(busy) throw new Error('插件安装或网关重启正在进行，请稍候。');
    busy=true;
    try {
      const {result}=await request(action,source);
      if(result.ok!==true) throw new Error('插件操作结果格式无效。');
      return {message:action==='install'?'插件已安装，重启网关后生效。':'网关服务已重启，正在重新连接。',restartRequired:action==='install'};
    } finally { busy=false; }
  }
  return {
    async listPlugins():Promise<PluginList> {
      const {result,distro}=await request('list');
      if(!Array.isArray(result.plugins) || result.plugins.some(item=>!item || typeof item!=='object' || typeof item.id!=='string' || !item.id.trim() || typeof item.enabled!=='boolean')) throw new Error('插件列表格式无效。');
      const plugins:PluginInfo[]=result.plugins.map(item=>({
        id:publicText(item.id),name:publicText(item.name)||publicText(item.id),description:publicText(item.description),
        status:publicText(item.status)||'unknown',enabled:item.enabled===true,
        ...(typeof item.version==='string'?{version:publicText(item.version)}:{}),
        ...(typeof item.origin==='string'?{source:publicText(item.origin)}:{}),
        ...(item.error?{error:'插件存在加载问题，请检查配置或依赖。'}:{}),
      }));
      const diagnostics=Array.isArray(result.diagnostics) && result.diagnostics.length ? [`检测到 ${result.diagnostics.length} 条插件诊断，请在对应 WSL 中检查插件配置或依赖。`] : [];
      return {plugins,diagnostics,environment:`WSL · ${distro} · 当前网关服务（安装记录）`};
    },
    async installPlugin(input:{source:string}):Promise<MutationResult> { return mutate('install',validateSource(input?.source)); },
    async restartGateway():Promise<MutationResult> { return mutate('restart'); },
  };
}
