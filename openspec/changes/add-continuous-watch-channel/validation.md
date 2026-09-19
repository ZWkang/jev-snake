# 连续观战实施验收

## 已实现

- `/` 独立首页，介绍区始终保留；顶栏为首页、观战、历史对局，介绍区有连续观战和历史双入口。
- `/watch` 跟随服务端频道；`/watch/:matchId` 和原回放地址固定原局。
- `/watch?admin=1` 显示管理员口令入口；现有 `GAME_ADMIN_TOKEN` 换取 HttpOnly 所有者会话，管理 API 校验会话与 Origin。参数本身不授权。
- 服务端持续开局、默认 5 秒倒计时、运行中停止后自然结束、倒计时/准备阶段取消、重新开启、故障及重启恢复。
- 新 SQLite v2 频道/轮次/命令表；旧记录不重写；共享真实单局运行器保留 CLI、分叉、进度事实、fixed/response 和两步行为。

## 确定性与集成检查

- 新增 `watch-store.test.ts`、`watch-channel.test.ts`、`watch-api.test.ts`：26 项，覆盖契约、旧库迁移、事务回滚、跨局、去重、停止竞态、六种阶段重启、凭证/会话/Origin、真实 HTTP/WS/SQLite 及单步/两步清理。
- 共享运行器提取后，原有 25 项 `jev-runner.test.ts` 回归通过，包括新近加入的历史分叉能力。
- 初次 `npm test` 为 29 个文件 / 288 项通过；期间工作区同步加入 v4 模型输入与新测试后，最终 `npx vitest run --no-file-parallelism` 为 **32 个文件 / 305 项通过**（36.47 秒）。当前 `npm run typecheck`、`npm run check`、`npm run build` 均通过。
- 构建公开目录扫描 17 个 JS/HTML/JSON/CSS/map 文件，没有发现本地管理员口令或模型 API 密钥原值。
- 迁移前数据库及涉及源码备份在 `.data/qa/continuous-watch/baseline/`。未删除旧库，未改写旧对局。

初次 API 测试误用了频道最早的 stopped 快照作为等待终点，改为同时要求第二局的 lastMatchId，之后两种模式均通过。全量格式检查发现原有 `tests/fixtures/post-growth-loop-regression.json` 排版不符，仅用 Oxfmt 整理并以 JSON 深度比较证明数据不变。

收尾期间新增的 v4 模型输入改动一度使两项旧断言未对齐，随后该组代码完成对应更新；本次保留其逻辑，只整理新增文件的 Oxfmt 格式并移除一个未使用的类型导入。期间有一次并行测试触发既有真实时钟用例的迟到断言；串行复核又遇到本机执行停顿，多项子进程启动超时（连简单 shell 命令也延迟）。失败记录保留在 `tests-final.log`、`tests-integrated-final.log`、`tests-serial-final.log`，未放宽断言或增加超时。环境恢复后相关 53 项回归和最终 305 项全量串行测试通过，最终日志为 `scoped-tests-final.log`、`tests-stable-final.log`。

## 真实模型与浏览器证据

以下使用实际配置的 OpenRouter，响应模型为 `typesafe/jev-1.13-20260917`；不是测试传输替身。沿用当前 fixed / 300ms / two_step_fallback / 24×18 / 12 障碍配置，不修改模型决策或加入游戏限步。

| 验收 | 真实对局与结果 |
| --- | --- |
| 自然跨局并在第二局结束后停止 | `71979d95-93e0-4d72-a7dd-818023cf378d` → `0d77ad93-a13b-4ed0-ba0c-c78c4b33f7cb`；第二局 stop 回执为 draining，随后自然 gameover，频道 stopped |
| 两个浏览器同局、UI 停止/恢复、断线期间跨局 | `377d95c4-e672-4d35-bb54-73e36d8633f1` → `d4e9ac05-4799-471b-bae1-3c85c7cbca3c`；两个只读页显示相同首局，浏览器离线显示连接中断，恢复后直接显示最新终局 |
| 固定单局/回放隔离 | 同时打开的单局页始终绑定 `0d77ad93…`，回放 URL 保持原局，没有被频道新局切走 |
| 关闭所有测试浏览器页 | `41aed00f-bf73-4a95-ad5b-7136619b7f21` 运行中关闭 5 个本任务标签，服务端仍自动开始 `86c7501b-55ee-420c-aea3-08c9cd298622`；对第二局提交停止后自然结束 |
| 活动局期间首页保持介绍 | `72884145-61e5-4ec5-94f1-49bd063a081f` 运行时，首页显示“对局进行中”，仍是介绍区和双入口，没有棋盘；验收后停止后续开局 |

