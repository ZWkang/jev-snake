## Why

JEV 曾在对局 `899251a7-7e06-4cad-a9ee-d98a860b227b` 的第 364 步选择进入身体围成的必死通道；当前代码已补上动态 `forcedPath`，但分叉后的空间、绕障食物路径和增长后的退路仍靠模型从坐标推理。结合参考会话和本项目历史，本变更一次设计完整的动作后果 context，使 JEV 更容易在生存、苹果和星星之间判断，同时能核验输入成本与真实效果。

## What Changes

- 复用真实碰撞规则，提供每个候选动作的即时结果、动态强制通道、静态可达空间、蛇尾连通性、候选食物路径及沿该路径增长后的退路信息；明确区分已证实结果、静态启发式与未知。
- 设计 `action-facts-v3` / `two-step-plan-v3`：以紧凑的动作后果为模型输入，程序负责几何计算，JEV 仍独立返回方向或有序方向对；删除要求模型继续从完整坐标推理的提示。
- 单步与两步统一事实生成。第一步吃苹果后，第二步仅报告仍可确定的事实，不猜测随机新苹果、后续增长或新的星星。
- 生存优先于追食，苹果与星星分别表达距离、到期条件和收益；不把概率当存活率，不把静态路径存在当成必胜证明。
- 新旧 context 按版本严格解析；保存实际发送正文，回放显示 context 版本和信息含义，旧正文原样可读。
- 实施任务包含历史死局回归、尾巴移动/增长/未知边界测试、请求大小与本地计算耗时、真实模型请求和整局评估；输入质量与整局结果分别报告。
- 保留现有 fixed/response、单步/两步执行协议和延迟处理。此次不新增自动避碰、寻路代打、重试、限步终局或换模型逻辑。

## Capabilities

### New Capabilities

- `snake-decision-context`：动作事实的计算语义、有限静态搜索与动态验证、紧凑表达、事实边界和验证标准。

### Modified Capabilities

- `snake-jev-runner`：版本化紧凑请求、单步与两步输入、原始结果与输入成本的可追溯性。
- `snake-match-replay`：兼容新旧决策正文并解释 context 版本，按保存内容展示，不重算历史。

`openspec/specs/` 当前为空；上述既有路径的基线在已完成未归档的 `add-neobrutalist-snake`，两步及 response 的后续 delta 分别在 `add-two-step-decision-fallback` 和 `add-response-driven-snake-mode`。本次沿用路径，只增加 context 要求，不重新定义它们之间的调度语义；以后同步主规格时应先处理这些基线。本次不归档或改写既有变更。

## Impact

- 核心：`server/jev/context.ts`、`server/jev/client.ts`、`shared/snake/types.ts`、`shared/snake/schema.ts`，必要的纯几何辅助函数继续与 `server/game/engine.ts` 的 `inspectMove` 一致。
- 集成：`scripts/run-jev.ts` 的诊断，`src/features/snake/DecisionInput.tsx` 的版本说明；SQLite 沿用已有 JSON 记录，不更换存储、不改游戏 record/rules/protocol 版本。
- 验证：`tests/context.test.ts`、`tests/jev.test.ts`、`tests/jev-runner.test.ts`、`tests/replay.test.ts` 及现有真实 SQLite/WS 测试；实施时增加可复用评估脚本并更新 README。
- 无新增运行依赖。只在实施阶段调用真实 JEV；本规划未开展新模型实验，也不承诺任意随机障碍棋盘必胜。
- 当前按“一次把改造上下文、实现顺序及验收写完整”理解“一次跑完”，同时把减少死亡、整局得分和吃满结果纳入效果评估，不以单局输赢替代契约正确性。
