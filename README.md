# dsh-desktop

将 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）封装为桌面应用的仓库：基于 **Tauri v2**，
内置真实的 `dsh web` 本地服务器（npm 发布包 `@deepseek-ai/dsh`），用系统 WebView 把 Web GUI 装进原生窗口。
支持 **Windows、Linux、macOS** 三平台，一键安装、双击即用、完全离线运行（仅用户自己的 LLM API 需要网络）。

## 特性

- 安装即可用：无需 `Node.js`、无需命令行，应用自带 Node 运行时与 `dsh` 本体
- 复用 CLI 配置：会话、凭据、设置与 `dsh web` / `dsh` CLI 完全一致（存放于用户主目录 `~/.dsh`）
- 进程级可靠性：随窗口关闭彻底退出本地服务器（无残留进程），启动失败展示可读错误页
- 三平台安装包由 GitHub Actions 自动构建并随 Release 发布

## 安装包

在 [Releases](https://github.com/CodeFuckee/dsh-desktop/releases) 页面下载对应平台安装包：

| 平台 | 格式 |
| --- | --- |
| Windows | `DeepSeek-Harness-Desktop-<version>-x64-setup.exe`（NSIS） |
| macOS (Apple Silicon) | `DeepSeek-Harness-Desktop_<version>_aarch64.dmg` |
| Linux (x64) | `.deb`（Debian/Ubuntu）或 `.AppImage` |

> v1 安装包**未签名**：macOS 首次打开请右键 →「打开」；Windows SmartScreen 提示时选择「仍要运行」。

## 从源码开发

前置：`Node.js >= 22.19`、`Rust`、`pnpm` 或 `npm`（仅用于准备运行时）。Linux 还需 Tauri v2 系统依赖
（`libwebkit2gtk-4.1-dev` 等，见 `docs/build.md`）。

```sh
git clone --recurse-submodules https://github.com/CodeFuckee/dsh-desktop.git
cd dsh-desktop

npm install                # 安装 @tauri-apps/cli
npm run prepare:runtime    # 下载 Node v22.23.1 + npm 安装 @deepseek-ai/dsh@0.1.2-rc.1 到 src-tauri/runtime
npm run tauri:dev          # 开发模式：启动桌面窗口（自动拉起 dsh web）
```

## 构建安装包

```sh
npm run prepare:runtime -- --target <triple>   # 按目标平台准备运行时
npx tauri build --bundles dmg                  # Windows: nsis；Linux: deb,appimage
```

三平台安装包由 `.github/workflows/build-desktop.yml` 自动构建：打 `v*` tag 即触发，并在 GitHub Release 附加产物。

## 架构速览

```
双击应用
  └─ Tauri (Rust) 壳
       ├─ spawn: <内置 node> <内置 dsh lib/bin.js> web --no-open --port 0
       ├─ 解析 stdout 的 "dsh web: <url>" 就绪行
       ├─ WebView 导航到该 URL（加载 Harness Web GUI）
       └─ 窗口关闭 → 终止 dsh 进程树（无孤儿进程）
```

详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 与 [docs/build.md](docs/build.md)。

## 常见问题

- **Linux 双击 AppImage 无反应**：目标机需安装 WebKitGTK：`sudo apt install libwebkit2gtk-4.1-0`；Debian 系推荐 `.deb`。
- **Windows 提示缺少 WebView2**：Windows 11 自带；Windows 10 需安装
  [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)。
- **端口冲突**：应用固定使用 `--port 0`（OS 自动分配），无需担心。
- **第一次打开较慢**：首次启动需加载 500+ 个内置模块，约 1–3 秒，属正常。

## 目录结构

```
scripts/            prepare-runtime / smoke-test / gen-icon
ui/                 启动页与错误页（静态，无构建器）
src-tauri/          Rust 壳（tauri.conf.json、src/lib.rs、src/server.rs）
deepseek-harness/   只读子模块（参考源码，桌面版不修改）
.github/workflows/  三平台构建
```

## 后续规划

macOS x64 / universal、Windows/Linux arm64、代码签名与公证、自动更新、系统托盘、正式品牌图标。

## License

MIT，见 [LICENSE](deepseek-harness/LICENSE)（DeepSeek Harness 本体为 MIT）。