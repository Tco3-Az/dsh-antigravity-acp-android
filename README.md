# dsh-antigravity-acp (Android)

DeepSeek Harness (DSH) 原生适配 Android 端 [dsh-go](https://github.com/ccch1mneyyy/dsh-go) 的 Google Antigravity ACP 插件。

## 特性

- **ARM64 ELF 二进制热修补**：纯 Node.js 实现 TCMalloc VA39 虚拟地址空间兼容与 Seccomp `faccessat2` 拦截修复。
- **PRoot 进程护栏**：强制隔离 `NO_PROXY`，剥离 SOCKS 冲突，适配 `--uid=` 参数。
- **三级原生 OAuth 闭环**：支持系统浏览器静默拉起、DSH Go 原生卡片唤起、以及后台冻结时的手动回调链接中继。
- **Flutter Material 3 极简美学**：无发光渐变，无冗余 Emoji，深度融入宿主主题。
