# 故障排查

[English](troubleshooting.md) · [文档目录](README.zh-CN.md)

先确定出错组件：管理页面、Worker、Runner 服务或 MCP 客户端，并保留原操作回执。

## 管理页面或登录异常

检查公网 HTTPS 地址与部署状态。为反向代理配置了 `RUNMESH_PUBLIC_ORIGIN` 时，也应核对该覆盖值。

| 现象 | 处理 |
| --- | --- |
| Registry 或鉴权依赖不可用 | 检查部署，等待恢复后用当前凭据重试登录 |
| 多次失败后登录被节流 | 等待节流窗口结束 |
| 修改密码后会话过期 | 使用当前密码重新登录 |
| 数据或 schema 不匹配 | 保护数据，比较所部署代码与资源绑定，按[升级指南](upgrading.zh-CN.md)处理 |

新实例应在向不可信访问者开放前完成管理员设置。涉及旧数据边界时，使用对应的[迁移流程](migration.md)。

## Runner 一直离线

检查主机服务、到 Worker 的 HTTPS/WebSocket 出站连接和系统时间。使用服务实际程序单独运行 `runmesh --version`，再运行 `runmesh doctor --json`。给 `doctor` 加 `--profile` 检查自定义配置，加 `--user` 检查用户级服务。反馈问题时，可用 `runmesh doctor --json --shareable` 生成诊断报告。

在控制台检查 Runner 授权期限和凭据状态。仍需访问的过期授权可以延期；已撤销或替换的凭据按管理员提供的恢复注册流程处理；网络和依赖故障则恢复相应连接或服务。

Runner 在线但策略被拒绝时，检查工作区是否存在、服务账号是否具有操作系统访问权限。重连时间和分层诊断见[连接恢复](connection-recovery.md)。

## 安装失败或不可用

在相应系统的管理员终端使用注册页面的命令，按[安装依赖](installer-prerequisites.zh-CN.md)处理 `RMI_*` 错误。

注册页提供便携安装时，检查[发行状态](release-readiness.zh-CN.md)与已部署 Worker 的发行描述。生产环境使用正式渠道，开发面板提供独立验证的预发布包，并将注册指向该开发实例。请从准备接入的实例复制安装命令。[便携安装流程](portable-runner-installation.md)同样提供 TLS、签名和哈希校验。

已有安装或卸载正在运行时，等待它结束。异常退出后，请管理员先检查进程与残留文件，再处理残留锁。注册可能已完成时，先核对控制台和本地配置，再决定是否生成新注册码。

## MCP 连接或工具参数异常

在支持 Streamable HTTP 的客户端使用以 `/mcp` 结尾的完整授权地址，去掉意外引号、空格和换行。使用地址鉴权即可，无需附加 Bearer token。

Worker 更新后刷新 Runmesh 工具目录。任务后续查询拒绝 `workspace_id` 时，按[目录刷新说明](mcp-connector-refresh.md)核对 Worker、Runner 和客户端定义。

`runner_upgrade_required` 表示需要兼容的已安装 Runner。Context `storage` 和 `prune` 从 0.1.4 开始提供。检查已安装版本，按需升级 Worker 和 Runner，再重新连接 Runner 以刷新可用动作。具体操作见[升级指南](upgrading.zh-CN.md)。

## 工作区缺失或权限不足

共享 MCP 或 Skill 的访问问题按下文连接流程检查；使用计算机时，按以下步骤核对 Runner 和工作区。

用 `runner_current` 确认机器，用 `workspace_list` 核对工作区 ID。请管理员检查客户端 scope、Runner 限制、授权期限、工作区权限和策略确认；Runner 服务账号还需要对应的操作系统权限。

按[权限排查流程](runbooks/permission-denial.md)找到需要调整的设置。所需服务暂不可用时，先恢复服务并重新检查权限。

## MCP 连接或 OAuth 需要处理

打开「MCP 和 Skill」，找到对应卡片。已暂停时先点击「启用」。「刷新工具」重新加载目录，并在需要登录时打开授权；「重新授权」直接开始新的提供方授权流程。

完成授权后，Runmesh 返回控制端并继续加载工具。提供方页面显示错误时，记录信息与时间，检查其登录状态和服务状态。[OAuth 指南](central-oauth.zh-CN.md)介绍重新授权，以及 `oauth_configuration_required` 的部署密钥恢复步骤。

更改连接后，刷新 AI 客户端中的 Runmesh 工具目录。上游工具发出后超时，先在提供方检查执行结果，再决定是否重复调用。

## Skill 上传或更新需要处理

选择根目录含 `SKILL.md` 的文件夹，检查文件开头的 YAML 元数据包含有效的 `name` 和 `description`，说明可以分多行编写。所选文件应使用 UTF-8 文本。压缩包先解压，再选择对应 Skill 文件夹。[Skill 指南](central-skills.zh-CN.md)提供完整示例与当前文件上限。

替换同名 Skill 时，核对文件后点击「更新 Skill」。审阅期间其他管理员修改了该 Skill 时，刷新列表并重新选择文件。发布后刷新 AI 客户端的 Skill 列表，以当前版本读取内容。

## 任务仍运行或云端历史为空

保留原 `job_id`、`workspace_id` 和 Runner 选择。前台调用可以在命令结束前返回，应继续使用带工作区 ID 的在线查询。云端历史被关闭、延迟、过期或暂不可用时，Runner 仍可能保留任务。

遇到 `job_history_unavailable` 或旧版 `not_found`，恢复原 Runner 在线，使用 shell 回执中的 `job_id` 和 `workspace_id` 重新查询 `job`。客户端缺少 `workspace_id` 参数时，刷新工具目录。仍然查询失败时，请管理员检查原 Runner 上的本地任务记录。发起另一条命令前，先核实原任务状态。

## 取消、恢复或输入结果不确定

发出取消后，等待任务进入最终状态。恢复为 `unknown` 的进程由管理员在主机上核实；Runner 确认该进程结束后，才会释放执行槽。

输入送达错误或超时后，先检查原进程，再发送数据或输入结束信号。结合 `operation_state`、`next_action` 和 `recovery_hint` 判断后续操作。完整状态说明见[用户指南](user-guide.zh-CN.md)。

## 输出不完整

前台输出的正数偏移表示返回的是靠后片段，可用 `job` 工具的 `logs` 动作分页读取保留字节。`output_truncated` 可能表示输出已永久丢弃；应用另有日志采集时，也请一并检查。

## 报告剩余问题

提供时间、工具及动作、组件版本、脱敏错误代码和相关诊断结果，分享前去掉凭据、真实工作区路径和私有内容。安全问题通过 [SECURITY.zh-CN.md](../.github/SECURITY.zh-CN.md) 私密反馈。
