# Cherry Toolbox

Cherry Toolbox 是一个仅面向 Windows 的个人桌面工具箱。它把常用的小功能收进同一个应用，通过统一的主页和侧边导航逐步扩展；首个内置工具是 **Network Switcher（网络切换器）**。

当前版本：`0.1.0`。

> 当前阶段只通过源码启动，不提供 Setup 安装程序或 GitHub Release。修改源码后重新运行 `start-source.cmd` 或 `start-source.vbs`，启动入口会自动重新编译最新代码。

## 已有工具

### Network Switcher

- 自动读取 Windows 网络适配器、连接状态和管理状态
- 记住上次选择的网卡；网卡消失时自动选择可用项
- 从工具页面或系统托盘启用、禁用和刷新网卡
- 禁用前二次确认，仅在实际更改网卡时请求管理员权限
- 启用网卡后短时观察连接过程并自动更新界面
- 变更前写入原子恢复日志，正常退出时恢复本程序改动的网卡状态
- 异常结束后提示恢复、保留当前状态或稍后处理
- 英文、法文和简体中文界面，自动跟随系统语言

恢复机制只跟踪本工具实际执行的网卡启用/禁用操作，不会覆盖 DNS、IP、路由或代理配置。关闭或最小化主窗口时应用会隐藏到托盘；从托盘退出时会先尝试恢复已记录的网卡状态。

## 系统与开发要求

- Windows 10 或更高版本
- Node.js 22.12 或更高版本
- npm

网络切换器依赖 Windows 自带的 PowerShell `Get-NetAdapter`。更改或恢复网卡状态时会弹出 UAC 确认框；取消授权不会更改系统状态。

## 本地开发

```powershell
npm ci
npm start
```

安装依赖后，也可以使用项目根目录中的双击启动入口：

```powershell
.\start-source.cmd           # 显示诊断窗口并启动应用
.\start-source.cmd --hidden  # 启动后隐藏到系统托盘
.\start-source.cmd --check   # 仅检查本地运行环境

wscript .\start-source.vbs           # 隐藏 CMD，显示应用窗口
wscript .\start-source.vbs --hidden  # CMD 和应用窗口都隐藏
wscript .\start-source.vbs --check   # 无窗口检查运行环境
```

常用命令：

```powershell
npm run build:icon # 从品牌 PNG 重新生成多尺寸 Windows ICO
npm run typecheck  # 严格 TypeScript 检查
npm test           # 构建并运行测试
npm run verify     # 类型检查 + 测试
npm run clean      # 删除 dist、out 和 .tmp 生成目录
```

## 架构

- `src/main/`：Electron 主进程、托盘、设置、恢复机制和 Windows 网卡操作
- `src/common/`：强类型 IPC 通道和最小化 preload API
- `src/renderer/`：工具注册、导航、国际化和各工具的界面逻辑
- `static/`：应用外壳、样式和品牌资源
- `test/`：构建契约、解析器、输入验证、恢复与设置测试

渲染进程不能直接调用 Node.js、Electron 或系统命令。主进程只接受来自本地应用页面的固定 IPC 通道，并验证所有网卡操作输入和来源。

## 项目来源与许可证

Cherry Toolbox 使用独立仓库与独立 Git 历史。首个工具基于 [NzoSifou/connection-switcher](https://github.com/NzoSifou/connection-switcher) 及 [Oriental-Cherry-N/connection-switcher](https://github.com/Oriental-Cherry-N/connection-switcher) 的现代化版本导入；原有 Connection Switcher GitHub 仓库保持独立，不会由本仓库替代或改写。详细署名见 [NOTICE](NOTICE)。

本项目采用 [GPL-3.0-or-later](LICENSE) 许可证。
