# 正向证据验收

日期：2026-09-20。

## 已实现

- action-facts-v4 提供四方向对称的正向机会，完整方向序列单独存入 decision.evidence，不发送给 provider；JEV 返回方向原样提交。
- 静态候选验证、完整有序身体动态 DFS、无增长完整循环、身体格释放与实际进入时序；没有搜索深度/节点/耗时截断。
- opportunity.postEat 来自同一条见证的实际增长端点，新奖励保持未知。
- 跨步信息只断言当前几何与旧见证某一步相容，不把汇合路径当成真实前缀，不推断模型意图；相容旧记录随档案保留并去重。
- 回放展示正向机会、完整后台见证、增长端点与跨步说明。旧 v3/已保存早期v4正文保持原样读取，不补写旧 postEat/历史字段。
- 生产沿用项目当前 response/single_step，旧两步仅离线历史兼容，没有恢复自动备用或程序代选。

## 验证

- npm test：33 文件 / 296 项通过。
- npm run typecheck、npm run check（oxfmt/oxlint）、npm run build 通过。
- 529dd 第649步原始几何：up找到21步动态苹果路线，真实move逐步复验；第11步进入(11,6)，恰好满足原身体格最快释放时间。right完整穷尽37状态、down67状态，无苹果或无增长循环；不宣称21步为最短，也不宣称随后必胜。
- 独立浏览器session snake-v4-implementation、隔离Vite预览3083，直接渲染实际 OpportunityEvidence 组件。4方向展示、展开路线、增长后3出口/47静态格、释放时间、后台JSON均核对；无页面错误、无横向溢出。此为固定历史几何UI验收，不是新对局。原3000端口未运行，未改动用户原服务。

## 成本（本机10次样本）

输入字节仅为实际provider正文，档案字节单列；构建成本没有实时上界保证。

| fixture | v3字节 | v4字节 | v4构建p50 ms | p95 ms | 档案字节 |
| --- | ---: | ---: | ---: | ---: | ---: |
| opening | 4261 | 6342 | 3.180 | 6.469 | 2235 |
| corridor | 5314 | 5543 | 1.211 | 1.894 | 1590 |
| nearComplete | 3690 | 5321 | 0.019 | 0.023 | 642 |
| release_trap_529dd | 5390 | 6241 | 2.467 | 2.834 | 2815 |

## 真实固定局面对照

沿用 OpenRouter / typesafe/jev-1.13，4个fixture各v3/v4一次，共8次，全部返回成功；未重试挑选结果，未创建或改写对局。fixture只复用历史几何，测试metadata不冒充原始历史请求。

| fixture | 版本 | 选择 | requestMs |
| --- | --- | --- | ---: |
| opening | v3 | right | 1008.9 |
| opening | v4 | right | 352.4 |
| corridor | v3 | right | 305.3 |
| corridor | v4 | right | 298.1 |
| nearComplete | v3 | right | 358.5 |
| nearComplete | v4 | right | 326.5 |
| release_trap_529dd | v3 | up | 311.7 |
| release_trap_529dd | v4 | up | 296.7 |

四个fixture的新旧选择一致，不能据此声称胜率提升；首个网络请求包含额外冷启动影响，也不能声称v4使模型变快。本轮未跑新的整局通关率实验。

## 证据

- .data/qa/context-v4/live.json：真实输入、原始输出、usage、字节和构建耗时。
- .data/qa/context-v4/positive-evidence-ui.png：实际组件固定局面展示。
- tests/positive-evidence.test.ts、tests/witness-context.test.ts、tests/witness-continuity.test.ts、tests/evaluate-positive-context.test.ts。
