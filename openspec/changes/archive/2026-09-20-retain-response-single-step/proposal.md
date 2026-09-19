## Why

当前系统维护固定单步、固定两步备用和随响应单步三种运行组合，而产品现在只需要“模型返回有效决策后走一步”。统一运行方式可删除固定移动调度、两步预测和备用裁决，让每次移动都直接对应一次真实的单步决策。

## What Changes

- **BREAKING**：CLI、HTTP 创建接口、连续观战和历史分支续跑统一使用 `stepMode=response`、`decisionMode=single_step`、`tickIntervalMs=null`；不再创建或启动固定步频、两步备用对局。
- 新局默认即为响应单步。保留显式 `--step-mode response`、`--decision-mode single_step` 作为同值声明；显式 fixed、two_step_fallback 和固定步长参数明确报错；遗留 SNAKE_TICK_MS 环境变量可见提示已弃用但不阻断响应模式，不静默忽略或改选。
- 删除生产运行链路的固定 tick 移动、迟到直行、两步模型请求、计划排队及备用执行。保留单在途请求、动作原子提交、去重、奖励按真实时间到期和明确失败。
- 保留当前 `action-facts-v4` 单步事实、正向路线证据和真实进度历史，仍由 JEV 自主选择四方向，不增加规则代选、等待超时或自动直行。
- 保留旧固定/两步历史的原始配置、请求、时间和回放语义。只允许原响应单步局续跑，完整继承其配置、几何、RNG、分数与历史；旧 fixed/两步局续跑明确拒绝，不新增模式转换或记录版本。
- 连续观战只产生响应单步新局；当前观战只呈现这一运行方式，历史页面继续准确标注旧模式。

## Capabilities

### New Capabilities

无；在已有能力中收敛运行契约。

### Modified Capabilities

- `snake-jev-runner`：唯一响应单步配置、串行模型循环、单步上下文和 CLI/频道共用运行能力。
- `snake-server`：新局创建与控制仅支持响应单步，旧记录只读兼容、响应单步续跑、重启清理及真实时间语义。
- `snake-continuous-watch`：首局和后续局统一响应单步，旧配置显式失败，保留局间倒计时和启停生命周期。
- `snake-spectating`：新局显示响应等待与实测步频，旧历史仍按原模式和动作来源呈现。

## Impact

- 运行入口：`scripts/run-jev.ts`、`server/jev/game-config.ts`、`server/jev/runner.ts`、`server/jev/client.ts`、`server/watch/channel.ts`、`server/start.ts`。
- 共享协议与服务：`shared/snake/{types,schema,context-schema,context-v4-schema}.ts`、`server/app.ts`、`server/matches/{service,restore}.ts`、`server/game/engine.ts`、`server/db/store.ts`。需区分新建/实时控制校验与旧历史解析，不能直接删除历史所需类型。
- 展示和工具：观战、决策面板、历史、回放，现有 context 评估脚本，`.env.example` 与 README。无新增服务商、依赖或游戏规则。
- 验证：响应模式、真实 HTTP/WS/SQLite 链路、runner、频道、续跑、恢复和回放测试；淘汰将 fixed/two-step 当作可运行能力的测试，保留历史兼容 fixture。
- 规范冲突：主规范仍要求 fixed 默认及两步能力，本 change 明确替代这些要求。较早 change 的 gameplay/history/replay 文档未成为独立主规范，本次不修改其历史文件；新边界写入上述现有 capability 的 delta。
- 实施保留已有出生布局、配色及 layoutVersion 行为，不改动无关功能。
