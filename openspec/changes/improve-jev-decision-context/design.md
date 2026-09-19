## Context

动机见 [proposal.md](proposal.md)。本设计以 2026-09-19 当前工作区为准，工作区已有大量未提交实现，不能以 Git HEAD 的模板代码代替当前基线。

已核对的现状：

| 位置 | 当前能力与约束 |
| --- | --- |
| `server/game/engine.ts:inspectMove` | 实际移动与 context 共用反向、碰撞、增长/尾巴规则；`move` 会改变 tick、奖励和 RNG，分析不能直接用它生成未来奖励 |
| `server/jev/context.ts` | 四方向即时事实、唯一出口动态通道、第二步条件事实；通道在分叉、循环、苹果或终局停止 |
| `server/jev/client.ts` | 单步 v2 将 actionFacts 在 state 和 criteria 重复；仍传完整身体/障碍，并要求模型继续用坐标推理；两步有 16 个字符串 criteria |
| `shared/snake/{types,schema}.ts` | 严格请求 schema；旧 context 可以无版本，v1/v2 共存；新字段须贯通控制信封 |
| `scripts/run-jev.ts` | 当前观察→构建请求→JEV→按原目标提交；单在途；fixed 与 response 已分别实现 |
| `src/features/snake/DecisionInput.tsx` | 从保存的 decision.request 显示 JSON；除 JSON 外依赖 head、direction、timing，未依赖全量身体坐标 |
| `server/db/store.ts` | 在 JSON 中保存决策/事件；已有 observedSeq 和真实局面，无需为精简模型输入新增一份完整棋盘 |
| `tests/context.test.ts` | 已有真实 tick 364 死胡同、尾巴让路、循环、增长、填满、两步回归；本轮与 `tests/jev.test.ts` 合计 16 项通过 |

需求来源：

