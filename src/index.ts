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
      ctx.llm.registerAdapter?.([resolved.provider], adapter);
      ctx.effect?.(() => () => adapter?.dispose());
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
        emit(stripView({ authorized: state.status === 'authenticated' }, locale));
      };
      push();
      return oauthManager.onStateChange(() => push());
    });

    // Register panel with v2 form/collapsible support and live state subscription
    dshGo.panel('acp-panel', {
      view: (_scope: any, caps: any) => {
        const state = oauthManager.getState();
        const lang = caps?.locale ?? 'zh';
        if (state.status === 'authenticated') {
          return connectedCardView({
            lang,
            model: config?.defaultModel || 'server-default',
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
        let lastAuth = oauthManager.getState().status === 'authenticated';
        const push = () => {
          const state = oauthManager.getState();
          const isAuth = state.status === 'authenticated';
          emit({
            authenticated: isAuth,
            authUrl: state.authUrl ?? '',
            callbackUrl: '',
            locale,
          });
          if (isAuth !== lastAuth) {
            lastAuth = isAuth;
            dshGo.refresh?.('acp-panel');
          }
        };
        push();
        return oauthManager.onStateChange(() => push());
      },
      actions: {
        'launch-browser': async (_scope: any, event: any) => {
          const isEn = String(event?.locale ?? '').startsWith('en');
          let state = oauthManager.getState();
          if (!state.authUrl && adapter) {
            void adapter.client.login().catch(() => {});
            await oauthManager.waitForAuthUrl(2500);
            state = oauthManager.getState();
          }
          if (state.authUrl) {
            return { type: 'link', url: state.authUrl };
          }
          return {
            type: 'toast',
            text: isEn ? 'No auth link yet, start a session first' : '暂无授权链接，请先发起会话',
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
