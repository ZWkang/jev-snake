# add-response-driven-snake-mode 验收记录

日期：2026-09-19。此次实现新增 response 推进模式，保留 fixed 默认行为；不改变服务商，不归档本变更。

## 实现范围

- fixed 默认仍为固定步频，runner 默认 `two_step_fallback`；response 自动选用 `single_step`，没有移动定时器、固定截止、额外 sleep 或最低步频限制。
- response 取得有效决策后立即提交一次移动，runner 收到 applied 后才读取下一实际局面。无响应时蛇保持原位；星星按真实时间到期。
- response 的显式 `--tick-ms` 或 `--decision-mode two_step_fallback` 组合在创建前报错；不继承 fixed 专用环境值 `SNAKE_TICK_MS`。
- 单步固定记录保留 v1、两步固定记录保留 v2，response 使用 `recordVersion: 3` / `rulesVersion: 3`；旧 JSON、创建摘要和状态摘要不通过注入默认模式重写。响应模式的控制信封仍为 `protocolVersion: 1`。
- 观战、历史、回放与决策输入区分两种推进模式；response 直接显示已确认位置，移动与得分反馈解耦。回放按原始时间和 seq 读取保存快照，不重新运行模型。

## 真实模型联调

两局均使用 OpenRouter 的 `typesafe/jev-1.13`，读取本机已配置的独立凭证，密钥未写入公开记录或本文件。数据来自真实 SQLite 对局及 `.data/qa/response-mode-live-results.json`，并非测试传输生成的模型成绩。

| 项目 | response | fixed |
| --- | --- | --- |
| 对局 ID | `03d11c83-529a-48c5-88ef-20e018146493` | `d97f2fba-84a0-4cfe-bf52-5bafd4227460` |
| 记录/规则版本 | 3 / 3 | 2 / 2 |
| 决策策略 | single_step | two_step_fallback |
| 固定间隔 | null | 500ms |
| 步数 / 分数 | 286 / 200 | 177 / 90 |
| 真实运行时长 | 99.435 秒 | 88.677 秒 |
| 返回并提交的决策数 | 290 | 169 |
| 接纳结果 | 286 条动作，均 applied | 160 份两步计划 |
| 拒绝结果 | 4 条 stale_state；0 条 late_action | 9 份 late_action |
| 模型请求耗时中位数 | 312.122ms | 318.673ms |
| 模型请求耗时范围 | 255.546–1061.881ms | 254.326–1010.143ms |
| 已记录移动间隔中位数 | 319.098ms | 177 次已保存移动的相邻时间差均为 500ms |
| response 实际移动间隔范围 | 263.284–2108.893ms | 不适用 |
| 事件数 / seq 连续 | 583 / 是 | 507 / 是 |
| 结束状态与原因 | interrupted / controller_stop | interrupted / controller_stop |

两局均主动停止用于完成验收，**不是自然通关或自然死亡**。固定模式接纳的是两步计划，不能把 160 份计划等同于 160 次实际移动。

response 第一条请求耗时 1061.881ms，第一步在开始后 1067.858ms 提交；其后前四步间隔为 276.560、413.810、317.375、313.610ms。请求往返与实际步间隔分别保存，没有把 HTTP 耗时当成纯推理时间，也没有强行对齐到 300ms 或 500ms。

4 次 stale_state 分别位于 tick 68、130、222、284。逐条核对原始事件：观察后、拒绝前均发生了同一 tick 的 star_expired；拒绝没有移动，随后在相同 tick 重新询问并接纳新动作。这验证了等待中奖励到期后的显式拒绝与恢复，没有死等 tick 或把旧结果绑定到后续步骤。

真实回放：

