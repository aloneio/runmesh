# 中央 OAuth 与临时会话（开发版）

[English](central-oauth.md)

**W06 实现管理员代为授权的 OAuth，以及单次操作内的旧版 MCP 会话。中央绑定已在
test 和 development 环境启用，不代表生产激活。**

## 控制端直接 OAuth 连接

日常页面输入 MCP 地址并选择 OAuth，程序自动发现元数据，优先使用客户端元数据
文档，其次动态注册公共客户端。保留 PKCE、会话绑定的一次性状态、issuer 校验、
加密持久凭据和刷新占用，不需要逐个供应商配置环境策略。AI 客户端授权独立分配。
程序先发送一次不携带凭据的服务发现请求，读取 `WWW-Authenticate` 中指定的资源
元数据地址和 scope；没有挑战时再使用 well-known 发现。该探测不初始化旧版会话、
不调用工具，所有目标仍须为受限公网 HTTPS，且不跟随重定向。参见
[MCP 授权发现要求](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)。
参见[产品使用流程](central-administration.zh-CN.md)。下方 W06 内容是保留兼容的
按客户端、预注册供应商旧接口。

## 身份与兼容范围

管理员显式把一份上游授权关联到一个 Runmesh MCP 客户端凭据代次。客户端 ID 不等于
自然人身份。关联绑定档案、客户端、凭据代次、资源端点和 OAuth 配置摘要；不同
客户端不能复用对方关联。上游授权、工具审核和客户端能力授权仍独立，完成 OAuth
不授予机器权限，也不需要在 Runner 安装软件。

本批支持预注册的**公共 OAuth 客户端**、授权码、PKCE S256、Bearer、显式 resource
和 RFC 9207 的 iss。提供方元数据必须确认固定 issuer／端点、S256、code、
authorization_code、客户端认证方式 none 和 iss 支持。不提供动态注册、客户端秘密、
自动扩大 scope、发送者约束令牌或任意认证重定向。

可选 `CENTRAL_OAUTH_POLICIES` 是不含令牌的 JSON 数组。每项字段为 profile_id、
resource、issuer、metadata_endpoint、authorization_endpoint、token_endpoint、
oauth_client_id 和 scopes；完整示例见英文页。所有地址必须是固定公网 HTTPS，授权和
令牌端点与 issuer 同源，元数据地址遵循 RFC 8414。返回的元数据不能增加新目标。
既有 Worker 公网 fetch 约束仍是部署前提，不跟随重定向或转发入站 Cookie／令牌。

## 管理接口

用既有档案接口提交 `action: "create_oauth"`、connector_id 和 endpoint，profile_id
仍来自路径。新档案默认停用且 `credential: null`，没有占位 Bearer。旧档案不能静默
改变认证模式，启用／停用仍不需要解密密钥。

以下 POST 路径的前缀为 `/admin/central/oauth/`，共用已有管理员会话、同源和 CSRF：

| 操作 | 请求 | 返回 |
| --- | --- | --- |
| begin | profile_id、principal: {client_id, secret_version}、expected_revision | 待处理关联和已校验授权 URL |
| complete | state、iss，以及 code／error 二选一 | 单次消费回调后的安全元数据 |
| inspect | 同样的选择结构，读取时 expected_revision 可为 0 | 仅元数据，不返回令牌或 verifier |
| revoke | 选择结构和已观察版本 | 本地撤销并移除令牌密文 |

不允许 ADMIN_TOKEN 或 MCP 凭据绕过。向提供方注册的回调必须固定为
`RUNMESH_PUBLIC_ORIGIN + /admin/central/oauth/callback`。用管理员浏览器打开授权 URL；
固定页面先清除浏览器历史中的查询参数，再发同源受保护 POST，不放宽 Strict Cookie。
不同管理员会话、issuer／配置变化、过期 state 和重复回调都会被拒绝。页面不把回调
内容插入 HTML。基础设施日志仍可能见到最初回调 URL，应关闭该路径的查询参数日志，
也不要记录授权 URL。

关联并启用后，`/admin/central/discovery/{profile_id}` 可在 expected_revision 之外
指定 principal，OAuth 发现必须提供它。完整目录仍须审核并独立授权；W08 已加入
[管理和可复用工具集界面](central-administration.zh-CN.md)，仍须上述显式提供方策略。

## 刷新、撤销与恢复

PKCE verifier 和令牌使用独立密钥环的 AES-GCM 加密，认证上下文绑定所有者、关联和
代次；SQLite 只保存密文与元数据。临时字节会清零，但 JavaScript 字符串不能可靠清零，
也不覆盖运行环境失陷。旧密钥须保留到关联刷新或被替换，不添加批量 OAuth 重加密任务。

仅在实际需求且临近到期时刷新。同一关联的并发请求合并为一次刷新，每个等待者仍检查
自己的授权。使用轮换 refresh token 前先持久化占用状态；结果未知或重启后遗留占用，
都要求重新授权，不重放旧令牌。扩大 scope 或返回相同 refresh token 会被拒绝。
未返回替换 refresh token 时可使用新的访问令牌，但不会保留旧 refresh token。

撤销是本地行为：阻止后续使用并清除本地令牌密文，不代表提供方令牌已撤销，也不承诺
停止或回滚已派发副作用。撤销客户端凭据或变更代次同样阻止旧关联。刷新、401 和丢失
响应不会自动重放工具调用。

## 临时旧版会话与预算

默认仍无状态。审核过的 2025-11-25 出站条目可加入 `"session":"ephemeral"`。
session ID 只在初始化时接收，绑定本次操作／凭据，不向入站客户端暴露；意外替换被拒绝。
每次操作新建会话，没有持久化、池化、自动重连、GET 订阅或续传。正常结束且仍授权时
最多尝试一次有界 DELETE；失败、取消、撤权可能阻止远程清理，但本地状态仍丢弃。
会话过期不重放调用，后续显式操作才新建会话。

上限为 64 份提供方配置、64 个待处理 flow、每所有者 1,000 个关联、4 个活动授权操作，
16 KiB 命令体、32 KiB 响应、2 KiB 令牌、五分钟回调 TTL、单次操作五秒，会话清理一秒。
过期 flow 按需有界清理，不新增 alarm 或轮询；这些是安全上限，不是性能保证。

不会自动安装生产／开发绑定或秘密；旧 Bearer 和原生路径不增加 OAuth 依赖。
旧 Worker 不理解 OAuth-only 档案，不要清库或赋予机器权限伪造回退成功。本地 fixture
不代表真实浏览器同意流程、公网提供方互操作或生产配额验收。

依据：[RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html)、
[RFC 9207](https://www.rfc-editor.org/rfc/rfc9207.html)、
[MCP 授权](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)、
[MCP 会话](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)。
