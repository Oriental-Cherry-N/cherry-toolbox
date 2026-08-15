# Connection Switcher

Connection Switcher 是一个仅面向 Windows 的轻量桌面工具，用于查看、选择、启用或禁用网络适配器。它常驻系统托盘，只在实际更改网卡状态时请求管理员权限。

## 功能

- 自动读取并展示 Windows 网络适配器、连接状态和管理状态
- 记住上次选择的网卡；网卡消失时自动选择可用项
- 从主窗口或系统托盘切换网卡
- 英文、法文和简体中文界面，自动跟随系统语言
- 禁用前二次确认，防止意外断网
- 启用网卡后短时观察连接过程，连接成功时自动更新界面，无需手动刷新
- 变更前写入原子恢复日志，正常退出时恢复由本程序改动的网卡状态
- 异常结束后在下次启动时提示恢复、保留当前状态或稍后处理
- 单实例运行，关闭或最小化窗口时隐藏到托盘
- 严格隔离渲染进程，并验证所有 IPC 输入和来源

## 系统与开发要求

- Windows 10 或更高版本
- 开发环境：Node.js 22.12 或更高版本、npm

应用依赖 Windows 自带的 PowerShell `Get-NetAdapter`。更改网卡状态会弹出 UAC 确认框；取消授权不会更改系统状态。

恢复机制只跟踪本程序实际执行的网卡启用/禁用操作，不会覆盖 DNS、IP、路由或代理配置。点击窗口右上角关闭按钮只是隐藏到托盘；从托盘真正退出时，程序会等待恢复完成。恢复同样需要 UAC 授权。若进程被强制结束、系统关机时来不及恢复或网卡暂时不存在，`recovery.json` 会保留到下次启动继续处理。

## 本地开发

```powershell
npm ci
npm start
```

首次执行 `npm ci` 安装依赖后，也可以直接双击项目根目录的 `start-source.cmd`。该脚本会编译最新源码并直接启动 Electron，不生成安装程序：

```powershell
.\start-source.cmd           # 正常显示窗口
.\start-source.cmd --hidden  # 启动后隐藏到系统托盘
.\start-source.cmd --check   # 仅检查本地运行环境
```

如果不希望看到 CMD 窗口，直接双击 `start-source.vbs`。它会在后台调用上述脚本，程序主窗口仍会正常显示：

```powershell
wscript .\start-source.vbs           # 隐藏 CMD，显示程序窗口
wscript .\start-source.vbs --hidden  # CMD 和程序窗口都隐藏，驻留托盘
wscript .\start-source.vbs --check   # 无窗口检查运行环境
```

常用命令：

```powershell
npm run typecheck  # 严格 TypeScript 检查
npm test           # 构建并运行单元测试
npm run verify     # 类型检查 + 测试
npm run package    # 生成未安装的应用目录
npm run make       # 生成 Windows 安装程序
npm run clean      # 删除 dist、out 和 .tmp 生成目录
```

安装程序默认生成在 `out/make/`。正式分发前建议为安装程序和可执行文件配置代码签名证书，以减少 Windows SmartScreen 警告。

## 架构与安全说明

- `src/main/`：窗口、托盘、设置持久化和 Windows 网卡操作
- `src/common/`：强类型 IPC 通道和最小化 preload API
- `src/renderer/`：无 Node.js 权限的界面逻辑
- `static/`：本地 HTML、CSS 和图标资源
- `test/`：解析器、输入验证和设置持久化测试

渲染进程不能直接调用 Node.js、Electron 或系统命令。主进程仅接受来自本地应用页面的固定 IPC 通道，并使用 GUID/哈希格式验证网卡标识。管理员 PowerShell 脚本通过结构化 Base64 JSON 传递数据，不拼接来自界面的命令文本。

## 注意事项

- 禁用当前正在使用的网卡会立即中断对应网络连接。
- 启用后最多观察连接状态约 45 秒；超过时限仍可手动刷新，观察过程不会重复执行启用命令。
- Windows 虚拟网卡、VPN、Hyper-V 或 WSL 网卡也可能显示在列表中。
- 本项目目前没有自动配置“开机启动”；如需该功能，应同时提供显式开关和卸载清理逻辑。

图标来自 [Freepik / Flaticon](https://www.flaticon.com/free-icons/connection)，许可证见原资源页面。项目源代码采用 [GPL-3.0-or-later](LICENSE)。
