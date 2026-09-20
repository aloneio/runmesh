# 检查 Runner 能力与工具目录

调用 `inspect`，传入 `action=diagnostics` 和可读的 `workspace_id`，查看 Runner 支持情况、当前权限及服务端工具目录。**0.1.4** 支持扩展能力报告；v0.1.3 Runner 升级前会将这些能力报告为未知。

## 解释诊断结果

`runtime_capabilities` 包括 Runner 版本、方法契约摘要、支持的方法、功能协议版本和并发上限。报告公开能力元数据，主机身份、绝对路径、凭据及环境变量保持私有。

| 字段 | 含义 |
| --- | --- |
| `runner_support` | 认证 Runner 声明的实现能力；实际使用时还会检查操作系统访问和依赖 |
| `permission_snapshot` | 本次诊断观察到的 scope 和有效工作区权限 |
| `requires_final_authorization` | `true`：每次操作仍检查当前授权 |
| `requires_job_check` | 该动作还会检查 Job 实际所属工作区 |
| `host_catalog_state` | `not_observed`：需单独查看 MCP 应用实际加载的工具目录 |

报告缺失时为 `not_reported`，格式错误或版本不支持时为 `invalid`，两者的方法支持状态均为 `unknown`。有效的部分列表可以指出未支持的方法。判断能力时使用方法列表，确认构建来源时使用已验证的发行包；版本号和契约摘要各有用途。

当前目录包含 10 个公开工具、26 个 Runner 动作和 27 个受保护 RPC 方法，其中包括内部工作区列表方法。每次操作需要满足自身 scope、当前策略及工作区权限；实时文件、执行和 Context 操作还需要可用的 Runner 连接。

## 检查连接器目录

`/health` 的 `mcp_catalog` 包含 Schema 版本、SHA-256 指纹、工具名及数量、动作数量和方法契约摘要。每个 `tools/list` 条目在 `_meta["io.runmesh/catalog"]` 中携带精简指纹，诊断结果带完整摘要。

请对照这个摘要、认证后的 `tools/list` 响应，以及 MCP 应用显示的输入参数。目录过期时刷新对应连接器。凭据可继续使用，除非有其他原因需要轮换；请保持含秘密的 MCP 地址私有。

指纹覆盖公开 JSON Schema、说明、注解、scope 和动作映射。Worker 还会在运行时校验跨字段关系。忽略 `_meta` 的应用仍可使用工具，但需要直接比较显示的 Schema。

## 升级缺少的能力

安装包含所需功能的已验证 Runner 发行包，连接到兼容 Worker 后重新诊断。Worker 部署、Runner 安装和连接器刷新是三个独立步骤。

转发 `context.storage` 或 `context.prune` 前，Worker 会检查当前连接声明的对应方法。缺少支持时返回 `runner_upgrade_required` 和 `operation_state=not_started`，连接仍可用于其他已支持的操作。

## 诊断开销

公开健康接口读取目录时无需访问 Registry、Runner 或 D1。诊断使用已有的 `env.info` RPC 和缓存探测，仍有正常的授权请求开销；它不会增加可选的 Job／审计历史条目或修改 Runner 配置。
