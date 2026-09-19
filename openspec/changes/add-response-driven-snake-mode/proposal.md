## Why

固定步频对局中，接口耗时超过移动窗口时会拒绝结果，按既有策略使用备用动作或继续直行，难以单独观察模型“得到当前局面后会选择怎样走”。新增由接口响应驱动的模式，让每次有效决策直接对应一步，速度由真实调用与必要提交耗时决定，同时保留固定步频实验。

## What Changes

- 增加开局配置 `stepMode: fixed | response`，默认保持 `fixed`。`response` 等待模型时蛇不移动；结果通过当前局面校验后，服务端立即提交一次移动，再请求下一步。
- 响应模式没有固定 tick 截止时间、额外 sleep、最低 300ms 间隔或自动直行；一次响应最多产生一步，不提前排队多个位置，也不把旧结果改绑到新位置。
- 保留方向、观察位置、状态摘要、请求去重、碰撞和持久化检查。拒绝的动作不移动；无可用响应时不代选。网络/API/解析错误继续明确报告并按现有 runner 规则中断。
- 星星沿用现有的真实运行时间 8 秒到期规则，等待响应也计时；到期与动作同时发生时先处理到期。
- 保存模式、实际每步时间和等待间隔。观战区分“等待下一次决策”和订阅断线；历史显示模式与实测平均步频；回放保留真实的非等间隔过程。
- 响应模式使用 `recordVersion: 3`、`rulesVersion: 3`，读取端兼容已有固定单步 v1 与固定两步 v2 历史；不把 `tickIntervalMs=0` 当作新模式，不把响应模式的时间误算成固定速度。
- 与已实现的固定模式 `two_step_fallback` 分开：响应模式选用 `single_step`，一次调用只执行一步，不消费备用动作；显式组合 response 与 two_step_fallback 在创建前报错。本变更保留 fixed 默认两步的运行器策略。

## Capabilities

### New Capabilities

无独立业务模块。

### Modified Capabilities

- `snake-gameplay`：开局选择推进模式、响应到达后的一步移动、真实时间奖励规则及错误情况下不自动移动。
- `snake-server`：按模式调度、无固定截止的当前局面契约、即刻应用事务、计时元数据与兼容记录。
- `snake-jev-runner`：响应模式的串行请求—提交—确认循环、CLI 配置及非固定时间输入。
- `snake-spectating`：明确推进模式、等待状态、实际步频和不依赖固定间隔的棋盘更新。
- `snake-match-history`：持久保存与展示模式、真实运行时长和步频。
- `snake-match-replay`：按原始时间间隔回放，兼容旧固定步频记录。

当前 `openspec/specs/` 尚无主规格；上述已实现能力的完整基线位于未归档的 `add-neobrutalist-snake/specs/`。本变更沿用这些路径和 requirement 名称编写 delta。旧规格中的“等待时仍直行”“方向在定时边界生效”仅继续约束固定模式；响应模式适用本次新增分支。后续合并规格时应先同步该基线，再应用本 delta。

## Impact

- 契约：`shared/snake/{types,schema}.ts`，以及 `server/app.ts` 的决策上下文和 WS 时间信息。
- 调度与持久化：`server/matches/service.ts`、`server/game/engine.ts`、`server/db/store.ts`；复用真实规则和 SQLite 事务，不新增数据库或后台服务。
- 调用端：`scripts/run-jev.ts`、`server/jev/client.ts`；复用现有 OpenRouter / Typesafe 配置和增强 context，不改变服务商或隐式重试策略。
- 前端：`src/features/snake/{api,Scene,SnakeBoard,LivePage,HistoryPage,ReplayPage,DecisionInput,replay}`；移除这些展示在响应模式下对固定间隔的假设。
- 验证覆盖规则/时钟、真实 SQLite/WS、runner 子进程、历史兼容与浏览器回放；更新 README 和环境配置说明属于实施阶段。
- 方案已获用户通过 openspec-apply-change 授权实施；实际进度与验收见 tasks.md 和 validation.md。
