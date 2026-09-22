## Context

动机和产品范围见 proposal.md。用户已确认：服务商为 Typesafe / OpenRouter；反馈立即匿名公开、管理员可隐藏；贡献 Key 真实验证成功后自动入库并参与明确的轮换。

本次只读追踪到的现状：

| 当前入口 | 已观察行为及对本方案的约束 |
| --- | --- |
| src/components/Header.tsx、src/routes/__root.tsx | 全站共用顶栏，只有首页/观战/历史和“游客只读”标签；适合直接增加全局入口 |
| src/routes/watch.index.tsx、src/features/snake/OwnerControl.tsx | 仅 /watch?admin=1 展示管理入口；已有口令解锁、同源 fetch、过期处理和命令 requestId |
| server/watch/owner.ts、routes.ts | 会话为服务端内存记录，cookie 路径固定 /api/watch-admin，HttpOnly/SameSite=Strict，写入校验 Origin |
| server/jev/config.ts、client.ts | 两个服务商已有独立固定端点与模型；Key 来自环境变量；sendJevRequest 校验结构化方向、概率和原始正文，错误目前主要是字符串 |
| server/jev/runner.ts | runJevMatch 每次读取真实局面再 askJev；单请求串行，异常通常退出并停止本局；action 回执与上游结果已分开 |
| server/watch/channel.ts | 启动和恢复都直接检查 settings.jev.apiKey；每局传同一个配置；故障脱敏只覆盖当前环境 Key；恢复已能继续同一个响应单步局 |
| server/db/store.ts、server/watch/store.ts | 真实 SQLite、事务提交、当前 user_version=2；频道开局登记与游戏创建有同事务扩展点 |
| tests/jev.test.ts、watch-*.test.ts | 已有双服务商隔离、错误传播、SQLite 迁移、HTTP/WS、同局恢复和停止竞态的回归基础 |

已有主规格存在历史漂移：snake-continuous-watch 的“持久恢复与显式故障”仍写重启不续旧局，源码和 README 已支持原局恢复；snake-owner-control 仍描述不能立即停止，但源码已有 stopCurrent。此次频道 delta 明确对齐当前恢复行为，社区管理采用独立区域，不重新设计游戏控制。模型 context 的旧规格版本也不作为本次实现依据，验证与运行复用当前实际构造器，不改提示词。工作区已有 AGENTS.md 修改，本规划不改动该文件。

## Goals / Non-Goals

**Goals:** 复用现有导航、会话、服务商传输和数据库；在凭证进入公开表单后建立完整的私有生命周期；令频道实际消费贡献 Key，同时让每次失败、切换、费用相关事实和停止意图可检查。

**Non-Goals:** 不把私有 Key 放入游戏协议，不让验证创建对局，不在 CLI 中隐式启用共享凭证池，不改变模型决策或停滞保护，不建立登录、支付结算或全站管理平台。

## Decisions

### 1. 页面入口与管理位置

