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
    const model = options.model ?? 'server-default';
    const percent = options.quotaPercent ?? 100;
    const reset = options.resetTime ?? (isZh ? '每日重置' : 'Daily');
    return {
        v: 1,
        type: 'stack',
        title: isZh ? 'Antigravity 已连接' : 'Antigravity',
        children: [
            {
                type: 'keyValue',
                items: [
                    [isZh ? '当前模型' : 'Model', model],
                    [isZh ? '额度剩余' : 'Quota', `${percent}%`],
                    [isZh ? '重置周期' : 'Reset', reset],
                ],
            },
        ],
    };
}
export function stripView(state = {}, lang = 'zh') {
    const isZh = lang.startsWith('zh');
    if (state.authorized) {
        return {
            text: isZh ? 'Antigravity 运行中' : 'Antigravity active',
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
