# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 Semantic Versioning。

## [0.1.0] - 2026-09-04

### Added

- **deepseek-harness-desktop v1（Tauri 桌面封装，跨平台）**
  - Tauri v2 原生壳：内置 `dsh web` 本地服务器 + 系统 WebView 加载 Harness Web GUI
  - 运行时自包含：捆绑 Node v22.23.1 与 npm 发布包 `@deepseek-ai/dsh@0.1.2-rc.1`（521 依赖、离线运行）
  - 启动流程：`--no-open --port 0` 拉起服务 → 解析 `dsh web: <url>` 就绪行 → WebView 导航（对齐
    harness postmortem：HTTP 200 ≠ 应用就绪，冒烟测试断言页面含 `__DSH_BOOT__`）
  - 生命周期：窗口关闭 / 应用退出时终止 dsh 进程树
    （Unix process-group SIGTERM→SIGKILL；Windows `taskkill /T /F`），无孤儿进程
  - 错误处理：启动失败 / 服务崩溃 / 就绪超时（30s）展示可读错误页（退出码 + stderr 尾部）
  - 单实例运行（tauri-plugin-single-instance），防双开
  - 配置复用：沿用用户主目录 `~/.dsh` 的 CLI 配置与凭据
  - 构建流水线：GitHub Actions 三平台矩阵
    （Windows NSIS / macOS dmg (arm64) / Linux deb+AppImage (x64)），tag 发布自动附安装包
  - 测试：URL 行解析（跨 chunk、\r\n、LAN 后缀、无关行、空 URL）、运行时解析（缺失 node / 缺失
    dsh 入口 / env 覆盖 / dev 回退 / 中文空格路径）、spawn 参数、stderr 环形缓冲、进程树终止、
    进程级冒烟测试（真实拉起 dsh web 并校验 `__DSH_BOOT__`）

### Fixed

- **macOS Gatekeeper「已损坏，无法打开」**：macOS 安装包改为 ad-hoc 代码签名
  （`bundle.macOS.signingIdentity: "-"`），下载后不再报「已损坏」，仅出现标准的
  「无法验证开发者」确认提示；CI 增加 `codesign --verify --deep --strict` 签名校验步骤。
  README 补充隔离属性清除命令（`xattr -cr …`）与旧包临时签名方法。
- **WebView 偶发停在「dsh web authentication required」**：WebView 首请求若早于浏览器
  鉴权 fence 就绪会收到 401；新增导航监视器（轮询 WebView URL 并做 `catch_unwind`
  防护），检测到 token 交换未完成（URL 仍带 `token=`）时自动以同一启动 token 重新
  导航重试，直至落在干净 `/`。复现验证：直接流程 4/4 收敛；代理观测确认 wry 完整
  走通 303→cookie→200。