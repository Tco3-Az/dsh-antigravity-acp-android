export declare const OAUTH_URL_REGEX: RegExp;
export interface OAuthSessionState {
    status: 'idle' | 'authorizing' | 'authenticated' | 'error';
    authUrl?: string;
    loopbackPort?: number;
    expectedState?: string;
    error?: string;
}
export interface AndroidOAuthOptions {
    onOAuthUrl?: (url: string, loopbackPort?: number, state?: string) => void;
    amStartLauncher?: (url: string) => Promise<boolean> | boolean;
    fetchFn?: typeof globalThis.fetch;
}
export declare class AndroidOAuthManager {
    private state;
    private onOAuthUrlListener?;
    private stateListeners;
    private amStartLauncher;
    private fetchFn;
    constructor(options?: AndroidOAuthOptions);
    getState(): OAuthSessionState;
    onStateChange(listener: (state: OAuthSessionState) => void): () => void;
    private emitState;
    markAuthenticated(): void;
    private defaultAmStart;
    handleStderrLine(line: string): string | undefined;
    waitForAuthUrl(timeoutMs?: number): Promise<string | undefined>;
    relayLoopbackCallback(callbackUrl: string): Promise<{
        ok: boolean;
        status: number;
        message: string;
    }>;
}
export declare const oauthManager: AndroidOAuthManager;
