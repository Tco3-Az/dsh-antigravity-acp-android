# dsh-antigravity-acp (Android Native)

DeepSeek Harness (DSH) 原生适配 Android 端 [dsh-go](https://github.com/ccch1mneyyy/dsh-go) 的 Google Antigravity ACP 插件。

面向 Android 12、PRoot Ubuntu 24.04 与 39 位用户虚拟地址空间（`CONFIG_ARM64_VA_BITS=39`）的兼容适配。官方服务端 1.3.0 已通过受限 QEMU 启动与 ACP 初始化验证；Android 真机会话与辅助进程仍需进一步验证，不能将模拟测试通过等同于完整移植成功。

---

## 核心特性

- **TCMalloc：39 位地址空间内使用 Tag35 布局**：
  - 随机基址使用 bit 0..34（小于 32GiB），Tag 使用 bit 35..37，组合提示地址小于 256GiB，保留 512GiB 内核上界。
  - 同步修正指针 Tag、释放掩码、guarded 分支，以及 `PageId = address >> 13` 的 Tag 提取（bit 22..24）、掩码和相邻比较常量。
  - 旧版遗漏 PageId 路径，会使释放路由进入错误的分配器并破坏空闲链表；保留 `Span` 安全断言与 PageMap 几何，不通过 NOP 绕过校验。
  - 支持原始 Tag42、实验 Tag39 与旧版不完整 Tag35 的迁移。Tag39 不适合作为最终布局：非零 Tag 会将 mmap 提示推到 512GiB 以上。
- **PRoot `memfd` dlopen 绕过层 (`dlopen-shim.so`)**：
  - 拦截并物化 `_elfzipimport` 无法通过 `/proc/self/fd/N` 直接加载的 `.so` 动态库，自动落盘临时目录并安全执行 `dlopen`。
- **Seccomp 与系统调用降级**：
  - 仅修补有 `svc #0` 或已验证 wrapper 上下文的 `faccessat2`（439）调用点至 `faccessat`（48）；不再把裸常量 439、JPEG/SVE 数组索引或调试行号误当成系统调用。此降级不模拟 faccessat2 的全部 flags 语义。
- **运行期网络与进程沙箱护栏**：
  - 剥离 SOCKS/ALL_PROXY 干扰，强制回环路由 `NO_PROXY=127.0.0.1,localhost,::1`；
  - 强制使用 Go 原生纯代码 DNS 解析器（`GODEBUG=netdns=go`）；
  - 剥离 Termux Bionic 的 `libtermux-exec` 避免与 glibc 产生符号冲突。
- **三级原生 OAuth 闭环**：
  - 支持调用系统默认浏览器、DSH Go 原生卡片呼起、以及后台进程冻结时的授权链接中继。
- **Material 3 极简美学**：
  - 零渐变发光、零荧光色、严格限制文案长度，完美贴合 DSH Web 与 Native 主题。

---

## 快速上手 (dsh-go)

在 `dsh-go` 运行时容器终端中执行：

```bash
# 1. 安装插件 Bundle
dsh plugin --profile web add github:Tco3-Az/dsh-antigravity-acp-android

# 2. 检查运行环境与 PRoot 签名
dsh-antigravity-acp doctor

# 3. 自动下载官方 Linux ARM64 服务端并应用本地修补
dsh-antigravity-acp setup

# 4. 在 DSH Composer 或会话侧边栏开启 Antigravity 即可开始会话
```

---

## 验证与当前边界

```bash
npm test
npm run check:secrets
```

`npm test` 先构建再执行回归，覆盖 PageId Tag 路由、原始／旧版迁移、重复执行幂等性、ELF 节区隔离、误匹配保护、大文件修补、256k 上下文容量、MCP 工具结果续传与 Mock ACP/OAuth。真实二进制集成测试默认跳过，可通过 `AGY_TEST_BINARY` 显式指定输入；测试只修改临时副本。

### 官方服务端验证（2026-11-08）

在专用 Ubuntu 24.04 aarch64 用户态测试环境中，使用 QEMU `-R 512G` 限制地址空间：

- 真实服务端 1.3.0：完整补丁修改 `google_malloc` 的 334 条指令；第二次执行修改数为 0。
- `--version`：成功退出并输出 `Build label: 1.3.0`，一次隔离重试约 45 秒；并发调试时曾超过 75 秒，不能承诺固定启动耗时。
- 真实 ACP `initialize`：约 47 秒收到成功响应，`agentInfo.version = 1.3.0`；不是 Mock 响应。
- 未执行用户登录、密钥配置或模型调用，未完成 Android 真机端到端验证。
- `localharness_external` 及其嵌入 ELF 已纳入补丁；辅助进程在受限 QEMU 下仍触发 QEMU 自身的 `page_find_range_empty` 断言，**辅助进程功能尚未验证通过**。不限制地址空间时仅运行到缺少输入配置的 EOF，不能视为完整通过。

在专用 Linux/WSL 环境中，使用自己的绝对路径运行；不要把测试指向个人默认发行版：

```bash
node lib/cli.js patch /path/to/agy_acp_server.par
qemu-aarch64-static -R 512G \
  -E LD_PRELOAD=/path/to/bin/dlopen-shim.so \
  /path/to/agy_acp_server.par --version
```

Android 安装缓存收据使用 `androidPatchRevision = 2`，旧收据会重新准备，避免把旧版残缺补丁当成就绪。预先打过任意范围替换／NOP 诊断补丁的文件，建议从官方压缩包重新提取后修补，不能假定所有历史误改均可逆。

## 上下文窗口与容量保护

- **固定 256k = 256,000 tokens**（十进制，不是 262,144）。所有模型 ID，包括 `server-default`，通过 DSH 的 `resolveModelInfo` 得到 `context.contextWindow = 256000`，供宿主上下文管理使用；不依赖模型目录是否已发现。
- 这是插件统一容量策略，不代表已测量每个上游模型的真实最大容量。服务端若通过 `usage_update` 报告更小窗口，该会话按更小值保护；更大的报告不会突破 256k。
- 256k 是输入与输出的总窗口，并非允许历史填满 256k 再生成。默认预留 **16,000 tokens 输出／思考空间 + 8,000 tokens ACP 内部开销**，本地发送前检查预算为 **232,000 tokens**。
- 本地检查覆盖系统提示词、完整历史、工具声明、工具结果，并在创建服务端进程前拒绝明显过大的初始请求；MCP 续传会在释放任何工具结果前检查整批内容及最近一次服务端上下文占用。
- ACP 没有通用精确 tokenizer 接口，本地采用 **UTF-8 字节数 ÷ 3 向上取整**的启发式估算，**不是精确 token 数，也不能保证绝不超限**。官方 `usage_update` 及服务端超限响应另行处理；占用不会伪装成计费 usage。
- 超限统一返回 `CONTEXT_LENGTH_EXCEEDED`，保留原历史，提示压缩 DSH 对话或新建会话，不静默截断。该补丁提供容量元数据与保护，不声称已完成真机自动压缩闭环，也不伪造 ACP 不支持的 `maxTokens` 请求参数。

### prerelease 真机改动同步

本次基于 `0.0.1rc`／`fc1d641` 快进同步：保留真机调整的 OAuth 冷启动授权链接等待 **10,000ms**（此前 2,500ms），源码和发布用 `lib` 一致，并加入回归检查。未改写该预发布标签，也未创建新的 GitHub Release。

## 已登录后的模型与思考等级

- 同时读取服务端 `configOptions` 和兼容版 `models.availableModels`；不硬编码账号可用模型，不要求已登录用户重复 OAuth。
- 登录成功／模型状态更新时通知 DSH 刷新模型目录；保留 `server-default` 别名，避免界面旧选择在目录更新后失效。
- 已登录面板显示服务端实际模型名，提供可取消的“刷新模型”。额度与重置时间未由服务端提供时显示“服务端未提供”，不再默认显示 100% 或每日重置。
- `xhigh`、`max` 都映射为 `high`；普通请求和 MCP 工具会话共用同一路径。若服务端没有独立 `thought_level` 选择器，继续使用原模型 ID 的思考档位，不伪造参数或改写提示词。
- 新增回归覆盖已登录发现、现代／兼容版模型切换、状态通知、原生面板延后刷新，以及真实 DSH 宿主对 `xhigh`／`max` 的请求校验。这些测试不使用真实账号或付费模型调用，账号端到端结果仍需实测。

## 隐私与提交

- 不要提交 `.env`、访问令牌、API key、OAuth 凭据、私钥或个人运行日志。
- `npm run check:secrets` 检查 Git 跟踪文件与待提交的新文件，失败时只输出文件位置和类型，不打印匹配值。
- 本地大型服务端、压缩包、测试日志与私密配置默认忽略；仅提交插件源码、构建产物、测试与公开文档。
- 扫描是防误提交措施，不是“绝无敏感信息”的保证。若凭据曾发布，应撤销／轮换；删除工作区文件不会移除 Git 历史或聊天记录。

---

## 许可证

[MIT License](LICENSE)
