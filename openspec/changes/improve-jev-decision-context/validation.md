# Context v3 验收记录

日期：2026-09-19。19 项实施任务全部完成，三场真实整局均自然结束，未使用限步或人为停止。

## 实现与确定性验证

- 单步 `action-facts-v3` / 两步 `two-step-plan-v3`，程序计算事实，JEV 保留最终选择。
- 新旧版本显式解析，动态身体、增长、静态空间、候选路线、第二步未知和星星计时已贯通。
- 全量 Vitest：11 文件 / 128 测试通过；TypeScript、18 个修改 TS/TSX 的 Biome、生产构建通过。
- 新评估入口已纳入 server/tsconfig.json 持续类型检查；追加检查和服务端构建通过。
- 回放显示耗时调整为三位小数后，15 项回放测试重新通过，原始诊断与 JSON 不变。
- 独立 agent 对核心几何只读复核：500 个状态、1191 条苹果候选路线、4952 个第二步碰撞与真实引擎一致。

## 离线成本

每种样本 30 次，单位 ms；p50/p95 是本机观测，无运行时截断或保证值。旧 v2 请求为改造前固定 fixture，其几何构建耗时未采集，不用 fixture 加载耗时冒充。

| 局面 | 模式 | v2 字节 | v3 字节 | v3 构建 p50 | p95 |
| --- | --- | ---: | ---: | ---: | ---: |
| opening | single | 3289 | 3896 | 0.990 | 2.337 |
| opening | plan | 5797 | 11868 | 2.919 | 3.099 |
| corridor | single | 3797 | 3528 | 0.274 | 0.359 |
| corridor | plan | 6099 | 8628 | 0.756 | 0.906 |
| nearComplete | single | 3223 | 3291 | 0.003 | 0.003 |
| nearComplete | plan | 5335 | 5282 | 0.009 | 0.013 |

v3 不再携带随身体长度增长的完整坐标列表，单步事实不重复。更丰富的第二步后果使部分两步请求比 v2 更大（开局样本约翻倍）；不能把“动作摘要”理解为所有样本字节都减少。本地最高样本 p95 约 3.1ms，低于 500ms 间隔，但网络延迟仍须分开实测。

## 真实 fixture 请求

使用现有配置 `openrouter` / `typesafe/jev-1.13`，12 次串行请求，0 次 API 错误。没有更换模型或服务商。

| 局面 | 模式 | 版本 | 选择 | 请求 ms |
| --- | --- | --- | --- | ---: |
| opening | single | v2 | right | 1450.5 |
| opening | single | v3 | right | 319.7 |
| opening | plan | v2 | right_right | 307.9 |
| opening | plan | v3 | right_right | 424.8 |
| corridor | single | v2 | right | 313.8 |
| corridor | single | v3 | right | 428.3 |
| corridor | plan | v2 | right_down | 305.9 |
| corridor | plan | v3 | right_right | 329.7 |
| nearComplete | single | v2 | right | 413.5 |
| nearComplete | single | v3 | right | 343.9 |
| nearComplete | plan | v2 | right_right | 322.6 |
| nearComplete | plan | v3 | right_right | 378.8 |

tick 364 的 v3 单步与两步均避开已证实死路。此次 v2 对照也选对，不据此声称 v3 已提升整体胜率。概率合计 0.99 的真实返回仅输出 warning，原始结果仍保存。

## 浏览器

- 使用独立 `agent-browser --session context-v3-qa`。
- 旧局 `899251a7-7e06-4cad-a9ee-d98a860b227b`：seq 734 决策 / 观察 seq 733，显示 action-facts-v1，诊断缺失显示“未记录”；显示正文、复制到系统剪贴板的正文均与保存请求一致。
- 新局 `d6eb8e35-4828-4191-804f-8525055538b3`：seq 2 决策 / 观察 seq 1，显示 action-facts-v3，3977 字节与真实构建耗时；原文和剪贴板均与保存请求一致，没有补回 bodyHeadToTail。
- 已检查新旧截图，无字段溢出；小数显示固定三位。
- CLI select 对数字 option value 返回 values 校验错误，改由该 CLI 的 eval 设置已观察到的原生 select 值并派发 change，再核验真实页面结果；没有修改产品逻辑。
- 修改 tsconfig/构建期间 Vite 热重载出现 RouterProvider 临时错误，重启本次预览进程后恢复，重新完成浏览器检查。游戏服务未因此停止。

