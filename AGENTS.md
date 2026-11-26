# 短考长考

DSH 插件：会话级的「短考 / 长考」开关。输入框右侧一个双态按钮，也可以 `/mode`。

- 包名 `@todrink/dsh-shortlong`，以 bundle 形式装进 **desktop** profile（`install_bundle`，junction 链接到本目录，改完源码即时生效，无需重装）。
- 这个目录是**活源**：profile 里的 `node_modules/@todrink/dsh-shortlong` 是指向这里的 junction。改 `index.js` / `client.js` 会经 HMR 直接生效。

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | host 半侧：`shortlong` session projection（模式状态真源）、按请求求值的提示词段、`/mode` 命令、`agent/pre-step` 里同步 `tools.restrict({deny:['ask_user_question']})` |
| `client.js` | 浏览器半侧（手写，无需构建）：在 `conversation.input.right` 槽注册按钮，模式从 `useProjection('shortlong')` 读 |
| `cordis.patch.yml` | 一行 `insert`，把插件插进 profile |
| `locale/*.json` | 插件列表里的标题与描述 |
| `package.json` | `dsh.bundle.patch` + `dsh.client` 声明 |

## 路径约定

- **唯一活源就是本目录。** profile 里用 `link:` / junction 指向这里，改源码即时生效（client 半侧需刷新页面）。
- 不要在别处留副本；要改就改本目录。

## 行为契约

两套人设文本都在 `index.js` 顶部（`SHORT_TEXT` / `LONG_TEXT`）。改文案只改那里，其它不用动。

**状态来源**：模式 = 会话日志里最后一条「切换成功」的 `/mode` 结果（`command/done` 文本以 `→` 开头，`→ 短考` / `→ 长考`）。
`shortlong` projection 折叠它，host 提示词、`tools.restrict`、客户端按钮全都只读这个 projection；`/mode` 命令是唯一写入者。

- 因此：**打开会话不再执行 `/mode status`**，不会每次点进会话都留一行 `>_ mode · 短考`；只有真的切换才留一行。
- 因此：模式现在跟着会话日志走，**重启 app / 刷新页面 / resume / fork 都还在**（1.0.0 时代重启就回短考）。
- `/mode status` 仍可用（回一行裸标签，不带 `→`），但它不动状态；客户端只在 projection 缺失（host 半侧没重载）时用它当兜底，且按会话缓存。

## 当前状态

- host 半侧：active。projection 已实测注册成功（`~/.dsh/storages/session_projcache` 里可见 `"shortlong": { "ver": 1, "val": { "mode": "short" } }`）。
- client 半侧：读投影 + **点击回执优先**（`fallback ?? projected ?? SHORT`）。原因：客户端那份投影快照可能是旧的，会永久压住点击结果，表现为"点了没反应/一直是短考"。另加 400ms 防连点，避免一次点击触发两次 toggle 互相抵消。
- 踩过的坑（别再犯）：
  1. 客户端插件必须声明 `inject: ["slots", "remote", "remote.commands"]`，否则 `ctx.remote` 是 undefined。
  2. `remote.commands.execute` 的返回是 `{ ok, value: { result: { kind, text } }, error }`；`value === undefined` 表示 host 不认识该命令。不是 `value.text`。
  3. **每次命令执行都会落一条 `command/run` + `command/done` 并渲染成会话里的 `>_ 名字 · 结果` 行**。要读状态就别用命令，用 projection —— 1.0.0 的重复 mode 行就是这么来的。
  4. projection 的 `stateSchema` 只要求运行时 `parse` 存在；本插件是 junction 安装，从源码目录解析不到 profile 的 `zod`，所以手写了一个只有 `parse` 的对象，别改成 `import { z } from "zod"`。
  5. host 半侧改完不会自动 HMR：用 `plugin_manager({ action: "set_bundle", target: "@todrink/dsh-shortlong", enabled: false })` 再 `true` 一次，等价于重挂载。
- 未做（v2 候选）：
  - 长考的 `tools.restrict` 只在 `agent/pre-step` 与切到长考后的下一步生效；还没在真实长考回合里观察一次日志确认没抛错（已 try/catch + 告警，不会挂）。
  - 未接 locale 服务，按钮文案是写死的中文（与 `locale/*.json` 里的插件标题分开）。

## 坑（已修，别再犯）

- **投影的 wire 值不要用文案解析**：投影里是内部字符串 `{ mode: "long" | "short" }`，早期客户端却按“长考”两个字去 `parseMode`，永远找不到、一律当短考；点击后的 fallback 只在当前页面压得住，切会话或重启就露馅。现在按 `"long"` / `"short"` 判定（`parseWireMode`）。
- 客户端在 `useState` 初始化时读回最近一次命令回执（`getCached`），切会话重挂载的第一帧就是对的。
- 投影迟迟不来时才延迟 1200ms 发一次 `/mode status` 兜底，避免每次打开会话都落一行命令行。
- host 的 `wire.summary: false`：模式不进 Session summary，避免列表缓存落后一整轮。

## 回归

`test-chip.cjs`（mock React 渲染 chip，5 例；`node test-chip.cjs [client 路径]`）。

## 怎么改

1. 改本目录里的文件。
2. host 半侧改了：**不会自动生效**（实测改完等 12s 没动静），要 `set_bundle enabled:false` 再 `true` 重挂载一次；client 半侧改了：500ms 轮询自动替换，刷新页面最稳。
3. 要重装 / 卸载（源目录 = `自定义探索\短考长考`；同包名重复 `install_bundle` 会报 `already-installed`，换源目录必须先 `remove_bundle` 再装）：
   - 装：`plugin_manager({ action: "install_bundle", target: "<本包目录的绝对路径>" })`
   - 卸：`plugin_manager({ action: "remove_bundle", target: "@todrink/dsh-shortlong" })`

## 别动

- 不要手改 `~/.dsh/profiles/desktop/package.json` 或 `cordis.patch.yml`（`install_bundle` 负责）。
- 不要把 `app.asar` 里的东西解出来改。