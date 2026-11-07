import { stripView, unauthCardView, connectedCardView } from './ui.js';
import { AndroidOAuthManager } from './android-oauth.js';
import { patchArm64Binary, patchExecutableFile, ensurePatchedServer } from './binary-patcher.js';
import { validateAndFormatServerArgs, prepareRunnerEnv, createStdoutJsonFilter, DEFAULT_HANDSHAKE_TIMEOUT_MS } from './acp-runner.js';
import { Config, resolveConfig } from './config.js';
import { AntigravityAcpAdapter } from './adapter.js';

export const name = 'llm-antigravity-acp';
export const inject = ['llm', 'subprocess'];

export {
  Config,
  resolveConfig,
  AntigravityAcpAdapter,
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

export function apply(ctx: any, config: any = {}): void {
  let adapter: AntigravityAcpAdapter | undefined;
  let sharedOAuth: AndroidOAuthManager | undefined;

  // 1. DSH core LLM provider registration (when running inside DSH core)
  if (ctx.llm && ctx.subprocess) {
    try {
      const resolved = resolveConfig(config);
      adapter = new AntigravityAcpAdapter(resolved, ctx.subprocess, (message) =>
        ctx.logger?.warn?.(message) ?? console.warn(message),
      );
      ctx.llm.registerAdapter([resolved.provider], adapter);
      ctx.effect?.(() => () => adapter?.dispose());
      sharedOAuth = adapter.oauthManager;
    } catch {
      // Fallback if config resolution fails in stubbed environments
    }
  }

  const oauthManager = sharedOAuth ?? new AndroidOAuthManager();

  // 2. DSH Go Android Native UI Bridge registration
  // Must use ctx.inject(['dshGo'], callback) - NOT top-level inject
  ctx.inject(['dshGo'], (subCtx: any) => {
    const dshGo = subCtx.dshGo;
    if (!dshGo) return;

    // Register composer strip
    dshGo.strip('acp-strip', (_scope: any, emit: any, caps: any) => {
      const state = oauthManager.getState();
      const isAuth = state.status === 'authenticated';
      emit(stripView({ authorized: isAuth }, caps?.locale ?? 'zh'));
      return () => {};
    });

    // Register panel
    dshGo.panel('acp-panel', {
      view: (_scope: any, caps: any) => {
        const state = oauthManager.getState();
        if (state.status === 'authenticated') {
          return connectedCardView({ lang: caps?.locale ?? 'zh' });
        }
        return unauthCardView({ lang: caps?.locale ?? 'zh', authUrl: state.authUrl });
      },
      data: (_scope: any, emit: any, caps: any) => {
        const state = oauthManager.getState();
        emit({
          authenticated: state.status === 'authenticated',
          authUrl: state.authUrl ?? null,
          locale: caps?.locale ?? 'zh',
        });
        return () => {};
      },
      actions: {
        'launch-browser': (_scope: any) => {
          const state = oauthManager.getState();
          if (state.authUrl) {
            return { type: 'open', url: state.authUrl };
          }
          return { toast: '暂无授权链接，请重新发起' };
        },
        'paste-callback': async (_scope: any, event: any) => {
          const callbackUrl = event?.value?.url ?? event?.value;
          if (typeof callbackUrl === 'string' && callbackUrl.trim()) {
            try {
              const res = await oauthManager.relayLoopbackCallback(callbackUrl.trim());
              return { toast: res.message };
            } catch (err: any) {
              return { toast: String(err?.message ?? err) };
            }
          }
          return { toast: '请提供完整的回调链接' };
        },
      },
    });
  });
}
