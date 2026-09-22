# Agent Instructions

## 项目与工作方式

- 默认使用中文交流；修改前确认当前分支和工作区状态，保留与任务无关的已有改动。
- 仓库名为 `poker-game`，当前产品是 **SNAKE · JEV 实时贪吃蛇**：模型决策、游客观战、历史回放、管理员连续开局、匿名反馈与模型 Key 贡献。
- 技术栈为 TypeScript、SolidJS、TanStack Solid Start/Router、Vite、Hono、WebSocket 和 SQLite（`better-sqlite3`）。前端沿用 Solid 的 signal、effect 与清理机制。
- 先读 [README.md](README.md) 和相关源码、测试。需求与验收资料在 `openspec/specs/`、`openspec/changes/`，模型输入说明在 `docs/`；其中含历史方案，判断当前行为必须追踪实际调用入口，不能仅按版本号或旧文档推断。
- 优先修复根因。不要为跑通流程新增静默兜底、吞错、模拟成功或任意上限；确有必要的边界应明确说明、记录并可配置关闭。

## 代码入口

| 路径                                    | 职责                                           |
| --------------------------------------- | ---------------------------------------------- |
| `src/routes/`                           | 首页、观战、历史、回放与反馈路由               |
| `src/features/snake/`                   | 棋盘、模型输入展示、管理控件、实时连接和回放   |
| `src/features/community/`               | 匿名反馈、企微/贡献弹窗、感谢动效与社区管理    |
| `shared/snake/`                         | 公共类型、Zod 协议、移动规则和局面分析         |
| `server/game/engine.ts`                 | 真实游戏状态推进、布局与种子随机数             |
| `server/matches/`、`server/db/store.ts` | 对局服务、事件恢复、事务持久化与请求去重       |
| `server/jev/`                           | 模型配置、请求构造、传输、运行器与历史分析入口 |
| `server/watch/`                         | 连续观战频道、管理员会话、启停与恢复           |
| `server/community/`                     | 社区配置、公共/管理接口、反馈持久化与 v3 迁移 |
| `server/credentials/`                   | Key 加密、验证回执、撤回、私有调用记录与轮换  |
| `scripts/`、`tests/`                    | CLI、离线/真实模型评估、Vitest 测试与固定局面  |

## 开发命令

使用 Bun 1.4.2（版本记录在 `.bun-version` 和 `packageManager`），依赖以 `bun.lock` 为准。类型检查与服务端编译使用 TypeScript 7 的 Go 原生编译器（原 `tsgo`，正式版命令名为 `tsc`）；沿用现有脚本名称。

- `bunfig.toml` 固定脚本及子进程使用 Bun；不要重新引入 npm/pnpm 锁文件或 Node/tsx 启动脚本。
- 测试继续使用 Vitest，通过 `bun run test` 调用，不使用 `bun test`。内存回归测量 Bun 的 GC 后保留堆，不把 V8 专有参数当作 Bun 的有效限制。
- Bun 脚本运行时自动加载 `.env` 已关闭；Vite 和服务端/CLI 分别通过 `loadEnv`、`dotenv/config` 显式读取配置，测试子进程保持环境隔离。

| 命令                                     | 用途                                            |
| ---------------------------------------- | ----------------------------------------------- |
| `bun install --frozen-lockfile`          | 按锁文件安装依赖                                |
| `bun run dev`                            | 同时启动网页（3000）与 Hono（默认 3001）        |
| `bun run dev:web` / `bun run dev:server` | 单独启动前端 / 游戏服务                         |
| `bun run generate-routes`                | 生成 TanStack 路由树                            |
| `bun run test tests/game.test.ts`        | 运行指定测试文件                                |
| `bun run test` / `bun run test:snake`    | 运行全部 Vitest 测试                            |
| `bun run typecheck`                      | 检查前端、共享模块与服务端 TypeScript           |
| `bun run check`                          | 格式检查与 lint；不包含类型检查或测试           |
| `bun run build`                          | 构建游戏服务与前端                              |
| `bun run serve`                          | 同时运行构建后的游戏服务与网页预览              |
| `bun run start:server` / `bun run start` | 分别启动构建后的游戏服务 / 前端                 |
| `bun run jev`                            | 服务运行后发起真实模型对局，使用配置的 API 密钥 |

