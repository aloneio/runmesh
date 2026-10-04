# 连接 MCP

[English](central-remote-mcp.md) · [MCP 和 Skill 指南](central-administration.zh-CN.md)

在控制端添加一次 MCP，即可通过已连接的 AI 客户端使用其启用的工具。

## 添加连接

1. 打开「MCP 和 Skill → MCP」。
2. 在「MCP 地址」中粘贴提供方的公网 HTTPS MCP 端点，例如 `https://mcp.example.com/mcp`。
3. 公开 MCP 选择「无身份验证」，需要账号登录的 MCP 选择「OAuth」。
4. 按需填写名称，点击「连接」。名称留空时会使用主机名。
5. 选择 OAuth 后，在提供方页面完成登录与授权，Runmesh 会返回控制端并加载工具。

使用标准 HTTPS 端口上的直接端点，地址包含主机名与 MCP 路径，账号凭据通过 OAuth 流程管理。提供方给出下载页或配置页时，请从其连接说明中获取 MCP 端点。

OAuth 提供方可采用客户端元数据文档或自动客户端注册。登录步骤见[MCP 账号授权](central-oauth.zh-CN.md)。

## 使用和刷新工具

点击 MCP 卡片的「查看工具」，即可浏览工具名称与说明。已启用的工具共享给实例中的有效 AI 客户端；客户端接入方法见[用户指南](user-guide.zh-CN.md)。

提供方更新工具后，点击「刷新工具」。完整工具列表会一起发布。刷新失败时会保留已保存的目录，按页面提示恢复连接后再次刷新。

工具较少时，Runmesh 会直接列出工具；较大的工具集合可通过目录工具浏览。AI 客户端可用 `remote_profiles` 查找 MCP，用 `remote_tools` 读取工具定义，再以返回的工具 ID 和版本调用 `remote_call`。添加或修改连接后，请刷新客户端的工具目录。

## 暂停和恢复

「暂停」停止所有客户端对该 MCP 工具的访问，并保留连接设置；「启用」恢复共享并重新加载工具。OAuth MCP 在暂停与恢复期间保留账号连接，「断开账号连接」则移除本地账号连接。详见[授权指南](central-oauth.zh-CN.md)。

## 连接格式与大小

Runmesh 通过 Streamable HTTP 连接公网 HTTPS MCP 端点，读取 JSON 或单次请求内的 SSE 响应，并向客户端返回文本、图片、音频、资源和结构化结果。每次调用使用独立的上游会话。

| 项目 | 上限 |
| --- | --- |
| 完整工具目录 | 128 个工具 |
| 发出的单次请求 | 64 KiB |
| 单次上游响应 | 1 MiB |
| 一次操作中的上游响应总量 | 2 MiB |
| 返回的内容项 | 32 项 |
| 操作时间 | 20 秒 |

输出较大时，请使用提供方的分页或筛选工具。调用发出后超时，先在提供方核对结果，再决定是否重复执行会修改数据的操作。

遇到错误时见[故障排查](troubleshooting.zh-CN.md)。协议与部署细节见[传输参考](maintainers/central-remote-mcp.zh-CN.md)。
