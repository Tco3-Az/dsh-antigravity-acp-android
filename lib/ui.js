export function unauthCardView(options = {}) {
  const isZh = (options.lang ?? 'zh').startsWith('zh');
  return {
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

export function connectedCardView(options = {}) {
  const isZh = (options.lang ?? 'zh').startsWith('zh');
  const model = options.model ?? 'server-default';
  const percent = options.quotaPercent ?? 100;
  const reset = options.resetTime ?? (isZh ? '每日重置' : 'Daily');

  return {
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
  const isZh = (lang ?? 'zh').startsWith('zh');
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
