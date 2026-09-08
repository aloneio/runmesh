# 故障排查

先确认问题发生在管理后台、Runner 连接还是 MCP 客户端。不要把密码、MCP 地址、注册码或 Runner token 粘贴到问题描述中。

## 无法打开管理页面

- 检查 Worker 域名和 HTTPS 是否正确；
- 确认 Cloudflare 部署成功，且 `RUNMESH_PUBLIC_ORIGIN` 与访问域名一致；
- 如果页面显示“未初始化”，直接设置管理员密码；首个完成设置的用户会成为管理员；
- 如果 Registry 报告数据结构不兼容，请创建全新的 Durable Object 命名空间；本版本不会修复或导入旧表；
- 如果登录失败多次，请等待节流时间结束后再试；
- 清除旧站点 Cookie 后重新登录。修改管理员密码会使旧会话失效。

## Runner 一直离线

1. 在 Runner 详情页确认注册码没有过期，必要时重新生成；
2. 检查目标机器上的服务是否正在运行；
3. 确认机器可以访问 Worker 的 `wss://` 出站连接；
4. 检查系统时间是否准确；
5. 使用 Runner 本机的 `runmesh doctor --json` 查看配置、服务和运行环境；
6. 如果刚刚轮换或撤销过凭据，重新注册并不要复用旧注册码。

如果 `doctor --json` 报告 profile 不完整或不兼容，请通过当前注册流程重新生成 profile；Runner 不会转换其他版本的配置。

Runmesh 不需要公网入站端口。不要为了“修复”连接而开放 SSH 或把 Runner 暴露到公网。

## 安装命令失败

- Linux/macOS：用管理员 Shell 重试，确认 `curl` 或 `wget` 可用；
- Windows：用“以管理员身份运行”的 PowerShell，并确保脚本完整复制；
- 如果托管安装器显示不可用，请按[便携式安装流程](portable-runner-installation.md)先校验发布包；
- 不要从 npm、源码分支或第三方镜像替换安装包；
- 安装完成后运行 `runmesh --version` 和 `runmesh doctor --json`；
- 若服务清单已存在但内容不一致，先停用旧服务并由管理员检查，不要强制覆盖。

## MCP 客户端无法连接

- 粘贴完整 URL，确认末尾是 `/mcp`；
- 删除换行、引号和多余空格；
- 不要附加 Bearer token 或自行改写路径；
- 确认客户端支持 Streamable HTTP；
- 在后台确认客户端没有被撤销，并且使用最新轮换后的 URL；
- 检查客户端与 Worker 的系统时间和 TLS 证书是否正常。

## 没有工作区或权限不足

客户端权限、Runner 权限和工作区权限必须同时允许操作。请管理员：

1. 在 Runner 详情页确认工作区策略已保存并被 Runner 确认；
2. 检查 MCP 客户端是否拥有对应 scope；
3. 检查客户端是否被限制到正确的 Runner；
4. 让客户端重新调用 `runner_current` 和 `workspace_list`。

不要尝试通过绝对路径、符号链接或 `shell` 绕过工作区限制。

## 任务失败、卡住或看不到日志

- 使用 `job({"action":"list"})` 查看任务是否仍在运行；
- 使用 `job({"action":"get","job_id":"..."})` 获取状态；
- 用 `job` 的 `logs` 分页读取输出；
- 任务启动后浏览器关闭不会停止它；
- Runner 离线时可以看到保留的元数据，但实时输出和输入需要 Runner 恢复在线；
- 出现 `output_truncated` 时，到 Runner 主机检查完整日志；
- 取消请求只影响已记录的任务，不代表已经启动的外部子进程一定立即结束。

## 仍然无法解决

记录时间、页面或工具名称、脱敏后的错误代码、Runner 显示名称和 `doctor --json` 中的非敏感检查结果。不要提供密码、完整 URL、注册码、token、工作区真实路径、文件内容或命令输出。安全问题请走 [.github/SECURITY.zh-CN.md](../.github/SECURITY.zh-CN.md) 的私密流程。
