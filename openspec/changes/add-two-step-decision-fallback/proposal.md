## Why

500ms 对局 `3e98b0a9-df25-4731-85b8-d3221fcbd267` 的最后两次向右决策分别耗时约 835ms、597ms，均未及时生效，蛇连续沿原方向移动并撞墙。用户希望每次推断两个连续方向：下一轮结果及时返回时优先采用新决策，迟到时由上一轮预留的第二步兜底，并接受备用预测可能不准确。

## What Changes

- 增加显式的 `two_step_fallback` 模式：一次真实模型请求生成两步有先后关系的计划，第一步绑定观察 tick + 1，第二步绑定观察 tick + 2。
- 服务端提前持久保存备用动作，在移动截止点按“有效的新决策 → 上一轮已具备执行条件的备用动作 → 现有方向”选择，游戏保持固定节拍；不等迟到响应回来才补发备用。
- 备用仅在所属计划第一步实际生效后可用，限定原始目标 tick、只消费一次；旧结果不得改绑目标，首次请求迟到和备用耗尽不会虚构后续动作。
- 备用容忍预测奖励信息过时；不增加寻路、避碰代打或按概率改选方向。墙、障碍、身体碰撞仍由原游戏规则正常判定。
- runner 默认使用两步模式，提供 `--decision-mode single_step` 显式关闭；配置随新局保存，既有对局与旧单步客户端保留原语义。
- 增加计划及逐步接纳、应用、覆盖、失效、耗尽记录；观战和回放展示“最新决策 / 上轮备用 / 沿原方向”，关联同一次模型请求，不把备用消费算成新调用。
- 增加版本化计划协议和双版本记录读取；保留密钥隔离、真实错误暴露、事务提交后确认及重启中断规则。

## Capabilities

### New Capabilities

无独立新业务模块。

### Modified Capabilities

- `snake-jev-runner`：一次请求生成条件相关的两步计划、实际局面驱动补充请求、显式模式切换与真实错误处理。
- `snake-gameplay`：双步模式下的新决策优先、备用消费、过期和碰撞语义。
- `snake-server`：版本化计划提交、逐步去重回执、持久备用和移动来源。
- `snake-spectating`：实时展示当前移动来源及计划覆盖情况。
- `snake-match-replay`：还原计划每一步的实际结果与原始请求，兼容旧记录。

当前 `openspec/specs/` 尚无主规格；上述既有 capability 的完整规格位于已完成、未归档的 `add-neobrutalist-snake/specs/`。本变更使用相同路径和 requirement 名称描述 delta；它明确取代旧规格中对两步模式不适用的“禁止多步”和“无新请求必然直行”约束，单步模式保留原约束。归档时需先同步旧变更基线，再应用本 delta；本次规划不修改旧变更或主规格。

## Impact

- 模型输入与解析：`server/jev/client.ts`、`server/jev/context.ts`；共享契约：`shared/snake/types.ts`、`shared/snake/schema.ts`。
- 执行与存储：`scripts/run-jev.ts`、`server/matches/service.ts`、`server/db/store.ts`、`server/app.ts`；引擎继续负责真实碰撞与奖励，预测不得消耗真实 RNG。
- 展示：`src/features/snake/{Scene,DecisionInput,ReplayPage,LivePage}.tsx`、`api.ts`、`replay.ts`。
- 回归：`tests/{jev,jev-runner,game,ws,replay}.test.ts`，以及 500ms 真实模型与浏览器验收；更新 `README.md` 的时序、关闭方式、版本和指标说明。
- 不引入新依赖，不改变默认游戏步长、旧对局数据或服务商选择；两步推断的实际延迟与效果需要测量，不能把旧单步延迟当作新模式性能。
