# 社区入口与 Key 贡献验收

日期：2026-09-21（Asia/Shanghai）
分支：feat/community-feedback-and-keys
状态：30/31 项完成；6.4 的 Typesafe 真实服务验收被 TLS 连接错误阻塞，未勾选。

## 实现范围

- 全站反馈导航、企微入口、贡献/撤回弹窗和管理员社区面板。
- 反馈立即匿名公开，可由管理员隐藏/恢复，纯文本渲染；游戏控制权限保持受保护。
- Typesafe/OpenRouter 明确授权、实际模型验证、加密存储、幂等回执、撤回与重新验证。
- 同服务商逐局轮换、明确凭证失效后的切换、池耗尽暂停、同局恢复与停止竞态处理。
- 验证和入库确认后的感谢文案与约 650ms 的一次庆祝动效；静态感谢与减少动态效果适配。
- 数据库 schema v3 原子迁移；配置、启用、HTTPS、主密钥管理和回滚说明见 README。

## 自动检查

- `bun run test`：93 个文件、1006 项测试全部通过。
- `bun run typecheck`：通过。
- `bun run build`：前后端构建通过。
- 任务范围 38 个源码/测试文件 Oxfmt 检查通过，Oxlint 通过；生成路由通过 `bun run generate-routes` 更新。
- `openspec validate add-community-feedback-and-key-contributions --strict`：通过。
- `git diff --check`：通过。
- 专项覆盖真实临时 SQLite 升级和回滚、HTTP/WS、重复验证、授权版本、密文篡改、错误分类、原始概率/请求契约、停用/撤回与迟到验证、关闭前取消、轮换与停止、断电后的同局恢复、存储失败不发请求/不推进。

全量输出保存在 `.data/qa/community/tests-final.log`，构建输出保存在 `.data/qa/community/build-final.log`。这些测试使用明确的测试传输，不作为真实模型成绩。

## 真实服务调用

凭证只从本机 `.env` 安全读取，未通过命令参数、浏览器操作或聊天传入。真实验收使用独立内存 SQLite 和临时加密主密钥，没有向现有生产凭证池登记验收贡献。

- OpenRouter：真实验证成功；随后通过贡献凭证池发起真实观战决策，实际推进 1 步（matchId：829b9411-ca50-4b44-93e3-202ac87cc378），随即明确停止。共 2 次真实模型请求，原始结构化请求/响应及服务商返回 usage 保存在 `.data/qa/community/live-results.json`。
- Typesafe：验证返回 network_error，未获得 HTTP 响应、未入池或创建验收对局。无凭证诊断确认 Bun 报 `UNKNOWN_CERTIFICATE_VERIFICATION_ERROR`；curl 同样在 TLS 握手失败并返回 HTTP 000。未关闭证书校验，未通过其他服务商冒充其验收成功。
- OpenRouter 错误契约：用刻意无效的测试值调用同一个 alpha/decisions 端点，实际返回 HTTP 401，分类为 invalid_key。证据在 `.data/qa/community/openrouter-error.json`。普通/临时 402 的区别由合同 fixture 测试覆盖，没有人为耗尽账户来采集额度错误；Typesafe 未确认的额度状态保持显式暂停。
- 首轮真实脚本未在关闭内存数据库前导出私有 requestMs 字段，因此不补造该测量；产品的私有调用存储与耗时契约由服务实现和专项测试覆盖。6.4 仍未被标记完整通过。

## 浏览器验证

使用 agent-browser、唯一 session `snake-community-qa-20260921-c7e42`，在独立 3100/3101 环境验证。界面状态使用明确标识的测试传输；配置缺失/二维码失败及结果未确认使用隔离的响应 fixture，均不作为真实入群或模型验证结果。

- 1440×1000 和 375×812：无横向溢出，表单与弹窗可操作。
- 投稿立即可读、刷新持久保留；包含 script 字样的正文只显示为文本，未执行。
- 管理员解锁、隐藏反馈后公共列表不再返回正文、Key 停用与重新验证状态更新。
- 成功只在确认后显示感谢；正常状态记录一次动画序列，重开为静态感谢，不重播。
- 减少动态效果启用时 `matchMedia` 为 true，感谢区域动画数量为 0，文字和图形保留。
- 验证失败和未确认没有感谢动效；验证中关闭不重开弹窗，再查看结果为静态感谢；成功和关闭均清除密码输入。
- 撤回后清空输入并显示撤回确认。
- Tab / Shift+Tab 在弹窗首尾循环；Escape 关闭后焦点回到原“贡献 Key”按钮。
- 企微缺少配置时明确提示；二维码加载失败时，独立配置的链接仍显示。
- 应用无页面 JavaScript 错误；Vite 输出既有 demo 路由导出不拆包提示，未扩展本任务修改范围。

截图位于 `.data/qa/community/`：`feedback-desktop.png`、`feedback-mobile.png`、`thanks-desktop.png`（动效过程）、`thanks-mobile.png`（静态结果）、`thanks-reduced.png`。素材采用现有风格的 CSS/SVG，无需额外生成位图；用户对 image_gen 的必要素材授权保留在设计中。

本机 agent-browser CLI 的 media/route 参数与 daemon 不一致；核对本机 protocol.js 后，只针对同一 session 使用其原生 emulatemedia/route 协议完成这两项设置，其余导航和交互继续使用 CLI。没有切换到其他浏览器或直接套用 Playwright API。

## 清理与交付状态

- 已执行该 session 的 close；session list 返回 No active sessions。
- 先后使用的 daemon/browser PID：99615/99628、23483/23491，均已确认退出。
- 独立 QA 服务 PID 98957、99365 已按完整命令行确认归属并 SIGTERM，均退出。
- 原有 3000/3001 服务 PID 28621/28620 保持运行；未重启它们，未修改现有 `.env` 或生产 SQLite。
- 现有 AGENTS.md 用户改动保留；实现尚未提交、未归档。
- 真实企微链接/二维码仍由部署者提供。新贡献与凭证池默认开关为 false，启用需要独立主密钥及明确配置；未把代码实现当作已上线。
