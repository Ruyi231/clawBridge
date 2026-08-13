# Operations

## Commands

```powershell
.\scripts\install.ps1
.\scripts\doctor.ps1
.\scripts\start.ps1
.\scripts\status.ps1
.\scripts\stop.ps1
```

`install.ps1 -RegisterTask` 会创建当前用户登录触发的 Windows 计划任务；不带参数时只安装、构建和生成本地配置副本。

日志默认位于 `logs/`，状态库位于 `data/`，两者都被 Git 忽略。异常退出后，启动过程会把残留的 `running` 和 `waiting_approval` 任务标记为 `interrupted`，不会自动重复执行可能有副作用的操作。尚未开始的 `queued` task 会继续处理；未确认发送完成的 delivery 会进入重试，因此极端崩溃窗口下外发消息采用“至少一次”语义。

## Console smoke test

控制台模式不连接飞书，但仍使用配置项目和 Codex：

```powershell
$env:CLAWBRIDGE_FEISHU_ALLOWED_OPEN_ID = "console-owner"
$env:CLAWBRIDGE_CONFIG = (Resolve-Path config/local.yaml)
node dist/src/app.js --console
```

真实 Codex 当前不可执行时，使用 `npm test` 运行假 App Server 契约测试。
