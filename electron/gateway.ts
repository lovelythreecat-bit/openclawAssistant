import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { WebSocket, type RawData } from 'ws';

import type { ConnectionStatus, GatewayEvent } from '../src/types.js';
import { signDevice, type DeviceIdentity } from './identity.js';

export interface GatewayOptions {
  url: string;
  token?: string;
  password?: string;
  identity: DeviceIdentity;
  deviceToken?: string;
  management?: boolean;
}

interface PendingRequest {
  generation: number;
  timer: NodeJS.Timeout;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface ConnectAttempt {
  generation: number;
  settled: boolean;
  resolve(status: ConnectionStatus): void;
  reject(error: Error): void;
}

interface HelloOk {
  type: 'hello-ok';
  protocol: 3;
  server: { version: string };
  policy: {
    tickIntervalMs: number;
    maxPayload: number;
    maxBufferedBytes: number;
  };
  auth?: {
    deviceToken: string;
    scopes: string[];
  };
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_INBOUND_PAYLOAD = 25 * 1024 * 1024;
const CLIENT = {
  id: 'gateway-client',
  displayName: '库洛桌面',
  version: '0.1.0',
  platform: 'win32',
  mode: 'ui',
} as const;
const SCOPES = ['operator.read', 'operator.write'] as const;

function positiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function parseHello(value: unknown): HelloOk {
  if (!value || typeof value !== 'object') throw new Error('Gateway returned an invalid connect response');
  const hello = value as Record<string, any>;
  if (
    hello.type !== 'hello-ok'
    || hello.protocol !== 3
    || typeof hello.server?.version !== 'string'
    || !positiveNumber(hello.policy?.tickIntervalMs)
    || !positiveNumber(hello.policy?.maxPayload)
    || !positiveNumber(hello.policy?.maxBufferedBytes)
  ) {
    throw new Error('Gateway returned an invalid protocol-3 hello response');
  }
  return hello as HelloOk;
}

function rawDataLength(data: RawData): number {
  if (Array.isArray(data)) return data.reduce((total, part) => total + part.byteLength, 0);
  return data.byteLength;
}

function rawDataText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

export class GatewayClient extends EventEmitter {
  private readonly requestTimeoutMs: number;
  private generation = 0;
  private socket: WebSocket | null = null;
  private options: GatewayOptions | null = null;
  private pending = new Map<string, PendingRequest>();
  private attempt: ConnectAttempt | null = null;
  private challengeTimer: NodeJS.Timeout | null = null;
  private activityTimer: NodeJS.Timeout | null = null;
  private handshakeSent = false;
  private lastInboundAt = 0;
  private maxPayload = MAX_INBOUND_PAYLOAD;
  private maxBufferedBytes = MAX_INBOUND_PAYLOAD;
  private status: ConnectionStatus = { state: 'disconnected', endpoint: '' };

  constructor(requestTimeoutMs = DEFAULT_TIMEOUT_MS) {
    super();
    if (!positiveNumber(requestTimeoutMs)) throw new Error('Request timeout must be positive');
    this.requestTimeoutMs = requestTimeoutMs;
  }

  getStatus(): ConnectionStatus {
    return { ...this.status };
  }

  async connect(options: GatewayOptions): Promise<ConnectionStatus> {
    this.abortCurrent(new Error('Gateway connection replaced by reconnect'));

    const generation = ++this.generation;
    this.options = { ...options };
    this.handshakeSent = false;
    this.maxPayload = MAX_INBOUND_PAYLOAD;
    this.maxBufferedBytes = MAX_INBOUND_PAYLOAD;
    this.setStatus({ state: 'connecting', endpoint: options.url });

    return new Promise<ConnectionStatus>((resolve, reject) => {
      const attempt: ConnectAttempt = { generation, settled: false, resolve, reject };
      this.attempt = attempt;

      let socket: WebSocket;
      try {
        socket = new WebSocket(options.url, { maxPayload: MAX_INBOUND_PAYLOAD });
      } catch (error) {
        this.failConnect(generation, this.asError(error, 'Could not open gateway connection'));
        return;
      }
      this.socket = socket;
      this.lastInboundAt = Date.now();

      this.challengeTimer = setTimeout(() => {
        this.failConnect(generation, new Error('Gateway challenge timed out'));
      }, this.requestTimeoutMs);

      socket.on('message', (data) => this.onMessage(socket, generation, data));
      socket.on('close', (code, reason) => this.onClose(socket, generation, code, reason.toString()));
      socket.on('error', (error) => this.onSocketError(socket, generation, error));
    });
  }

