# 中央管理与治理（开发中）

[English](central-administration.md)

/admin/central 复用现有浏览器会话、CSRF、Strict cookie 和 CSP，提供连接档案、
目录发现/审阅、OAuth、客户端授权、可复用工具集、Skill 预览/启用及元数据回执的
显式 JSON 操作。先读当前记录，再携带 revision 修改；失败或未知结果不自动重试。

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
