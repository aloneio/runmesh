# 中央 OAuth 与操作内会话

> 维护者参考：接口、协议和验证边界。日常操作请阅读[用户指南](../central-oauth.zh-CN.md)。

[English](central-oauth.md)

## 从控制台连接

在 /admin/central 填写公网 HTTPS MCP URL，选择 OAuth。Runmesh 自动发现资源和提供方元数据，优先使用 OAuth 客户端元数据文档，否则动态注册公共客户端。不支持的提供方明确失败，无需手工客户端密钥、提供方环境变量或逐客户端 OAuth 分配。

不带凭据的探测读取 WWW-Authenticate，其中的资源元数据 URL 和 scope 优先于 well-known 路径；缺少挑战时使用 well-known 发现。探测不初始化会话或调用工具。所有请求目标均为有界公网 HTTPS，不跟随重定向、不访问私网、不转发入站凭据。

授权属于已保存的连接。连接成功并自动发现工具后，实例内所有有效认证客户端均可使用服务。每个调用方仍复核身份；中央发布不授予 Runner 或工作区权限。

## 授权与凭据生命周期

/admin/central/connections/begin、complete 和 revoke 受管理员会话、同源及 CSRF 保护；浏览器回调为 /admin/central/connections/callback。PKCE、绑定会话的一次性状态、issuer、精确连接 revision 和 origin 共同约束交换。回调页先清除查询参数再发受保护 POST，不把回调文本插入 HTML。部署日志不得记录回调查询字符串或授权 URL。

客户端数据、校验器和令牌使用 AES-256-GCM 加密。HKDF-SHA256 从现有 `INTERNAL_CONTROL_SECRET` 派生不可导出的密钥，并按 OAuth 用途和 Durable Object 命名空间隔离，无需增加部署变量。认证加密还将密文绑定到操作上下文。连接元数据不保存上游秘密，OAuth 仓库负责凭据状态，读取 API 只返回元数据。临时字节缓冲会清零，但 JavaScript 字符串不能保证清零；加密不防护已失陷的运行环境。

这三类数据统一使用 `platform/secret-storage.ts` 实现及 `contracts/secret-storage.ts` 契约。此次模块调整保持现有密文格式，无需因此重新授权。每个加密值允许最多 64 KiB 的 UTF-8 明文，密文及整条记录的上限由同一预算计算，可容纳同时达到长度上限的访问令牌和刷新令牌。密钥派生和 base64url 编码均只保留一套实现。

凭据序列化使用不依赖业务模块的 `contracts/json.ts`。发现元数据统一按 32 KiB 的 UTF-8 字节预算校验，协议校验与记录容量计算共用这一上限，包含中文等多字节文本时也保持一致。

交换或刷新前先写入持久占用状态，防止并发重复使用。刷新按需触发，每个等待请求复核自身准入，并使用检查当前 OAuth revision 的凭据租约。结果不确定时要求重新连接，不自动重放。升级时保留 `INTERNAL_CONTROL_SECRET`，轮换后需重新连接 OAuth。不缓存原始密钥，也不保留旧独立密钥环的兼容实现。

断开账号会撤销本地状态并使租约失效，但不撤销提供方令牌，也不能回滚已派发副作用。撤销客户端单独阻止该客户端，不断开共享服务。401 或凭据变化不自动重放 tools/call。

## 会话与模块边界

传输层协商支持的 MCP 协议版本。初始化创建的上游会话仅属于单次操作和凭据，异常替换被拒绝。不建立持久会话池、不自动重连、不开放 GET 订阅或续传。正常关闭至多发送一次有界 DELETE，且准入仍须有效；取消或撤销可能阻止清理，此时丢弃本地状态。

托管 OAuth 应用层通过不依赖 SDK 的端口负责生命周期，协议适配器负责发现与有界 HTTP，存储负责原子状态，组合根连接实现。旧逐客户端 OAuth、手工 bearer 档案和环境变量策略实现均已删除，不保留兼容入口；旧 HTTP 路径按普通未知路由处理。

## 验证范围

点击“重新授权”会先同步已保存连接的当前状态，再发起一次新的授权；自动发现失败后无需额外手动刷新。若状态读取失败，或连接已暂停、移除，则不发起授权。

工具发现前，已保存连接的当前工具目录返回 HTTP 200 和空目录状态；连接不存在或指定快照不存在时仍返回 404。发现操作因等待授权而尚未开始时，返回 HTTP 200 和需要授权的状态，控制台据此提供重新授权入口；其他失败仍保留错误响应。OAuth 返回途中中断后，再次打开控制台会自动继续发现工具，并复用首次读取的目录状态。

授权开始前会检查凭据加密是否可用。缺少或无效的 `INTERNAL_CONTROL_SECRET` 返回 `oauth_configuration_required`（503，`not_started`），不会访问提供方或覆盖已有账号；此时应恢复现有部署密钥。正常配置的实例无需额外初始化 OAuth，用户填写 MCP URL、选择 OAuth 后即可前往提供方授权页。此错误与提供方不支持或暂时不可用分别展示。

测试覆盖加密绑定、密钥轮换、回调身份与 origin、刷新占用、撤销、会话清理及不重放。本地协议样例不能证明每个真实提供方的同意流程；部署启用与外部授权证据记录在[上线核验表](../central-rollout.md)。

参见[产品使用流程](central-administration.zh-CN.md)、[MCP 授权](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)和 [MCP 传输](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)。
