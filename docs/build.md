# 构建指南

## 前置

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | >= 22.19 | 本仓库脚本与运行时准备 |
| npm | >= 11 | 根目录安装 @tauri-apps/cli |
| Rust | stable（>= 1.77） | cargo/rustc，含 C 工具链 |

Linux 额外需要 Tauri v2 系统依赖（Ubuntu/Debian 示例）：

```sh
sudo apt-get update
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev \
  librsvg2-dev patchelf pkg-config python3
```

macOS 需 Xcode Command Line Tools（`xcode-select --install`）。

## 开发运行

```sh
npm install
npm run prepare:runtime          # 准备本平台运行时（下载 Node + npm 安装 dsh）
npm run tauri:dev                # 开发模式启动桌面窗口
```

`tauri:dev` 通过 `CARGO_MANIFEST_DIR/runtime` 回退自动找到运行时，无需环境变量。

## 构建安装包

按目标平台准备对应架构的运行时（本机是 mac arm64 则默认就是 aarch64-apple-darwin）：

```sh
# 明确指定目标（产物与下载的 Node 架构必须匹配）
npm run prepare:runtime -- --target aarch64-apple-darwin   # macOS arm64
npm run prepare:runtime -- --target x86_64-pc-windows-msvc # Windows x64
npm run prepare:runtime -- --target x86_64-unknown-linux-gnu # Linux x64
```

然后构建并打包：

```sh
npx tauri build --bundles dmg        # macOS；--target 默认本机架构
npx tauri build --bundles nsis       # Windows（在 Windows 上执行）
npx tauri build --bundles deb,appimage # Linux（在 Linux 上执行；deb 需 dpkg 工具链）
```

产物位于 `src-tauri/target/release/bundle/`。跨平台请用各平台原生环境（macOS 安装包只能在 macOS 构建；
Windows NSIS 在 Windows；Linux 在 Linux）——CI（GitHub Actions）按此矩阵构建。

## 运行时准备细节（prepare-runtime.mjs）

1. 下载 Node v22.23.1 官方发行包（失败自动回退 npmmirror）并解压出 `node`/`node.exe`
2. 生成 `runtime/app/package.json`，固定 `@deepseek-ai/dsh@0.1.2-rc.1`，并放行 npm 12 默认拦截的
   安装脚本（`koffi`、`node-pty`、`node-addon-require-builtin` 相关等）——这些脚本产出的原生二进制
   （koffi FFI 预编译、node-pty 终端原生模块）是运行时加载所必需
3. `npm install --prefix`（每平台各自安装，自动只取该平台 optional 依赖，如 `landlock-run-linux-x64`）
4. 校验 `lib/bin.js` 与 node 存在，写 `version.json`

`--force` 可强制重做；命中版本一致时跳过（CI 缓存友好）。

## 冒烟验收

```sh
node scripts/smoke-test.mjs
```

真实 spawn 打包所用的 node + `dsh web --no-open --port 0`，断言：
- stdout 出现 `dsh web: http://<host>:<port>/…` 就绪行
- GET 该 URL 返回 HTTP 200 且 HTML 含 `__DSH_BOOT__`（应用就绪，而非仅传输就绪）
- 失败时非零退出并转储 stdout/stderr

## 图标

```sh
npm run gen:icon
```

生成占位图标（`scripts/gen-icon.mjs` 输出 PNG，`tauri icon` 派生 icns/ico/png 全套到 `src-tauri/icons`）。
正式品牌图标替换 `scripts/assets/icon-source.png` 后重跑即可。

## 三平台 CI

`.github/workflows/build-desktop.yml`：矩阵 `ubuntu-22.04 / windows-latest / macos-14`，
各自 `prepare:runtime --target <triple>` → `tauri build --bundles …` → 冒烟测试 → 上传产物；
打 `v*` tag 自动附加到 GitHub Release。推送 tag 前请先在本地通过 `npm run smoke`。