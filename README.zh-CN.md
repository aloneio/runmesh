<p align="center">
  <img src="./assets/logo.png" alt="Runmesh" width="460" />
</p>

<p align="center"><strong>让 AI 客户端安全地使用你批准的计算机</strong></p>
<p align="center">Runmesh 是一个自托管的远程开发与自动化控制平台，兼容 MCP。</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./docs/user-guide.zh-CN.md">用户指南</a> ·
  <a href="./docs/admin-guide.zh-CN.md">管理员指南</a> ·
  <a href="./docs/troubleshooting.zh-CN.md">故障排查</a> ·
  <a href="./docs/README.zh-CN.md">文档目录</a>
</p>

> [!IMPORTANT]
> Runmesh 按 PolyForm Noncommercial License 1.0.0 提供。个人、教育和非商业用途可按许可证使用；商业使用请先取得书面授权，详见 [商业许可](docs/legal/COMMERCIAL_LICENSE.zh-CN.md)。

## Runmesh 能做什么

Runmesh 把 ChatGPT、Claude、Cursor 等支持 MCP 的客户端连接到你自己的电脑或服务器。你可以让 AI 在指定目录中查看文件、提出修改、执行经过授权的命令，并跟踪长时间运行的任务。

每台执行任务的机器安装一个 Runmesh Runner，由它主动向控制平面建立加密出站连接。文件操作和命令在你的机器上执行，请求的输出经过控制平面转发给已认证的客户端。控制平面保存配置、有上限的审计元数据和可选的近期任务元数据。

适合以下场景：

- 让 AI 辅助维护家庭服务器、开发机或 CI 主机；
- 为团队提供统一的 MCP 接入地址，同时保留每台机器的本地控制权；
- 运行测试、构建和其他可能持续数分钟甚至数小时的任务；
- 管理多个 Runner，并限制每个客户端可以使用的机器、目录和能力。

## 开始使用

如果管理员已经给你一个 MCP 地址：

1. 把完整地址粘贴到兼容 MCP Streamable HTTP 的客户端。
2. 在客户端调用 `runner_list`，确认可用机器。
3. 调用 `runner_current` 检查选择；尚未选择时，用目标 Runner ID 调用 `runner_select`，再调用 `runner_current` 确认。
4. 使用 `workspace_list` 查看管理员开放的目录。
5. 先用 `read` 或 `inspect` 查看内容；只有确实需要时再使用 `edit`、`shell` 或 `job`。

MCP 地址本身就是凭据，在创建或轮换时显示。请妥善保存，仅通过安全渠道交给指定使用者。完整操作步骤见[用户指南](docs/user-guide.zh-CN.md)。

## 管理员快速配置

生产环境请选用 `main` 上经过验证并启用的正式发行版本。测试 **0.1.4 候选版**时，按[部署参考](docs/deployment.md)使用独立的 `dev` 环境。

1. 从 `main` 的已发布版本部署正式 Worker，配置 `INTERNAL_CONTROL_SECRET`、`RUNNER_TOKEN_PEPPER` 两个独立密钥，并在向不可信访问者开放前完成首次管理员密码设置；
2. 在「Runner」页面添加一台机器。保留默认的 `dedicated_user` 模式，只有确实需要并接受主机高权限时才改选；
3. 复制一次性注册命令，在目标机器上运行；
4. 在 Runner 详情中添加允许访问的工作区和权限；
5. 在「MCP 客户端」页面创建客户端，选择最小权限并复制一次性 MCP 地址；新客户端默认为 `coding:read`；
6. 将地址交给使用者，并在需要时轮换或撤销。

托管安装器会下载并验证固定版本的 Runner 发行物、补齐运行环境、注册 Runner 并配置守护服务。安装器不可用时，管理后台会自动显示可离线校验的便携安装流程。完整步骤见[管理员指南](docs/admin-guide.zh-CN.md)。

复制的安装命令含有一次性注册码，整条命令都应保密。通过隐藏提示手动输入时，请按[交互式安装步骤](docs/portable-runner-installation.md)操作；Windows 还需从复制的 PowerShell 命令中移除 `-NonInteractive`。

