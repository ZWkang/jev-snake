# 历史模型上下文与评估

本文保留旧版 README 中的实验说明、评估命令和验收索引，描述各版本当时的行为。当前实时请求见 [V16 模型输入](jev-compact-growth.md)，运行方式见 [运行与部署](running.md)。

离线测试和少量真实请求对照均不代表整局胜率；带 `--live` 的命令会实际调用服务商并产生费用。

## 历史搜索实验与回放

v6 原始坐标构造器位于 `server/jev/board-context.ts`。v7 本步事实、v8 当前连通区域、v9 有预算前瞻、v10 吃后乐观检查构造器已隔离到 `server/jev/search-context.ts`，只供显式离线实验，不从实时 client 重新导出。旧 v3/v4/v5 无界分析构造器仍位于 `server/jev/analysis-context.ts`。

旧 v10 在总节点预算内检查吃果后的无增长乐观路径，不能保证真实未来安全；旧 v9 只查看立即出口。所有旧版本按当时保存的正文读取，不补入新版本字段。历史比较脚本仍可显式运行，但不代表当前模型自主规划链路：

```sh
bun scripts/evaluate-local-search.ts --live --baseline v9 --layout-version 3 --seeds bounded-search-a,bounded-search-b --steps 350
```

这个脚本仅比较历史 v8/v9 与 v10，使用独立的离线搜索配置；不会切换实时观战。评估调用观察窗口结束时未完成的局标为 `censored`，不算赢或输。API/格式错误单列并返回非零退出码，不隐藏重试。比较通关率须单列未完和调用失败，不能用吃果数量代替通关。

以下说明和验收链接同样描述历史方案。

## 历史完整后果 context（v5）

历史单步请求使用 `action-outcomes-v5`，四个方向保持完整、固定顺序，由 JEV 自主选择。每个选项将 `summary`（完整事实句）、`survival`（这个方向全部续路的结果）和 `appleRoute.postApple`（一条具体进食路线的增长端点）放在一起；能吃到苹果不等于该方向能够通关。

- `survival` 区分非法反向、当前碰撞、立即满盘、所有续路已证必死、尚未证明必死。碰撞上界包含候选动作和致死尝试；非法反向不执行移动，没有死亡上界。
- `appleRoute` 只保留一条已验证的动态/静态候选，不再同时发送 v4 的静态 `appleRoute` 与动态 `opportunity`。吃后的死亡上界同时给出“从吃后起算”和“从当前观察起算”，不会把一条路线端点必死扩大为同方向的所有续路必死。
- 若该方向整体未证必死、但初始苹果路线吃后已证必死，会继续搜索其他身体排列下的苹果终点。找到不同终点后重新生成全部路线事实；否则明确报告完整搜索耗尽。`appleAlternativeSearch` 为可选的搜索来源字段，兼容早期 v5；未证必死仍不保证长期安全。初始和替代见证都保留供回放核验。
- `noGrowthCycle` 与 `bodyReleasePassages` 保留其条件范围；循环不代表获得苹果，未知不代表安全。
- v5 请求移除了 `witnessContinuity` 和它的 `nextDirection`，只保留实际提交历史 `progress`；不会将程序发现的旧路线作为下一动作暗示。完整见证仍存入 `decision.evidence`，不发给 provider。
- 所有方向均可由模型选择，包括已证明危险的方向；程序不重排、不过滤、不代选，也不重试挑选满意答案。

旧 v3/v4 原始请求仍可读取；离线评估显式使用 `decisionBodyV3`、`buildDecisionContextV4` 和 `buildDecisionContextV5`，不会重写已保存对局。回放按实际版本显示摘要和作用范围，复制内容仍是实际 provider 请求。

```sh
# 固定局面对照；默认离线。历史失败局保留原始v4请求和旧方向引用。
bun scripts/evaluate-outcome-context.ts --out .data/qa/outcome-context-v5/offline.json
# 显式真实对照：5局面×2版本×3轮，预定30次，所有结果保留、不提交游戏。
bun scripts/evaluate-outcome-context.ts --live --repeats 3 --out .data/qa/outcome-context-v5/live.json
```

验证记录见 [v5 后果表达修复](../openspec/changes/fix-jev-outcome-presentation/validation.md)。固定局面选择改善与整局成绩分开统计。

## 历史动作事实 context（v3 / v4）

此前的 v4 请求使用 `action-facts-v4`，以下描述其历史语义。程序计算动作后果和已验证的机会，JEV 在完整四方向中自主选择，不按分数、概率或启发式改选。单步摘要只在 `questions.direction.criteria` 保存一份；`progress-v1` 历史与正向摘要发给模型，完整 `positive-v1` 路线保存在 `decision.evidence`，不发送给模型；不生成第二步问题或计划。请求保留必要局面与真实计时，完整棋盘仍在 observedSeq 对应事件中。旧两步 context 仅供历史读取与离线对照。

