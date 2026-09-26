# 控制端服务与 Skill（开发版）

[English](central-administration.md)

/admin/central 提供直接连接 MCP、安装 Skill、审阅工具和分配客户端权限的操作。
日常页面没有高级 JSON 控制台；revision 由程序携带，冲突或未知结果不会自动重放。

## 开始使用

1. 输入公网 HTTPS MCP 地址，选择「无身份验证」或「OAuth」；名称可选。
   无需预设地址清单、环境变量 JSON 或安装 Runner。
2. OAuth 会自动发现服务配置，通过客户端元数据文档或动态客户端注册连接，
   然后打开服务授权页。授权完成后返回控制端发现工具。仅支持手工预注册的服务
   暂不能自动连接，不要求使用者自行填写高级配置。
3. 审阅并批准需要的工具。连接的是实例管理员账号；每个 AI 客户端仍需单独授权。
4. 选择 SKILL.md 与配套文本文件，或整个 Skill 文件夹，点击「安装 Skill」。
   名称与说明从文件元数据读取；同名安装需要确认更新，不执行包内脚本。
5. 创建 AI 连接，保存一次性 MCP 地址，再在「客户端授权」中分配服务与 Skill。

更新 Skill 不会改变已有客户端固定版本的权限。服务工具变化后须重新审阅。
OAuth 服务卡片支持重新授权、断开账号；读取接口不会返回凭据。连接仅访问保存的
公网 HTTPS 目标，不跟随重定向，也不允许私网路由。

OAuth 加密密钥由实例部署负责：开发环境的 setup:secrets 初始化会生成独立随机
密钥，且不会覆盖已有密钥。无验证连接与 Skill 安装不依赖该密钥。真实第三方授权
及 AI 宿主接入仍需分别验收，模拟测试不会被当成真实外部账号授权成功的证据。

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

CENTRAL_DIRECT_TOOLS_ENABLED=1 在中央绑定与所选服务档案出站授权有效时发布审核后的直接工具，
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
