# Security model

ClawBridge 当前按“单一可信操作者、Codex Desktop 项目或受控手工项目、本机出站连接”设计。飞书身份校验、项目来源校验和对话所属项目校验是硬授权边界，不依赖模型提示词。

## 已实现

### 身份与消息入口

- 只允许配置中的唯一飞书 `open_id`
- 默认只允许 `p2p` 单聊
- SQLite 事件唯一约束防止消息重投导致重复执行
- 外发消息先持久化到 outbox；失败重试不会重新执行对应 Codex task

### 项目目录边界

- `projects.yaml` 是启动时导入的 bootstrap，不再是唯一项目来源；已登记项目和运行期变更保存在 SQLite
- 当 `codexDesktopProjects.enabled: true` 时，Codex Desktop `project-order` 中当前可见的所有本地项目自动成为可信项目，不再逐项目二次授权；状态文件只读，绝不写回
- Desktop 项目按内部 source ID 和规范化真实主目录同步；同路径静态项目会复用，移出 Desktop 可见列表的自动项目只停用、不删除历史
- Desktop 主状态读取或严格解析失败时 fail-closed；`.bak` 不作为执行授权源，缓存的自动项目暂时停用，主状态恢复后再自动启用
- Desktop 多目录项目目前只使用第一个 `rootPaths` 作为主 `cwd`，并明确提示其余目录未纳入当前 App Server 工作目录
- `/project create` 只有在 `allowCreateDirectory: true` 时可用，并且只能在首个 `projectManagement.allowedRoots` 下创建以项目 ID 命名的直属目录
- `/project import` 只有在 `allowRegisterExisting: true` 时可用，只接受相对于 `allowedRoots` 的路径
- `allowedRoots` 为空时不能通过机器人创建或导入项目；创建和导入开关默认关闭
- 创建、导入和任务执行前均使用真实路径及父子关系判断，阻止 `..`、绝对路径和连接点逃逸
- 动态登记不会允许任意用户输入成为工作目录；项目 ID、重复登记和歧义路径都会被拒绝
- 停用项目不会删除目录或对话历史；仍有排队或运行任务的项目不能停用

### 对话与任务隔离

- 每个项目以真实 `cwd` 作为 Codex 对话的归属边界；选择、查阅、重命名和归档前都会校验对话 `cwd`
- SQLite 按“飞书 chat + 项目”保存活动对话，并在项目内分配稳定本地编号；本地编号不能跨项目引用
- 普通消息入队时将项目和对话 ID 固化到任务记录，避免排队后因 UI 状态变化而被重定向
- chat 中存在排队或运行任务时，项目切换、对话切换和新建对话会被拒绝
- 同一 Codex 对话使用租约防止 Bridge 内并发写入；活动对话的管理操作也会被拒绝
- 桌面端与 Bridge 的跨进程线程占用目前仍无法检测，因此不能把 Bridge 内租约视为全局互斥锁

### Codex 进程与输出

- Codex sandbox 配置只接受 App Server 的 `readOnly` 和 `workspaceWrite`
- App Server 使用 `stdio`，Bridge 不创建监听端口
- 结构化日志字段和外发文本执行常见密钥脱敏
- 管理器将三项飞书凭据以 Windows 当前用户 DPAPI 密文保存到 `%LOCALAPPDATA%\ClawBridge`，不会写入项目配置、命令参数或日志
- Bridge 读取配置后立即从进程环境移除飞书凭据；启动 Codex App Server 时还会过滤常见 secret/token/key/password 环境变量
- 生命周期脚本通过带 PID 校验的 ready/shutdown 文件确认飞书已连接并请求优雅退出；超时才在再次验证进程身份后终止整棵进程树
- 登录自启动使用当前用户计划任务；注册前 fail-closed 检查脚本、构建、依赖、配置和数据目录 ACL，不会自动放宽或修改权限
- 在手机审批 broker 完成前默认使用 `approvalPolicy: never`；若手动启用按需审批，命令/文件审批会被自动 `decline`，其他不支持的阻塞交互会返回协议错误

## 配置示例

```yaml
projectManagement:
  allowedRoots:
    - D:/CodexWorkspace
  allowCreateDirectory: true
  allowRegisterExisting: true
  codexDesktopProjects:
    enabled: true
```

启用 `codexDesktopProjects` 代表操作者一次性授权飞书 Bridge 使用 Codex Desktop 当前可见的全部本地项目。`allowedRoots` 仍只约束 `/project create` 和 `/project import`；生产使用不要把磁盘根目录、用户主目录或含敏感数据的广泛目录加入 `allowedRoots`。

## 尚未实现

- 飞书审批卡片与 App Server 审批请求闭环
- 工作区连接点在任务运行期间发生变化时的持续检测
- 桌面端与 Bridge 跨进程线程占用检测
- 诊断包自动脱敏扫描
- Codex Desktop 私有项目状态 schema 的跨版本稳定保证；升级 Desktop 后需重跑发现器契约与真实只读同步 smoke

在这些能力完成前，不应让 Bridge 无人值守执行安装、联网、发布、删除或系统配置任务。DPAPI 绑定“同一台电脑上的同一 Windows 用户”，它解决的是凭据落盘和重复输入问题，不替代磁盘加密、Windows 账户安全或项目目录权限隔离。项目发现与内存数据库同步已使用本机真实 Desktop 状态完成只读 smoke；真实凭据的管理器首次连接、登录自启，以及 Desktop 与 Bridge 双进程同时写入仍需现场验证。
