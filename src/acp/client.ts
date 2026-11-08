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
  type PromptResponse,
  type McpServer,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';
import type { Config } from '../config.js';
import { connectTransport } from './transport.js';
import { disposeProcess, resolveCommand, serverArgs } from './process.js';
import { aborted, classify } from './errors.js';
import { acpReasoningEffort, currentModel, modelCatalog, modelOption, selectValues, type ModelSession } from '../models.js';
import { prepareRunnerEnv } from '../acp-runner.js';
import { oauthManager, type AndroidOAuthManager } from '../android-oauth.js';

/** One process per adapter, serialized by the adapter. No credentials or history are persisted here. */
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
  onUpdate?: (event: SessionNotification) => void;
  onSessionState?: (session: NewSessionResponse) => void;
  private sessions = new Map<string, NewSessionResponse>();
  onPermission?: (request: RequestPermissionRequest) => void | RequestPermissionResponse;

  constructor(
    readonly config: Config,
    readonly runtime: SubprocessRuntime,
    private notify: (message: string) => void = () => {},
    private oauth: AndroidOAuthManager = oauthManager,
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
      this.child = this.runtime.spawn({
        argv: [command, ...serverArgs(this.config, command)],
        cwd: this.cwd,
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
        graceMs: this.config.disposeGraceMs,
        env: prepareRunnerEnv(process.env),
      });
      this.processStarts++;
      const child = this.child;
      if (!child.stdin || !child.stdout)
        throw new LlmError('ACP subprocess did not expose stdio pipes.', 'ACP_DISCONNECTED');

      // Monitor stderr line-by-line for Google OAuth URLs without retaining sensitive logs.
      if (child.stderr) {
        let stderrRemainder = '';
        child.stderr.on('data', (chunk: Buffer | string) => {
          stderrRemainder += chunk.toString();
          const lines = stderrRemainder.split(/\r?\n/);
          stderrRemainder = lines.pop() ?? '';
          for (const line of lines) {
            this.oauth.handleStderrLine(line);
          }
          if (stderrRemainder.includes('https://accounts.google.com/')) {
            this.oauth.handleStderrLine(stderrRemainder);
          }
        });
        child.stderr.resume();
      }

      const connection = connectTransport(
        child.stdout,
        child.stdin,
        (event) => {
          const session = this.sessions.get(event.sessionId);
          if (session && event.update.sessionUpdate === 'config_option_update') {
            session.configOptions = event.update.configOptions;
            this.onSessionState?.(session);
          }
          this.onUpdate?.(event);
        },
        (request) => this.onPermission?.(request),
      );
      this.connection = connection;
      void child.done.then(
        () => connection.close(),
        () => connection.close(),
      );
      const handshakeTimeout =
        this.config.handshakeTimeoutMs ?? Math.max(this.config.requestTimeoutMs, 120000);
      const init = await this.bounded(
        connection.agent.request(methods.agent.initialize, {
          protocolVersion: 1,
          clientInfo: { name: 'dsh-antigravity-acp', version: '0.3.5' },
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
    this.oauth.markAuthenticated();
  }

  async newSession(
    signal?: AbortSignal,
    authenticate = true,
    mcpServers: McpServer[] = [],
  ): Promise<NewSessionResponse> {
    this.unusedSession = undefined;
    // ACP has no universal session disposal; periodically recycle between turns.
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
    this.sessions.set(session.sessionId, session);
    this.onSessionState?.(session);
    this.oauth.markAuthenticated();
    if (!mcpServers.length) this.unusedSession = session;
    return session;
  }

  /** Claim a still-empty discovery session once. Sessions with MCP or prior prompts are excluded. */
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
    const wanted =
      model === 'server-default' ? this.config.defaultModel : model || this.config.defaultModel;
    if (!wanted) return;
    if (!modelCatalog(session).some((c) => c.id === wanted))
      throw new LlmError(
        'Selected model is not announced by the official ACP server. Refresh models and use an exact server model ID.',
        'ACP_INVALID_MODEL',
      );
    if (currentModel(session)?.id === wanted) return;
    if (option && selectValues(option).some((c) => c.value === wanted)) {
      const result = await this.bounded(
        this.connection!.agent.request(methods.agent.session.setConfigOption, {
          sessionId: session.sessionId,
          configId: option.id,
          value: wanted,
        }),
        this.config.requestTimeoutMs,
        signal,
      );
      session.configOptions = result.configOptions;
    } else {
      // Use the legacy method ONLY when this session announces legacy models.
      const legacy = (session as ModelSession).models;
      if (!legacy?.availableModels.some((m) => m.modelId === wanted))
        throw new LlmError('Official ACP model selector is unavailable.', 'ACP_INVALID_MODEL');
      await this.bounded(
        this.connection!.agent.request('session/set_model', {
          sessionId: session.sessionId, modelId: wanted,
        }),
        this.config.requestTimeoutMs,
        signal,
      );
      legacy.currentModelId = wanted;
    }
    this.onSessionState?.(session);
  }

  async selectReasoning(
    session: NewSessionResponse,
    effort?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const normalized = acpReasoningEffort(effort);
    if (!normalized) return;
    const option = session.configOptions?.find((c) => c.type === 'select' &&
      (c.category === 'thought_level' || c.id === 'thought_level' || c.id === 'reasoning_effort'));
    // Model-ID-based thinking remains authoritative on older servers.
    if (!option || option.type !== 'select') return;
    const values = selectValues(option);
    const aliases = normalized === 'off' ? ['off', 'none']
      : normalized === 'none' ? ['none', 'off'] : [normalized];
    const wanted = aliases.find((id) => values.some((value) => value.value === id));
    if (!wanted) throw new LlmError(
      'Selected thinking level is not announced by the official ACP server. Choose an advertised level.',
      'ACP_INVALID_REASONING',
    );
    if (option.currentValue === wanted) return;
    const result = await this.bounded(
      this.connection!.agent.request(methods.agent.session.setConfigOption, {
        sessionId: session.sessionId, configId: option.id, value: wanted,
      }), this.config.requestTimeoutMs, signal,
    );
    session.configOptions = result.configOptions;
    this.onSessionState?.(session);
  }

  prompt(
    sessionId: string,
    text: string,
    signal?: AbortSignal,
    timeoutMs = this.config.timeoutMs,
  ): Promise<PromptResponse> {
    if (this.unusedSession?.sessionId === sessionId) this.unusedSession = undefined;
    return this.bounded(
      this.connection!.agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: 'text', text }],
      }),
      timeoutMs,
      signal,
    );
  }

  async logout(signal?: AbortSignal): Promise<void> {
    await this.start(signal);
    if (!this.initializeResult?.agentCapabilities?.auth?.logout)
      throw new LlmError(
        'The official server does not advertise logout.',
        'ACP_METHOD_UNSUPPORTED',
      );
    await this.bounded(
      this.connection!.agent.request('logout', {}),
      this.config.requestTimeoutMs,
      signal,
    );
    await this.reset();
  }

  async cancelAndReset(sessionId?: string): Promise<void> {
    if (this.stopping) return this.stopping;
    if (sessionId && this.connected) {
      // ACP cancel is a notification, not a JSON-RPC request.
      try {
        await this.bounded(
          this.connection!.agent.notify(methods.agent.session.cancel, { sessionId }),
          this.config.cancelGraceMs,
        );
      } catch {
        /* reset owns cleanup */
      }
    }
    await this.reset();
  }

  async reset(): Promise<void> {
    if (this.stopping) return this.stopping;
    const child = this.child,
      connection = this.connection;
    this.child = undefined;
    this.connection = undefined;
    this.initializeResult = undefined;
    this.unusedSession = undefined;
    this.sessionCount = 0;
    this.sessions.clear();
    this.stopping = (async () => {
      connection?.close();
      if (child) await disposeProcess(child, this.config.disposeGraceMs);
    })();
    try {
      await this.stopping;
    } catch {
      throw new LlmError(
        'Official ACP subprocess cleanup failed. Restart this DSH profile before retrying.',
        'ACP_TEARDOWN_FAILED',
      );
    } finally {
      this.stopping = undefined;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.reset();
    if (this.cwd) {
      await rm(this.cwd, { recursive: true, force: true });
      this.cwd = undefined;
    }
  }
}
