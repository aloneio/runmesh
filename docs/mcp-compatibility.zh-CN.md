# MCP 兼容性矩阵

[English](mcp-compatibility.md)

Runmesh 提供有界远程工具发现及调用，不执行任意服务端代码或全部可选 MCP 功能。

| 接口 | 支持范围及边界 |
| --- | --- |
| Streamable HTTP | JSON、请求内 SSE，有状态及无状态服务 |
| 协议协商 | 2026-07-28 发现及固定 SDK 支持的 2025/2024 初始化协议 |
| 会话标识 | 可见 ASCII，最多 4 KiB，限单次操作 |
| 响应分帧 | UTF-8 分片、CRLF/LF、注释和空心跳、EOF 前完整末帧 |
| MIME | JSON、application/*+json；缺失或文本类型须经过严格 JSON-RPC 校验 |
| 工具描述 | 校验执行字段，安全投影图标、版本及注解扩展 |
| JSON Schema | 2020-12、2019-09、draft-07/06，保守规范化 draft-04/OpenAPI；支持组合、依赖、元组、局部无环引用和锚点 |
| 正则约束 | 结构及输入计算预算；不支持时隔离工具，绝不删除约束后执行 |
| 参数请求头 | 仅 SDK 从合法 string/integer/boolean 输入生成的 Mcp-Param-* |
| 返回结果 | 有界文本、图像、音频、资源、链接、结构化 JSON 和工具错误 |
| 认证 | 保留 CIMD、DCR、预注册客户端、加密凭据及 issuer/PKCE/state 校验 |
| 单工具隔离 | 支持的工具发布并提示排除项；非空目录全部不支持时保留原发布 |
| 大目录 | 最多 512 个工具，通过 remote_search/remote_tools/remote_call 避免直接菜单过载 |

## 明确边界

中央 Worker 不托管 stdio，不自动接入双端点旧 HTTP+SSE，不跟随任意重定向、加载外部
Schema、恢复执行或自动履行 sampling/elicitation/roots/task/多轮交互。`/sse` 地址若实际
提供 Streamable HTTP 仍可工作，不能仅凭路径判断协议。
未知必需 vocabulary、递归或动态引用及不安全正则不会当作成功校验。参数不转换、不补默认值、
不删除字段；工具提示不授予权限，JSON-RPC ID 不转换类型，结果不明的写操作不自动重试。

单次最多 20 秒、40 次请求、32 页；单响应 2 MiB，累计 8 MiB，单工具 64 KiB，
单目录 2 MiB，最多 128 块结果。全局存储、Schema 图和计算预算仍生效，数字不是吞吐量承诺。

发现回执包含 `excluded_tools` 工具名及固定原因，界面显示该次刷新数量及部分名称。
重名、不完整分页、畸形封装及全局容量错误不会覆盖旧目录；真实空目录可以发布为空。
“检查连接”只统计格式合法的描述，不执行业务操作，不保证全部 Schema 可执行。

## 验证范围

离线测试覆盖固定 GitLab 源码的合成样本、GitHub 参数头、旧版及现代 SDK、版本降级、
不安全 Schema 和隔离发布。GitLab 样本不是用户授权抓包。
2026-10-15 在 oci0 对 Microsoft Learn、DeepWiki、Cloudflare Documentation 的公开 MCP
完成握手、列工具及各一次只读调用，均 `isError: false`；没有安装或发布这些服务。
这不代表私人 GitLab OAuth 或未来版本已验收；部署后仍需刷新用户现有授权连接。
参考文档及版本信息见 [英文矩阵](mcp-compatibility.md)。
