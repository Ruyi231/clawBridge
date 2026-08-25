# ClawBridge 2.0

ClawBridge 是一个运行在 Windows 本机的单用户控制桥：它通过飞书长连接接收手机消息，将任务送入本机 Codex App Server，再把结果发回飞书。电脑无需开放公网端口。

当前版本为 **ClawBridge 2.5.1**。仓库已完成 Phase 0–2 以及 ClawBridge 2.0-A/B/C/D/E 的本地实现：除原有单聊控制台、项目/对话管理和持久队列外，还增加了项目群/对话话题隔离、任务中心、CardKit 流式任务卡、卡片新建项目、按对话保存模型与推理强度、命令/文件审批和 Codex 提问卡片，以及图片与受限文档附件输入。2.5.1 为每个对话话题持久保存唯一的模型工具栏消息，后续任务完成时只原位更新，不再重复发送“切换模型”卡片；原卡失效时才补发并绑定替代卡。2.5.0 改为由 Codex Desktop 决定飞书项目的启用生命周期：Bridge 只在 Desktop 完全关闭后登记新项目，Desktop 中移除项目会自动在飞书停用，重新加入同一目录则恢复；全程不提供飞书删除入口，也不删除目录、对话或项目群。

## 环境要求

- Windows 10/11
- Node.js 22 或更新版本
- 已登录且能运行 App Server 的 Codex CLI/Desktop
- 飞书企业自建应用，已启用机器人和长连接事件订阅

## 快速安装

```powershell
git clone https://github.com/Ruyi231/clawBridge.git
Set-Location clawBridge
.\scripts\install.ps1
```

安装脚本会生成未跟踪的 `config/local.yaml`、`config/projects.yaml`，安装锁定依赖并构建。示例 bootstrap 项目使用相对路径 `.`，所以无论仓库克隆到哪个盘符，都指向当前 ClawBridge 目录。真实凭据、本机 YAML、SQLite 和日志均被 `.gitignore` 排除。

接着双击无控制台窗口的 `ClawBridge Manager.vbs` 保存三项飞书凭据并启动；`ClawBridge Manager.cmd` 作为兼容入口也会立即转交给该隐藏启动器。完整的新电脑安装、旧实例状态迁移和项目路径规则见 [安装与迁移](docs/MIGRATION.md)，飞书开发者后台逐项配置和两种 Open ID 获取方法见 [飞书开放平台配置清单](docs/FEISHU_SETUP.md)。

`config/projects.yaml` 可保留少量静态 bootstrap 项目。若希望飞书端直接复用当前 Windows 用户 Codex Desktop 左栏中的本地项目，保留自动同步；不要把真实密钥写入 YAML 或提交到 Git。

如需在飞书中创建或导入项目，还要编辑 `config/local.yaml` 中的项目管理配置：

```yaml
projectManagement:
  allowedRoots:
    - D:/Work
  allowCreateDirectory: true
  allowRegisterExisting: true
  codexDesktopProjects:
    enabled: true
    registerCreatedProjects: true
```

- `allowedRoots`：机器人可以创建或导入项目的父目录列表。`/project create` 使用列表中的第一个目录，`/project import` 会在所有目录中查找。
- `allowCreateDirectory`：是否允许 `/project create` 新建目录；不需要此能力时保持 `false`。
- `allowRegisterExisting`：是否允许 `/project import` 登记已有目录；不需要此能力时保持 `false`。
- `codexDesktopProjects.enabled`：启用后，读取**当前 Windows 用户**的 Codex Desktop 本地项目状态，把其当前可见项目按原顺序自动登记为可执行项目，不会继承仓库发布者的项目。
- `codexDesktopProjects.registerCreatedProjects`：显式开启后，飞书表单新建成功的项目进入 `pending` 状态；Bridge 检测到 Codex Desktop 完全关闭后才原子登记到当前 Windows 用户的 Desktop 状态。下次 Desktop 启动并看到该目录后转为 `synced`。以后从 Desktop 左栏移除会转为 `removed` 并在飞书自动停用；在 Desktop 重新加入同一目录即可恢复。Bridge 不会反复补回已移除项目。该开关默认关闭，示例配置为方便飞书新建项目而明确开启。
- `codexDesktopProjects.stateFile`：可选覆盖 Desktop 状态文件路径；未配置时使用 `CODEX_HOME/.codex-global-state.json`，否则使用当前用户的 `~/.codex/.codex-global-state.json`。

