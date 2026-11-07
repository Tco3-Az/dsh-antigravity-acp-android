import { spawn } from 'node:child_process';
import { URL } from 'node:url';
export const OAUTH_URL_REGEX = /https:\/\/accounts\.google\.com\/[^\s\r\n"'>]+/i;
export class AndroidOAuthManager {
    state = { status: 'idle' };
    onOAuthUrlListener;
    stateListeners = new Set();
    amStartLauncher;
    fetchFn;
    constructor(options = {}) {
        this.onOAuthUrlListener = options.onOAuthUrl;
        this.fetchFn = options.fetchFn ?? globalThis.fetch;
        this.amStartLauncher = options.amStartLauncher ?? ((url) => this.defaultAmStart(url));
    }
    getState() {
        return { ...this.state };
    }
    onStateChange(listener) {
        this.stateListeners.add(listener);
        return () => {
            this.stateListeners.delete(listener);
        };
    }
    emitState() {
        const snapshot = this.getState();
        for (const listener of this.stateListeners) {
            try {
                listener(snapshot);
            }
            catch {
                // Ignore listener errors
            }
        }
    }
    markAuthenticated() {
        if (this.state.status !== 'authenticated') {
            this.state = {
                ...this.state,
                status: 'authenticated',
                error: undefined,
            };
            this.emitState();
        }
    }
    async defaultAmStart(url) {
        return new Promise((resolve) => {
            try {
                const child = spawn('/system/bin/am', ['start', '-a', 'android.intent.action.VIEW', '-d', url], {
                    stdio: 'ignore',
                });
                child.on('error', () => resolve(false));
                child.on('close', (code) => resolve(code === 0));
            }
            catch {
                resolve(false);
            }
        });
    }
    handleStderrLine(line) {
        const match = line.match(OAUTH_URL_REGEX);
        if (!match)
            return undefined;
        const url = match[0];
        let loopbackPort;
        let expectedState;
        try {
            const parsed = new URL(url);
            const redirectUri = parsed.searchParams.get('redirect_uri');
            if (redirectUri) {
                const redirectUrl = new URL(redirectUri);
                loopbackPort = Number(redirectUrl.port) || undefined;
            }
            expectedState = parsed.searchParams.get('state') ?? undefined;
        }
        catch {
            // Ignore URL parsing errors
        }
        this.state = {
            status: 'authorizing',
            authUrl: url,
            loopbackPort,
            expectedState,
        };
        // Level 1: Launch Android browser silently
        try {
            void this.amStartLauncher(url);
        }
        catch {
            // Ignore launch errors
        }
        this.onOAuthUrlListener?.(url, loopbackPort, expectedState);
        this.emitState();
        return url;
    }
    waitForAuthUrl(timeoutMs = 15000) {
        if (this.state.authUrl)
            return Promise.resolve(this.state.authUrl);
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                unsubscribe();
                resolve(this.state.authUrl);
            }, timeoutMs);
            timer.unref?.();
            const unsubscribe = this.onStateChange((s) => {
                if (s.authUrl) {
                    clearTimeout(timer);
                    unsubscribe();
                    resolve(s.authUrl);
                }
            });
        });
    }
    // Level 3: Manual Loopback Callback Relay
    async relayLoopbackCallback(callbackUrl) {
        let parsed;
        try {
            parsed = new URL(callbackUrl);
        }
        catch {
            throw new Error('无效的回调链接格式');
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error('回调链接协议必须为 http 或 https');
        }
        const hostname = parsed.hostname.toLowerCase();
        if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1') {
            throw new Error('安全拦截：回调链接必须指向本地回环地址 (127.0.0.1)');
        }
        const port = Number(parsed.port);
        if (this.state.loopbackPort && port && port !== this.state.loopbackPort) {
            throw new Error(`回调端口 ${port} 与当前服务器监听端口 ${this.state.loopbackPort} 不符`);
        }
        const stateParam = parsed.searchParams.get('state');
        if (this.state.expectedState && stateParam && stateParam !== this.state.expectedState) {
            throw new Error('安全拦截：State 校验失败，可能来自不同授权会话');
        }
        try {
            const response = await this.fetchFn(callbackUrl, {
                method: 'GET',
                redirect: 'follow',
            });
            if (response.ok) {
                this.markAuthenticated();
            }
            return {
                ok: response.ok,
                status: response.status,
                message: response.ok ? '授权成功' : `服务器返回状态码 ${response.status}`,
            };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(`本地中继请求失败：${message}`);
        }
    }
}
export const oauthManager = new AndroidOAuthManager();
