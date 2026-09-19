## 1. 配置与历史协议分离

- [x] 1.1 在 `shared/snake/types.ts`、`schema.ts` 区分新建响应单步配置与可读历史配置，省略新建模式时明确保存 response/single_step/null；用 schema/API 测试验证默认值、显式同值、旧模式/数值间隔拒绝以及旧历史解析不变。
- [x] 1.2 收敛 `server/jev/game-config.ts` 和 `scripts/run-jev.ts` 的参数/环境校验，保留 response/single_step 同值声明，拒绝 fixed/two_step_fallback/显式步长，遗留 SNAKE_TICK_MS 仅提示弃用（含 fork 路径）；用 CLI 测试验证错误发生在创建和模型请求之前。
- [x] 1.3 为既有 v1 固定单步、v2 两步、v3 响应及未完成计划保存可复现的历史 fixture，保留原始配置、请求 hash 与回执；通过旧记录读取、原文一致及去重测试验证 fixture，不通过新生产入口创建旧模式。

## 2. 唯一服务端移动路径

- [x] 2.1 修改 `server/matches/service.ts` 的创建与控制边界，既有相同请求只返回原回执，新请求仅允许响应单步；更新 `server/app.ts` 能力声明为 `[1]`，用 HTTP/WS 测试验证旧模式创建、新 v2/plan、旧 ready start 被拒且无移动，旧请求冲突和幂等语义保留。
- [x] 2.2 删除固定 tick 调度/补跑、`advancePlan`、计划接纳及直行执行路径，保留单步原子移动和独立星星到期计时；以 response 测试验证等待十秒不动、不均匀到达、到期优先、致命碰撞只尝试一步及持久化失败不确认成功。
- [x] 2.3 将旧计划取消清理与执行分离，调整 `server/start.ts` 和频道停止清理，确保旧 running 重启中断、旧 ready 可停止但不可运行；通过混合旧库重启/关闭测试验证追加 cancelled/server_restart、无补步、无新计划执行。
- [x] 2.4 收敛公开计时和动作来源，明确 null 截止/固定间隔、单步 primary 来源及真实间隔；用服务端测试验证重复请求不移动、同观察竞争、过时摘要、非法反向和终局后真实收件时间。

## 3. Runner 与模型输入

- [x] 3.1 将 `runJevMatch` 改为唯一 `askJev` 串行闭环，删除 fixed 等待和两步模型分派；用 `tests/jev-runner.test.ts` 验证最多一个在途、applied 后立即新观察、慢响应等待不动、stale_state/invalid_direction 重新读取及其他错误明确退出。
- [x] 3.2 删除生产两步请求入口并隔离仅供历史/离线使用的构建辅助，保留 action-facts-v4、positive-v1、progress-v1 和四方向自主选择；用 context/witness/progress/loop-prompt 测试验证事实、选项、原始概率、正文、字节数与耗时语义未退化。
- [x] 3.3 更新 `scripts/evaluate-context.ts` 与 `scripts/evaluate-positive-context.ts`，真实评估只运行响应单步、旧模式仅用已标注离线 fixture；通过对应评估测试和一次离线输出验证没有真实两步调用路径或虚构 usage。

## 4. 历史读取与响应续跑

- [x] 4.1 限制新的 fork 仅接受原响应单步记录，CLI/API 对旧 fixed/两步明确返回 mode_retired 且无写入；通过 fork/fork-api 测试验证拒绝、终局校验和重复请求仍幂等。
- [x] 4.2 保留响应分支的原配置、RNG、布局/配色、进度与上一移动时间恢复；通过 restore/fork 测试验证再次续跑、下一随机食物、停机时间不计入及源历史不变，不新增记录/数据库版本。

## 5. 频道与展示

- [x] 5.1 连续频道首局和后续局统一使用新配置，保留启停意图、五秒局间倒计时、故障和清理语义；把 `tests/watch-channel.test.ts` 的固定时间死亡 fixture 改为真实单步动作，验证连续两局、等待中停止续局、无观众、配置错误及重启恢复。
- [x] 5.2 核对并按需调整 `Scene.tsx`、`LiveMatch.tsx`、`DecisionInput.tsx` 等新局展示，只呈现响应等待和实测步频，历史记录继续显示原速度/备用/联合概率；通过展示测试及浏览器观察验证正常等待与断线可区分、新局无备用或固定移动提示。
- [x] 5.3 保留 `HistoryPage.tsx`、`ReplayPage.tsx` 和 `replay.ts` 对旧三种记录及响应续跑的展示；用 replay/fork-replay 测试验证原模式、默认续跑定位、原文、调用计数和无伪造 coast。
- [x] 5.4 更新 README 与 `.env.example` 的默认命令、废弃配置迁移、旧历史边界及回退说明，保留历史验收原文；通过文档搜索确认当前能力不再宣称 fixed/两步可运行，并确认真实 `.env` 未被修改。

## 6. 集成验收与范围检查

- [x] 6.1 运行响应、runner、频道、HTTP/WS、fork/restore/replay 和上下文相关测试，随后运行 `npm test`、`npm run typecheck`、`npm run check`、`npm run build`；记录实际结果，既有无关失败单独标识，不把跳过或 mock 响应写成真实模型验收。
- [x] 6.2 先读 `agent-browser --help`，用独立命名 session 在隔离数据下验证默认观战、响应等待、连续两局、旧历史和响应分支回放；每次操作前 snapshot、操作后核对结果并按需截图，验收记录写入本 change 的 validation.md。
- [x] 6.3 在可用真实凭证下进行响应单步冒烟，保存实际请求/动作对应关系和模式配置，验证没有计划或 coast/fallback 新移动；正常终局或明确人工停止即可，不以全盘通关作为模式收敛条件，不新增自动结束规则，无法执行则记录真实限制。
- [x] 6.4 审核 `git diff`、旧模式符号剩余引用及 `openspec validate retain-response-single-step --strict`，确认剩余引用只服务于旧历史、清理、离线 fixture 或显式拒绝；保留已有布局/配色工作，仅交付本次范围并记录验证证据。
