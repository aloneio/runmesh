# Runner 与协议验证记录

日期：2026-10-12。基线：`origin/dev` 的 `115ba45`，以及本次 0.1.8 候选修复。执行平台：Windows，Node.js 22.23.2。

当前状态：候选 `aab0b18` 的 push CI 全部成功；PR CI 的 Windows 网络 E2E 记录 3 项失败，其余 jobs 成功。本机干净源码与安装包 E2E 各 41/41 通过、混合请求各 512 次成功；源码日志另记录原生运行时退出与重启，所处测试或收尾阶段尚未归因。完整证据与历史 `5984ae8` 记录分别保存，0.1.8 保持 candidate。

## 检查与修复

检查覆盖作业排队、stdin、日志分页、取消、终态持久化和重启恢复，以及协议、Context 证据、原生服务和独立升级管理器。审阅以待发布 dev 分支为准；dev 已包含的历史修复未重复列为缺陷。

确认并修复原生进程退出码在各层处理范围不一致的问题：作业恢复、MCP 投影、公开输出 schema 和 Context 证据统一保留 `-2147483648` 至 `4294967295` 的整数。Windows 普通退出码 3010 和原生状态 3221225477 已通过真实子进程完成与重启恢复测试。

v2 `job.completed` 保持原有 `-1..255` 协议范围。范围外的数值在该旧版生命周期摘要中投影为 `null`，完成状态正常发送；Job 查询、shell 详细结果和本地记录保留原始数值。协议 JSON schema 和已发布 maintenance v1 客户端 fixture 保持原 hash。

定向验证：协议 25 项、Runner 作业报告与 Context 19 项、Worker MCP 输出 59 项、公开契约基线 3 项，合计 106 项通过。

### A05：首次 Shell 发现失败被永久缓存

源码检查确认，Runner 原先只在初始化时发现 Host shell，首次发现返回空值后，进程生命周期内后续 shell 请求始终返回 `shell_unavailable`。一次端到端运行观察到 Runner 保持在线、文件读取成功而连续 shell 请求返回该状态；当次首次探测的具体失败原因未被捕获，因此该观测不能证明是 5 秒探测超时。

修复将失败发现结果保留 5 秒；之后通过权限与输入检查的 shell 请求可再次发现受信 shell。并发请求共享一个发现过程，成功结果继续缓存。原有可信可执行文件路径、探测环境和单次探测预算保持一致。发现过程只处理本机能力，不保存或重试用户命令。启动参数复用 JobManager 的纯校验规则；工作目录预检完成后、shell 发现完成后均重新核对策略代际。

`exec.run` 从请求开始计算观察预算，发现耗时计入原有 `wait_ms`。超出探测等待预算的请求返回未开始结果；共享探测即使随后成功，也只更新能力缓存，不恢复该请求的命令准入。该保证限定于探测等待阶段，既有 JobManager 文件 I/O 和准入阶段的超时语义保持原样。已获得终态的任务仍返回完成结果，即使准入已用完观察预算。

确定性恢复回归 23 项覆盖首次失败后恢复、16 路共享探测、再次失败后的冷却、权限与策略变化、11 类无效输入、工作目录的存在性与目录类型、冷热能力状态一致性、迟到探测、成功发现耗时、已完成任务和探测异常后的资源释放。连同现有命令校验、真实 Node `exec.run` 和幂等恢复用例，最终定向运行共 36 项通过。Runner TypeScript 构建、`scripts/check-architecture.mjs` 和差异空白检查通过。

恢复测试夹具通过显式构造的 RunnerRuntime 设置公共作业端口，并返回结果与日志 spy 及只读作业观察函数。探测完成函数命名为 `resolveDiscovery`。完整架构测试 `node --test test/architecture.test.mjs` 在门禁规则保持原样的条件下完成：300 项中 299 项通过、0 项失败；1 项文件符号链接测试按 Windows 主机权限条件跳过。夹具调整后的 Runner 定向回归再次通过 36 项（其余 77 项按筛选条件跳过）。

同时修正测试证据分类：堆栈中的 `runWithTimeout` 不再将普通 TypeError 或断言错误归类为超时，公开诊断仅保留固定类别与安全源码坐标。混合 MCP 负载保留 `mixed_load` 阶段，任务准备使用已有终态观察器；相关轻量回归 8 项通过。正式端到端与发布门禁由总检查记录汇总。