普通生产部署使用**两个独立的长期密钥**。域名、历史后端和已验证发布状态自动确定；`ADMIN_TOKEN` 供可选的高级管理 API 使用。更新时保留现有密钥，初始化工具及反向代理设置见[最小运行时配置](docs/runtime-config.zh-CN.md)。

## 能力与权限

| 能力 | 作用 | 默认原则 |
| --- | --- | --- |
| 查看 | 浏览已批准工作区中的文件和目录 | 只读、分页、有大小限制 |
| 修改 | 应用带基线校验的文件修改 | 需要写入权限；结果不确定时按恢复指引处理 |
| 检查 | 查看 Git 状态、差异和有限诊断信息 | 只读，限定在允许的工作区中 |
| Shell | 在 Runner 身份下执行命令 | 需要执行权限，使用服务账号的系统权限 |
| Job | 查看、读取、输入或取消长任务 | 日志分页，保留数量有限 |
| Context | 保存和读取工作区交接记录 | 可选的本地存储，受权限控制，显式清理 |

有效权限取客户端、Runner、工作区三层策略的交集。操作始终指向选定的 Runner，切换机器由客户端显式完成。

## 安全使用

- MCP 地址在创建或轮换时复制；注册码和 Runner 配置文件也应保密。凭据泄露后应撤销或更换；
- 管理员可以管理工作区根路径，普通 MCP 工作区元数据不包含这些绝对路径；文件内容和命令输出仍可能含有主机路径。文件工具的路径检查会拒绝越界、设备路径和符号链接逃逸；
- 管理页面启用安全 Cookie、CSRF 校验、来源校验和登录节流；
- 运行不受信任的代码时，使用专用容器或虚拟机，并为 Runner 配置受限服务账号；
- 生产环境请配置 Cloudflare 日志脱敏，并建立凭据泄露后的轮换流程。

## 版本与升级

最新已发布正式版为 **0.1.3**，当前源码为 **0.1.4 候选版**。请根据[版本说明](docs/release-notes.zh-CN.md)和[发行状态](docs/release-readiness.md)选择合适的版本。开发环境使用单独验证的预发布渠道。

升级分为三步：部署 Worker、安装目标 Runner 包、刷新 MCP 客户端工具目录。完成后按[升级指南](docs/upgrading.zh-CN.md)验证一个代表性任务。

新实例使用自己的账号资源。更新已有 v2 实例时，保留 Worker、现用命名空间、D1 绑定、密钥和已注册 Runner。上线前验证账号配额、服务启停、日志脱敏及实际使用的 MCP 客户端。

## 文档

- [用户指南](docs/user-guide.zh-CN.md)：连接 MCP 客户端、选择 Runner、读写文件和管理任务；
- [管理员指南](docs/admin-guide.zh-CN.md)：部署、添加 Runner、配置工作区和创建客户端；
- [升级指南](docs/upgrading.zh-CN.md)：更新兼容实例并验收 Worker、Runner 和客户端整条链路；
- [故障排查](docs/troubleshooting.zh-CN.md)：登录、连接、安装、权限和任务问题；
- [安全说明](docs/security.md)：详细威胁边界和凭据保护；
- [便携式安装](docs/portable-runner-installation.md)：离线校验和手工安装；
- [部署参考](docs/deployment.md)：Cloudflare 与高级运维配置；
- [版本说明](docs/release-notes.zh-CN.md)：每个版本的变化与已知限制。

完整入口见[文档目录](docs/README.zh-CN.md)，其中也提供架构、协议与维护者参考，以及用于追溯的历史记录。

## 许可证与支持

Runmesh 由 aloneio 维护。安全漏洞请按照 [.github/SECURITY.zh-CN.md](.github/SECURITY.zh-CN.md) 的私密流程报告；普通问题和改进建议请提交 Issue。名称与徽标使用规则见 [商标说明](docs/legal/TRADEMARKS.zh-CN.md)。
