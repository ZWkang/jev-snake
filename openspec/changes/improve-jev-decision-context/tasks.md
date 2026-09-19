## 1. 固定可复用基线与版本契约

- [x] 1.1 将现有 tick 364、开局、近满盘测试局面整理为共享 fixture，保存改造前单步/两步 v2 请求及无版本/v1 历史正文；验证 fixture 无凭证、不依赖本机 SQLite，现有 context/jev 测试仍通过。
- [x] 1.2 在 `shared/snake/types.ts` 定义历史/v3 请求 union、完整动作摘要、未知第二步分支和可选 contextBuildMs/requestBytes；按 design 的状态/字段表核对 null 与不适用语义，运行 typecheck 验证调用点。
- [x] 1.3 在 `shared/snake/schema.ts` 贯通单步/两步 request、decision 与控制信封；增加无版本/v1/v2/v3 接受、v3 缺项/未知版本拒绝的契约测试，验证十六 pair 与四方向完整性。

## 2. 动作后果分析

- [x] 2.1 基于 `inspectMove` 实现只读几何推进、冻结占据图与空间/头尾连通性；保留现有 forcedPath，验证 tick 364 左 7 步碰撞、右分叉、移动尾巴和循环结果，以及输入 state/RNG 不变。
- [x] 2.2 实现苹果冻结 BFS、确定的等长选择、逐步身体验证、增长后的出口/空间与 terminal；测试绕障、no_static_path、直接吃、吃后无出口和最后一格胜利，交叉核对真实引擎移动。
- [x] 2.3 实现星星不经过苹果的候选路线及 fixed/response 时效信息；测试 TTL 相等视为赶不上、deadline 缺失/已过、第二步 analysisOffset=1、response 时间未知和几何接触不等于实际得分。
- [x] 2.4 统一两步条件分析，第一步碰撞/胜利不执行第二步，第一步增长只保留可确定的第二步碰撞，第一步触及星星不重复计入；测试不同第一步身体、未知增长、距离起点和 RNG 不变。

## 3. 构建并发送 v3 context

- [x] 3.1 更新 `decisionBody` 的精简 state、单份结构化 criteria 和生存优先指令；验证四选项保留、无全量 bodyHeadToTail/障碍坐标/重复 actionFacts，并用 fixture 核对摘要来源于真实观察。
- [x] 3.2 更新 `planBody` 为共享 firstActions 与结构化 pair criteria，使用显式 secondStatus；验证十六选项、关联两步、已知/未知分支和 response 仍拒绝两步。
- [x] 3.3 在 client 构建边界测 contextBuildMs，按实际发送 JSON 测 requestBytes，贯通 runner 日志与 decision 保存；测试传输正文等于保存正文、字节数准确、不泄露凭证，以及 API 失败/0.99 概率行为不变。
- [x] 3.4 更新 runner/WS/SQLite 集成测试中旧全坐标假设，同时保留旧 fixture 兼容断言；验证 fixed 单步/两步和 response 的单在途、原目标不重绑、备用/直行来源及拒绝/错误处理。

## 4. 回放与评估入口

- [x] 4.1 在 `DecisionInput.tsx` 展示 context 版本、已记录构建耗时与请求字节数，增加静态证据与概率含义说明；通过回放测试核对旧/新/未知版本、缺失诊断及复制正文均不重算历史。
- [x] 4.2 新增 `scripts/evaluate-context.ts`，默认离线输出共享 fixtures 的 v2/v3 大小与本地构建成本，`--live` 显式启用同局面真实请求；验证默认无外部调用、报告含样本数/provider/model/原文/错误，真实结果与离线检查分开标识。
- [x] 4.3 更新 README 的 context 含义、版本、评估命令和兼容部署/回滚说明；核对文档命令实际可执行，明确静态路径与整局获胜的区别。

## 5. 集成验收与真实证据

- [x] 5.1 运行 `npm run test:snake`、`npm run typecheck`、针对实际修改 TS/TSX 的 `npx biome check`、`npm run build`；所有必需检查通过，结果记录本 change 的 `validation.md`，不将 ignored 当 lint 通过。
- [x] 5.2 运行离线评估，记录三类 fixture、单步/两步的字节变化和 contextBuildMs p50/p95；核对 v3 无随身体增长的坐标列表，并说明计算成本相对 500ms 截止的实际影响，不添加运行时截断。
- [x] 5.3 用已配置 provider 串行完成 design 的 12 次真实 fixture 请求对照，保留输入/输出和选择错误；核对 tick 364 是否避开已证实死路，若模型仍选错明确标记效果未通过，不以契约测试代替结果。
- [x] 5.4 用同一 `context-v3-eval-01` seed 顺序完成 response 单步、fixed 500ms 单步、fixed 500ms 两步的三场真实 runner 验收；记录 matchId、模式、终局/中断、得分、苹果、步数、请求延迟及动作来源，未终局不得写为已完成，不加限步或改换模型。
- [x] 5.5 按 `agent-browser --help` 使用独立 session 验证至少一条旧局和新局的决策版本、原始 JSON、复制和棋盘定位；保存 snapshot/必要截图至 `.data/qa/context-v3/`，在 validation.md 分别报告代码正确性、输入成本与真实模型表现。
