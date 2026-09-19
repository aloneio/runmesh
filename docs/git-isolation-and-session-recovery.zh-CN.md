# 配置 Git 访问与恢复 Runner 会话

[English](git-isolation-and-session-recovery.md)

Runmesh 的只读 Git 操作使用位于所选工作区之外的可信 Git 安装。出现 `git_unavailable` 时，先检查工作区根目录和主机 Git 安装，再重试查询。

## 配置独立工作区

使用 `/workspace/project` 这类仓库目录作为工作区根目录。文件系统根目录、盘符根目录及其规范化等价路径会被 Git 检查拒绝，因为它们无法为可信 Git 可执行文件留下独立位置。此规则适用于 status、diff、log、show 和 blame；其他工具仍按各自工作区权限运行。

中央管理的工作区路径由获授权管理员在控制面修改。保存后，等待 desired、applied 和 reported 策略版本及校验和一致，再发起 Git 请求。

可信 Git 的字面路径和规范路径都必须位于工作区之外。工作区范围过大时，即使常见的系统级 Git 安装也可能落在其中。POSIX 还检查可执行文件所有者及祖先目录、文件的安全权限；Windows 使用可信的系统安装位置。可信程序发现失败时，请安装或选择合适的 Git，同时保留工作区隔离边界。

MCP 返回受限的 `git_unavailable` 恢复提示。具体安装路径可通过本地诊断检查，共享排障报告时应保留这些路径的私密性。

## 解释连接关闭

| Registry 结果 | WebSocket 关闭方式 | 恢复方式 |
| --- | --- | --- |
| `401` 或 `403` | `4001`，`runner credentials rejected` | 检查 Runner 凭据；当前连接循环停止，服务管理器之后仍可能重启进程 |
| `409` | `4000`，`stale runner session` | 使用现有凭据重新连接并完成握手 |
| 可用性失败，包括 `429` 和 `5xx` | `1013`，`control plane temporarily unavailable` | 检查控制面，并等待服务不可用时较慢的退避重连 |

这些分类适用于连接建立、心跳、同步、Job 事件、策略确认和回复前的会话检查。旧会话的待处理回复会被拒绝。welcome 前消息和协议不匹配有各自的传输错误，应与凭据拒绝分别排查。

对于可重试的 `4000`，Runner 记录 `session_conflict`，保留凭据并使用带抖动的退避重连。处理方式由关闭码决定；分析历史掉线时，应查看当时的时间戳和实际关闭码。

## 重试对应操作

`git_unavailable` 属于可用性错误，默认 `operation_state=not_started`；Runner 明确返回的状态优先。修正安装或工作区配置后，重新发起只读 Git 请求。结果为 `unknown` 时，按[调用恢复](mcp-agent-call-contract.md)检查产生该结果的原操作。

排查兼容性时，核对已部署 Worker 和已安装 Runner 的版本。需要更新主机行为时安装已验证的 Runner 发行包，并在服务重启期间保留独立主机访问。详见[升级说明](upgrading.md)。
