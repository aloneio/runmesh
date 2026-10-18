<p align="center">
  <img src="./assets/logo.png" alt="Runmesh" width="460" />
</p>

<p align="center"><strong>让 AI 客户端安全地使用你批准的计算机</strong></p>
<p align="center">Runmesh 是一个自托管平台，把 AI 客户端、共享 MCP 和 Skill 连接到你管理的计算机。</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./docs/user-guide.zh-CN.md">用户指南</a> ·
  <a href="./docs/admin-guide.zh-CN.md">管理员指南</a> ·
  <a href="./docs/troubleshooting.zh-CN.md">故障排查</a> ·
  <a href="./docs/README.zh-CN.md">文档目录</a>
</p>

> [!IMPORTANT]
> Runmesh 按 PolyForm Noncommercial License 1.0.0 提供。商业使用请先取得书面授权，详见[商业许可](docs/legal/COMMERCIAL_LICENSE.zh-CN.md)。

## 60 秒了解 Runmesh

Runmesh 让 ChatGPT、Claude、Cursor 等兼容 MCP 的客户端连接到你批准的 Linux、macOS 或 Windows 计算机。机器可以在 NAT 或内网中，AI 只能使用你授予的内容和权限。

https://github.com/user-attachments/assets/53ac03e9-612e-40f2-b5e7-a331fe02ba72

[下载 MP4](docs/media/runmesh-promo.zh-CN.mp4?raw=1) · [视频介绍与字幕](docs/media/README.zh-CN.md)

## 你可以用 Runmesh 做什么

- 在指定工作区中让 AI 查看文件、提出修改或执行你允许的命令；
- 运行测试、构建和其他长时间任务，并在控制台中查看进度；
- 在中央位置连接 MCP、安装 Skill，再提供给多个 AI 客户端；
- 为不同客户端选择只使用共享内容，或同时使用已授权计算机。

Runner 安装在实际执行任务的计算机上。管理员决定哪些工作区可以访问，以及每个客户端可以查看、修改或执行哪些内容。默认使用受限服务账号模式（`dedicated_user`），计算机权限初始勾选读取。

## 开始使用

如果管理员已经给你 Runmesh 地址：

1. 将完整地址粘贴到兼容 MCP 的 AI 客户端。
2. 刷新客户端的 Runmesh 连接，加载共享 MCP 和 Skill。
3. 需要计算机访问时，先选择目标计算机，再打开获准的工作区。
4. 从查看文件开始；需要修改、执行命令或跟踪任务时，按客户端显示的权限继续操作。

Runmesh 地址就是访问凭据，请只通过安全渠道保存和分享。完整步骤见[用户指南](docs/user-guide.zh-CN.md)。

## 管理员快速配置

1. 按[发行状态](docs/release-readiness.zh-CN.md)部署当前正式版本。
2. 在「Runner」页面添加计算机，复制一次性安装命令并在目标机器上运行。
3. 在 Runner 详情中添加允许访问的工作区和权限。
4. 在「MCP 和 Skill」页面连接共享服务、安装 Skill。
5. 在「AI 连接」页面创建连接，选择共享内容或计算机访问，然后把显示的地址交给使用者。
6. 需要更新或停用时，在对应页面选择更新、暂停、轮换或撤销。

安装命令和客户端地址都只显示一次或用于授权，请妥善保管。更新已有实例时保留现有凭据和 Runner 配置，按[升级指南](docs/upgrading.zh-CN.md)操作。

## 权限说明

| 权限 | 用途 |
| --- | --- |
| 查看 | 浏览已批准工作区中的文件和目录 |
| 修改 | 在允许写入的工作区中应用文件修改 |
| 执行 | 在 Runner 上运行命令 |
| 任务 | 查看、跟踪或取消长时间运行的任务 |
| 共享内容 | 使用实例已启用的 MCP 和 Skill |

实际可用范围由客户端、Runner 和工作区设置共同决定。管理员可随时暂停共享内容、轮换客户端地址或撤销访问。

## 安全使用

- 只把客户端地址、安装命令和 Runner 配置交给指定使用者；
- 发现凭据泄露时立即轮换或撤销；
- 运行不受信任的代码时使用专用账号、容器或虚拟机；
- 共享 Skill 前检查来源和内容；
- 升级前阅读[版本说明](docs/release-notes.zh-CN.md)，遇到问题按[故障排查](docs/troubleshooting.zh-CN.md)处理。

## 文档

- [用户指南](docs/user-guide.zh-CN.md)
- [管理员指南](docs/admin-guide.zh-CN.md)
- [MCP 和 Skill 指南](docs/central-administration.zh-CN.md)
- [升级指南](docs/upgrading.zh-CN.md)
- [故障排查](docs/troubleshooting.zh-CN.md)
- [发行状态](docs/release-readiness.zh-CN.md)
- [版本说明](docs/release-notes.zh-CN.md)
- [完整文档目录](docs/README.zh-CN.md)

安全问题请按照[安全报告流程](.github/SECURITY.zh-CN.md)私密提交；普通问题请提交 Issue。
