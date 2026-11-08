import { LlmAdapter, LlmError, ReasoningEffortId, } from '@deepseek-ai/dsh-llm';
import { AcpClient } from './acp/client.js';
import { EventMapper, finishReason } from './acp/events.js';
import { aborted, classify } from './acp/errors.js';
import { currentModel, modelCatalog } from './models.js';
import { buildPrompt } from './prompt.js';
import { ACP_CONTEXT_WINDOW, assertContextBudget } from './context.js';
import { ToolSessions } from './mcp/sessions.js';
import { oauthManager } from './android-oauth.js';
/**
 * DSH validates effort before dispatch (including xhigh from its native UI).
 * Older ACP sessions encode thinking in the exact model ID and expose no
 * independent selector; newer sessions can announce a thought_level option.
 * selectReasoning forwards only an advertised selector, never a prompt hack.
 */
const REASONING_META = {
    efforts: [
        { id: ReasoningEffortId('off'), name: 'Off' },
        { id: ReasoningEffortId('low'), name: 'Low' },
        { id: ReasoningEffortId('medium'), name: 'Medium' },
        { id: ReasoningEffortId('high'), name: 'High' },
        { id: ReasoningEffortId('xhigh'), name: 'Extra high' },
        { id: ReasoningEffortId('max'), name: 'Max' },
    ],
};
export class AntigravityAcpAdapter extends LlmAdapter {
    config;
    runtime;
    warn;
    oauth;
    controlClient;
    tools;
    tail = Promise.resolve();
    disposed = false;
    lifetime = new AbortController();
    generations = 0;
    warnedTools = false;
    catalog = [];
    selected;
    discoveryError;
    listeners = new Set();
    onStateChange(listener) {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }
    emitState() {
        for (const listener of this.listeners) {
            try {
                listener();
            }
            catch { /* observers cannot veto state */ }
        }
    }
    observeSession(session) {
        const catalog = modelCatalog(session);
        const selected = currentModel(session);
        const changed = JSON.stringify([catalog, selected]) !== JSON.stringify([this.catalog, this.selected]);
        this.catalog = catalog;
        this.selected = selected;
        this.discoveryError = catalog.length ? undefined : 'ACP_MODEL_DISCOVERY_EMPTY';
        if (changed)
            this.emitState();
    }
    createClient() {
        const client = new AcpClient(this.config, this.runtime, this.warn, this.oauth);
        client.onSessionState = (session) => this.observeSession(session);
        return client;
    }
    modelState() {
        return { models: this.catalog.map((m) => ({ ...m })), currentModel: this.selected ? { ...this.selected } : undefined,
            discoveryError: this.discoveryError, connected: this.client.connected || this.tools.connected };
    }
    async refreshModels(signal) {
        const activeSignal = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
        const release = await this.acquire(activeSignal);
        try {
            this.catalog = [];
            this.discoveryError = undefined;
        }
        finally {
            release();
        }
        return this.listModels(this.config.provider, activeSignal);
    }
    constructor(config, runtime, warn = () => { }, oauth = oauthManager) {
        super();
        this.config = config;
        this.runtime = runtime;
        this.warn = warn;
        this.oauth = oauth;
        this.controlClient = this.createClient();
        this.tools = new ToolSessions(config, runtime, warn, oauth, (session) => this.observeSession(session));
    }
    get client() {
        return this.controlClient;
    }
    providerInfo(provider) {
        return { id: provider, name: 'Antigravity (official ACP)' };
    }
    async acquire(signal) {
        if (this.disposed)
            throw new LlmError('Antigravity adapter has been disposed.', 'ACP_DISPOSED');
        if (signal?.aborted)
            throw aborted();
        const previous = this.tail;
        let release;
        this.tail = new Promise((resolve) => {
            release = resolve;
        });
        let onAbort;
        try {
            const abort = new Promise((_, reject) => {
                onAbort = () => reject(aborted());
                signal?.addEventListener('abort', onAbort, { once: true });
                if (signal?.aborted)
                    onAbort();
            });
            await Promise.race([previous, abort]);
            if (this.disposed)
                throw new LlmError('Antigravity adapter has been disposed.', 'ACP_DISPOSED');
            return release;
        }
        catch (error) {
            void previous.then(release);
            throw error;
        }
        finally {
            if (onAbort)
                signal?.removeEventListener('abort', onAbort);
        }
    }
    async listModels(provider, signal) {
        const activeSignal = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
        const release = await this.acquire(activeSignal);
        try {
            if (!this.catalog.length) {
                try {
                    this.observeSession(await this.client.newSession(activeSignal, false));
                    if (this.config.toolPolicy === 'bridge' &&
                        this.catalog.length &&
                        this.client.initializeResult?.agentCapabilities?.mcpCapabilities?.http) {
                        const ready = this.controlClient;
                        this.controlClient = this.createClient();
                        await this.tools.acceptReadyClient(ready);
                    }
                }
                catch (error) {
                    await this.client.reset();
                    if (activeSignal.aborted)
                        throw aborted();
                    this.discoveryError = classify(error).code;
                    this.emitState();
                    this.warn(classify(error).message);
                }
            }
            const entries = new Map([...this.catalog, ...this.config.models.map((id) => ({ id, name: id }))].map((m) => [
                m.id,
                m,
            ]));
            // Keep the alias stable across login/discovery. DSH may still have it
            // selected while a refreshed catalog replaces the previous placeholder.
            entries.set('server-default', { id: 'server-default', name: 'Server default' });
            return [...entries.values()].map((m) => ({
                ...m,
                provider,
                inputModalities: ['text'],
                description: 'Official ACP backend with DSH tools through MCP',
                reasoning: REASONING_META,
            }));
        }
        finally {
            release();
        }
    }
    async resolveModel(provider, model, signal) {
        if (signal?.aborted)
            throw aborted();
        return {
            provider,
            id: model,
            name: model === 'server-default' ? 'Server default' : this.catalog.find((m) => m.id === model)?.name ?? model,
            inputModalities: ['text'],
            reasoning: REASONING_META,
            context: { contextWindow: ACP_CONTEXT_WINDOW },
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
        };
    }
    async *stream(options) {
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
        const prompt = buildPrompt(options, this.config); // Validate before spawning or authenticating.
        const release = await this.acquire(options.signal);
        const borrowed = this.tools.borrowReadyClient();
        const client = borrowed ?? this.client;
        const mapper = new EventMapper();
        let sessionId, completed = false, promptStarted = false;
        const queue = [];
        let wake;
        let error;
        let done = false;
        try {
            if (options.tools?.length && !this.warnedTools) {
                this.warnedTools = true;
                this.warn('Antigravity ACP is a text-only route: DSH tool schemas are omitted and tool execution is unavailable (toolPolicy: text-only).');
            }
            const session = client.takeUnusedSession() ?? (await client.newSession(options.signal));
            sessionId = session.sessionId;
            this.observeSession(session);
            await client.selectModel(session, options.model, options.signal);
            await client.selectReasoning(session, options.reasoningEffort, options.signal);
            this.generations++;
            const nativeTools = () => {
                error = new LlmError('Antigravity attempted native agent tool activity. This provider supports text only; tools remain unavailable on this route.', 'ACP_NATIVE_TOOLS_UNSUPPORTED');
                done = true;
                wake?.();
            };
            client.onPermission = nativeTools;
            client.onUpdate = (event) => {
                if (event.sessionId !== sessionId || done)
                    return;
                if (event.update.sessionUpdate === 'usage_update') {
                    try {
                        assertContextBudget('', event.update);
                    }
                    catch (failure) {
                        error = failure;
                        done = true;
                        wake?.();
                        void client.cancelAndReset(sessionId).catch(() => { });
                    }
                    return;
                }
                if (event.update.sessionUpdate === 'tool_call' ||
                    event.update.sessionUpdate === 'tool_call_update') {
                    nativeTools();
                    return;
                }
                queue.push(...mapper.update(event.update));
                wake?.();
            };
            let stop = '';
            promptStarted = true;
            const pending = client.prompt(sessionId, prompt, options.signal).then((result) => {
                stop = result.stopReason;
                done = true;
                wake?.();
            }, (failure) => {
                error = failure;
                done = true;
                wake?.();
            });
            while (!done || queue.length) {
                while (queue.length) {
                    if (options.signal?.aborted)
                        throw aborted();
                    yield queue.shift();
                }
                if (!done)
                    await new Promise((resolve) => {
                        wake = resolve;
                    });
            }
            if (error)
                throw error;
            await pending;
            if (options.signal?.aborted)
                throw aborted();
            if (!mapper.hasText && stop === 'end_turn')
                throw new LlmError('Official ACP server ended the turn without assistant text.', 'EMPTY_RESPONSE');
            yield* mapper.end();
            // ACP usage_update reports current context occupancy, not per-call token billing.
            completed = stop === 'end_turn';
            yield { type: 'finish', reason: finishReason(stop) };
        }
        catch (failure) {
            throw options.signal?.aborted ? aborted() : classify(failure);
        }
        finally {
            client.onUpdate = undefined;
            client.onPermission = undefined;
            try {
                if (completed && !options.signal?.aborted && borrowed)
                    await this.tools.acceptReadyClient(client);
                else if (!completed || options.signal?.aborted)
                    await client.cancelAndReset(promptStarted ? sessionId : undefined);
            }
            finally {
                try {
                    if (borrowed && (!completed || options.signal?.aborted))
                        await this.tools.discardReadyClient(client);
                }
                finally {
                    release();
                }
            }
        }
    }
    async dispose() {
        this.disposed = true;
        this.lifetime.abort();
        this.listeners.clear();
        await Promise.all([this.client.dispose(), this.tools.dispose()]);
    }
}
