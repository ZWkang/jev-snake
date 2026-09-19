# SNAKE · JEV 实时贪吃蛇

一个用于观察快速决策模型的贪吃蛇实验。游戏由 Hono 服务端管理，支持固定步频与随模型响应逐步推进，JEV 通过 Typesafe 或 OpenRouter API 选择方向；游客无需登录，可以实时观战、查看历史和逐步回放。

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

频道使用与 CLI 相同的 `SNAKE_STEP_MODE`、`SNAKE_TICK_MS`、棋盘尺寸、障碍和种子配置，以及 `JEV_PROVIDER`/`JEV_MODEL`。默认仍为 fixed、300ms、两步备用；设 `SNAKE_STEP_MODE=response` 可改为随响应单步推进。没有固定 `SNAKE_SEED` 时每局生成新种子。频道不代替模型选择方向，也没有强制限步或限时终局。

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
# 固定步频，默认两步预测与备用策略
npm run jev -- --step-mode fixed --tick-ms 500
# 随模型响应：返回一次，立即走一步，再询问下一步
npm run jev -- --step-mode response
```

也可以明确地图参数：

```sh
npm run jev -- --tick-ms 300 --width 24 --height 18 --obstacles 12 --seed experiment-01
```

- 默认通过 Typesafe 直连，固定模型 jev-1.13.0；JEV_MODEL 可显式选择其他官方版本或别名。
- 如需对照 OpenRouter，显式设置 JEV_PROVIDER=openrouter，并使用独立的 OPENROUTER_API_KEY；不会在失败时自动切换服务商。
- Typesafe 接口为 https://api.typesafe.ai/v1/systemone，输入 state/questions，输出 choice、概率与置信度。
- 默认 fixed 模式每 300ms 走一格，约 3.33 格/秒；500ms 是 2 格/秒。固定速度在单局内不变，实际固定步频实验使用不小于 300ms 的间隔；response 模式没有固定间隔，也不人为限制快响应的步频。
- 默认地图 24×18、12 个障碍；尺寸和数量为开局参数，不随机改变尺寸。未指定 seed 时，每局随机生成并保存。
- 连续观战和 CLI 新局使用 `config.layoutVersion=2`：随机选择出生方向及位置，保留初始 4 格蛇身和正前方 3 格空间。可容纳开局的方向等概率抽取（默认棋盘四向各 25%；高度不足 7 格时仅左右），障碍仍避开开局区域并保证空地连通。配色从 24 组中按种子选取，包括 8 组整条统一的纯色、8 组同色系深浅变化、8 组不同颜色的组合，三类各占约三分之一，整局、刷新、回放和分支续局保持一致；固定种子可复现开局。缺少 `layoutVersion` 的旧记录及旧 API 配置继续使用原生成规则和配色，保证历史 RNG 可以精确恢复。
- 最小宽度 7 用于容纳初始蛇和前方三格安全区；高度为正整数。障碍配置必须满足出生安全区和空格连通性，否则明确报错。
- Ctrl+C 通过受保护通道结束当前对局，保留已提交记录。
- 没有密钥时 runner 明确拒绝启动。API 或格式错误会暴露错误并记录模型调用中断，不切换其他模型或自动寻路策略。
- runner 输出 model_request_started / model_request_cancelled / model_request_failed，记录观察步、目标步和取消或失败的等待时间；终局不会吞掉真实调用错误。只有返回并提交的结果才算模型决策。
- 概率合计不等于 1（例如 0.99）只输出 model_response_warning，并在决策面板提示；方向照常提交，原始概率保留，不自动归一化或停止对局。

运行器还支持 --name、--url、--step-mode 和 --decision-mode 参数。两步兜底联调结果见 [validation.md](openspec/changes/add-two-step-decision-fallback/validation.md)，初版记录见 [原验收记录](openspec/changes/add-neobrutalist-snake/validation.md)。官方接口及模型约定见 [API 文档](https://docs.typesafe.ai/api) 和 [模型列表](https://docs.typesafe.ai/models)。

## 从历史卡点续跑

使用原局 ID 和目标事件序号创建分支，当前配置的真实模型从该局面继续决策：

```sh
npm run jev -- --fork-match 334e1e69-17b0-4875-8f48-916a8d4b1db8 --fork-seq 3273 --name 'JEV · 从第1628步续跑'
```

`--fork-seq` 是事件序号，不是步数；应选择错误决策之前的事件。只能从 ready/running 局面继续，终局事件会明确拒绝。两项参数必须一起提供，且不能同时传地图、seed、步频或决策模式参数；这些配置完整继承自原局，创建配置的环境默认值不覆盖原局。

服务端从种子逐事件重放真实引擎并校验棋盘，恢复随机数进度、得分、蛇身和累计游戏时间；任何历史缺失或重放不一致都会报错。分支复制截至目标的历史，让模型保留已执行的决策和进度证据，随后使用最新上下文与提示词继续调用模型。旧排队动作与控制凭证不继承，停机时间不计入游戏。原局和未来事件保持不变。

观战与回放标注来源；分支回放默认打开续跑起点，也能从头查看继承的历史。底层接口为管理员认证的 `POST /api/matches/:id/fork`，请求包含 `requestId`、`controlToken`、`agentName`、`model` 和 `sourceSeq`，返回新局面及 `forkedFrom` 来源。

## 随模型响应推进

`--step-mode response` 或 `SNAKE_STEP_MODE=response` 选择该模式：蛇等待模型回答，服务端校验有效后在同一事务中保存动作与一次移动，runner 收到 applied 确认后立即读取新局面并再次询问。每次最多一个模型请求在途，没有移动定时器、额外 sleep 或动画等待。

- response 自动选用 single_step；显式组合 `--decision-mode two_step_fallback` 会在创建前报错。显式组合 `--tick-ms` 同样报错，fixed 专用环境默认值 `SNAKE_TICK_MS` 在 response 中不会生效。
- 模型输入明确标注 response、当前观察 tick 与唯一的下一 tick，固定间隔与截止为 null。gameTimeMs 使用服务端取得上下文时的真实已运行时间；保存的原始正文不包含凭证。
- 等待期间蛇不移动；星星仍按真实时间 8 秒到期。到期导致局面摘要过时，或模型选择了直接反向时，拒绝事实会保存，runner 重新读取当前局面再询问，不死等 tick 变化。
- 只有有效响应会走一步，碰撞也属于一次移动尝试。重复请求不会多走；错误目标、协议错误或 API 失败会明确暴露并中断，不自动补方向、换模型或重试隐藏失败。
- 观战展示“随模型响应”、真实最近一步间隔与已记录平均步频；等待和观战断线分别提示。平均步频是已记录移动次数除以记录时长，零步或时长为零时不生成虚构速度。
- `lastStepDurationMs` 是距上一次移动的真实间隔，第一步从 start 计算；它包含模型请求与 HTTP/WS、持久化等实际开销。`requestMs` 仅是模型调用往返耗时。回放按原始事件 gameTimeMs 保留快慢间隔，同时间戳按 seq 排序，倍速只缩放时间差。
- 主动停止保存包括等待在内的真实时长。进程异常退出后只保留最后已提交位置和时间，重启不补步、不把停机时间算入原对局。

模式在创建时固定，不能局内切换。固定模式继续默认 two_step_fallback；response 不消费备用计划。

## 两步预测与延迟兜底

fixed 模式的 runner 默认使用 `two_step_fallback`：一次模型请求选择一个有先后顺序的方向对，例如“右 → 下”。第一步是下一 tick 的主动作，第二步是再下一 tick 的备用。游戏时钟仍独立推进，默认步长仍是 300ms。

```sh
# 显式通过 OpenRouter 跑 500ms 两步对局，使用 OPENROUTER_API_KEY
JEV_PROVIDER=openrouter JEV_MODEL=typesafe/jev-1.13 npm run jev -- --tick-ms 500 --decision-mode two_step_fallback
# 关闭两步兜底；每次只询问下一步
npm run jev -- --tick-ms 500 --decision-mode single_step
```

1. 观察实际第 N 步，模型一次选择 N+1 主动作和 N+2 备用；服务端必须在 N+1 截止前接纳整份计划。
2. N+1 执行第一步后，第二步才具备资格；runner 立即基于 N+1 的真实位置询问新计划，每次最多一个在途请求。
3. N+2 到点时按“有效的新主动作 → 上轮备用 → 沿原方向”结算。备用提前保存在服务端，不需要等待迟到请求回来再发送。
4. 新主动作只在实际执行时覆盖旧备用；如果它因局面摘要变化而取消，旧备用仍可参与本步裁决。
5. 备用绑定原目标、只消费一次。所属第一步没执行就取消备用；首次请求迟到或连续迟到耗尽备用时，继续沿原方向并明确记录原因。
6. 迟到的新计划整体拒绝为 late_action，不截取第二步、不顺延目标。HTTP/格式错误仍明确中断，不以备用掩盖真实失败。

第二步允许预测不准确：吃苹果后的随机新奖励、奖励过期不会单独使已有备用失效。备用仍禁止直接反向，会按真实规则撞墙、撞障碍或撞身；没有隐藏寻路或避碰代打。原始联合概率与置信度属于完整方向对，两步共用一次模型请求耗时。

`single_step` 保留原来只控制实际局面紧接着一步的规则。模式随新局配置保存，不能局内切换；旧客户端未传 decisionMode 时仍为单步。旧 /projection 接口和 --lookahead-ms 参数仍不可用，旧预判回放保留当时原文与标注。新请求的实际观察始终 `stateIsProjected: false`，未来第二步只表示条件预测。

`requestMs` 是客户端模型请求往返耗时；`reactionMs` 是观察事件到收件时间的服务端游戏时间差；`schedulerLagMs` 是服务端调度落后。`receivedAt` 与有本进程时钟锚点时的 `receivedGameTimeMs` 独立记录收件时间，不能用冻结的终局 gameTimeMs 冒充到达时间；服务重启后缺少原单调时钟锚点时后者为 null，实际收件时间仍保留。可选 inferenceMs 只表示客户端额外报告的推理耗时。

回放分别统计真实返回并提交的请求数、新主动作使用步数、备用使用步数、沿原方向步数；碰撞尝试也计入动作来源，备用不算一次新请求。真实网络延迟与得分需实测，不能从单步历史数据推断两步模式必然更快或更安全。

## 模型的动作后果 context

新单步请求使用 `action-facts-v3`，两步请求使用 `two-step-plan-v3`。程序计算动作后果，JEV 在完整的四方向或十六方向对中选择；不会按分数、概率或启发式偷偷改选。单步摘要只在 `questions.direction.criteria` 保存一份；两步第一步摘要在 `state.firstActions` 共享，各方向对携带条件第二步事实。请求保留蛇头、长度、障碍数量、奖励和真实计时，不再发送完整蛇身和障碍坐标。完整棋盘仍在 `observedSeq` 对应事件中。

身体与固定障碍共同参与碰撞分析，非增长时尾巴离开原格，吃苹果时尾巴保留；分析与真实移动共用 `inspectMove` 规则，不改变原状态或 RNG。

| 摘要 | 含义与边界 |
| --- | --- |
| `danger` | 每个选项的直接危险结论：`immediate_collision` 为即时碰撞/非法反向，`proven_fatal` 为强制撞死、已证实陷阱、所有出口都有死亡证书的分叉，或吃苹果后即使不再增长仍必撞的局面，`null` 仅表示尚无死亡证明。标签描述证据，不用于过滤选项或替模型改选。旧 v3 没有该字段时不补算。 |
| `immediateCollision` / `forcedPath` | 即时碰撞与动态强制通道。后续仅有一个合法方向时推进副本，直到碰撞、分叉、完整身体与朝向重复、吃苹果或完成棋盘。`steps` 包含候选动作和最后的碰撞尝试；`branch` 不保证后续安全，`unknown_after_apple` 不推测新苹果。 |
| `space` | 执行动作后冻结身体的可达格数、身体长度比较、立即合法出口和静态头尾连通性。可达格数包含头、阻塞其余身体含尾巴；头尾连接只把尾格作为终点打开。静态小区域或不连通不证明动态必死。 |
| `appleRoute` / `postEat` | 冻结身体下的一条最短候选路线，再逐步移动身体验证，报告吃后出口、空间与头尾连接。等长路线按固定顺序取一条，`no_static_path` 不表示所有动态路线不存在；该路线吃后无出口也不否定该第一方向的其他路线。填满棋盘标为胜利，不以无出口当失败。 |
| `starRoute` | 不经过当前苹果的星星候选路线、观察时剩余时间及名义到达条件。fixed 根据距下一截止的实际剩余时间计算，到达等于到期算赶不上；response 的未来到达时间未知。几何接触不承诺实际得到星星分数。 |

路线距离包含当前候选动作；两步的第二步距离和通道步数从第一步执行后起算。第一步碰撞或胜利不执行第二步；第一步吃苹果后只保留第二步可确定的碰撞，增长与后续事实明确未知，不生成未来随机奖励。第一步触及星星后，第二步不会重复计入同一星星。

提示词给出完成棋盘、收集奖励的游戏目标，并解释事实与未知的边界；方向取舍、吃食物时机与探索策略由 JEV 自主决定。静态连通性、一条已验证路线及模型概率均不是存活保证，方向对的概率属于整个方向对。v3 以明确的候选路线代替旧 `appleDistance` 曼哈顿距离；旧正文、无版本/v1/v2 context 均保持原文可读。

`contextBuildMs` 记录本地分析与请求对象构建耗时，`requestBytes` 记录实际发送正文的 UTF-8 字节数；`requestMs` 单独记录模型调用往返，`inputTokens` 仅使用服务商真实返回值。回放展示保存的版本与成本，旧记录缺少数据显示“未记录”，不重算；未知 context 版本明确提示语义不支持，仍可查看和复制原始 JSON。

吃苹果后先在“未来不再增长”的乐观几何中检查全部合法分支：如果仍有有限死亡证明，额外增长只会占据更多格子。仅当剩余空格数不少于碰撞上界时采用该证明，排除连续增长先填满棋盘获胜的可能。这个证明不读取未来 RNG，不把上界写成精确未来步数；存在可循环路线或尚无完整证明时保持未知。

分叉死亡证据组合强制碰撞、封闭区域、吃后必死和已有单分叉证书。显式栈逐支检查所有待证出口，只有所有合法出口都能证明死亡，才把结论传回入口，给出最迟碰撞步数。当前路径重复、存在真实可循环路线、获胜或未证明的苹果后续时保持未知。已完成的子证明按局面复用，分支汇合不当成循环；没有搜索深度、时间或节点数上限。分析器还动态验证“蛇头到尾部再沿原身体返回”的完整闭环，作为无法判定必死的真实见证，不把路线交给控制器。模型收到入口与首分叉的上界、证书种类和结构计数；摘要同样复用共享子证明的计数，避免重复展开，计数精度溢出明确报错。

## 重复路线与食物进展

新 runner 会把服务端提供的 `state.progress`（`historyVersion: progress-v1`）送给 JEV。服务端按当前观察 seq 增量读取已提交事件，记录距上次吃苹果的步数、当前完整局面出现次数、重复间隔，以及各方向实际执行后又回到该局面且没吃苹果的次数。完整局面包括有序蛇身、朝向、棋盘/障碍和可见食物；tick、时钟、分数和请求 ID 不会让同一局面变成新局面。

只有实际移动才记录执行方向，包含 fixed 模式的备用和直行。同 tick 的等待、请求接纳/拒绝或重新询问不增加移动和重复计数；吃苹果后清空该次无苹果周期的局面统计，旧选择不会污染新食物阶段。缓存从保存的事件构建，终局释放；丢失或不一致历史明确报错。

进展信息只陈述真实历史，不要求“未尝试方向优先”、不按执行次数排序，也不硬性安排危险、空间、食物的评分顺序。`no_static_path` 只表示冻结身体下未找到路径，不证明动态路线不存在。JEV 根据目标和这些证据自主选择，四个方向和十六个方向对均保持完整，返回选择原样提交。

单步和两步共用真实历史，两步历史仅描述第一方向的已执行事实，不把尚未执行的备用算进去。历史旧 v3 正文没有 progress 时仍可读取，不补写零值；新生产 runner 遇到旧服务没有历史字段会在模型调用前明确拒绝。回放显示当时保存的无进展与重复信息。此前带策略偏好的版本的真实局面和同图验证见 [循环修复验收](openspec/changes/improve-jev-decision-context/loop-fix-validation.md)。

当前自主决策版本的事实回归与真实模型选择见 [分叉证据与自主决策验收](openspec/changes/improve-jev-decision-context/branch-autonomy-validation.md)。此前的通关记录保留当时原始提示词，不作为当前版本必胜的证明。

多层分叉优化的真实回归与性能记录见 [证据链优化验收](openspec/changes/improve-jev-decision-context/proof-chain-validation.md)；多出口与增长后漏判修复见 [全分支证明验收](openspec/changes/improve-jev-decision-context/multi-exit-validation.md)。

## Context 评估

```sh
# 默认离线：无需密钥，不发外部请求；--out 是 JSON 文件路径
npx tsx scripts/evaluate-context.ts --out .data/qa/context-v3/offline.json
# 显式启用真实请求；读取 .env 中的 provider/model/对应密钥
npx tsx scripts/evaluate-context.ts --live --out .data/qa/context-v3/live.json
```

离线使用开局、历史 tick 364 死胡同和近满盘的共享 fixture，比较固定保存的 v2 正文与 v3 正文大小，测量 fixed 单步/两步及 response 单步构建耗时 p50/p95。`--samples` 可指定每项采样次数，默认 30。旧 v2 fixture 未采集构建耗时，报告保留未记录，不填零；v3 不保证在每个短蛇局面都比 v2 更小。报告将本地成本与 500ms 截止对照，不通过截断搜索或改慢步频掩盖开销。

`--live` 对同三个 fixture 的 v2/v3 单步和两步各请求一次，共 12 次串行调用，保存 provider/model、原始输入输出、选择、概率、耗时、真实 usage 与错误。这些调用只评估同一观察局面的选择，不提交到任何游戏，也不是整局游玩。密钥不会写入报告。确定性几何正确性、输入成本、真实模型选择及整局表现分别报告；有限样本不证明随机地图必胜。真实整局的 seed、模式与结果见本次 [验收记录](openspec/changes/improve-jev-decision-context/validation.md)。

## 游客界面

- 观战：真实棋盘、分数、步数、当前移动来源、待执行计划、模型原始概率与连接状态；最近收到的模型响应与当前实际执行动作分开展示。
- 指定对局观战地址为 /watch/:matchId，进入即读取最新状态并通过 WebSocket 跟随更新；刷新与切换对局保持 URL 和选中局一致。历史中等待开始/进行中的对局显示“观战”，终局显示“回放”。
- 历史：参与者和结果筛选，区分固定步频与随模型响应；显示配置速度或已记录平均速度、结束原因，支持游标分页。
- 回放：播放/暂停、时间轴、前后步进、关键事件跳转、0.5×/1×/2×/4×。
- 决策输入：在回放下方选择一次决策，查看并复制实际发送的 JSON、context 版本与已记录输入成本；区分旧坐标 context 与 v3 动作摘要。旧记录未保存正文时明确提示，未知版本保留原始 JSON。
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

单步控制使用 `protocolVersion: 1` 的 start/action/stop；两步使用 `protocolVersion: 2` 的 start/plan/stop。plan 携带 observedSeq、第一步 targetTick、expectedStateHash、恰好两个 directions 和完整模型 decision。回执将整份计划的接纳与两步各自 queued/standby/applied/superseded/cancelled/expired/rejected 分开记录。health 公布 supportedProtocolVersions，旧服务不支持 v2 时两步 runner 明确拒绝开局，不静默降级。

固定两步记录使用 recordVersion/rulesVersion 2/2，固定单步与旧记录保持 1/1，response 使用 3/3。新读取端支持这三种组合，未知版本明确报错；数据库表不变，旧历史和摘要输入无需重写。旧记录缺少 stepMode 时仍按原有 fixed 语义读取。response 控制信封继续使用 protocolVersion 1，记录版本与控制协议版本不同。关闭响应模式可用 fixed 创建后续局，但应保留能读取 v3 的程序，不通过删库或改写历史回滚。实际请求形状见 scripts/run-jev.ts 和 shared/snake/schema.ts。

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
| SNAKE_STEP_MODE | 默认 fixed，可选 response；CLI --step-mode 优先 |
| SNAKE_TICK_MS | fixed 专用，默认 300；response 忽略该环境值，显式 --tick-ms 冲突则拒绝创建 |
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

测试使用临时的真实 SQLite 文件和真实 WebSocket 连接，覆盖事务失败、去重、截止时间、局面失效、服务重启、记录损坏与游客权限。JEV HTTP 契约的自动测试使用测试专用传输数据，不代表已经完成真实模型性能测试。

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

Context v3 不改变控制协议或游戏记录版本，也没有数据库 DDL 迁移。部署时先更新支持无版本/v1/v2/v3 context 的服务端解析与回放，再更新生成 v3 的 runner；新 runner 向旧严格解析服务端发请求会明确失败，不自动降级。回滚生成端时继续保留 v3 读取能力与历史正文，不改写 contextVersion、recordVersion，也不删除旧局。
