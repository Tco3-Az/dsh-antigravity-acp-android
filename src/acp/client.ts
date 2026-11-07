import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LlmError } from '@deepseek-ai/dsh-llm';
import {
  methods,
  type ClientConnection,
  type InitializeResponse,
  type NewSessionResponse,
  type SessionNotification,
  type McpServer,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';
import type { Config } from '../config.js';
import { connectTransport } from './transport.js';
import { disposeProcess, resolveCommand, serverArgs } from './process.js';
import { aborted, classify } from './errors.js';
import { modelOption } from '../models.js';
import { AndroidOAuthManager } from '../android-oauth.js';
import { prepareRunnerEnv } from '../acp-runner.js';

/** One process per adapter, serialized by the adapter. Native Android PRoot support. */
export class AcpClient {
  private connection?: ClientConnection;
  private child?: SubprocessHandle;
  private cwd?: string;
  private stopping?: Promise<void>;
  private sessionCount = 0;
  private unusedSession?: NewSessionResponse;
  private disposed = false;
  initializeResult?: InitializeResponse;
  processStarts = 0;
  authentications = 0;
  readonly oauthManager = new AndroidOAuthManager();
  onUpdate?: (event: SessionNotification) => void;
  onPermission?: (request: RequestPermissionRequest) => void | RequestPermissionResponse;

  constructor(
    readonly config: Config,
    readonly runtime: SubprocessRuntime,
    private notify: (message: string) => void = () => {},
  ) {}

  get connected(): boolean {
    return !!this.connection && !this.connection.signal.aborted;
  }

  private async bounded<T>(
    operation: Promise<T>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const interruption = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new LlmError(
              'Official ACP operation timed out. The process will be reset; retry to reconnect.',
              'ACP_TIMEOUT',
            ),
          ),
        timeoutMs,
      );
      onAbort = () => reject(aborted());
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
    try {
      return await Promise.race([operation, interruption]);
    } catch (error) {
      throw classify(error);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.disposed) throw new LlmError('ACP client has been disposed.', 'ACP_DISPOSED');
    if (signal?.aborted) throw aborted();
    if (this.stopping) await this.stopping;
    if (this.connected) return;
    if (this.child) await this.reset();
    try {
      const command = await resolveCommand(this.config, this.runtime, signal, this.notify);
      const cwd = this.cwd ?? (await mkdtemp(join(tmpdir(), 'dsh-antigravity-acp-')));
      if (this.disposed || signal?.aborted) {
        if (!this.cwd) await rm(cwd, { recursive: true, force: true });
        throw aborted();
      }
      this.cwd = cwd;

      // Spawn with PRoot environment isolation and shims
      const env = prepareRunnerEnv(process.env);
      this.child = this.runtime.spawn({
        argv: [command, ...serverArgs(this.config, command)],
        cwd: this.cwd,
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
        graceMs: this.config.disposeGraceMs,
        env: env as Record<string, string>,
      });
      this.processStarts++;
      const child = this.child;
      if (!child.stdin || !child.stdout)
        throw new LlmError('ACP subprocess did not expose stdio pipes.', 'ACP_DISCONNECTED');

      // Capture stderr to intercept OAuth URLs
      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        for (const line of text.split('\n')) {
          this.oauthManager.handleStderrLine(line);
        }
      });

      const connection = connectTransport(
        child.stdout,
        child.stdin,
        (event) => this.onUpdate?.(event),
        (request) => this.onPermission?.(request),
      );
      this.connection = connection;
      void child.done.then(
        () => connection.close(),
        () => connection.close(),
      );

      // Default handshake timeout (120s for mobile cold start)
      const handshakeTimeout = this.config.handshakeTimeoutMs || 120000;
      const init = await this.bounded(
        connection.agent.request(methods.agent.initialize, {
          protocolVersion: 1,
          clientInfo: { name: 'dsh-antigravity-acp', version: '0.4.0' },
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        }),
        handshakeTimeout,
        signal,
      );
      if (init.protocolVersion !== 1)
        throw new LlmError('The official server did not negotiate ACP v1.', 'ACP_VERSION_MISMATCH');
      this.initializeResult = init;
    } catch (error) {
      await this.reset();
      throw signal?.aborted ? aborted() : classify(error);
    }
  }

  async login(signal?: AbortSignal): Promise<void> {
    await this.start(signal);
    const method = this.initializeResult?.authMethods?.find((m) => m.id === this.config.auth);
    if (!method || ('type' in method && method.type === 'terminal'))
      throw new LlmError(
        'This server does not advertise protocol-driven oauth-personal authentication.',
        'ACP_AUTH_UNSUPPORTED',
      );
    this.notify(
      'Authorize your Google account in the browser opened by the official Antigravity server. DSH will continue automatically.',
    );
    await this.bounded(
      this.connection!.agent.request(methods.agent.authenticate, { methodId: method.id }),
      this.config.authTimeoutMs,
      signal,
    );
    this.authentications++;
  }

  async newSession(
    signal?: AbortSignal,
    authenticate = true,
    mcpServers: McpServer[] = [],
  ): Promise<NewSessionResponse> {
    this.unusedSession = undefined;
    if (this.sessionCount >= this.config.maxSessionsPerProcess) await this.reset();
    await this.start(signal);
    const create = () =>
      this.bounded(
        this.connection!.agent.request(methods.agent.session.new, {
          cwd: this.cwd!,
          mcpServers,
        }),
        this.config.requestTimeoutMs,
        signal,
      );
    let session: NewSessionResponse;
    try {
      session = await create();
    } catch (error) {
      if (!authenticate || !(error instanceof LlmError) || error.code !== 'ACP_AUTH_REQUIRED')
        throw error;
      await this.login(signal);
      session = await create();
    }
    this.sessionCount++;
    if (!mcpServers.length) this.unusedSession = session;
    return session;
  }

  takeUnusedSession(): NewSessionResponse | undefined {
    const session = this.connected ? this.unusedSession : undefined;
    this.unusedSession = undefined;
    return session;
  }

  async selectModel(
    session: NewSessionResponse,
    model: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const option = modelOption(session);
    if (!option) return;
    await this.bounded(
      this.connection!.agent.request(methods.agent.session.setOption, {
        sessionId: session.sessionId,
        optionId: option.id,
        value: model,
      }),
      this.config.requestTimeoutMs,
      signal,
    );
  }

  async reset(): Promise<void> {
    const child = this.child;
    const connection = this.connection;
    const cwd = this.cwd;
    this.child = undefined;
    this.connection = undefined;
    this.initializeResult = undefined;
    this.unusedSession = undefined;
    this.sessionCount = 0;
    this.cwd = undefined;
    if (this.stopping) await this.stopping;
    if (!child && !connection && !cwd) return;
    this.stopping = (async () => {
      try {
        if (connection) await connection.close();
        if (child) await disposeProcess(child, this.config.disposeGraceMs);
      } finally {
        if (cwd) await rm(cwd, { recursive: true, force: true }).catch(() => {});
      }
    })();
    try {
      await this.stopping;
    } finally {
      this.stopping = undefined;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.reset();
  }
}
