# Runner 与协议验证记录

日期：2026-10-12。基线：`origin/dev` 的 `115ba45`，以及本次 0.1.8 候选修复。执行平台：Windows，Node.js 22.23.2。

## 检查与修复

检查覆盖作业排队、stdin、日志分页、取消、终态持久化和重启恢复，以及协议、Context 证据、原生服务和独立升级管理器。审阅以待发布 dev 分支为准；dev 已包含的历史修复未重复列为缺陷。

确认并修复原生进程退出码在各层处理范围不一致的问题：作业恢复、MCP 投影、公开输出 schema 和 Context 证据统一保留 `-2147483648` 至 `4294967295` 的整数。Windows 普通退出码 3010 和原生状态 3221225477 已通过真实子进程完成与重启恢复测试。

v2 `job.completed` 保持原有 `-1..255` 协议范围。范围外的数值在该旧版生命周期摘要中投影为 `null`，完成状态正常发送；Job 查询、shell 详细结果和本地记录保留原始数值。协议 JSON schema 和已发布 maintenance v1 客户端 fixture 保持原 hash。

定向验证：协议 25 项、Runner 作业报告与 Context 19 项、Worker MCP 输出 59 项、公开契约基线 3 项，合计 106 项通过。

## 本地并发负载

[原始指标](runner-functional-load-2026-10-12.json) 与[驱动器](runner-functional-load-driver.mjs)保留本轮证据。最终完整运行耗时 119.754 秒，594 次计时操作通过；驱动器峰值常驻内存约 53.7 MiB，此数值只统计驱动器进程。

在已安装项目依赖的 Windows checkout 中，可用项目支持的 Node 版本和 PowerShell 重现：

```powershell
npx --no-install esbuild reports/runner-functional-load-driver.mjs --bundle --platform=node --format=esm --alias:@aloneio/runmesh-protocol=./packages/protocol/src/index.ts --outfile=.audit/runner-functional-load.bundle.mjs
$env:RUNMESH_LOAD_GIT = (Get-Command git).Source
node .audit/runner-functional-load.bundle.mjs
```

| 功能 | 本轮负载与断言 |
| --- | --- |
| 作业排队 | 3 个执行槽，3 个客户端，18 个成功作业，等待队列峰值 15；执行槽上限保持为 3 |
| stdin 与取消 | 3 次 EOF 释放持有作业；另 4 个真实 Node 作业取消并收敛到终态 |
| 日志与重启 | 252 个 UTF-8 日志页逐字重组；18 个成功记录经新 JobManager 实例完整恢复 |
| 文件编辑 | 24 次新增与 24 次更新，4 路并发，各文件最终内容一致 |
| 文件读取 | 192 次读取、31 个快照分页，精确验证中英文与 emoji 内容 |
| 搜索 | 4 次目录搜索均返回 24 条；另一次缩小目录范围搜索返回 1 条完整结果 |
| Git | status、diff、log、show、blame 各 3 次，最多 2 个 Git 调用并发；实际执行本机 Git |
| Context | 12 个 checkpoint，4 路提交，12 次新实例读取和完整搜索 |

最终运行中，文件更新 P95 为 6.672 秒、最大 8.475 秒；文件新增最大 9.287 秒；日志分页 P95 为 330 毫秒；作业取消最大 630 毫秒。主机同时承载其他验证工作，指标用于记录本轮负载条件，不作为服务级性能承诺。

驱动器准备阶段依次校准了作业 RPC 的 `expected_workspace_id`、Git show 的提交哈希参数、搜索时间预算断言。准备阶段曾观察到目录搜索按时间预算返回部分结果并附带截断证据，以及文件更新约 14 秒的单次延迟；这些观测保留为容量规划依据。最终完整运行使用校准后的驱动器，所有内容与状态断言通过。

## 证据边界

本轮负载使用隔离临时目录、真实 Node/Git 子进程与文件系统 API，不连接生产服务，也不操作系统级 Runner 注册。驱动器使用显式的本机 Git 路径作为测试注入。升级协调器、服务回滚和跨平台服务适配器由项目完整测试及 CI 矩阵覆盖；原生 Linux/macOS 服务行为需由对应平台执行证据确认。Worker→Runner 网络链路和浏览器验证另行记录。
