# ClawBridge 2.0 status

基线日期：2026-08-11

## 已实现

### 项目管理

- `projects.yaml` 继续作为启动时的项目 bootstrap；运行期创建、导入、启用和停用状态持久化到 SQLite
- 可选 `codexDesktopProjects.enabled` 已在本机启用：Bridge 只读 Desktop 的 `project-order`/`local-projects`，自动同步当前可见项目名称、顺序和主目录，不要求逐项目授权
- Desktop 项目与现有静态项目按规范化真实路径合并；自动项目使用保留前缀的稳定内部 ID，移出 Desktop 列表后只停用、不删除历史
- `/project create <ID> [名称]` 只会在配置的首个 `projectManagement.allowedRoots` 下创建新的直属目录
- `/project import <ID> <相对路径> [名称]` 只会登记 `allowedRoots` 内已经存在的目录，不接受绝对路径
- 创建和导入分别受 `allowCreateDirectory`、`allowRegisterExisting` 开关控制；路径会经过 `realpath` 与父子关系校验
- SQLite 按“飞书 chat + 项目”保存各项目最后选择的对话；`/project use <名称|#编号|ID>` 切回项目时会恢复该项目上次选择的对话
- 停用项目只改变登记状态，不删除项目目录、Codex 对话或历史索引

### 对话管理

- 对当前项目使用稳定的 App Server API：`thread/start`、`thread/resume`、`thread/list`、`thread/read`、`thread/name/set`、`thread/archive` 和 `thread/unarchive`
- `/chat new [名称]` 立即创建并选择新对话；普通消息继续当前选择的对话
- `/chat list [archived|all]` 按当前项目 `cwd` 同步并列出普通或已归档对话
- `/chat show <编号或ID>` 读取对话历史；`/chat rename`、`/chat archive` 和 `/chat unarchive` 管理名称与归档状态
- SQLite 为每个项目中的 Codex 对话分配稳定本地编号，例如 `#1`；同步刷新不会改变已分配编号
- SQLite 也为项目分配稳定本地编号；Desktop 重排只改变列表顺序，不会让原 `#N` 指向其他目录
- 所有选取、查阅和管理操作都会校验对话 `cwd` 与当前项目真实根目录一致，阻止跨项目绑定
- 归档当前选中的对话会解除绑定；恢复归档不会自动切换，需再执行 `/chat use <编号或ID>`
- MVP 列表窗口固定为每次从 Codex 同步最近 50 条未归档对话和最近 50 条已归档对话；飞书端每种列表模式最多显示 50 条，不做自动分页。已索引的更早对话仍可按编号、完整 ID 或已索引前缀使用；全新数据库中超出同步窗口的旧对话需先用完整 Codex 线程 ID 读取，校验 `cwd` 后才会进入索引并获得编号
- 本机 Codex CLI `0.147.0` 的真实 smoke 中，尚无 turn 的纯空线程不一定出现在 `thread/list`；Bridge 自己通过 `/chat new` 创建的空线程会立即进入 SQLite 索引，其他客户端创建且从未产生 turn 的空线程可能需要完整 ID 才能首次导入

### 队列与并发语义

- 普通消息入队时固化 `projectId` 和当时选择的 `threadId`，后续状态变化不会把已入队任务重定向到其他项目或对话
- chat 中存在排队或运行中的任务时，切换项目、切换对话和创建新对话会被拒绝
- 同一 Codex 对话仍使用租约防止 Bridge 内并发写入；活动对话的重命名和归档等操作也会被拒绝
- `/stop` 关联当前 chat 的活动 `threadId`/`turnId`，通过 `turn/interrupt` 请求中止
- App Server 子进程异常退出会立即使活动任务失败，不等待 turn 超时

### 飞书交互卡片 MVP

