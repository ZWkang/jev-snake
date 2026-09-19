# SNAKE · JEV 实时贪吃蛇

一个用于观察快速决策模型的贪吃蛇实验。游戏由 Hono 服务端管理，仅随模型有效响应逐步推进，每次决策只走一步，JEV 通过 Typesafe 或 OpenRouter API 选择方向；游客无需登录，可以实时观战、查看历史和逐步回放。

首版不提供人类操作、游客开局或接管。网页不会生成模拟 JEV 对局；没有真实记录时展示空状态。

## 本地启动

需要 Node.js 22.22+ 和 npm。依赖由 package-lock.json 锁定，SQLite 使用 better-sqlite3。

```sh
npm ci
# 首次配置；已有 .env 时不要覆盖
cp .env.example .env
# 生成 GAME_ADMIN_TOKEN，再填写 .env
openssl rand -hex 32
npm run dev
```

本地管理员凭证仅存放在 .env。服务默认地址：

- 网页：http://localhost:3000
- Hono：http://127.0.0.1:3001
- SQLite：.data/snake.sqlite

.env、数据库及 .data/ 下的验收记录不会提交到 Git。修改环境变量后重启相关进程。

## 首页与连续观战

- `/` 是独立首页，提供介绍、规则、连续观战与历史入口，有活动局时也不会替换为棋盘。
- `/watch` 跟随服务端连续频道；`/watch/:matchId` 只看指定的一局，结束后不自动跳到其他局。
- `/matches` 和 `/matches/:matchId/replay` 保留历史及回放。手动 CLI 对局不会被连续频道接管。

连续频道初始关闭。打开 `http://localhost:3000/watch?admin=1`，输入 `.env` 中的 `GAME_ADMIN_TOKEN` 解锁，再点击“开启连续观战”。`admin=1` 只显示管理入口，启停接口仍要求有效的服务端管理员会话；普通页面不显示管理控件。

开启后，正常终局并完成模型请求清理后，默认倒计时 5 秒自动开启下一局。关闭网页、注销管理或没有观众都不会停止频道。“停止连续开局”让已经开始的本局正常结束，然后不再开启下一局；在倒计时或准备阶段停止会取消尚未开始的局。等待本局结束期间重新开启会沿用当前局。

频道与 CLI 均仅运行响应单步，共用棋盘尺寸、障碍、种子以及 `JEV_PROVIDER`/`JEV_MODEL` 配置。蛇等待有效模型响应后才走一步，没有固定移动间隔。没有固定 `SNAKE_SEED` 时每局生成新种子。频道不代替模型选择方向，也没有强制限步或限时终局。

| 配置 | 默认值 | 含义 |
| --- | --- | --- |
| `WATCH_INTERMISSION_MS` | `5000` | 非负整数；0 表示正常结束清理后立即准备下一局 |
| `WATCH_PUBLIC_ORIGIN` | `http://localhost:3000` | 管理页面的精确 Origin，不带末尾斜线；管理写接口校验 Origin |
| `WATCH_SESSION_TTL_MS` | `28800000` | 管理会话有效期，默认 8 小时，必须为正整数 |
| `VITE_ROUTER_DEVTOOLS` | `false` | 显式启用路由面板及其 Vite 插件；默认不为每个观战标签创建额外的调试日志 SSE |

管理口令不写入 URL、localStorage 或前端构建。会话使用限定管理 API 路径的 HttpOnly、SameSite=Strict cookie；HTTPS Origin 使用 Secure。本地使用 `127.0.0.1` 而非 `localhost` 打开网页时，也需相应调整 `WATCH_PUBLIC_ORIGIN`。生产代理须转发 `/api` 和 `/ws`，并保持前端真实 Origin，不开放任意跨域管理请求。

模型/API/网络错误会明确中断频道，等待管理员点击“恢复连续观战”，不会自动换模型或新建替代局。关闭服务不等同于停止续局：重启会中断原局，再按此前保存的开关决定是否从完整倒计时继续；已经停止的频道仍停止，已保存故障不会自动清除，管理员会话需要重新解锁。

