# Agent Instructions

## 浏览器操作

- 本项目需要打开网页、调试页面、截图或验证 UI 时，默认使用 **`agent-browser` CLI**。
- 开始前读取 `agent-browser --help`，按本机实际支持的命令操作。`agent-browser` 与 `ego-browser` 是不同工具，不要混用命令，也不要直接套用 Playwright API。
- 一个用户任务使用独立的命名 session，后续调用复用同一 `--session`。
- 操作前运行 `snapshot` 获取页面状态，操作后验证实际结果。需要视觉确认时再截图。
- 遇到连接或执行失败时，先诊断实际错误并明确报告。尊重用户接管，保留用户自己的标签页与登录状态。

最小调用示例（实际任务中替换任务名称和目标 URL）：

```bash
agent-browser --session snake-qa --headed open http://localhost:3000
agent-browser --session snake-qa snapshot
agent-browser --session snake-qa click @e1
agent-browser --session snake-qa snapshot
agent-browser --session snake-qa screenshot .data/qa/page.png
```

示例中的元素引用需替换为当前 `snapshot` 返回的引用。任务结束后，仅关闭自己创建且不需要交付用户的 session；需要保留预览时保留该 session。
