# 重复路线与吃后退路修复验收

日期：2026-09-19。修复目标是让模型看见真实无进展循环，并保留明确危险优先级；不添加循环自动结束、限步、自动代选或模型切换。

## 原始问题

- 对局 `07ac9584-eec1-4a25-9ce7-6f4d7ce2fd07` 在 tick 103 后未再吃苹果，完整蛇身/朝向/食物从 tick 116 起每 24 步重复。
- tick 119/143/167 蛇头 `(1,1)`、苹果 `(1,0)`：向上能吃、吃后两条合法出口且尾巴连通，原 JEV 反复向右。
- 用户授权修复后，以原 runner 的正常 stop 通道结束空转，保存为 tick 1341 / 280 分 / interrupted / controller_stop，没有改写成游戏胜负。

## 最终实现

- `ProgressHistory` 从服务端已提交事件增量构建，绑定观察 seq/tick；key包括完整有序身体、朝向、棋盘/障碍及奖励，不含时钟与请求ID。
- 保存同局面访问次数、重复间隔、距上次苹果步数、各方向真实执行及随后无苹果返回次数。排队/拒绝/等待不算移动，备用与直行按真实执行计入；增长重置苹果周期，终局清缓存。
- `state.progress` 带 `historyVersion: progress-v1`，旧无字段 v3 仍可读，新 runner 缺历史或 tick 错配明确失败。
- 每个候选的 `danger` 直接呈现即时碰撞或充分证明的必死结论；`null` 仅表示没有已知死亡证明，不能当保证安全。已有证明的算法和新证明均不读未来 RNG。
- 只有实际出现“离开后又无苹果返回”时才强化破圈指令；危险判定先于食物与破圈，模型仍自己选择方向。
- 补充吃苹果后的充分证明：假设未来完全不再增长，若乐观身体也只剩一条最终撞死的通道，真实增长仅保留更多身体格，不会打开出口。只有剩余空格多于撞死前可成功移动数时才作死亡判定，排除先填满获胜。返回碰撞上界；原 forcedPath 的 unknown_after_apple/steps 语义不被篡改。

## 过程中暴露并修复的两类退化

- 第一轮 `7c3221ba-ef6b-48f5-b462-d289c410f6cc`：72 步、180 分。tick 70 的必死苹果证明埋在长提示词中，模型仍选择吃；已改为每个选项直接携带 danger，且仅有实际循环证据时强调破圈。
- 第二轮 `fd1614b1-ba1e-4fdc-9d61-2891049f52c7`：187 步、250 分。tick 183 吃苹果后唯一通道最迟 3 步碰撞，原分析因随机新苹果未知而漏判；新充分证明明确把 down 标为 proven_fatal，left 仍为 null。
- 上述失败记录均保留，不以“对局能结束”冒充修复成功。

## 真实模型回归

沿用当前 OpenRouter / typesafe/jev-1.13。最终 11 次真实请求均通过；完整请求/响应保存在 `.data/qa/loop-fix/probe-explore.json`，此前各轮输出也保留，不以反复重试掩盖失败。

| 固定观察局面 | 实际选择 | 关键概率 | 结果 |
| --- | --- | ---: | --- | --- |
| loop-119 | up | 80% | 通过 |
| loop-143 | up | 96% | 通过 |
| loop-167 | up | 94% | 通过 |
| fatal-apple-70-0 | left | 97% | 通过 |
| fatal-apple-70-1 | left | 97% | 通过 |
| post-apple-death-183-0 | left | 96% | 通过 |
| post-apple-death-183-1 | left | 95% | 通过 |
| no-static-route-loop-848-0 | right | 75% | 通过 |
| no-static-route-loop-848-1 | right | 78% | 通过 |
| board-complete | right | 99% | 通过 |
| board-complete-plan | right_right | 72% | 通过 |

新增的无静态路径场景：tick 848 向上已无苹果返回 17 次，向右从未尝试，两者 danger=null 且都无静态食物路线。新输入两次均选择向右。

连续验证：从该真实记录局面开始，使用真实 JEV 返回方向，按共享游戏几何规则逐步推进并更新历史，8 步序列为右、上、左、上、右、上、左、左，吃到原来 `(4,1)` 的苹果。8 步均无即时碰撞或已证实死亡，吃后仍有一个合法出口、尾巴连通。该验证是带真实模型的历史几何推演，不是伪装成完整持久化对局；到已观察苹果时即结束验证，不猜测下一次随机食物。证据 `.data/qa/loop-fix/trace-explore.json`，该8步路径已加入单元回归。

## 自动验证

- 全量：全量测试与连续路径回归全部通过，最终全量198项测试通过（17个文件）。
- TypeScript 与生产构建通过；按当前仓库配置执行 oxfmt / oxlint，本次 17 个 TS/TSX 文件通过。执行期间仓库从 Biome 迁移至 Ox 工具，本修复沿用当前配置，没有恢复旧依赖。
- 覆盖真实 24 步循环、同 tick 去重、增长重置、缺历史拒绝、分页缓存、fixed/response 与备用/直行、原选择不代换、旧正文兼容。
- 新证明覆盖真实 tick 183 的所有增长/不增长组合、允许提前吃满获胜、分叉/循环无证明、RNG 禁止读取及状态不变；另由独立 agent 复核占据集合和胜利边界。

## 同图对局与最新状态

第三轮 `7ddc8a56-0ae5-4ad2-9e36-e11d212d55ff` 到27个苹果后形成新的32步循环。根因是此前只在有食物路线时鼓励破圈，没有要求在“都无静态路径”时改变身体排列；该局已正常停止并保留回放。

最终提示词补上：仅在有实际重复证据时，在 danger=null 选项内优先尝试未走过的出口；都尝试过后比较无苹果返回次数、实际执行次数。该策略仍由 JEV 作选择，不剔除选项或代选动作。

新对局 `a9eab03e-45cf-434a-bda2-2e9fcf5caf35` 使用同一7×5/1障碍/response单步/seed。已自然通关：653步 / 450分 / 30个苹果，蛇长34，等于35个格子减1个障碍。服务端终局为 `won / board_complete`，由真实移动吃满触发，未以限步、人工停止或模拟成功替代。此单局结果不代表任意地图必胜。

[完整回放](http://localhost:3000/matches/a9eab03e-45cf-434a-bda2-2e9fcf5caf35/replay)。证据：`.data/qa/loop-fix/won-summary.json`、`won-events.json`、`same-seed-explore.log` 和 `won.png`。


## 证据

- 单元 fixture：`tests/fixtures/loop-replay.json`、`loop-regression-death.json`、`post-growth-loop-regression.json`，均来自真实保存局面，不含凭证。
- `.data/qa/loop-fix/{probe,probe-balanced,probe-final}.json` 保留各轮真实请求。
- `.data/qa/loop-fix/tests-delivery.log`、`typecheck-explore.log`、`build-explore.log`。
- `.data/qa/loop-fix/same-seed-explore.log` 记录最新整局，其他同名日志保留此前失败。
