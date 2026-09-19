# 两步延迟兜底验收

验收日期：2026-09-19。以下区分确定性测试、真实模型运行与浏览器核对；测试传输数据没有作为真实模型结果写入生产对局。

## 自动检查

- `npm run test:snake`：6 个测试文件、60 个测试全部通过，覆盖单步旧协议、两步计划、真实临时 SQLite/HTTP/WS 和模型边界 fixture；最终结果见 `.data/qa/two-step-fallback/tests.log`。
- `npm run typecheck`：通过，包含前端、共享类型、服务端和 runner。
- `npx biome check server shared scripts tests src/features/snake`：30 个文件通过，没有忽略或抑制检查项。
- `npm run build`：通过，生成服务端、前端与 SSR 产物；日志位于 `.data/qa/two-step-fallback/build.log`。
- OpenSpec delta 的主规格同步依赖保持不变：归档前先同步 `add-neobrutalist-snake` 基线，本次没有归档或修改旧规格。

## 规格对应证据

| capability | 验证内容 | 证据 |
| --- | --- | --- |
| snake-jev-runner | 一次 Choice 的 16 个顺序选项，原始实际局面，联合概率不归一化，错误暴露，串行补充，模式关闭 | `tests/jev.test.ts`、`tests/jev-runner.test.ts`；真实两步及单步运行 |
| snake-gameplay | 新主动作优先、835ms 等待期间自动使用上轮第二步、首次迟到/耗尽直行、旧计划不重绑、奖励变化、备用碰撞 | `tests/plans.test.ts`；真实 seq 82 / 178 / 186 |
| snake-server | 原子接纳、逐步去重、首步 applied/次步 superseded、失败回滚、stop/restart 清理、版本和权限 | `tests/plans.test.ts`、`tests/ws.test.ts`、保留的 `tests/game.test.ts` |
| snake-spectating | 当前实际来源与最新收到结果分开，待执行主动作和备用同时显示，手机布局 | agent-browser 实时页与回放；seq 7 展示三个待执行项 |
| snake-match-replay | 备用事件可跳转、逐步状态、原始请求不串线、复制 JSON、旧记录及版本错误 | `tests/replay.test.ts`、浏览器 seq 8 / 82 / 83 / 186 与旧回放 |

确定性测试在下一模型请求人为等待 835ms 时证明：N+2 在截止点使用计划 A 第二步；返回的新计划 B 整份 late_action 拒绝，随后读取实际局面。它同时覆盖无备用的后续直行，不生成第三步。HTTP/结构错误、Ctrl+C 和终局取消均经过真实 runner 子进程验证。数据库触发器注入失败证明无部分状态提交或成功广播。

## 真实模型运行

两局顺序运行，均使用 OpenRouter、`typesafe/jev-1.13`，返回版本 `typesafe/jev-1.13-20260917`，24×18、12 个障碍、500ms/步，seed 为 `two-step-validation-20260919`。没有增加截止阈值、模拟成功、自动改选方向或中途改速；两局均自然结束，runner 退出码 0。

| 指标 | 两步兜底 | 单步关闭检查 |
| --- | --- | --- |
| matchId | `089ec144-ff32-47b5-bcd8-820146a2044b` | `899251a7-7e06-4cad-a9ee-d98a860b227b` |
| decisionMode | two_step_fallback | single_step |
| recordVersion / rulesVersion | 2 / 2 | 1 / 1 |
| 步数 / 得分 | 69 / 40 | 371 / 270 |
| 返回并提交的模型请求 | 63 | 369 |
| 新动作执行尝试 | 56 | 354 |
| 备用执行尝试 | 3 | 0 |
| 沿原方向步数 | 10 | 17 |
| late_action 拒绝 | 7 | 11 |
| invalid_direction 拒绝 | 0 | 1 |
| 备用被新主动作覆盖 | 53 | 0 |
| requestMs 中位数 | 326.83ms | 314.28ms |
| requestMs P95 | 532.41ms | 385.18ms |
| requestMs 最大值 | 1112.88ms | 1115.88ms |
| 结束原因 | wall，来源 fallback | self |

P95 按排序后的 `floor(0.95*(n-1))` 取值。这是两局集成验收，不是足以推断胜率或模型性能提升的统计实验；两步轨迹与单步轨迹不同。本次两步结果分数低于单步，不能把兜底已生效说成更安全或得分更高。

两步局的备用事实：

- seq 82 / tick 29：执行计划 `64336188-fd95-4170-a6e8-2ca5b98ca639` 的第二步向左，依据 tick 27；前置 tick 28 已实际执行。
- seq 178 / tick 65：执行上一计划的第二步向上。
- seq 186 / tick 69：执行上一计划的第二步向上并撞墙。记录同时保留 fallback 来源和 wall 结果，没有替换为其他方向。

原始日志、完整公开状态及事件、统计 JSON 均保存在 `.data/qa/two-step-fallback/`：`two-step-runner.log`、`single-step-runner.log`、两组 `*-events.json` / `*-state.json`、`report.json`。其中原始请求记录真实 `questions.plan` 和 16 项概率，未包含密钥或认证头。

## 浏览器核对

按项目要求使用 `agent-browser`，先读取本机 help；独立 session 为 `two-step-fallback-qa`，检查前取 snapshot，操作后核对真实状态。

- `/watch/089ec144-ff32-47b5-bcd8-820146a2044b` 实时更新；tick 36 明确显示沿原方向、备用已耗尽，旁边的迟到响应未被冒充成本步动作。
- 两步回放 seq 7 同时显示旧计划 tick 4 备用、新计划 tick 4 主动作和 tick 5 尚待激活备用；seq 8 的输入面板正确显示旧备用被覆盖。
- seq 82 默认关联原计划 A、观察 tick 27、目标 tick 28/29，两步均 applied；textarea 的 JSON 与持久原请求逐字一致，“复制 JSON”操作显示“已复制 JSON”。
- seq 83 单独查看迟到计划 B 时，输入面板改为 B 的拒绝结果，实际动作面板仍显示 A 的备用，不串请求来源。
- seq 186 显示第 69 步的备用撞墙；桌面与 390×844 手机均核对。手机两步侧栏采用单列，实测宽 358px，无横向溢出。
- 原 `3e98b0a9-df25-4731-85b8-d3221fcbd267` 的旧回放仍显示 290 分 / 438 步、四方向概率与原始单步请求，没有被解释为两步记录。
- 浏览器 `errors` 未返回页面异常。

截图：`live.png`、`replay-fallback.png`、`replay-mobile.png`、`replay-superseded.png`、`legacy-replay.png`，均位于 `.data/qa/two-step-fallback/`。

## 验证边界

- 实际使用并验证的是 OpenRouter；Typesafe 直连的两步契约经过测试传输校验，本次没有新增直连实跑。
- 随机奖励变化、事务失败、重启和鉴权等非自然运行分支由确定性测试验证；没有在用户数据库中注入故障。
- 备用的准确性不保证。它只覆盖已预留的一个目标 tick，首次超时和备用耗尽仍会直行，所有结果明确记录。