身体与固定障碍共同参与碰撞分析，非增长时尾巴离开原格，吃苹果时尾巴保留；分析与真实移动共用 `inspectMove` 规则，不改变原状态或 RNG。

| 摘要 | 含义与边界 |
| --- | --- |
| `danger` | 每个选项的直接危险结论：`immediate_collision` 为即时碰撞/非法反向，`proven_fatal` 为强制撞死、已证实陷阱、所有出口都有死亡证书的分叉，或吃苹果后即使不再增长仍必撞的局面，`null` 仅表示尚无死亡证明。标签描述证据，不用于过滤选项或替模型改选。旧 v3 没有该字段时不补算。 |
| `immediateCollision` / `forcedPath` | 即时碰撞与动态强制通道。后续仅有一个合法方向时推进副本，直到碰撞、分叉、完整身体与朝向重复、吃苹果或完成棋盘。`steps` 包含候选动作和最后的碰撞尝试；`branch` 不保证后续安全，`unknown_after_apple` 不推测新苹果。 |
| `space` | 执行动作后冻结身体的可达格数、身体长度比较、立即合法出口和静态头尾连通性。可达格数包含头、阻塞其余身体含尾巴；头尾连接只把尾格作为终点打开。静态小区域或不连通不证明动态必死。 |
| `appleRoute` / `postEat` | 冻结身体下的一条最短候选路线，再逐步移动身体验证，报告吃后出口、空间与头尾连接。等长路线按固定顺序取一条，`no_static_path` 不表示所有动态路线不存在；该路线吃后无出口也不否定该第一方向的其他路线。填满棋盘标为胜利，不以无出口当失败。 |
| `starRoute` | 不经过当前苹果的星星候选路线、观察时剩余时间及名义到达条件。当前 response 的未来到达时间未知；旧 fixed 历史保留当时按截止计算的到达条件。几何接触不承诺实际得到星星分数。 |

路线距离包含当前候选动作；未来随机奖励不被预测。正向机会是存在见证，不是推荐方向、存活概率或必须遵循的路线。

提示词给出完成棋盘、收集奖励的游戏目标，并解释事实与未知的边界；方向取舍、吃食物时机与探索策略由 JEV 自主决定。静态连通性、一条已验证路线及模型概率均不是存活保证，历史方向对的概率仍属于整个方向对。历史 v4 保留 v3 的候选路线事实并补充正向机会；旧正文和各已支持版本 context 均保持原文可读。

`contextBuildMs` 记录本地分析与请求对象构建耗时，`requestBytes` 记录实际发送正文的 UTF-8 字节数；`requestMs` 单独记录模型调用往返，`inputTokens` 仅使用服务商真实返回值。回放展示保存的版本与成本，旧记录缺少数据显示“未记录”，不重算；未知 context 版本明确提示语义不支持，仍可查看和复制原始 JSON。

吃苹果后先在“未来不再增长”的乐观几何中检查全部合法分支：如果仍有有限死亡证明，额外增长只会占据更多格子。仅当剩余空格数不少于碰撞上界时采用该证明，排除连续增长先填满棋盘获胜的可能。这个证明不读取未来 RNG，不把上界写成精确未来步数；存在可循环路线或尚无完整证明时保持未知。

分叉死亡证据组合强制碰撞、封闭区域、吃后必死和已有单分叉证书。显式栈逐支检查所有待证出口，只有所有合法出口都能证明死亡，才把结论传回入口，给出最迟碰撞步数。当前路径重复、存在真实可循环路线、获胜或未证明的苹果后续时保持未知。已完成的子证明按局面复用，分支汇合不当成循环；没有搜索深度、时间或节点数上限。分析器还动态验证“蛇头到尾部再沿原身体返回”的完整闭环，作为无法判定必死的真实见证，不把路线交给控制器。模型收到入口与首分叉的上界、证书种类和结构计数；摘要同样复用共享子证明的计数，避免重复展开，计数精度溢出明确报错。

## 历史正向路线与跨步相容证据

离线 v4 分析器中，四方向均使用同样的分析流程：先验证静态食物候选，再按有序身体、朝向和已知苹果搜索动态状态。找到当前苹果或完整无增长循环时保存具体路线；全部状态穷尽才报告 exhausted。内部距离仅决定搜索遍历次序，不排序模型的四个动作，不替模型执行路线，也不加搜索深度、节点数或耗时上限。

