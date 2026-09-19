# 读取文件与日志分页

文件和 Job 日志按受限大小分页返回。**0.1.4 候选版**增加了分页状态和输出可用性元数据；旧 Runner 可能只返回兼容字段。需要各页绑定到同一份文件或日志代次时，可选择[快照与追加模式](bound-cursors.zh-CN.md)。

## 继续读取

普通读取使用数字字节游标。将返回的 `next_cursor` 传入下一次请求即可翻页。游标只会前进或为空。末尾出现不完整 UTF-8 字符时，结果会报告待补全字节并停止翻页；源文件增长后，可在 `resume_offset` 处显式刷新，补读该字符。

Runner 在每次读取中检查文件身份、大小、修改时间及变更时间。日志允许正常追加，同时检查观察到的截短、替换和同大小改写。发现变化时，需要重新读取。数字游标表示字节位置，各次请求可能观察到不同文件版本；需要跨页一致性时选择快照模式。

## 解释分页字段

| 字段 | 含义 |
| --- | --- |
| `page_protocol` | 数字字节分页契约版本 `1` |
| `page_state` | `more`：可继续翻页；`end`：到达本次观察末尾；`incomplete`：末尾字符待补全 |
| `returned_bytes` | 返回 `data` 的 UTF-8 字节数 |
| `total_bytes` | 本次读取观察到的源大小 |
| `resume_offset` | 已返回完整字符之后的源字节位置 |
| `pending_bytes` | 不完整末尾等待补全的 1—3 字节 |
| `truncated_reason` | `page_limit`、`response_bytes`、`incomplete_utf8` 或空 |
| `snapshot_id` | 数字游标读取时为空 |
| `source_truncated` | 日志专用，表示整个 Job 的保存输出截断标记 |

`next_cursor`、`offset`、`size`、`truncated` 和 `data` 等兼容字段继续保留。`page_state=incomplete` 时，空 `next_cursor` 表示应停止翻页，末尾仍有待补全字节。`source_truncated` 针对整个 Job，无法提供每个输出流丢失的具体字节数。

源内容中的非法 UTF-8 使用 Node 替换解码；分页边界处的完整字符会保留。Worker 校验元数据并返回允许的字段；可选字段缺失时，应视为该观测暂不可用。详见[MCP 输出契约](mcp-output-contracts.zh-CN.md)。

## 处理日志不可用

`log_unavailable` 表示日志文件缺失、访问受限、类型不符或其他读取故障。排队中的 Job 可能尚未创建日志。已存在的空普通文件会返回成功的空页。

`shell` 结束后，内嵌 stdout／stderr 读取失败时，使用实际 Job ID、状态和退出码。相应流返回 `available:false` 与 `log_unavailable`，此时应重试日志查询。再次执行命令会产生新的执行，而不是找回原日志页。

## 读取预算与兼容性

MCP 文件页最多请求 **32 KiB** 正文，Job 日志页最多 **16 KiB**。读取另加最多 3 字节向前补全和 7 字节对齐探测。操作系统短读时，每个缓冲区最多重试 32 次；提前读到零字节或用完预算会返回错误。

文件和日志结果序列化后限制在 **48 KiB** 内，为 Worker 元数据预留空间。JSON 转义计入响应大小，`returned_bytes` 则只计正文 UTF-8 字节。授权和元数据检查仍有正常资源开销。

当前 Worker 接受合法的兼容结果并保留已有字段。旧 Worker 可能省略扩展分页或可用性元数据；依赖这些字段前，请安装兼容的 Worker 和 Runner。可用的一致性模式由已安装 Runner 的能力决定。
