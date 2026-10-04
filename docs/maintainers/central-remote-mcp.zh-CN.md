# 受控中央 HTTP MCP

> 维护者参考：接口、协议和验证边界。日常操作请阅读[用户指南](../central-remote-mcp.zh-CN.md)。

本页说明当前受控远程传输，托管 OAuth 和操作内会话见
[中央 OAuth](central-oauth.zh-CN.md)。所有部署启用仍须显式执行。

[English](central-remote-mcp.md)

**Runmesh 0.1.6 已包含这些能力。** 中央 HTTP 发现和调用接入控制台连接及审核目录。
开发与生产源码配置均包含独立中央绑定，并启用 Skills、直接目录和治理开关。
受管连接通过控制端保存目标策略，OAuth 加密密钥从现有部署密钥派生。
部署与升级步骤见[发行状态](../release-readiness.md)，验收证据见[发布记录](../central-rollout.md)。

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
参数保留传入的类型、值及字段缺省状态。展开 schema 与输入结构的预计工作量
超过配置上限时，校验拒绝该输入。

支持 JSON 和单次请求的 SSE 响应，保留文本、图片、音频、内嵌资源、资源链接、
结构化结果及工具级 `isError`。链接只作为数据返回，中继不会抓取链接。进度／日志
通知受到数量限制并被丢弃；根级传输元数据不会转发到客户端的认证界面。
本批次不提供连续进度转发。

当前支持托管 OAuth 和操作内 MCP 会话，详见 [OAuth](central-oauth.zh-CN.md)。
不支持任意请求头、查询凭据、stdio 托管、长期会话、GET 订阅、续传、tasks、sampling、
elicitation 或多轮交互；失败调用不自动重放。

## 连接与发布流程

在控制台输入公网 HTTPS MCP URL，选择无身份验证或 OAuth。已保存且启用的连接
就是精确出站准入，不需要环境变量白名单或手工 bearer 配置。OAuth 使用现有部署密钥。
非标准 HTTPS 端口、IP 字面量、私有主机、通配符、URL 用户信息、查询及片段均被拒绝。

先通过现有受保护管理接口创建并启用档案。随后 POST
`/admin/central/discovery/{profile_id}`，正文为 `{"expected_revision":0}`，沿用
管理员会话、同源及 CSRF 校验。完整、有界的 tools/list 结果一次性保存并发布全部工具，
只增加一个目录版本，所有有效客户端立即可用，无需单独审阅或批准，参见
[控制端管理界面](central-administration.zh-CN.md)。客户端仍需连接凭据，中央发布不授予机器权限。

发现接口不接受调用方提供 URL、token、请求头或命令。分页不完整、重复工具、
不支持的 schema、超时和上游失败不会覆盖旧的已审核目录。实际调用会再次获取
上游工具定义；所选工具的说明、schema 或注解变化后停止派发，需刷新工具，刷新成功后直接发布。
调用本身不改写目录，也不会每次请求都创建新目录版本。

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

已完成调用先关闭操作内会话，再执行最终的客户端及发布状态检查。异步清理结束后
再次检查凭据租约和出站策略；期间权限变化会扣留结果，但不会重放已完成的操作。
单纯清理失败不会丢弃仍有效的结果。工具发现同样将凭据及策略校验保留到目录哈希
完成及最终发布事务之前。

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
