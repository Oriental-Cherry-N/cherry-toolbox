# Cherry Toolbox

Cherry Toolbox 是一个仅面向 Windows 的个人桌面工具箱。当前版本为 `0.1.0`，现阶段只通过源码启动，不提供 Setup 安装程序或 GitHub Release。

> 修改源码后先退出正在运行的 Cherry Toolbox，再运行 `start-source.cmd`、`start-source.vbs` 或项目快捷方式，新实例会编译当前工作区代码。程序已经运行时，再次双击只唤醒现有窗口，不重建文件。

## 本次安全版本的边界

这个版本把“可恢复”放在功能数量之前：

- **不对 ChatGPT 桌面端施加任何代理或分流设置。** “指定网站”模式保留 ChatGPT/OpenAI 域名保护；新增的“ChatGPT 网页”模式仅代理专门打开的临时浏览器。检测到 ChatGPT 进程运行时，网卡启停仍会被阻止。
- 安全网站代理不修改 WinINET、WinHTTP、环境变量、DNS、路由、网卡指标或 FlClash 配置，不启用 TUN，也不请求 UAC。
- 微信功能强制为试运行。界面固定勾选、主进程拒绝 `dryRun=false`，Python worker 内也不存在真实发送分支。
- 离开任一工具页面会先等待该工具停止或恢复；恢复失败时留在原页面。退出应用也必须先完成恢复，没有“保持现状并退出”或“丢弃恢复记录”。

## 已有工具

### 网卡开关

- 读取 Windows 网络适配器、连接状态和管理状态。
- 启用或禁用前保存原始状态；禁用最后一张已连接网卡会被拒绝。
- ChatGPT 桌面进程正在运行或无法完成进程检查时，所有网卡变更都会失败关闭。
- 每次事务使用三份带 SHA-256 校验和与递增序号的恢复日志：`recovery.v4.json`、`recovery.v4.backup.json`、`recovery.v4.previous.json`。三份都保存最新完整状态，全部写入并复核后才允许修改网卡；恢复完成写入持久的完成标记，防止旧副本复活。
- 第一次实际变更会请求 UAC，并启动编译后的独立恢复程序。管理员端通过命名管道校验调用进程、创建时间和 Windows 账户，只接受 GUID 指定的网卡启停/恢复命令，并重新检查 ChatGPT 和最后连接网卡保护。
- 管理员端在 `%ProgramData%\CherryToolboxAdapterRecovery\<账户 SID>` 另外保存普通用户不可写的原始状态。启动会检查该副本；每张网卡独立恢复，一张缺失不会阻止其他网卡恢复。
- Electron 主进程退出、崩溃或心跳超过 10 秒未更新时，看门狗会持续重试恢复原始网卡状态。
- 正常离开“网卡开关”页面、点击“立即恢复”或退出程序都会等待看门狗确认恢复；如看门狗不可用，再使用一次性提权恢复兜底。
- 断电时没有进程能够继续执行；恢复日志会保留，下一次启动先恢复，完成前禁止新的网卡修改。
- 三份日志全部损坏、网卡被物理移除或用户拒绝恢复所需的 UAC 时，程序不会假装成功，也不会删除证据。

### 浏览器分流

这个组件为一个临时 Edge/Chrome 浏览器提供分流。浏览器使用固定的 `--proxy-server`，经过本机网关和独立 Mihomo 内核选择路径。其他应用和普通浏览器保持现有网络设置。两种模式互斥，运行中不能切换：

| 模式 | 临时浏览器内的流量 |
| --- | --- |
| 指定网站 | 普通网站和受保护的 OpenAI 域名绑定有线网卡直连；选定网站通过独立内核使用所选 WLAN。 |
| ChatGPT 网页 | 整个临时浏览器的 HTTP/HTTPS 请求统一经所选节点和 WLAN，包括登录跳转、页面资源与文件请求；不依赖 ChatGPT 域名清单。 |

默认代理目标是 `ipinfo.io` 及其子域，也可以填写自定义域名后缀。匹配采用域名边界，例如 `api.ipinfo.io` 会匹配，`fakeipinfo.io` 不会匹配。保护名单优先于用户规则；顶级域名和覆盖保护名单的父域后缀也被拒绝。固定代理失效、网卡断开或绑定失败会中止连接，没有跨网卡后备。

在“指定网站”模式中，ChatGPT、OpenAI 及相关服务域名仍是硬编码保护名单。旧设置中的 ChatGPT 开关会被归一化为关闭，自定义列表也不能绕过；只有明确选择“ChatGPT 网页”才进入新模式。程序只读取 FlClash 选中节点及本地缓存，将节点复制到会话独享的配置中。既有 FlClash 的订阅、数据库、节点选择、mixed port、接口绑定和运行状态保持原样。

