import { stripView, unauthCardView, connectedCardView } from './ui.js';
import { AndroidOAuthManager } from './android-oauth.js';
import { patchArm64Binary, patchExecutableFile, ensurePatchedServer } from './binary-patcher.js';
import { validateAndFormatServerArgs, prepareRunnerEnv, createStdoutJsonFilter, DEFAULT_HANDSHAKE_TIMEOUT_MS } from './acp-runner.js';

export const name = 'llm-antigravity-acp';
export const inject = ['llm', 'subprocess'];

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

export function apply(ctx, config = {}) {
  let adapter;
  let sharedOAuth;

  // 1. DSH core LLM provider registration (when running inside DSH core)
  if (ctx.llm && ctx.subprocess) {
    try {
      const provider = config?.provider || 'antigravity-acp';
      if (typeof ctx.llm.registerAdapter === 'function') {
        ctx.llm.registerAdapter([provider], {
          providerInfo: (p) => ({ id: p, name: 'Antigravity (Android ACP)' }),
          listModels: async () => [
            {
              id: 'server-default',
              name: 'Google Antigravity Default',
              provider,
              inputModalities: ['text'],
            },
          ],
        });
      }
    } catch {
      // Fallback
    }
  }

  const oauthManager = sharedOAuth ?? new AndroidOAuthManager();

  // 2. DSH Go Android Native UI Bridge registration
  // Must use ctx.inject(['dshGo'], callback) - NOT top-level inject
  ctx.inject(['dshGo'], (subCtx) => {
    const dshGo = subCtx.dshGo;
    if (!dshGo) return;

    // Register composer strip
    dshGo.strip('acp-strip', (_scope, emit, caps) => {
      const state = oauthManager.getState();
      const isAuth = state.status === 'authenticated';
      emit(stripView({ authorized: isAuth }, caps?.locale ?? 'zh'));
      return () => {};
    });

    // Register panel
    dshGo.panel('acp-panel', {
      view: (_scope, caps) => {
        const state = oauthManager.getState();
        if (state.status === 'authenticated') {
          return connectedCardView({ lang: caps?.locale ?? 'zh' });
        }
        return unauthCardView({ lang: caps?.locale ?? 'zh', authUrl: state.authUrl });
      },
      data: (_scope, emit, caps) => {
        const state = oauthManager.getState();
        emit({
          authenticated: state.status === 'authenticated',
          authUrl: state.authUrl ?? null,
          locale: caps?.locale ?? 'zh',
        });
        return () => {};
      },
      actions: {
        'launch-browser': (_scope) => {
          const state = oauthManager.getState();
          if (state.authUrl) {
            return { type: 'open', url: state.authUrl };
          }
          return { toast: '暂无授权链接，请重新发起' };
        },
        'paste-callback': async (_scope, event) => {
          const callbackUrl = event?.value?.url ?? event?.value;
          if (typeof callbackUrl === 'string' && callbackUrl.trim()) {
            try {
              const res = await oauthManager.relayLoopbackCallback(callbackUrl.trim());
              return { toast: res.message };
            } catch (err) {
              return { toast: String(err?.message ?? err) };
            }
          }
          return { toast: '请提供完整的回调链接' };
        },
      },
    });
  });
}
