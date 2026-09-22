# 运行与部署

本页补充 [README](../README.md) 的运行、配置和维护说明。配置示例以 [`.env.example`](../.env.example) 为准，模型输入见 [V16 说明](jev-compact-growth.md)。

## 配置

本地服务通过 `.env` 读取配置，已有文件按需修改。部署时也可以由进程环境提供变量；修改后重启相关服务。

| 配置 | 默认值 / 用途 |
| --- | --- |
| `GAME_ADMIN_TOKEN` | 必填，至少 32 个字符，用于创建对局与管理员登录 |
| `SQLITE_PATH` | 必填，示例为 `.data/snake.sqlite`；生产使用持久目录 |
| `GAME_HOST` / `GAME_PORT` | `127.0.0.1` / `3001` |
| `GAME_SERVER_URL` | 可选，CLI 和网页代理使用的后端地址 |
| `JEV_PROVIDER` | `typesafe`，可显式选择 `openrouter` |
| `TYPESAFE_API_KEY` | Typesafe 凭证，供该服务商的环境单 Key 模式使用 |
| `OPENROUTER_API_KEY` | OpenRouter 凭证，供该服务商的环境单 Key 模式使用 |
| `JEV_MODEL` | 可选；Typesafe 默认 `jev-1.13.0`，OpenRouter 默认 `typesafe/jev-1.13` |
| `WATCH_PUBLIC_ORIGIN` | `http://localhost:3000`；填写页面的精确 Origin，无末尾斜线 |
| `WATCH_INTERMISSION_MS` | `5000`；局间等待，0 表示结束清理后立即准备下一局 |
| `WATCH_SESSION_TTL_MS` | `28800000`，管理员会话默认 8 小时 |
| `SNAKE_WIDTH` / `SNAKE_HEIGHT` | 未设置时按种子选择棋盘尺寸 |
| `SNAKE_OBSTACLES` | 未设置时按棋盘面积计算 |
| `SNAKE_SEED` | 未设置时每局生成新种子 |
| `JEV_DYNAMIC_ANALYSIS` | 默认启用 V16；`false` 显式使用 V13 |
| `JEV_STAGNATION_GUARD` | `true`；`false` 关闭停滞费用保护 |
| `JEV_STAGNATION_MAX_VISITS` | `3`，同一完整局面的访问次数阈值 |
| `JEV_STAGNATION_MAX_NO_APPLE_MOVES` | 未设置时为 `max(64, 2 × 可走格数)` |
| `JEV_CONTRIBUTIONS_ENABLED` | `false`；是否接收新的 Key 贡献 |
| `JEV_CREDENTIAL_POOL` | `false`；连续观战是否使用贡献凭证池 |
| `CREDENTIALS_MASTER_KEY` | 开放贡献或启用凭证池时必填，32 字节 base64 主密钥 |
| `COMMUNITY_WECOM_JOIN_URL` | 可选，真实企微入群 HTTPS 链接 |
| `COMMUNITY_WECOM_QR_URL` | 可选，同源图片路径或 HTTPS 二维码图片 |
| `COMMUNITY_MAX_BODY_BYTES` | `16384`，社区请求体字节限制；0 显式关闭 |
| `VITE_ROUTER_DEVTOOLS` | `false`；显式启用前端路由调试工具 |

新局仅支持 `response` / `single_step`，每次有效响应推进一步。旧 `SNAKE_TICK_MS` 只输出弃用提示；CLI 的 `--tick-ms`、`fixed` 和 `two_step_fallback` 会明确拒绝。历史搜索实验的参数不控制当前实时模型。

连续观战的随机棋盘为 8×6、8×8、10×8、12×9、14×10、16×12；CLI 使用 8×6 至 24×18 的独立尺寸池。恢复和分支沿用保存的布局、种子及 RNG，不重新抽取。

## 连续观战与管理员

打开 `/watch?admin=1`，输入 `GAME_ADMIN_TOKEN` 解锁。参数只显示入口，实际写操作仍由服务端会话与 Origin 校验。

| 操作 | 效果 |
| --- | --- |
| 开启连续观战 | 开始首局，正常结束后按局间等待进入下一局 |
| 停止连续开局 | 当前已开始的对局继续，结束后不再开局；倒计时中的下一局取消 |
| 立即停止本局 | 中断本局、取消在途请求，同时停止后续开局 |
| 注销或关闭页面 | 不改变已保存的频道运行意图 |

`/watch` 跟随频道，`/watch/:matchId` 固定观看单局。首次访问不会自动开局；无观众时，已启用的频道仍会运行。管理员在同一入口管理反馈可见性和贡献 Key。

服务重启后，无已保存故障的未完成响应局恢复同一个 matchId、身体、RNG、历史与累计有效时间。停机时间不补步，已停止的频道不自动开启；已有故障需要管理员明确恢复。

管理员会话使用 HttpOnly、SameSite=Strict cookie，路径限定为 `/api/watch-admin`；HTTPS Origin 使用 Secure。使用 `localhost` 和 `127.0.0.1` 时应与配置的 Origin 一致。

## Key 贡献与费用

贡献弹窗要求用户确认一次真实验证及后续观战使用授权。服务端调用对应 JEV 模型，校验结构化结果，验证与持久入库均成功后才启用。感谢动效只播放一次，文案保留；减少动态效果时显示静态结果。

Key 以 AES-256-GCM 密文保存。主密钥与数据库分离并妥善备份；重新生成主密钥不会自动解密旧数据。公开页面、回放与管理员列表均不返回完整 Key。本人可凭原 Key 撤回，管理员可停用；已发出的请求可能继续完成并计费，后续调用停止。撤回清除活动密文，但不保证旧备份中的密文被物理擦除。