当前隔离模式支持 **IPv4、80/443 端口的 HTTP/HTTPS 网站和 TCP 代理节点**。DNS 查询也绑定指定网卡，不使用系统 DNS 后备；所选 DNS 服务器需要支持 TCP 查询。浏览器关闭 QUIC、非代理 WebRTC UDP、扩展和后台网络活动。“指定网站”模式禁用 HTTP/2，避免跨域复用连接；“ChatGPT 网页”只有一条代理路径，保留 HTTP/2 和 TCP 长连接，暂不开放语音。IPv6、UDP 节点、外部插件及可能覆盖隔离设置的企业浏览器策略会被拒绝，不能把本组件当作整机 VPN。

浏览器控制使用父子进程继承的匿名管道，不开放 DevTools 调试端口。登录、缓存和自动下载文件都位于一次性配置目录中，退出时一并清理；每次新会话需要重新登录。代理隧道建立后不再套用 15 秒握手超时。

#### 首次使用

1. 在 FlClash 中自行开启外部控制接口，并确认它只监听 `127.0.0.1` 或 `::1`，默认控制端口为 `9090`。若设置密钥，Cherry Toolbox 只在当前内存中使用。
2. 自行启用 FlClash mixed port，并确保 mixed proxy 也只监听本机回环地址。若监听 `0.0.0.0`、`::` 或局域网地址，预检会拒绝启动。
3. 在 FlClash 的 GLOBAL 中选定具体 TCP 节点，同时连接有线和 WLAN。在“浏览器分流”中选择模式与实际出口网卡；“指定网站”保留 `ipinfo.io` 或添加域名，“ChatGPT 网页”无需填写域名。
4. 点击“运行预检”。预检只读检查 FlClash、浏览器、网卡以及全局网络指纹。
5. 点击“打开隔离浏览器”。程序会打开一次性浏览器配置；“ChatGPT 网页”进入 `https://chatgpt.com/`，“指定网站”默认进入 `ipinfo.io`。
6. 页面加载后点击“验证流量路径”。“指定网站”检查 `api.ipify.org` 和 `ipinfo.io`；“ChatGPT 网页”检查该窗口的 ChatGPT 安全页面、ChatGPT 代理连接记录、代理出口以及专用内核 PID 的活动连接。两种模式都核对全局网络指纹，证据不足会停止会话。该检查验证网络路径，不代表已验证登录、聊天和文件处理功能。
7. 关闭隔离浏览器、离开页面或退出 Cherry Toolbox 时，浏览器进程树、本机网关、独立内核和临时目录都会被清理。浏览器与内核在执行第一条指令前就加入 Windows Job；父程序通信中断或守护进程退出也会终止受管进程。

网卡选择现在直接影响连接绑定。无需修改 Windows 路由或共享 FlClash 的接口配置。每次会话仍需按“验证流量路径”确认实际环境；代码和自动测试通过不等于已经在你的双网卡环境完成验收。

全局网络指纹覆盖 Windows 代理、默认路由、DNS、接口指标、`IgnoreDefaultRoutes`、WinHTTP 数据和 FlClash 规范配置摘要。如果会话期间其他软件主动修改这些项目，退出时只报告漂移，不覆盖外部改动。

#### 旧版本恢复

如果磁盘上仍有旧版全局分流的 v1/v2 恢复记录，启动时只允许执行兼容恢复：依次恢复旧 PAC、FlClash 运行态、路由/接口和 WinINET 快照。每一步都继续尝试，其余步骤成功也不会掩盖失败；仅在全部验证成功后清除恢复记录。在此之前不能启动安全网站代理或执行新的网络修改。

### 微信消息检测

- 面向微信 `4.1.12.26`，使用固定提交 `109724b7` 的上游 `pyweixin` UI 元素与导航能力。
- 请先手动打开白名单联系人各自的独立私聊窗口。程序只读取已有窗口，不自动开窗、不抢焦点、不最小化；群聊、非好友和名称不一致会被拒绝。
- 只报告新消息检测结果，不读取微信进程内存，不注入 DLL，不 Hook 微信，不模拟协议，也不发送消息。
- 试运行复选框不可关闭；即使绕过界面提交 `dryRun=false`，主进程和 worker 也会拒绝。
- Windows 锁屏或休眠会停止 worker，不自动恢复。离开页面或退出应用会等待 worker 完全停止，必要时终止其进程树。
- 消息正文不会被 Cherry Toolbox 记录或持久化。报告的是新增的非系统消息项目，可能包含自己发送的消息；本版本不通过截图或焦点操作区分收发方向。

### 设置与恢复范围

网卡选择、分流参数、微信检测参数只在组件会话内应用，离开组件后恢复载入时的设置，不覆盖既有设置文件。自动清理保留失败记录并允许重试；完成标记和必要恢复证据会留在磁盘，作为审计与防止旧事务重新生效的依据。

程序能恢复自身拥有的网卡管理状态、进程和临时文件，不能撤销网络请求已经造成的远端影响，也不能在断电期间运行。网页下载到用户另选目录的文件、用户主动进行的网页操作，以及其他软件的网络修改不属于自动删除/覆盖范围。