路径既可以写成 Windows 正斜杠形式（如 `D:/Work`），也可以使用 YAML 中正确转义的反斜杠。建议只配置专门存放代码的窄范围目录，不要配置磁盘根目录或用户主目录。

每次换电脑、换 Windows 用户或修改项目配置后，都应构建并运行只读路径诊断：

```powershell
npm run build
npm run doctor:projects
```

诊断会列出 bootstrap 项目、`allowedRoots` 以及当前用户 Codex Desktop 项目解析后的真实目录；任何不存在、不是目录或重复指向同一目录的配置都会失败。

### ClawBridge 管理器（推荐）

构建完成后，直接双击仓库根目录的 `ClawBridge Manager.vbs`。这是推荐入口，只显示 WinForms 管理器，不保留 CMD/PowerShell 控制台窗口；旧的 `ClawBridge Manager.cmd` 会转交给同一隐藏入口，但 Windows 在启动 `.cmd` 时仍可能短暂闪过一个控制台。管理器提供三个输入框：

- `App ID`：飞书开放平台“凭证与基础信息”中的 `cli_...`
- `App Secret`：同一页面中的应用密钥，输入框不会回显
- `Open ID`：唯一允许控制机器人的飞书用户 `ou_...`

Open ID 输入框旁的“如何获取？”包含两种流程：已安装飞书 CLI 时运行 `lark-cli auth status --json` 并读取 `identities.user.openId`；没有 CLI 时先填 `ou_pending_pairing`，启动后单聊机器人，再把机器人回复的 `ou_...` 写回管理器。完整步骤与安全注意事项见 [飞书开放平台配置清单](docs/FEISHU_SETUP.md#4-取得当前用户-open-id)。

第一次填写后点击“保存并应用”。三项凭据会使用 Windows 当前用户的 DPAPI 加密，保存到 `%LOCALAPPDATA%\ClawBridge\credentials.json`；不会写入仓库、YAML、命令行参数或 PowerShell 历史。以后直接在管理器中启动、停止、重启或“构建并重启”，无需再次输入，也无需使用 `npm start`。

管理器只有在飞书长连接真正就绪后才显示“已连接”。若显示“连接异常”，查看窗口中的错误日志，并优先核对 App ID、App Secret、应用版本发布状态和长连接事件配置。

“电脑登录自启动”使用当前 Windows 用户的计划任务。启用前会检查运行目录权限；如果仓库可被其他本机账户修改，管理器会拒绝创建自启动任务且不会自动修改 ACL。这样可以避免其他账户篡改登录脚本后借用你的 DPAPI 凭据。需要启用时，应先把项目放到仅当前用户、SYSTEM 和 Administrators 可写的目录，或在明确确认后单独收紧目录权限。

命令行方式仍可用于排错：

```powershell
.\scripts\configure-credentials.ps1
.\scripts\start.ps1
.\scripts\status.ps1
.\scripts\restart.ps1 -Build
.\scripts\stop.ps1
```

## 飞书应用配置

请严格按 [飞书开放平台配置清单](docs/FEISHU_SETUP.md) 操作。最容易遗漏的是：

1. 企业自建应用必须启用机器人能力，并只向实际操作者开放。
2. 在权限管理中批量导入 [ClawBridge 已验证应用权限](docs/feishu-permissions.json)；权限用途、租户差异和错误补充见[飞书配置清单](docs/FEISHU_SETUP.md)。
3. 事件配置使用长连接并添加 `im.message.receive_v1`。
4. 回调配置也使用长连接并添加 `card.action.trigger`。
5. 每次修改权限、事件或回调后都要创建并发布新版本。
6. Open ID 属于具体飞书应用；换 App ID 后必须重新查询，不能照抄其他部署的 `ou_...`。

启动前运行诊断：

```powershell
.\scripts\doctor.ps1
.\scripts\start.ps1
```

修改代码后，需要重新构建并重启正在运行的 Bridge；仅重新发布飞书应用不会加载本机新代码：

```powershell
.\scripts\restart.ps1 -Build
```

### 手机交互卡片

在机器人单聊中发送“菜单”或 `/menu`，即可打开 ClawBridge 控制台，不必在手机上输入项目名、对话名或编号。推荐流程如下：

1. 点击“选择项目”，从列表选择任务要运行的本机项目；Bridge 会准备该项目的私有项目群。
2. 单聊控制台只保留项目选择、项目群入口、刷新和交还 Desktop，不再混入对话与任务操作。
3. 进入项目群后，使用群内项目控制卡继续已有对话、新建对话或查看项目任务；模型设置属于具体对话，不放在项目级控制卡中。
4. “继续对话”会创建或复用该 Codex 对话的独立话题，并恢复历史；无需再通过卡片详情页翻页查看内容。
5. “新建对话”只创建一个等待首条任务的新话题，不会预先制造空 Codex 线程。进入该话题发送第一条普通消息后，Bridge 才创建真实 Codex 对话并固定绑定话题。
6. 后续任务、流式进度、审批、提问和终态结果都留在对应话题中，不占用机器人单聊控制台的消息上下文。
7. 继续已有对话后、以及每项任务完成后，话题底部会出现单行模型条，只显示当前模型、推理强度和“切换”。展开后的模型列表每个模型只占一行，不显示介绍文字；选择模型或推理强度后原卡片会直接收起，不返回项目控制台。也可以在话题中单独发送“模型”重新打开设置。模型条不提供冗余的“查看状态”。设置只作用于该 Codex 对话；任务入队时会固化设置，之后修改不会改变旧任务。新建的待绑定话题在首条任务创建真实 Codex 对话后才显示模型条，首条任务使用默认模型。

单聊控制台提供“剩余额度”按钮。它通过 Codex App Server 的 `account/rateLimits/read` 读取当前主窗口、次窗口和可用的月度限额百分比及重置时间；不会读取或显示 App Secret、登录令牌等凭据。额度卡可直接刷新，并可返回控制台。

项目列表中的“新建项目”会打开飞书表单。填写项目名称并提交后，Bridge 会在 `allowedRoots` 的首个目录下创建一个**同名**、受路径策略约束的新目录，自动登记、选择项目并创建项目群；例如 `test_codex` 会创建为 `<首个 allowedRoot>/test_codex`，不再落到 `mobile-时间戳` 目录。内部仍使用不可见的 `mobile-*` ID。需要 `allowCreateDirectory: true`。同时启用 `codexDesktopProjects.enabled` 和 `registerCreatedProjects` 时，新项目不会修改正在运行的 Desktop 状态：请完全退出 Desktop，保持 Bridge 运行并等待至少 5 秒，再启动 Desktop。表单能力要求飞书客户端支持输入框和 `form_submit`。

当 Codex 因命令执行或文件修改请求审批时，任务会进入“等待审批”，原项目话题内会出现“允许一次 / 拒绝 / 拒绝并停止”卡片；机器人单聊任务则在单聊中显示。Codex 的 `request_user_input` 选择题会显示选项卡，自由文本问题会使用表单输入。回调采用一次性随机令牌，重复点击或任务结束后的旧卡片会被拒绝；秘密输入问题不会转发到飞书。当前只提供单次允许，不提供“本会话全部允许”或持久修改安全策略。

选择项目后会出现“项目群”按钮。已存在的项目群使用纯 AppLink 一次跳转，不再同时触发耗时回调；选择项目时会先检查并准备群，因此退出丢弃后重新选择项目，也只需点击一次“项目群”即可进入新群。群主聊天流只用于项目控制卡，可在群内查看/继续对话、新建对话和查看项目任务。每个 Codex 对话仍单独对应一个飞书话题：继续已有对话时会恢复历史，新建对话时先建立待绑定话题，首条任务启动后再绑定真实 Codex 线程。以后在该话题中直接发普通文本，Bridge 会按 `群 chat_id + 话题 root_id` 固定路由，入队、流式进度、完成、失败和停止结果也只回复到原话题。未登记的群、群主聊天流中的普通文本、未知话题、错误项目或其他发送者都不会执行 Codex。

2.1.1 会把飞书卡片的原位更新同步写回 outbox 索引。项目列表卡被改写为单聊控制台后，退出并丢弃项目群能够准确更新用户正在操作的那张卡，而不是误更新更早的控制卡；对 2.1.0 遗留记录会直接使用同一单聊最近的已发送 P2P 卡片。重新选择项目后，新群入口不再需要反复刷新或多次重选。

2.1.2 修复了项目群虽然由飞书返回 `chat_id`、却因没有稳定的群主成员而立即变成 `dissolved` 的问题。Bridge 创建群时会明确指定唯一授权用户为群主、把机器人设为群管理员，并在保存群入口前重新读取群状态；群主暂时缺席时自动补加成员，已解散或不可用的新群不会写入数据库。每次重建使用新的幂等键，避免飞书再次返回此前已经失效的群。

2.1.0 会在再次打开旧项目群时把旧 `thread` 消息模式迁移为 `chat` 控制台模式，但不会合并或删除已有对话话题。旧卡片中的“查看内容”动作会兼容转换为“继续对话”，不再生成卡片历史详情页。群内控制卡只允许操作当前群绑定的项目；“返回项目”回到当前项目控制卡，不会跳回单聊项目选择器。

项目短期不用时可以在飞书客户端主动退出项目群。下次在机器人单聊中再次点击“项目群”，Bridge 会检查原群和成员状态：原群仍存在时自动重新邀请唯一授权用户，原有话题与 Codex 历史保持不变；原群已解散或群 ID 失效时重建群，并在用户再次进入各 Codex 对话时重建对应话题。自动重新邀请依赖上述三个群成员/群管理权限；修改权限后必须重新发布飞书应用版本。

任务开始后，Bridge 会在原话题创建 CardKit 流式卡片，并把 Codex 的 `item/agentMessage/delta` 以约 400 ms 节流更新到同一张卡片；计划更新也会进入任务摘要。流式卡片创建或更新失败不会让 Codex 任务失败，最终文本仍通过持久 outbox 可靠发送。SQLite 会保存最近的增量正文与摘要，Bridge 重启后任务中心仍可查询。

可以直接向机器人单聊或已登记的项目话题发送图片、文本、Markdown、JSON、YAML、CSV、日志、XML 或 PDF 文件。Bridge 会先将附件元数据和原飞书消息 ID 固化到任务快照，再按任务下载到 `bridge.attachmentDirectory` 下的隔离临时目录；图片通过 Codex `localImage` 输入提交，普通文档以明确的本机只读路径附加到任务说明。单个附件默认上限为 20 MiB，可用 `bridge.attachmentMaxBytes` 调整；任务结束后临时目录会自动删除。未知文件类型、超限文件或不支持附件下载的通道会安全失败，不会把飞书文件名当作本机路径使用。

当前卡片 MVP 的项目列表和对话列表每页最多显示 10 条，可用“上一页/下一页”浏览。对话数据仍受 Codex 最近 50 条未归档记录的同步窗口约束；更早记录及其他高级操作可继续使用 `/project list`、`/chat list` 等文本命令。全部原有命令仍保留。

全局项目选择和新建项目卡只在机器人单聊中生成；项目内的对话选择、新对话、项目任务和模型卡可在已登记项目群中生成，任务流、审批和提问卡片则回复到对应话题。卡片点击仍执行服务端校验：只有 `CLAWBRIDGE_FEISHU_ALLOWED_OPEN_ID` 绑定的用户、从本 Bridge 已成功发出且 chat/audience 匹配的卡片才能操作；群卡还会再次核对项目群 owner 和项目 ID。卡片 payload 只接受预定义动作、一次性交互令牌及受格式限制的内部项目/对话 ID，不会作为 shell、Codex 提示词或任意 Bridge 命令执行。

当前仓库覆盖了卡片解析、渲染、动作路由、授权和持久 outbox 的自动测试，但尚未在真实飞书客户端上完成完整卡片端到端验证。首次启用后应依次现场检查“菜单”、项目选择、表单新建项目、对话选择、新对话、模型设置、停止任务、交还桌面和刷新。

## 项目与对话管理

ClawBridge 把“项目”和“对话”分开管理：项目对应一个本机工作目录，对话对应该目录下的一个 Codex 线程。启用 Desktop 自动同步后，`/projects` 会直接读取 Codex Desktop 当前可见的项目名称、顺序和主目录；每个项目仍独立记住最后选择的对话。普通文本会作为任务发送到当前项目、当前对话；若当前项目尚未选择对话，则会在收到第一条普通任务时创建对话。

### 项目命令

| 命令                                         | 作用与用法                                                                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/project list`                              | 刷新并按 Codex Desktop 顺序列出项目名称、真实目录和启用状态；`▶` 表示当前项目，`/projects` 与其等价。                                            |
| `/project create <ID> [项目名称]`            | 在 `allowedRoots` 的第一个目录下新建 `<ID>` 目录并登记项目。例如 `/project create wafm "WaFM experiments"`。                                      |
| `/project import <ID> <相对路径> [项目名称]` | 登记 `allowedRoots` 下已经存在的目录。例如根目录为 `D:/Work` 时，`/project import demo demo "Demo"` 会导入 `D:/Work/demo`。路径含空格时请加引号。 |
| `/project use <名称\|#编号\|ID>`             | 按 Desktop 项目名称、列表编号或内部 ID 切换项目，并恢复该项目上次选择的对话。名称含空格时加引号，例如 `/project use "Codex Conversation Tree"`。  |
| `/project status`                            | 查看当前项目名称、稳定 `#编号`、真实目录、启用状态以及当前对话。                                                                                  |
| `/project disable <ID>`                      | 停用手工登记的项目。不会删除项目目录或对话历史；该项目有排队或运行任务时会拒绝操作。Desktop 项目请在 Desktop 中移除。                             |
| `/project enable <ID>`                       | 重新启用手工停用的项目；Desktop 项目重新加入 Desktop 后会自动启用。                                                                               |

手工创建/导入项目时，项目 ID 只能使用小写字母、数字、下划线和连字符，最长 64 个字符。Desktop 自动项目使用内部稳定 ID，日常无需复制它，直接使用名称或 `/project list` 的 `#编号` 即可。

项目 `#编号` 由 Bridge 持久化分配，Desktop 调整展示顺序后编号不会改指向另一个目录。长期使用时仍建议按项目名称切换；项目名称重复时，Bridge 会要求改用 `/project list` 显示的稳定 `#编号`。

### 对话命令

执行对话命令前，先用 `/project use <名称|#编号|ID>` 选择项目。`/chat list` 为每个项目维护稳定的本地编号（例如 `#1`、`#2`），日常操作优先使用短编号，不必复制完整 Codex 线程 ID。

| 命令                               | 作用与用法                                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------------- |
| `/chat new [名称]`                 | 立即创建并选择一个新对话。示例：`/chat new "训练脚本排错"`。之后发送的普通消息会继续该对话。  |
| `/chat list`                       | 刷新并列出当前项目未归档的对话。                                                              |
| `/chat list archived`              | 仅列出已归档对话；`/chat list all` 同时列出未归档和已归档对话。也支持 `--archived`、`--all`。 |
| `/chat use <编号或ID>`             | 选择一个未归档且空闲的对话。例如 `/chat use 2`、`/chat use #2` 或 `/chat use <完整线程ID>`。  |
| `/chat show <编号或ID>`            | 查阅对话信息及最近 20 条用户/Codex 文本消息，不会切换当前对话。                               |
| `/chat rename <编号或ID> <新名称>` | 重命名空闲对话，名称最长 120 个字符。例如 `/chat rename 2 "部署问题"`。                       |
| `/chat archive <编号或ID>`         | 归档空闲对话；若它正是当前对话，会同时解除当前绑定，但不会删除历史。                          |
| `/chat unarchive <编号或ID>`       | 恢复已归档对话，但不会自动切换；恢复后再执行 `/chat use <编号>`。                             |
| `/chat close`                      | 关闭当前飞书对话并释放 Codex App Server，使同一对话可立即交给 Desktop；不删除或归档历史。     |

除了本地编号和完整 ID，也可以使用已被本地索引、长度至少 8 位且唯一的线程 ID 前缀。若前缀不唯一，机器人会要求输入更长的 ID。对话严格归属于创建它的项目，不能在另一个项目中误选或继续。

当前 MVP 的列表同步有固定窗口：每次执行 `/chat list`、`/chat list archived` 或 `/chat list all`，Bridge 都会分别从 Codex 同步当前项目最近 50 条未归档对话和最近 50 条已归档对话；飞书端每种列表模式最多显示 50 条，不会自动翻页扫描全部历史。已经进入 SQLite 索引但早于该窗口的对话仍可用本地编号、完整 ID 或已索引的唯一 ID 前缀操作。使用全新数据库时，早于两个同步窗口的旧对话尚无本地编号或前缀索引，需要输入完整 Codex 线程 ID；Bridge 会通过 `thread/read` 校验其项目 `cwd`，成功后补建本地索引并分配编号。

本机 Codex CLI `0.147.0` 的真实 smoke 还表明：只执行 `thread/start`、尚未产生任何 turn 的纯空线程不一定出现在 App Server 的 `thread/list` 中。ClawBridge 用 `/chat new` 创建线程后会立即写入本地索引，因此该线程在飞书端仍可列出并跨重启恢复；但由其他客户端创建、从未产生 turn、且尚未被 Bridge 索引的空线程，可能需要完整线程 ID 才能首次导入。

ClawBridge 与 Codex Desktop 共享底层 Codex 对话历史，但两端使用独立的 App Server 进程和客户端侧栏索引。ClawBridge 新建线程会按当前本机协议写入 `threadSource: "user"`，以贴近 Desktop 创建普通用户任务时的元数据；已经打开的 Desktop 仍不会收到另一个 App Server 进程发出的实时 `thread/started` 通知。公开 App Server API 不提供项目登记或跨进程强制刷新能力，因此 `registerCreatedProjects` 是一个显式、默认关闭的 Desktop 私有状态兼容层：只在确认 Desktop 已关闭时新增飞书刚创建项目的名称和绝对目录，保留状态中的其他字段，并在落盘前检查文件未被并发修改。不要在 Bridge 之外手工编辑 `.codex-global-state.json` 或 Codex SQLite。

每个 Codex 回合结束后，Bridge 会调用 `thread/unsubscribe` 取消当前连接的线程订阅；这不会删除历史。官方 App Server 仍可能将没有订阅者的空闲线程保留为 loaded 最多约 30 分钟，因此如需立刻在 Codex Desktop 打开同一对话，请在任务结束后发送 `/chat close`。该命令会先确认全局没有排队或运行中的 Bridge 任务，再解除当前飞书绑定并关闭按需启动的 Codex App Server；下一个飞书任务会自动重新启动它。之后可用 `/chat use <编号或ID>` 重新选择原对话。若仍有任务进行中，`/chat close` 会拒绝执行，避免误中断其他项目或聊天。

### 兼容命令的语义

旧命令继续可用，但 `/use`、`/new` 与新命令有意保留不同语义：

- `/projects` 等同于 `/project list`。
- `/status` 等同于 `/project status`。
- `/threads` 等同于 `/chat list`。
- `/resume <编号或ID>` 等同于 `/chat use <编号或ID>`。
- `/use <项目名称|#编号|ID>` 会切换项目并清除该项目当前对话绑定，因此下一条普通任务一定创建新对话。这是为了兼容旧版行为。
- `/new` 只解除当前对话绑定，不会立即启动 Codex；下一条普通任务到来时才懒创建新对话。
- `/project use <项目名称|#编号|ID>` 不清除绑定，而是恢复该项目上次使用的对话。日常在多个项目间切换时应优先使用它。
- `/stop` 请求中断当前运行中的 Codex 回合；`/chat close` 在任务结束后释放空闲 App Server，便于把对话交给 Desktop；`/health` 查看 Bridge 健康状态；`/help` 查看手机端命令摘要。

### 手机端典型流程

首次使用已有项目：

```text
/project list
/project use claw
/chat new "README 审计"
请读取 README.md，概括当前项目，不要修改文件。
```

切换到另一个项目并返回原对话：

```text
/project use wafm
/chat list
/chat use 3
继续检查上一轮训练日志。

/project use bridge-dev
/project status
继续刚才的 README 审计，并给出三条改进建议。
```

`/project use bridge-dev` 会自动恢复 `bridge-dev` 上次选择的对话；如果想在该项目中另开工作，使用 `/chat new "新任务名称"`。如果只想查阅旧记录而不改变后续消息的去向，使用 `/chat show <编号>`。

从手机新建项目：

```text
/project create demo-agent "Demo Agent"
/project use demo-agent
/chat new "初始化"
请创建一个最小 TypeScript 项目，并先说明准备修改哪些文件。
```

导入已有目录：

```text
/project import openpi openpi-main "OpenPI"
/project use openpi
/chat new "环境检查"
请只检查依赖和 Git 状态，不要修改文件。
```

### 持久化与配置边界

- `config/projects.yaml` 是静态项目的 bootstrap 清单。启用 `codexDesktopProjects` 后，Bridge 启动及每次列出/切换项目时会刷新 Codex Desktop 项目；同一真实目录会复用现有静态 ID，不会重复登记。只有额外显式开启 `registerCreatedProjects` 时，飞书新建项目才会写入 Desktop 状态。
- Desktop 自动项目按其内部 source ID 持久化到 SQLite；飞书新建项目另有 `pending / synced / removed` 生命周期。改名和目录变化会同步更新；从正在运行的 Desktop 可见列表移除后会在 Bridge 中自动停用而不删除目录、对话历史或项目群，重新加入同一目录会恢复。目录变化时会解除旧对话绑定；若仍有排队或运行中的任务则拒绝变更，避免任务跑到另一目录。
- Codex App Server 没有 Desktop `project/list` 或项目登记接口，因此发现器兼容的是 Desktop 私有状态格式，而不是官方稳定 API。读取时只提取 `project-order`、项目名称和 `rootPaths`；可选登记时只追加一个 `local-*` 项目并保留其他状态。升级 Desktop 后应重新运行发现器测试和本机 smoke。
- Desktop 主状态文件无法严格解析时采用 fail-closed：`.bak` 仅用于诊断，不会作为执行授权源；此前自动项目会暂时停用，直到主状态文件恢复。这样已移除的旧项目不会因备份或 SQLite 缓存继续获得远程执行权限。
- 通过 `/project create` 或 `/project import` 添加的动态项目、每个飞书会话的当前项目、每个项目最后选择的对话、对话编号和归档状态都保存在 `bridge.databasePath` 指向的 SQLite 数据库中，重启后仍会恢复。
- 动态项目不需要回写 `config/projects.yaml`。删除或更换 SQLite 数据库会丢失这些动态登记及本地索引；YAML 中的项目会在新数据库首次启动时重新 bootstrap。
- `allowedRoots` 只授权机器人在指定父目录下创建或导入项目，不会扩大 Codex 自身的 sandbox 权限。

### 安全限制

- `/project import` 只接受相对于 `allowedRoots` 的路径，拒绝绝对路径、`..` 路径逃逸以及解析后越界的符号链接。若多个允许根目录中存在同名相对路径，也会拒绝导入，避免选错目录。
- `/project create` 只在第一个允许根目录下创建一个新的直接子目录；目标已存在时不会接管，需显式使用 `/project import`。
- 启用 `codexDesktopProjects` 表示明确授权飞书操作者使用 Codex Desktop 当前可见的所有本地项目；这些项目不再经过 `allowedRoots` 二次授权。`registerCreatedProjects` 是独立的写入授权，只应在接受 Desktop 私有状态兼容风险时开启；它只登记由飞书成功创建、且仍受 `allowedRoots` 约束的项目。
- Desktop 支持多目录项目；当前 Bridge 以 `rootPaths` 的第一个目录作为主 `cwd`，并在项目列表中给出多目录提示。迁移后应运行 `npm run doctor:projects` 验证当前用户实际解析到的目录。
- ClawBridge 没有远程删除项目目录或永久删除对话的命令。`disable` 只停用登记，`archive` 只归档对话，两者都保留数据。
- 同一飞书会话有任务排队或运行时，项目切换、创建/切换对话等会被拒绝；可等待任务结束或用 `/stop` 中断运行回合。正在运行或被租约占用的对话也不能切换、重命名或归档。
- 普通消息一次只进入当前项目绑定的一个对话。发送任务前可用 `/project status` 再次确认工作目录和对话，避免在手机端选错上下文。

## 离线契约验证

不连接飞书和真实 Codex 也可以验证核心协议：

```powershell
npm run check
npm test
```

测试使用真实 SQLite 和一个假 App Server 子进程，覆盖授权、群聊拒绝、路径逃逸、脱敏、飞书 payload、事件去重、线程租约、outbox 重试、迁移、重启恢复以及 JSONL 握手/线程/任务事件。

## Codex 版本与线协议

当前 App Server wire 契约不是只根据官网示例推断：实现基线来自本机 Codex CLI `0.147.0` 执行 `codex app-server generate-json-schema` 生成的 schema，并已用同一二进制完成真实验证。2026-08-11 的 smoke 覆盖 `initialize`、最小只读 `turn/start` 到 `turn/completed`，以及新建对话、命名、读取历史、未归档列表、归档列表、恢复和最终再次归档；各项均通过。该结论只适用于本机已验证版本和这些 App Server 链路，不代表跨版本兼容，也不代表飞书中正在运行的旧进程已经自动加载本次代码。

[OpenAI 官方 App Server 文档](https://developers.openai.com/codex/app-server)用于确认方法语义和推荐流程，但官网当前文档与本机已安装版本可能在 approval、sandbox 等枚举拼写上不同，例如驼峰形式与带连字符形式。ClawBridge 的 YAML 配置使用仓库 schema 中的值，客户端再映射为本机生成 schema 和真实 turn 已确认的 wire 值；不要直接把网页示例中的枚举复制到 JSONL 请求中。

升级 Codex CLI/Desktop 后，应把协议复核视为必做迁移步骤：

1. 记录新的 `codex --version`，重新运行 `codex app-server generate-json-schema`。
2. 对比方法参数、响应结构和枚举，重点检查 `approvalPolicy`、`sandbox` 与 `sandboxPolicy`。
3. 如有差异，先更新协议类型、客户端映射、假 App Server 和 contract tests。
4. 重新运行类型检查、构建和 contract tests，再使用无敏感数据的测试目录完成真实只读 turn smoke 与项目/对话管理 smoke。

只有上述检查在新版本上通过后，才能把该 Codex 版本作为新的已验证基线。

## 安全状态

- App Server 仅通过子进程标准输入输出连接，不监听 TCP。
- 首版只接受一个 `open_id` 的单聊消息。
- Codex 仅允许 `readOnly` 或 `workspaceWrite`，配置 schema 不接受 `dangerFullAccess`。
- 项目可以来自 Codex Desktop 当前可见本地项目、`config/projects.yaml` 静态登记，或受 `projectManagement.allowedRoots` 约束的手工创建/导入流程。Desktop 自动同步模式由本机配置显式开启。
- 日志和外发消息会遮盖常见 Token、Authorization 头和密钥字段。
- 当前版本已支持命令执行、文件修改和非秘密提问的手机审批 broker；启用 `approvalPolicy: onRequest` 后仍只允许当前任务的一次性卡片决策。秘密输入和未知 server request 会继续拒绝，避免凭据进入飞书或无人值守无限等待。
- App Server RPC 默认 30 秒超时，完整 Codex 回合默认 10 分钟超时；回合超时后 Bridge 会主动发送 `turn/interrupt`，避免遗留后台任务。

完整路线与 Gate 定义见 [BRIDGE_PLAN.md](BRIDGE_PLAN.md)，当前进度见 [docs/PHASE2_STATUS.md](docs/PHASE2_STATUS.md)，安全边界见 [docs/SECURITY.md](docs/SECURITY.md)。

从 0.1 升级、数据库备份、飞书权限检查和真实手机验收顺序见 [ClawBridge 2.0 发布与升级](docs/RELEASE_2.0.md)。
