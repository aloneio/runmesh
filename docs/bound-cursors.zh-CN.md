# 使用文件快照与追加日志游标

需要从同一份已捕获内容读取文件各页时，选择 `consistency:"snapshot"`；需要通过多次显式读取跟进 Job 日志时，选择 `consistency:"append"`。**0.1.4** 支持这些模式，需要兼容的 Worker 和 Runner。普通数字游标仍是默认模式。

## 读取文件快照

```json
{"workspace_id":"workspace","path":"src/example.ts","consistency":"snapshot","limit":4096}
```

Runner 将最多 **1 MiB** 的文件读入进程内不可变缓冲区，返回其 SHA-256 作为 `snapshot_id`。继续读取时，原样传回不透明的 `next_cursor`。后续成功页使用同一缓冲区。

每次继续读取都会检查当前权限、工作区及根目录身份、解析后的路径、操作系统访问条件，以及文件身份、大小和变更信息。观察到修改或替换时返回 `file_changed`。游标还绑定读取器实例和策略代次。

`snapshot_id` 标识实际捕获的字节。文件系统读取不是操作系统原子快照，外部写入可能与首次捕获竞争；需要更强保证时，应保护主机和源文件。大于 1 MiB 的文件返回 `snapshot_too_large`；普通分页已能满足需求时，可显式发起新的 `live` 读取。

## 跟进追加日志

```json
{"action":"logs","workspace_id":"workspace","job_id":"job-example","stream":"stdout","consistency":"append","limit":4096}
```

游标绑定 Runner 本地 Job 管理器、Job、工作区、输出流、策略代次和观察到的文件代次，正常追加后仍可使用。这里的 `snapshot_id` 是代次标识，而非整份日志的内容哈希。

检查覆盖文件替换、观察到的缩短、同大小元数据变化，以及开头最多 256 字节和上次观察边界附近最多 256 字节的 SHA-256。通过受限读取即可检测普通轮转和常见的截断后重新增长。

此模式适用于 Runner 管理的只追加日志。外部写入者可能修改未采样的内部字节，或在两次观察间恢复被检查的字节；防止此类篡改需要主机访问控制。

到达本次观察末尾时，`next_cursor` 为空，`resume_cursor` 保留代次和位置，供之后显式刷新。不完整 UTF-8 字符保留起始偏移，追加剩余字节后可继续读出。

## 继续读取或恢复

绑定结果使用 `page_protocol:2`，包含 `consistency`、`snapshot_id`、`resume_cursor`、`cursor_expires_at_ms`，以及字节统计和分页状态。Worker 会检查字段及资源绑定关系。

游标应继续用于原资源和一致性模式。绑定游标请求需省略显式 `offset`、`tail:true` 和 `consistency:live`。首次快照或追加读取省略游标，之后使用返回的不透明游标。

| 结果 | 下一步 |
| --- | --- |
| `cursor_expired` | 重新发起读取；缓存已过期、被淘汰或属于上一次 Runner 进程 |
| `cursor_mismatch` | 核对资源、输出流、工作区及策略，使用匹配参数重新读取 |
| `file_changed` 或日志轮转 | 重新读取当前来源 |
| `runner_upgrade_required` | 安装已验证的兼容 Runner；原响应缺少请求模式所需的绑定证据 |

这些错误涉及已有资源的读取。查询 Job 日志时保留原 Job ID；恢复游标无需再次执行命令。

## 资源限制

| 资源 | 限制 |
| --- | --- |
| 文件缓存 | 每进程 16 项、合计 8 MiB 正文 |
| 首次捕获 | 最多四个并发缓冲区，每项 1 MiB；最多 64 次读取，在 I/O 完成之间检查两秒期限 |
| 日志缓存 | 256 项、256 KiB 计量元数据，不额外缓存日志正文 |
| 日志附加检查 | 每次继续读取最多 2 KiB 边界数据，另有原分页与 UTF-8 探测 |
| 游标寿命 | 创建后五分钟；访问保持原到期时间 |

捕获期限采用协作式检查，单次操作系统调用可能更久。在途缓冲区、对象和序列化还有额外内存开销。缓存在访问时清理，并在 Runner 退出时释放；过期条目可能保留到清理时，但仍受缓存总量约束。

分页元数据计入响应大小。文件读取保留元数据审计；Job 记录偏好用于其可选历史及 `exec.*`／`job.*` 审计条目。详见[任务记录设置](batched-job-history.md)。

先部署兼容 Worker，再安装已验证 Runner；MCP 输入 Schema 过期时刷新对应连接器。详见[能力诊断](capability-contracts.zh-CN.md)。