首次使用需要创建项目专属 Miniconda 环境：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-wechat-auto-reply.ps1
```

项目专属依赖由 `python/requirements-wechat-auto-reply.lock` 固定版本和 SHA-256；安装后还会复核上游 Git 提交。

## 安全中心

主页会显示：

- 三副本恢复日志是否可用；
- 独立网卡恢复看门狗是待命还是监控中；
- 网站代理是否保持“零全局写入”；
- ChatGPT 桌面客户端是否保持原有网络保护；
- 微信是否保持“仅检测”；
- 当前等待恢复的网卡事务与组件清理数量；清理失败时显示阻止状态，恢复完成前拒绝新变更。

## 系统与开发要求

- Windows 10 或更高版本
- 系统自带 .NET Framework 4.x（编译和运行固定安全程序）
- Node.js 22.12 或更高版本
- npm
- Microsoft Edge 或 Google Chrome（安全网站代理）
- FlClash（仅在使用安全网站代理时需要，且由用户自行运行）
- Miniconda、Python 3.11 和已登录的微信 `4.1.12.26`（仅在使用微信检测时需要）

只有“网卡开关”会请求管理员权限；安全网站代理和微信检测不会修改系统网络。

## 本地开发与源码启动

```powershell
npm ci
node scripts/setup-routing-core.cjs
npm start
```

也可以创建双击快捷方式：

```powershell
npm run shortcut:source
```

之后双击项目根目录中的 `Cherry Toolbox.lnk`。快捷方式记录绝对路径；项目目录移动后需重新生成。

```powershell
.\start-source.cmd           # 显示诊断窗口并启动
.\start-source.cmd --hidden  # 启动后隐藏到托盘
.\start-source.cmd --check   # 只检查环境

wscript .\start-source.vbs           # 隐藏 CMD 并显示应用
wscript .\start-source.vbs --hidden  # CMD 和应用窗口都隐藏
wscript .\start-source.vbs --check   # 无窗口检查环境
```

常用命令：

```powershell
npm run build:icon
npm run typecheck
npm test
npm run verify
npm run package
npm run clean
```

自动测试使用模拟接口、临时目录和受管的无害 Windows 子进程，不切换真实网卡、不修改路由、不改系统代理，也不启动真实 FlClash 或微信。独立内核使用官方固定版本 `v1.19.30`，安装脚本验证发布档案 SHA-256；配置验证使用 `mihomo -t`，不连接节点。

前一阶段修复见 [安全修复记录](docs/SAFETY-REPAIR.md)。新版网页分流的使用方式、89 项回归测试和实机验收边界见 [ChatGPT 网页分流说明](docs/CHATGPT-WEB-ROUTING.md)。

2026-09-11 的 [页面切换延迟修复](docs/NAVIGATION-PERFORMANCE.md) 去掉了未修改网卡时退出页面的七次重复 PowerShell 查询，并补上清理等待提示。

随后完成的 [网卡握手与退出修复](docs/ADAPTER-HANDSHAKE-REPAIR.md) 修正了原生管道句柄、身份验证顺序、失败清理及恢复后的退出判定，并增加取消启动和具体进度提示；回归测试为 115 项。

2026-09-12 的 [辅助程序版本隔离修复](docs/HELPER-BUILD-ISOLATION.md) 处理了再次构建导致运行实例校验失败的问题。辅助程序按哈希保留多个版本；重复启动先检查实例；完整性预检失败不会新增网卡恢复记录。

## 架构

- `native/`、`src/main/structured-adapter-broker.ts`：固定程序、管理员恢复副本、命名管道和 Windows Job。`adapter-recovery-broker.ts` 仅用于旧会话兼容恢复。
- `src/main/recovery.ts`：三副本校验恢复事务及旧版迁移。
- `src/main/isolated-browser.ts`、`browser-control.ts`、`dedicated-routing.ts`、`browser-routing-verification.ts`：固定代理、匿名管道控制、专用内核、临时资源与真实浏览器验证。PAC 仅保留旧版兼容。
- `src/main/system-network-fingerprint.ts`：只读全局网络状态摘要。
- `src/main/safety-guard.ts`：ChatGPT 进程和最后连接网卡保护。
- `src/common/`：强类型 IPC 通道和最小化 preload API。
- `src/renderer/`、`static/`：工具导航、安全中心、国际化和界面。
- `test/`：构建契约、失败注入、恢复幂等和输入边界测试。

渲染进程不能直接调用 Node.js、Electron 或系统命令。主进程只接受来自本地应用页面的固定 IPC 通道，并验证来源和所有输入。

## 项目来源与许可证

Cherry Toolbox 使用独立仓库与独立 Git 历史。首个工具基于 [NzoSifou/connection-switcher](https://github.com/NzoSifou/connection-switcher) 及 [Oriental-Cherry-N/connection-switcher](https://github.com/Oriental-Cherry-N/connection-switcher) 的现代化版本导入；原有 Connection Switcher GitHub 仓库保持独立，不会由本仓库替代或改写。详细署名见 [NOTICE](NOTICE)。

本项目采用 [GPL-3.0-or-later](LICENSE) 许可证。
