## 1. 共享契约与版本兼容

- [x] 1.1 在 `shared/snake/types.ts`、`schema.ts` 定义 decisionMode、PlanDecision、两步计划及逐步回执，保留 v1 单步协议；验证两步长度、原始 choice 一致性、模式不匹配、未知版本和旧请求解析的契约测试通过。
- [x] 1.2 在配置创建与 `server/app.ts` health 中贯通旧客户端默认 single_step、新两步 v2 和 supportedProtocolVersions；验证 mode 纳入创建去重、启动/停止鉴权、错误模式拒绝且不改局。
- [x] 1.3 扩展 `server/db/store.ts` 和前端 `api.ts` 的记录校验，支持旧 1/1 与新 2/2，保存两步私有执行状态与 lastAppliedAction；用真实临时 SQLite 验证旧记录无需重写、新记录重读一致、未知组合明确报错。

## 2. 一次请求生成两步计划

- [x] 2.1 在 `server/jev/client.ts` 构造 two-step-plan-v1 请求及 16 个有序方向对的字符串 criteria，复用实际 state/actionFacts；验证输入蛇身等于观察记录、目标固定 N+1/N+2、没有预测 RNG 或虚构奖励，保留单步请求契约测试。
- [x] 2.2 解析并保存 PlanDecision 原始联合选择、概率、confidence、实际模型、requestMs 和请求正文；验证缺失/非法选项显式失败、0.99/1.01 原值保留、provider 独立选择、认证信息不进入保存正文。

## 3. 服务端计划接纳与 tick 裁决

- [x] 3.1 在 `server/matches/service.ts` 实现 v2 plan 的原子接纳、当前观察/摘要/截止/方向一致性校验及逐步去重回执；验证截止前、恰好截止、截止后、同 ID 改第二步、不同 ID 同主动作 tick 冲突和迟到计划不得部分接纳。
- [x] 3.2 调整两步模式 decision-context 和 pending 存储，使旧备用存在时仍可获取真实 context 和接纳新主动作；验证接纳事件不会改变棋盘、已有主动作仍冲突、旧备用不被接纳阶段提前覆盖。
- [x] 3.3 在移动边界实现 primary → fallback → coast 选择、前置应用证明、一次性备用消费和后继激活；以注入时钟覆盖及时新结果、500ms 下一请求超过截止、连续迟到耗尽、首次超时及一次 advance 跨多个 tick，断言每 tick 只走一次。
- [x] 3.4 完成 stale_state、奖励变化、非法反向、前置未执行、碰撞、停止与终局的计划清理；验证新主动作失效仍可用旧备用、第一步吃苹果不自动丢备用、备用错误正常碰撞、没有按规则替模型另选方向。
- [x] 3.5 将计划和逐步回执、覆盖/取消事件、动作来源及实际收件时间纳入事务；通过写入故障注入验证无部分确认/广播，并验证第一步 applied/第二步 superseded 的重发结果、终局后收件时间和 restart 取消而非续跑。

## 4. runner 滚动补充与关闭入口

- [x] 4.1 添加 `--decision-mode`，默认 two_step_fallback，保留 `--tick-ms` 原默认；创建前校验 v2 能力并打印模式，验证 single_step 关闭、无效模式/旧服务拒绝开局、创建配置与日志一致。
- [x] 4.2 接入两步请求及 v2 提交/回执，保持一次一个在途请求、每实际 tick 至多一次、实际移动后重新取 context；集成验证请求等待期间备用自动生效、迟到新计划整份拒绝、消费备用后从真实新位置恢复请求。
- [x] 4.3 更新 `tests/jev-runner.test.ts` 的外部传输 fixture，明确区分单步与双步用例；验证真实 HTTP/WS/SQLite 链路上的前一请求快速、下一请求延迟，以及 HTTP/解析错误、Ctrl+C、终局取消和错误竞态，没有假成功或错误吞掉。

## 5. 观战、回放与来源解释

- [x] 5.1 更新 `Scene.tsx`、`LivePage.tsx`，把 lastAppliedAction 与最新待执行计划分开展示，显示三种来源和计划方向对；验证接纳 B 后当前移动仍归属 A、coast 不展示残留决策为已执行、单步旧记录显示正常。
- [x] 5.2 更新 `DecisionInput.tsx`，按实际动作 requestId/stepIndex 关联原请求，展示两步目标/结果和原始联合概率，支持另选迟到计划与复制 JSON；验证备用 A 与迟到 B 相邻时不串数据，旧预判/缺正文仍有准确提示。
- [x] 5.3 更新 `ReplayPage.tsx`、`api.ts`、`replay.ts` 的事件名称、关键事件与统计；通过 `tests/replay.test.ts` 验证覆盖/取消等同 tick 事件不增加移动步数，重放无模型请求或随机生成，唯一请求数不因两步使用翻倍。
- [x] 5.4 在 `tests/ws.test.ts` 验证 v2 控制鉴权、持久化后有序推送与断线续读，游客不能提交计划；核对公开状态及事件不包含控制 token、认证头或其他密钥。

## 6. 联调、验收与文档

- [x] 6.1 运行相关 `vitest` 用例及全套 `npm run test:snake`、`npm run typecheck`、改动区域 Biome、`npm run build`；记录命令和真实结果，失败先定位原因，不跳过旧模式兼容用例。
- [x] 6.2 用显式 OpenRouter 配置完成 500ms 真实两步对局和 single_step 关闭检查；保存 matchId、真实请求/响应结构、请求延迟分布、迟到/备用/直行次数、碰撞来源和最终结果到验收记录。若自然运行未出现备用，明确记为未观测，该分支由确定性延迟集成用例证明，不用测试传输冒充真实模型。
- [x] 6.3 按 AGENTS.md 先读取 `agent-browser --help`，用本任务独立命名 session 检查实时观战和回放的主动作、备用、覆盖、直行、迟到与旧记录；快照与必要截图保存到 `.data/qa/`，核对页面显示与持久事件一致。
- [x] 6.4 更新 `README.md` 的两步时序、模式关闭命令、v1/v2 边界和指标含义，并在本变更添加 `validation.md` 记录实际验证结果；逐项对照本变更五份 spec，标明未观测项，文档只描述已实现且已核对的行为。