- 首次配置参考 `.env.example`，已有 `.env` 不覆盖。服务启动需要 `GAME_ADMIN_TOKEN` 和 `SQLITE_PATH`；真实模型使用 `TYPESAFE_API_KEY` 或显式选择的 OpenRouter 配置。
- 默认 SQLite 路径为 `.data/snake.sqlite`。环境变量变更后重启相关服务；密钥、管理员凭证、数据库和 `.data/` 验收产物不提交到 Git。
- 日常本地观战使用 `bun run build` 后 `bun run serve`，避免源码保存触发刷新或重启。启动或重启前核对端口、进程完整命令行和工作目录；保留原频道开关意图，不因预览页面自动开局。
- 生产需要两个常驻服务、持久磁盘和 `/api`、`/ws` 反向代理；不能把前端构建成功或模板 `vercel.json` 当作游戏后端已部署。

## 游戏与模型约束

- 游戏事实由服务端引擎与持久化事件决定。新局只运行 `response` / `single_step`：每次有效模型响应只推进一步，等待期间不移动；前端动画不延迟请求或推进游戏。
- 即时碰撞、增长与尾格释放共用 `shared/snake/move-rules.ts` 的 `inspectMove`。分析不得修改真实局面或消耗真实 RNG；未知的未来苹果不能伪装成已知事实。
- 实时请求沿 `server/jev/client.ts` → `server/jev/board-context.ts` 构造，当前默认 `compact-growth-v16`；`JEV_DYNAMIC_ANALYSIS=false` 显式选择 V13。精简请求见 [docs/jev-compact-growth.md](docs/jev-compact-growth.md)，增长与困死事实沿用 [V15 语义](docs/jev-growth-space.md)；旧分析器和评估脚本不代表实时路径。
- 程序提供合法选项和分析事实，执行模型原始选择；不自动代选方向、超时直行、切换服务商或隐藏重试。无合法动作的终局与 API/格式错误应明确记录。
- 区分即时合法、有限窗口内存在续路、已证明困死和整局通关；搜索预算耗尽及乐观续路不表示安全。分析预算与对局终止条件分开处理。
- 保留实际发送的模型请求、原始概率及真实耗时；概率合计异常按当前协议提示，不自行归一化。缺失指标不补零，离线测试结果不冒充真实模型成绩。
- 已有停滞费用保护由 `server/jev/stagnation.ts` 管理，可用 `JEV_STAGNATION_GUARD=false` 显式关闭。触发后记录本局中断，不判输；`stagnation_loop` 停止连续开局，`stagnation_no_apple` 在频道原本启用时按倒计时进入下一局。用户已停止的频道不能因此重新启用。

## 历史、持久化与权限

- 局面、事件和请求结果在同一事务提交后才确认和推送；保持请求幂等与事件 `seq` 顺序。SQLite 写入失败明确报错，不切换到临时内存存储。
- 修改布局、协议或 context 时保留历史读取与回放语义。旧 fixed/两步模式只供历史读取，不恢复为新局运行选项，也不重写已保存的请求正文。
- 分支与重启恢复需保持原配置、身体、RNG、累计时间和已执行历史；`sourceSeq` / `--fork-seq` 是事件序号，不是 tick。恢复时不重抽地图、不补走停机期间的步数。
- `/watch` 跟随连续频道，`/watch/:matchId` 固定单局。停止连续开局与立即停止本局的行为不同；修改时核对频道恢复、在途请求取消和迟到响应处理。
- 游客游戏接口只读；匿名反馈、Key 贡献与持原 Key 撤回是独立的公共写接口，校验精确 Origin 与输入，不授予游戏或管理权限。`/watch?admin=1` 仅显示管理入口；社区管理复用 `/api/watch-admin/*` 的服务端会话及 Origin 校验，不扩展 cookie 到全站。
- 当前 SQLite schema 为 v3，社区表由 `server/community/migration.ts` 原子迁移，保留已有对局、事件、频道和回执。升级前做一致性备份，回退时保留兼容读取或明确恢复旧备份，不能直接降版本、删表或用空库替代。