- [response 对局](http://localhost:3000/matches/03d11c83-529a-48c5-88ef-20e018146493/replay)
- [fixed 500ms 对局](http://localhost:3000/matches/d97f2fba-84a0-4cfe-bf52-5bafd4227460/replay)

上述结果是两场联调样本，不用于证明 response 模式一定得分更高，也不代表服务商延迟已稳定。

## 自动化验证

本次覆盖范围：

- 共享契约与兼容：合法模式、默认 fixed、冲突配置、v1/v2/v3 读取、旧创建请求重发与原摘要不变、未知版本明确失败。
- 服务端：按可控时钟在 120/470/1770ms 到达的动作分别提交，实际步间隔为 120/350/1300ms；长时间等待不自行移动；重复请求、同观察竞争、错误目标、反向、碰撞、奖励到期优先处理。
- 事务：写入失败回滚 accepted 事件、移动、状态和回执，失败前不发布成功；另一个真实 SQLite 连接在成功发布时已经能读取结果。
- HTTP/WS：等待中控制端断线不移动，奖励仍按时到期，重连后立即应用合法动作，重复请求不多走；结合既有 fixed/v2 用例验证观众续读与游客写权限。
- runner：快响应与 120/470/1770ms 慢传输均保持最多一个在途请求；每条已确认动作对应一次实际移动；stale_state 和 invalid_direction 后同 tick 重询；错误目标、API 错误和主动取消显式暴露；0.99 概率合计只诊断、不改写或拦住方向。
- 时间与回放：零步、同时间戳、真实长等待、非等间隔、seq 排序、播放倍速、逐步定位、旧记录读取；显示时间增长不修改已提交局面。

测试边界：runner 自动化仅替换外部模型 HTTP 传输，游戏 HTTP、WebSocket、进程和 SQLite 真实运行；这部分测试结果与上面的真实 OpenRouter 对局分开统计。

已确认的分项检查：`tests/jev.test.ts` 与 `tests/jev-runner.test.ts` 共 31 项通过；对应改动文件 Biome、服务端 TypeScript 检查和 `git diff --check` 通过。

最终执行：`npm run test:snake`（8 个测试文件、93 项通过）、`npm run typecheck`、`npx biome check server shared scripts tests src/features/snake`（33 文件）、`npm run build`、`git diff --check`，均通过。`openspec validate add-response-driven-snake-mode --strict` 通过。CLI 提示基础规格尚未同步、直接归档会被拒绝；本次 apply 没有归档。

## 浏览器验收

使用项目约定的 `agent-browser` 独立 session。已完成并确认：

- 375px 布局没有水平溢出。
- response 零步等待时，显示时间从 00:13 增至 00:16，蛇位置保持不变。
- 2ms 连续确认动作能够直接更新位置；得分增加 10 时仍显示得分反馈，没有为了动画延迟规则状态。
- 真实对局第一步在界面显示约 1062ms 请求耗时和 1068ms 实际步间隔，两种指标没有混用。

- 长等待回放在第 0 步暂停于 00:02，继续后到 00:03；切换 2× 后继续到 00:05，棋盘仍为第 0 步，没有重置为上一事件时间。
- 减少动态效果通过原 agent-browser daemon 的 emulatemedia 命令开启并验证媒体查询为 true；吃苹果后分数为 10、蛇长为 5，未出现加分动画，蛇身坐标保持整数格。验收后已恢复默认媒体设置。
- 实际关闭观众 WebSocket：页面显示连接中断、等待提示消失、运行时间冻结；自动重连后恢复实时更新和等待提示。主动停止后终局显示、等待提示消失、计时冻结。
- 历史列表区分两种模式；旧 v1、固定两步 v2、响应 v3 均成功读取并逐步回放。回放原始 JSON 显示 response、deadlineInMs:null、tickIntervalMs:null 和当前观察/目标 tick；历史导航 active 正确。
- agent-browser 未报告页面 JavaScript 错误。桌面和 375px 截图分别保存在 `/tmp/snake-response-replay.png`、`/tmp/snake-response-mobile.png`。

浏览器协议操作使用明确标为“非 JEV”的真实对局，未冒充模型调用。首场 `daa7ba37-6e70-47c5-ab6f-2ff0d9cbb7b1` 在开发服务重启时按 server_shutdown 保存；补测场 `666fc1b8-bd01-439b-87f4-f7f7e9a2c916` 完成减少动态效果、断线重连与终局冻结验收后，以 controller_stop 正常保存。

## 启动与时间约定

保持 Hono 和前端运行，使用已配置凭证：

```sh
# 固定 500ms；沿用默认的两步策略
npm run jev -- --step-mode fixed --tick-ms 500

# 随真实模型响应走一步，不传 --tick-ms
npm run jev -- --step-mode response
```

CLI `--step-mode` 优先于 `SNAKE_STEP_MODE`；两者均省略时默认 fixed。服务商仍由 `JEV_PROVIDER` 选择，OpenRouter 与 Typesafe 凭证隔离，不自动切换。

response 的 `nextTickAt`、`deadlineInMs` 和 `tickIntervalMs` 为 null。`elapsedGameTimeMs` 表示服务端读取时的实际运行时间；事件 `gameTimeMs` 是最后已提交事件时刻；`stepDurationMs` / `lastStepDurationMs` 表示实际步间隔，第一步从 start 计算；`requestMs` 表示客户端模型调用往返时间。停止记录包含真实等待时长，进程异常重启只保留最后持久化时间，不补跑停机期间的移动。

README 与 `.env.example` 已与实际 runner 配置和协议核对。本次不自动归档 OpenSpec，也不以重写旧历史的方式回滚新格式。
