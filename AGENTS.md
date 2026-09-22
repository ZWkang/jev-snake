# Agent Instructions

## 项目入口

- 默认使用中文交流。项目为 SNAKE · JEV 贪吃蛇，使用 TypeScript、SolidJS、Hono 和 SQLite。
- 启动与使用说明见 [README.md](README.md)，详细配置见 [运行与部署](docs/running.md)。需求与验收以 `openspec/specs/`、`openspec/changes/` 和相关源码为准。
- 前端入口为 `src/routes/`、`src/features/`；服务端在 `server/`；共享协议与规则在 `shared/snake/`；测试在 `tests/`。

## 开发与验证

- 修改前检查分支和工作区，保留无关改动；优先修复根因，错误明确报告，不通过模拟成功或静默兜底掩盖问题。
- 使用 Bun，版本和命令以 `.bun-version`、`package.json` 为准，依赖使用 `bun.lock`。
- 测试使用 `bun run test <测试文件>`，不使用 `bun test`；按改动范围补充 `bun run typecheck`、`bun run check` 或 `bun run build`。纯文档改动检查链接、命令和 `git diff --check`。
- 沿用现有 Solid signal/effect/清理方式，以及仓库的格式与 lint 配置；只格式化任务文件。
- `src/routeTree.gen.ts` 通过 `bun run generate-routes` 生成，不手工编辑。服务端 NodeNext 相对导入保留 `.js` 后缀。
- 业务行为和模型请求以真实服务、持久化记录为准；修改时保留历史读取与回放兼容。测试替身与真实模型调用的结果分开报告。
- `.env`、密钥、数据库及 `.data/` 产物不提交；已有 `.env` 按需修改，不用示例文件覆盖。
- 提交只包含任务文件，提交说明使用简洁中文；交付时说明改动、验证结果和未完成项。

## 浏览器验证

- 默认使用 `agent-browser` CLI，开始前读 `agent-browser --help`。同一任务使用一个独立、简短的 session，默认无界面运行。
- 操作前读取 snapshot，操作后核对实际结果；需要视觉确认时截图。记录本任务的 daemon 和浏览器 PID。
- 结束、失败或中断时执行该 session 的 `close`，核对 session 和进程均已退出；批量操作用退出清理确保执行。只有用户明确要求保留或接管时才例外。
- 清理仅限本任务创建的进程，保留用户标签、登录状态和其他任务；清理失败必须报告。
