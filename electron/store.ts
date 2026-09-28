import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { DeviceIdentity } from './identity.js';
import type { PublicSettings, SettingsInput } from '../src/types.js';
import { validateSettings } from './settings.js';

export interface SecretCodec {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
interface Stored {
  version: 1;
  configured: boolean;
  url: string;
  distro: string;
  token?: string;
  password?: string;
  credentialSource: PublicSettings['credentialSource'];
  identity: DeviceIdentity;
  deviceToken?: string;
  deviceScopes?: string[];
}

export class SettingsStore {
  private value: Stored;
  private readonly file: string;
  constructor(directory: string, private codec: SecretCodec, createIdentity: () => DeviceIdentity) {
    mkdirSync(directory, {recursive:true});
    this.file = join(directory, 'connection.sealed');
    if (!codec.isEncryptionAvailable()) throw new Error('系统凭据加密暂不可用，请在正常的 Windows 用户会话中启动库洛。');
    if (existsSync(this.file)) {
      try {
        const parsed = JSON.parse(codec.decryptString(readFileSync(this.file))) as Stored;
        validateSettings(parsed);
        if (parsed.version !== 1 || !parsed.identity?.privateKeyPem || !parsed.identity?.publicKeyPem || !parsed.identity?.deviceId) throw new Error();
        this.value = { ...parsed, configured: parsed.configured ?? (parsed.credentialSource !== 'none' || parsed.url !== 'ws://127.0.0.1:18789/' || parsed.distro !== 'Ubuntu-24.04') };
      } catch { throw new Error('无法读取本机加密连接配置。请使用保存配置时的 Windows 账户启动应用。'); }
    } else {
      this.value = {version:1,configured:false,url:'ws://127.0.0.1:18789/',distro:'Ubuntu-24.04',credentialSource:'none',identity:createIdentity()};
      this.persist();
    }
  }
  needsInitialDiscovery(): boolean { return !this.value.configured; }
  getPublicSettings(): PublicSettings {
    const {url,distro,credentialSource} = this.value;
    return {url,distro,credentialSource,hasCredential:Boolean(this.value.token || this.value.password || this.value.deviceToken)};
  }
  getConnection() {
    const {url,token,password,identity,deviceToken} = this.value;
    return {url,token,password,identity,deviceToken};
  }
  save(input: SettingsInput): PublicSettings {
    const normalized = validateSettings(input);
    const changedEndpoint = normalized.url !== this.value.url || normalized.distro !== this.value.distro;
    if (changedEndpoint) {
      this.value.token = undefined;
      this.value.password = undefined;
      this.value.deviceToken = undefined;
      this.value.deviceScopes = undefined;
      this.value.credentialSource = 'none';
    }
    this.value.url = normalized.url;
    this.value.distro = normalized.distro;
    this.value.configured = true;
    if (normalized.token || normalized.password) {
      this.value.token = normalized.token || undefined;
      this.value.password = normalized.password || undefined;
      this.value.deviceToken = undefined;
      this.value.deviceScopes = undefined;
      this.value.credentialSource = 'manual';
    }
    this.persist();
    return this.getPublicSettings();
  }
  importWsl(input: SettingsInput): PublicSettings {
    this.save(input);
    this.value.token = input.token || undefined;
    this.value.password = input.password || undefined;
    this.value.deviceToken = undefined;
    this.value.deviceScopes = undefined;
    this.value.credentialSource = 'wsl';
    this.persist();
    return this.getPublicSettings();
  }
  saveDeviceToken(token: string, scopes: string[]) {
    this.value.deviceToken = token;
    this.value.deviceScopes = scopes;
    this.persist();
  }
  private persist() {
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, this.codec.encryptString(JSON.stringify(this.value)), {mode:0o600});
    renameSync(temporary, this.file);
  }
}
