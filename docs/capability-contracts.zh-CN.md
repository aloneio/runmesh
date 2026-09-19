# 检查 Runner 能力与工具目录

使用 `inspect` 的 `action=diagnostics`，查看当前 Runner 声明的能力及客户端的有效权限。扩展能力报告已在 **0.1.4 候选版**中实现。已安装的 v0.1.3 Runner 可以保持连接，但这些能力会显示为未知。

## 可用操作

当前目录包含 10 个公开工具和 26 个由 Runner 执行的动作。共享协议定义 27 个受保护 RPC 方法，其中包含内部工作区列表方法。目录中出现某个方法，不代表所选 Runner 已支持，也不代表当前客户端有权调用。

每次调用都要满足明确的 MCP scope、工作区权限及当前 Runner 策略。Job 操作还会检查任务实际所属的工作区。选择 Runner 和查询工作区元数据通过控制面处理；实时文件、执行及 Context 操作需要可用的 Runner 连接。

## 分开报告能力与权限

`runtime_capabilities` 报告包括 Runner 版本、方法契约摘要、支持的方法、功能协议版本和并发上限。主机名、绝对路径、服务身份、凭据和环境变量不进入该报告。

| 字段 | 正确含义 |
| --- | --- |
| `runner_support` | 在线对端自报实现该方法，不表示操作系统访问和外部依赖均已验证 |
| `permission_snapshot` | 本次 scope 与有效权限的观测，不是之后可以复用的执行授权 |
| `requires_final_authorization` | 始终为 true，每次调用仍须通过最终检查 |
| `requires_job_check` | 该动作还需要已有的任务和工作区检查 |
| `host_catalog_state` | 固定 `not_observed`，服务端不假装看到宿主内部缓存 |

旧 Runner 未报告时显示 `not_reported`；格式无效或不支持时显示 `invalid`。两者的方法支持状态均为 `unknown`，不按版本号猜测。有效但不完整的方法列表可以明确表示不支持。指纹不一致不会自动升级、重注册或放宽权限。

报告是经过认证的对端观测，不是签名构建证明；目录指纹也不是源码提交。权限在观测之后仍可能变化，实际执行必须重新检查。

## 对照真实目录

`/health` 的 `mcp_catalog` 包含目录摘要、工具名及数量、动作数量和操作契约摘要。每个 `tools/list` 条目的 `_meta["io.runmesh/catalog"]` 携带相同指纹，诊断带完整摘要。

指纹覆盖公开输入／输出 JSON Schema、说明、注解、scope 和动作映射，不覆盖源码、宿主缓存或 JSON Schema 无法表达的跨字段校验。

宿主可能缓存旧 Schema 或忽略元数据。服务端一致不能证明宿主已经刷新；应分别对照真实 tools/list 和宿主显示参数。只刷新相关连接器，不为此重新生成凭据。MCP 地址含秘密，不得发布完整地址、授权头或带凭据的抓包。

## 开销和兼容边界

摘要只在 Worker 实例加载时计算，不新增数据库读写、定时器或逐调用监控。健康接口不访问 Registry、Runner 或 D1。诊断没有增加原有 RPC 数量，也不创建任务／审计历史行；已有鉴权仍有成本。

Runner 报告复用已有的缓存探测。诊断不会安装依赖、修改权限或写入 Runner 配置。

更新 Worker 不会升级 Runner，也不会刷新 MCP 客户端的工具目录。请安装包含所需功能的已验证 Runner 发行包；客户端缓存过期时，只刷新对应连接器。

对于 `context.storage` 和 `context.prune`，Worker 还会在发送前检查当前认证连接声明的方法。缺少支持时返回 `runner_upgrade_required` 和 `operation_state=not_started`，旧连接仍然可用。兼容性检查不能替代权限检查。
