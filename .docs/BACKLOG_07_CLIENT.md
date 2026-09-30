# B07 — React 登录、单次生成与本地历史

状态：**已完成（2026-09-29）**，见文末验证记录。
依赖：B03/B04/B06；与 B05 按冻结 HTTP 契约并行。
基线：[CONTRACTS v3](CONTRACTS.md)、[决策记录](DECISIONS.md)；总规则见 [BACKLOG_README](BACKLOG_README.md)。

## 范围与文件所有权

src/client/ 除 B06 local/ 外的实现/测试。只做同步单次生成范围；不改其他 agent 拥有的文件。

## 执行清单

- [x] typed API 接入可配置 Server、Solaris bearer、统一生成响应和错误 envelope，不硬编码 SSO/NewAPI。
- [x] 登录/退出/过期重新登录，Server 与用户切换隔离缓存/本地记录；通过 LocalScope 调用桌面能力。
- [x] 连接 Key 只录入提交，不保存；只提供已适配、已授权模型及实际参数。
- [x] 单次输入/参考图保存本地；一次明确运行稳定 submissionId，传输重试复用，内容变化冲突，新运行新 ID。
- [x] 展示 pending、success/error/uncertain 及 delivered/unavailable；202 后可查历史或重放，不自动发新生成。
- [x] 保存失败优先重用已收字节；字节丢失仅同提交尽力重放，缓存失效明确不可取；重跑提示可能重复收费。
- [x] 远程历史只有元数据，本设备文件决定预览/保存状态；跨设备仅元数据验收待确认，不伪造可下载。
- [x] 删除视频/Batch/素材库/取消/调试面相关页面和 API（调试面删除按 D11 冻结结论）；outputCount 控件待确认。

## 验收与交接

- [x] 200/202 判别响应正确解析；保存失败/缓存未命中/未知提交不导致新收费调用。
- [x] 切账号/Server 不出现其他身份的本地记录；历史删除不解除服务端去重。
- [x] 页面 fixture 不能替代实际桌面保存和浏览器登录。

验证：focused Client tests → typecheck → lint；完整桌面联调归 B08。

交接记录实际修改文件、接口版本、检查命令/结果、未验证环境及剩余风险。本文复选框是修订后的当前任务，不把旧调查完成误认为实现完成；B00 的历史调查证据保留在 DECISIONS。

---

## 实际验证（2026-09-29 实跑，交接自实现 agent）

- `npx vitest run src/client` → 12 文件 / 95 项通过
- `npx vitest run` → 35 文件 / **319 项通过**（无回归）
- `npx eslint .` → 通过；`npm run build` → vite 成功（54 modules）
- `npx tsc --noEmit` → 仅 `src/server/services.replay.test.ts(90,19)` TS2352 报错，**属 B05 并行文件、当时仍在编辑中**，与本任务无关；B07 自己的文件全部干净

**新增**：`settings.ts`（唯一的不可推导环境值：绝对 Server 地址）、`ServerAddress.tsx`（配置界面）、`settings.test.ts`/`session.test.ts`/`display.test.ts`（17 项）。
**删除**：`src/client/placeholders.ts`（唯一引用者为 `main.tsx`，已 grep 确认）。
**接线**：`main.tsx` 改用 `createLocalStore()`/`createDesktopLogin()`；`SessionProvider` 重写为对 `LocalStore.readSession|writeSession|clearSession` 的 `restore()`/`persist()`，按规范化 origin 分键，且是存储 token 的唯一写入者；`App.tsx` 按 origin 派生一个 `ServerApp`（`key={origin}`），切 Server/账号从该 Server 自己的会话与本地 scope 重新开始；`AUTH_REQUIRED` 清除设备 token 并回到登录页；登出先清设备 token 再尽力 `logout()`。

**本地保存语义**：`saved` 只在 `saveImage` resolve 之后写入；失败保持 `unsaved`；交付图片与设备记录合并（`listLocalRuns`，由 B06 对账 `missing`），因此重复交付不会把已保存文件显示成未保存、也不会把已删除文件显示成存在。

### 仅 fixture / 未验证

**没有任何 fixture 覆盖、且此处无法做浏览器或桌面运行**（仓库无 jsdom/testing-library，桌面 App 从未启动；`vite build` 只证明能打包）：真实 Server 的登录序列、`AUTH_REQUIRED` 登出路径、切换 origin、启动时恢复会话、以及每一次 `LocalStore` 调用（save/merge/missing/reveal）。**在 B08 端到端联调之前，客户端与本地层的集成应视为未验证。**

### 遗留风险

1. **B03 的边界仍然挡在前面**（已由协调者从代码确认）：`assertSameOrigin` 拒绝任何缺少 `Origin: http://127.0.0.1:<port>` 的非 GET 请求，而 **`assertLoopbackHost` 对每个请求都拒绝非回环 `Host`**。两者都不在冻结码表内，故 `toPublicError` 把二者映射为 `500 INTERNAL`。B07 未伪造 `Origin`、未削弱任何服务端检查。**注意回环 Host 这一条影响面远大于换码：今天桌面客户端根本无法与非回环 Server 通信。** 归 B08。
2. Server 地址存在 webview 的 `localStorage`（B07 文件内唯一可达的设备级存储；`LocalStore` 未暴露配置 API，`src-tauri` 不在其范围）。它不是秘密，但 webview 数据被清即丢失。
3. `isDesktopShell()` 探测 Tauri 内部全局 `__TAURI_INTERNALS__`；未来 Tauri 改名会使 Windows 桌面版误以为 Server 是 `http://tauri.localhost`。未对真实 shell 验证。
4. **切换 Server 会刻意保留上一个 Server 的 token**（§10：只有登出清除）。持解锁设备的人切回去即可免登录。
5. 交付字节只存在于 React state：保存失败后在页面存活期间可重试，刷新即丢失（已接受：结果缓存本就是尽力而为）。
6. `readSavedImage` 与 `revealInFileManager` **客户端仍未使用**：没有打开/定位已保存文件的 UI 路径，预览始终来自交付字节而非设备文件。
7. `outputCount` 仍标为 "maximum retained"（§3.2 未冻结），原样保留。