  async request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.status.state !== 'connected') throw new Error('Gateway is not connected');
    return this.sendRequest<T>(method, params, false);
  }

  disconnect(): void {
    const error = new Error('Gateway disconnected');
    this.abortCurrent(error);
    ++this.generation;
    this.setStatus({
      state: 'disconnected',
      endpoint: this.options?.url ?? this.status.endpoint,
      message: 'Disconnected',
    });
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = { ...status };
    this.emit('status', this.getStatus());
  }

  private onMessage(socket: WebSocket, generation: number, data: RawData): void {
    if (!this.isCurrent(socket, generation)) return;
    this.lastInboundAt = Date.now();

    if (rawDataLength(data) > this.maxPayload) {
      this.failLiveConnection(new Error('Incoming payload exceeds the gateway payload limit'));
      return;
    }

    let frame: Record<string, any>;
    try {
      frame = JSON.parse(rawDataText(data));
    } catch {
      return;
    }

    if (frame.type === 'event') {
      if (frame.event === 'connect.challenge') {
        const nonce = frame.payload?.nonce;
        if (this.status.state !== 'connecting' || this.handshakeSent || typeof nonce !== 'string' || !nonce) return;
        this.handshakeSent = true;
        this.clearChallengeTimer();
        void this.sendHandshake(generation, nonce);
        return;
      }

      if (typeof frame.event !== 'string') return;
      const event: GatewayEvent = {
        event: frame.event,
        payload: frame.payload,
        ...(typeof frame.seq === 'number' ? { seq: frame.seq } : {}),
      };
      this.emit('event', event);
      return;
    }

    if (frame.type !== 'res' || typeof frame.id !== 'string') return;
    const pending = this.pending.get(frame.id);
    if (!pending || pending.generation !== generation) return;
    clearTimeout(pending.timer);
    this.pending.delete(frame.id);
    if (frame.ok === true) {
      pending.resolve(frame.payload);
    } else {
      pending.reject(this.gatewayError(frame.error));
    }
  }

  private async sendHandshake(generation: number, nonce: string): Promise<void> {
    const options = this.options;
    if (!options || generation !== this.generation) return;
    const authToken = options.token ?? options.deviceToken;
    const auth = authToken !== undefined
      ? { token: authToken }
      : options.password !== undefined
        ? { password: options.password }
        : undefined;
    const signedAt = Date.now();
    const scopes = options.management ? [...SCOPES, 'operator.admin'] : [...SCOPES];
    const params = {
      minProtocol: 3,
      maxProtocol: 3,
      client: CLIENT,
      role: 'operator',
      scopes,
      caps: ['tool-events'],
      ...(auth ? { auth } : {}),
      device: signDevice(options.identity, nonce, authToken, signedAt, scopes),
      locale: 'zh-CN',
      userAgent: 'kuro-desktop/0.1.0',
    };

    try {
      const rawHello = await this.sendRequest<unknown>('connect', params, true);
      if (generation !== this.generation) return;
      const hello = parseHello(rawHello);
      this.maxPayload = Math.min(hello.policy.maxPayload, MAX_INBOUND_PAYLOAD);
      this.maxBufferedBytes = Math.min(hello.policy.maxBufferedBytes, MAX_INBOUND_PAYLOAD);
      this.lastInboundAt = Date.now();
      this.startActivityWatch(generation, hello.policy.tickIntervalMs);

      if (hello.auth?.deviceToken) {
        this.emit('deviceToken', {
          token: hello.auth.deviceToken,
          scopes: Array.isArray(hello.auth.scopes) ? [...hello.auth.scopes] : [],
        });
      }

      const status: ConnectionStatus = {
        state: 'connected',
        endpoint: options.url,
        version: hello.server.version,
        connectedAt: Date.now(),
      };
      this.setStatus(status);
      this.finishAttempt(generation, status);
    } catch (error) {
      this.failConnect(generation, this.asError(error, 'Gateway connect failed'));
    }
  }