## 社区与贡献凭证

- `/feedback` 免登录投稿并立即匿名公开，只展示正文与时间，不收集昵称或联系方式、不关联 Key 贡献。正文按纯文本渲染，管理员可隐藏/恢复；匿名展示不等于程序会移除正文里的个人资料。
- 企微入口读取 `COMMUNITY_WECOM_JOIN_URL` / `COMMUNITY_WECOM_QR_URL`。未配置或图片加载失败应明确显示；不伪造入群成功，不用生成图片代替真实二维码。
- `JEV_CONTRIBUTIONS_ENABLED` 与 `JEV_CREDENTIAL_POOL` 默认均为 false，分别控制新贡献与频道使用凭证池。任一启用都需要独立的 `CREDENTIALS_MASTER_KEY`（32 字节、base64）；以实际配置为准，不把本地启用状态当成仓库默认值。配置细节见 README。
- Key 贡献必须经过用户主动授权和对应服务商的真实 JEV 验证；只有验证与持久入库均成功才启用并播放一次感谢动效。Key 前缀、余额查询或 HTTP 200 不足以证明可用；失败、未确认和已有 Key 的重复投稿不播放成功庆祝，减少动态效果时静态展示。
- Key 仅以 AES-256-GCM 密文保存，完整 Key 的 HMAC 指纹用于去重，主密钥与数据库分离。原始 Key、密文和指纹不得进入公开响应、对局事件、URL、浏览器持久存储、前端构建或日志；管理员只读脱敏状态。生产贡献传输使用 HTTPS，解密错误明确报错，不降级为明文或当作空池。
- 凭证池只在当前 `JEV_PROVIDER` 与已验证的目标模型内逐局轮换，局内固定当前 Key；CLI 保持原环境单 Key 行为。异常切换以 `server/jev/transport-error.ts` 的明确分类为准：Typesafe 仅确认的 401，OpenRouter 本层 401 或确认余额耗尽的 402；限流、临时预算、权限、网络、格式和未知错误不得借轮换绕过。
- 验证、管理命令和回执保持幂等；未确认的外部调用不自动补发。撤回/停用后阻止新观战调用，已经发出的请求可能完成并计费；迟到验证不能重新启用已撤回或停用的 Key。撤回清除活动密文，不承诺物理清除历史备份。
- 正常轮换游标与新局绑定原子保存，同局恢复不推进游标。失败请求和切换原因保存在私有记录，不生成游戏动作；池耗尽明确暂停，新贡献不自动清除故障或开启频道。区分“已验证”“已启用”和“实际调用”，缺失用量/费用不补零。

## 修改与验证

- 沿用 `.oxfmtrc.json` 和 `.oxlintrc.json`：Tab 缩进、2 列宽度、80 列换行、双引号与分号。服务端 NodeNext 相对导入沿用 `.js` 后缀。
- `src/routeTree.gen.ts` 是生成文件，更新路由源文件后通过命令生成；不要手改生成结果。
- 按改动范围运行相关 Vitest 测试；类型、跨模块行为或构建链路变更时补充相应检查。仅文档改动核对路径、命令与 `git diff --check`，不要求全量构建。
- 格式化限于任务文件，可用 `bun run oxfmt --check <文件>` 检查；不要通过全仓 `bun run format` 混入无关变动。
- UI 改动按下节使用真实浏览器验证。测试中的模型传输替身只验证契约，真实模型评估单独报告实际调用与结果，不能用空页面或 HTTP 200 代替业务验证。
- 社区改动重点核对 `tests/community-*.test.ts`、`tests/credential-*.test.ts`；触及轮换或恢复时同时验证 runner、watch 和停滞保护回归。真实服务失败应保留未完成验收，不通过关闭 TLS 校验、切换服务商或测试替身冒充成功。
- 报告说明改动、已执行检查及失败或未验证范围；提交仅包含任务文件，提交说明使用简洁中文。

