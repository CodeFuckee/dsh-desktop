# dsh-desktop 架构

## 1. 设计原则

- **桌面壳绝不 serve 前端**。Harness Web GUI 需要宿主的 `window.__DSH_BOOT__` 注入，唯一正确的宿主是
  真实的 `dsh web` 本地服务器（CLI 的 web profile）。桌面壳只负责：拉起该服务器 → 拿到就绪 URL →
  把 WebView 指过去。违背这一原则（例如自己起静态服务器）会得到"白屏但 HTTP 200"。
- **运行时自包含**：安装包内置 Node 可执行文件 + `node_modules`（npm 发布包 `@deepseek-ai/dsh`），
  运行期零网络依赖；`npm` 只出现在构建期。
- **复用用户环境**：沿用 `~/.dsh`（CLI 同款配置与凭据），无迁移、无双写。

## 2. 组件与数据流

```
┌─────────────────────────────── 桌面进程（Tauri/Rust） ───────────────────────────────┐
│                                                                                        │
│  setup()                                                                                │
│    ├─ resolve_runtime():                                                                │
│    │     DSH_DESKTOP_RUNTIME env  →  资源目录 runtime/  →  dev 回退 src-tauri/runtime│
│    └─ start_server(): spawn 后台线程：                                                 │
│          <node> <app>/node_modules/@deepseek-ai/dsh/lib/bin.js web --no-open --port 0  │
│            │── stdout 读取线程 ──> parse_url_line ──> "dsh web: <url>"                  │
│            │                              └────────────> WebView.navigate(url)          │
│            ├── stderr 读取线程 ──> 环形缓冲（200 行，供错误页展示）                     │
│            └── 监管线程：stdout+stderr 双双 EOF → wait() → 若未就绪则错误页             │
│                                                                                        │
│  窗口关闭 CloseRequested / 应用退出 RunEvent::Exit                                      │
│    └─ terminate(): Unix kill(-pgid) SIGTERM → 3s → SIGKILL；Windows taskkill /T /F     │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

就绪行由 harness 侧保证：web 运行时的 `printUrl` 默认 true，且只在 Loader 树沉降、`/api` 路由就绪后打印，
因此"拿到 URL 行"即"服务可服务"，无需再轮询健康检查（冒烟测试仍会 GET 校验页面含 `__DSH_BOOT__`）。

## 3. 运行时布局（安装包内）

`bundle.resources` 把 `src-tauri/runtime/**` 映射为资源目录下的 `runtime/`：

```
runtime/
├── node | node.exe          # Node v22.23.1（满足 engines ^22.19.0 || >=24.0.0）
├── version.json             # node/dsh/target/时间戳
└── app/
    └── package.json         # 固定依赖 @deepseek-ai/dsh@0.1.2-rc.1 + allowScripts
    └── node_modules/…       # npm 安装的完整依赖树（含 dsh-web-frontend dist、landlock-run 平台包）
```

Rust 侧用 `app.path().resource_dir()` 定位；开发模式经 `DSH_DESKTOP_RUNTIME` 环境变量或
`src-tauri/runtime`（`CARGO_MANIFEST_DIR` 下）回退。路径全程 `PathBuf`，兼容空格/非 ASCII。

## 4. 关键决策记录

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 框架 | Tauri v2 | 用户选定；包体小、系统 WebView |
| 运行时来源 | npm `@deepseek-ai/dsh@0.1.2-rc.1` | 与官方发布一致、构建简单、离线自包含 |
| 端口策略 | `--port 0`（OS 分配） | 彻底规避端口冲突，无锁文件/竞态 |
| 单实例 | tauri-plugin-single-instance | 防双写同一 `~/.dsh` |
| 进程清理 | 进程组/树 kill | 防 dsh 子会话残留 |
| node-pty/koffi | npm 12 `allowScripts` 放行 | 安装脚本产物（原生二进制）是加载所必需 |

## 5. 已知边界（v1）

- 平台矩阵：Windows x64 / Linux x64 / macOS arm64；其余架构待后续
- 安装包未签名：macOS Gatekeeper、Windows SmartScreen 需用户手动放行
- Linux AppImage 目标机需 WebKitGTK 运行时；Windows 10 需 WebView2 Runtime
- WebView 一致性依赖各平台系统 WebView（WebKitGTK / WebView2 / WKWebView）
- 无更新器、无托盘、无崩溃自动重启（后续迭代）

## 6. 测试体系

- Rust 单测（`cargo test`）：`parse_url_line`、`resolve_runtime`、`build_spawn_command`、
  `ServerState` 环形缓冲、Unix 进程树终止
- 进程级冒烟（`scripts/smoke-test.mjs`，每平台 CI 执行）：真实拉起 `dsh web`，断言就绪行、
  HTTP 200 且页面含 `__DSH_BOOT__`