- [参考策略会话](codex://threads/01a0b8f9-86b4-7ec3-bb55-9aec83c5bf48)：程序计算动作后果，JEV 权衡生存与奖励。
- [死胡同分析和修补](codex://threads/01a0b8f3-c820-71b0-a043-3dd1b11184e8)：身体也是障碍，下一格空不能代表后续可活。历史错误局面现在已有自动测试，不将旧缺陷误报为尚未修复。
- [项目主会话](codex://threads/01a0b77e-e320-7a72-ba08-119759249418)：真实 JEV、请求延迟、当前观察与原目标绑定、回放原始输入、0.99 概率不得阻断、response 模式。
- [两步会话](codex://threads/01a0b8c6-9802-7721-bb46-1b9959c4baa7)：第二步用于延迟时备用，允许预测不准，不代表延迟结果可顺延。

2026-09-19 实时核对的外部依据：JEV 官方建议把精确计算留在代码中、减少间接推理与无关状态；Choice 支持结构化 criteria。它们支持本设计的分工，并不证明新 prompt 的实测效果。[JEV 能力边界](https://docs.typesafe.ai/model-jaggedness/jev-1.13) · [Choice](https://docs.typesafe.ai/primitives/choice)。Flood fill 作为静态空间指标的用途见 [Battlesnake 算法说明](https://docs.battlesnake.com/guides/useful-algorithms)。以下具体字段与算法边界是本项目的设计选择。

## Goals / Non-Goals

**Goals:**

- 让后续实施无需再次决定路径起点、尾巴语义、未知值、版本形状、两步关系和验收口径。
- 由确定性代码生成证据，由 JEV 选择；同时测量几何正确性、输入成本和模型行为。
- 保持游戏协议、计时与历史真实可读，缩减随身体增长而膨胀的模型输入。

**Non-Goals:**

- 不加入自动驾驶策略、方向过滤、推荐动作分数、哈密顿回路、强化学习、全状态空间搜索或新服务商。
- 不保证任意随机障碍地图能吃满；不改地图生成来迎合评估，不新增限步、运行超时或截断搜索后的伪安全值。
- 不重做观战 UI，不重写旧局，不自动归档其他 OpenSpec 变更；本次仅创建规划文档。

## Decisions

### 1. 纯几何分析与真实执行分开，碰撞规则共用

在 `context.ts` 中组织 `analyzePosition`、候选移动、静态图、路线验证和结果摘要；允许按职责拆成同目录的小模块。输入只读 `PublicState`，每条模拟路线维护自己的身体和方向副本。调用 `inspectMove` 判定，随后手动执行同一几何更新：插入新头，非苹果移动移走尾巴，苹果移动保留尾巴。不得调用会抽奖的 `move`、`placeApple` 或改变真实 gameTime。

现有 `forcedPath` 的证明范围保持不变。`branch` 是未继续枚举，`cycle` 是完整身体与方向重复，均不改成 `safe`。在某个动作即时被挡时，其后续指标统一为“不适用”，不以 0 冒充算过的结果。

替代方案：只改提示词仍让 JEV 做坐标推理，无法提供可回归的几何证据；穷举动态 BFS 的状态包含整条身体，成本随状态空间增长。本版选择有限棋盘 BFS 加一条候选路线的动态验证，不设置人为深度上限，也不声称动态完备。

### 2. 精确事实与静态启发式使用不同字段

以下名称作为实施契约；枚举不是安全评分。`space` 一律是“执行被分析动作之后”的冻结快照。

| 字段 | 语义 |
| --- | --- |
| `immediateCollision` | 沿用 null/reverse/wall/obstacle/body |
| `eatsApple` | 完整动作摘要中为 boolean；两步遇未知新苹果时使用单独的 unknown 分支，不携带此字段 |
| `forcedPath` | 沿用结果及 steps；steps 包括最初候选动作和最后碰撞尝试 |
| `space.staticReachableCells` | 4 邻接 flood fill；允许头格作为起点，其他蛇身含尾格及障碍均阻塞；包含头格 |
| `space.bodyLength` / `relativeToBody` | 移动后长度；`less/equal/greater` 由代码精确比较，避免让模型算差值；less 只是静态狭小提示 |
| `space.legalNextMoves` | 当前已知奖励下，移动后四方向 `inspectMove` 无碰撞的数量 |
| `space.tailConnection` | `connected/disconnected`，静态 BFS 只对当前尾格打开终点，不允许把尾格作为通道继续遍历 |
| `terminal` | `none/board_complete`；即时碰撞由 immediateCollision 表达 |

头尾为同格时 tailConnection 为 connected；虽然当前初始身体长度更大，函数契约仍按图语义定义。空间图可达不计未来增长或腾出的格子；方向约束只计入 legalNextMoves，静态连通性本身不是动态合法路径。坐标键统一为 `y * width + x`，避免重复扫描；邻居次序固定 `up,right,down,left`。缓存只在同一次构建内部复用相同快照，不建立跨 tick 缓存。

即时碰撞时 space=null、forcedPath=null、两种 route.status=not_applicable；完成棋盘时 space=null、terminal=board_complete，苹果保留 eaten_now/distance=1/verified=true 及 postEat 的胜利标记，胜利后的出口与连通指标为 null。字段缺失只用于有 discriminator 的未知第二步分支，不混同 null、0 和 false。

### 3. 苹果：冻结最短候选路线→逐步验证→吃后出口

对即时可走的方向先得到位置 P，再从 P 的头到已知苹果做 BFS。固定障碍和 P 中除头外的全部身体（包括尾巴）阻塞；初始出边排除反向。BFS 只访问每格一次，固定邻居顺序，选第一条静态最短路线。路线无重复格，不穷举等长路线，也不等待未来尾巴打开本来不可达的路径。

在副本上以 `inspectMove` 逐步验证这条路线，按真实身体更新。这样“路径找到”和“路径按真实身体可执行”是两个字段，不因静态图存在就跳过动态验证。若路线验证失败，保留失败位置与原因供评估，模型摘要标为 `candidate_invalid`，不偷偷换一条路线。

`appleRoute` 字段：

- `status: absent | eaten_now | path_found | no_static_path | candidate_invalid | not_applicable | unknown_after_growth`。
- `distance: number | null`：从本次分析输入位置出发，包含候选第一步；直接吃为 1；BFS 从 P 起算的长度再加 1。
- `verified: boolean | null`：只说明该候选路线；无候选/未知/不适用为 null。
- `postEat`：`terminal`、`legalNextMoves`、`staticReachableCells`、`bodyLength`、`relativeToBody`、`tailConnection`。未到苹果或候选失败为 null；board_complete 不再要求出口。

已吃苹果后的身体是确定的，但新苹果位置未知。postEat 的冻结空间和头尾连通性与新苹果位置无关；下一次碰撞也仍可确定，因为新苹果不能生成在任何身体格，包括尾格。除此以外不继续模拟增长，也不生成“吃后永久安全”。吃后无出口仅否定这条候选路线，不否定该第一方向经过其他路线的可能性。

v3 删除 `appleDistance`，以明确的路线状态和距离替代；曼哈顿距离仅保留在旧记录和离线对照中。避免同时给模型两种容易混淆的“距离”。

### 4. 星星：路线与时间条件单独表达

`starRoute` 使用同样的冻结 BFS/验证，但把当前苹果格排除在中途路线外；若必须先经过苹果则本类路径记为 `no_static_path`，说明只搜索不经过苹果的路线。星星不增长。当前候选第一步已吃苹果时，后续星星路线标 `unknown_after_growth`；不推测可能生成的新星星。

`starRoute` 包含与苹果一致的候选状态、总 distance、verified，以及 `remainingMs`、`nominalArrivalMs`、`timingStatus`，不附带 postEat。候选直接触及星星用 `reached_now`；这表示几何接触，是否得分仍受实际时刻约束。

- `remainingMs = max(0, expiresAt - elapsedGameTimeMs)`。这只是观察瞬间剩余时间。
- fixed 且有已知 deadline：`nominalArrivalMs = deadlineInMs + (analysisOffset + distance - 1) * tickIntervalMs`。第一步摘要的 analysisOffset=0，第二步摘要为 1；两者都从原实际观察时刻比较 remainingMs。第一步距下一截止的剩余时间不是完整 tick；不人为推进观察时间后再次扣除同一偏移。
- 已过截止时标 `deadline_passed`；deadline 未提供则为 `unknown`，不得自造一个完整周期。
- 到达时间严格小于 remainingMs 为 `before_expiry_if_on_schedule`，大于等于为 `not_before_expiry`，因为服务端先处理到期。名义可赶上不是实际会赶上的承诺。
- response 为 `unknown`，nominalArrivalMs 为 null。不使用历史均值冒充下一次请求时长；不为赶星星引入重试或并发请求。

### 5. v3 请求：候选后果只放在一个权威位置

单步顶层保持 `{model,state,questions}`。`state` 保存：

```text
contextVersion: action-facts-v3
rules: objective / applePoints / starPoints / factsSemantics
board: width / height / obstacleCount
player: head / direction / length / score
food: apple / star
timing: 沿用实际观察、目标 tick、stepMode、gameTime 和截止语义
questions.direction: type=choice / instructions / criteria[up,right,down,left]
criteria[direction]: meaning / immediateCollision / eatsApple /
                     forcedPath / terminal / space / appleRoute / starRoute
```

这是字段结构说明，`questions` 仍处于顶层，不嵌入 state。单步不再传 `state.actionFacts`，也不传 `bodyHeadToTail` 与障碍坐标。几何计算在服务端/runner 的已知状态上完成；原始棋盘可由 observedSeq 对应事件核对。head 保留以兼容现有输入面板定位，food 保留以便核对当时奖励与到期。

`factsSemantics` 只放一份简短说明：碰撞和强制死路为明确证据，静态连通性与单条路线是有限证据，未知不是安全，距离起点明确。不要把本 design 或完整算法说明放进每次请求。

单步指令固定为一个问题，大意为：

> Choose one absolute direction for the immediately upcoming move. First avoid immediate collisions when an alternative exists, then avoid proven forced collisions. Compare escape evidence and room to move before food rewards. A static path or a branch does not guarantee survival. An unsearched or unknown continuation is not safe by default. Consider apple growth and star timing. Return your own choice from the four options.

具体英文措辞可为清晰度调整，但不得加入隐藏权重、方向排序或“永远选择面积最大”的决策算法。四个选项全部保留，概率校验不变。

### 6. 两步以第一步结果为条件，原有十六选项不变

`two-step-plan-v3` 保留 planningHorizon=2、targetTicks 和 fixed timing。第一步完整摘要仅存在于 `state.firstActions[direction]`；`questions.plan.criteria[pair]` 改为结构化对象 `{first, second, secondStatus, secondFacts}`。first/second 是明确方向，不是索引或压缩编码。指令直接说明 firstActions 的关联，最多一次字段定位。

- 普通第一步：`secondStatus=known`，为其移动后的身体生成第二步完整摘要。每个方向对共享同一 firstActions 项，第二步 steps、distance 从第一步后的位置起算。若第一步触及当前星星，条件位置中去掉该星星（收集或到期都不会留在原格），不能让第二步再次获得它；不生成新星星。
- 第一碰撞：`secondStatus=not_executed_first_blocked`，secondFacts=null。
- 第一完成棋盘：`secondStatus=not_executed_board_complete`，secondFacts=null。
- 第一吃苹果：`secondStatus=unknown_after_growth`；secondFacts 只包含第二步 immediateCollision 与明确未知原因，eatsApple/forcedPath/space/appleRoute/starRoute 不造默认值。新苹果在第一步后身体外，故第二步碰撞可确定，但第二步后身体长度不可确定。
- 第一步未吃、第二步吃：第二步完整摘要可包含已知 postEat，但不能再推演未知第三步。

选择仍是一次 Choice 得到有序对；不改成两次独立方向调用。两步没有“保证安全”布尔值，也不将一对的概率解释成某个动作的概率。这比每个 pair 重复第一步完整事实更小，也避免模型自己模拟第二步身体。

### 7. 契约、保存与兼容采用显式版本分支

`types.ts` 分离历史请求类型与 v3 请求类型，导出 union；旧类型维持字段、可选版本、旧预判 timing。v3 单独严格定义，不通过把所有新字段设为 optional 来兼容。schema 先按缺失/已有 contextVersion 选择对应 shape，各 shape strict；v3 单步要求四项完整 criteria，两步要求四项 firstActions 及十六项结构化 criteria，非法版本、漏字段、错误 unknown 分支明确失败。

旧 planRequestSchema 不能继续只对一个通用对象 `.extend`；抽取共用 timing、rules、坐标小结构，再构成历史/v3 两步 union。更新所有 `allControlSchema`、`decisionSchema`、`planDecisionSchema` 引用，防止客户端能发但 WS 拒绝。

`Decision` / `PlanDecision` 新增可选诊断 `contextBuildMs`、`requestBytes`，供旧记录兼容；新调用必须填写。构建计时覆盖事实生成、两步组合和最终 request 对象构建；不把这段藏进模型 requestMs。UTF-8 字节数按最终发送 JSON 计算，传输层复用同一串行化结果。`inputTokens` 沿用真实 usage，不估算成实际值。错误继续抛出，不因分析失败退回 v2 请求。

保留 `decision.request` 的完整实际 HTTP body（不含认证头），不能在发送后为了回放把全量坐标补进去。service/store 已按对象保存，若无需修改就只做契约回归。记录版本 1/2/3、控制协议 1/2 均不变：它们描述游戏与控制，不描述 JEV context。

DecisionInput 增加版本、contextBuildMs、requestBytes 的简单说明；保留原 JSON 文本及复制逻辑。旧诊断未记录显示“未记录”，不显示 0；未知版本可以看原始 JSON，但不套用 v3 语义。版本相关说明通过显式 type guard 访问，不把缺少 bodyHeadToTail 当作数据损坏。

### 8. 验证分层，先验证事实，再验证真实模型

**确定性回归（完成实现的硬要求）**

在既有 context 测试上新增：分叉后小区域、静态路径绕障、静态不可达但移动尾巴可开放、两条等长路线、直接吃/绕路吃后零出口、最后一格胜利、星星路径不能穿苹果、TTL 相等边界、response 时间未知、第一步增长后的第二步未知。每例验证 state/RNG 不变；选中路线与真实引擎逐步结果交叉检查，而不是只重复算法输出快照。

契约测试覆盖无版本/v1/v2/v3、漏字段、未知版本、fixed 单步/两步/response、0.99 概率、真实 API 错误。runner 的 HTTP/WS/SQLite 测试核对原目标和观察一致、单在途、拒绝不改绑、保存 body 等于实际发出的 body。已有测试里的完整身体断言改为 v3 摘要与 observedSeq 局面核对，同时用固定旧 fixture 保留旧正文契约，不能删掉历史覆盖。

**本地成本（无外部调用）**

新增 `scripts/evaluate-context.ts`，默认离线；使用测试共享 fixtures，输出每个局面的 v2/v3 requestBytes、各模式 contextBuildMs、具体错误，不依赖私人数据库才能运行。v2 基线是在改造前保存的完整请求 fixture，不在生产增加 v2 自动回退。使用开局、tick 364、接近填满三类，采样次数由报告明确记录，统计 p50/p95；字节数是客观值，耗时不写脆弱 CI 绝对阈值。

成本验收：v3 移除按蛇长增长的坐标列表和单步重复事实；同类不同长度输入的字段结构相同。报告大小变化、每个模式的本地计算和 500ms 截止关系；若新开销明显侵蚀截止，先优化占据表和单次构建复用，不以静默裁剪或改为更慢 tick 掩盖。不得预先声称 v3 总字节数一定小于所有短蛇 v2 样本。

**真实请求与整局（实施阶段执行，规划未执行）**

评估脚本显式 `--live` 才调用配置 provider；同三个 fixture 对 v2/v3 的单步和两步各调用一次，共 12 次串行真实请求，保存 manifest 与原始输入输出、模型/provider、时间、probability、requestMs、inputTokens。这测相同观察状态上的模型选择，不向线上历史局提交，不把该结果标为真实游玩。优先关注 tick 364 是否仍选已证明的死路；若还选错如实记录为模型效果未通过，不用代码代选“修好”。

随后通过已有 runner 顺序跑三场：response 单步、fixed 500ms 单步、fixed 500ms 两步，24×18/12 障碍，同一固定评估 seed `context-v3-eval-01`；记录 matchId、苹果数、得分、存活步数、结果、最新主动作/备用/直行占比、迟到/失效原因、请求耗时。相同 seed 在不同轨迹下不保证相同随机奖励时序，不能宣称严格 A/B 因果提升。结束以真实终局或用户停止为准，不加游戏限步。若服务、密钥、费用条件不满足或游戏仍运行，明确保留未完成项，不把离线通过写成真实评估完成。

以上三局只是完整链路验收，吃满与平均提升属于观察指标，不设拍脑袋必胜率。扩大的统计实验不属于此次实施任务。

**浏览器与交付**

按 AGENTS.md 使用 `agent-browser --help` 后的实际命令，独立命名 session；snapshot→操作→snapshot，验证一条旧局和新局 JSON、版本和复制内容，保留用户现有页。记录截图/日志到 `.data/qa/context-v3/`，结论写本 change 的 `validation.md`。不让复制出来的内容与发送正文不一致。

## Risks / Trade-offs

- [冻结图会漏掉等待尾巴腾出的动态路线] → no_static_path 明确限定静态搜索；现有动态通道证据保留，不输出必死。
- [一条最短候选路线不是完整策略] → postEat 只评价该路线；不将某条路线失败升级为所有走法失败，不加入隐藏兜底。
- [摘要移除了模型自己的空间推理输入] → 本实验明确为“程序计算事实 + JEV 选择”；历史原文与 observedSeq 棋盘仍可核对。
- [更多特征可能增加短蛇输入或本地耗时] → 共享第一步摘要、移除重复坐标、实测字节与耗时；不把性能目标伪装成已取得结果。
- [随机奖励让第二步不完整] → 使用明确 unknown 分支；保留已确定碰撞，不能靠不存在的新苹果继续算。
- [prompt 不能强制 JEV 遵从优先级] → 用真实 fixture 调用报告错误选择；概率不解释为存活率。
- [新 runner 对旧服务端发送 v3 会被严格 schema 拒绝] → 先部署兼容解析的服务端，再部署 runner；不自动降级。
- [未提交工作区与历史 spec 有时序重叠] → 改造前以当前文件再次核对；只改任务范围，已有旧 change 不动。本 delta 新增 runner 要求，避免覆写 response/两步调度要求。

## Migration Plan

1. 在改造前固定当前 v2 fixture；先加入新旧 request/decision 读取和 schema，保留历史行为。
2. 实现纯分析、v3 请求和诊断；贯通 runner 控制及存储回放；同一次发布使服务端先接受 v3。
3. 运行确定性/契约/全量回归、typecheck、局部 Biome 和 build，再执行上述真实评估与浏览器检查，记录实际证据。
4. 回滚生成端时保留支持 v3 的 schema 与回放读取端；不删除 v3 历史，不改写 recordVersion，不自动切换其他模型或旧 context。没有数据库 DDL 迁移。

规划阶段没有未定的接口或算法选择。真实延迟、JEV 的选择质量和整局得分只能在实施后按上述清单得到，不影响本次规格和任务结构。
