import type { SkillInfo, ModelOption, ModelSettings, SaveModelSettingsInput, PluginList, MutationResult } from './management-types.js';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';
export interface ConnectionStatus {
  state: ConnectionState;
  endpoint: string;
  message?: string;
  version?: string;
  connectedAt?: number;
}
export interface PublicSettings {
  url: string;
  distro: string;
  hasCredential: boolean;
  credentialSource: 'wsl' | 'manual' | 'none';
}
export interface SettingsInput { url: string; distro: string; token?: string; password?: string }
export interface Session {
  key: string;
  sessionId?: string;
  displayName?: string;
  derivedTitle?: string;
  label?: string;
  updatedAt?: number;
  lastMessagePreview?: string;
  model?: string;
  modelProvider?: string;
  totalTokens?: number;
}
export interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  arguments?: unknown;
  content?: unknown;
}
export interface ChatMessage {
  role: string;
  content: string | ContentBlock[];
  timestamp?: number;
  id?: string;
  toolName?: string;
  stopReason?: string;
}
export interface HistoryResult { sessionKey?: string; messages: ChatMessage[]; thinkingLevel?: string }
export interface GatewayEvent { event: string; payload: unknown; seq?: number }
export interface ChatEvent {
  sessionKey: string;
  runId: string;
  seq: number;
  state: 'delta' | 'final' | 'aborted' | 'error';
  message?: ChatMessage;
  errorMessage?: string;
}
export interface DesktopBridge {
  listSkills(): Promise<SkillInfo[]>;
  listModels(): Promise<ModelOption[]>;
  getModelSettings(): Promise<ModelSettings>;
  saveModelSettings(input: SaveModelSettingsInput): Promise<MutationResult>;
  switchSessionModel(input: {sessionKey: string; model: string | null}): Promise<void>;
  listPlugins(): Promise<PluginList>;
  installPlugin(input: {source: string}): Promise<MutationResult>;
  choosePluginSource(): Promise<string | null>;
  restartPluginGateway(): Promise<MutationResult>;
  getSettings(): Promise<PublicSettings>;
  saveSettings(input: SettingsInput): Promise<PublicSettings>;
  importWsl(distro: string): Promise<PublicSettings>;
  getStatus(): Promise<ConnectionStatus>;
  connect(): Promise<ConnectionStatus>;
  disconnect(): Promise<void>;
  listSessions(): Promise<Session[]>;
  history(sessionKey: string): Promise<HistoryResult>;
  send(input: { sessionKey: string; message: string; idempotencyKey: string }): Promise<{runId: string; status?: string}>;
  abort(input: { sessionKey: string; runId?: string }): Promise<unknown>;
  openExternal(url: string): Promise<void>;
  onStatus(listener: (status: ConnectionStatus) => void): () => void;
  onEvent(listener: (event: GatewayEvent) => void): () => void;
}
declare global { interface Window { kuro: DesktopBridge } }
