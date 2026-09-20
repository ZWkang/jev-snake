# SNAKE · JEV 实时贪吃蛇

一个用于观察快速决策模型的贪吃蛇实验。游戏由 Hono 服务端管理，仅随模型有效响应逐步推进，每次决策只走一步，JEV 通过 Typesafe 或 OpenRouter API 选择方向；游客无需登录，可以实时观战、查看历史和逐步回放。

首版不提供人类操作、游客开局或接管。网页不会生成模拟 JEV 对局；没有真实记录时展示空状态。

## 本地启动

需要 Bun 1.4.2（版本记录在 `.bun-version` 和 `packageManager`）。依赖由 bun.lock 锁定，SQLite 使用 better-sqlite3。

开发、构建、测试、CLI 和生产服务统一使用 Bun。`bunfig.toml` 的 `[run] bun = true` 使工具及其子进程也运行在 Bun 下。已有 Bun 版本较旧时先按 [官方安装说明](https://bun.com/docs/installation) 安装项目版本，并用 `bun --version` 确认；Bun 1.2.19 无法运行本项目当前的 SQLite 原生模块。

```sh
bun install --frozen-lockfile
# 首次配置；已有 .env 时不要覆盖
cp .env.example .env
# 生成 GAME_ADMIN_TOKEN，再填写 .env
openssl rand -hex 32
bun run build
bun run serve
```

本地管理员凭证仅存放在 .env。服务默认地址：

- 网页：http://localhost:3000
- Hono：http://127.0.0.1:3001
- SQLite：.data/snake.sqlite

.env、数据库及 .data/ 下的验收记录不会提交到 Git。修改环境变量后重启相关进程。

日常观战使用 `build` + `serve`：前后端运行构建产物，不监听源码变化，保存组件、样式或后端代码都不会刷新观战页或重启对局。更新版本时重新构建，再重启 `serve`；未完成的对局按保存进度恢复。`serve` 固定网页端口为 3000，端口占用会明确报错，不会自动换地址。

开发调试仍使用 `bun run dev`，该模式会热更新页面并在后端代码变化时重启服务。两种模式使用相同端口，启动前先退出另一种模式。

## 首页与连续观战

- `/` 是独立首页，提供介绍、规则、连续观战与历史入口，有活动局时也不会替换为棋盘。
- `/watch` 跟随服务端连续频道；`/watch/:matchId` 只看指定的一局，结束后不自动跳到其他局。
- `/matches` 和 `/matches/:matchId/replay` 保留历史及回放。手动 CLI 对局不会被连续频道接管。

连续频道初始关闭。打开 `http://localhost:3000/watch?admin=1`，输入 `.env` 中的 `GAME_ADMIN_TOKEN` 解锁，再点击“开启连续观战”。`admin=1` 只显示管理入口，启停接口仍要求有效的服务端管理员会话；普通页面不显示管理控件。

开启后，正常终局并完成模型请求清理后，默认倒计时 5 秒自动开启下一局。关闭网页、注销管理或没有观众都不会停止频道。“停止连续开局”让已经开始的本局正常结束，然后不再开启下一局；在倒计时或准备阶段停止会取消尚未开始的局。等待本局结束期间重新开启会沿用当前局。 “立即停止本局”会马上中断当前局、取消尚未完成的模型请求，并停止连续开局；迟到的模型响应不再提交动作。该主动停止记录不会在重启时自动恢复，必须重新开启才能开始新局。

终局棋盘内显示时钟加载和下一局秒数，数字变化使用轻量缓动，倒计时沿用服务端开局时间。归零后等待真实新局就绪；断线时暂停动效并显示同步状态，停止或报错时撤掉续局加载。系统设置“减少动态效果”时保留文字倒计时、关闭旋转与数字动画。

频道与 CLI 均仅运行响应单步，共用棋盘尺寸、障碍、种子以及 `JEV_PROVIDER`/`JEV_MODEL` 配置。蛇等待有效模型响应后才走一步，没有固定移动间隔。没有固定 `SNAKE_SEED` 时每局生成新种子。频道不代替模型选择方向；正常游戏没有总步数或总时长终局上限，但默认启用下述停滞费用保护。

| 配置 | 默认值 | 含义 |
| --- | --- | --- |
| `WATCH_INTERMISSION_MS` | `5000` | 非负整数；0 表示正常结束清理后立即准备下一局 |
| `WATCH_PUBLIC_ORIGIN` | `http://localhost:3000` | 管理页面的精确 Origin，不带末尾斜线；管理写接口校验 Origin |
| `WATCH_SESSION_TTL_MS` | `28800000` | 管理会话有效期，默认 8 小时，必须为正整数 |
| `VITE_ROUTER_DEVTOOLS` | `false` | 显式启用路由面板及其 Vite 插件；默认不为每个观战标签创建额外的调试日志 SSE |

管理口令不写入 URL、localStorage 或前端构建。会话使用限定管理 API 路径的 HttpOnly、SameSite=Strict cookie；HTTPS Origin 使用 Secure。本地使用 `127.0.0.1` 而非 `localhost` 打开网页时，也需相应调整 `WATCH_PUBLIC_ORIGIN`。生产代理须转发 `/api` 和 `/ws`，并保持前端真实 Origin，不开放任意跨域管理请求。

模型/API/网络错误会明确中断频道，等待管理员点击“恢复连续观战”，不会自动换模型或新建替代局。关闭服务不等同于停止续局：连续观战重启后恢复同一个未完成对局，从最后保存的步数继续，保留棋盘、得分、蛇身、随机数进度、模型决策历史和原始开始时间；控制凭证重新生成，停机时间不计入对局。已选择停止续局的本局仍会恢复并跑完，结束后不再新开。真正结束的对局才进入下一局倒计时；已经停止的频道仍停止，已保存的模型/API 故障不会自动清除，管理员会话需要重新解锁。

公开接口为 `GET /api/watch-channel` 和只读 `WS /ws/watch-channel`。管理员使用 `POST/GET/DELETE /api/watch-admin/session` 解锁、查询、注销，使用 `POST /api/watch-admin/commands` 提交 `{requestId, enabled}`；立即停止使用 `{requestId, enabled:false, stopCurrent:true}`。重复请求返回原确认与当前状态，不重复开局或停止事件。

本功能将 SQLite schema v1 事务迁移为 v2，增加频道、轮次归属和命令去重记录，保留原对局与事件 JSON。升级前备份数据库；旧后端不能直接读取 v2。回退时可保留兼容 v2 的后端并停用频道；如必须恢复迁移前备份，应先停止写入，并明确备份之后的历史不在其中，不能静默降版本或删表。

## 停滞费用保护

默认启用，频道和 CLI 共用。在下一次真实模型请求发出之前，读取已有 `progress-v1` 历史，任一条件达到即中断本局：

1. 未吃苹果期间，同一完整局面第 **3** 次出现。比较完整有序身体、朝向、障碍及可见食物，不是只看蛇头坐标。
2. 连续未吃苹果的移动数达到 **`max(64, 2 × 可走格数)`**。例如10×8、2障碍为156步；8×8、1障碍为126步；8×6、1障碍为94步。

只吃苹果才重置进食进度；星星得分、等待、重复请求、重启不会清零实际移动历史。历史分支仍继承真实进度，因此也受同样保护。

触发后保存 `interrupted` 和 `stagnation_loop` / `stagnation_no_apple` 原因，停止事件的 `data.guard` 记录观察步、无果步数、重复次数与生效阈值。**这是费用保护暂停，不是判输、通关或证明地图无解。** 不调用触发点的下一次模型请求、不替模型走路。

连续频道对两种原因分别处理：`stagnation_no_apple` 结束当前局后，保持启用并按 `WATCH_INTERMISSION_MS` 倒计时自动开下一局；`stagnation_loop` 关闭 `enabled` 并进入暂停状态，等待管理员恢复。用户已经停止连续开局时，两种原因都不会重新启用频道。重启恢复遵循相同规则，包括“本局中断已保存、频道状态尚未保存”的崩溃窗口；已有关闭的故障频道仍需明确恢复。

| 配置 | 默认 | 含义 |
| --- | --- | --- |
| `JEV_STAGNATION_GUARD` | `true` | 仅接受true/false；false显式关闭两道费用保护 |
| `JEV_STAGNATION_MAX_VISITS` | `3` | 同一完整局面的访问次数阈值，整数且至少2 |
| `JEV_STAGNATION_MAX_NO_APPLE_MOVES` | 自动按上式 | 可用正整数显式覆盖无果步数阈值 |

配置错误会明确报错。这些检查只比较已有计数，不增加寻路或扩大搜索预算；也不是按货币金额结算的账户总额度限制。

## 跑一场真实 JEV 对局

在 .env 设置 TYPESAFE_API_KEY，然后保持开发服务运行，在另一个终端执行：

```sh
# 默认随模型响应：返回一次，立即走一步，再询问下一步
bun run jev
# 可显式声明唯一运行方式
bun run jev --step-mode response --decision-mode single_step
```

也可以明确地图参数：

```sh
bun run jev --width 24 --height 18 --obstacles 12 --seed experiment-01
```

- 默认通过 Typesafe 直连，固定模型 jev-1.13.0；JEV_MODEL 可显式选择其他官方版本或别名。
- 如需对照 OpenRouter，显式设置 JEV_PROVIDER=openrouter，并使用独立的 OPENROUTER_API_KEY；不会在失败时自动切换服务商。
- Typesafe 接口为 https://api.typesafe.ai/v1/systemone，输入 state/questions，输出 choice、概率与置信度。
- 每次有效响应只尝试移动一格，包含真实碰撞终局；等待期间蛇不移动，不消费旧备用或沿原方向自动前进。快响应没有额外 sleep 或动画等待。
- 连续观战未指定尺寸时，按 seed 从 8×6、8×8、10×8、12×9、14×10、16×12 六档地图中均匀抽取，每档概率约为 16.7%，默认障碍数分别为 1、1、2、3、3、5；当前进行中的对局、恢复和历史分支保持保存的尺寸与布局，新轮次才使用这组梯度。CLI 未指定尺寸仍从 8×6、10×8、12×9、16×12、20×15、24×18 六种大小中均匀抽取，每种概率约为 16.7%。独立抽样允许相邻两局相同。28×21 和 32×24 暂不进入随机池。默认障碍数为棋盘面积除以 36 向下取整，CLI 六档分别为 1、2、3、5、8、12 个。显式 CLI 或环境变量可固定任一尺寸和障碍数。未指定 seed 时，每局生成并保存新 seed；固定 seed 在同一随机池内可复现默认尺寸，局中、回放和重启续跑均不重抽。
- API、连续观战和 CLI 新局使用 `config.layoutVersion=3`：随机选择出生方向及位置，保留初始 4 格蛇身和正前方 3 格空间。可容纳开局的方向等概率抽取（默认棋盘四向各 25%；高度不足 7 格时仅左右），障碍避开开局区域并保证空地连通，同时按黑白格配额生成，使剩余两色格数差不超过 1。合法蛇身沿网格黑白交替，色数差超过 1 的地图不可能填满；配额只排除这个必要条件反例，不保证任意地图或策略都能通关。配色从 24 组中按种子选取，包括 8 组整条统一的纯色、8 组同色系深浅变化、8 组不同颜色的组合，三类各占约三分之一，整局、刷新、回放和分支续局保持一致；固定种子可复现开局。缺少 `layoutVersion` 或显式为 2 的历史记录继续使用原规则、配色和 RNG；新建默认升级，旧局恢复、分支及幂等重试不重抽地图。
- 最小宽度 7 用于容纳初始蛇和前方三格安全区；高度为正整数。障碍配置必须满足出生安全区和空格连通性，否则明确报错。
- Ctrl+C 通过受保护通道结束当前对局，保留已提交记录。
- 没有密钥时 runner 明确拒绝启动。API 或格式错误会暴露错误并记录模型调用中断，不切换其他模型或自动寻路策略。
- runner 输出 model_request_started / model_request_cancelled / model_request_failed，记录观察步、目标步和取消或失败的等待时间；终局不会吞掉真实调用错误。只有返回并提交的结果才算模型决策。
- 概率合计不等于 1（例如 0.99）只输出 model_response_warning，并在决策面板提示；方向照常提交，原始概率保留，不自动归一化或停止对局。

运行器支持 --name、--url、--step-mode response 和 --decision-mode single_step。显式 fixed、two_step_fallback、--tick-ms 已停用，会在开局前报错。旧两步实验仅作为 [历史验收记录](openspec/changes/add-two-step-decision-fallback/validation.md) 保留。官方接口及模型约定见 [API 文档](https://docs.typesafe.ai/api) 和 [模型列表](https://docs.typesafe.ai/models)。

## 从历史卡点续跑

仅支持从原响应单步局续跑。使用原局 ID 和目标事件序号创建分支，当前配置的真实模型从该局面继续决策；旧 fixed/两步局仍能查看和回放，新的续跑请求明确返回 mode_retired，不转换或删除旧记录：

```sh
bun run jev --fork-match 334e1e69-17b0-4875-8f48-916a8d4b1db8 --fork-seq 3273 --name 'JEV · 从第1628步续跑'
```

`--fork-seq` 是事件序号，不是步数；应选择错误决策之前的事件。只能从 ready/running 局面继续，终局事件会明确拒绝。两项参数必须一起提供，且不能同时传地图、seed、步频或决策模式参数；这些配置完整继承自原局，创建配置的环境默认值不覆盖原局。

服务端从种子逐事件重放真实引擎并校验棋盘，恢复随机数进度、得分、蛇身和累计游戏时间；任何历史缺失或重放不一致都会报错。分支复制截至目标的历史，让模型保留已执行的决策和进度证据，随后使用最新上下文与提示词继续调用模型。旧排队动作与控制凭证不继承，停机时间不计入游戏。原局和未来事件保持不变。

观战与回放标注来源；分支回放默认打开续跑起点，也能从头查看继承的历史。底层接口为管理员认证的 `POST /api/matches/:id/fork`，请求包含 `requestId`、`controlToken`、`agentName`、`model` 和 `sourceSeq`，返回新局面及 `forkedFrom` 来源。

## 随模型响应推进

`--step-mode response` 或 `SNAKE_STEP_MODE=response` 选择该模式：蛇等待模型回答，服务端校验有效后在同一事务中保存动作与一次移动，runner 收到 applied 确认后立即读取新局面并再次询问。每次最多一个模型请求在途，没有移动定时器、额外 sleep 或动画等待。

- response 自动选用 single_step；显式组合 `--decision-mode two_step_fallback` 会在创建前报错。显式组合 `--tick-ms` 同样报错，遗留环境变量 `SNAKE_TICK_MS` 只提示弃用，不参与计时。
- 模型输入明确标注 response、当前观察 tick 与唯一的下一 tick，固定间隔与截止为 null。gameTimeMs 使用服务端取得上下文时的真实已运行时间；保存的原始正文不包含凭证。
- 等待期间蛇不移动；星星仍按真实时间 8 秒到期。到期导致局面摘要过时时，拒绝事实会保存，runner 重新读取当前局面再询问。模型选择直接反向时保存 invalid_direction 拒绝并明确中断，不对同一局面反复请求。
- 请求下一次模型决策前，服务端按真实身体、增长和尾格释放规则检查四方向；全部不可走时记录 `trapped` / `no_legal_moves` 终局，不增加步数、不改选方向、不调用模型。尚有合法出口时不触发该终止条件。
- 只有有效响应会走一步，碰撞也属于一次移动尝试。重复请求不会多走；错误目标、协议错误或 API 失败会明确暴露并中断，不自动补方向、换模型或重试隐藏失败。
- 观战展示“随模型响应”、真实最近一步间隔与已记录平均步频；等待和观战断线分别提示。平均步频是已记录移动次数除以记录时长，零步或时长为零时不生成虚构速度。
- `lastStepDurationMs` 是距上一次移动的真实间隔，第一步从 start 计算；它包含模型请求与 HTTP/WS、持久化等实际开销。`requestMs` 仅是模型调用往返耗时。回放按原始事件 gameTimeMs 保留快慢间隔，同时间戳按 seq 排序，倍速只缩放时间差。
- 主动停止保存包括等待在内的真实时长。进程异常退出后只保留最后已提交位置和时间，重启不补步、不把停机时间算入原对局。

新局仅使用 response/single_step，不支持局内切换。

## 旧配置与历史兼容

- `SNAKE_STEP_MODE` 可以省略或设为 `response`；旧的 `fixed` 值应改为 `response` 或移除。显式 CLI fixed、two_step_fallback、--tick-ms 及创建 API 的旧模式/数值步长明确拒绝。
- 遗留 `SNAKE_TICK_MS` 不参与响应模式计时，只输出可见的弃用提示，不阻断开局；删除该变量即可消除提示。程序不会修改已有 `.env`。
- 历史缺少推进模式仍按当时 fixed 语义读取。旧单步/两步的时间、原始模型正文、联合概率、备用和直行记录保持不变；不重新执行模型或队列。
- 重启会在最后确认位置中断旧 running 局并取消未执行主动作/备用；旧 fixed ready 局可读和停止，但不能重新启动或创建续跑分支。
- 原响应局的续跑继续完整继承配置、布局、RNG、累计时间与进度历史，不应用新建地图/模式的环境默认值。没有新增记录版本或数据库迁移。

`requestMs` 仅为模型往返；`reactionMs` 为观察到收件的端到端耗时；`lastStepDurationMs` 为两次实际移动的间隔。缺失耗时不填零，不把等待时间冒充纯推理时间。

## 当前模型输入：精简的吃果后续路检查 v16

实时入口使用 `compact-growth-v16`。保留 V15 的完整字符图、身体顺序、静态/动态事实、搜索预算和真实历史；只移除 state 中逐步重复的 `rules`、`factsSemantics`、`dynamicSemantics` 长说明，把核心规则集中为短 instructions，方向 criteria 只保存方向名。字符图和图例仍放在 instructions，state 保留同一份图以便校验与回放；原始请求按实际发送内容保存。JEV 仍选择每次实际执行的方向。详见 [V16 精简说明](docs/jev-compact-growth.md)，分析事实的定义沿用 [V15 说明](docs/jev-growth-space.md)。

- 困死检查最多从当前动作起推演 8 步，吃当前苹果后正确保留尾巴并继续检查。后续假设不再增长，构造更宽松的几何条件；只有所有续路仍会耗尽、且已排除额外增长提前满盘的可能，才标记 `proven_trap`。其余窗口结果、近满盘例外、预算耗尽明确区分，不宣称安全。
- 当前实时苹果候选最多搜索 128 步（历史 V15 构造器保留 32 步），每个增长端点再检查吃果后的 8 步，而非只数即时出口。已证明吃后困死的到达方式会被拒绝，继续搜索不同身体排列的到达方式；这些拒绝不会移除模型的方向选项。
- `route_with_optimistic_continuation` 仅表示找到“此后不再增长”的条件下可继续走满检查窗口的候选；`route_postcheck_unknown` 表示吃后检查未完成或近满盘例外，不能当作通过。未知未来苹果不被采样、预测或写进模型输入。
- 每方向的困死搜索、进食搜索各保留原 2048 状态预算；该方向所有增长端点的后续检查累计共享另一个 2048 节点预算，避免候选数量与每次检查预算相乘。队列和去重结构同样有界。预算、访问数和拒绝的进食到达数都存档可见。
- 后续检查质量相当时，提示模型优先较短的已验证进食候选，而非眼前空格、出口或曼哈顿距离。每个 runner 保留候选的内部路线；实际动作吻合时优先重新验证剩余路线及吃后检查，同样消耗已记录的搜索预算。吃果、局面不匹配、跳步、换局或重启后重新搜索；路线不代替模型选择，不读取未来苹果或 RNG。
- 字符图及图例仍在 `instructions` 和 `state.board.ascii`，回放展示增长后检查的相对步数、乐观假设、未知原因和共享预算。旧 [V14](docs/jev-dynamic-space.md)、[V13](docs/jev-legal-space.md)、[V12](docs/jev-repository-strategies.md) 请求保持原文与原语义。
- `JEV_DYNAMIC_ANALYSIS=false` 显式切回 V13；默认启用 V16 精简输入，分析逻辑仍为 V15。非法配置直接报错。没有自动代选、超时直行或隐藏重试，原始概率继续保留；无进展时由独立保护结束本局，频道是否续局取决于具体结束原因。

分析预算不是对局终止条件。即时有出口、窗口内有路和整局通关需要分别判断；吃后乐观续路也不是未来增长下的安全保证。

## 历史搜索实验与回放

v6 原始坐标构造器位于 `server/jev/board-context.ts`。v7 本步事实、v8 当前连通区域、v9 有预算前瞻、v10 吃后乐观检查构造器已隔离到 `server/jev/search-context.ts`，只供显式离线实验，不从实时 client 重新导出。旧 v3/v4/v5 无界分析构造器仍位于 `server/jev/analysis-context.ts`。

旧 v10 在总节点预算内检查吃果后的无增长乐观路径，不能保证真实未来安全；旧 v9 只查看立即出口。所有旧版本按当时保存的正文读取，不补入新版本字段。历史比较脚本仍可显式运行，但不代表当前模型自主规划链路：

```sh
bun scripts/evaluate-local-search.ts --live --baseline v9 --layout-version 3 --seeds bounded-search-a,bounded-search-b --steps 350
```

这个脚本仅比较历史 v8/v9 与 v10，使用独立的离线搜索配置；不会切换实时观战。评估调用观察窗口结束时未完成的局标为 `censored`，不算赢或输。API/格式错误单列并返回非零退出码，不隐藏重试。比较通关率须单列未完和调用失败，不能用吃果数量代替通关。

以下说明和验收链接同样描述历史方案。

## 历史完整后果 context（v5）

历史单步请求使用 `action-outcomes-v5`，四个方向保持完整、固定顺序，由 JEV 自主选择。每个选项将 `summary`（完整事实句）、`survival`（这个方向全部续路的结果）和 `appleRoute.postApple`（一条具体进食路线的增长端点）放在一起；能吃到苹果不等于该方向能够通关。

- `survival` 区分非法反向、当前碰撞、立即满盘、所有续路已证必死、尚未证明必死。碰撞上界包含候选动作和致死尝试；非法反向不执行移动，没有死亡上界。
- `appleRoute` 只保留一条已验证的动态/静态候选，不再同时发送 v4 的静态 `appleRoute` 与动态 `opportunity`。吃后的死亡上界同时给出“从吃后起算”和“从当前观察起算”，不会把一条路线端点必死扩大为同方向的所有续路必死。
- 若该方向整体未证必死、但初始苹果路线吃后已证必死，会继续搜索其他身体排列下的苹果终点。找到不同终点后重新生成全部路线事实；否则明确报告完整搜索耗尽。`appleAlternativeSearch` 为可选的搜索来源字段，兼容早期 v5；未证必死仍不保证长期安全。初始和替代见证都保留供回放核验。
- `noGrowthCycle` 与 `bodyReleasePassages` 保留其条件范围；循环不代表获得苹果，未知不代表安全。
- v5 请求移除了 `witnessContinuity` 和它的 `nextDirection`，只保留实际提交历史 `progress`；不会将程序发现的旧路线作为下一动作暗示。完整见证仍存入 `decision.evidence`，不发给 provider。
- 所有方向均可由模型选择，包括已证明危险的方向；程序不重排、不过滤、不代选，也不重试挑选满意答案。

旧 v3/v4 原始请求仍可读取；离线评估显式使用 `decisionBodyV3`、`buildDecisionContextV4` 和 `buildDecisionContextV5`，不会重写已保存对局。回放按实际版本显示摘要和作用范围，复制内容仍是实际 provider 请求。

```sh
# 固定局面对照；默认离线。历史失败局保留原始v4请求和旧方向引用。
bun scripts/evaluate-outcome-context.ts --out .data/qa/outcome-context-v5/offline.json
# 显式真实对照：5局面×2版本×3轮，预定30次，所有结果保留、不提交游戏。
bun scripts/evaluate-outcome-context.ts --live --repeats 3 --out .data/qa/outcome-context-v5/live.json
```

验证记录见 [v5 后果表达修复](openspec/changes/fix-jev-outcome-presentation/validation.md)。固定局面选择改善与整局成绩分开统计。

## 历史动作事实 context（v3 / v4）

此前的 v4 请求使用 `action-facts-v4`，以下描述其历史语义。程序计算动作后果和已验证的机会，JEV 在完整四方向中自主选择，不按分数、概率或启发式改选。单步摘要只在 `questions.direction.criteria` 保存一份；`progress-v1` 历史与正向摘要发给模型，完整 `positive-v1` 路线保存在 `decision.evidence`，不发送给模型；不生成第二步问题或计划。请求保留必要局面与真实计时，完整棋盘仍在 observedSeq 对应事件中。旧两步 context 仅供历史读取与离线对照。

身体与固定障碍共同参与碰撞分析，非增长时尾巴离开原格，吃苹果时尾巴保留；分析与真实移动共用 `inspectMove` 规则，不改变原状态或 RNG。

| 摘要 | 含义与边界 |
| --- | --- |
| `danger` | 每个选项的直接危险结论：`immediate_collision` 为即时碰撞/非法反向，`proven_fatal` 为强制撞死、已证实陷阱、所有出口都有死亡证书的分叉，或吃苹果后即使不再增长仍必撞的局面，`null` 仅表示尚无死亡证明。标签描述证据，不用于过滤选项或替模型改选。旧 v3 没有该字段时不补算。 |
| `immediateCollision` / `forcedPath` | 即时碰撞与动态强制通道。后续仅有一个合法方向时推进副本，直到碰撞、分叉、完整身体与朝向重复、吃苹果或完成棋盘。`steps` 包含候选动作和最后的碰撞尝试；`branch` 不保证后续安全，`unknown_after_apple` 不推测新苹果。 |
| `space` | 执行动作后冻结身体的可达格数、身体长度比较、立即合法出口和静态头尾连通性。可达格数包含头、阻塞其余身体含尾巴；头尾连接只把尾格作为终点打开。静态小区域或不连通不证明动态必死。 |
| `appleRoute` / `postEat` | 冻结身体下的一条最短候选路线，再逐步移动身体验证，报告吃后出口、空间与头尾连接。等长路线按固定顺序取一条，`no_static_path` 不表示所有动态路线不存在；该路线吃后无出口也不否定该第一方向的其他路线。填满棋盘标为胜利，不以无出口当失败。 |
| `starRoute` | 不经过当前苹果的星星候选路线、观察时剩余时间及名义到达条件。当前 response 的未来到达时间未知；旧 fixed 历史保留当时按截止计算的到达条件。几何接触不承诺实际得到星星分数。 |

路线距离包含当前候选动作；未来随机奖励不被预测。正向机会是存在见证，不是推荐方向、存活概率或必须遵循的路线。

提示词给出完成棋盘、收集奖励的游戏目标，并解释事实与未知的边界；方向取舍、吃食物时机与探索策略由 JEV 自主决定。静态连通性、一条已验证路线及模型概率均不是存活保证，历史方向对的概率仍属于整个方向对。历史 v4 保留 v3 的候选路线事实并补充正向机会；旧正文和各已支持版本 context 均保持原文可读。

`contextBuildMs` 记录本地分析与请求对象构建耗时，`requestBytes` 记录实际发送正文的 UTF-8 字节数；`requestMs` 单独记录模型调用往返，`inputTokens` 仅使用服务商真实返回值。回放展示保存的版本与成本，旧记录缺少数据显示“未记录”，不重算；未知 context 版本明确提示语义不支持，仍可查看和复制原始 JSON。

吃苹果后先在“未来不再增长”的乐观几何中检查全部合法分支：如果仍有有限死亡证明，额外增长只会占据更多格子。仅当剩余空格数不少于碰撞上界时采用该证明，排除连续增长先填满棋盘获胜的可能。这个证明不读取未来 RNG，不把上界写成精确未来步数；存在可循环路线或尚无完整证明时保持未知。

分叉死亡证据组合强制碰撞、封闭区域、吃后必死和已有单分叉证书。显式栈逐支检查所有待证出口，只有所有合法出口都能证明死亡，才把结论传回入口，给出最迟碰撞步数。当前路径重复、存在真实可循环路线、获胜或未证明的苹果后续时保持未知。已完成的子证明按局面复用，分支汇合不当成循环；没有搜索深度、时间或节点数上限。分析器还动态验证“蛇头到尾部再沿原身体返回”的完整闭环，作为无法判定必死的真实见证，不把路线交给控制器。模型收到入口与首分叉的上界、证书种类和结构计数；摘要同样复用共享子证明的计数，避免重复展开，计数精度溢出明确报错。

## 历史正向路线与跨步相容证据

离线 v4 分析器中，四方向均使用同样的分析流程：先验证静态食物候选，再按有序身体、朝向和已知苹果搜索动态状态。找到当前苹果或完整无增长循环时保存具体路线；全部状态穷尽才报告 exhausted。内部距离仅决定搜索遍历次序，不排序模型的四个动作，不替模型执行路线，也不加搜索深度、节点数或耗时上限。

- `opportunity`：存在见证、路线步数、苹果终点/循环周期、身体格的最快释放步数和路线实际进入步数。找到的路线不宣称最短。
- `opportunity.postEat`：只描述该见证的实际增长终点；不借用另一条静态路线的出口。新苹果位置未知，循环也不等于进食进展或永远安全。
- `state.witnessContinuity`：当前完整几何与先前路线经过 `stateCompatibleAfterMoves` 步的预测相容；不同走法可能汇合，因此不声称真实走过相同前缀，更不代表模型承诺跟随。摘要保留目标与证据范围，相容旧路线一并存档；相同剩余路线按事实去重。
- `decision.evidence`：独立于 provider HTTP body 的完整路线、起始几何和结束几何，用于回放核验。回放原始 JSON/复制仍是实际模型请求，不补入后台档案。

离线及固定局面对照入口：

```sh
bun scripts/evaluate-positive-context.ts --samples 10 --out .data/qa/context-v4/offline.json
# 显式真实请求：4个固定局面，各发送v3/v4一次，共8次；不创建对局、不重试挑结果
bun scripts/evaluate-positive-context.ts --live --out .data/qa/context-v4/live.json
```

报告分别记录 provider 输入字节、后台档案字节、构建时间、真实模型选择与 usage；历史未提供时标为 not_provided。固定局面和本地规则测试不等于整局胜率验证。

## 重复路线与食物进展

新 runner 会把服务端提供的 `state.progress`（`historyVersion: progress-v1`）送给 JEV。服务端按当前观察 seq 增量读取已提交事件，记录距上次吃苹果的步数、当前完整局面出现次数、重复间隔，以及各方向实际执行后又回到该局面且没吃苹果的次数。完整局面包括有序蛇身、朝向、棋盘/障碍和可见食物；tick、时钟、分数和请求 ID 不会让同一局面变成新局面。

只有实际移动才记录执行方向，包含旧 fixed 历史中实际执行的备用和直行。同 tick 的等待、请求接纳/拒绝或重新询问不增加移动和重复计数；吃苹果后清空该次无苹果周期的局面统计，旧选择不会污染新食物阶段。缓存从保存的事件构建，终局释放；丢失或不一致历史明确报错。

进展信息只陈述真实历史，不要求“未尝试方向优先”，不按执行次数排序。JEV 根据完整棋盘、规则、目标和这些历史自主选择，当前 V13 仅提供本步合法方向，返回选择原样提交。重复记录帮助模型看到已经发生的绕圈，不保证模型一定会改变路径。

当前单步使用已提交历史；旧两步历史仍只代表实际执行事实。历史旧 v3 正文没有 progress 时仍可读取，不补写零值；新生产 runner 遇到旧服务没有历史字段会在模型调用前明确拒绝。回放显示当时保存的无进展与重复信息。此前带策略偏好的版本的真实局面和同图验证见 [循环修复验收](openspec/changes/improve-jev-decision-context/loop-fix-validation.md)。

历史分析版本的事实回归与真实模型选择见 [分叉证据与自主决策验收](openspec/changes/improve-jev-decision-context/branch-autonomy-validation.md)。此前的通关记录保留当时原始提示词，不作为当前版本必胜的证明。

多层分叉优化的真实回归与性能记录见 [证据链优化验收](openspec/changes/improve-jev-decision-context/proof-chain-validation.md)；多出口与增长后漏判修复见 [全分支证明验收](openspec/changes/improve-jev-decision-context/multi-exit-validation.md)。

## 历史 Context 评估

```sh
# 默认离线：无需密钥，不发外部请求；--out 是 JSON 文件路径
bun scripts/evaluate-context.ts --out .data/qa/context-v3/offline.json
# 显式启用真实请求；读取 .env 中的 provider/model/对应密钥
bun scripts/evaluate-context.ts --live --out .data/qa/context-v3/live.json
```

离线使用开局、历史 tick 364 死胡同和近满盘的共享 fixture，比较固定保存的 v2 正文与 v3 正文大小，测量历史 fixed 单步/两步与 response 单步构建耗时 p50/p95；fixed/两步数据仅为离线对照。`--samples` 可指定每项采样次数，默认 30。旧 v2 fixture 未采集构建耗时，报告保留未记录，不填零；v3 不保证在每个短蛇局面都比 v2 更小。报告的 500ms 截止仅用于旧实验对照，当前响应模式没有移动截止。

`--live` 仅对三个 fixture 的 response 单步 v3 正文串行请求，共 3 次，不再调用 fixed/两步。保存 provider/model、原文、选择、耗时、真实 usage 与错误，不提交到游戏。历史 v4 与 v3 的 response 单步对照使用 `scripts/evaluate-positive-context.ts`，每个 fixture 两次串行请求；输出明确标注 fixture 和测量版本。离线输入不代表整局成绩，有限模型样本不证明随机地图必胜。

## 游客界面

- 观战：真实棋盘、分数、步数、当前移动来源、模型原始概率与连接状态；最近收到的模型响应与当前实际执行动作分开展示。
- 指定对局观战地址为 /watch/:matchId，进入即读取最新状态并通过 WebSocket 跟随更新；刷新与切换对局保持 URL 和选中局一致。历史中等待开始/进行中的对局显示“观战”，终局显示“回放”。
- 历史：参与者和结果筛选，区分固定步频与随模型响应；显示配置速度或已记录平均速度、结束原因，支持游标分页。
- 回放：播放/暂停、时间轴、前后步进、关键事件跳转、0.5×/1×/2×/4×。
- 决策输入：在回放下方选择一次决策，查看并复制实际发送的 JSON、context 版本与已记录输入成本；区分当前 v12 排除反向的模型自主规划、历史 v11、历史 v10 吃后后果、v9 有预算前瞻、v8 全局当前空间、v7 一步事实、v6 完整棋盘、历史坐标 context、v3 动作摘要、v4 机会证据与 v5 后果摘要。旧记录未保存正文时明确提示，未知版本保留原始 JSON。
- 回放读取保存的真实状态，不重新运行模型或随机数。
- 进行中对局的回放会明确提示不会自动追随进度，并提供“进入实时观战”链接。
- 断线时保留最后确认局面并明确提示；重连按事件序列续读。已 gameover/won 的单局停止实时订阅，服务断开后不再无休止重连；可恢复的中断局仍可接收续跑更新。
- 连续频道的未完成响应局在服务重启后以同一个对局编号恢复，记录中保留中断与续跑事件；已保存的模型故障不会自动重试。手动 CLI 对局不会被频道接管，旧推进模式仍只读。停机时间不补步、不计入游戏时间。
- 减少动态效果设置取消装饰动效和插值；视频默认静音、由用户点击播放。

奖励图片来自本次 ImageGen 生成素材；片头和胜利视频来自用户提供的 Seedance 文件。胜利素材的实际时长为 4.064 秒。

## API

所有网页访问都是公开只读。写操作在服务端校验权限，密钥不进入网页构建、URL 或公开事件。

| 入口 | 用途 |
| --- | --- |
| GET /api/health | 服务状态及本进程的 JEV 密钥配置状态 |
| GET /api/matches | 列表，支持 agent/status/cursor/limit |
| GET /api/matches/:id | 最新已提交局面及服务器时间元数据 |
| GET /api/matches/:id/events?afterSeq=-1 | 按序读取事件，默认每页 200 条 |
| POST /api/matches | 创建 ready 对局，需 GAME_ADMIN_TOKEN |
| GET /api/matches/:id/decision-context | 获取当前实际局面与紧接着的移动目标，需该局控制 token |
| WS /ws/matches/:id/watch | 游客订阅，发送 subscribe 和 afterSeq |
| WS /ws/matches/:id/control | 程序化控制者，握手 Authorization: Bearer 控制 token |

创建方生成高熵 controlToken 并随创建请求提交，服务端仅保存 hash。创建请求和控制请求均有唯一 requestId：相同请求重发返回已保存结果；同 ID 不同内容明确冲突。

当前控制仅使用 `protocolVersion: 1` 的 start/action/stop，health 的 supportedProtocolVersions 为 `[1]`。新的 v2/plan 请求明确拒绝，已保存旧请求的幂等重发只返回原回执，不重新执行。

新局使用 recordVersion/rulesVersion 3/3，配置为 response/single_step/null。新建 API 省略模式时写入明确值；旧固定单步 1/1、两步 2/2 和响应 3/3 的读取语义保持不变，未知版本明确报错。记录版本与控制协议版本不同。回退代码时保留 v3 读取能力，不删除历史。请求形状见 scripts/run-jev.ts 和 shared/snake/schema.ts。

## 配置

| 环境变量 | 说明 |
| --- | --- |
| GAME_ADMIN_TOKEN | 必填，至少 32 个字符，仅用于受保护创建接口 |
| SQLITE_PATH | 必填，数据库路径；Bun 脚本从项目目录运行，生产建议用绝对路径 |
| GAME_PORT / GAME_HOST | 默认 3001 / 127.0.0.1 |
| GAME_SERVER_URL | runner 与开发代理的后端地址，可选 |
| JEV_PROVIDER | 默认 typesafe，可显式设置 openrouter |
| TYPESAFE_API_KEY | Typesafe 独立密钥，仅服务端使用，禁止 VITE_ 前缀 |
| OPENROUTER_API_KEY | 仅选择 OpenRouter 时使用的独立密钥 |
| JEV_MODEL | 可选；Typesafe 默认 jev-1.13.0，OpenRouter 默认 typesafe/jev-1.13 |
| JEV_LOCAL_SEARCH | 已退出实时配置；实时固定为原始观察输入 |
| JEV_SEARCH_DEPTH | 仅历史离线搜索实验使用，实时不读取 |
| JEV_SEARCH_NODES | 仅历史离线搜索实验使用，实时不读取 |
| SNAKE_STEP_MODE | 默认且仅支持 response；CLI --step-mode response 可显式声明 |
| SNAKE_TICK_MS | 已弃用；遗留值仅提示，不阻断运行，删除后停止提示；显式 --tick-ms 拒绝 |
| SNAKE_WIDTH / SNAKE_HEIGHT | 可选；未设置时观战使用 8×6 至 16×12 六档，CLI 使用独立的 8×6 至 24×18 六档 |
| SNAKE_OBSTACLES | 可选；默认 `floor(width × height / 36)` |
| SNAKE_SEED | 可选；留空由 runner 随机生成 |
| VITE_ROUTER_DEVTOOLS | 显式设为 true 才显示开发工具 |

## 检查与构建

```sh
bun run test:snake
bun run typecheck
bun run build
```

测试使用临时的真实 SQLite 文件和真实 WebSocket 连接，覆盖事务失败、去重、等待不移动、局面失效、服务重启、记录损坏与游客权限。JEV HTTP 契约的自动测试使用测试专用传输数据，不代表已经完成真实模型性能测试。

使用 `bun run test` 或 `bun run test tests/game.test.ts` 运行 Vitest；`bun test` 是另一个测试运行器，本项目不使用。内存回归在 Bun 子进程中验证工作量、搜索预算和 GC 后保留堆小于 64 MiB，不再使用仅适用于 V8 的 `--max-old-space-size`，也不宣称验证了进程峰值或硬堆上限。

`bunfig.toml` 禁用脚本运行时自动读取 `.env`，避免测试自动加载本地模型凭证。游戏服务及 CLI 保留显式的 `dotenv/config`，前端配置通过 Vite `loadEnv` 读取；部署可使用 `start:server` 的 `--env-file=.env` 或环境变量提供配置。

类型检查与服务端编译使用 TypeScript 7 的 Go 原生编译器（原 `tsgo`）。正式版命令名恢复为 `tsc`，因此 `bun run typecheck` 和 `bun run build:server` 的调用方式不变；依赖由 `bun.lock` 锁定。命名与迁移说明见 [TypeScript 7 官方发布说明](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)。

Oxfmt 负责源码、测试和项目配置的格式化与 import 排序，Oxlint 负责代码检查。生成的路由文件不参与检查；格式化也不处理依赖锁文件、技能目录与 OpenSpec 历史文档。

```sh
bun run format        # 格式化并写入文件
bun run format:check  # 只检查格式，不修改文件
bun run lint          # Oxlint 代码检查
bun run check         # 依次检查格式和 lint
```

格式规则位于 `.oxfmtrc.json`（Tab 缩进、2 列宽度、80 列换行、双引号），lint 规则位于 `.oxlintrc.json`。Oxlint 使用默认插件的 correctness 规则并按错误报告；TypeScript 类型检查仍由 `bun run typecheck` 执行。

VS Code 安装项目推荐的 [Oxc 扩展](https://marketplace.visualstudio.com/items?itemName=oxc.oxc-vscode) 后，保存 JS、TS、JSX、TSX、JSON、JSONC 和 CSS 文件时会使用项目内的 Oxfmt 格式化，并执行 Oxlint 的安全修复。编辑器配置与终端使用同一套本地工具，参见 [官方设置说明](https://oxc.rs/docs/guide/usage/formatter/editors.html)。

开发模式中，Nitro 的预处理先于 Vite 的普通 HTTP proxy，因此 /api/** 在 Nitro devProxy 配置；WebSocket 由 Vite 的 upgrade proxy 转发。

本地 `preview` 使用 Nitro 构建产物和内置 `/api/**` 代理，WebSocket 沿用 Vite 的 `/ws` upgrade proxy；没有 HMR 客户端或源码监听。API 目标由构建时的 `GAME_SERVER_URL` / `GAME_PORT` 决定，保留浏览器 Origin 和管理员会话 cookie。

## 部署边界

构建同时生成 .server-build/ 后端和 .output/ 前端：

```sh
bun run start:server
# 另一个进程
bun run start
```

需要常驻 Bun 进程和持久磁盘。生产反向代理把 /api/ 和 /ws/ 交给 Hono（WebSocket 要支持 Upgrade），其余请求交给 Solid Start；开发代理不参与生产部署。现有 vercel.json 属于前端模板配置，不能把 SQLite 常驻服务当成已部署的 Vercel 功能。

SQLite 使用 WAL、外键和 FULL 同步。局面、事件和请求结果在同一事务内保存后才确认和推送。数据库写入失败会明确报错，不切换内存库；备份使用 SQLite 的一致性备份流程，不在写入期间只复制主文件。代码回滚不自动删除历史记录。

当前生产 context 固定 `non-reverse-v12`，服务端和回放同时保留旧版本的读取。完整棋盘输入不改变 SQLite 表或对局记录版本；回退时须保留读取已保存 v6/v7/v8/v9/v10/v11/v12 正文与响应 v3 对局的能力，不删除或重写历史。

## 棋盘显示与运动

蛇身沿真实有序身体绘制成一条连续轮廓，保留种子配色，相邻身体没有独立方块黑框。实时单步移动采用短缓动，头尾沿实际折线行进，转弯不斜切格子，增长时尾端保持；快速连续事件从当前视觉位置继续，不回跳。动画不延迟模型请求或实际游戏推进。回放拖动、跳步、终局和系统减少动态效果时直接对齐真实位置；断线补记录完成前不开启动画。
