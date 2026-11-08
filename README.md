# dsh-maze

Maze 是 [DeepSeek Harness](https://github.com/) (dsh) 的常驻个人助手插件：设置页里的
**迷宫模块中心**，加右下角一位名叫 **Dolores** 的接待员——每座迷宫的中心，
都住着一位醒来的接待员。

当前模块：**提醒**（模型调用条件提醒 + cron 定时提醒）与**个性化**
（应用背景图 / 透明度 / 接待员名册）。框架按模块扩展，新模块各占设置页一个 Tab。

纯 UI 插件：不向模型上下文注入任何内容。

## 安装

```sh
dsh plugin --profile <profile> add file:/path/to/dsh-maze
```

desktop profile 由 Electron 应用管理，装完重启应用生效。

**更新**：`file:` 依赖是复制不是软链，且 pnpm 见已装会跳过——改完源码先删再装：

```sh
rm -rf ~/.dsh/profiles/<profile>/node_modules/dsh-maze
dsh plugin --profile <profile> add file:/path/to/dsh-maze
```

新 profile 开箱即用：插件自带出厂背景图、透明度偏好与五位出厂接待员
（Dolores / Maeve / Bernard / Teddy / William，各带头像与 S1-S4 原剧台词库）。
用户数据一旦存在（`data/dsh-maze/appearance.json`）则以用户文件为准。

## 使用

### 提醒（模型额度场景）

一条规则 = 触发源 × 条件 × 频控 × 文案。例：工作日 14–18 点用 glm 系模型时提醒
额度消耗（默认规则 `glm-peak-hours` 即此）。

- **触发源**：`model-call`（每次模型调用时评估）或 `cron`（5 字段标准表达式）。
- **条件**（model-call）：模型通配 `modelPattern`（对 `provider/model` 匹配，
  如 `*glm*`）、生效时段 `startHour/endHour`、星期限定 `daysOfWeek`（如工作日）。
- **频控**：每日上限 `maxPerDay` + 冷却 `cooldownMinutes`。
- **文案**：`{model}` `{provider}` 占位替换。
- 编辑器带 cron 常用预设与**预览效果**（服务端按草稿渲染并判断会不会命中，
  纯预览不占频控额度）；cron 规则预览下次触发时间。

提醒到达：右下角悬浮球高亮并弹气泡（吐字渐显），可「知道了」或「今日不再提醒」。
规则增删改、启停、处置历史都在设置页「提醒」Tab。

### 个性化

- **背景图片**：作用于整个应用界面；大图自动压缩（缩边 + WebP 重编码）。
- **背景透明度**：控制背景图之上的主题色纱层，100%=纯图，5%≈近实心；
  弹层与菜单保持不透明以保证设置页等浮层可读。
- **聊天框透明度**：独立调节会话内容卡片（气泡 / 输入卡 / 代码块 / 工具摘要），
  与背景纱互不牵连。
- 浅色 / 深色主题自动适配；改动实时预览，保存落盘原子写。

### 接待员

- **名册**（≤8 位）：每位 = 名字 + 头像 + 专属语录 + 启用开关。**随机觉醒**开启时
  每个浏览器会话随机一位（会话内稳定）；关闭则用指定接待员。全停用时回落内置兜底形象。
- **头像存档池**：上传过的头像自动入池（≤12 张），编辑时点击取用，换形象不用重新找图。
- **语录**：按七神态分组（≤12 句/组，单句 ≤200 字符），清空一组=该状态沉默；
  分组默认收起防误改，删除单句两步确认。
- **状态**：显示/隐藏、固定位置（也可右键悬浮球：固定 / 隐藏）；隐藏后提醒气泡
  照常工作。悬浮球可拖拽，位置每设备记忆。
- **叙事镜像**：接待员看得见会话走向——宿主把模型调用与会话事件投影为七种神态，
  悬浮球随神态换演出（呼吸 / 摇曳 / 微浮+迷宫环 / 机芯律动 / 侧倾 / 小跳✦ /
  错帧⚠），并按概率低语一句台词；独处久了会自语。提醒永远优先，绝不插话。

## 配置参考

规则字段（`cordis.patch.yml` 的 `config.rules` 为基底，UI 编辑覆盖落盘）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 唯一标识（UI 保存后不可改） |
| `name` | string? | 展示名（缺省用 id） |
| `trigger` | `model-call` \| `cron` | 缺省按有无 `schedule` 推断 |
| `schedule` | string? | cron 专用。5 字段（分 时 日 月 周）；`*` `a` `a-b` `*/n` `a-b/n` 逗号列表；周 0-7（7=0） |
| `modelPattern` | string? | model-call 专用。对 `provider/model` 通配，`*` 任意段 |
| `startHour`/`endHour` | int? | model-call 专用。生效时段 [start, end)，0-24 |
| `daysOfWeek` | int[]? | model-call 专用。0=周日..6=周六；`[1,2,3,4,5]`=工作日；缺省=每天 |
| `message` | string | 提醒文案，`{model}` `{provider}` 占位替换 |
| `maxPerDay` | int | 每日触发上限（默认 2） |
| `cooldownMinutes` | int | 两次触发最小间隔（默认 120） |
| `locked` | bool? | config 声明后 UI 不可编辑/删除（仍可启停） |
| `when` | string? | L2 表达式（仅 config 可用，见下） |

**L2 表达式**（`when`）：结构化条件之外的自定义判断，与 L1 条件 AND 叠加；
仅 YAML 配置可用（不进 UI），装载期编译校验，运行期异常按 false 处理：

```yaml
- id: weekend-alert
  message: '周末还在用 {model}？注意额度'
  modelPattern: 'deepseek*'
  when: 'dow === 0 || dow === 6'   # 用普通引号字符串，不要 !!js（会变成函数，与 schema 冲突）
```

可用变量：`use`（`{provider, model, at}` 或 null）、`hour`、`minute`、`dow`（0=周日）。
在 UI 里编辑带 `when` 的规则会丢弃该条件（编辑器会警告）。

**持久化语义**（`data/dsh-maze/`，均为原子写）：

- `rules.json`：UI 编辑结果。同 id 的 store 规则覆盖 config 版本；`locked` 的
  config 规则恒胜出；UI 删除 config 来源的规则记入 `deletedIds` 墓碑（重启不复活，
  重建同名即解除）。文件损坏时退回纯 config 规则集（提醒可用，编辑失效）。
- `appearance.json`：外观整体（背景 / 接待员偏好 / 名册 / 存档池）。损坏按默认降级。

**校验限值**：头像 data URL ≤6M / emoji ≤4 字符；名册 ≤8 位、名字 ≤24 字符、
id 去重；台词每组 ≤12 句、单句 ≤200 字符；背景透明度 0.05–1、聊天框 0–1。

## 机制

```
宿主半边 (src/, Cordis 插件)
  llm/stream 事件 ──┬→ 规则引擎 (reminders/engine.ts) → pending 提醒（频控）
  session/event 流 ─┼→ 叙事引擎 (narrative.ts) → 七神态投影（内存）
  30s cron tick ────┘
  HTTP: /maze/reminders/{state,ack,rule,preview}  /maze/appearance  /maze/events(SSE)

浏览器半边 (client/client.js, ModuleLoader 外壳)
  shell.overlay    → 悬浮球 / 提醒气泡 / 低语（神态演出、右键菜单、拖拽）
  settings.section → 设置页（Tab：个性化 / 接待员 / 提醒）
```

- **状态推送**：`GET /maze/events` SSE 直推快照（连接即回发；500ms 节流 +
  负载不变跳过 + 30s 心跳）；浏览器 EventSource 订阅即时上屏，断线自动重连，
  10s 轮询仅作断线兜底。
- **安全栅栏**：dsh 平台对回环 socket 免鉴权，因此全部 `/maze/*` 路由统一过
  同源栅栏——`sec-fetch-site: cross-site` 或 Origin 与 Host 不一致即 403
  （挡恶意网页 drive-by fetch）；请求体默认 64KiB 上限（appearance 放宽 8MiB），
  超限断流。
- **背景实现**：底图是 body 下真实 DOM 层（`position:fixed; z-index:-2`，画在
  body 画布之上、所有面板之下）；透明度纱画在底图层内部，不依赖应用面板的
  token 消费差异，任何区域恰好一层。关闭背景时样式与 DOM 全部撤除，无残留。
- **台词轮播**：低语按神态分组游标轮播（全覆盖后才重复）；收束/失灵是结果
  时刻——必说且限频 30s，其余过渡神态 70% 概率 + 90s 限频。
- **导航图标**：设置壳层对未知分区硬编码齿轮图标，客户端以 DOM 补丁把「Maze」
  行替换为迷宫徽记（500ms 轮询驱动，React 重渲后下一拍自动重补）。

## 开发

```sh
npm install --cache /tmp/dsh-maze-npm-cache   # ~/.npm 可能不可写
npm run build    # tsc → lib/
npm test         # build + 全部 79 用例
node --check client/client.js                 # 客户端零构建，语法自查
```

**类型依赖**：tsconfig 的类型映射（`@deepseek-ai/cordis` 等）指向 DeepSeek
Harness checkout 的 `../vendor`、`../packages` 已构建产物——在 checkout 内开发
开箱即用；独立 clone 时需自行调整 paths。发布不依赖消费方构建：`lib/` 产物
随包发行（`files` 白名单），直装即用。

## 扩展新模块

1. 宿主：`src/<module>/` 纯逻辑 + 观察者/调度源 + 路由挂 `/maze/<module>/*`。
2. 浏览器：`MODULES` 注册表加一项 `{id, label, component}`（照 `RemindersModule` 的结构）。
3. 通知层复用：新模块的提醒同样进 pending，悬浮球气泡直达。