公开接口为 `GET /api/watch-channel` 和只读 `WS /ws/watch-channel`。管理员使用 `POST/GET/DELETE /api/watch-admin/session` 解锁、查询、注销，使用 `POST /api/watch-admin/commands` 提交 `{requestId, enabled}`；重复请求返回原确认与当前状态，不重复开局。

本功能将 SQLite schema v1 事务迁移为 v2，增加频道、轮次归属和命令去重记录，保留原对局与事件 JSON。升级前备份数据库；旧后端不能直接读取 v2。回退时可保留兼容 v2 的后端并停用频道；如必须恢复迁移前备份，应先停止写入，并明确备份之后的历史不在其中，不能静默降版本或删表。

## 跑一场真实 JEV 对局

在 .env 设置 TYPESAFE_API_KEY，然后保持开发服务运行，在另一个终端执行：

```sh
# 默认随模型响应：返回一次，立即走一步，再询问下一步
npm run jev
# 可显式声明唯一运行方式
npm run jev -- --step-mode response --decision-mode single_step
```

也可以明确地图参数：

```sh
npm run jev -- --width 24 --height 18 --obstacles 12 --seed experiment-01
```

- 默认通过 Typesafe 直连，固定模型 jev-1.13.0；JEV_MODEL 可显式选择其他官方版本或别名。
- 如需对照 OpenRouter，显式设置 JEV_PROVIDER=openrouter，并使用独立的 OPENROUTER_API_KEY；不会在失败时自动切换服务商。
- Typesafe 接口为 https://api.typesafe.ai/v1/systemone，输入 state/questions，输出 choice、概率与置信度。
- 每次有效响应只尝试移动一格，包含真实碰撞终局；等待期间蛇不移动，不消费旧备用或沿原方向自动前进。快响应没有额外 sleep 或动画等待。
- 默认地图 24×18、12 个障碍；尺寸和数量为开局参数，不随机改变尺寸。未指定 seed 时，每局随机生成并保存。
- 连续观战和 CLI 新局使用 `config.layoutVersion=2`：随机选择出生方向及位置，保留初始 4 格蛇身和正前方 3 格空间。可容纳开局的方向等概率抽取（默认棋盘四向各 25%；高度不足 7 格时仅左右），障碍仍避开开局区域并保证空地连通。配色从 24 组中按种子选取，包括 8 组整条统一的纯色、8 组同色系深浅变化、8 组不同颜色的组合，三类各占约三分之一，整局、刷新、回放和分支续局保持一致；固定种子可复现开局。缺少 `layoutVersion` 的旧记录及旧 API 配置继续使用原生成规则和配色，保证历史 RNG 可以精确恢复。
- 最小宽度 7 用于容纳初始蛇和前方三格安全区；高度为正整数。障碍配置必须满足出生安全区和空格连通性，否则明确报错。
- Ctrl+C 通过受保护通道结束当前对局，保留已提交记录。
- 没有密钥时 runner 明确拒绝启动。API 或格式错误会暴露错误并记录模型调用中断，不切换其他模型或自动寻路策略。
- runner 输出 model_request_started / model_request_cancelled / model_request_failed，记录观察步、目标步和取消或失败的等待时间；终局不会吞掉真实调用错误。只有返回并提交的结果才算模型决策。
- 概率合计不等于 1（例如 0.99）只输出 model_response_warning，并在决策面板提示；方向照常提交，原始概率保留，不自动归一化或停止对局。

