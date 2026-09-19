# 响应单步收敛验收

日期：2026-09-20，Asia/Shanghai。实施 change：`retain-response-single-step`。

## 已修正的设计

- 删除旧固定/两步局转换为响应局的方案，没有新增 recordVersion 或数据库迁移。旧历史原样可读；新的续跑仅接受原响应单步局，旧模式明确返回 `mode_retired`。
- 遗留 `SNAKE_TICK_MS` 只输出可见弃用提示，不影响响应运行；删除变量即可消除提示。显式 fixed、two_step_fallback、--tick-ms 仍明确拒绝。原响应局续跑完整继承配置，不应用新建环境默认值。真实 `.env` 未修改。

## 代码与自动验证

- 新建 schema 与历史 schema 分离；旧创建及控制请求按原 hash 幂等返回，不借此执行已停用模式。
- 生产 runner 只调用单步；删除 `askJevPlan`、`advancePlan`、`acceptPlan`、`movedAfter` 和固定节拍移动。旧计划构建移入 `server/jev/legacy-context.ts`，仅测试与离线评估引用。
- 保留星星真实时间到期、单步原子提交、请求去重、错误暴露、原始概率、v4 事实/正向证据、真实进度，以及旧计划取消清理。
- 现有 UI 已按已保存模式条件展示，经验证无需新增前端补丁；新局不显示备用或固定速度，旧回放保留原模式。

| 检查 | 结果 |
| --- | --- |
| 修改前 `npm test` | 32 文件，311 测试通过 |
| 最终 `npm test` | 32 文件，290 测试通过，7.98 秒 |
| `npm run typecheck` | 通过 |
| `npm run check` | format:check、lint 通过 |
| `npm run build` | 服务端与前端构建通过 |
| `git diff --check` | 通过 |
| `openspec validate retain-response-single-step --strict` | 通过 |
| 两个 context 评估脚本，`--samples 2` | 离线均通过，真实请求数 0 |

测试数量变化来自移除旧模式“继续可执行”的断言，替换为默认响应、旧参数拒绝、历史原文/hash、旧请求幂等、重启取消和旧模式续跑拒绝。响应的事务失败、慢响应、去重、反向、过时状态、真实 HTTP/WS、频道两局、续跑/RNG、回放和上下文均保留。额外覆盖“停止后到达真实 API 错误”仍以失败退出，不能误报正常取消。

`tests/fixtures/legacy-matches.json` 在修改旧执行器前由当时的真实引擎和 SQLite 捕获，包括 ready、主动作已执行但备用待定、备用/直行已经执行的固定单步与两步记录。其控制者输入为明确的测试数据，不代表真实模型推理。自动测试仅在外部模型边界使用测试传输，不伪造服务端移动或事务成功。

## 浏览器与真实模型

使用 `agent-browser --session response-only-qa`，先读取实际 CLI 帮助，操作前 snapshot、操作后核对。网页端口 3100，服务端 3101，隔离数据库 `.data/qa/response-only/browser.sqlite`，没有使用或改写现有对局库。结束后已关闭本任务浏览器 session 和两个测试服务。

- 响应续跑局等待超过一分钟仍停在第 1 步，页面显示“等待下一次决策后移动”“随模型响应”；实时等待和连接状态分别展示。
- 响应分支回放默认定位 `forked` 边界，显示原局来源、继承步数及原配置。
- 旧两步回放第 2 步仍显示“上轮备用”、原 500ms 配置、方向对联合概率及完整原始输入；统计为 1 次模型请求、1 次主动作、1 次备用、1 次直行。
- 页面错误检查为空；保存 waiting、channel、two-rounds-complete、legacy-replay、response-fork-replay 截图。

真实调用使用本机当前配置 `openrouter / typesafe/jev-1.13`，请求全部为 `action-facts-v4`、response 单步。保留服务商返回的实际模型与概率。

| 对局 | 场景 | 结果 | 返回请求 / 实际移动 / 拒绝 |
| --- | --- | --- | --- |
| `83f7310e-3a09-4c37-aaff-8ac37932cf75` | 随机 7×1 小棋盘 | 主动关闭测试服务，记录 interrupted/server_shutdown | 140 / 3 / 137 |
| `4671de7c-b7f6-45b8-85a3-cd4f6d8723da` | 固定 7×1 种子，连续第 1 局 | won，30 分，3 步 | 3 / 3 / 0 |
| `cf1f7a20-70b7-4fc8-8dd2-5f30ac75f36d` | 同种子，连续第 2 局 | won，30 分，3 步 | 3 / 3 / 0 |

第一场在第 3 步后反复返回非法反向，全部明确拒绝，没有补方向或自动直行；最后一个在途请求主动取消并保留真实等待时间。此现有行为未通过限次、代选或隐藏降级规避，也不将这场记为成功通关。

两局正常续局采用 `response-only-forward-3`：该种子事先通过引擎验证，连续向前可逐个吃满，用于检验运行/续局流程，不作为模型一般棋盘能力证明。实际六次调用全部返回向左并各自推进一步。第一局 1813ms，第二局 1666ms；请求耗时约 300–1119ms，没有固定截止拒绝。

频道依次记录 `running → countdown → running → draining → stopped`。QA 驱动在第二局开始后提交与所有者相同的“停止后续开局”意图；本局仍由真实模型自然完成，没有强制终局或生产限步规则。最终频道关闭，没有第三局。两局共六次真实请求、六次实际移动、零 plan/fallback/coast。

原始验收产物位于忽略目录 `.data/qa/response-only/`：`summary.json`、两个离线报告、`server.log`、`rounds.log`、`channel-transitions.jsonl`、隔离 SQLite 和截图。验收脚本独立于生产入口，没有增加生产兜底或模拟模型。

## 范围

保留出生布局、配色、棋盘规则、模型自主选择和已有历史。没有提交 Git、归档 change、部署或修改真实环境凭证。
