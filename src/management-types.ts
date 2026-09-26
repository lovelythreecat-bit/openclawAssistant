export interface SkillInfo {
  name: string;
  description: string;
  source: string;
  eligible: boolean;
  disabled: boolean;
  missing: string[];
  homepage?: string;
}
export interface ModelOption { id: string; name: string; provider: string }
export interface ProviderModel { id: string; name: string }
export interface ModelProvider {
  id: string;
  baseUrl: string;
  api: string;
  hasApiKey: boolean;
  models: ProviderModel[];
}
export interface ModelSettings { hash: string; defaultModel: string; providers: ModelProvider[] }
export interface SaveModelSettingsInput {
  hash: string;
  defaultModel?: string;
  provider?: { id: string; baseUrl: string; api: string; apiKey?: string; models: ProviderModel[] };
}
export interface PluginInfo {
  id: string;
  name: string;
  description: string;
  version?: string;
  status: string;
  enabled: boolean;
  source?: string;
  error?: string;
}
export interface PluginList { plugins: PluginInfo[]; diagnostics: string[]; environment: string }
export interface MutationResult { message: string; restartRequired: boolean }