## 本地并发负载

[第一轮原始指标](runner-functional-load-2026-10-12.json) 与[驱动器](runner-functional-load-driver.mjs)保留首轮证据。第一轮完整运行耗时 119.754 秒，594 次计时操作通过；驱动器峰值常驻内存约 53.7 MiB，此数值只统计驱动器进程。

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

### 第二轮功能负载

精确文件身份与测试收尾修复后的新一轮于 2026-10-12 13:23:44（Asia/Shanghai）开始，沿用相同功能负载，594/594 次计时操作通过，耗时 9.276 秒。4 次目录搜索均返回完整 24 条结果，无截断；其余内容和任务终态断言通过。文件新增 P95 为 145.65 ms、更新 P95 为 220 ms，日志分页 P95 为 5.85 ms、文件读取 P95 为 17.16 ms，取消最大耗时为 292.32 ms。驱动器峰值常驻内存为 103,718,912 字节，约 98.914 MiB，仅统计驱动器进程，不含子进程。

[第二轮原始指标](runner-functional-load-2026-10-12-r2.json) 独立保存，SHA256 为 `2f05511aabfc9c7f9403a70433bfdcfda39d5f3ef6b984a9cd366a6bf406f291`；原始执行日志为 `.audit/runner-functional-load-identity-repair.log`。第一轮文件保持原样。两轮主机负载条件不同，第一轮并行验证压力更高，119.754 秒与 9.276 秒的差异不作为本批修复的性能收益证明。

驱动器现在接受可选报告路径，后续运行可保存到新的文件。准备时新增输出路径变量曾与既有 payload 变量重名，esbuild 在执行负载前拒绝构建；改为 `reportPath` 后，语法检查与打包通过，再完成上述负载。该准备问题未形成一次失败的产品负载运行。

## `5984ae8` 网络与原生平台复验

候选提交 `5984ae8609373390230b6a97b9f6993dec173d89`，源码树 `2360913788b45611b3a737c940c8fbe177c57640`。Windows 本机在干净源码上执行源码与安装包 E2E，各 41/41 通过、0 跳过；每组混合负载在并发 1/4/8/16 下各完成 128 请求，总计各 512 请求、0 失败。

| 并发 | 源码 P50/P95（ms） | 安装包 P50/P95（ms） |
| --- | --- | --- |
| 1 | 97 / 146 | 94 / 128 |
| 4 | 311 / 669 | 317 / 521 |
| 8 | 788 / 1,159 | 587 / 835 |
| 16 | 1,511 / 1,836 | 893 / 1,080 |

源码 Vitest 总耗时 152.31 秒、测试耗时 146.42 秒；门禁 wrapper 为 158,457 ms。安装包 Vitest 总耗时 101.92 秒、wrapper 为 138,550 ms。测试包 1,206,785 字节，SHA256 `d3e4b189f58d5de200acae76f0e54531122af3c481f7c4b37dfc864d0320042a`，签名与发布状态均为 false。源码证据保存在 `.audit/source-e2e-5984ae8` 的 log/json/evidence.json/gate.json，安装包证据保存在 `.audit/package-e2e-5984ae8.json` 与对应 log。