运行器支持 --name、--url、--step-mode response 和 --decision-mode single_step。显式 fixed、two_step_fallback、--tick-ms 已停用，会在开局前报错。旧两步实验仅作为 [历史验收记录](openspec/changes/add-two-step-decision-fallback/validation.md) 保留。官方接口及模型约定见 [API 文档](https://docs.typesafe.ai/api) 和 [模型列表](https://docs.typesafe.ai/models)。

## 从历史卡点续跑

仅支持从原响应单步局续跑。使用原局 ID 和目标事件序号创建分支，当前配置的真实模型从该局面继续决策；旧 fixed/两步局仍能查看和回放，新的续跑请求明确返回 mode_retired，不转换或删除旧记录：

```sh
npm run jev -- --fork-match 334e1e69-17b0-4875-8f48-916a8d4b1db8 --fork-seq 3273 --name 'JEV · 从第1628步续跑'
```

`--fork-seq` 是事件序号，不是步数；应选择错误决策之前的事件。只能从 ready/running 局面继续，终局事件会明确拒绝。两项参数必须一起提供，且不能同时传地图、seed、步频或决策模式参数；这些配置完整继承自原局，创建配置的环境默认值不覆盖原局。

服务端从种子逐事件重放真实引擎并校验棋盘，恢复随机数进度、得分、蛇身和累计游戏时间；任何历史缺失或重放不一致都会报错。分支复制截至目标的历史，让模型保留已执行的决策和进度证据，随后使用最新上下文与提示词继续调用模型。旧排队动作与控制凭证不继承，停机时间不计入游戏。原局和未来事件保持不变。

观战与回放标注来源；分支回放默认打开续跑起点，也能从头查看继承的历史。底层接口为管理员认证的 `POST /api/matches/:id/fork`，请求包含 `requestId`、`controlToken`、`agentName`、`model` 和 `sourceSeq`，返回新局面及 `forkedFrom` 来源。

## 随模型响应推进

`--step-mode response` 或 `SNAKE_STEP_MODE=response` 选择该模式：蛇等待模型回答，服务端校验有效后在同一事务中保存动作与一次移动，runner 收到 applied 确认后立即读取新局面并再次询问。每次最多一个模型请求在途，没有移动定时器、额外 sleep 或动画等待。

- response 自动选用 single_step；显式组合 `--decision-mode two_step_fallback` 会在创建前报错。显式组合 `--tick-ms` 同样报错，遗留环境变量 `SNAKE_TICK_MS` 只提示弃用，不参与计时。
- 模型输入明确标注 response、当前观察 tick 与唯一的下一 tick，固定间隔与截止为 null。gameTimeMs 使用服务端取得上下文时的真实已运行时间；保存的原始正文不包含凭证。
- 等待期间蛇不移动；星星仍按真实时间 8 秒到期。到期导致局面摘要过时，或模型选择了直接反向时，拒绝事实会保存，runner 重新读取当前局面再询问，不死等 tick 变化。
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

## 模型的动作后果 context

新请求使用 `action-facts-v4`。程序计算动作后果和已验证的机会，JEV 在完整四方向中自主选择，不按分数、概率或启发式改选。单步摘要只在 `questions.direction.criteria` 保存一份，另附 `positive-v1` 见证与 `progress-v1` 真实历史；不生成第二步问题或计划。请求保留必要局面与真实计时，完整棋盘仍在 observedSeq 对应事件中。旧两步 context 仅供历史读取与离线对照。

身体与固定障碍共同参与碰撞分析，非增长时尾巴离开原格，吃苹果时尾巴保留；分析与真实移动共用 `inspectMove` 规则，不改变原状态或 RNG。

| 摘要 | 含义与边界 |
| --- | --- |
| `danger` | 每个选项的直接危险结论：`immediate_collision` 为即时碰撞/非法反向，`proven_fatal` 为强制撞死、已证实陷阱、所有出口都有死亡证书的分叉，或吃苹果后即使不再增长仍必撞的局面，`null` 仅表示尚无死亡证明。标签描述证据，不用于过滤选项或替模型改选。旧 v3 没有该字段时不补算。 |
| `immediateCollision` / `forcedPath` | 即时碰撞与动态强制通道。后续仅有一个合法方向时推进副本，直到碰撞、分叉、完整身体与朝向重复、吃苹果或完成棋盘。`steps` 包含候选动作和最后的碰撞尝试；`branch` 不保证后续安全，`unknown_after_apple` 不推测新苹果。 |
| `space` | 执行动作后冻结身体的可达格数、身体长度比较、立即合法出口和静态头尾连通性。可达格数包含头、阻塞其余身体含尾巴；头尾连接只把尾格作为终点打开。静态小区域或不连通不证明动态必死。 |
| `appleRoute` / `postEat` | 冻结身体下的一条最短候选路线，再逐步移动身体验证，报告吃后出口、空间与头尾连接。等长路线按固定顺序取一条，`no_static_path` 不表示所有动态路线不存在；该路线吃后无出口也不否定该第一方向的其他路线。填满棋盘标为胜利，不以无出口当失败。 |
| `starRoute` | 不经过当前苹果的星星候选路线、观察时剩余时间及名义到达条件。当前 response 的未来到达时间未知；旧 fixed 历史保留当时按截止计算的到达条件。几何接触不承诺实际得到星星分数。 |

路线距离包含当前候选动作；未来随机奖励不被预测。正向机会是存在见证，不是推荐方向、存活概率或必须遵循的路线。

提示词给出完成棋盘、收集奖励的游戏目标，并解释事实与未知的边界；方向取舍、吃食物时机与探索策略由 JEV 自主决定。静态连通性、一条已验证路线及模型概率均不是存活保证，历史方向对的概率仍属于整个方向对。当前 v4 保留 v3 的候选路线事实并补充正向机会；旧正文和各已支持版本 context 均保持原文可读。

`contextBuildMs` 记录本地分析与请求对象构建耗时，`requestBytes` 记录实际发送正文的 UTF-8 字节数；`requestMs` 单独记录模型调用往返，`inputTokens` 仅使用服务商真实返回值。回放展示保存的版本与成本，旧记录缺少数据显示“未记录”，不重算；未知 context 版本明确提示语义不支持，仍可查看和复制原始 JSON。

吃苹果后先在“未来不再增长”的乐观几何中检查全部合法分支：如果仍有有限死亡证明，额外增长只会占据更多格子。仅当剩余空格数不少于碰撞上界时采用该证明，排除连续增长先填满棋盘获胜的可能。这个证明不读取未来 RNG，不把上界写成精确未来步数；存在可循环路线或尚无完整证明时保持未知。

分叉死亡证据组合强制碰撞、封闭区域、吃后必死和已有单分叉证书。显式栈逐支检查所有待证出口，只有所有合法出口都能证明死亡，才把结论传回入口，给出最迟碰撞步数。当前路径重复、存在真实可循环路线、获胜或未证明的苹果后续时保持未知。已完成的子证明按局面复用，分支汇合不当成循环；没有搜索深度、时间或节点数上限。分析器还动态验证“蛇头到尾部再沿原身体返回”的完整闭环，作为无法判定必死的真实见证，不把路线交给控制器。模型收到入口与首分叉的上界、证书种类和结构计数；摘要同样复用共享子证明的计数，避免重复展开，计数精度溢出明确报错。

## 重复路线与食物进展

新 runner 会把服务端提供的 `state.progress`（`historyVersion: progress-v1`）送给 JEV。服务端按当前观察 seq 增量读取已提交事件，记录距上次吃苹果的步数、当前完整局面出现次数、重复间隔，以及各方向实际执行后又回到该局面且没吃苹果的次数。完整局面包括有序蛇身、朝向、棋盘/障碍和可见食物；tick、时钟、分数和请求 ID 不会让同一局面变成新局面。

只有实际移动才记录执行方向，包含旧 fixed 历史中实际执行的备用和直行。同 tick 的等待、请求接纳/拒绝或重新询问不增加移动和重复计数；吃苹果后清空该次无苹果周期的局面统计，旧选择不会污染新食物阶段。缓存从保存的事件构建，终局释放；丢失或不一致历史明确报错。

进展信息只陈述真实历史，不要求“未尝试方向优先”、不按执行次数排序，也不硬性安排危险、空间、食物的评分顺序。`no_static_path` 只表示冻结身体下未找到路径，不证明动态路线不存在。JEV 根据目标和这些证据自主选择，四个方向均保持完整，返回选择原样提交。

当前单步使用已提交历史；旧两步历史仍只代表实际执行事实。历史旧 v3 正文没有 progress 时仍可读取，不补写零值；新生产 runner 遇到旧服务没有历史字段会在模型调用前明确拒绝。回放显示当时保存的无进展与重复信息。此前带策略偏好的版本的真实局面和同图验证见 [循环修复验收](openspec/changes/improve-jev-decision-context/loop-fix-validation.md)。

当前自主决策版本的事实回归与真实模型选择见 [分叉证据与自主决策验收](openspec/changes/improve-jev-decision-context/branch-autonomy-validation.md)。此前的通关记录保留当时原始提示词，不作为当前版本必胜的证明。

多层分叉优化的真实回归与性能记录见 [证据链优化验收](openspec/changes/improve-jev-decision-context/proof-chain-validation.md)；多出口与增长后漏判修复见 [全分支证明验收](openspec/changes/improve-jev-decision-context/multi-exit-validation.md)。

## Context 评估

```sh
# 默认离线：无需密钥，不发外部请求；--out 是 JSON 文件路径
npx tsx scripts/evaluate-context.ts --out .data/qa/context-v3/offline.json
# 显式启用真实请求；读取 .env 中的 provider/model/对应密钥
npx tsx scripts/evaluate-context.ts --live --out .data/qa/context-v3/live.json
```

离线使用开局、历史 tick 364 死胡同和近满盘的共享 fixture，比较固定保存的 v2 正文与 v3 正文大小，测量历史 fixed 单步/两步与 response 单步构建耗时 p50/p95；fixed/两步数据仅为离线对照。`--samples` 可指定每项采样次数，默认 30。旧 v2 fixture 未采集构建耗时，报告保留未记录，不填零；v3 不保证在每个短蛇局面都比 v2 更小。报告的 500ms 截止仅用于旧实验对照，当前响应模式没有移动截止。

`--live` 仅对三个 fixture 的 response 单步 v3 正文串行请求，共 3 次，不再调用 fixed/两步。保存 provider/model、原文、选择、耗时、真实 usage 与错误，不提交到游戏。当前 v4 与 v3 的 response 单步对照使用 `scripts/evaluate-positive-context.ts`，每个 fixture 两次串行请求；输出明确标注 fixture 和测量版本。离线输入不代表整局成绩，有限模型样本不证明随机地图必胜。

## 游客界面

- 观战：真实棋盘、分数、步数、当前移动来源、模型原始概率与连接状态；最近收到的模型响应与当前实际执行动作分开展示。
- 指定对局观战地址为 /watch/:matchId，进入即读取最新状态并通过 WebSocket 跟随更新；刷新与切换对局保持 URL 和选中局一致。历史中等待开始/进行中的对局显示“观战”，终局显示“回放”。
- 历史：参与者和结果筛选，区分固定步频与随模型响应；显示配置速度或已记录平均速度、结束原因，支持游标分页。
- 回放：播放/暂停、时间轴、前后步进、关键事件跳转、0.5×/1×/2×/4×。
- 决策输入：在回放下方选择一次决策，查看并复制实际发送的 JSON、context 版本与已记录输入成本；区分旧坐标 context、v3 动作摘要与 v4 机会证据。旧记录未保存正文时明确提示，未知版本保留原始 JSON。
- 回放读取保存的真实状态，不重新运行模型或随机数。
- 进行中对局的回放会明确提示不会自动追随进度，并提供“进入实时观战”链接。
- 断线时保留最后确认局面并明确提示；重连按事件序列续读。
- 服务重启会将原运行中对局标记为 server_restart 中断，不补跑停机时间。
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
| SQLITE_PATH | 必填，数据库路径；npm 脚本从项目目录运行，生产建议用绝对路径 |
| GAME_PORT / GAME_HOST | 默认 3001 / 127.0.0.1 |
| GAME_SERVER_URL | runner 与开发代理的后端地址，可选 |
| JEV_PROVIDER | 默认 typesafe，可显式设置 openrouter |
| TYPESAFE_API_KEY | Typesafe 独立密钥，仅服务端使用，禁止 VITE_ 前缀 |
| OPENROUTER_API_KEY | 仅选择 OpenRouter 时使用的独立密钥 |
| JEV_MODEL | 可选；Typesafe 默认 jev-1.13.0，OpenRouter 默认 typesafe/jev-1.13 |
| SNAKE_STEP_MODE | 默认且仅支持 response；CLI --step-mode response 可显式声明 |
| SNAKE_TICK_MS | 已弃用；遗留值仅提示，不阻断运行，删除后停止提示；显式 --tick-ms 拒绝 |
| SNAKE_WIDTH / SNAKE_HEIGHT | 默认 24 / 18 |
| SNAKE_OBSTACLES | 默认 12 |
| SNAKE_SEED | 可选；留空由 runner 随机生成 |
| VITE_ROUTER_DEVTOOLS | 显式设为 true 才显示开发工具 |

## 检查与构建

```sh
npm run test:snake
npm run typecheck
npm run build
```

测试使用临时的真实 SQLite 文件和真实 WebSocket 连接，覆盖事务失败、去重、等待不移动、局面失效、服务重启、记录损坏与游客权限。JEV HTTP 契约的自动测试使用测试专用传输数据，不代表已经完成真实模型性能测试。

Oxfmt 负责源码、测试和项目配置的格式化与 import 排序，Oxlint 负责代码检查。生成的路由文件不参与检查；格式化也不处理依赖锁文件、技能目录与 OpenSpec 历史文档。

```sh
npm run format        # 格式化并写入文件
npm run format:check  # 只检查格式，不修改文件
npm run lint          # Oxlint 代码检查
npm run check         # 依次检查格式和 lint
```

格式规则位于 `.oxfmtrc.json`（Tab 缩进、2 列宽度、80 列换行、双引号），lint 规则位于 `.oxlintrc.json`。Oxlint 使用默认插件的 correctness 规则并按错误报告；TypeScript 类型检查仍由 `npm run typecheck` 执行。

VS Code 安装项目推荐的 [Oxc 扩展](https://marketplace.visualstudio.com/items?itemName=oxc.oxc-vscode) 后，保存 JS、TS、JSX、TSX、JSON、JSONC 和 CSS 文件时会使用项目内的 Oxfmt 格式化，并执行 Oxlint 的安全修复。编辑器配置与终端使用同一套本地工具，参见 [官方设置说明](https://oxc.rs/docs/guide/usage/formatter/editors.html)。

开发模式中，Nitro 的预处理先于 Vite 的普通 HTTP proxy，因此 /api/** 在 Nitro devProxy 配置；WebSocket 由 Vite 的 upgrade proxy 转发。

## 部署边界

构建同时生成 .server-build/ 后端和 .output/ 前端：

```sh
npm run start:server
# 另一个进程
npm start
```

需要常驻 Node 进程和持久磁盘。生产反向代理把 /api/ 和 /ws/ 交给 Hono（WebSocket 要支持 Upgrade），其余请求交给 Solid Start；开发代理不参与生产部署。现有 vercel.json 属于前端模板配置，不能把 SQLite 常驻服务当成已部署的 Vercel 功能。

SQLite 使用 WAL、外键和 FULL 同步。局面、事件和请求结果在同一事务内保存后才确认和推送。数据库写入失败会明确报错，不切换内存库；备份使用 SQLite 的一致性备份流程，不在写入期间只复制主文件。代码回滚不自动删除历史记录。

当前生产 context 为 v4，服务端和回放同时保留已有版本的读取。移除固定/两步运行不改变 SQLite 表或记录版本；回退时保留读取既有 v4 正文与响应 v3 对局的能力，不删除或重写历史。
