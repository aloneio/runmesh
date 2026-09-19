# 用户指南

[English](user-guide.md) · [文档目录](README.zh-CN.md)

Runmesh 让兼容 MCP 的 AI 客户端使用管理员批准的机器和工作区。你需要完整的 MCP 地址、支持 Streamable HTTP 的客户端，以及至少一台 Runner 和一个工作区的使用权限。

## 连接客户端

在客户端的 MCP 设置中填写管理员提供的完整地址：

```text
https://your-host.example/<generated-secret>/mcp
```

地址本身就是凭据，只在创建或轮换时显示。完整复制秘密路径，去掉误复制的空格、换行，使用地址鉴权即可，无需额外的 Bearer token。真实地址应妥善保管，避免出现在对话、截图、工单或仓库中。

## 确认机器与工作区

1. 用 `runner_current` 查看当前选择，再用 `runner_list` 查找目标机器。
2. 尚未选择 Runner 时，调用 `runner_select`，即使列表中只有一台机器也应明确选择。切换已有选择须提供 `confirm_switch: true`；完成后用 `runner_current` 确认。
3. 用 `workspace_list` 查看获准的工作区 ID。先用 `read` 或 `inspect` 查看内容，再修改文件或执行命令。

使用 `workspace_list` 返回的工作区 ID，以及相对于该工作区的文件路径。Runner 离线期间会保留当前选择；跟踪已有任务时也应保持原 Runner。

请结合实例返回的工具目录和真实 ID 使用以下示例。缺少动作时可能需要刷新客户端目录；返回 `runner_upgrade_required` 时需要升级到兼容的 Runner。适用步骤见[版本说明](release-notes.zh-CN.md)和[故障排查](troubleshooting.zh-CN.md)。

## 读取、检查与修改

假设工作区名为 `work`，读取文件时可使用：

```json
{"workspace_id":"work","path":"README.md"}
```

`inspect` 支持列目录、搜索和 Git 检查。先用 `git_log` 查提交，再用 `git_show` 和必填的 `revision` 查看内容，或用 `git_blame` 和可选行范围查看归属。`revision` 只用于 `git_show`。Worker 更新后，客户端动作或参数与服务器有差异时，刷新工具目录。

使用 `edit` 前先读文件，并保留读取时的基线。遇到基线冲突，重新读取再生成补丁；遇到超时或结果未知，先检查补丁是否已经应用，再决定是否重试。权限拒绝交由管理员核对。

## 执行命令并保留回执

`shell` 使用 Runner 服务账号的操作系统权限；不可信代码应放在独立容器或虚拟机中执行。可先在获准的工作区运行无害检查：

```json
{"workspace_id":"work","command":"echo runmesh-ok","wait_ms":1000}
```

保留返回的 `job_id` 和 `workspace_id`。`wait_ms` 控制本次调用等待结果的时间，命令可以在调用返回后继续执行。收到 `running` 或 `queued` 回执后，继续查询直到任务进入最终状态，并检查存在时的 `exit_code`。

已启动的进程会在浏览器关闭或短暂断线后继续执行。调用超时后先查询原任务，再考虑是否需要另一次启动。使用工具支持的 `request_id` 时，同一个键始终绑定相同的启动参数。

## 跟踪同一个任务

将 `job-from-shell` 替换为回执中的真实 ID。支持工作区绑定任务查询的实例使用：

```json
{"action":"get","job_id":"job-from-shell","workspace_id":"work"}
```

```json
{"action":"logs","job_id":"job-from-shell","workspace_id":"work","stream":"stdout","offset":0,"limit":16384}
```

也可用带工作区 ID 的 `list` 查看本地近期任务，包括关闭云端记录的任务。查询需要任务所属工作区的权限。客户端拒绝 `workspace_id` 时，请管理员核对 Worker、Runner 和缓存的工具定义。

| 状态 | 对使用者的含义 |
| --- | --- |
| `queued` | 正在等待执行槽，启动前会重新检查权限。 |
| `running` | 进程正在受 Runner 监督。 |
| `cancelling` | 正在处理取消，请等待最终状态。 |
| `cancelled` | 排队任务已撤回，或已观察到的终止有取消送达证据支持。 |
| `succeeded` | Runner 观察到进程成功退出。 |
| `failed` | 启动或执行失败，应查看已有输出和错误详情。 |
| `unknown` | 恢复的进程可能仍存活，提交相关工作前先检查它。 |
| `interrupted` | 恢复已结束，尚无确认的执行结果；应检查已有输出和操作影响。 |

Runner 重启后，尚未启动的排队任务会变为 `interrupted`，恢复中的进程可能需要人工检查。取消与正常零退出码结束同时发生时，最终可以是 `succeeded`。

## 日志、输入与取消

前台回执可能只含末尾输出。正数 `offset` 表示该响应省略了前面的字节，可用 `job` 工具的 `logs` 动作分页读取仍保留的内容。原样使用返回的游标；工具目录禁止时，不要把游标与新的偏移或末尾模式混用。

本地日志有大小上限，`output_truncated` 可能表示部分字节已永久丢弃。应用另有日志采集时，可请管理员一并检查。

`input` 必须提供 `data` 或 `close_stdin: true`；关闭标准输入表示发送输入结束信号。`cancel` 需要任务控制权限。输入或取消发生送达错误、超时后，先检查原进程，再决定是否重试。进程身份无法确认时，Runner 会保留其记录和并发槽位，交由管理员在主机上核对。

云端历史保存可选的近期任务快照，输出从 Runner 保留的日志中读取。实时输入、取消和日志读取需要 Runner 在线且授权有效；此前记录的云端元数据可在离线期间保留。记录设置控制后续上传，与本地执行和日志读取分别管理。

## 保存工作区交接记录

`context` 工具将你明确提交的交接记录保存在所选 Runner 上。用 `bootstrap` 查找已有记录，`read` 或 `search` 读取记录，再用 `checkpoint` 保存目标、决策、证据和后续步骤。创建检查点需要写入权限，内容来自你明确提交的记录。

Worker 和 Runner 均兼容时，`storage` 可查看本地 Context 用量，`prune` 可预览要删除的旧版本。执行删除必须提供预览返回的计划哈希和明确的 `apply: true`，每条记录的最新版本会保留。删除前请阅读 [Context 存储说明](context-storage.zh-CN.md)。需要使用这两个存储管理动作时，请从 0.1.3 升级到包含它们的已验证发行版本。

## 安全求助

权限错误需要同时检查客户端、Runner 和工作区设置。Runner 离线时先恢复原机器，也可为新工作明确选择另一台机器。依赖服务故障时，等待服务恢复并检查原操作。

恢复方法见[故障排查](troubleshooting.zh-CN.md)。反馈问题时提供时间、操作、版本和脱敏错误代码，分享前去掉凭据、私有文件内容和敏感命令输出。
