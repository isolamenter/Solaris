# B06 — Tauri/macOS、本地数据与文件

状态：**已完成（2026-09-29）**，见文末验证记录。
依赖：B01；与 B02/B03/B04 并行。
基线：[CONTRACTS v3](CONTRACTS.md)、[决策记录](DECISIONS.md)；总规则见 [BACKLOG_README](BACKLOG_README.md)。

## 范围与文件所有权

src-tauri/、src/client/local/ 及测试；根 package/lockfile 归 B08。只做同步单次生成范围；不改其他 agent 拥有的文件。

## 执行清单

- [x] 建立 Tauri v2 最小能力，业务留 React/Server；Windows 保留接口边界，首期不宣称实测。
- [x] 实现 DesktopLogin：本地回环监听、Client state/PKCE、系统浏览器、超时/取消清理；code/verifier 不落盘。
- [x] 系统安全存储保存当前 Server 的 SessionDto；账号切换替换 token，其他本地文件按 LocalScope 隔离。
- [x] 实现 CONTRACTS 中 DraftRecord/LocalRunRecord/LocalStore；本地唯一键含 origin+userId，不依赖全局活动账号猜归属。
- [x] 文件选择、参考图读取、保存/预览/导出限制在授权路径；文件名不来自远程响应。
- [x] 图片临时文件→原子改名→保存状态；磁盘满/无权限/丢文件正确表达，失败不修改 Server status。
- [x] 应用重启能读已保存本地文件，但无保证未接收结果可恢复；Server 缓存重放不是持久下载功能。
- [x] 依赖、macOS 权限/打包配置交 B08，原生层只开放所需能力。

## 验收与交接

- [x] 两个账号/Server 的草稿/图片关联/会话不混用；安全存储外不含 bearer。
- [x] 失败与崩溃不会留下已保存记录；文件遗失标 missing。
- [x] macOS 实机回环登录和文件能力单独记录；fixture 不代表原生实测。

验证：原生工具检查 + local focused tests → typecheck → lint。

交接记录实际修改文件、接口版本、检查命令/结果、未验证环境及剩余风险。本文复选框是修订后的当前任务，不把旧调查完成误认为实现完成；B00 的历史调查证据保留在 DECISIONS。

---

## 实际验证（2026-09-29 实跑，交接自实现 agent）

**原生侧（真实编译与运行，非 fixture）：**

| 命令 | 结果 |
| --- | --- |
| `cargo check --all-targets` | Finished，**零警告** |
| `cargo test` | 24 passed / 0 failed / 1 ignored |
| `cargo test -- --ignored` | **真实 macOS Keychain 往返通过**（clear→None→write→read→replace→read→clear） |
| `cargo build` | 产出 `target/debug/solaris-desktop`，25,983,424 bytes，Mach-O arm64 |

**客户端侧：** `tsc --noEmit` 0 错误；`eslint .` 通过；`vitest run` → 本项目 261 项全过（B06 贡献 66 项）。

### 发现并修复的严重缺陷

**`keyring` 3.x 在未启用原生 store feature 时会静默选用内存 mock store**（源码 `#[cfg(all(target_os="macos", not(feature="apple-native")))] pub use mock as default;`），即**所有 token 会被悄悄丢弃**且测试仍显示通过。修复方式是按平台声明 feature，并**故意不提供无 feature 的兜底**——没有原生 store 的平台现在直接编译失败，而不是静默丢密钥。该缺陷原本已被 `--ignored` 用例捕获为失败。

### 职责划分

Rust 只承担回环网络、Keychain、原生对话框、原子文件写与受限 JSON KV；**所有能用 TS 表达的规则**（scope 键、state/S256 PKCE、回调校验、文件命名、记录映射、保存顺序、missing 对账）都在 `src/client/local/` 并有无设备单测。

### 仅 fixture / 未验证

**App 从未启动过**；未弹过文件对话框；`open -R` 未执行；**Windows 与 Linux 从未编译或运行**（`windows-native` feature 与 windows cfg 分支只是声明）；`read_reference_file` 的允许列表检查（canonicalize + 精确匹配 `local-config.json`）位于 Tauri command 体内、无单测；`load_config` 的损坏文件硬错误未触发过。

### B07 必须做的接线（原文）

把 `main.tsx` 里的 `createPlaceholder*` 换成 `createLocalStore()` / `createDesktopLogin()`，`session` 换成真实 `SessionProvider`（须在启动时 `readSession(serverOrigin)`、登录/登出时 `writeSession`/`clearSession`），删掉 `developmentNotice` 与 `./placeholders.js` 引用；`serverOrigin` 在打包版必须是**配置的绝对 Server 地址**而非 `window.location.origin`。

### 遗留风险

- 桌面 App 首次启动行为（窗口创建、`app_data_dir` 权限、主线程 rfd 对话框）未测。
- Windows/Linux 未构建；Linux 上该 crate 现在**按设计编译失败**（未声明 keyring store）。
- `reveal_in_file_manager` 不等待子进程，`open -R` 失败不会被观测。
- 保存目录与参考图允许列表存在 `<app_data_dir>/local/local-config.json`（明文、用户可写）：本地攻击者可改写保存目录指向（文件名形状与包含性检查仍生效）。
- `MAX_IMAGE_BASE64_BYTES`（96 MiB）约束跨 IPC 的字符串，保存期间 base64 会在内存中存留多份。
- **范围外改动已披露**：`eslint.config.mjs` 加了一行 `"src-tauri/target/**"` 到 ignores（ESLint 原本因 Tauri 代码生成产物报 4 个错）。已确认 `src-tauri/target` 被 `.gitignore` 忽略，无大文件入库。
