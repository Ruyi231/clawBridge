# 飞书开放平台配置清单

本清单适用于每一位独立部署 ClawBridge 的用户。不要复用他人的 App Secret 或 Open ID；Open ID 是“用户在某个应用下”的标识，换一个飞书应用后通常会变化。

## 1. 创建和启用应用

1. 在[飞书开放平台开发者后台](https://open.feishu.cn/app)创建“企业自建应用”。
2. 在“添加应用能力”中启用**机器人**。
3. 在“凭证与基础信息”取得 `App ID` 和 `App Secret`。Secret 只保存到 ClawBridge 管理器，不要写入仓库或 YAML。
4. 在“应用发布范围”中只加入实际操作者。ClawBridge 当前是单用户桥，代码还会用 `CLAWBRIDGE_FEISHU_ALLOWED_OPEN_ID` 做第二次校验。

## 2. 权限管理

### 2.1 推荐：批量导入已验证权限

ClawBridge 使用 `tenant_access_token` 以应用/机器人身份访问飞书，不需要用户身份权限。下面的配置覆盖消息、CardKit、附件、项目群生命周期以及可选的飞书云端组合发送页。进入“开发配置 → 权限管理”，使用“批量导入/导出权限”功能，将 [feishu-permissions.json](./feishu-permissions.json) 的完整内容粘贴并导入：

```json
{
  "scopes": {
    "tenant": [
      "bitable:app",
      "cardkit:card:write",
      "drive:media:download",
      "im:chat.members:read",
      "im:chat.members:write_only",
      "im:chat:create",
      "im:chat:delete",
      "im:chat:operate_as_owner",
      "im:chat:readonly",
      "im:chat:update",
      "im:message",
      "im:message.group_at_msg.include_bot:readonly",
      "im:message.group_at_msg:readonly",
      "im:message.group_msg",
      "im:message.group_msg.include_bot:read",
      "im:message.p2p_msg:readonly",
      "im:message:send_as_bot",
      "im:resource"
    ],
    "user": []
  }
}
```

导入后检查权限列表并创建、发布一个新的应用版本。仅在后台导入但没有发布，新权限不会对正在运行的机器人生效。

不要直接导入某个开发者账号导出的完整权限文件。该文件可能同时包含邮箱、审批等 ClawBridge 不使用的权限，还可能包含大量 `user` 权限。批量导入通常也不会自动撤销此前已开通的无关权限；如需最小权限部署，请在导入后人工复核并移除无关项。若不启用云端组合发送页，可以不申请 `bitable:app` 和 `drive:media:download`。

### 2.2 权限用途

上面的批量导入文件采用当前飞书权限中心可导出的应用身份权限：

| 权限码                                         | ClawBridge 用途                                |
| ---------------------------------------------- | ---------------------------------------------- |
| `bitable:app`                                  | 读取组合发送记录并写回处理状态（可选）         |
| `cardkit:card:write`                           | 创建并更新流式任务卡、控制卡和模型工具栏       |
| `drive:media:download`                         | 下载组合发送记录中的云端附件（可选）           |
| `im:message`                                   | 消息读写综合权限，支持发送、回复和原位更新消息 |
| `im:message.p2p_msg:readonly`                  | 接收机器人单聊消息，用于菜单、配对和控制台操作 |
| `im:message.group_at_msg:readonly`             | 接收群聊中提及机器人的消息                     |
| `im:message.group_at_msg.include_bot:readonly` | 接收包含机器人消息的群聊提及上下文             |
| `im:message.group_msg`                         | 接收项目群和对话话题中的普通群消息             |
| `im:message.group_msg.include_bot:read`        | 读取包含机器人消息的项目群上下文               |
| `im:message:send_as_bot`                       | 以机器人身份发送文本、卡片和话题回复           |
| `im:resource`                                  | 下载用户消息中的图片和受支持文件               |
| `im:chat:create`                               | 为项目创建私有项目群                           |
| `im:chat:readonly`                             | 检查已有项目群是否存在并读取群配置             |
| `im:chat:update`                               | 更新项目群名称、配置和消息模式                 |
| `im:chat:delete`                               | 执行“退出并丢弃项目群”时删除失效项目群         |
| `im:chat.members:read`                         | 检查授权用户是否仍在项目群                     |
| `im:chat.members:write_only`                   | 用户退出后重新邀请，以及维护项目群成员         |
| `im:chat:operate_as_owner`                     | 允许创建群的机器人以群主能力维护群信息和成员   |

### 2.3 权限版本差异和报错补充

不同租户或飞书权限目录版本可能显示等价的权限别名，例如 `im:chat:read`、`im:message:readonly`、`im:message:update`、`im:chat.members:bot_access` 或 `cardkit:card:read`。不要主动用这些别名替换已验证配置；只有后台无法导入某项，或接口返回 `99991672 Access denied` 并明确提示其他 scope 时，才按提示补充并重新发布应用版本。

飞书 CLI 可用 `lark-cli schema im.chats.create`、`lark-cli schema im.chats.get`、`lark-cli schema im.chats.update` 和 `lark-cli schema im.chat.members.get` 等命令查看接口当前接受的权限。接口列出的权限通常是“满足其中之一”，不是要求全部开启。不要为了省事开通讯录、云文档、邮箱等无关权限。

## 3. 事件与回调

ClawBridge 使用官方 SDK 的长连接，不需要公网 URL。

1. 打开“事件与回调 → 事件配置”，订阅方式选择**使用长连接接收事件**。
2. 添加事件 `im.message.receive_v1`（接收消息）。
3. 打开“回调配置”，同样选择长连接。
4. 添加回调 `card.action.trigger`（卡片回传交互）。
5. 保存后创建新版本并发布。

只配置事件、不配置卡片回调时，普通文本可能能收到，但所有卡片按钮都会失效。只在后台保存但未发布新版本，也不会对线上机器人生效。

## 4. 取得当前用户 Open ID

Open ID 必须是实际操作者在**当前飞书应用**下的用户标识，格式为 `ou_...`。不要填写机器人的 Open ID、用户 ID 或 Union ID，也不要照抄其他应用查询出的值。

### 4.1 已安装飞书 CLI

在准备运行 ClawBridge 的同一 Windows 用户下执行：

```powershell
lark-cli auth status --json
```

复制输出中 `identities.user.openId` 的 `ou_...` 值，并确认输出中的 App ID 与管理器中填写的 App ID 相同。若 CLI 尚未登录或绑定的不是这个应用，先按 CLI 提示完成授权，再重新查询。

飞书 CLI 能确认当前绑定的 App ID、用户 Open ID和已授权 scope，也能核对事件/API schema；它不能替代开发者后台完成机器人能力开关、长连接订阅或应用版本发布。

### 4.2 没有飞书 CLI

ClawBridge 内置一次性人工配对流程，不需要安装 CLI：

1. 在管理器的 Open ID 输入框中填写固定占位符 `ou_pending_pairing`。
2. 点击“保存并应用”，等管理器显示长连接已就绪。
3. 在飞书中打开该机器人的**单聊**，发送“绑定”或任意一条文本消息；不要在群聊中操作。
4. 机器人会回复发送者的实际 Open ID。配对模式只返回标识，不会执行消息中的 Codex 任务。
5. 复制回复中的 `ou_...`，替换管理器里的占位符，再次点击“保存并应用”。
6. 向机器人单聊发送“菜单”。只有绑定用户能够得到正常控制卡，其他用户和群消息都会被拒绝。

建议先把应用可用范围限制为本人，再进行配对。`ou_pending_pairing` 只应用于首次发现 Open ID，不应作为日常运行配置保留。

## 5. 发布后验证

```powershell
.\scripts\doctor.ps1
.\scripts\start.ps1
.\scripts\status.ps1
```

然后依次验证：

1. 在机器人单聊发送“菜单”，应收到控制卡。
2. 点击“选择项目”，应看到当前电脑的有效项目。
3. 点击“项目群”，应创建或恢复私有群。
4. 在项目群中新建对话话题并发送一条测试任务。
5. 点击模型、额度、停止等卡片按钮，确认 `card.action.trigger` 正常。
6. 发送一张小图片，确认 `im:resource` 正常。
7. 让 Codex 在项目目录生成一张小图片和一个文档，并在最终回答中明确给出 Markdown 文件链接；确认图片嵌入回答卡片、文档作为同一话题的文件附件出现。

若第 1 步失败，优先检查应用是否发布、机器人可用范围、App ID/Secret 和 `im.message.receive_v1`；若普通消息正常但按钮失败，检查 `card.action.trigger`；若项目群失败，按错误提示检查群权限。
