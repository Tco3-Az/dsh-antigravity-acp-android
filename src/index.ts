import { stripView, unauthCardView, connectedCardView } from './ui.js';
import { AndroidOAuthManager } from './android-oauth.js';
import { patchArm64Binary, patchExecutableFile, ensurePatchedServer } from './binary-patcher.js';
import {
  validateAndFormatServerArgs,
  prepareRunnerEnv,
  createStdoutJsonFilter,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
} from './acp-runner.js';
import type { Config } from './config.js';
import type { AntigravityAcpAdapter } from './adapter.js';

export const name = 'llm-antigravity-acp';
export const inject = ['llm', 'subprocess'];

export type { Config, AntigravityAcpAdapter };

export {
  AndroidOAuthManager,
  patchArm64Binary,
  patchExecutableFile,
  ensurePatchedServer,
  validateAndFormatServerArgs,
  prepareRunnerEnv,
  createStdoutJsonFilter,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  stripView,
  unauthCardView,
  connectedCardView,
};

export async function apply(ctx: any, config: Partial<Config> = {}): Promise<void> {
  const oauthManager = new AndroidOAuthManager();
  let adapter: AntigravityAcpAdapter | undefined;

  // 1. DSH core LLM provider registration (when running inside DSH core)
  if (ctx.llm && ctx.subprocess) {
    try {
      const [{ resolveConfig }, { AntigravityAcpAdapter: AdapterClass }] = await Promise.all([
        import('./config.js'),
        import('./adapter.js'),
      ]);
      const resolved = resolveConfig(config);
      adapter = new AdapterClass(
        resolved,
        ctx.subprocess,
        (message: string) => ctx.logger?.warn?.(message) ?? console.warn(message),
        oauthManager,
      );
      const registration = ctx.llm.registerAdapter([resolved.provider], adapter);
      const unsubscribe = adapter.onStateChange(() => {
        // The DSH model picker caches provider catalogs. OAuth alone does not
        // invalidate it; publish the host's documented model update event.
        try { ctx.emit?.('llm/models-updated', resolved.provider); } catch { /* observer only */ }
      });
      let auth = oauthManager.getState().status;
      const unsubscribeAuth = oauthManager.onStateChange((state) => {
        const changed = state.status !== auth;
        auth = state.status;
        if (changed && state.status === 'authenticated') {
          // Do not await within the ACP session callback: discovery owns the
          // adapter queue and the callback must never recursively acquire it.
          queueMicrotask(() => {
            if (adapter?.modelState().models.length) return;
            void adapter?.refreshModels().then(() => {
              try { ctx.emit?.('llm/models-updated', resolved.provider); } catch { /* observer only */ }
            }).catch(() => {});
          });
        }
      });
      ctx.effect?.(() => () => {
        unsubscribe(); unsubscribeAuth(); registration?.();
        return adapter?.dispose();
      });
    } catch (err) {
      ctx.logger?.warn?.(`AntigravityAcpAdapter initialization fallback: ${String(err)}`);
    }
  }

  // 2. DSH Go Android Native UI Bridge registration
  // Must use ctx.inject(['dshGo'], callback) - NOT top-level inject
  ctx.inject(['dshGo'], (subCtx: any) => {
    const dshGo = subCtx.dshGo;
    if (!dshGo) return;

    // Register composer strip with live state subscription
    dshGo.strip('acp-strip', (_scope: any, emit: any, caps: any) => {
      const locale = caps?.locale ?? 'zh';
      const push = () => {
        const state = oauthManager.getState();
        emit(stripView({ authorized: state.status === 'authenticated', connected: adapter?.modelState().connected }, locale));
      };
      push();
      const stopAuth = oauthManager.onStateChange(() => push());
      const stopAdapter = adapter?.onStateChange(push);
      return () => { stopAuth(); stopAdapter?.(); };
    });

    // Register panel with v2 form/collapsible support and live state subscription
    dshGo.panel('acp-panel', {
      view: (_scope: any, caps: any) => {
        const state = oauthManager.getState();
        const lang = caps?.locale ?? 'zh';
        if (state.status === 'authenticated') {
          return connectedCardView({
            lang,
            model: adapter?.modelState().currentModel?.name || config.defaultModel,
          });
        }
        return unauthCardView({
          lang,
          authUrl: state.authUrl,
          components: caps?.components,
        });
      },
      data: (_scope: any, emit: any, caps: any) => {
        const locale = caps?.locale ?? 'zh';
        let lastView = '';
        const push = () => {
          const state = oauthManager.getState();
          const isAuth = state.status === 'authenticated';
          emit({
            authenticated: isAuth,
            authUrl: state.authUrl ?? '',
            callbackUrl: '',
            locale,
            model: adapter?.modelState().currentModel?.name ?? '',
            discoveryError: adapter?.modelState().discoveryError ?? '',
          });
          const viewKey = JSON.stringify([isAuth, adapter?.modelState()]);
          if (viewKey !== lastView) {
            lastView = viewKey;
            dshGo.refresh?.('acp-panel');
          }
        };
        push();
        const stopAuth = oauthManager.onStateChange(() => push());
        const stopAdapter = adapter?.onStateChange(push);
        return () => { stopAuth(); stopAdapter?.(); };
      },
      actions: {
        'refresh-models': (_scope: any, event: any) => {
          const isEn = String(event?.locale ?? '').startsWith('en');
          const activeAdapter = adapter;
          if (!activeAdapter) return { type: 'toast', text: isEn ? 'Provider unavailable' : '提供方未就绪' };
          // Native action handlers have a 3s deadline. Discovery starts an ACP
          // process and must run as cancellable deferred work, not block it.
          return {
            pending: { label: isEn ? 'Refresh models' : '刷新模型', timeoutMs: 60000 },
            result: async (signal: AbortSignal) => {
              await activeAdapter.refreshModels(signal);
              if (signal.aborted) return;
              dshGo.refresh?.('acp-panel');
              const ok = activeAdapter.modelState().models.length > 0;
              return { type: 'toast', text: ok
                ? (isEn ? 'Models refreshed' : '模型已刷新')
                : (isEn ? 'No models reported; retry later' : '服务端未返回模型，请稍后重试') };
            },
          };
        },
        'launch-browser': async (_scope: any, event: any) => {
          const isEn = String(event?.locale ?? '').startsWith('en');
          let state = oauthManager.getState();
          if (!state.authUrl && adapter) {
            void adapter.client.login().catch(() => {});
            await oauthManager.waitForAuthUrl(10000);
            state = oauthManager.getState();
          }
          if (state.authUrl) {
            return { type: 'link', url: state.authUrl };
          }
          return {
            type: 'toast',
            text: isEn ? 'No auth link yet; refresh or start a session' : '暂无授权链接，可先刷新模型',
          };
        },
        'paste-callback': async (_scope: any, event: any) => {
          const isEn = String(event?.locale ?? '').startsWith('en');
          const rawVal =
            event?.value?.values?.['data.callbackUrl'] ??
            event?.value?.callbackUrl ??
            event?.value?.url ??
            event?.value;
          if (typeof rawVal === 'string' && rawVal.trim()) {
            try {
              const res = await oauthManager.relayLoopbackCallback(rawVal.trim());
              return [
                { type: 'patch', data: { authenticated: res.ok, callbackUrl: '' } },
                { type: 'refresh', id: 'acp-panel' },
                { type: 'toast', text: res.message },
              ];
            } catch (err: any) {
              return { type: 'toast', text: String(err?.message ?? err) };
            }
          }
          return {
            type: 'toast',
            text: isEn ? 'Paste the full callback URL' : '请粘贴完整的回调链接',
          };
        },
      },
    });
  });
}