- `opportunity`：存在见证、路线步数、苹果终点/循环周期、身体格的最快释放步数和路线实际进入步数。找到的路线不宣称最短。
- `opportunity.postEat`：只描述该见证的实际增长终点；不借用另一条静态路线的出口。新苹果位置未知，循环也不等于进食进展或永远安全。
- `state.witnessContinuity`：当前完整几何与先前路线经过 `stateCompatibleAfterMoves` 步的预测相容；不同走法可能汇合，因此不声称真实走过相同前缀，更不代表模型承诺跟随。摘要保留目标与证据范围，相容旧路线一并存档；相同剩余路线按事实去重。
- `decision.evidence`：独立于 provider HTTP body 的完整路线、起始几何和结束几何，用于回放核验。回放原始 JSON/复制仍是实际模型请求，不补入后台档案。

离线及固定局面对照入口：

```sh
bun scripts/evaluate-positive-context.ts --samples 10 --out .data/qa/context-v4/offline.json
# 显式真实请求：4个固定局面，各发送v3/v4一次，共8次；不创建对局、不重试挑结果
bun scripts/evaluate-positive-context.ts --live --out .data/qa/context-v4/live.json
```

报告分别记录 provider 输入字节、后台档案字节、构建时间、真实模型选择与 usage；历史未提供时标为 not_provided。固定局面和本地规则测试不等于整局胜率验证。

## 历史进度上下文与食物进展

这一阶段的 runner 会把服务端提供的 `state.progress`（`historyVersion: progress-v1`）送给 JEV。服务端按当前观察 seq 增量读取已提交事件，记录距上次吃苹果的步数、当前完整局面出现次数、重复间隔，以及各方向实际执行后又回到该局面且没吃苹果的次数。完整局面包括有序蛇身、朝向、棋盘/障碍和可见食物；tick、时钟、分数和请求 ID 不会让同一局面变成新局面。

只有实际移动才记录执行方向，包含旧 fixed 历史中实际执行的备用和直行。同 tick 的等待、请求接纳/拒绝或重新询问不增加移动和重复计数；吃苹果后清空该次无苹果周期的局面统计，旧选择不会污染新食物阶段。缓存从保存的事件构建，终局释放；丢失或不一致历史明确报错。

进展信息只陈述真实历史，不要求“未尝试方向优先”，不按执行次数排序。JEV 根据完整棋盘、规则、目标和这些历史自主选择，该阶段的 V13 仅提供本步合法方向，返回选择原样提交。重复记录帮助模型看到已经发生的绕圈，不保证模型一定会改变路径。

这一阶段的单步使用已提交历史；旧两步历史仍只代表实际执行事实。历史旧 v3 正文没有 progress 时仍可读取，不补写零值；当时的 runner 遇到旧服务没有历史字段会在模型调用前明确拒绝。回放显示当时保存的无进展与重复信息。此前带策略偏好的版本的真实局面和同图验证见 [循环修复验收](../openspec/changes/improve-jev-decision-context/loop-fix-validation.md)。

历史分析版本的事实回归与真实模型选择见 [分叉证据与自主决策验收](../openspec/changes/improve-jev-decision-context/branch-autonomy-validation.md)。此前的通关记录保留当时原始提示词，不作为当前版本必胜的证明。

多层分叉优化的真实回归与性能记录见 [证据链优化验收](../openspec/changes/improve-jev-decision-context/proof-chain-validation.md)；多出口与增长后漏判修复见 [全分支证明验收](../openspec/changes/improve-jev-decision-context/multi-exit-validation.md)。

## 历史 Context 评估

```sh
# 默认离线：无需密钥，不发外部请求；--out 是 JSON 文件路径
bun scripts/evaluate-context.ts --out .data/qa/context-v3/offline.json
# 显式启用真实请求；读取 .env 中的 provider/model/对应密钥
bun scripts/evaluate-context.ts --live --out .data/qa/context-v3/live.json
```

离线使用开局、历史 tick 364 死胡同和近满盘的共享 fixture，比较固定保存的 v2 正文与 v3 正文大小，测量历史 fixed 单步/两步与 response 单步构建耗时 p50/p95；fixed/两步数据仅为离线对照。`--samples` 可指定每项采样次数，默认 30。旧 v2 fixture 未采集构建耗时，报告保留未记录，不填零；v3 不保证在每个短蛇局面都比 v2 更小。报告的 500ms 截止仅用于旧实验对照，当前响应模式没有移动截止。

`--live` 仅对三个 fixture 的 response 单步 v3 正文串行请求，共 3 次，不再调用 fixed/两步。保存 provider/model、原文、选择、耗时、真实 usage 与错误，不提交到游戏。历史 v4 与 v3 的 response 单步对照使用 `scripts/evaluate-positive-context.ts`，每个 fixture 两次串行请求；输出明确标注 fixture 和测量版本。离线输入不代表整局成绩，有限模型样本不证明随机地图必胜。