- Header 增加反馈 Link 和两枚弹窗按钮；“游客只读”改为“免登录观战”。/feedback 对应新增路由与 FeedbackPage；路由树用 bun run generate-routes 生成。
- 反馈页上方为正文表单及“将立即匿名公开，请勿填写个人资料或密钥”的提示，下方为最新反馈；分页使用稳定的 createdAt/id 游标。匿名标签为固定文字，业务表不收集身份字段。只渲染文本，不使用 innerHTML 或 Markdown HTML。
- 全站弹窗使用 Solid 的 signal/清理机制与已安装的 Kobalte Dialog 能力，匹配当前奶油色、粗描边、硬阴影视觉。优先复用组件，无需引入新的弹窗依赖。通过 375px 换行和有约束的弹窗滚动解决空间问题。
- 在 /watch?admin=1 已解锁区域增加“反馈管理”“贡献 Key”两个独立区块，复用同一个 OwnerSessions 实例。管理路由均位于 /api/watch-admin/*，避免把 cookie 路径扩展至全站。公共反馈页不增加管理参数或第二套登录。
- 企微统一打开指引弹窗，展示配置的链接/二维码；不调用企微成员 API，不伪造已入群状态。
- 用户补充授权：必要的原创插画、线稿及动效配套图片可通过 image_gen 生成。实施时先按现有风格判断是否需要；生成提示词和预览保留在变更验收资料，选用产物再进入正式素材目录。交互动效由 CSS/Solid 实现，尊重减少动态效果设置；生成图片不替代可读标签、图标语义或真实企微二维码。
- 贡献成功采用弹窗内的感谢状态：标题“谢谢你的支持，让小蛇继续向前！”，正文“Key 已验证并加入凭证池”，并保留真实的待调度/服务商说明和“完成”按钮。收到验证与入库完成回执才切换，失败或未确认继续显示原状态。使用 transitions-dev 成功反馈作为参考，勾选图形描边并轻弹出现，周围少量星星短暂散开，约 650ms 收束后留下静态感谢卡片；不自动关闭，不等待动画才允许操作，也不影响观战请求。通过本次会话内已呈现的贡献回执去重；后台成功不强行重开弹窗，重新查看或重复投稿已有 Key 时显示静态感谢。成功区域用 role=status / aria-live=polite 宣告一次，装饰图形 aria-hidden；减少动态效果时直接静态展示。CSS/SVG 足够时直接实现，确需原创小蛇/线稿素材才使用已授权的 image_gen。

备选：新建 /admin 和第二套 cookie 会增加权限迁移；把管理控件插入所有公共页面会扩大暴露面，因此均不采用。

### 2. 接口边界

新增 shared/snake/community.ts 定义严格 Zod 请求及公开 DTO；服务分别放在 server/community/ 和 server/credentials/，由 start.ts / app.ts 装配。

| 接口 | 内容与权限 |
| --- | --- |
| GET /api/community | 只返回企微链接/二维码、贡献功能是否开放、支持服务商和本次验证模型，不返回密钥配置值 |
| GET /api/feedback?cursor=... | 仅可见反馈，固定分页批次；隐藏卡片不提供公共详情读取 |
| POST /api/feedback | 本站 Origin；requestId、body；事务保存正文及原回执 |
| POST /api/key-contributions | 本站 Origin；高熵 requestId、provider、apiKey、consentVersion、consent=true；验证并自动启用 |
| POST /api/key-contributions/status | 本站 Origin；提交时的高熵 requestId；只返回该请求状态及回执，不在 URL 放验证回执标识或 Key |
| POST /api/key-contributions/revoke | 本站 Origin；requestId、provider、apiKey；持有原 Key 即可撤回，不调用外部模型 |
| GET /api/watch-admin/feedback | 管理员会话；包含隐藏状态和原文 |
| POST /api/watch-admin/feedback/:id/visibility | 管理员会话与 Origin；requestId、visible，禁止无幂等的 toggle |
| GET /api/watch-admin/credentials | 管理员会话；脱敏状态、最近验证/调用、切换原因与真实 usage |
| POST /api/watch-admin/credentials/:id/commands | 管理员会话与 Origin；requestId 和 disable 或 revalidate-and-enable |

投稿与凭证接口不能调用游戏创建/控制服务。所有凭证及管理响应 no-store，公共反馈也不使用长期缓存，隐藏后下次请求即生效；已经打开的页面不承诺远程擦除先前读到的文本。

公共写入使用相同精确 Origin 配置，但不要求管理员会话。请求体大小限制在读取正文前生效，使用 COMMUNITY_MAX_BODY_BYTES（默认 16384，0 显式关闭），用于公开写入的资源保护，不限制游戏步数或时长。超过限制返回明确 413，不截断正文；非零配置须足以容纳接口正常使用。匿名是产品展示与业务数据约定，不虚称反向代理或网络层完全不接触 IP；不把 IP、UA 写进反馈/贡献业务表。

### 3. 数据结构与加密

新增同库的 schema v3 迁移，保留 WAL、外键与 FULL 同步：

| 表/存储区域 | 主要字段与用途 |
| --- | --- |
| community_feedback | id、body、created_at、visible、updated_at；不保存作者身份 |
| community_requests | namespace、request_id、request_hash、receipt_json；反馈、撤回和管理操作幂等 |
| credential_verifications | request_id、provider、model、key_fingerprint、consent_version、status、started_at、finished_at、脱敏错误与回执；验证中不存明文 Key |
| contributed_credentials | 随机 id、provider、model 验证范围、key_fingerprint、掩码、ciphertext/nonce/tag/key_version、enabled/disabled/unusable/revoked 状态与原因、验证/调用时间 |
| credential_attempts | 随机 attempt_id、purpose=validation/watch、私有 credential_ref、match_id、observed_seq、target_tick、action_request_id、开始/结束、HTTP 分类、真实 usage；不复制 Key/认证头 |
| credential_pool_state | provider、正常轮换游标及环境凭证的指纹/可用状态；环境 Key 不复制为贡献密文 |
| watch_round_credentials | match_id、provider、model、credential_ref；随新局创建一同登记，支持同局恢复 |

使用服务端 32 字节 CREDENTIALS_MASTER_KEY，AES-256-GCM 为每条 Key 使用随机 nonce，AAD 绑定记录 id、provider、key_version。主密钥留在部署秘密配置，不进入数据库、仓库或前端；派生独立用途的 HMAC 密钥生成 provider+完整 Key 指纹去重，不能用短后缀去重。环境 Key 与同值贡献 Key 识别为同一候选，避免一次失败后重试同一秘密。

掩码只向管理员返回（例如只显示末四位），公开回执不返回指纹、密文和 credential_ref。所有可被公开使用的错误是固定安全描述与状态码，不透传任意上游 body；私有诊断可存脱敏摘要，不保存认证头。对响应正文、嵌套 cause、JSON 解析错误、日志和全局 app.onError 做专门的泄露回归，不能只在 channel.message 替换当前环境 Key。随机 attempt_id 可用于事件关联，公开数据不包含稳定凭证标识。

不保存明文是必需的隐私边界，不提供明文“调试开关”。没有主密钥或密文鉴权失败时明确失败；不把解密失败当作无贡献并偷换环境凭证。管理员不能读取原 Key；确需再次验证时由服务内部临时解密，使用后释放引用。JS 运行时无法保证内存物理清零，不在产品上承诺这一点。

### 4. 验证状态机及回执

1. 客户端生成高熵 requestId，仅持有内存中的 provider/Key/授权勾选；请求回执标识允许留在本次页面会话内，Key 不持久化。
2. 服务端在发出请求前事务登记 validating 和输入 HMAC。同 requestId 同内容复用状态，不同内容冲突；同 provider/Key 已有效则返回现状，不再重复验证。同 Key 的在途验证合并处理；disabled 不被公开重复投稿重新启用。
3. 从当前对应服务商模型配置构造固定、小型、无真实游戏副作用的方向选择请求，复用 sendJevRequest 及当前响应校验。非当前服务商使用该服务商默认模型；当前服务商若配置 JEV_MODEL 则验证该精确目标。分别保存 requestedModel 和实际返回 model；验证范围匹配 requestedModel，允许官方别名返回具体版本。配置目标模型变化后旧贡献不自动声称兼容新模型，需明确重新验证。
4. 使用原生 fetch，禁止隐式 SDK 重试。检查实际模型、choice、概率及 confidence；保持概率合计异常只作诊断的当前契约。HTTP 200 或查询 Key 存在不足以激活。
5. 验证通过后，同一事务写入密文、enabled 状态和完成回执，再返回成功。失败仅保存不含秘密的失败元数据，未通过 Key 不进入候选池。已有 disabled/unusable Key 的私有重新验证仍使用相同状态机。
6. 浏览器关闭或请求连接断开不等同于撤回，已接收验证由服务端完成；重开弹窗可用请求回执查询。服务关闭应显式取消验证，取消结果记录为 interrupted/unconfirmed，不自动重新请求。
7. 外部计费与本地数据库不能原子提交。若调用发生后进程崩溃但结果尚未落库，启动时将遗留 validating 标为 unconfirmed；用户主动重新提交前说明上次可能已计费。同 requestId 不能触发重放，显式重试用新 requestId。

撤回使用完整 Key 的 HMAC 定位，不再联系服务商；记录 revoked 并清空活动密文，保留非秘密审计。并发撤回/禁用优先级以事务版本校验保证：迟到验证不能重新启用已被撤回或禁用的记录。已撤回的 Key 只有持有人再次明确贡献并验证才能新增有效授权，管理员无权从已清除的密文恢复。SQLite/WAL/备份中的旧密文不承诺物理抹除；运行时按最新 revoked 状态拒绝使用，备份与主密钥按同一秘密管理要求保护。

备选：先查余额再直接入库无法证明 JEV 模型调用权限；在浏览器直连验证会扩大暴露和 CORS 依赖；均不采用。

### 5. 错误分类必须有契约证据

本次查阅的官方材料：Typesafe 的 [API reference](https://docs.typesafe.ai/api) 记载 401 为缺失/无效 Key，422 为请求格式问题，429 为限流，529 为过载；未说明余额耗尽状态。OpenRouter 的 [Errors and Debugging](https://openrouter.ai/docs/api_reference/errors-and-debugging) 说明鉴权、额度、权限与限流错误，并单独区分带 Retry-After / openrouter_in_flight_budget 元数据的临时预算阻塞。原生 Typesafe 调用端点和当前 OpenRouter alpha/decisions 端点以仓库配置为准，不迁移到聊天 API。

client.ts 新增结构化传输错误（provider、httpStatus、明确业务分类、安全摘要），runner 不匹配整段错误字符串。首版可自动排除并轮换的范围：

- Typesafe：明确 401。公开文档未定义的余额错误保持 unknown_upstream 并暂停；不能猜测 402 或依赖正文包含“credit”就轮换。
- OpenRouter：明确本层无效 Key 的 401；确认为账户/Key 余额耗尽的 402 才标记 exhausted。带 Retry-After、临时预算元数据、额度政策歧义或无法辨别来源的 402 一律暂停，不通过多把 Key 绕过临时预算。
- 403、429、超时、网络、5xx/529、未知业务码、模型权限或结构错误：记录并走现有失败路径，不永久标记 Key 无效，不自动换 Key/服务商/模型。

OpenRouter 通用文档不能单独证明 alpha/decisions 的所有响应细节。实现仅接纳可证明符合上述语义的响应；使用该端点的真实脱敏错误样本补充契约验收，不放宽未知错误规则。未取得 Typesafe 额度错误契约时，限制已确定为“明确报错暂停”，不是留待实现者决定的策略。

### 6. 轮换和运行器接入

- 通过可选的私有 credential source 接入 runJevMatch；没有该 source 的 CLI 完整维持环境单 Key 路径。频道启动检查从 apiKey 非空改为所选模式下“有可用凭证”，health 的就绪状态也相应读取实际可用性，不暴露池明细。
- JEV_CREDENTIAL_POOL=true 时，仅以 JEV_PROVIDER 选定的服务商和目标模型组成候选集。站长环境 Key 为既有授权来源，不要求先重新计费验证；贡献 Key 必须具有相同模型的成功验证。未配置站长 Key 但有匹配贡献时，频道可启动。Typesafe 与 OpenRouter 各有独立池与游标；不存在跨服务商自动选择。
- 正常每局按稳定顺序轮换：环境成员排序在前，贡献按 createdAt/id 排序；从上次正常轮次成员之后选取并环回。新局建立时将轮换游标、凭证绑定和 watch round 注册与游戏创建一同提交，失败不消耗正常轮换序号。同局恢复不推进局间游标。
- 每次实际发出前重新检查当前凭证状态并持久登记 attempt started，再立即发请求；同一 Node/Bun 事件循环中检查与 dispatch 之间不得有允许撤回先提交的异步空隙。每局只有一个上游调用在途。验证调用在私有台账中独立，不计入游戏轮次。
- 响应成功先保存实际调用结果，再用原观察和独立 action_request_id 提交游戏动作；private attempt 分别记录上游成功与游戏 applied/rejected，不把二者合并为一次假成功。command helper 应允许显式 action_request_id，并保留现有控制请求去重，不引入新的网络自动重试。
- 收到明确凭证失败时，在同一事务记录失败结果并将当前成员标记 unusable/exhausted。服务端重新读取当前局面和停止状态，选择同 provider 下一把；每次错误均可查。失败成员在明确重新验证前不会再次入选，不需要额外的任意重试次数上限。
- 管理禁用/贡献撤回后不取消已发出的调用，也不承诺退费；该请求按原规则完成。下一次 dispatch 检查改选下一把，若无可用 Key 则明确中断并进入池耗尽故障。验证回调以记录版本防止覆盖禁用/撤回。
- 非凭证错误原样进入现有中断机制。池耗尽时 current match 的停止、频道 fault 和私有池状态均以数据库已提交内容为准；若某次持久化失败，停止调度并暴露服务故障，不虚称所有状态已保存。
- 本局继续运行时新贡献可在下次必要选择时使用；新正常轮次才发生常规轮换。已经 stopped/fault 的频道不会被投稿自动唤醒。管理员的停止开局、立即停止以及既有 generation/AbortSignal 检查优先于轮换回调。

首版按“局”分摊而非声称公平分摊金额：不同局的步数、输入大小和账单可能不同。仅报告真实可得的调用次数、最近调用与 usage；未知金额不填 0，不承诺账户总支出上限。贡献弹窗明确建议使用服务商侧可独立撤销、由用户自行限定额度的 Key。

### 7. 配置、可关闭性和恢复

| 配置 | 规划行为 |
| --- | --- |
| COMMUNITY_WECOM_JOIN_URL | 可选 HTTPS 入群地址，不含用户凭证；缺失可仅展示二维码 |
| COMMUNITY_WECOM_QR_URL | 可选同源静态资源路径或 HTTPS 图片地址，部署者提供 |
| JEV_CONTRIBUTIONS_ENABLED | 默认 false；明确设 true 开放新贡献，必须有有效主密钥；关闭后仍允许已有贡献撤回和管理员停用 |
| CREDENTIALS_MASTER_KEY | 独立 32 字节秘密，采用明确的 base64 格式校验，不设置 VITE_ 前缀；启用贡献或池模式时缺失即配置错误 |
| JEV_CREDENTIAL_POOL | 默认 false 保持现有部署单 Key 行为；部署本功能时明确设 true；false 停止选择贡献并回到环境单 Key，每次请求仍先检查模式 |
| COMMUNITY_MAX_BODY_BYTES | 默认 16384，0 显式关闭请求体资源限制；前后端提示与服务器校验一致 |
| WATCH_PUBLIC_ORIGIN | 复用当前精确站点 Origin，不新增任意跨域来源 |

这些开关影响未来请求，修改环境配置按已有规则重启服务。已停止或故障状态不因重启开关变化被清除。池绑定只存私有引用；环境 Key 变化以 HMAC 识别新成员，旧失效状态不误套新 Key。贡献密文解密失败是配置故障，不能伪装普通凭证耗尽再绕行。进程重启将未完成 attempt 标为结果未确认，结合已保存 action_request_id/公开回执核对是否已推进；不补发旧 HTTP 请求、不补步。

未配置企微信息可先部署反馈与贡献，页面明确显示未配置。功能开关用于部署启用和回滚，不把“贡献已成功”返回给实际没有写入或未开放的请求。

## Risks / Trade-offs

- 公开即时反馈可能包含垃圾信息或正文中的个人资料 → 使用前置公开提示、纯文本展示、明确大小限制与管理员隐藏；不承诺自动识别或匿名化正文中的所有个人信息。
- 上游已计费但本地未确认 → 持久化验证/调用开始记录，重启标记未确认，显式重试，不宣称跨系统 exactly-once。
- 贡献 Key 可能余额少或随时被服务商撤销 → 记录验证时刻及真实失败，匹配契约后同服务商轮换，池耗尽明确暂停。
- Typesafe 未公开余额错误、OpenRouter alpha 细节未完整确认 → 已确定只轮换可确认类型；其他错误保持暂停，真实端点样本列入专项验收。
- 不能从请求 usage 推断全部实际账单 → 不生成虚构余额、固定额度或精确分摊承诺。
- 无法从数据库备份物理删除过去密文 → 撤回关闭活动授权并清除当前密文，保护备份及主密钥；不把历史备份当作可重新启用的授权。
- 大量无效验证投稿可能带来上游压力 → 按 Key 去重、公共请求大小限制及现有部署层流量管理；后续若需要应用限流需显式配置和可关闭，不在此变更暗加随机验证配额。

## Migration Plan

1. 实施时再次确认 user_version；若仍为 2，新增 v2→v3 原子迁移，并覆盖从空库、v1、v2 连续升级。主规格及 README 的调整只针对本变更涉及行为，不批量改写历史方案。
2. 停服务并进行一致性数据库备份，保留部署配置和主密钥；准备真实企微素材。部署新前后端及 /api、/ws 代理，设置独立加密秘密和两个显式启用开关；生产使用 HTTPS 与对应 Secure 会话，本地开发可沿用现有 localhost HTTP。
3. 启动后核对旧历史及原局恢复、匿名投稿、管理隐藏、无权限拒绝、两个服务商各一次真实验证和贡献实际被用于受控观战的证据。自动化测试不得使用开发 .env 或冒充真实调用。
4. 常规回退先关闭新贡献和池选择，保留 v3 兼容后端读取数据；已有验证/调用状态保留。必须回到 v2 旧程序时，先停止写入，再显式恢复迁移前备份并说明备份后的记录不在其中；不能原地降版本或删新表假装无损回滚。

## Open Questions

- 部署时需提供真实企微入群 URL、二维码资源或两者；目前尚未提供，这仅影响配置和素材，不影响既定流程或接口。无配置的明确状态已纳入规格。