## 真实整局

三场按方案顺序运行，相同 seed `context-v3-eval-01`、24×18 / 12 障碍，当前 provider 为 OpenRouter。三场 runner 均退出 0，全部真实 gameover。

| 模式 | 步数 | 分数 | 苹果 | 结束原因 | 主动作 / 备用 / 直行 |
| --- | ---: | ---: | ---: | --- | --- |
| response | 1199 | 750 | 63 | self | 1199 / 0 / 0 |
| fixed-single | 134 | 70 | 7 | wall | 121 / 0 / 13 |
| fixed-plan | 393 | 30 | 3 | wall | 366 / 14 / 13 |

| 模式 | 返回请求数 | requestMs p50 / p95 | contextBuildMs p50 / p95 / max | 请求字节 p50 | 拒绝 |
| --- | ---: | --- | --- | ---: | --- |
| response | 1208 | 349.6 / 510.9 | 0.977 / 3.791 / 40.991 | 3984 | {"stale_state": 8, "invalid_direction": 1} |
| fixed-single | 128 | 334.6 / 490.1 | 0.808 / 2.980 / 6.319 | 3948 | {"late_action": 6} |
| fixed-plan | 389 | 348.3 / 465.3 | 3.258 / 6.161 / 54.261 | 11679 | {"late_action": 23} |

- 响应局 1199 步全部由有效新响应推进；另有 8 次 stale_state 和 1 次非法反向拒绝，均真实保留，没有补方向。
- 固定单步终局前有未返回请求被按已有规则取消，日志记录等待约 1999ms；已返回请求统计不包含该取消等待，不能据此称所有请求都及时。
- 固定两步实际消费 14 次备用。终局前目标 390、391、392 的三份计划均 late_action，目标 393 的请求在终局时取消，最终按既有耗尽策略直行撞墙。备用无法覆盖连续迟到。
- 两步局曾出现完整身体/方向/苹果/星星一致的 36 步重复局面（例如 tick 335→371），之后 tick 376 又吃到苹果。它有明显绕行，但不是已经证明永远无法脱离的循环。
- 本地构建耗时存在比离线更高的长尾，尤其两步；如表记录实测最大值，不用离线 p95 保证固定截止。
- 三场用于链路与真实行为验收，不是统计胜率实验。没有吃满棋盘，不声称已实现必胜或已证实优于 v2。

对局标识：
- `response`: `d6eb8e35-4828-4191-804f-8525055538b3` — [回放](http://localhost:3000/matches/d6eb8e35-4828-4191-804f-8525055538b3/replay)
- `fixed-single`: `922e48e9-d956-49af-b3e8-16004651dd6b` — [回放](http://localhost:3000/matches/922e48e9-d956-49af-b3e8-16004651dd6b/replay)
- `fixed-plan`: `4054b9ff-6e72-4da2-9e16-eaa063f37ebb` — [回放](http://localhost:3000/matches/4054b9ff-6e72-4da2-9e16-eaa063f37ebb/replay)

## 响应局末段复核

独立 agent 只读核对最后 10 步（目标 tick 1190–1199）：11 次请求正文与对应 observedSeq 局面重算一致，44 个方向碰撞结论与引擎一致。seq 2396 / tick 1189 起仅向左可走，候选苹果路线已标明吃后零出口和蛇尾不连通；seq 2413 / tick 1198 吃苹果后四向不可走。模型先选反向被拒，随后选择已标注撞身体的方向而结束。此末段已经没有可活方向；检查未定位更早进入死路的分叉，不把此结论扩大为整体策略保证。

## 证据路径

- `.data/qa/context-v3/{offline,live}.json`
- `.data/qa/context-v3/{tests,typecheck,biome,build,build-final}.log`
- `.data/qa/context-v3/browser-{old,new}.png` 与对应 verification/snapshot 文件
- `.data/qa/context-v3/game-*.log`、`games-run.json`、`games-summary.json`（完成后更新）

这些本地证据含真实请求/输出，不含凭证；`.data/` 沿用现有 Git 忽略。没有数据库迁移，没有重写旧局，没有新增自动代选、重试或限步。