- 发送“菜单”或 `/menu` 会打开手机控制台；普通文本仍作为当前项目和当前对话中的 Codex 任务
- 控制台提供选择项目、选择已有对话、立即创建新对话、项目群、停止任务、交还桌面和刷新状态按钮；对话列表还可查看最近内容
- “新对话”不要求先输入名称，会立即创建 Codex 对话，并在项目群中自动创建对应话题
- 项目卡片和对话卡片每页最多显示 10 条，支持上一页、下一页和当前页刷新；对话仍受每类最近 50 条的 App Server 同步窗口约束
- 文本命令全部保留，卡片动作复用相同的项目授权、对话归属、任务并发和 Desktop 交还检查
- 卡片动作只允许预定义的版本化 action，以及经过格式约束的内部项目/对话 ID；payload 不会被当作任意命令或 Codex 提示词执行
- 卡片回调与消息事件都使用飞书长连接；应用必须订阅 `im.message.receive_v1` 和 `card.action.trigger`。修改权限、事件或回调后需重新发布应用版本，本机代码修改后还需执行 `npm run build` 并重启 Bridge

### ClawBridge 2.0-A：项目群与话题隔离

- 每个项目最多绑定一个由机器人创建的私有 thread-style 飞书群；绑定关系持久化到 SQLite，不依赖内存状态
- 每个 Codex 对话最多绑定一个群话题根消息；同一个群话题不能指向多个对话
- 项目群只接受唯一授权用户在已登记话题内发送的普通任务；群主聊天流、未知群、未知话题和管理命令均不会执行 Codex
- 任务入队时持久化话题根消息 ID，Bridge 重启后仍会把入队、完成、失败、停止和释放警告通过 `reply_in_thread` 回到原话题
- 数据库 v6 增加项目群/话题绑定，v7 增加任务话题回传字段；旧项目、旧任务和旧 delivery 均保持兼容

### ClawBridge 2.0-B：任务中心与流式输出

- 控制台提供“全部任务”和“项目任务”两个入口，均从同一 SQLite 任务快照读取并支持每页 10 条分页
- Codex App Server 客户端归一化 `item/agentMessage/delta`，任务执行器把增量正文和计划摘要持久化到数据库 v8 字段
- 飞书通道通过 CardKit 创建 `streaming_mode` 卡片，按单卡单调 sequence 更新 markdown 元素，并在终态关闭流式模式
- 流式泵按约 400 ms 合并快速增量，保证 API 更新串行；最终文本会在关闭前强制 flush
- 流式能力是增强路径：创建、增量更新或最终关闭失败只记录脱敏警告，不替代持久 outbox 的最终成功/失败消息

### ClawBridge 2.0-C：项目创建与对话模型设置

- 项目列表提供“新建项目”表单；服务端仅接受 `form_value.projectName`，校验长度和 Windows 路径保留字符后生成内部 ID，并复用原有 allowedRoots、开关和 realpath 安全策略
- App Server 客户端使用本机 schema 中的稳定 `model/list`，分页读取非隐藏模型；`turn/start` 通过 `model` 和 `effort` 覆盖当前回合及后续回合
- SQLite v9 为每个 Codex 对话保存模型和推理强度；普通任务入队时将二者复制到 task 快照，保证排队期间修改设置不会重定向旧任务
- 模型和推理强度回调会重新查询当前 Codex 模型目录，并验证项目、当前对话、模型及受支持 effort，拒绝过期卡片和伪造选项
- 模型卡、新建项目表单已通过本地协议、数据库、渲染和 Bridge 集成测试；真实手机端仍需验证飞书客户端的 `form_submit` 展示与回传

### ClawBridge 2.0-D：远程审批与 Codex 提问

- App Server 的 server request 由客户端专用 handler 接管，不再由 app 入口无条件拒绝；未知方法仍返回 JSON-RPC `-32601`
- `item/commandExecution/requestApproval` 与 `item/fileChange/requestApproval` 显示一次性审批卡，只支持 `accept`、`decline` 和 `cancel`，不开放持久策略修改
- `item/tool/requestUserInput` 支持最多三个可选项和非秘密自由文本表单；多问题会在收齐全部 question id 后一次返回协议要求的 answers map
- 卡片使用随机 UUID 令牌绑定当前活动 task，消费后立即失效；任务终态会清除尚未处理的令牌
- 群话题审批卡通过 interactive reply 回到原话题；回调必须命中 Bridge 已成功发送的同 chat、同 audience 卡片，并再次验证项目群 owner
- `isSecret` 问题不会进入飞书消息或日志；无活动 thread/turn 所有权的 server request 会被拒绝

