# 飞书开放平台配置清单

本清单适用于每一位独立部署 ClawBridge 的用户。不要复用他人的 App Secret 或 Open ID；Open ID 是“用户在某个应用下”的标识，换一个飞书应用后通常会变化。

## 1. 创建和启用应用

1. 在[飞书开放平台开发者后台](https://open.feishu.cn/app)创建“企业自建应用”。
2. 在“添加应用能力”中启用**机器人**。
3. 在“凭证与基础信息”取得 `App ID` 和 `App Secret`。Secret 只保存到 ClawBridge 管理器，不要写入仓库或 YAML。
4. 在“应用发布范围”中只加入实际操作者。ClawBridge 当前是单用户桥，代码还会用 `CLAWBRIDGE_FEISHU_ALLOWED_OPEN_ID` 做第二次校验。

## 2. 权限管理

在“开发配置 → 权限管理”中按权限码搜索。建议使用下面的兼容权限集合：

| 权限码                               | ClawBridge 用途                                                      |
| ------------------------------------ | -------------------------------------------------------------------- |
| `im:message`                         | 以机器人身份发送文本、交互卡片和话题回复                             |
| `im:message:readonly`                | 读取机器人收到的消息和卡片回调上下文                                 |
| `im:message:update`                  | 原位更新控制卡、模型卡和任务流式卡片                                 |
| `im:resource`                        | 下载用户消息中的图片和受支持文件                                     |
| `im:chat:create`                     | 为项目创建私有项目群；若后台只提供 `im:chat`，可使用该群管理综合权限 |
| `im:chat:read` 或 `im:chat:readonly` | 检查已有项目群是否仍存在及其消息模式                                 |
| `im:chat:update`                     | 更新旧项目群的名称、配置和消息模式                                   |
| `im:chat.members:read`               | 检查唯一授权用户是否仍在项目群                                       |
| `im:chat.members:write_only`         | 用户退出后重新邀请，以及退出并丢弃项目群                             |
| `im:chat:operate_as_owner`           | 让创建群的机器人以群主能力维护成员和群信息                           |

飞书可能把综合权限拆成更细的权限。若 API 报 `99991672 Access denied`，以错误里的 `requires ... scope` 为准补充对应权限；补权限后必须重新发布应用版本。不要为了省事开通讯录、云文档、邮箱等与 ClawBridge 无关的权限。

## 3. 事件与回调

ClawBridge 使用官方 SDK 的长连接，不需要公网 URL。

1. 打开“事件与回调 → 事件配置”，订阅方式选择**使用长连接接收事件**。
2. 添加事件 `im.message.receive_v1`（接收消息）。
3. 打开“回调配置”，同样选择长连接。
4. 添加回调 `card.action.trigger`（卡片回传交互）。
5. 保存后创建新版本并发布。

只配置事件、不配置卡片回调时，普通文本可能能收到，但所有卡片按钮都会失效。只在后台保存但未发布新版本，也不会对线上机器人生效。

## 4. 取得当前用户 Open ID

若已安装并授权飞书 CLI，可以使用：

```powershell
lark-cli auth status
```

输出中 `identities.user.openId` 就是当前绑定应用下的用户 Open ID。也可以先把管理器中的 Open ID 设为 `ou_pending_pairing`，启动后向机器人发送一条单聊消息，再根据 Bridge 返回的配对提示填写实际 `ou_...`。

飞书 CLI 能确认当前绑定的 App ID、用户 Open ID和已授权 scope，也能核对事件/API schema；它不能替代开发者后台完成机器人能力开关、长连接订阅或应用版本发布。

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

若第 1 步失败，优先检查应用是否发布、机器人可用范围、App ID/Secret 和 `im.message.receive_v1`；若普通消息正常但按钮失败，检查 `card.action.trigger`；若项目群失败，按错误提示检查群权限。