首组观测接入时频道已经开启，过程中还观测到额外的停止/恢复操作；没有把它当成严格隔离的模型对照实验。之后的独立浏览器流程从 stopped 状态启动并保存明确 UI/API 证据。

原始验收文件（均不含口令或 cookie）：

- `.data/qa/continuous-watch/live-validation.json`
- `.data/qa/continuous-watch/browser-flow.json`
- `.data/qa/continuous-watch/no-viewers.json`
- `.data/qa/continuous-watch/home-live.json`
- `.data/qa/continuous-watch/reduced-motion.json`

真实局得分不作为本功能验收标准；fixed 300ms 下仍能观察到模型迟到并沿原方向移动，这属于既有单局模式。本次证明连续开局、鉴权和停止语义，不宣称模型胜率提升。

## 页面与交互

- 1440×1000 桌面和 375px 窄屏均检查；首页、观战和管理员面板没有页面横向溢出。375px 下主体和 scrollWidth 均为 375，棋盘等比缩小并切成单列。
- 普通 `/watch` 不显示管理员区，已有会话时去掉参数同样隐藏；解锁、实际启停、运行中恢复和注销经过界面/接口检查。
- 首次停止后的无局首页、正常终局、活动局首页均有截图。导航高亮、单局选择和历史回放继续可用。
- 媒体模拟的本机 CLI `set media` 存在命令/守护进程协议不匹配；未把报错当成通过。读取已安装 agent-browser 的 `EmulateMediaCommand` 定义后，对同一个命名会话使用其 `emulatemedia` 协议，实测 `prefers-reduced-motion=true`、介绍视频暂停、双入口无动画且仍可读。完成后恢复测试前的媒体偏好。

截图位于 `.data/qa/continuous-watch/`：`home-mobile.png`、`home-desktop.png`、`home-live-desktop.png`、`watch-desktop.png`、`watch-mobile.png`、`admin-mobile.png`、`home-reduced-motion.png`、`watch-reduced-motion.png`。

## 多标签开发环境问题及修复

初次多标签验证时，浏览器对 localhost 的带凭证请求持续排队，诊断性读请求在 2–3 秒内未完成；同一接口由命令行访问正常，浏览器 omit 凭证的请求也正常。核对本机依赖源码发现 Vite devtools 默认注入 `/__tsd/console-pipe/sse` 长连接，即使路由面板隐藏也存在。

让 Vite 插件与已有 `VITE_ROUTER_DEVTOOLS` 开关一致后，5 标签下的普通带凭证请求实测 11.2ms 返回，UI 启停和完整断线跨局流程通过。没有移除 Cookie 鉴权，也没有在业务请求加入超时重试或限制观众数来掩盖问题。

## 交付状态

最后确认频道 revision 42，`enabled=false`、`phase=stopped`、`lastMatchId=72884145-61e5-4ec5-94f1-49bd063a081f`。在没有活动对局时重新加载后台到最新代码，频道仍保持停止；开发网页和游戏服务保持可用。收尾时当前浏览器验证标签已关闭，未重新接管。没有提交或归档此变更。

OpenSpec 严格校验通过。既有主规格目录尚未汇总，工具提示 snake-presentation 与 snake-spectating 的 MODIFIED delta 将来归档前需要先处理旧基线；这不代表实现任务未完成，也没有为消除提示而覆写旧变更。