凭证池按当前 `JEV_PROVIDER` 和已验证目标模型选择 Key，正常情况下逐局轮换；CLI 保持环境单 Key 模式。不同服务商的贡献分别保存，不自动切换服务商。更换目标模型后需针对新目标重新验证。

明确凭证失效或余额耗尽时，会保存失败事实并选择同服务商下一把 Key。当前分类见 [`transport-error.ts`](../server/jev/transport-error.ts)：Typesafe 已确认的 401，以及 OpenRouter 本层 401 或明确额度耗尽的 402 可轮换；限流、临时预算、权限、网络、格式及未知错误暂停频道。没有可用 Key 时也会暂停，新贡献不会自动清除已有故障。

重复请求复用验证回执。上游已调用但本地未确认时记录为“未确认”，不自动补发；显式重新验证可能再次产生费用。管理面板区分验证、启用与实际调用，记录调用次数和可得的输入用量，不提供完整账单结算。

### 停滞保护

费用保护在下一次模型请求发出前检查真实历史：同一完整局面达到访问阈值，或未吃苹果的移动数达到阈值时，中断本局。它不是判输或无解证明。

- `stagnation_loop`：关闭连续开局，等待管理员恢复。
- `stagnation_no_apple`：频道原本启用时按倒计时进入下一局。

只有吃苹果重置进食进度，星星得分、等待和重启不会清零；用户已经停止的频道不会被保护逻辑重新开启。

## CLI 与历史分支

服务运行后，在另一个终端执行：

```sh
bun run jev
bun run jev --width 24 --height 18 --obstacles 12 --seed experiment-01
```

CLI 默认运行一场真实对局，Ctrl+C 停止本局并保留已提交记录。`--name` 可设置对局名称，`--url` 可指定游戏服务地址。

从历史响应局的某个事件继续：

```sh
bun run jev --fork-match <match-id> --fork-seq <event-seq> --name "历史分支"
```

`--fork-seq` 是事件序号，不是步数。分支只接受未结束的源局面，继承配置、身体、RNG 与已执行历史，不接受地图或步频覆盖参数。原局与其后续事件保持不变。旧 fixed/两步记录可查看回放，不作为新局或新分支执行模式。

回放中的 `requestMs` 是模型往返耗时，`reactionMs` 是观察到动作收件的端到端耗时，`lastStepDurationMs` 是相邻移动间隔。缺失指标显示为未记录。

## 部署与数据维护

生产需要两个常驻服务、持久磁盘和反向代理：

```sh
bun run build
bun run start:server
# 另一个进程
bun run start
```

反向代理将 `/api/` 和 `/ws/` 转给 Hono，其余请求转给 Solid Start；WebSocket 需要转发 Upgrade。Key 贡献在生产使用 HTTPS，`WATCH_PUBLIC_ORIGIN` 应为实际站点 Origin。仓库中的 `vercel.json` 不代表 SQLite 后端已部署。

本地 `bun run serve` 使用构建后的后端和 Vite preview，保存源码不会热更新。API 代理目标在构建时由 `GAME_SERVER_URL` / `GAME_PORT` 确定；开发模式由 Nitro 代理 HTTP、Vite 代理 WebSocket。

当前 SQLite schema 为 v3，升级新增社区和凭证表，保留对局、事件与频道记录。数据库使用 WAL 和事务写入。升级前停止写入并做一致性备份；不要在运行中仅复制主库文件而遗漏 WAL。

回滚可关闭贡献和凭证池开关，同时保留兼容 v3 的后端。若必须运行只支持 v2 的旧后端，应停写并明确恢复升级前备份，备份之后的记录不会包含在旧库中。不要直接改低 schema 版本或删除新表。

## API 入口

| 入口 | 用途 / 权限 |
| --- | --- |
| `GET /api/health` | 服务及模型配置状态 |
| `GET /api/matches` | 对局列表，支持参与者、状态和游标分页 |
| `GET /api/matches/:id` | 最新已提交局面 |
| `GET /api/matches/:id/events` | 按事件 seq 读取历史 |
| `POST /api/matches` | 管理员认证创建对局 |
| `POST /api/matches/:id/fork` | 管理员认证创建历史分支 |
| `GET /api/matches/:id/decision-context` | 当前决策上下文，需要该局控制 token |
| `WS /ws/matches/:id/watch` | 游客只读订阅 |
| `WS /ws/matches/:id/control` | 控制 token 认证的单步控制通道 |
| `GET /api/watch-channel`、`WS /ws/watch-channel` | 连续频道状态与订阅 |
| `/api/watch-admin/session`、`/api/watch-admin/commands` | 管理员登录与频道命令 |
| `GET /api/community` | 公开的社区功能配置 |
| `GET/POST /api/feedback` | 读取可见反馈 / 匿名投稿 |
| `POST /api/key-contributions` | 授权验证与贡献 Key |
| `POST /api/key-contributions/status` | 按 requestId 查询验证结果 |
| `POST /api/key-contributions/revoke` | 持原 Key 撤回贡献 |
| `/api/watch-admin/feedback`、`/api/watch-admin/credentials` | 反馈与凭证管理，需要管理员会话 |

请求格式以 [`shared/snake/`](../shared/snake/) 的协议及 [`server/community/routes.ts`](../server/community/routes.ts) 为准。游戏控制使用协议 v1 的 start/action/stop；对局记录版本、数据库 schema 版本和控制协议版本是不同概念。相同 requestId 同内容返回原回执，不重复推进或计费验证；不同内容明确冲突。
