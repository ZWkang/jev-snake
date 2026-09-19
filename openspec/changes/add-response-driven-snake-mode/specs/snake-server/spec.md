## MODIFIED Requirements

### Requirement: 动作校验和请求去重

控制请求 SHALL 具备唯一请求标识和可识别的目标对局，方向请求另外包含已观察的 `observedSeq`、`targetTick` 与 `expectedStateHash`。相同标识与相同内容重发时返回已保存的接纳结果及当前已知生效结果，不能再次应用；相同标识携带不同内容时明确冲突。无效方向、不存在或未来的 observedSeq、未运行/已结束对局、迟到、预期局面失效和同 tick 冲突均返回可区分错误。固定截止或响应即刻执行的规则由该局已保存的 stepMode 决定并遵循 snake-gameplay；重复请求去重先于截止判断，不能把已成功请求的重发重新判成迟到。

#### Scenario: 响应丢失后重发
- **WHEN** 控制者重复发送已经提交成功的相同请求
- **THEN** 返回原结果，该动作不会再次生效

#### Scenario: 重用标识修改动作
- **WHEN** 控制者用同一请求标识发送不同方向
- **THEN** 返回冲突错误，不覆盖原请求结果或改变原局

#### Scenario: 响应移动已经成功但确认丢失
- **WHEN** response 动作已提交并推进一格，控制者重发相同 requestId 和内容
- **THEN** 返回原 applied 结果，不再次移动、不重复得分，即使当前 tick 已超过原目标

#### Scenario: 响应没有固定截止
- **WHEN** 控制者读取 response 对局的决策上下文或游客读取计时元数据
- **THEN** 返回当前实际局面、下一移动编号，deadlineInMs 和 nextTickAt 明确为 null，不使用 0、无限大或旧固定步长伪造截止

### Requirement: 接纳与实际生效分开记录

方向请求 SHALL 保留 accepted/rejected 与实际 applied 结果的关联。fixed 仍在定时边界结算；response 的接纳和一次真实移动属于同一原子提交，提交后控制确认直接返回 applied，公开事件中可以保留同一时刻但不同 seq 的 accepted 与移动结果。停止或服务中断时尚未生效的请求标为 cancelled。fixed 缺少新动作时沿原方向移动；response 缺少新动作时不移动，且不存在预存的后续移动队列。

#### Scenario: 动作接纳后目标 tick 尚未发生
- **WHEN** fixed 服务已确认 accepted，但当前尚未到该请求的 targetTick
- **THEN** 当前方向和局面不提前改变；记录能把 accepted 与后来的 applied 或 cancelled 对应到同一 requestId

#### Scenario: 响应即刻应用和原子保存
- **WHEN** response 的有效方向到达
- **THEN** 一次提交保存请求、接纳事件、移动或碰撞事件、最终状态与回执；提交失败时不移动、不广播部分成功，提交成功后才发送 applied 确认和有序事件

### Requirement: 实时模型测试的时间证据

服务 SHALL 保存有效控制请求的 observedSeq、targetTick、服务端处理入口时间、接纳/拒绝原因以及实际生效 tick。基于服务端观察事件时间到收件时间的差值标记为端到端反应耗时，包含发送、模型处理和返回链路；不得标作纯模型推理延迟。可选的客户端推理耗时必须标明为客户端报告值。首版不据此自动评价模型优劣。

#### Scenario: 查看迟到决策
- **WHEN** 游客在历史或回放中打开一条 late_action 事件
- **THEN** 可以关联观察位置、目标步、到达时间及拒绝原因，且该方向不会出现在实际移动轨迹中

#### Scenario: 查看变步频时间
- **WHEN** 查看 response 模式的一个已应用动作
- **THEN** 能区分模型请求耗时、观察到收件的时间、实际移动时刻以及距上一步的间隔，不把间隔全部当作模型推理耗时，也不填入固定周期调度滞后

## ADDED Requirements

### Requirement: 推进模式的存储与版本兼容

对局创建结果、公开状态、摘要和记录 SHALL 保存明确的推进模式。已有 v1 固定步频记录缺少模式时按固定模式解释，不改写其原始事件；新响应记录使用独立可识别版本。无法识别的版本或模式明确拒绝，不能将 response 回退成 fixed。模式信息不得泄露控制密钥。

#### Scenario: 升级后混合读取
- **WHEN** 同一数据库包含已有 v1 固定步频历史和新的响应模式记录
- **THEN** 列表、单局、WS 和分页事件均能正确读取受支持版本，原 v1 棋盘、分数、时刻、seq 和请求去重事实不变

#### Scenario: 未知模式
- **WHEN** 记录或创建请求包含不支持的 stepMode
- **THEN** 明确报不兼容或配置错误，不按默认固定模式继续运行
