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

检查主机服务、到 Worker 的 HTTPS/WebSocket 出站连接和系统时间。使用服务实际程序单独运行 `runmesh --version`，再运行 `runmesh doctor --json`。给 `doctor` 加 `--profile` 检查自定义配置，加 `--user` 检查用户级服务；已安装版本支持时，可用 `--shareable` 生成适合支持反馈的报告。

在控制台检查 Runner 授权期限和凭据状态。仍需访问的过期授权可以延期；已撤销或替换的凭据按管理员提供的恢复注册流程处理；网络和依赖故障则恢复相应连接或服务。

Runner 在线但策略被拒绝时，检查工作区是否存在、服务账号是否具有操作系统访问权限。重连时间和分层诊断见[连接恢复](connection-recovery.md)。

## 安装失败或不可用

在相应系统的管理员终端使用注册页面的命令，按[安装依赖](installer-prerequisites.zh-CN.md)处理 `RMI_*` 错误。

托管分发不可用时，查看[发行状态](release-readiness.md)。经过审核的 0.1.4 源码已启用正式托管分发，请检查已部署 Worker 的提交、发行描述及显式关闭安装的覆盖配置。有适用且已验证的发行物时，可按[便携安装流程](portable-runner-installation.md)操作，并保留 TLS、签名和哈希校验。

已有安装或卸载正在运行时，等待它结束。异常退出后，请管理员先检查进程与残留文件，再处理残留锁。注册可能已完成时，先核对控制台和本地配置，再决定是否生成替代码。

## MCP 连接或工具参数异常

在支持 Streamable HTTP 的客户端使用以 `/mcp` 结尾的完整授权地址，去掉意外引号、空格和换行。使用地址鉴权即可，无需附加 Bearer token。

Worker 更新后刷新 Runmesh 工具目录。任务后续查询拒绝 `workspace_id` 时，按[目录刷新说明](mcp-connector-refresh.md)核对 Worker、Runner 和客户端定义。

`runner_upgrade_required` 表示需要兼容的已安装 Runner。Context `storage` 和 `prune` 需要从 0.1.3 升级到包含这些动作的已验证版本，再重新连接以识别能力。具体操作见[升级指南](upgrading.zh-CN.md)。

## 工作区缺失或权限不足

用 `runner_current` 确认机器，用 `workspace_list` 核对工作区 ID。请管理员检查客户端 scope、Runner 限制、授权期限、工作区权限和策略确认；Runner 服务账号还需要对应的操作系统权限。

按[权限排查流程](runbooks/permission-denial.md)确定拒绝发生在哪一层，再调整访问设置。依赖不可用时，该部分诊断保留为未确认。

## 任务仍运行或云端历史为空

保留原 `job_id`、`workspace_id` 和 Runner 选择。前台调用可以在命令结束前返回，应继续使用带工作区 ID 的在线查询。云端历史被关闭、延迟、过期或暂不可用时，Runner 仍可能保留任务。

遇到 `job_history_unavailable` 或旧版 `not_found`，请管理员恢复原任务查询链路。发起另一条命令前，先核实原任务状态。

## 取消、恢复或输入结果不确定

发出取消后，等待任务进入最终状态。恢复为 `unknown` 的进程由管理员在主机上核实身份，状态核对完成前会继续占用执行槽。

输入送达错误或超时后，先检查原进程，再发送数据或输入结束信号。结合 `operation_state`、`next_action` 和 `recovery_hint` 判断后续操作。完整状态说明见[用户指南](user-guide.zh-CN.md)。

## 输出不完整

前台输出的正数偏移表示返回的是靠后片段，可用 `job` 工具的 `logs` 动作分页读取保留字节。`output_truncated` 可能表示输出已永久丢弃；应用另有日志采集时，也请一并检查。

## 报告剩余问题

提供时间、工具及动作、组件版本、脱敏错误代码和相关诊断结果，分享前去掉凭据、真实工作区路径和私有内容。安全问题通过 [SECURITY.zh-CN.md](../.github/SECURITY.zh-CN.md) 私密反馈。
