# Protocol notes

## Feishu inbound

`im.message.receive_v1` 只接受 `message_type=text`。幂等键使用事件头中的 `event_id`；处理顺序为解析、授权、落库、快速返回，实际 Codex 工作由单并发 worker 执行。

## Codex App Server

Bridge 启动配置中的本地命令（默认 `codex app-server`），每行发送或接收一个 JSON-RPC/JSONL 消息。当前纵向链路使用：

1. `initialize`
2. `initialized`
3. `thread/start` 或 `thread/resume`
4. `turn/start`
5. `item/completed`
6. `turn/completed`

配置和线协议使用 App Server 的驼峰枚举值，例如 `approvalPolicy: onRequest`、`sandbox: workspaceWrite`；`turn/start` 使用 `sandboxPolicy` 对象并默认关闭网络访问。协议依据 [OpenAI 官方 Codex App Server 文档](https://developers.openai.com/codex/app-server)。

协议契约测试位于 `tests/contract/app-server.test.ts`，假服务位于 `tests/fixtures/fake-app-server.mjs`。真实 Codex 二进制版本必须在首次联调后记录；协议升级时先更新契约测试。

线程历史使用 `thread/list` 并显式包含 `appServer`、`cli` 和 `vscode` 来源；续接前使用 `thread/read` 检查 runtime status 与 `cwd`。活动任务取消使用 `turn/interrupt`，最终以 `turn/completed` 的 `interrupted` 状态为准。
