# 控制端服务与 Skill（开发版）

[English](central-administration.md)

## 连接、发布与使用

用管理员浏览器会话打开 /admin/central，填写公网 HTTPS MCP 地址，选择「无身份验证」
或 OAuth，服务名称可不填。OAuth 配置自动发现；必须人工预注册客户端的提供方暂不能
自动连接。登录上游后返回控制端，审阅发现的工具并勾选批准。

选择 SKILL.md 和配套文本文件，或整个 Skill 文件夹即可安装。名称和说明从元数据
读取；内容、批准和启用状态原子保存，不执行脚本。同名更新需查看内容并确认，提交
当前 revision。无需高级 JSON 配置。

创建 AI 连接，将一次性地址粘贴到 AI 客户端。同一实例中，所有凭据有效的客户端
共享所有已启用且已发布的 MCP 工具和当前 Skill。没有「客户端授权」页、逐个分配
或授权模板。使用服务和 Skill 不需要 Runner，发布更新后可能需要刷新客户端目录。

## 共享规则

所有有效客户端使用共享库。逐客户端规则、toolset 分配、按客户端绑定的 OAuth 和
手工 bearer 档案 API 均已删除。旧路径按普通未知路由返回 HTTP 404，不解析状态所有者。
该功能仍在开发，不保留旧兼容层。

要停用某个客户端，请撤销其连接凭据；轮换会使旧凭据失效。暂停服务或 Skill 会停止
对所有客户端共享该能力。需要不同能力信任边界时使用独立实例。原生计算机 scope、
Runner 和工作区权限仍单独检查，共享中央能力不会自动增加机器权限。

Skill 更新对所有客户端生效。旧 digest 请求被拒绝，需要重新 skill_list，再按新
digest 读取正文和附件。旧 bundle 保留给管理员显式回退。停用或撤销凭据不能清除
已进入客户端上下文的内容。

## 审核、身份与连接边界

工具发布仍须审阅。新工具或描述、schema 变化不会绕过审核；调用前与返回前仍校验
客户端身份、服务启用状态、已批准目录、内容版本和凭据状态。执行后校验失败可能
扣留结果，但不能宣称上游动作已回滚。冲突或未知结果不会自动重放。

OAuth 服务仍须完成上游同意。服务卡片提供重新授权和断开账号；OAuth 凭据加密保存，
读取 API 不返回明文。受管连接仅访问已保存的公网 HTTPS 目标，不允许私网或重定向。
密钥库由实例部署管理；无认证服务和 Skill 不需要密钥库。上游凭据由 OAuth 连接生命周期管理。

GET /admin/central/profiles 每页最多 50 个无凭据档案，用 next_after 作为 after
继续，每页重新验证管理会话。修改要求同源、会话、CSRF 及精确 revision。刷新失败
使待确认操作失效，并阻止进一步写入，直到成功刷新。

## 发现与可选治理

remote_profiles 列出有界共享服务目录；remote_tools 按 profile_id 和 cursor
读取已审阅工具；remote_call 调用精确工具及版本。CENTRAL_DIRECT_TOOLS_ENABLED=1
还发布带原始已审 schema 的 rm_ 别名，最多八个服务、32 个工具。更大的库通过
remote_profiles、remote_tools、remote_call 使用，不静默截断。发现不会连接上游。

CENTRAL_SKILLS_ENABLED=1 提供 skill_list、skill_read 及对应资源接口。skill_list
每页最多扫描 128 个 Skill head，返回 next_after；即使停用项目导致空页也须继续。

CENTRAL_GOVERNANCE_ENABLED=1 提供有界调用预算、冷却和元数据回执；不保存参数、结果
和凭据。审计故障不会重放调用或改变已完成结果，不宣称计费或分布式限流能力。

本地浏览器检查不截图，覆盖连接、审核、OAuth 回调、Skill 更新、过期确认、刷新失败
和不重放。真实供应商同意、两个真实 AI 宿主及生产发布仍遵循[验收清单](central-rollout.md)。
