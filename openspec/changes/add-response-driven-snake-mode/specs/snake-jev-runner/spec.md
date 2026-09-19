## MODIFIED Requirements

### Requirement: 当前局面与在途请求
runner SHALL 使用服务端当前已提交的实际局面请求模型，目标固定为该局面的紧接着一次移动；每次最多一个在途请求。fixed 每个实际 tick 最多询问一次，接纳后等待实际 tick 推进；response 等前一次应用确认后立即读取新局面并再次询问，不等待定时 tick，也不额外 sleep。response 的 stale_state 或非法反向被拒绝时保持不动，重新读取当前局面后可再次询问同一 tick；请求格式、鉴权、版本或不支持目标错误必须显式失败。返回后带原始目标和摘要提交，禁止预测多步、填充未来队列或重绑旧观察。

#### Scenario: 结果已过时
- **WHEN** 请求返回时目标 tick 已过或局面摘要失效
- **THEN** 该结果不生效，记录原因，再基于最新状态决策；游戏持续运行

#### Scenario: 响应模式的串行闭环
- **WHEN** response 模式已取得一条有效模型结果
- **THEN** 只提交该结果一次，收到 applied 或明确的结果事件后才为新的实际局面请求下一次；不会并发预问或为了动画播放而等待

#### Scenario: 正常等待不是请求失败
- **WHEN** 模型请求仍未结束且对局未停止
- **THEN** runner 保持该请求在途并暴露等待状态或日志，不按旧步长定时取消、不启动并行替代请求、不生成方向

#### Scenario: 奖励变化导致响应失效
- **WHEN** response 请求返回后因奖励到期收到 stale_state
- **THEN** 不移动，也不死等 tick 增长；重新读取当前实际状态再请求，保留本次拒绝事实

## ADDED Requirements

### Requirement: 响应模式的显式启动配置

runner SHALL 提供显式选择 fixed/response 的启动配置，默认保留 fixed。response 的请求正文明确标注模式及当前观察步/唯一下一步，不声明固定间隔或截止时间；历史保存实际发送的正文。两种模式均使用真实服务商和现有凭证隔离，概率合计偏差仍只作诊断。response 不消费两步备用计划，显式请求不兼容的组合必须报错。

#### Scenario: 启动响应模式
- **WHEN** 用户以 response 模式启动 runner，没有显式固定步长
- **THEN** 创建 response 对局并运行单响应单步循环；用于 fixed 的默认间隔不会变成该局的等待时间

#### Scenario: 明确提供冲突选项
- **WHEN** response 同时显式指定固定步长，或同时显式选择 two_step_fallback
- **THEN** 在创建对局前明确拒绝，不偷偷选一种模式

#### Scenario: 请求失败或用户停止
- **WHEN** API、网络或解析失败，或用户主动停止
- **THEN** 沿用明确错误/停止结算与请求取消记录，不因为响应模式改为假结果、自动换模型或自动继续走