## 浏览器操作

- 本项目需要打开网页、调试页面、截图或验证 UI 时，默认使用 **`agent-browser` CLI**。
- 开始前读取 `agent-browser --help`，按本机实际支持的命令操作。`agent-browser` 与 `ego-browser` 是不同工具，不要混用命令，也不要直接套用 Playwright API。
- 一个用户任务使用独立且不与其他任务重名的 session，后续调用复用同一 `--session`；不要为每次截图、重试或验证步骤另开 session。记录本任务的 session 名称、daemon PID 和浏览器 PID，供结束时核对。
- session 名称保持简短；macOS 的临时目录加上长名称可能超过 Unix socket 路径限制，导致路径截断和 daemon 启动失败。此时检查实际 socket 路径与进程归属，只清理本任务残留，不按进程名称批量终止。
- 默认无界面运行；截图和 snapshot 不需要 `--headed`。只有需要显示窗口交互或用户明确要求时才使用 `--headed`。
- 操作前运行 `snapshot` 获取页面状态，操作后验证实际结果。需要视觉确认时再截图。
- 遇到连接或执行失败时，先诊断实际错误并明确报告。尊重用户接管，保留用户自己的标签页与登录状态。
- **用完必须关闭**：成功、验证失败、放弃当前方案或收到中断后，均须在结束任务前执行 `agent-browser --session <本任务名称> close`。关闭标签页或窗口不等于退出 session；不能自行以“保留预览”为由留下测试浏览器，只有用户明确要求保留或接管时才例外。
- 批量命令在同一 shell 中预先注册 `EXIT` / `INT` / `TERM` 清理；跨工具调用的交互验证，在完成或停止时显式执行同一 session 的 `close`。关闭失败必须报告错误，不能用 `|| true` 吞掉。
- 关闭后核对 `agent-browser session list`，并用先前记录的 PID 与完整命令行确认本任务 daemon 和浏览器均已退出。仍有残留时核实归属，向该任务的 daemon 发 `SIGTERM` 并再次核对；禁止按 Chrome/Electron 名称批量终止其他任务或用户浏览器。报告验证结果时同时交代清理结果。

批量验证示例（在同一次 shell 调用中执行，替换任务名称和目标 URL）：

```bash
(
  set -e
  browser_session="snake-$(date +%H%M%S)-$$"
  cleanup_browser() {
    browser_result=$?
    trap - EXIT
    if agent-browser --session "$browser_session" close; then
      exit "$browser_result"
    else
      printf '浏览器 session 关闭失败：%s\n' "$browser_session" >&2
      exit 1
    fi
  }
  trap cleanup_browser EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  agent-browser --session "$browser_session" open http://localhost:3000
  agent-browser --session "$browser_session" snapshot
  # 按当前 snapshot 返回的引用操作，再验证实际结果。
  mkdir -p .data/qa
  agent-browser --session "$browser_session" screenshot .data/qa/page.png
)
```

此示例无论验证成功还是命令报错，退出时都会尝试关闭自己的 session，并保留验证失败的退出码；关闭失败也会返回非零。截图和日志可保留用于交付，浏览器进程按上述规则清理。进程被 `SIGKILL` 或宿主崩溃时 trap 无法执行，恢复任务后需按记录核对并清理遗留进程。