  private sendRequest<T>(method: string, params: unknown, connecting: boolean): Promise<T> {
    const socket = this.socket;
    const generation = this.generation;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Gateway is not connected'));
    }
    if (!connecting && this.status.state !== 'connected') {
      return Promise.reject(new Error('Gateway is not connected'));
    }

    const id = randomUUID();
    const serialized = JSON.stringify({ type: 'req', id, method, params });
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes > this.maxPayload) {
      return Promise.reject(new Error(`Outgoing payload exceeds gateway payload limit (${this.maxPayload} bytes)`));
    }
    if (socket.bufferedAmount + bytes > this.maxBufferedBytes) {
      return Promise.reject(new Error(`Outgoing payload exceeds gateway backpressure limit (${this.maxBufferedBytes} bytes)`));
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending || pending.generation !== generation) return;
        this.pending.delete(id);
        reject(new Error(`Gateway request ${method} timed out`));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        generation,
        timer,
        resolve: (value) => resolve(value as T),
        reject,
      });

      try {
        socket.send(serialized, (error) => {
          if (!error) return;
          const pending = this.pending.get(id);
          if (!pending || pending.generation !== generation) return;
          clearTimeout(pending.timer);
          this.pending.delete(id);
          reject(this.asError(error, `Could not send gateway request ${method}`));
        });
      } catch (error) {
        const pending = this.pending.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(id);
        }
        reject(this.asError(error, `Could not send gateway request ${method}`));
      }
    });
  }

  private startActivityWatch(generation: number, tickIntervalMs: number): void {
    this.clearActivityTimer();
    const checkEveryMs = Math.max(10, tickIntervalMs);
    this.activityTimer = setInterval(() => {
      if (generation !== this.generation || this.status.state !== 'connected') return;
      if (Date.now() - this.lastInboundAt < tickIntervalMs * 2) return;
      const error = new Error('Gateway became silent beyond two tick intervals');
      this.clearActivityTimer();
      this.rejectPending(error, generation);
      const socket = this.socket;
      if (socket) this.releaseSocket(socket, 4000, 'gateway silent');
      this.setStatus({
        state: 'disconnected',
        endpoint: this.options?.url ?? this.status.endpoint,
        message: error.message,
      });
    }, checkEveryMs);
  }

  private onClose(socket: WebSocket, generation: number, code: number, reason: string): void {
    if (!this.isCurrent(socket, generation)) return;
    this.socket = null;
    this.clearConnectionTimers();
    const safeReason = this.redact(reason);
    const suffix = safeReason ? `: ${safeReason}` : '';
    const error = new Error(`Gateway closed (${code})${suffix}`);
    this.rejectPending(error, generation);
    if (this.status.state === 'connecting') {
      this.failConnect(generation, error);
      return;
    }
    this.setStatus({
      state: 'disconnected',
      endpoint: this.options?.url ?? this.status.endpoint,
      message: error.message,
    });
  }

  private onSocketError(socket: WebSocket, generation: number, error: Error): void {
    if (!this.isCurrent(socket, generation)) return;
    const safe = this.asError(error, 'Gateway socket error');
    if (this.status.state === 'connecting') {
      this.failConnect(generation, safe);
    } else {
      this.failLiveConnection(safe);
    }
  }

  private failLiveConnection(error: Error): void {
    const generation = this.generation;
    this.rejectPending(error, generation);
    const socket = this.socket;
    if (socket) this.releaseSocket(socket, 1008, 'gateway connection error');
    this.setStatus({
      state: 'error',
      endpoint: this.options?.url ?? this.status.endpoint,
      message: this.redact(error.message),
    });
  }

  private finishAttempt(generation: number, status: ConnectionStatus): void {
    const attempt = this.attempt;
    if (!attempt || attempt.generation !== generation || attempt.settled) return;
    attempt.settled = true;
    this.attempt = null;
    attempt.resolve({ ...status });
  }

  private failConnect(generation: number, error: Error): void {
    const attempt = this.attempt;
    if (!attempt || attempt.generation !== generation || attempt.settled) return;
    const safeError = new Error(this.redact(error.message));
    attempt.settled = true;
    this.attempt = null;
    this.rejectPending(safeError, generation);
    const socket = this.socket;
    if (socket) this.releaseSocket(socket, 1008, 'connect failed');
    this.clearConnectionTimers();
    this.setStatus({
      state: 'error',
      endpoint: this.options?.url ?? this.status.endpoint,
      message: safeError.message,
    });
    attempt.reject(safeError);
  }

  private abortCurrent(error: Error): void {
    const attempt = this.attempt;
    if (attempt && !attempt.settled) {
      attempt.settled = true;
      attempt.reject(error);
    }
    this.attempt = null;
    this.rejectPending(error);
    const socket = this.socket;
    if (socket) this.releaseSocket(socket, 1000, 'disconnect');
    this.clearConnectionTimers();
  }

  private releaseSocket(socket: WebSocket, code: number, reason: string): void {
    if (this.socket === socket) this.socket = null;
    socket.removeAllListeners();
    socket.on('error', () => undefined);
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(code, reason);
    }
  }

  private rejectPending(error: Error, generation?: number): void {
    for (const [id, pending] of this.pending) {
      if (generation !== undefined && pending.generation !== generation) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private gatewayError(raw: unknown): Error {
    const error = raw && typeof raw === 'object' ? raw as Record<string, any> : {};
    const code = typeof error.code === 'string' ? error.code : 'GATEWAY_ERROR';
    const message = typeof error.message === 'string' ? error.message : 'Gateway request failed';
    const requestId = typeof error.details?.requestId === 'string' ? error.details.requestId : undefined;
    const pairing = /pair/i.test(code) || /pair/i.test(message) || Boolean(requestId);
    const action = pairing && requestId
      ? ` Approve pairing request ${requestId} in OpenClaw, then reconnect.`
      : '';
    return new Error(this.redact(`[${code}] ${message}${action}`));
  }

  private asError(error: unknown, fallback: string): Error {
    const message = error instanceof Error ? error.message : String(error || fallback);
    return new Error(this.redact(message || fallback));
  }

  private redact(value: string): string {
    let result = value;
    const secrets = [this.options?.token, this.options?.deviceToken, this.options?.password]
      .filter((secret): secret is string => typeof secret === 'string' && secret.length > 0)
      .sort((a, b) => b.length - a.length);
    for (const secret of secrets) result = result.split(secret).join('[REDACTED]');
    return result;
  }

  private isCurrent(socket: WebSocket, generation: number): boolean {
    return generation === this.generation && socket === this.socket;
  }

  private clearChallengeTimer(): void {
    if (this.challengeTimer) clearTimeout(this.challengeTimer);
    this.challengeTimer = null;
  }

  private clearActivityTimer(): void {
    if (this.activityTimer) clearInterval(this.activityTimer);
    this.activityTimer = null;
  }

  private clearConnectionTimers(): void {
    this.clearChallengeTimer();
    this.clearActivityTimer();
  }
}
