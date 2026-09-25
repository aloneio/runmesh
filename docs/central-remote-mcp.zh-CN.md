# 受控中央 HTTP MCP（开发版）

本页说明 W05 的无状态基线。可选 W06 OAuth 和临时会话扩展及其支持边界见
[中央 OAuth](central-oauth.zh-CN.md)。所有部署启用仍须显式执行。

[English](central-remote-mcp.md)

**状态：dev 上的 W05 实现，未在生产环境启用。** 中央 HTTP 发现和调用已接入
W03 凭据档案及 W04 审核目录。development 配置现已增加独立中央绑定，并显式
启用 Skills、直接目录和治理开关；配置未预置远程端点或密钥环，远程 MCP 在补齐
这些配置前仍关闭。生产配置不变；本说明不代表正式发版或通过真实公网服务验收。

## 已实现能力

Worker 是统一入口，不需要在每台 Runner 上安装上游 MCP。中央操作不要求注册、
选定或连接任何 Runner，也不隐含机器权限。客户端继续负责推理，随后可以独立调用
原生 Runner 工具；Runmesh 不把上游文本当成 Shell 命令执行。

可选工具 `remote_tools` 查询某个连接档案下已审核且已授权的定义；`remote_call`
接受档案 ID、精确工具 ID、批准版本和参数。原生十个工具的工厂及契约保持不变。
只有 CAPABILITIES 与有效出站策略同时存在，才提供这两个中央工具。发现时还会
检查当前已启用的远程工具授权；没有对应授权的客户端看不到 remote_tools、
remote_call、remote_status 或直接别名。原生调用不解析中央存储、读取密钥或连接
上游；中央发现失败只隐藏中央入口，不会移除原生工具。
这是一组发现／调用接口，不会把成千上万个定义默认注入每个客户端上下文。

## 协议范围

每个精确端点显式选择 `2026-07-28`，或无状态 Streamable HTTP 兼容通道
`2025-11-25`。官方 MCP Client SDK 固定为 2.0.0，封装在平台适配层。
Cloudflare JSON Schema 解释器验证已有的受限目录 schema，不动态生成代码；
参数不会被类型强转，也不会自动插入默认值。展开 schema 与输入结构的保守工作量
上限会拒绝昂贵输入，而不是允许无界同步计算。

支持 JSON 和单次请求的 SSE 响应，保留文本、图片、音频、内嵌资源、资源链接、
结构化结果及工具级 `isError`。链接只作为数据返回，中继不会抓取链接。进度／日志
通知受到数量限制并被丢弃；根级传输元数据不会转发到客户端的认证界面。
本批次不提供连续进度转发。

尚不支持 OAuth 刷新／提权、任意请求头、查询参数凭据、stdio 托管、长期会话、
独立 GET SSE、断线续传、异步 tasks、sampling、elicitation 或多轮输入。
上游返回会话标识或不支持的交互时明确拒绝，不在失败调用后自动降级协议。
这些能力需要 W06 及后续独立适配与验证，不能通过放宽当前限制悄悄引入。

## 配置与审核流程

经过单独审核的测试部署需要独立的凭据密钥环，以及以下精确、规范化、不含秘密的
HTTPS 策略。示例没有真实凭据，本次代码变更不会自动安装该配置：

```json
{
  "schema_version": 1,
  "endpoints": [
    { "endpoint": "https://api.example.com/mcp", "protocol": "2026-07-28" }
  ]
}
```

变量名为 `CENTRAL_MCP_EGRESS`，缺失或格式错误时不开放远程入口。不接受非标准
HTTPS 端口、IP 字面量、私有／歧义主机形式、通配符、URL 用户信息、查询字符串和
片段；连接档案必须已启用，并精确匹配策略。

先通过现有受保护管理接口创建并启用档案。随后 POST
`/admin/central/discovery/{profile_id}`，正文为 `{"expected_revision":0}`，沿用
管理员会话、同源及 CSRF 校验。完整、有界的 tools/list 结果只进入 W04 待审核目录，
不会自动批准。再通过目录审核接口检查和批准指定工具，最后为每个客户端授予精确
工具 ID、版本和连接档案权限，可使用 [W08 管理界面](central-administration.zh-CN.md)。
身份存在、档案启用或目录批准，都不等于客户端已经得到工具权限。

发现接口不接受调用方提供 URL、token、请求头或命令。分页不完整、重复工具、
不支持的 schema、超时和上游失败不会覆盖旧的已审核目录。实际调用会再次获取
上游工具定义；所选工具的说明、schema 或注解变化后停止派发，必须重新发现与审核。
调用本身不自动批准变化，也不会每次请求都创建新目录版本。

## 信任与执行边界

每次出站使用重新构造的请求头，只注入该档案解密出的 bearer。客户端 URL 密钥、
入站 Authorization、浏览器 Cookie、Runner token 和控制面秘密均不转发。
协议需要的头由适配器填写，不跟随重定向或认证发现，不配置自动认证、重连或重放。
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
