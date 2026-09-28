import { execFile } from 'node:child_process';
import { validateSettings } from './settings.js';
import type { SettingsInput } from '../src/types.js';

// This fixed program emits only the gateway endpoint and its authentication fields.
// Config bodies, provider keys and channel credentials never cross the process boundary.
const READ_GATEWAY = String.raw`
import json, os, pathlib, re, shlex, subprocess
try:
    service_env = {}
    try:
        r = subprocess.run(['systemctl','--user','show','openclaw-gateway.service','-p','Environment','--value'],capture_output=True,text=True,timeout=5)
        for item in shlex.split(r.stdout):
            if '=' in item:
                k,v=item.split('=',1)
                service_env[k]=v
    except Exception:
        pass
    def env(name):
        return service_env.get(name) or os.environ.get(name)
    config_path = env('OPENCLAW_CONFIG_PATH')
    path = pathlib.Path(config_path).expanduser() if config_path else pathlib.Path.home()/'.openclaw'/'openclaw.json'
    config = json.loads(path.read_text(encoding='utf-8-sig'))
    gateway = config.get('gateway',{})
    auth = gateway.get('auth',{})
    def resolve(value):
        if isinstance(value,dict):
            if value.get('source') == 'env':
                return env(value.get('id',''))
            raise ValueError('SECRET_REFERENCE')
        if isinstance(value,str):
            match = re.fullmatch(r'\$\{([A-Za-z_][A-Za-z0-9_]*)\}',value)
            if match:
                result = env(match.group(1))
                if not result: raise ValueError('ENV_MISSING')
                return result
            return value
        return None
    mode = auth.get('mode','token')
    port = gateway.get('port',18789)
    if not isinstance(port,int) or not 1 <= port <= 65535: raise ValueError('PORT')
    output = {'url':'ws://127.0.0.1:'+str(port)+'/'}
    if mode == 'password':
        output['password'] = resolve(auth.get('password')) or env('OPENCLAW_GATEWAY_PASSWORD')
        if not output['password']: raise ValueError('PASSWORD_MISSING')
    elif mode == 'token':
        output['token'] = resolve(auth.get('token')) or env('OPENCLAW_GATEWAY_TOKEN')
        if not output['token']: raise ValueError('TOKEN_MISSING')
    elif mode != 'none':
        raise ValueError('AUTH_MODE')
    print(json.dumps(output))
except FileNotFoundError:
    print(json.dumps({'error':'找不到 WSL 中的 OpenClaw 配置，请检查发行版或手工填写凭据。'}))
except json.JSONDecodeError:
    print(json.dumps({'error':'当前配置使用扩展 JSON 格式，请先在设置中手工填写网关凭据。'}))
except Exception:
    print(json.dumps({'error':'无法解析网关认证配置，请在设置中手工填写有效凭据。'}))
`;

export async function readWslGateway(distro: string): Promise<SettingsInput> {
  validateSettings({url:'ws://127.0.0.1:18789',distro});
  return new Promise((resolve,reject) => {
    const child = execFile('wsl.exe', ['-d',distro,'--','python3','-'], {
      windowsHide:true, timeout:20000, maxBuffer:128*1024, encoding:'utf8',
    }, (error, stdout) => {
      if (error) { reject(new Error('无法读取 WSL 配置，请确认发行版已安装并能运行 Python 3。')); return; }
      try {
        const data = JSON.parse(stdout.trim());
        if (data.error) throw new Error(data.error);
        resolve(validateSettings({...data,distro}));
      } catch (failure) {
        reject(failure instanceof Error && !('code' in failure) && !(failure instanceof SyntaxError) ? failure : new Error('WSL 配置读取结果无效。'));
      }
    });
    child.stdin?.end(READ_GATEWAY);
    child.stdin?.on('error', () => { /* execFile callback owns process errors. */ });
  });
}
