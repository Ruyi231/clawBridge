# Phase 1 status

基线日期：2026-08-11

## 已完成

- 所有已授权入站事件先写入 `inbound_events`，以 `event_id` 做全局幂等
- 飞书回调只执行解析、授权、SQLite 写入和 worker 调度，不等待外部消息发送
- 文本回复先进入持久化 delivery outbox，再由独立 worker 发送
- delivery 支持 `pending → sending → retry → sent/dead` 状态和指数退避
- Bridge 重启时恢复遗留的 `sending` delivery，并自动处理既有 `queued` task
- 超长消息在脱敏后分片，分片顺序持久化
- 增加 Phase 0 到 Phase 1 的 SQLite 兼容迁移

## Gate B 自动验证

- [x] 同一事件重复投递不会产生第二个任务或重复命令路由
- [x] 未授权用户无法触发 worker
- [x] Bridge 重启后排队任务仍存在并会继续处理
- [x] 超长回复能够完整分片
- [x] 外发失败会重试，而且不会重新运行 Codex task
- [x] 入站处理不会被缓慢的外发 API 阻塞
- [ ] 真实飞书断线后的自动重连尚未做网络故障演练

## 验证证据

- `npm run check`：通过
- `npm test`：9 个测试文件、23 个测试全部通过
- SQLite migration、outbox claim、重试、发送恢复和任务重启恢复均有自动测试

## 进入真实联调所需条件

- 在本机安全配置飞书 App ID、App Secret 和唯一允许用户的 `open_id`
- 发布飞书测试应用并订阅 `im.message.receive_v1`
- 提供可执行的 Codex CLI 路径；当前 WindowsApps 执行别名仍被系统拒绝
