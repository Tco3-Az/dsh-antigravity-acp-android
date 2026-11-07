import {
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  type StreamChunk,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
} from '@deepseek-ai/dsh-llm';
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';
import { AcpClient } from './acp/client.js';
import { EventMapper, finishReason } from './acp/events.js';
import { aborted, classify } from './acp/errors.js';
import { modelCatalog } from './models.js';
import { buildPrompt } from './prompt.js';
import type { Config } from './config.js';
import { ToolSessions } from './mcp/sessions.js';
import type { AcpGenerateOptions as GenerateOptions } from './request.js';
import type { AndroidOAuthManager } from './android-oauth.js';

const REASONING_META = {
  efforts: [
    { id: ReasoningEffortId('off'), name: 'Off' },
    { id: ReasoningEffortId('low'), name: 'Low' },
    { id: ReasoningEffortId('medium'), name: 'Medium' },
    { id: ReasoningEffortId('high'), name: 'High' },
    { id: ReasoningEffortId('max'), name: 'Max' },
  ],
};

export class AntigravityAcpAdapter extends LlmAdapter {
  private controlClient: AcpClient;
  private tools: ToolSessions;
  private tail: Promise<void> = Promise.resolve();
  private disposed = false;
  private lifetime = new AbortController();
  private generations = 0;
  private warnedTools = false;
  private catalog: { id: string; name: string }[] = [];

  constructor(
    readonly config: Config,
    private runtime: SubprocessRuntime,
    private warn: (message: string) => void = () => {},
  ) {
    super();
    this.controlClient = new AcpClient(config, runtime, warn);
    this.tools = new ToolSessions(config, runtime, warn);
  }

  get client(): AcpClient {
    return this.controlClient;
  }

  get oauthManager(): AndroidOAuthManager {
    return this.controlClient.oauthManager;
  }

  providerInfo(provider: string) {
    return { id: provider, name: 'Antigravity (official ACP Android)' };
  }

  private async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.disposed) throw new LlmError('Antigravity adapter has been disposed.', 'ACP_DISPOSED');
    if (signal?.aborted) throw aborted();
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    let onAbort: (() => void) | undefined;
    try {
      const abort = new Promise<never>((_, reject) => {
        onAbort = () => reject(aborted());
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
      await Promise.race([previous, abort]);
      if (this.disposed)
        throw new LlmError('Antigravity adapter has been disposed.', 'ACP_DISPOSED');
      return release;
    } catch (error) {
      void previous.then(release);
      throw error;
    } finally {
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
  }

  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const release = await this.acquire(this.lifetime.signal);
    try {
      if (!this.catalog.length) {
        try {
          this.catalog = modelCatalog(await this.client.newSession(this.lifetime.signal, false));
          if (
            this.config.toolPolicy === 'bridge' &&
            this.catalog.length &&
            this.client.initializeResult?.agentCapabilities?.mcpCapabilities?.http
          ) {
            const ready = this.controlClient;
            this.controlClient = new AcpClient(this.config, this.runtime, this.warn);
            await this.tools.acceptReadyClient(ready);
          }
        } catch (error) {
          await this.client.reset();
          this.warn(classify(error).message);
        }
      }
      const entries = new Map(
        [...this.catalog, ...this.config.models.map((id) => ({ id, name: id }))].map((m) => [
          m.id,
          m,
        ]),
      );
      if (!entries.size)
        entries.set('server-default', {
          id: 'server-default',
          name: 'Server default (login / discovery pending)',
        });
      return [...entries.values()].map((m) => ({
        ...m,
        provider,
        inputModalities: ['text'],
        description: 'Official ACP backend with DSH tools through MCP on Android',
        reasoning: REASONING_META,
      }));
    } finally {
      release();
    }
  }

  async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    if (signal?.aborted) throw aborted();
    return {
      provider,
      id: model,
      name: this.catalog.find((m) => m.id === model)?.name ?? model,
      inputModalities: ['text'],
      reasoning: REASONING_META,
    };
  }

  diagnostics() {
    return {
      connected: this.client.connected || this.tools.connected,
      processStarts: this.client.processStarts + this.tools.processStarts,
      authentications: this.client.authentications + this.tools.authentications,
      generations: this.generations + this.tools.generations,
      activeToolSessions: this.tools.active,
      idleToolProcesses: this.tools.idle,
      oauth: this.oauthManager.getState(),
    };
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options = {
      ...options,
      signal: options.signal
        ? AbortSignal.any([options.signal, this.lifetime.signal])
        : this.lifetime.signal,
    };
    if (this.config.toolPolicy === 'bridge' && (options.tools?.length || this.tools.has(options))) {
      yield* this.tools.stream(options);
      return;
    }
    const prompt = buildPrompt(options, this.config);
    const release = await this.acquire(options.signal);
    const borrowed = this.tools.borrowReadyClient();
    const client = borrowed ?? this.client;
    const mapper = new EventMapper();
    let sessionId: string | undefined,
      completed = false,
      promptStarted = false;
    const queue: StreamChunk[] = [];
    let wake: (() => void) | undefined;
    let error: unknown;
    let done = false;
    try {
      if (options.tools?.length && !this.warnedTools) {
        this.warnedTools = true;
        this.warn(
          'Antigravity ACP is a text-only route: DSH tool schemas are omitted and tool execution is unavailable (toolPolicy: text-only).',
        );
      }
      const session = client.takeUnusedSession() ?? (await client.newSession(options.signal));
      sessionId = session.sessionId;
      this.catalog = modelCatalog(session);
      await client.selectModel(session, options.model, options.signal);
      this.generations++;
      const nativeTools = () => {
        error = new LlmError(
          'Antigravity attempted native agent tool activity. This provider supports text only; tools remain unavailable on this route.',
          'ACP_NATIVE_TOOLS_UNSUPPORTED',
        );
        done = true;
        wake?.();
      };
      client.onPermission = nativeTools;
      client.onUpdate = (event) => {
        if (event.sessionId !== sessionId) return;
        for (const chunk of mapper.map(event)) queue.push(chunk);
        wake?.();
      };
      const cancelTurn = (reason: string) => {
        if (!promptStarted || completed || !sessionId || !client.connected) return;
        void client.connection!.agent
          .notify(methods.agent.session.cancel, { sessionId })
          .catch(() => {});
        this.warn(`Antigravity prompt cancelled (${reason}).`);
      };
      options.signal?.addEventListener('abort', () => cancelTurn('client abort'), { once: true });
      this.lifetime.signal.addEventListener('abort', () => cancelTurn('adapter disposed'), {
        once: true,
      });
      const promptPromise = (async () => {
        try {
          promptStarted = true;
          const result = await client.connection!.agent.request(
            methods.agent.session.prompt,
            { sessionId: session.sessionId, prompt },
          );
          completed = true;
          queue.push({ finishReason: finishReason(result.stopReason) });
        } catch (err) {
          error = err;
        } finally {
          done = true;
          wake?.();
        }
      })();
      while (!done || queue.length) {
        while (queue.length) yield queue.shift()!;
        if (done) break;
        await new Promise<void>((r) => (wake = r));
        wake = undefined;
      }
      await promptPromise;
      if (error) throw error;
    } finally {
      client.onPermission = undefined;
      client.onUpdate = undefined;
      release();
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.lifetime.abort();
    await Promise.allSettled([this.controlClient.dispose(), this.tools.dispose()]);
  }
}