### ClawBridge 2.0-E：图片与文档附件

- 飞书消息解析支持 `image` 和 `file` 两类消息，并只保留资源 key、显示名称与类型；文件名不会直接参与本机路径拼接
- 任务入队时在 SQLite v10 中固化原消息 ID 和附件元数据，重启或排队期间不会把附件关联到另一条消息
- 飞书适配器通过消息资源接口下载附件，在写入前检查声明大小、写入后再次检查实际大小；超限文件会拒绝并删除临时副本
- 图片使用 Codex `localImage` 输入；普通文档仅允许 txt、md、json、yaml、yml、csv、log、xml、pdf，并以隔离本机路径追加到文本输入
- 每个任务使用独立的随机任务目录；无论成功、失败、取消或超时，任务终态都会递归清理该目录
- 默认单附件上限为 20 MiB，临时根目录默认为 `./data/attachments`，两者都可在 `bridge` 配置段调整
- 自动测试覆盖图片/文件事件解析、飞书下载契约、声明大小拒绝、任务快照持久化、Codex `localImage` 输入及任务完成后的目录清理；真实飞书附件 E2E 仍需现场验证

方法语义参考 [OpenAI 官方 Codex App Server 文档](https://developers.openai.com/codex/app-server)，未依赖实验性的对话分页接口。实际 JSON-RPC wire 字段和枚举以本机 Codex CLI `0.147.0` 运行 `codex app-server generate-json-schema` 生成的 schema 为当前基线，并已用同一二进制完成真实验证。

2026-08-11 的 App Server smoke 覆盖 `initialize`、最小只读回合、新建、命名、历史读取、未归档列表、归档列表、恢复和最终再次归档，所有断言均通过。测试对话最终保持归档。该结论不代表跨版本兼容，也不代表飞书中的旧 Bridge 进程已经重新加载本次构建。

## Codex 版本漂移边界

- 官网当前文档与本机已安装 Codex 可能在 approval、sandbox 等枚举拼写上不同，例如驼峰形式与带连字符形式；wire 实现应以本机生成 schema 和真实请求结果为准
- 仓库配置枚举与 App Server wire 枚举是两个边界，客户端负责显式映射，不能把网页示例或 YAML 值直接当作 JSONL wire 值
- Codex CLI/Desktop 升级后必须重新记录版本、运行 `codex app-server generate-json-schema`，并对比方法参数、响应类型及 `approvalPolicy`、`sandbox`、`sandboxPolicy` 等枚举
- schema 发生变化时，应先同步协议类型、客户端映射、假 App Server 和 contract tests，再运行类型检查、构建和协议测试
- 每次升级还需在无敏感数据的测试目录重跑真实只读 turn smoke，并重跑新建、列表、查阅、命名、归档和恢复对话的 smoke；全部通过后才能更新已验证版本基线

## 命令与兼容别名

| 新命令                      | 作用                          | 兼容命令及差异                                                |
| --------------------------- | ----------------------------- | ------------------------------------------------------------- |
| `/project list`             | 刷新并列出 Desktop 项目与目录 | `/projects` 等价                                              |
| `/project status`           | 查看当前项目、目录和对话      | `/status` 等价                                                |
| `/project use <名称或编号>` | 切换项目并恢复上次对话        | `/use` 保留旧语义：切换项目并清空当前对话，下一条任务新建对话 |
| `/chat new [名称]`          | 立即创建并选择对话            | `/new` 保留旧语义：只解除当前绑定，下一条普通消息再创建对话   |
| `/chat list`                | 列出当前项目的未归档对话      | `/threads` 等价                                               |
| `/chat use <编号或ID>`      | 选择已有对话                  | `/resume <ID>` 等价于按 ID 选择                               |

## 自动验证范围

- 新消息创建线程，后续消息继续同一线程，`/new` 后不续接旧线程
- 动态项目创建/导入的允许根目录、相对路径和连接点逃逸校验
- Desktop 状态严格解析、主文件失败时 fail-closed（`.bak` 仅诊断）、项目顺序、同路径复用、自动停用及中文/空格名称解析
- 项目切换恢复各自活动对话，稳定本地编号不会因重新同步改变
- 新建、列出、查阅、重命名、归档和恢复对话的协议契约
- 跨项目对话拒绝、活动任务期间切换拒绝及线程租约竞争拒绝
- `/stop` 中断与 App Server 异常退出处理
- 卡片 schema、项目/对话列表渲染、回调 payload 解析、非法 action 拒绝、单用户授权和卡片 delivery outbox

2026-08-11 基线验证：`npm run check`、`npm run build`、`npm run format:check` 全部通过；`npm test` 为 12 个测试文件、65 项测试全部通过，并完成真实 App Server smoke。

2026-08-12 Desktop 项目同步增量：`npm run check`、`npm run build`、`npm run format:check` 全部通过；沙箱内 Vitest 因 esbuild `spawn EPERM` 无法启动，经批准在沙箱外完成全量回归，14 个测试文件、84 项测试全部通过。本机真实状态只读 smoke 发现并同步 17/17 个可见项目，所有主目录解析成功。

## 尚待现场验证

- 在真实飞书客户端完成交互卡片 E2E：打开菜单、选择项目/对话、新建对话、刷新、停止任务及交还桌面；当前不能仅凭自动测试宣称该链路已通过
- 重启当前飞书 Bridge 进程后，从手机执行 `/projects`，确认直接显示 17 个 Desktop 项目及目录，并按名称/编号切换
- 验证同一对话能否同时被 Codex Desktop 发现并继续
- 完成 Desktop 与 Bridge 两个独立进程同时写入的故障演练

## 2.0 发布状态

- npm 软件包版本和 App Server `clientInfo.version` 已统一为 `2.0.0`
- 2.0 数据库迁移版本为 v10，旧数据只做增量扩展，不在启动迁移中删除历史
- 发布与回滚步骤、飞书权限检查和真实手机验收顺序见 `docs/RELEASE_2.0.md`

2026-08-13 发布验证：`npm run check`、`npm run build`、`npm run format:check` 全部通过；全量 Vitest 为 18 个测试文件、193 项测试全部通过。全新临时数据库和现用数据库的只读备份副本均成功迁移到 v10，副本中的 17 个项目及 11 条任务历史保留。受管脚本随后优雅停止旧实例、构建并部署私有运行副本；运行态只读核验确认版本为 `2.0.0`、状态 healthy、凭据已配置、登录自启动已安装、`approvalPolicy: onRequest`、17/17 个 Desktop 项目同步成功且 stderr 为空。

### v2.0.1 对话发现补丁

- Codex Desktop 历史对话的 `cwd` 可能仍保存迁移前路径；项目对话同步现在比较两侧 `realpath`，因此指向当前项目目录的 Junction/符号链接不再被误判为其他项目。
- 对于仅执行 `thread/start`、尚未产生 rollout 就被 App Server 释放的空对话，Codex 会返回 `no rollout found for thread id`。Bridge 现在会将该索引标为不可用、清除所有活动绑定和飞书话题路由，并从卡片与文本对话列表隐藏，避免继续选择后重复失败。
- 2026-08-13 验证：`npm run check`、`npm run format:check`、`npm run build` 通过；全量 Vitest 为 18 个测试文件、196 项测试全部通过。受管实例已优雅重启到 `2.0.1`，状态 healthy，17/17 个 Codex Desktop 项目同步成功。

上述运行态验证证明 2.0 已被本机进程加载，但没有替代“尚待现场验证”中的手机操作。尤其是项目群、CardKit 增量、表单、远程审批/提问和附件下载仍需使用无敏感数据的测试项目完成真实飞书 E2E。
