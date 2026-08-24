# 安装、迁移与项目路径

## 新电脑或新用户安装

```powershell
git clone https://github.com/Ruyi231/clawBridge.git
Set-Location clawBridge
.\scripts\install.ps1
```

安装脚本会从示例生成未跟踪的 `config/local.yaml` 和 `config/projects.yaml`，执行 `npm ci` 并构建。随后双击 `ClawBridge Manager.cmd`，为这台电脑重新填写 App ID、App Secret 和当前操作者 Open ID。

不会进入 Git 的本机状态包括：

- `config/local.yaml`、`config/projects.yaml`
- `data/`（SQLite、附件和运行状态）
- `logs/`
- `.env*`
- `%LOCALAPPDATA%\ClawBridge\credentials.json`

因此，从 GitHub 克隆得到的是干净的新实例，不会继承原电脑的飞书身份、项目群映射、任务或对话路由。

## 不同用户的项目从哪里来

ClawBridge 有两个独立项目来源：

1. `config/projects.yaml`：静态 bootstrap 项目。相对 `rootPath` 从仓库根目录解析；示例中的 `.` 永远指向当前克隆的 ClawBridge 仓库，不依赖盘符或用户名。
2. Codex Desktop 自动发现：当 `codexDesktopProjects.enabled: true` 时，默认只读当前 Windows 用户的 `%CODEX_HOME%\.codex-global-state.json`，未设置 `CODEX_HOME` 时读取 `%USERPROFILE%\.codex\.codex-global-state.json`。它不会读取发布者的项目列表。

`allowedRoots` 只控制机器人“新建项目/导入项目”的边界，不限制 Desktop 已经登记的项目。建议每个用户在自己的 `config/local.yaml` 中填写窄范围的真实代码父目录，例如：

```yaml
projectManagement:
  allowedRoots:
    - C:/Users/Alice/source
    - D:/Work
  allowCreateDirectory: true
  allowRegisterExisting: true
  codexDesktopProjects:
    enabled: true
```

不要使用 `C:/`、`D:/` 或整个用户主目录。Desktop 多目录项目当前只使用第一个 `rootPaths` 作为 Codex 工作目录。

构建后运行下面的只读诊断，逐项打印最终解析路径并确认目录存在：

```powershell
npm run doctor:projects
# 或连同 Node、Codex、凭据和构建一起检查
.\scripts\doctor.ps1
```

出现错误时先修正本机未跟踪的 YAML，不要修改并提交 example 文件来保存个人路径。

## 从旧 ClawBridge 实例迁移状态

仅迁移代码时，直接重新克隆并配置即可。若确实需要保留原项目群、任务和话题映射：

1. 在旧电脑执行 `.\scripts\stop.ps1`，确认进程已停止。
2. 复制旧实例的 `config/local.yaml`、`config/projects.yaml` 和整个 `data/` 到新实例。
3. 检查 YAML 和 SQLite 中关联的项目目录在新电脑仍存在。盘符或目录改变时，优先重新登记项目；不要直接批量替换数据库。
4. DPAPI 凭据通常只能由同一台 Windows 电脑上的同一用户解密。跨电脑或跨 Windows 用户迁移时必须在管理器中重新输入三项凭据。
5. 重新运行 `npm ci`、`npm run build`、`npm run doctor:projects`。
6. 自启动任务和私有运行副本不会随 Git/文件复制迁移，需要在新电脑重新启用。

复制正在运行的 SQLite/WAL 可能得到不一致快照，所以必须先停止 Bridge。项目群属于原飞书应用；更换 App ID 后不应复用旧群映射，建议从干净 `data/` 开始。
