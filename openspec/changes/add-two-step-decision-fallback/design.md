## Context

动机见 [proposal.md](proposal.md)。本文件记录提案时的设计与实现基线；当前落地及验证状态见 [validation.md](validation.md)。

本轮已核对的实现事实：

| 位置 | 当前行为及本变更的切入点 |
| --- | --- |
| `scripts/run-jev.ts` | 读取实际 decision-context → 等待 `askJev` → 提交 action → 等实际 tick；一次一个在途请求。 |
| `server/jev/client.ts` / `context.ts` | 只有四方向 `questions.direction`，携带真实棋盘、蛇身和一步 actionFacts；没有多步模型响应。 |
| `server/matches/service.ts` | `pending` 中仅接受当前 tick+1；`decisionContext` 遇到任何 pending 都拒绝；`advance` 没有 intent 就用原方向。 |
| `shared/snake/{types,schema}.ts` | 严格 protocolVersion 1、单个方向和一个最终 receipt；记录与规则版本都是 1。 |
| `server/db/store.ts` | SQLite `state_json`、`event_json`、`receipt_json` 保存完整 JSON，同一事务提交；解码硬校验记录版本。 |
| `Scene.tsx` / `DecisionInput.tsx` / `ReplayPage.tsx` | 使用 lastDecision 展示四方向概率，最近接纳/拒绝决定面板内容；不能区分最近收到与本步实际使用。 |
| `tests/{game,jev-runner,ws,replay,jev}.test.ts` | 已覆盖未来目标拒绝、过期不重绑、原局面校验、真实 SQLite/WS、终局错误、旧记录和原始请求保存。 |

主规格目录目前只有 `.gitkeep`。完整基线位于已完成但未归档的 `add-neobrutalist-snake/specs/`。本提案的 MODIFIED 块从该基线保留原 requirement 名称及原场景，再补入模式分支；归档顺序见 Migration Plan，不能把缺失主规格误认为没有既有行为约定。

