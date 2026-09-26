# 受控中央 HTTP MCP（开发版）

本页说明当前受控远程传输，托管 OAuth 和操作内会话见
[中央 OAuth](central-oauth.zh-CN.md)。所有部署启用仍须显式执行。

[English](central-remote-mcp.md)

**状态：开发实现，未在生产环境启用。** 中央 HTTP 发现和调用接入控制台连接
及审核目录。development 配置有独立中央绑定，并显式
启用 Skills、直接目录和治理开关；配置未预置远程端点或密钥环，受管连接通过控制端保存目标策略，仅 OAuth 需要密钥库。生产配置不变；本说明不代表正式发版或通过真实公网服务验收。

## 已实现能力

Worker 是统一入口，不需要在每台 Runner 上安装上游 MCP。中央操作不要求注册、
选定或连接任何 Runner，也不隐含机器权限。客户端继续负责推理，随后可以独立调用
原生 Runner 工具；Runmesh 不把上游文本当成 Shell 命令执行。

remote_profiles 列出有已发布工具的服务，remote_tools 查询对应档案的审核定义，
remote_call 接受精确档案、工具 ID、版本和参数。所有有效客户端共享这些发布内容，
不需要授权行；客户端凭据、服务停用、上游 OAuth 和实时 schema 仍独立检查。原生
调用不解析中央存储或连接上游。大目录使用有界服务与工具发现，中央故障保留原生工具。

## 协议支持

控制台连接与已保存端点协商支持的 MCP 版本，用户无需手工指定协议版本。
官方 MCP Client SDK 固定为 2.0.0，封装在平台适配层。
Cloudflare JSON Schema 解释器验证已有的受限目录 schema，不动态生成代码；
参数不会被类型强转，也不会自动插入默认值。展开 schema 与输入结构的保守工作量
上限会拒绝昂贵输入，而不是允许无界同步计算。

支持 JSON 和单次请求的 SSE 响应，保留文本、图片、音频、内嵌资源、资源链接、
结构化结果及工具级 `isError`。链接只作为数据返回，中继不会抓取链接。进度／日志
通知受到数量限制并被丢弃；根级传输元数据不会转发到客户端的认证界面。
本批次不提供连续进度转发。

当前支持托管 OAuth 和操作内 MCP 会话，详见 [OAuth](central-oauth.zh-CN.md)。
不支持任意请求头、查询凭据、stdio 托管、长期会话、GET 订阅、续传、tasks、sampling、
elicitation 或多轮交互；失败调用不自动重放。

## 配置与审核流程

在控制台输入公网 HTTPS MCP URL，选择无身份验证或 OAuth。已保存且启用的连接
就是精确出站准入，不需要环境变量白名单或手工 bearer 配置。OAuth 使用独立密钥库。
非标准 HTTPS 端口、IP 字面量、私有主机、通配符、URL 用户信息、查询及片段均被拒绝。

先通过现有受保护管理接口创建并启用档案。随后 POST
`/admin/central/discovery/{profile_id}`，正文为 `{"expected_revision":0}`，沿用
管理员会话、同源及 CSRF 校验。完整、有界的 tools/list 结果只进入 W04 待审核目录，
不会自动批准。再通过目录审核接口检查和批准指定工具，批准后所有有效客户端即可使用，参见
[控制端管理界面](central-administration.zh-CN.md)。客户端仍需连接凭据，中央发布不授予机器权限。

发现接口不接受调用方提供 URL、token、请求头或命令。分页不完整、重复工具、
不支持的 schema、超时和上游失败不会覆盖旧的已审核目录。实际调用会再次获取
上游工具定义；所选工具的说明、schema 或注解变化后停止派发，必须重新发现与审核。
调用本身不自动批准变化，也不会每次请求都创建新目录版本。

## 信任与执行边界

每次出站使用重新构造的请求头，仅在 OAuth 连接时注入服务访问令牌。客户端 URL 密钥、
入站 Authorization、浏览器 Cookie、Runner token 和控制面秘密均不转发。
协议需要的头由适配器填写，不跟随重定向；认证由托管 OAuth 适配器处理，不自动重连或重放。
入站 Runmesh MCP 拒绝 `x-runmesh-mcp-hop` 标记，避免中继递归。

必须保留仓库已经开启的 `global_fetch_strictly_public`，让同域请求也经过公网入口，
而不是绕过该域安全规则直达源站。独立 workerd 部署必须保留默认的仅公网全局出站
网络及 DNS 地址过滤；不能把此适配器接到私网、VPC／源站绑定或更宽松的 fetch。
精确白名单是另一层应用控制，不声称 DNS 预检查能够固定之后连接的 IP。
部署及网络边界仍需独立验收。

每次操作使用全新的 SDK 客户端和凭据上下文。解密前、出站轮次前，以及最终
tools/call 派发前检查权限和档案代次；新 tools/list 将所选定义与已批准版本比较。
异步等待后重新检查身份、授权、目录和档案版本，不把旧目录可见性当作当前执行权限。

派发后的失败可能表示操作已经发生、响应却丢失，此时返回 `operation_state: unknown`。
只读或幂等注解不能触发自动重试。若结果已经返回但客户端在执行期间被撤权，则扣留
数据，同时保留操作已完成的事实。取消本地 I/O 或达到截止时间不能回滚上游副作用，
不承诺恰好执行一次或跨所有者原子事务。外层 MCP 连接断开也不能证明 DO 调用已取消。

## 有界执行与持久化

| 预算 | 初始上限 |
| --- | --- |
| 单次所有者操作 | 20 秒 |
| 每所有者／每客户端活跃操作 | 2／1，不排队 |
| 出站请求／单响应 | 64 KiB／1 MiB |
| 累计响应 | 2 MiB |
| HTTP 请求／目录分页 | 12／8 |
| 完整目录工具数量 | 128，另受 W04 字节和节点约束 |
| 响应片段／SSE 事件 | 4,096／256 |
| 返回内容块 | 32 |
| 出站端点策略 | 64 项／16 KiB |

这些是准入上限，不是吞吐量或费用承诺；单次预算包含连接、目录检查、验证和执行。
暂态并发限制不是分布式限流器，重启不会重放操作。调用不会创建 Runner Job，不向
审计表写入参数／结果正文，也不留下请求生命周期以外的定时器。W09 通过
CENTRAL_GOVERNANCE_ENABLED=1 加入可选元数据回执、所有者内速率限制与冷却，
见[中央管理与治理](central-administration.zh-CN.md)。费用和线上验证仍须外部验收。

## 验证范围与依据

测试使用官方客户端／服务端 SDK、真实 Fetch Request/Response 对象、本地实际
DO／SQLite 和 Registry 权限链，以及模拟上游服务。覆盖两种协议、UTF-8 分片 SSE、
凭据隔离、定义变化、撤权、并发准入、过大／损坏响应和派发后失败。
这些测试不连接私人账户，也不代替真实公网服务互操作验收。

实现参考：[官方 TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)、
[Cloudflare 公网 fetch 配置](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public)、
[workerd 公网与 DNS 过滤规则](https://github.com/cloudflare/workerd/blob/main/src/workerd/server/workerd.capnp)、
[Cloudflare JSON Schema 解释器](https://github.com/cfworker/cfworker/tree/main/packages/json-schema)。
