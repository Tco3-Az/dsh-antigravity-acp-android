# dsh-antigravity-acp (Android Native)

DeepSeek Harness (DSH) 原生适配 Android 端 [dsh-go](https://github.com/ccch1mneyyy/dsh-go) 的 Google Antigravity ACP 插件。

针对 Android 12+、PRoot Ubuntu 24.04、Termux Bionic 及 39 位用户虚拟地址空间（`CONFIG_ARM64_VA_BITS=39`）进行了全链路深度内核级与内存分配器级适配。

---

## 核心特性

- **TCMalloc VA35 严格空间隔离**：
  - 针对 Android 39 位内核（512GB 用户空间上限，如华为鸿蒙/EMUI 等设备）进行物理分区。
  - 将堆基址空间严格限制在 35 位（$< 32\text{ GB}$，掩码 `0x7ffffffff`），Tag 偏移置于 bit 35..37。
  - 达成数学级零碰撞（$\text{Base} \ \& \ \text{Tag} \equiv 0$），Hint 上限严格控制在 $256\text{ GB} < 512\text{ GB}$，彻底消除 `AllocSlow OOM`、`Span CHECK` 与 `ReportCorruptedFree`。
- **PRoot `memfd` dlopen 绕过层 (`dlopen-shim.so`)**：
  - 拦截并物化 `_elfzipimport` 无法通过 `/proc/self/fd/N` 直接加载的 `.so` 动态库，自动落盘临时目录并安全执行 `dlopen`。
- **Seccomp 与系统调用降级**：
  - 就地修补官方 ARM64 二进制中的所有 `faccessat2`（Syscall 439）为兼容老旧内核与 PRoot 的 `faccessat`（Syscall 48）。
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

## 本地环境离线校验 (Local Verification)

为避免反复打包推送到真机测试，本项目提供完整的本地离线断言与仿真方案：

### 1. 离线数学不变式检测（0.1 秒，推荐）
```bash
npm test
```
自动运行 6 项测试套件，通过数学位运算验证：
- 基址掩码与 Tag 掩码零碰撞（`kBaseMask & kTagMask == 0`）；
- 所有 Tag 组合 Hint 地址均 $< 512\text{ GB}$；
- Span PageId index 严格小于 $2^{35}$（`kMaxPageIdBits`）；
- 快速释放路径 dealloc 掩码对称性与就地平滑迁移幂等性。

### 2. WSL2 / QEMU 用户态 39 位仿真（3 秒）
```bash
# 在 WSL2 Debian 中限定 512GB (2^39) 虚拟地址空间运行测试
wsl -d Debian qemu-aarch64-static -R 512G \
  -E LD_PRELOAD=./bin/dlopen-shim.so \
  ./agy_acp_server.par --uid=
```

---

## 许可证

[MIT License](LICENSE)
