# Phase 0 status

基线日期：2026-08-11

## 已完成

- 初始化 Git、TypeScript、格式化、结构化日志和测试框架
- 锁定 Node 依赖并生成 `package-lock.json`
- 定义配置 schema、项目 schema、核心事件类型和错误分类
- 实现飞书长连接适配器及 `im.message.receive_v1` 文本事件契约
- 实现 Codex App Server 默认 `stdio` JSONL 握手、线程和 turn 契约
- 实现 SQLite WAL、事件去重、任务状态、会话绑定和线程租约
- 实现单用户/单聊授权、项目白名单、路径逃逸防护和输出脱敏
- 实现 Bridge 纵向集成测试和 Windows 运维脚本
- 按 OpenAI 官方 App Server 文档复核线协议枚举及 `sandboxPolicy`

## 验证证据

- `npm run check`：通过
- `npm run build`：通过
- `npm test`：7 个测试文件、13 个测试全部通过
- `npm audit`：0 个已知漏洞
- 5 个 PowerShell 脚本语法检查：通过

## Gate A 尚未完成

- 尚未配置真实飞书 App ID、App Secret 和唯一允许用户的 `open_id`
- 尚未用手机向真实机器人发送消息并验证固定回复
- 当前环境中的 Microsoft Store `codex.exe` 执行别名返回 `Access is denied`，尚未完成真实 App Server 握手
- 因真实 Codex 未启动，尚未验证线程是否能在 Codex Desktop 中发现

在以上外部条件补齐前，Bridge 使用假飞书 payload 和假 App Server 做协议级验证，不访问其他真实项目。
