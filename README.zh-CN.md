<p align="center">
  <img src="./assets/logo.png" alt="Runmesh" width="460" />
</p>

<p align="center"><strong>让 AI 客户端安全地使用你批准的计算机</strong></p>
<p align="center">Runmesh 是一个自托管的远程开发与自动化控制平台，兼容 MCP。</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./docs/user-guide.zh-CN.md">用户指南</a> ·
  <a href="./docs/admin-guide.zh-CN.md">管理员指南</a> ·
  <a href="./docs/troubleshooting.zh-CN.md">故障排查</a>
</p>

> [!IMPORTANT]
> Runmesh 按 PolyForm Noncommercial License 1.0.0 提供。个人、教育和非商业用途可按许可证使用；商业使用请先取得书面授权，详见 [商业许可](docs/legal/COMMERCIAL_LICENSE.zh-CN.md)。

## Runmesh 能做什么

Runmesh 把 ChatGPT、Claude、Cursor 等支持 MCP 的客户端连接到你自己的电脑或服务器。你可以让 AI 在指定目录中查看文件、提出修改、执行经过授权的命令，并跟踪长时间运行的任务。

每台执行任务的机器安装一个 Runmesh Runner。Runner 只主动向控制平面建立加密连接，不需要开放公网端口、SSH 或 VPN 入站服务。文件和命令仍留在你的机器上，控制平面只负责认证、权限和转发。

适合以下场景：

- 让 AI 辅助维护家庭服务器、开发机或 CI 主机；
- 为团队提供统一的 MCP 接入地址，同时保留每台机器的本地控制权；
- 运行测试、构建和其他可能持续数分钟甚至数小时的任务；
- 管理多个 Runner，并限制每个客户端可以使用的机器、目录和能力。

## 三分钟开始使用

如果管理员已经给你一个 MCP 地址：

1. 把完整地址粘贴到兼容 MCP Streamable HTTP 的客户端。
2. 在客户端调用 `runner_list`，确认可用机器。
3. 有多台机器时调用 `runner_select` 选择目标，再调用 `runner_current` 确认。
4. 使用 `workspace_list` 查看管理员开放的目录。
5. 先用 `read` 或 `inspect` 查看内容；只有确实需要时再使用 `edit`、`shell` 或 `job`。

MCP 地址本身就是凭据，只会在创建或轮换时显示一次。不要把它发到群聊、工单、截图、日志或代码仓库中。完整操作步骤见[用户指南](docs/user-guide.zh-CN.md)。

## 管理员快速配置

管理员只需要完成以下流程：

1. 部署 Cloudflare Worker，并完成首次管理员密码设置；
2. 在「Runner」页面添加一台机器，选择执行权限并阅读高权限提示；
3. 复制一次性注册命令，在目标机器上运行；
4. 在 Runner 详情中添加允许访问的工作区和权限；
5. 在「MCP 客户端」页面创建客户端，选择最小权限并复制一次性 MCP 地址；
6. 将地址交给使用者，并在需要时轮换或撤销。

标准安装命令会自动下载经过固定版本校验的安装器、补齐运行环境、注册 Runner 并配置守护服务。安装器不可用时，管理后台会自动显示可离线校验的便携安装流程。完整步骤见[管理员指南](docs/admin-guide.zh-CN.md)。

## 能力与权限

| 能力 | 作用 | 默认原则 |
| --- | --- | --- |
| 查看 | 浏览已批准工作区中的文件和目录 | 只读、分页、有大小限制 |
| 修改 | 应用带基线校验的文件修改 | 需要写入权限，失败自动保护现场 |
| 检查 | 查看 Git 状态、差异和有限诊断信息 | 只读，不暴露主机根目录 |
| Shell | 在 Runner 身份下执行命令 | 必须明确授权；不是安全沙箱 |
| Job | 查看、读取、输入或取消长任务 | 日志分页，保留数量有限 |

权限由客户端、Runner、工作区三层共同决定。任何一层拒绝，操作都会停止。Runmesh 不会因为一台机器离线而悄悄切换到另一台机器。

## 安全边界

- MCP 地址、Runner 注册码和 Runner 凭据都只显示一次，并支持轮换、撤销；
- Runner 与控制平面使用加密的出站连接，执行机器不需要公网入站端口；
- 工作区根路径不会返回给 MCP 客户端；路径检查会拒绝越界、设备路径和符号链接逃逸；
- 管理页面启用安全 Cookie、CSRF 校验、来源校验和登录节流；
- `shell` 继承 Runner 服务账号的操作系统权限。它不是容器或虚拟机，请勿在高权限 Runner 上运行不受信任的代码；
- 生产环境请配置 Cloudflare 日志脱敏，并建立凭据泄露后的轮换流程。

## 当前版本边界

Runmesh 当前是开发预览版。已支持 Runner、工作区策略、MCP 客户端、持久任务、断线恢复、服务安装和签名安装器门控。以下能力尚不属于兼容性承诺：自动升级与回滚、多租户组织、计费、托管 IDE、浏览器自动化、模型服务和操作系统级沙箱。

本版本采用全新的数据边界：请为 Durable Object 使用全新命名空间并重新注册 Runner，不会导入旧表、旧配置、旧服务清单或旧凭据。在正式环境启用前，请在目标系统验证 Cloudflare 配额、全新命名空间行为、Windows/macOS 服务生命周期、日志脱敏和实际 MCP 客户端兼容性。

## 文档

- [用户指南](docs/user-guide.zh-CN.md)：连接 MCP 客户端、选择 Runner、读写文件和管理任务；
- [管理员指南](docs/admin-guide.zh-CN.md)：部署、添加 Runner、配置工作区和创建客户端；
- [故障排查](docs/troubleshooting.zh-CN.md)：登录、连接、安装、权限和任务问题；
- [安全说明](docs/security.md)：详细威胁边界和凭据保护；
- [便携式安装](docs/portable-runner-installation.md)：离线校验和手工安装；
- [部署参考](docs/deployment.md)：Cloudflare 与高级运维配置；
- [版本说明](docs/release-notes.md)：每个版本的变化与已知限制。

架构、传输协议和版本切换文件属于高级参考，供维护者在需要时查阅。法律文件、第三方声明和社区规则位于 [docs](docs/) 目录。

## 许可证与支持

Runmesh 由 aloneio 维护。安全漏洞请按照 [.github/SECURITY.zh-CN.md](.github/SECURITY.zh-CN.md) 的私密流程报告；普通问题和改进建议请提交 Issue。名称与徽标使用规则见 [商标说明](docs/legal/TRADEMARKS.zh-CN.md)。