官方契约核对（2026-09-19）：Typesafe 的 Choice 接受调用者定义的标签并返回该组选项概率，OpenRouter Decisions 使用相同的 `state/questions/answers` 形状。因此选择“有序方向对作为一个选项”是本项目的协议设计；文档支持其数据形状，但本轮没有发起付费模型请求验证 16 选项的延迟或效果。[Typesafe API](https://docs.typesafe.ai/api)、[OpenRouter Decisions API](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request)。

## Goals / Non-Goals

**Goals:**

- 在 500ms 固定节拍下，为下一轮请求延迟提供一个已保存、由真实模型产生的备用动作。
- 服务端在 tick 边界完成裁决，计划的接纳、逐步执行和失效可以从 DB、回执及回放交叉核对。
- 保留单步运行模式及旧历史读取，关闭方式明确。

**Non-Goals:**

- 不保证备用安全或提高分数，不新增寻路、避碰接管、概率阈值改选、自动重试或服务商切换。
- 不增加任意长度计划、多请求并发、自动调速、暂停等待模型或重新引入旧 `/projection` 接口。
- 不推断未来随机奖励，不修改已运行对局模式，不在本规划阶段启动实现或重启服务。

## Decisions

### 1. 一个模型 Choice 选择一个有序方向对

两步请求保留实际观察 state，增加 `contextVersion: "two-step-plan-v1"`、`planningHorizon: 2` 和固定目标 `[N+1, N+2]`。`questions.plan` 为一个 Choice，16 个标签完整覆盖四方向笛卡尔积，如 `right_down`；每个 criteria 使用字符串明确“先右，再在第一步已执行的条件下向下”。instructions 说明优先避免第一步碰撞，再考虑第二步生存与奖励，后续奖励位置未知。保留当前一步 actionFacts、原始蛇身、障碍和奖励；不新增会运行真实 RNG 的本地未来局面生成器。

解析结果为 `PlanDecision`：原始 choice、16 项 probabilities、confidence、实际 provider/model、requestMs、usage、完整脱敏请求；方向对通过固定标签映射解码，不重新取概率最大值替代模型 choice。单项字段非法或缺失仍显式失败；概率合计异常仅告警，保留原值。模型概率属于整份方向对，不伪造两步独立置信度。

理由：两个独立的 `direction` / `nextDirection` 问题并不能在契约层保证第二个答案基于第一个答案；串行询问两次又会增加 HTTP 等待。联合选项在一次请求里表达顺序，保留真实选择。16 是四方向两步的完整空间，不是额外的运行上限。

局限：联合选择可能改变第一步策略，返回体和选择复杂度可能增加；实施验收必须单独测量两步请求耗时，不能沿用单步基准声称性能提升。

### 2. 固定的模式、版本和关闭入口

- 新 runner 参数 `--decision-mode single_step|two_step_fallback`，默认 two_step_fallback；启动日志打印 mode、provider、model、tick-ms。`--tick-ms` 默认保持现有 300，不改成 500；本需求验收显式传 500。
- 创建配置增加 `decisionMode`；未传的旧创建请求默认为 single_step。局内不可切换，创建去重摘要包含 mode。
- 单步沿用 protocolVersion 1 的 start/action/stop；两步采用 protocolVersion 2 的 start/plan/stop，服务公开 `supportedProtocolVersions: [1,2]`，保留现有 `protocolVersion: 1` 字段服务旧客户端。
- runner 在创建两步局前确认服务支持 v2；不支持就明确失败，不降级成单步。控制协议与局模式不一致返回 `decision_mode_mismatch`。
- 两步局写 `recordVersion: 2, rulesVersion: 2`，单步和既有记录继续 1/1；读取端显式支持这两种组合，未知组合继续报错。该版本区分的是控制与记录语义，碰撞和随机奖励算法仍相同。

理由：严格旧 schema 不能靠追加字段自然兼容。显式区分使旧服务拒绝新能力、旧查看端拒绝未知记录，不出现第二步被静默丢弃。正常关闭使用 single_step，而不回退到不能读取新记录的旧程序。

### 3. 一份计划原子接纳，两个动作分别结算

v2 计划外形：

```json
{
  "protocolVersion": 2,
  "type": "plan",
  "requestId": "plan-A",
  "observedSeq": 200,
  "targetTick": 101,
  "expectedStateHash": "<当前实际局面摘要>",
  "directions": ["right", "down"],
  "decision": "<完整 PlanDecision>"
}
```

`targetTick` 是第一步，第二步只能是 `targetTick+1`，服务端派生 stepIndex 0/1，不接收任意 future tick。提交时校验实际观察仍是当前 tick、摘要相符、原始 choice 与 directions 一致、首步不反向、次步不相对首步反向、长度恰为两步、无已接纳本步主动作。语法正确但直接反向的计划返回 `invalid_direction`，不伪造成模型传输错误。两步整体接纳或整体拒绝；第一步迟到即整份拒绝，第二步不能单独救活该迟到计划。

保留当前单步 pending 路径；两步模式在私有 MatchState 中保存一个当前主动作、该计划的后继备用，以及可能同时存在的“上一计划本 tick 备用”。这三项来自滚动两步的重叠，不是任意长未来队列。接受新计划时只注册新主动作及其未激活后继；旧备用保留到 tick 裁决结束。`decisionContext` 只在当前 tick 已有主动作时冲突，不能因存在旧备用就拒绝读取实际局面。

v2 receipt 将 admission 与执行分开：接纳/拒绝结果固定，`steps[0|1]` 分别记录 targetTick、direction、状态、结果事件 seq、reason、replacementRequestId（适用时）。逐步状态包括 queued/standby、applied、superseded、cancelled、expired、rejected。接纳时备用可以预留但尚不具备执行资格；计划第一步应用后才激活。first applied / second superseded 等组合必须完整表达。重复请求读取 DB 中当前逐步结果；同 ID 改变任一方向冲突，不能重复建备用。

### 4. 移动边界按优先级选择，而不是客户端超时补发

每次 `advance` 的目标 tick T：

1. 按原时序先处理到期奖励，读取 T 的已接纳主动作，并进行原有实际状态摘要与反向校验。
2. 主动作有效：选择 primary；旧 T 备用记 superseded 并关联替代计划。
3. 主动作缺席或失效：对旧 T 备用核对原目标、未消费、parentRequestId 的第一步已在 T-1 applied、当前方向可执行。符合条件则选择 fallback。主动作失效时取消它及自己的后继，不连带删除旧备用。
4. 两者均无效：选择 coast，保存 `no_plan`、`backup_exhausted`、`backup_invalid` 等实际原因；继续原方向。这里延续已有游戏规则，不虚构第三步或其他模型结果。
5. 调用原引擎 `move` 一次，保存实际方向、尝试目标及 actionSource。使用的动作即使导致 gameover 也记为已执行尝试；不会标成成功存活。若首步成功移动且对局仍 running，激活该计划的后继备用；终局则取消所有未用项。
6. 在同一 DB 事务内提交局面、计划/逐步回执、覆盖/取消事件和移动事件，再广播。

截止以现有服务端入口时间判断，恰好到点视为迟到。服务线程调度落后时，接收处理先推进应结算的 tick，不能利用真实处理晚于计划时刻而接纳过期输入。按顺序结算多个积压 tick 时，备用只能消费一次，后续没有新指令继续 coast。

```text
观察 N ── A=[右,下] 及时接纳
             │
N+1          └─ 执行 A[0]=右，激活 A[1]；观察实际 N+1，请求 B
N+2             B 及时且有效：执行 B[0]，A[1] 被覆盖
                B 未可用：执行 A[1]=下，A 耗尽
N+3             B 迟到整份拒绝后，如仍无新有效计划：沿原方向
```

理由：把备用留在 runner 内，等 await 模型返回再提交会错过原本要救的 tick。将两个动作无区别放进现有 pending 又会导致新主动作被旧备用判为冲突，无法实现最新决策优先。

### 5. 备用只校验执行前提，不强求旧奖励预测正确

备用的依赖是“所属计划第一步确实在上一 tick 生效”，不是只比较方向是否碰巧一样。第一步取消、被拒绝、终局或错过目标，第二步就取消；反向仍明确拒绝。正常吃苹果、新奖励出现或星星消失不单独使备用失效，因为用户明确接受后续预测不准确。

主动作继续用真实状态 full hash。备用不拿 N 时刻 full hash 与 N+1 比较，也不要求对随机新苹果作准确预测；通过第一步的实际应用证明位置前提，原始请求保持不变。不提前拒绝会撞墙/撞身的备用并替换为直行，否则会额外引入未请求的防撞控制策略。真实碰撞由引擎结算并记录 fallback 来源。

### 6. runner 保持串行、按实际局面重新决策

沿用当前一次一个在途请求和每个实际 tick 至多一次请求。双步结果及时提交后，等待一次真实移动再取新 context；仅收到计划接纳或备用注册事件不能重复请求同 tick。等待新模型期间服务端可以消费旧备用，runner 不另开并发预测请求。响应回来仍按原 target 提交并记录接纳/迟到，随后立即基于最新已提交局面恢复循环；不会拿迟到 B 的第二步给下一个 tick。

不新增超时阈值或假成功路径。HTTP、解析错误按现有规则暴露并 stop 为 model_error；错误被发现前已经在截止点消费的备用保留为事实，错误发现后不会继续用它掩盖失败。保留 match_ended 主动取消与真实错误的区分，Ctrl+C 仍走受保护停止通道。

### 7. 存储与展示分清“收到”与“执行”

- 保留 `lastDecision` 表达最近收到的模型结果；新增公开 `lastAppliedAction` 表达最近实际移动尝试，包括 `source: primary|fallback|coast`、direction、tick、requestId/stepIndex/observedTick（有计划时）及 reason。
- 事件包括 plan_accepted/plan_rejected、plan_step_cancelled/plan_step_superseded/plan_step_expired；原 move/apple/star/gameover 携带真实 actionSource。第一步应用与备用激活结果可在该次移动的逐步结果中表达，不额外增加 tick。
- `plan_accepted`/`plan_rejected` 保存脱敏原始 request 和 PlanDecision。所有逐步事件引用同一 requestId；备用不是一个新的模型调用。收到拒绝记录不能覆盖 lastAppliedAction。
- 在版本 2 事件保存独立 `receivedGameTimeMs`，包括终局后收到请求的情况；保留原 observedSeq、两个目标、requestMs 和可计算时的 reactionMs。gameTimeMs 仍表示游戏局面时间，不把冻结的终局时间当作收件时间。
- `Scene` 分别呈现当前移动来源和待执行计划；`DecisionInput` 可以按实际移动 requestId 定位原计划，也能手动查看另一条迟到结果。联合概率以 16 个方向对的列表呈现，可折叠；不复用四方向条形图伪称独立单步概率。
- `ReplayPage` 分别统计唯一请求数、主动作使用数、备用使用数和沿原方向步数；取数基于持久事件，终局碰撞尝试同样计入执行来源。

SQLite 表结构无需新增列，扩展 JSON 结构和支持版本即可；更新 Store 的 snapshot 与 event 双路径校验和前端 assertRecord，未知版本继续明确失败。私有待执行状态不暴露控制凭证，PublicState 继续隐藏内部调度结构。

## Risks / Trade-offs

- [两步 Choice 可能更慢或改变首步策略] → 真实验收记录请求数、requestMs 分布、迟到率、备用实际使用、碰撞来源和分数；不以单场分数宣称模型能力提升。
- [首次超时、连续慢请求超过一拍仍无备用] → 明确 no_plan/backup_exhausted；保留直行规则，不额外生成动作。
- [备用预测不准确] → 用户已接受该取舍；真实执行结果与来源持久记录，不增加隐藏避碰代打。
- [新主动作接纳后失效导致旧备用意外丢失] → 推迟覆盖裁决到移动边界，测试奖励过期和事务失败场景。
- [同一请求两次执行污染回执或统计] → v2 逐步状态和唯一 requestId 统计，覆盖重发、首步 applied/次步 superseded 的组合。
- [版本 2 被旧二进制读取] → 明确版本错误，先部署兼容读取端，关闭新模式通过 single_step 完成，不删除新记录。
- [旧基线尚未同步主规格] → 保留基线变更原文件，归档时先同步基线；随后检查本 delta 的 requirement 名称和原场景仍匹配，不能直接把 MODIFIED 当作 ADDED。

## Migration Plan

1. 实施时先完成支持旧 1/1、新 2/2 的共享契约、存储读取和 UI，再启用新 runner 默认模式；任何服务重启遵循现有 server_restart 中断行为，不承诺运行中无缝迁移。
2. 新单步与旧客户端保留 v1 路径；新双步 runner 通过 health 能力声明选择 v2 并保存 decisionMode。配置值、模式和记录版本都从创建到回放贯通。
3. 先跑确定性边界/持久化/WS/runner 集成测试，再做 500ms 的真实 OpenRouter 两步联调和单步关闭检查，保存实际请求契约与事件证据，禁止把测试传输 fixture 作为真实模型验证。
4. 使用项目规定的独立 agent-browser session 检查 `/watch/:matchId` 和回放，验证主动作、备用、沿原方向、覆盖、迟到、碰撞和旧记录；读取快照、操作后核对，必要时截图。
5. 运行相关测试、typecheck、针对改动文件的 Biome 与完整 build；更新 README 的已实现行为与观测指标。规划阶段不执行以上业务验证。
6. 归档前依次同步 `add-neobrutalist-snake` 基线、本变更 delta；本次 proposal 阶段不执行同步或归档。
7. 回退行为使用 `--decision-mode single_step` 创建后续新局，继续保留能读 v2 的程序；不得通过删库、重写历史或静默降级恢复旧二进制。原始库无需全量重写。
