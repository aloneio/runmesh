# 中央管理与治理（开发中）

[English](central-administration.md)

/admin/central 默认显示「服务与 Skill」能力库，复用现有浏览器会话、CSRF、
Strict cookie 和 CSP。日常连接、工具审阅、Skill 导入发布和客户端授权使用表单
及勾选操作；系统携带已审阅的 revision 和内容版本。失败或未知结果不自动重试。
OAuth、可复用工具集和原始 API 操作保留在默认收起的「高级诊断」。

## 开始使用

首页优先展示添加能力与连接 AI；计算机访问默认收起，仅使用中继服务或 Skill
时无需从 Runner 安装开始。

1. 实例管理员统一配置允许连接的服务地址与安全凭据存储。未就绪时页面显示原因，
   禁用服务创建，已启用的 Skill 库仍可独立使用。普通使用者无需编辑环境变量或请求 JSON。
2. 在「MCP 服务」选择已批准的地址，输入服务名称与上游访问令牌。连接后逐项
   审阅并批准需要的工具。令牌更新可直接在服务卡片完成，提交后输入框清空。
3. 在「Skill 库」选择 SKILL.md 和配套文本文件或整个文件夹，填写来源与许可证。
   预览不会写入；勾选审阅确认后才发布。脚本只作为文本保存，不在服务端执行。
4. 新建 AI 连接时，默认仅使用服务和 Skill，无需 Runner。先保存一次性 MCP 地址，
   再点击「选择服务与 Skill」进入该连接的授权页面；选择能力并保存。
5. 在 AI 客户端添加远程 MCP 连接并粘贴地址。修改授权后刷新客户端的工具列表。

更新 Skill 时，授权页面使用已发布版本的名称和说明；未发布的草稿不会混入。
已固定的旧版本权限单独显示，只有明确取消勾选才移除。发生冲突或目录刷新失败时，
先刷新并重新审阅，页面不会自动重复提交。

这仍是开发版的管理员能力库。OAuth 供应商注册、可复用工具集的可视化管理、
公开服务市场和实际 AI 客户端兼容性验收尚未完成，不应宣传为任意 MCP 的零配置接入。

## 共享配置与授权

GET /admin/central/profiles 每次返回最多 50 个不含凭据明文的档案，以 next_after
作为下一页 after，每页重新验证管理员会话。凭据仅可写入，页面提交后清空含凭据
的输入。已有 profile/catalog/OAuth 路由保持原契约。

GET/POST /admin/central/grants/{client_id} 读取或替换精确授权。修改包含
expected_revision、enabled、rules；规则引用远端 tool ID/version/profile，或
Skill ID/digest。它不改变原生 scope，未批准或不可用的能力仍不能执行。

GET/POST /admin/central/toolsets/{toolset_id} 管理最多 64 个可复用模板。保存使用
action replace、expected_revision、enabled、rules；应用使用 action apply、
client_id、toolset_revision、expected_revision，只需为第二个客户端再次分配。
源模板和目标授权均检查 revision。修改/停用模板不静默改变已有客户端授权，须显式
重新应用或逐个撤销客户端授权；它不是实时权限继承。

## 直接目录与发现入口

CENTRAL_DIRECT_TOOLS_ENABLED=1 在远端绑定/出站策略有效时发布审核后的直接工具，
使用稳定 rm_ 别名和原始 JSON schema。tools/list 只读保存且经 ACL 筛选的快照，
不向上游实时发现。直接调用和 remote_call 共用参数校验、代次检查与执行实现。
当前客户端没有已启用的远程工具授权时，发现结果隐藏远程通用入口及直接别名；
Skill 入口独立按 Skill 授权筛选。重新查询目录会反映撤权，旧缓存名称的调用仍须
通过实时授权检查。

直接视图限制 8 个档案、32 工具、512 KiB；更大目录使用 remote_tools/remote_call。
remote_status 区分容量、拒绝、故障和正常空目录。中央故障保留原生工具注册，原生
工具调用不加载直接目录。真实宿主刷新仍需独立验收，旧缓存别名不能绕过当前授权。

## 可选持久化治理

CENTRAL_GOVERNANCE_ENABLED=1 为远端调用加入同一状态所有者内的持久准入与回执，
并保留已有并发上限。授权后、连接前检查每客户端每分钟 30 次、每档案每分钟 120
次，最多 2,048 个准入键。连续三次上游传输、协议或结果未知故障触发该档案 30 秒
冷却。不排队、不后台轮询、不自动重放。关闭该标志恢复此前仅并发限制的基线，
不会删除表。

回执只含请求 ID、客户端 ID、档案/工具/版本、操作状态、固定错误码、时间戳，
不保存参数、结果、正文、密钥或虚假 Runner ID。回执写入失败不把已完成调用改成
失败，runmesh/receipt 元数据返回 audit_status unavailable。最多保留 1,000 条，
读取窗口 24 小时，过期记录在新写入时清理。GET /admin/central/receipts 向通过
验证的管理员返回最近 50 条，没有客户端回执查询或重放 API。

这些是安全上限，不是生产吞吐测量。OAuth/会话边界见[中央 OAuth](central-oauth.zh-CN.md)，
[Skill 内容](central-skills.zh-CN.md)具有独立开关和预算。
