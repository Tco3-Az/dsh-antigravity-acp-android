export function unauthCardView(options = {}) {
    const isZh = (options.lang ?? 'zh').startsWith('zh');
    const supportsV2Controls = !options.components ||
        (options.components.includes('collapsible') &&
            options.components.includes('form') &&
            options.components.includes('textField'));
    if (!supportsV2Controls) {
        return {
            v: 1,
            type: 'stack',
            title: isZh ? 'Antigravity 未授权' : 'Antigravity auth',
            children: [
                {
                    type: 'callout',
                    tone: 'info',
                    text: isZh ? '请在系统浏览器中完成授权' : 'Authorize in browser',
                },
                {
                    type: 'actions',
                    items: [
                        {
                            label: isZh ? '拉起浏览器登录' : 'Log in',
                            style: 'primary',
                            action: { id: 'launch-browser' },
                        },
                        {
                            label: isZh ? '手动粘贴回调' : 'Relay URL',
                            style: 'plain',
                            action: { id: 'paste-callback' },
                        },
                    ],
                },
            ],
        };
    }
    return {
        v: 2,
        type: 'stack',
        title: isZh ? 'Antigravity 未授权' : 'Antigravity auth',
        children: [
            {
                type: 'actions',
                items: [
                    {
                        label: isZh ? '拉起浏览器登录' : 'Log in',
                        action: { id: 'launch-browser' },
                    },
                ],
            },
            {
                type: 'collapsible',
                label: isZh ? '粘贴回调链接' : 'Paste callback',
                expanded: false,
                children: [
                    {
                        type: 'form',
                        submit: { id: 'paste-callback' },
                        submitLabel: isZh ? '确认提交' : 'Submit',
                        children: [
                            {
                                type: 'textField',
                                label: isZh ? '回调链接' : 'Callback URL',
                                bind: 'data.callbackUrl',
                                placeholder: 'http://127.0.0.1:...',
                                maxLength: 1024,
                            },
                        ],
                    },
                ],
            },
        ],
    };
}
export function connectedCardView(options = {}) {
    const isZh = (options.lang ?? 'zh').startsWith('zh');
    const model = options.model && options.model !== 'server-default'
        ? options.model : (isZh ? '服务端默认' : 'Server default');
    const percent = options.quotaPercent;
    const quota = typeof percent === 'number' && Number.isFinite(percent) && percent >= 0 && percent <= 100
        ? `${percent}%` : (isZh ? '服务端未提供' : 'Not reported');
    const reset = options.resetTime ?? (isZh ? '服务端未提供' : 'Not reported');
    return {
        v: 1,
        type: 'stack',
        title: isZh ? 'Antigravity 已连接' : 'Antigravity',
        children: [
            {
                type: 'keyValue',
                items: [
                    [isZh ? '当前模型' : 'Model', model],
                    [isZh ? '额度剩余' : 'Quota', quota],
                    [isZh ? '重置周期' : 'Reset', reset],
                ],
            },
            { type: 'actions', items: [
                    { label: isZh ? '刷新模型' : 'Refresh', action: { id: 'refresh-models' } },
                ] },
        ],
    };
}
export function stripView(state = {}, lang = 'zh') {
    const isZh = lang.startsWith('zh');
    if (state.authorized) {
        return {
            text: state.connected
                ? (isZh ? 'Antigravity 已连接' : 'Antigravity connected')
                : (isZh ? 'Antigravity 已登录' : 'Antigravity signed in'),
            icon: 'model',
            tone: 'good',
        };
    }
    return {
        text: isZh ? 'Antigravity 未授权' : 'Antigravity offline',
        icon: 'model',
        tone: 'warn',
    };
}