托管 [push CI](https://github.com/aloneio/runmesh/actions/runs/38208199049) 和 [PR CI](https://github.com/aloneio/runmesh/actions/runs/38208203605) 均为 attempt 1。Linux Runner 单元测试各 1,600 通过、36 跳过；Windows Runner 各 1,494 通过、142 平台跳过、0 失败，Vitest 总耗时分别为 225.13/239.95 秒。Linux/macOS native、Node 22.23.2/24.21.0 LTS 与 browser jobs 成功。

Windows 网络 E2E 的 push 记录 1 个失败测试：8 并发的 `job_logs` 返回 HTTP 500、固定运行时特征 `network_connection_lost`，首错时 started/completed 为 57/49，等待响应头/正文为 7/1。PR 记录 2 个失败测试：1 并发在 60,014 ms 超时，started/completed 为 87/86、等待响应头为 1；16 并发的 `read_initial` 返回同类 HTTP 500，started/completed 为 85/69、等待响应头/正文为 15/1。两侧均为 0 跳过，完整通过计数未由失败工件提供。

两次连接丢失均记录 POST attempts 1；首错时 launcher 尚未退出或开始 teardown，工件没有控制面阶段或运行时重启事件。该证据保留网络等待与连接丢失的事实，初始触发路径继续定位。本机两组通过与托管失败分别记录。Linux verify 同时因 Registry 的两个索引写入成本历史断言失败，后续 Linux E2E 工件为 `not_run`。

完整源身份、PR 合成树一致性、作业与工件摘要见[项目检查书](project-audit-2026-10-12.zh-CN.md)及 `.audit/5984ae8-ci/safe-summary.json`。本轮所有终态与首错已保存，后续修复使用新候选完成验收。

## 后续 HTTP 资源清理与首错定位

`test/e2e/mcp-runner.e2e.test.ts` 的第二 Runner 注册及根目录 Git 测试注册原先只检查 HTTP 200。两处已在状态断言后完整读取 JSON 正文，并按 `apps/worker/src/http/runner-api.ts` 的 `{ runner_id, token }` 契约仅断言 `runner_id`。这是测试 HTTP 资源清理修正，`git diff --check` 通过，完整网络 E2E 等待新候选冻结后验收。修正保持原请求量、并发、超时与调用顺序，网络初始原因尚未确证。

对既有 `5984ae8` PR 工件的进一步定位表明：并发 1 在 started/completed 87/86、pending_headers/pending_body 1/0 时超时。此时唯一在途请求为从 0 计数的 index 86；按固定四种操作的轮换顺序，它是省略 `workspace_id` 的 `job/get`，等待 HTTP 响应头。push 的并发 8 与 PR 的并发 16 各自记录的 pending_body 1 包含正在分类的 HTTP 500：夹具对所有响应均在检查状态前进入 body 阶段。这两个计数不构成成功 SSE 正文卡住的证据。

生命周期核查确认：成功 303 为 null body，成功 MCP 经 `readMcp().text()` 完整消费；Agents legacy adapter 在 SSE EOF 时先等待 server/transport 清理，再关闭响应流。离线恢复测试会重启 Runner 进程并确认恢复 Job 为 `interrupted`，其余前序后台 Job 已达到成功终态；排队、busy 与历史模式切换测试位于混合负载之后。上述源码事实及两处响应读取修正分别记录，尚未建立它们与历史连接丢失的因果关系。

夹具原生进程观察器作为下一项待验证诊断，用于区分 Wrangler launcher 与实际运行时子进程的生命周期。该方案尚无本节可引用的验证结果；后续执行证据另行补录，历史测试记录保持原样。

## 原生进程诊断的后续实现与验证

夹具观察器随后通过专用 preload 接入真实 Wrangler 启动链路，匹配其实际解析的嵌套 workerd，仅保留固定覆盖状态、spawn/exit 阶段、有界序号与耗时、原生退出码和信号分类。Windows、Node 22.23.2 健康检查 smoke 通过；`.audit/runtime-observer-smoke.json` 中 bin 与 CLI 两层各报告一次 installed，实际 workerd spawn 为 index 1（6,963 ms）和 index 2（11,858 ms）。这验证了观测覆盖；两个启动事件本身不代表故障重启，也不作为历史连接丢失已修复的证据。

observer 定向 10/10、browser-fixture 定向 5/5、完整原生退出码诊断定向 8/8 通过。verification-tools 与 observer 两文件完整复验 107/107 通过、0 跳过，耗时 35.076 秒，原始日志为 `.audit/runtime-observer-tools-full.log`。专项与完整测试覆盖有重叠，计数分别保留。

CI 接线初次替换冻结的旧 native 命令，产生 5 项布局契约失败；`.audit/observer-ci-wiring-tests.log` 保留 238 通过、5 失败、2 跳过的首轮结果。改为 `NATIVE_ADDED_COMMANDS` 独立 step 后，ci-layout 复验 6/6 通过、0 跳过、362.823 ms，日志为 `.audit/observer-ci-layout-corrected.log`。产品请求与负载预算保持原值。

本轮 format（1,051 文件）、架构（473 模块、2,422 边、0 环）、清单（9 组、260 文件）、CI 契约（26 门禁）、文档源码事实、3 项 runbook、版本一致性及 TypeScript 检查通过。这些属于冻结前工作区验证，新的干净提交源码 E2E 结果另行追加。

## `aab0b18` 网络与原生平台复验

候选提交 `aab0b183a4b6759fe92d944847f445b1cacbbdf6`，源码树 `7fed2f3c6b498c4c13a594ee1e7d351b32c777e1`。PR 工件的合成提交为 `6727f81fb8dddd19254b5b3e495c840f1ba3fe20`，Git 提交 API 与工件 source 均确认相同源码树。托管 [push CI 38211958047](https://github.com/aloneio/runmesh/actions/runs/38211958047) 全部成功；[PR CI 38211962274](https://github.com/aloneio/runmesh/actions/runs/38211962274) 唯一失败 job 为 Windows native，失败 step 为传输与恢复 E2E，均为 attempt 1。

两侧 Windows Runner 单元测试各 1,494 通过、142 平台跳过、0 失败，Vitest 总耗时 222.32/271.87 秒。Linux/macOS native、Node 22.23.2/24.21.0 LTS、browser 和 Linux verify 均成功。两侧 Linux unit 各为 Vitest 4,696 通过、36 跳过，加根级 Node 305/305，合计 5,001 通过、0 失败、36 跳过。tooling 独立计量，各 1,050 通过、23 跳过；Linux 源码与安装包 E2E 各 41/41、browser 各 5/5。

push Windows 网络 E2E 41/41 通过，Vitest 总耗时 180.04 秒，wrapper 182,174 ms。各档混合负载均为 128 请求、0 失败，总计 512 请求。

| 并发 | push Windows P50/P95（ms） | 该档耗时（ms） |
| --- | --- | --- |
| 1 | 139 / 2,186 | 51,326 |
| 4 | 499 / 887 | 16,732 |
| 8 | 1,190 / 2,298 | 19,739 |
| 16 | 2,457 / 3,008 | 18,109 |

单并发耗时接近 60 秒测试预算，仍需结合正常请求路径评估延迟。该次通过仅作为本轮成功证据，历史网络失败的触发原因继续独立定位。

PR Windows 网络工件保留 3 项失败、0 跳过，失败列表未截断；完整通过计数与成功负载汇总按工件缺失保留。wrapper 为 291,786 ms，子进程退出码 1，低于整体 300,000 ms 截止，门禁为 `failed`。

| 并发 / 测试索引 | 失败类别 | 首错快照 |
| --- | --- | --- |
| 1 / 19 | `test_timeout`，位置 `test/e2e/mcp-runner.e2e.test.ts:1188:24` | 60,020 ms；started/completed 122/121；pending_headers/pending_body 1/0。 |
| 8 / 21 | `job_get` HTTP 500，文本非 JSON，固定特征 `network_connection_lost`；位置 `test/e2e/mcp-runner.e2e.test.ts:1195:42` | 54,610 ms；started/completed 122/114；pending_headers/pending_body 7/1。 |
| 16 / 22 | 同类 HTTP 500，安全阶段分类保留为 `other`，位置同上 | 13,040 ms；started/completed 35/19；pending_headers/pending_body 15/1。 |

PR 记录 POST 连接丢失事件 3 条，各 attempts 1；launcher 的 `test_failed` 快照中退出码/信号为 null，teardown 尚未开始、未提前退出。原生观察器有 installed 两次及 spawn index 1/2，耗时 2,763/3,529 ms；push 对应 spawn 为 3,293/4,212 ms。两侧归档日志与工件均未记录 native exit 或 runtime restart。该观测补充了实际原生子进程事件，但事件缺席本身不构成进程全程存活或故障原因的证明。

Windows 本机两组在干净候选源码上各 41/41 通过、0 跳过，每组混合请求各 512 次成功。源码 Vitest 总耗时 97.93 秒、wrapper 100,368 ms；安装包为 104.94 秒、132,382 ms。

| 并发 | 本机源码 P50/P95（ms） | 本机安装包 P50/P95（ms） |
| --- | --- | --- |
| 1 | 76 / 97 | 92 / 177 |
| 4 | 244 / 386 | 308 / 444 |
| 8 | 513 / 625 | 665 / 1,435 |
| 16 | 1,013 / 1,281 | 1,025 / 1,363 |

本机源码日志同时记录 index 1 在 `elapsed_ms=87126` 以退出码 1 退出，随后出现 `crash_restarting`、`crash_count=1`，index 3 于 `elapsed_ms=87175` 启动。耗时基准为观察器启动，不是单个子进程寿命；事件没有 teardown 字段，Vitest JSON 也没有各组收尾的绝对时刻。本轮保留退出与重启事实，尚不能将其归为活跃测试中的崩溃或收尾终止。本机安装包日志仅记录两次 native spawn。

本机包为 1,206,785 字节，SHA256 `d3e4b189f58d5de200acae76f0e54531122af3c481f7c4b37dfc864d0320042a`，签名与发布状态均为 false。证据为 `.audit/source-e2e-aab0b18` 的 log/json/evidence.json/gate.json，以及 `.audit/package-e2e-aab0b18.json` 和对应 log。

本轮四个工作流全部终态、6 ZIP 与 5 日志归档至 `.audit/aab0b18-ci`；main-source-policy 成功，开发预发布 cadence 为 `due=false`，后续发布步骤按节奏跳过。`safe-summary.json` SHA256 为 `9e99cbfa359393834dba855205181ebf884025064ec021f54da4bef10eead3a2`，`state=complete`、`archive_state=complete`、`validation_state=failed`。详细源码身份、Linux 负载与发布边界见[项目检查书](project-audit-2026-10-12.zh-CN.md)。历史 `5984ae8` 归档保持原样，后续修复按新的源码身份验收。

## 后续阶段耗时与证据容量观测

`aab0b18` 之后新增测试观测，按 read、workspace_list、job/get、job/logs 汇总等待响应头、正文与完整结果的有限耗时样本。四档并发、每档 128 请求、每档 60 秒用例预算以及产品调用顺序和预算保持原值。失败后单独请求一次 `/health` 快照，设 1 秒截止，作为独立失败收尾开销计量。

Worker 仅在 `RUNMESH_TEST_MODE=1` 保留固定分类与数值，正常请求采样不新增定时器或外部调用。每个 isolate 的活动项上限 32、最近结束项上限 16；响应包装按下游读取并传递取消，生产响应保持原路径。导出字段不包含凭据、URL、参数或结果正文。快照缺失不证明健康，也不将不同 isolate 的计数合并解释。

服务端响应头中的 total 截止于返回响应头前，最近结束记录的 total 截止于 EOF、取消或错误；Registry fetch 包含依赖处理和排队，身份核验 facade 的 fetch 还包含签名。各阶段可能重叠，计数分别解释。客户端等待响应头包含 Worker 首个 SSE 字节的准备，阶段耗时用于下一轮定位，不作为本轮网络根因已修复的依据。

补充工件维持 65,536 字节合同，完整保留 source、failures 与既有 runtime 事件，新增阶段和分布事件按优先级及并发档位裁剪并记录省略数；主证据超限仍拒绝写入。裁剪不修改输入记录或完整安全日志。容量定向验证 3/3 通过，包含 579 条事件的极值输入、四档并发记录与原顺序保留、小工件逐字节一致，以及主证据超限时原文件保持完整。

Worker 定向验证 4 个文件、252/252 通过、0 跳过，耗时 48.19 秒，覆盖生产路径、流转发和取消等边界。工具层 4 套测试为 394 通过、14 跳过，耗时 91.661 秒，日志为 `.audit/mcp-timing-tooling-full.log`；其中包含此前 5/5 通过的解析器测试，其日志为 `.audit/mcp-timing-parser-tests.log`。工具完整集合运行于容量裁剪修改之前，3 项容量用例随后单独执行；Worker 与容量结果以本轮工具执行回执为证据，未另存日志文件。

TypeScript、文档、runbook 与版本检查通过；format 为 1,054 文件，架构为 474 模块、2,426 条依赖边、0 环，测试清单为 9 组、261 文件，CI 契约为 26 门禁。上述结果用于确认观测实现与证据容量边界，最新完整 CI 仍以 `aab0b18` 的 push 成功、PR Windows 三项失败为准，正式版 0.1.7 与 0.1.8 candidate 状态保持原样。

## 证据边界

本轮负载使用隔离临时目录、真实 Node/Git 子进程与文件系统 API，不连接生产服务，也不操作系统级 Runner 注册。驱动器使用显式的本机 Git 路径作为测试注入。升级协调器、服务回滚和跨平台服务适配器由项目完整测试及 CI 矩阵覆盖；原生 Linux/macOS 服务行为需由对应平台执行证据确认。Worker→Runner 网络链路和浏览器验证另行记录。
