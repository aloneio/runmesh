# Runmesh 项目检查书

检查日期：2026-10-12 至 2026-10-13（Asia/Shanghai）

初始检查基线：`dev`，`115ba45`。
正式发布源码：`e4656476f2b7ad8f1f873c1362ef0262404c0a45`，tree `3db3b8127fbf0a3ba910e3891662309efe4e3b39`。
阶段：[0.1.8 已公开发布](https://github.com/aloneio/runmesh/releases/tag/v0.1.8)，原始十二项发现及后续修正的验证记录保留。发布提交的 push、PR、main 与 release 工作流均完成首轮验收，九项公开资产独立校验通过，公开安装包在本机 Windows 单次验证中通过 41/41 项测试和 512/512 次压力请求。后续激活提交 `ef72e2a` 的 PR Windows 单元测试暴露版本暂存目录重命名的 `EPERM`，生产激活停止推进，线上保留 0.1.7。正在以 0.1.9 候选修正目录提交与运行时探测的顺序，完整记录见末节。

本检查书按提交和执行阶段保留历史判断。`a259abd` 的 push、PR 两次 Windows CI 各 2 项失败及其原始证据完整保留，底层根因仍未归属；后续被动诊断和成功执行分别记录。最新发布证据、公开包验收及归属边界见末节，早期候选的发布阻塞结论描述当时状态。

## 范围与方法

并行审阅 Runner 与协议、Worker 与数据存储、用户文档与发布流程，并由主审交叉核对证据。覆盖进程与任务生命周期、连接恢复、文件与工作区、中央 MCP/Skills、管理界面、安装升级、测试收集、构建及双平台发布。审阅以当前 dev 实现为准；旧版本已经修复的问题不重复计入。

现有主目录的暂存变更完整保留。修复在独立检出中开展，基于 dev 提交形成可审阅变更。压力验证使用本地或隔离测试设施。

## 检查发现

| 编号 | 级别 | 发现与影响 | 处理与验收要求 |
| --- | --- | --- | --- |
| A01 | P1 | Skills 数据库 v1 到 v2 迁移一次性物化全部内容。允许的库容量达到 256 MiB，可能超过 Worker 内存预算，导致正常大库升级失败。位置：`apps/worker/src/platform/skills/schema.ts`。 | 使用有界读取迁移，保留事务原子性；验证多包迁移、失败回滚和重试。 |
| A02 | P1 | Windows 进程退出码在任务完成协议、持久记录和 MCP 输出之间取值范围不一致。正常的 3010 退出码不能通过完成帧校验，更大的 Windows 退出码还可能影响记录恢复和结果读取。位置：`packages/protocol/src/schema.ts`、`apps/runner/src/jobs/records.ts`、`apps/worker/src/mcp/output-contracts.ts`。 | 统一完整 Windows/POSIX 退出码约定；验证事件编解码、结果输出与重启恢复，并检查旧协议兼容性。 |
| A03 | P2 | 用户文档混有历史执行记录、会话叙事及验收状态；部分 0.1.7 版本说明包含发行后的改动。 | 用户文档按使用步骤、预期结果、恢复操作组织；历史证据独立归档并保留真实性；版本说明按实际提交归属修正。 |
| A04 | P2 | 测试错误分类读取完整堆栈，将通用包装函数 `runWithTimeout` 误认为实际超时，可能掩盖原始业务错误。位置：`scripts/test-evidence.mjs`。 | 已修正分类逻辑并通过 8 项轻量回归；旧分类结果需结合原始失败消息解释。 |
| A05 | P1 | Runner Runtime 在首次 shell 发现失败后永久缓存失败状态，后续 shell 请求持续返回 `shell_unavailable`，即使 Runner online 与读取仍正常。位置：`apps/runner/src/runtime.ts`。 | 已加入有界、共享的发现恢复，36 项定向回归及本机 Windows 完整网络 E2E 41 项通过；首次探测具体失败原因未被捕获，与已修复的永久缓存行为分别记录。 |
| A06 | P2 | 网络负载首错后的主动停止、在途请求取消与汇合需要完整绑定；失败工件曾遗漏负载进度、内部运行时生命周期和控制面失败阶段，Windows ASCII 日志前缀也未被识别。已有测试 HTTP 作用域会在结束时取消请求，因此该缺口本身不能解释首次 Windows 故障。 | 已实现首错快照、停止领取、主动取消与请求汇合，13/13 项定向回归通过；前置控制面 217/217、日志诊断 17/17 项定向回归及架构、类型检查通过。`130c834` 已取得授权路径 deadline 与负载首错事件，完整结果见下文。 |
| A07 | P1 | Registry 在每次受保护 RPC 的例行维护中扫描全部 Runner 记录，查询读取量随 Runner 数量增长，增加授权请求路径的开销。位置：`apps/worker/src/registry/lifecycle.ts`、`apps/worker/src/registry/schema.ts`。 | 已加入部分表达式索引并使用等价 `MIN` 查询，保留维护写预算、nonce 与权限约束；33/33 项定向验证通过。1,000 条记录时 `rowsRead` 从至少 1,000 降至最多 2。`5984ae8` 的完整 Worker 验证发现 heartbeat 与 session_begin 的索引计量写入由 1 增至 2，其余对应调用、读取、顺序及回执保持一致；精确成本断言按该取舍更新后复验。 |
| A08 | P1 | Workspace、补丁及分页读取使用 JavaScript `number` 表示系统文件标识，较大的 inode 会丢失整数精度，影响身份一致性比较；同类表示也用于 Jobs、Context、配置、元数据、Git 与验证证据读取链路。共享位置：`apps/runner/src/file-identity.ts`；证据读取位置：`scripts/evidence-io.mjs`。 | 已改为完整整数身份；Workspace/补丁/分页集合 95 通过、3 跳过，Jobs/Context 的 8 文件 139 通过、1 跳过，配置/元数据/Git 等 8 文件合计 97 通过、64 跳过，证据读取 10/10 通过。本机 Windows 完整 Runner 1,494 通过、142 平台跳过、0 失败；package-verification/verification-tools 两文件完整验证通过。各定向集合与完整套件分别记录，尚无证据将该独立防御修复认定为 Windows 网络首错原因。 |
| A09 | P2 | Windows 版本探针退出后，包含刚执行运行时的目录重命名曾返回 `EPERM`；原始日志没有记录锁持有者。测试清理错误还可能覆盖阶段原错。位置：`apps/runner/src/updates/release-stager.ts`、`apps/runner/test/release-stager.test.ts`。 | 早期有限重试修正通过 39/39 项定向验证，但 `ef72e2a` 的 PR CI 再次失败。0.1.9 调整为先放置最终目录、后执行探针，保持原重试及探针预算；与协调器共 142/142 项定向验证通过，完整验收按新源码另行记录。 |
| A10 | P2 | 两处原生测试的提前失败路径未完整回收测试进程：Runtime 的失败终止夹具仅在主路径停止子进程；Windows 锁夹具在持有者未就绪时无法解除维护子进程等待。位置：`apps/runner/test/runtime.test.ts`、`apps/runner/test/update-launchers.test.ts`。 | 测试持有的进程在收尾时独立停止并等待 `close`；维护夹具具有独立停止信号和自身截止。两文件 118 通过、4 跳过，包含 stop/deadline 故障分支。该发现限于测试提前失败路径，不能解释单元测试全通过后的网络失败。 |
| A11 | P2 | 补丁回滚测试在操作原错发生后仍断言 `external` 已创建，可能以 `undefined` 断言覆盖真正的首个异常。位置：`apps/runner/test/patch-persistence-failures.test.ts`。 | 已保留操作原错，28/28 项定向诊断验证通过；在新候选 Windows 完整测试中继续复验回滚行为。该项属于证据完整性修复。 |
| A12 | P2 | MCP 再授权在完整读取有效 200 收据后仍取消 reader 并触发 AbortSignal，使正常完成与失败清理采用同一取消路径。位置：`apps/worker/src/mcp/reauthorization.ts`。 | 完整有效收据（允许及有效主体不匹配的拒绝）释放读取锁并清除计时器；失败、超时、未读正文和迟到回执继续取消。45/45 项定向测试通过，独立复核通过；该资源生命周期修正与 Windows 网络故障的关系另行验证。 |
| A13 | P1 | 已有独立管理器在普通 Runner 版本切换后继续运行原管理器包，当前安装流程复用它；因此仅发布新 Runner 包不能将版本暂存修正送达已有管理器。位置：`apps/runner/src/updates/manager-install.ts`。 | 增加显式 `manager-refresh`，以独立验签的同版本维护包替换管理器程序，保留私有运行时、身份、操作记录、配置和 Runner。刷新取得安装锁、确认本地活动操作记录完全不存在后进行，并具备中断恢复与失败回滚。实现与验证记录见后续专节。 |

## 验证矩阵

以下结果绑定候选 `0274535b261ec995ef85903085b391d2bc5d429e`，源码树 `8c82b4153053424a22eb2e9be1530d912dbfb23a`。PR 检出合成提交 `42bae438745557a3c8aad1c5c5c5fa14a34d1fff`，树与候选一致。专项、完整套件、源码、安装包及不同平台存在覆盖重叠，分别列示，计数不累加。

| 功能面 | 本候选的执行证据 | 验收状态 |
| --- | --- | --- |
| 协议、Runner、Worker 与治理 | push、PR 两路 Linux verify 均成功；各自 26 个门禁通过，覆盖 unit、security、tooling、构建、类型、文档、版本、架构及发布契约。 | 对应 Linux 门禁通过。 |
| 源码 Worker→Runner 网络链路 | 本机 Windows 41/41；push、PR Linux 各 41/41；PR Windows 41/41，均为 0 跳过。push Windows 记录两项混合负载失败。 | Windows push 网络门禁构成发布阻塞。 |
| 安装包网络链路 | 本机 Windows、push Linux、PR Linux 的实际安装包 E2E 各 41/41、0 跳过。 | 对应安装包功能验证通过；签名和正式发布另行验收。 |
| 混合负载 | 本机源码、安装包各在并发 1/4/8/16 下执行每档 128 请求，各完成 512 请求。push Windows 的并发 4、8 失败，并发 1、16 完成。 | 各环境原结果分别保留。 |
| 原生平台与 Node LTS | 两路 Linux、macOS native 和 Node 22.23.2、24.21.0 LTS jobs 成功。两路 Windows Runner 单元测试各 1,494 通过、142 平台跳过；push 的后续网络步骤失败。 | 原生 job 与其内部各步骤分别判定。 |
| 管理界面 | push、PR browser jobs 成功，浏览器 E2E 各 5/5、0 跳过。 | 浏览器门禁通过。 |
| 分支提升与发布 | PR 全部 8 个 jobs 成功；push Windows 与 verify-all 失败。两次 main-source-policy 成功。开发预发布仅 cadence 执行，`due=false`。 | 候选发布阻塞；本轮保留正式版 0.1.7。 |

## 判定原则

测试记录保留命令、环境、源码身份、通过/失败/跳过数量及负载指标。失败经修复后使用新证据复验。已通过的本地测试只证明其覆盖范围；原生平台、托管 CI 与正式部署使用各自证据。正式版本号、发行状态及校验和以实际发布结果为准。

## 修复与验收记录

### 已完成的修复

- A01：迁移按 rowid 每次读取一条记录，读取游标耗尽后再写入。保留完整事务，新增第 13 条写入失败后的回滚与重试验证。最初直接遍历游标的实现被新回归发现会在重试时保留 SQLite 读取锁，已改为有界分页。
- A02：本地记录、MCP 输出和 Context 证据共享完整的原生退出码范围。保持 v2 完成通知的既有范围；超范围退出码在该摘要中表示为 null，详细任务结果保留真实值。真实 Windows 子进程的 3010 与 3221225477 已通过完成和恢复验证。
- A03：23 份历史审计记录归档至 `reports/history`，保留失败事实和后续验证。用户文档按安装、配置、升级与恢复组织；发行后的界面改动从 0.1.7 说明移入 0.1.8 候选说明。
- A04：错误分类从实际错误消息识别超时，避免将通用堆栈包装函数当作原因；8 项轻量回归通过。
- A05：Runtime shell 发现加入有界重试与共享恢复，修复和恢复验证已完成；36 项定向回归与本机完整网络 E2E 41 项通过。首次 shell 发现失败的具体原因尚未捕获，缓存缺陷与触发原因分别追踪。
- A06：在 `510bc2a` 的首错快照、停止调度与请求汇合基础上，进一步加入首错主动取消在途 HTTP 请求。13/13 项定向回归及 TypeScript 检查通过，并纳入 `130c834` 验收；该修复结论限于测试任务收尾。

### 本地验证

| 项目 | 结果 |
| --- | --- |
| 依赖审计 | 426 个依赖记录，漏洞数 0 |
| 构建与类型检查 | 通过，Node 22.23.2、npm 10.9.3 |
| 工具链、文档、CI 一致性、runbook、版本、格式、架构、提升策略、空白、许可证、发行契约 | 11 项门禁通过 |
| 退出码专项 | 协议 25、Runner 19、Worker 59、公开基线 3，共 106 项通过 |
| Skills 修复专项 | 状态与生命周期 42 项、已有集成用例 28 项通过 |
| 文档验证 | 文档契约 39 项、安全配置 10 项；本次调整后 check-docs、3 项 runbook 以及 963 个本地链接、30 个标题锚点通过 |
| 测试诊断分类 | A04 修复后的 8 项轻量回归通过 |
| 测试首错取消 | A06 后续修复的 13/13 项定向回归及 TypeScript 检查通过，`130c834` 的完整结果按提交记录 |
| Registry 维护查询 | A07 后续修改的 33/33 项定向验证通过；1,000 记录 `rowsRead` 从至少 1,000 降至最多 2，类型、架构与测试收集通过，完整门禁待新候选验收 |
| 精确文件身份 | A08 的 Workspace/补丁/分页集合 95 通过、3 跳过；一项旧夹具修正后，分页快照文件复验 25/25。Jobs/Context 8 文件 139 通过、1 既有平台跳过；配置/元数据/Git 等 8 文件合计 97 通过、64 平台跳过。随后本机 Windows 完整 Runner 套件通过 |
| Windows 完整 Runner | 75 文件、1,636 项测试：72 文件通过、3 平台跳过；1,494 项通过、142 平台跳过、0 失败，耗时 580.30 秒。原始日志 `.audit/runner-full-identity-repair.log` |
| 本批最终静态与工具验证 | 架构 300 通过、1 Windows 符号链接条件跳过；package-verification/verification-tools 127 通过、3 跳过。固定 Node 22.23.2/npm 10.9.3 的类型检查与构建通过；测试清单与收集检查覆盖 9 组、259 文件 |
| 验证证据文件身份 | A08 扩展至 `evidence-io.mjs`，保留原生 BigIntStats 身份、大小和纳秒时间；9 项模拟元数据回归及 1 项原生 UTF-8/大小边界测试共 10/10 通过，package-verification/verification-tools 两文件完整验证通过 |
| 共享身份 helper 架构 | 共享 helper 仅保留 `node:fs` 类型导入，并禁止 I/O、异步及调度行为；源码架构检查 473 模块、2,422 条边、0 环通过 |
| 控制面阶段诊断 | A06 细化 `fetch`、`body_read`、`json_parse` 阶段；Worker 264/264、Node 诊断 18/18 通过，保留原有请求预算和安全日志投影 |
| Windows 暂存发布 | A09 定向验证 39/39 通过，含 6 项新增提交重试、失败及取消回归 |
| 测试进程收尾 | A10 两文件 118 通过、4 跳过；新增 Windows stop/deadline 故障分支通过，原终止及锁断言预算保持原值 |
| Runner 本地负载 | 两轮各 594 次操作通过，分别保留原始指标。新一轮耗时 9.276 秒，18 个成功任务与 4 次取消，4 次目录搜索均完整返回 24 条；详见 [Runner 验证记录](runner-validation-2026-10-12.zh-CN.md) |
| Skills 本地负载 | 最近一轮 512 请求、0 失败，四档并发 1/4/8/16；详见 [Skills 记录](skills-validation-2026-10-12.zh-CN.md) |

### 历史候选的托管 CI

候选：`fae0224828394e01c4bc69345c7fa05d018d44a8`；GitHub [push CI 38191433673](https://github.com/aloneio/runmesh/actions/runs/38191433673)，attempt 1。该轮整体结果为 failure：`verify`、`browser`、Linux/macOS native 和两个 Node LTS jobs 成功；Windows native 的 `Verify Windows MCP transport and Runner recovery` 失败，汇总 `verify-all` 随之失败。[PR CI 38191497364](https://github.com/aloneio/runmesh/actions/runs/38191497364) 同样在 Windows transport 失败；PR 的 main-source-policy 成功。PR 验证与源码 push 验证分别记录，正式发布要求受保护 main 上的精确提交 push CI。

| Linux verify 项目 | 结果与边界 |
| --- | --- |
| `node scripts/ci-check.mjs unit` | 4,892 通过、0 失败、34 跳过：domain 530、contracts 50、protocol 57、Runner 1,541、Worker 2,409、根级 Node 测试 305。 |
| `node scripts/ci-check.mjs security` | 22 项安全回归要求通过；11 个独立测试文件共 546 项测试通过，0 失败、0 跳过。计数去除了多个要求引用同一文件所造成的重复。 |
| `node scripts/ci-check.mjs tooling` | 1,013 通过、0 失败、23 跳过，共 1,036 项。 |
| `node scripts/ci-check.mjs transport` | 源码 Worker→Runner E2E 38/38 通过，0 跳过。 |
| `node scripts/ci-check.mjs installed_transport` | 实际安装包 E2E 38/38 通过，0 跳过；归档大小 1,196,122 字节，SHA256 `533313738f1f4506965525352a74c8ede72a2d3f27d35ed29d72b558142db402`。 |

托管负载使用 Linux、Node 22.23.2、本地 Worker/Runner 隔离夹具。每组均在并发 1/4/8/16 下各执行 128 请求，共 512 请求，失败数均为 0。

| 负载 | P50，按并发 1/4/8/16 | P95，按并发 1/4/8/16 |
| --- | --- | --- |
| 源码 MCP `RUNMESH_MCP_LOAD` | 30 / 87 / 173 / 319 ms | 34 / 157 / 217 / 436 ms |
| 安装包 MCP `RUNMESH_MCP_LOAD` | 30 / 85 / 170 / 304 ms | 35 / 149 / 232 / 408 ms |
| `skills-normal-load` | 8 / 21 / 37 / 76 ms | 13 / 32 / 71 / 124 ms |

Windows 失败工件记录 1 个失败测试，位置为当时的 `test/e2e/mcp-runner.e2e.test.ts:1171:22`；Worker 启动器记录 `exited_before_teardown=false`。旧分类器将其归为 `test_timeout`，后续检查发现 A04，故该分类本身不足以确定失败原因，也不能据此认定某个业务请求永久挂起。原始日志、verify/Windows 工件及安全统计保存在本地 `.audit/fae-push-ci-38191433673` 档案；以上链接保留可定位的托管运行。

[Dev Runner Prerelease 38191433726](https://github.com/aloneio/runmesh/actions/runs/38191433726) 的 run number 为 311，仅 cadence job 执行成功，plan、verification、build、publish 均跳过，因此该运行没有发布开发包。

### Windows 本机网络 E2E 复验

执行环境为 Windows、Node 22.23.2、npm 10.9.3，使用 `npm run test:e2e` 对本地 Worker 与真实 Runner 子进程验证。下表时间为 Asia/Shanghai；前两轮使用历史候选的测试结构，之后各轮包含 `fae0224` 之后的测试调整及定向修复。

| 记录时间 | 通过 / 失败 / 未执行 | 观察与后续处理 |
| --- | --- | --- |
| 08:57 | 3 / 0 / 35 | 注册子进程退出等待达到 15 秒上限，主业务组未执行；独立会话组通过。该轮同时运行了其他本机负载，随后改为串行复验。原始报告：`.audit/source-e2e-first.json`。 |
| 09:21 | 37 / 1 / 0 | 四档合计 512 请求共用一个 90 秒测试预算，最后 16 并发阶段累计超时。随后拆为四个参数化测试，每档 128 请求、独立 60 秒测试预算，生产请求预算保持原值。原始报告：`.audit/source-e2e-second.json`。 |
| 09:31 | 37 / 4 / 0 | 四个参数化用例均因测试回调 API 使用错误触发 `TypeError`：`onTestFailed` 从 undefined 解构。该夹具错误已修正，完整验收继续进行。原始报告：`.audit/source-e2e-callback-error.json`。 |
| 09:40 | 25 / 16 / 0 | 夹具回调修正后的下一轮，shell 调用持续出现 `shell_unavailable`，Runner online 与只读查询仍正常。失败覆盖 shell、依赖作业的日志/队列/Context 及四档混合负载；随后定位 A05 的失败缓存行为，首次发现失败的触发原因仍在核查。原始报告：`.audit/source-e2e-shell-errors.json`。 |
| 10:21 | 41 / 0 / 0 | A04/A05 及夹具修正后的完整网络 E2E 通过，总耗时 141.85 秒。四档各 128 次混合请求全部成功，生产预算保持原值。原始报告：`.audit/source-e2e-recovery.json`。 |

10:21 这一轮本机负载结果如下；每个请求均检查完整内容或任务终态。修改随后冻结为新提交，在托管环境重新验证源码、安装包、浏览器与原生平台；后续结果按提交分别记录。

| 并发 | 请求 / 失败 | P50 | P95 | 负载阶段耗时 |
| --- | --- | --- | --- | --- |
| 1 | 128 / 0 | 97 ms | 129 ms | 11.457 s |
| 4 | 128 / 0 | 356 ms | 607 ms | 11.350 s |
| 8 | 128 / 0 | 804 ms | 1135 ms | 12.168 s |
| 16 | 128 / 0 | 1525 ms | 1898 ms | 11.564 s |

### `47c61a9` 候选的安装包与托管复验

Windows 对提交 `47c61a9b3cec3912b4a63ed38d5cc7885e24f497` 的干净检出执行 `npm run test:package:e2e`：实际打包、解压安装并运行完整网络 E2E，41/41 通过、0 跳过，总耗时 118.347 秒。未签名测试归档为 1,198,291 字节，SHA256 `a18f0c146d4ddac5756dd926d439c8c549631b3e3400367b0e0102aeaebbe966`；四档各 128 请求均成功，P95 为 111 / 406 / 819 / 1226 ms。最初直接执行内部脚本的调用被 npm 入口预检拒绝，随后使用项目声明的 npm 命令完成验证；预检阶段未运行产品测试。

该提交的 [GitHub push CI 38195602950](https://github.com/aloneio/runmesh/actions/runs/38195602950) 和 [PR CI 38195605228](https://github.com/aloneio/runmesh/actions/runs/38195605228) 在 AR18 架构测试中发现新测试夹具不符合静态约定：探针的 `finish` 名称与退休私有接口重名，部分 `test.runtime.jobs` 引用的 Runtime 所有权也不能由扫描器确定。后续仅调整测试夹具命名及公共 spy 句柄，保留架构门禁。生产代码和预算保持原值。

该候选已完成的独立结果包括 browser 5/5、两个 Node LTS Runner jobs，以及 Linux 单元/安全检查。Linux 单元测试共 4,915 通过、34 跳过，安全专项 546 通过；Skills 压测 512 请求、0 失败，P95 为 10 / 28 / 113 / 82 ms。夹具修正后，本机完整架构测试 299 通过、0 失败、1 项按 Windows 符号链接权限条件跳过，Runner 定向回归 36 项通过。完整托管验收以新提交的结果为准。

### `46b5f69` 候选的托管复验

候选：`46b5f69e8b41fba4c52ddc0c99326d4e5c6fa28b`，源码树 `520690f8912b08c37342e64779c186b2991cd28e`。[GitHub push CI 38196490639](https://github.com/aloneio/runmesh/actions/runs/38196490639) 与 [PR CI 38196493730](https://github.com/aloneio/runmesh/actions/runs/38196493730) 均为 attempt 1，最终结果均为 failure。两次运行的 `verify`、browser、Linux/macOS native 和 Node 22.23.2/24.21.0 LTS jobs 均成功；Windows native 均在 `Verify Windows MCP transport and Runner recovery` 失败，`verify-all` 随之失败。

push 工件绑定上述精确候选提交。PR 工件绑定合成合并提交 `f963c267e5931afae7c526a4e550021e11225f16`，源码树与候选一致；两类运行仍分别记录。PR118 已转为 ready，随后执行的 [main-source-policy 38197202102](https://github.com/aloneio/runmesh/actions/runs/38197202102) 成功。

| Linux push verify 项目 | 结果与边界 |
| --- | --- |
| 单元测试 | 4,915 通过、0 失败、34 跳过：domain 530、contracts 50、protocol 57、Runner 1,564、Worker 2,409、根级 Node/UI 测试 305。 |
| 安全专项 | 22 项安全回归要求通过；去除重叠文件后，11 个独立文件共 546 项通过，0 失败、0 跳过。 |
| 工具检查 | 1,015 通过、0 失败、23 跳过，共 1,038 项。 |
| 源码网络 E2E | 41/41 通过，0 跳过。 |
| 安装包网络 E2E | 41/41 通过，0 跳过；测试归档 1,198,294 字节，SHA256 `be3f1441b1d12d1368c9041f07355841e48f5872709b574849e541edb72281af`，未签名、未发布。 |
| 浏览器 E2E | 独立 browser job 5/5 通过，0 跳过。 |

Linux 托管负载每组均在并发 1/4/8/16 下各执行 128 请求，共 512 请求，失败数均为 0。MCP 混合负载覆盖文件读取、工作区列表、已完成任务查询和日志读取；准备阶段先完成 shell 任务，并发进程执行另由 Runner 负载专项验证。

| 负载 | P50，按并发 1/4/8/16 | P95，按并发 1/4/8/16 |
| --- | --- | --- |
| 源码 MCP | 36 / 103 / 223 / 459 ms | 41 / 183 / 273 / 611 ms |
| 安装包 MCP | 36 / 103 / 214 / 417 ms | 40 / 181 / 268 / 551 ms |
| Skills | 11 / 33 / 66 / 153 ms | 20 / 48 / 109 / 324 ms |

Windows push job `114640198372` 于 `2026-10-12T02:50:29Z` 结束。前置 Runner 单元测试 1,457 通过、141 跳过、0 失败；transport 工件记录 4 个失败测试、0 跳过。Windows PR job `114640208204` 于 `2026-10-12T02:47:50Z` 结束，transport 工件记录 3 个失败测试、0 跳过。

| 运行 | 失败测试 | 安全诊断记录 |
| --- | --- | --- |
| push | 索引 19，并发 1 | `test_timeout`。 |
| push | 索引 20，并发 4 | `test_timeout`。 |
| push | 索引 21，并发 8 | HTTP 500，正文为非 JSON 文本，`network_connection_lost`，阶段 `other`。 |
| push | 索引 22，并发 16 | HTTP 500，正文为非 JSON 文本，`network_connection_lost`，阶段 `read_initial`。 |
| PR | 索引 21，并发 8 | 断言失败；`control_plane_unavailable`，失败类别 `availability`，操作状态 `not_started`。 |
| PR | 索引 22，并发 16 | HTTP 500，`network_connection_lost`，阶段 `shell`。 |
| PR | 索引 26，队列夹具 | 断言失败，位置 `test/e2e/mcp-runner.e2e.test.ts:647:88`。 |

该候选已包含 A04 分类修复，因此上述实际超时分类与旧候选分别解释。两次 Worker 启动器均记录 `exited_before_teardown=false`。失败工件没有导出完整的逐档进度及负载统计，Windows 的已完成请求数与各档延迟据此保持空缺；HTTP 500、连接丢失和后续队列断言尚不足以确定最初故障来源。

独立夹具审阅确认，测试超时会取消当前测试的 HTTP 信号，已关闭作用域会拒绝其后续 HTTP 请求。另发现两处需要加强的验证环节：混合负载的普通断言失败采用 `Promise.all` 提前返回，缺少对同组任务的显式停止与汇合；失败进度写入普通 stderr，现有安全工件导出未收录该标记。该轮之后补充首错快照、停止调度、等待全部任务结束及有界进度诊断导出，后续结果按候选分别记录。这些调整用于提高测试收尾与证据完整性，Windows 初始故障原因仍待新的运行证据确认。

原始日志、push/PR Windows 工件、Linux verify 与浏览器工件及安全汇总保存在独立检出的 `.audit/46b-push-ci-38196490639`。该轮 [Dev Runner Prerelease 38196490795](https://github.com/aloneio/runmesh/actions/runs/38196490795) 为 run number 313，仅 cadence job 成功，未执行开发包发布。正式发布继续以新候选完整门禁和受保护 main 的精确提交证据为准。

### `510bc2a` 候选的本机与托管复验

候选：`510bc2aa98e4caf7d459b2e4c8cdd6dd397f57e3`，源码树 `2c1b38afd515c662779cfe8ae245638046ca4407`。Windows 本机使用 Node 22.23.2、npm 10.9.3 完成源码与安装包验证；每组混合负载在并发 1/4/8/16 下各执行 128 请求，共 512 请求、0 失败。

| 本机验证 | 结果 | P95，按并发 1/4/8/16 |
| --- | --- | --- |
| `npm run test:e2e` | 41/41 通过、0 跳过，E2E 耗时约 115.40 秒。 | 113 / 411 / 798 / 1855 ms |
| `npm run test:package:e2e` | 实际打包、解压安装与网络 E2E 41/41 通过、0 跳过，全流程耗时 151,745 ms。 | 90 / 437 / 1730 / 3960 ms |

本机安装包测试归档为 1,198,291 字节，SHA256 `a18f0c146d4ddac5756dd926d439c8c549631b3e3400367b0e0102aeaebbe966`，未签名、未发布。本机原始证据保存在 `.audit/source-e2e-510bc2a.json`、`.audit/source-e2e-510bc2a.log` 与 `.audit/package-e2e-510bc2a.log`。

[GitHub push CI 38198970590](https://github.com/aloneio/runmesh/actions/runs/38198970590) 的 8 个 jobs 全部成功，包括 Windows native 与 `verify-all`。[PR CI 38198974309](https://github.com/aloneio/runmesh/actions/runs/38198974309) 的 Windows native 在 `Verify Windows MCP transport and Runner recovery` 失败，`verify-all` 随之失败；其余 6 个 jobs 均成功。两次运行均为 attempt 1。[main-source-policy 38198974298](https://github.com/aloneio/runmesh/actions/runs/38198974298) 成功。

push 工件绑定精确候选提交。PR 工件绑定合成合并提交 `303d5d6a0070b252681cc06dc307ef1d54fbf717`，源码树与候选一致。两侧 Linux verify 均记录单元测试 4,928 通过、0 失败、34 跳过，其中 Worker 为 2,422、Runner 为 1,564；工具检查 1,020 通过、0 失败、23 跳过。安全专项 22 项要求、11 个独立文件共 546 项通过，源码与安装包网络 E2E 各 41/41，浏览器 E2E 5/5。Linux 安装包测试归档为 1,198,294 字节，SHA256 `be3f1441b1d12d1368c9041f07355841e48f5872709b574849e541edb72281af`，未签名、未发布。

push 的 Windows Runner 单元测试 1,457 通过、0 失败、141 跳过，网络 E2E 41/41 通过、0 跳过。下表各组均完成四档共 512 请求、0 失败。

| push 托管负载 | P50，按并发 1/4/8/16 | P95，按并发 1/4/8/16 |
| --- | --- | --- |
| Windows 源码 MCP | 141 / 583 / 1178 / 2576 ms | 239 / 876 / 1703 / 3167 ms |
| Linux 源码 MCP | 38 / 113 / 237 / 458 ms | 45 / 202 / 297 / 606 ms |
| Linux 安装包 MCP | 37 / 108 / 227 / 446 ms | 43 / 191 / 283 / 577 ms |
| Linux Skills | 12 / 35 / 69 / 155 ms | 22 / 61 / 91 / 285 ms |

PR Windows job `114647884642` 于 `2026-10-12T03:24:30Z` 结束。前置 Runner 单元测试同样为 1,457 通过、0 失败、141 跳过；transport 工件记录 2 个失败测试、0 跳过，失败列表完整。

| 失败测试 | 首错记录 |
| --- | --- |
| 索引 21，并发 8 | HTTP 500，阶段 `read_initial`；正文为非 JSON 文本，`network_connection_lost`，RPC code/id 均缺省。位置 `test/e2e/mcp-runner.e2e.test.ts:1199:42`。 |
| 索引 22，并发 16 | 断言失败，阶段 `mixed_load`；`registry_unavailable`，失败类别 `availability`，操作状态 `not_started`，下一步 `wait_and_retry`。位置 `test/e2e/mcp-runner.e2e.test.ts:591:85`。 |

该失败工件共保留 3 条 Worker 事件，其中两条为首错瞬时进度：

| 并发 | 阶段 | 已启动 / 已完成 | 距用例开始 | 等待响应头 / 响应体 |
| --- | --- | --- | --- | --- |
| 8 | `mixed_requests` | 127 / 119 | 27,956 ms | 7 / 1 |
| 16 | `mixed_requests` | 34 / 18 | 16,424 ms | 13 / 2 |

第三条为 `launcher_snapshot`：`reason=test_failed`，`exit_code=null`，`signal=null`，`teardown_started=false`，`exited_before_teardown=false`。工件未截断，未记录 `control_plane_failure` 或 `runtime_lifecycle` 事件。首错快照与最终完成统计分别使用；该轮缺少完整负载指标，保留这一证据边界。

两侧原始日志、6 份工件、安全事件、负载指标和 SHA256 校验值归档在 `.audit/510bc2a-ci-38198970590`，汇总文件为 `safe-summary.json`。该轮 [Dev Runner Prerelease 38198970842](https://github.com/aloneio/runmesh/actions/runs/38198970842) 为 run number 314，仅 cadence job 成功，发布相关 jobs 跳过。push 的成功与 PR 的失败共同保留，Windows 初始故障原因继续定位；后续 A06 首错取消修改按新候选重新完成验收。

### `130c834` 候选的本机与托管复验

候选：`130c834e7d55ae7588809828dc5b7dde5acefe22`，源码树 `c807d8d5cffc16ff5411dcb19e7c99a0b1fc52e5`。Windows 本机在干净源码上完成网络 E2E 41/41、0 失败、0 跳过，测试耗时 193.55 秒、Vitest 总耗时 200.43 秒。混合负载在并发 1/4/8/16 下各完成 128 请求，共 512 请求、0 失败，P95 为 177 / 734 / 2721 / 3157 ms。原始证据为 `.audit/source-e2e-130c834.json` 与 `.audit/source-e2e-130c834.log`。

本次现有生产控制面的发布前置检查通过：Worker 版本 0.1.7、部署提交 `a18f3c0`，`release-chain-audit-v1`、生产非测试模式、packed D1 历史及审计绑定符合要求。该结果属于既有生产版本；候选 0.1.8 继续按独立发布与激活流程验收。

| 托管运行 | 最终结果 |
| --- | --- |
| [push CI 38203340543](https://github.com/aloneio/runmesh/actions/runs/38203340543)，attempt 1 | Windows Runner 单元测试失败，`verify-all` 失败；其余 6 个 jobs 成功。 |
| [PR CI 38203344298](https://github.com/aloneio/runmesh/actions/runs/38203344298)，attempt 1 | Windows Runner 单元测试失败，`verify-all` 失败；其余 6 个 jobs 成功。 |
| [main-source-policy 38203344300](https://github.com/aloneio/runmesh/actions/runs/38203344300) | 成功，验证对象为 PR118 的同仓库 dev→main。 |
| [Dev Runner Prerelease 38203340737](https://github.com/aloneio/runmesh/actions/runs/38203340737)，attempt 1、run number 315 | cadence、plan、Linux verify、browser、Linux/macOS native 和 Node LTS 成功；Windows 网络 E2E 与汇总失败，build/publish 跳过。计划版本 `0.1.8-dev.62` 未发布。 |

push 与开发预发布工件绑定精确候选提交。PR 工件绑定合成提交 `74e28835210ef6696a86ff3d90aa28d3121d63fd`，源码树与候选一致。三个工作流的 Linux verify 均成功；push 单元测试 4,947 通过、0 失败、34 跳过，其中 domain 530、contracts 50、protocol 57、Runner 1,564、Worker 2,441、根级 Node/UI 305。工具检查 1,027 通过、0 失败、23 跳过；安全专项 22 项要求、11 个独立文件共 565 项通过。源码与安装包网络 E2E 各 41/41，浏览器 E2E 5/5。Linux 测试归档为 1,198,294 字节，SHA256 `be3f1441b1d12d1368c9041f07355841e48f5872709b574849e541edb72281af`，未签名、未发布。

下表为 push 的 Linux 负载，每组四档共 512 请求、0 失败；PR 与开发预发布的各自指标保存在对应归档。

| 负载 | P50，按并发 1/4/8/16 | P95，按并发 1/4/8/16 |
| --- | --- | --- |
| 源码 MCP | 39 / 119 / 239 / 469 ms | 43 / 212 / 324 / 615 ms |
| 安装包 MCP | 36 / 112 / 221 / 437 ms | 41 / 195 / 277 / 565 ms |
| Skills | 11 / 31 / 57 / 128 ms | 20 / 49 / 77 / 251 ms |

push 与 PR 的 Windows Runner 单元测试均为 1,456 通过、1 失败、141 跳过，共 1,598 项；测试文件均为 70 通过、1 失败、3 跳过。两侧 transport 工件明确记录 `not_run`，这两次结果没有提供新的 Windows 网络验证。

| 运行 | Runner 单元首错与时间 |
| --- | --- |
| push，job `114661319638` | `patch-persistence-failures.test.ts` 的 `preserves 'atomic-save' file ownership during 'add' rollback` 失败；`AssertionError: expected undefined to be defined`，位置 `63:24`，断言为 `expect(external).toBeDefined()`。首错记录时间 `2026-10-12T04:23:34.6825547Z`，job 于 `04:23:39Z` 结束；Vitest 耗时 164.10 秒，测试耗时 148.09 秒。 |
| PR，job `114661331112` | `release-stager.test.ts` 的 `installs a signed older version beside the current installation and keeps state untouched` 失败；`EBUSY: resource busy or locked`，清理目标为暂存目录内的 `runtime/node.exe`。首错记录时间 `2026-10-12T04:25:01.6615576Z`，job 于 `04:25:06Z` 结束；Vitest 耗时 224.05 秒，测试耗时 195.34 秒。 |

开发预发布 Windows job `114661421271` 的 Runner 单元测试为 1,457 通过、0 失败、141 跳过；随后网络 E2E 记录 4 个失败测试、0 跳过，job 于 `2026-10-12T04:30:48Z` 结束。

| 网络失败测试 | 首错记录 |
| --- | --- |
| 索引 20，并发 4 | `mixed_load` 断言失败，`registry_unavailable`，类别 `availability`，操作状态 `not_started`，下一步 `wait_and_retry`；位置 `test/e2e/mcp-runner.e2e.test.ts:591:83`。 |
| 索引 21，并发 8 | HTTP 500，阶段 `shell`，非 JSON 文本、`network_connection_lost`；位置 `test/e2e/mcp-runner.e2e.test.ts:1193:42`。 |
| 索引 22，并发 16 | `mixed_load` 断言失败，`control_plane_unavailable`，类别 `availability`，操作状态 `not_started`，下一步 `wait_and_retry`；位置 `test/e2e/mcp-runner.e2e.test.ts:591:83`。 |
| 索引 23，编辑用例 | HTTP 500，阶段 `edit`，非 JSON 文本、`network_connection_lost`；位置 `test/e2e/mcp-runner.e2e.test.ts:1193:42`。 |

该工件保留的 15 条安全事件按出现顺序如下。授权 deadline 事件中的 `status=200` 是已观察到的 HTTP 状态，仍需结合对应阶段判断失败位置。

| 事件序号 | 记录 |
| --- | --- |
| 1 | `control_plane_failure`：阶段 `mcp_rpc_authorization`，`outcome=deadline`、`kind=other`、`reason=unknown`、`status=200`。 |
| 2 | 并发 4，`mixed_requests`：启动 126、完成 122，距用例开始 36,626 ms，等待响应头 3、响应体 0。 |
| 3–5 | 3 条 `proxy_upstream_connection_lost`，均为 `POST`、`attempts=1`。 |
| 6 | 并发 8，`job_setup`：启动 0、完成 0，距用例开始 1,403 ms。 |
| 7 | 1 条 `proxy_upstream_connection_lost`，`POST`、`attempts=1`。 |
| 8–9 | 2 条 `control_plane_failure`：阶段 `runner_mcp_authorization`，均为 `outcome=deadline`、`kind=other`、`reason=unknown`、`status=200`。 |
| 10 | 并发 16，`mixed_requests`：启动 21、完成 5，距用例开始 32,631 ms，等待响应头 14、响应体 1。 |
| 11–14 | 4 条 `proxy_upstream_connection_lost`，均为 `POST`、`attempts=1`。 |
| 15 | `launcher_snapshot`：`reason=test_failed`、`exit_code=null`、`signal=null`、`teardown_started=false`、`exited_before_teardown=false`。 |

失败列表未截断；代理事件已达到该组 8 条上限，未记录 `runtime_lifecycle` 事件。负载数据是首错瞬时快照，本轮缺少完整 Windows 负载统计。当前观测确定了授权路径 deadline 与后续连接丢失，初始触发原因继续核查。

四类工作流的源身份、jobs、10 份工件、8 份必要日志、负载和安全事件归档在 `.audit/130c834-ci`。`safe-summary.json` 的 SHA256 为 `1aad53b118b7ee8e95c6a1c2103c94b31d8c22ac553fd03d41976bbd1d2831ba`。这些记录属于 `130c834`；以下新修复尚待新候选完整验证。

### Skills 历史观测

Skills 新负载夹具在准备阶段曾出现瞬时 `skill_unavailable`，直接服务预检成功；后续成功运行分别保留在 [Skills 验证记录](skills-validation-2026-10-12.zh-CN.md)。新增安全阶段诊断后的一次串行运行完成 512 请求、0 失败，P95 为 67 / 208 / 703 / 546 ms。前次失败的原始阶段未被捕获；成功复测不抹去先前记录，也不作为历史根因已修复的证明。

候选版本为 0.1.8，源码发行状态保持 candidate。正式发布、双端 CI 与线上激活将按实际执行结果补录。

### Windows 首次故障的诊断补充

A06 的修改保留每档 128 请求、并发 1/4/8/16、每档 60 秒测试时限及生产控制面 5 秒预算。`510bc2a` 已在首错后停止发起新请求并等待同组请求结束；后续修改进一步主动取消在途 HTTP 请求，汇合全部任务后重新抛出首错，HTTP 作用域同时保留测试超时取消。首错快照在取消前冻结，区分响应头与响应体等待；准备阶段单独标记。主动取消修改通过 13/13 项定向回归及 TypeScript 检查后纳入 `130c834`，该候选的本机通过与托管失败结果分别保留。

已补充的控制面诊断包括 Registry 初始化与 HTTP 请求、Runner 请求、内部签名与传输、最终授权回执；运行时诊断包含 Miniflare 内部重启等固定分类。日志与工件仅输出固定阶段、原因、状态和有界计数。首批控制面定向回归 38/38、诊断定向回归 16/16 已通过。

`510bc2a` 后补齐前置 `reauthorizePrincipal` 与 Registry RPC 路径的九个固定阶段，以及现有碎片上限对应的 `fragment_limit` 分类。200 成功、404 缺失、403/409 权限拒绝、合法 202 延迟审计回执均保持静默；签名异常仍原样抛出。两个 Worker 定向文件共 217/217 项通过，架构检查覆盖 472 模块、2,402 条依赖边、0 环，TypeScript 和差异检查通过。另使用 Wrangler 实际依赖的 esbuild 0.28.1 验证 Windows `X [ERROR]` 格式，修正严格日志解析器，17/17 项定向回归通过。

此前对顶层 Miniflare 源码的只读核对发现，其 core 外层 `service.fetch` 异常路径可以返回无专用诊断头的文本 500，loopback server 也已设置 `keepAliveTimeout=0`。后续依赖解析确认该顶层版本属于 Worker 单元测试池，E2E 由 Wrangler 的嵌套运行时启动。因此这项源码观测仅作为对应依赖实现的参考；E2E 路径及版本以末节的 `createRequire` 解析结果为准。现有首错证据尚未确认具体运行时触发路径。

### `130c834` 后、`5984ae8` 冻结前的修复状态

以下记录保留 `5984ae8` 冻结前的修复与定向验证状态；该候选的最终本机与托管结果见末节。定向证据与完整验收分别使用。

| 项目 | 已确认的问题与当前进度 | 下一项验收 |
| --- | --- | --- |
| A07：Registry 例行维护 | 每次受保护 RPC 的维护查询扫描全部 Runner。已使用部分表达式索引与等价 `MIN` 查询，保持维护写预算、nonce 和权限语义。33/33 项定向验证通过；1,000 条记录的 `rowsRead` 从原至少 1,000 降至最多 2。类型、架构与测试收集检查通过。 | 在新候选上完成源码、安装包及托管门禁，并继续核对授权路径的负载表现。该优化与历史 Windows 故障的因果关系仍需证据。 |
| A06：控制面阶段诊断 | 首错记录在返回 HTTP 200 后仍可能显示 deadline，原日志未区分等待响应、读取正文与解析 JSON。已加入固定枚举 `fetch`、`body_read`、`json_parse`，Worker 264/264、Node 诊断 18/18 通过；5 秒生产预算、首错保留及安全日志字段约束保持原值。 | 在新候选失败工件中核对阶段证据；此修改提高可观察性，未据此确定历史网络首因。 |
| A08：文件身份精度 | Workspace、补丁及分页读取已采用精确身份，定向集合 95 通过、3 跳过；Jobs/Context 的 8 文件 139 通过、1 既有平台跳过；配置/元数据/Git 等新增与既有 8 文件合计 97 通过、64 平台跳过。证据读取扩展 10/10 通过。共享 helper 约束、源码架构检查及本机 Windows 完整 Runner 套件通过。 | package-verification/verification-tools 两文件完整验证通过，新候选 E2E 与托管门禁待完成；当前未将其认定为 `130c834` CI 失败原因。 |
| A09：Windows release staging | 已为私有暂存目录提交加入 Windows 短暂占用重试，最多 6 次 rename、共 250 ms 退避；取消保留调用方原因，清理使用有限重试，并通过 `AggregateError` 同时保留主错与清理错误。受影响测试的收尾改为独立钩子。39/39 项定向验证通过，包含新增的瞬时 EBUSY/EPERM/EACCES、持续 EBUSY/EIO 与取消 6 项回归。 | 在新候选上执行完整安装升级及托管门禁；定向通过与候选验收分别记录。 |
| A10：测试进程收尾 | Runtime 的测试子进程在 spawn 时登记 `close`，finally 独立停止并汇合；Windows 锁夹具增加独立 stop 文件和 20 秒自身截止，锁持有者等待 `close`。两文件 118 通过、4 跳过，新增 holder 始终未就绪时的 stop/deadline 回归均通过，随后本机 Windows 完整 Runner 套件通过。 | 冻结提交后完成源码/安装包 E2E 与托管门禁；保持原终止、锁与退出码断言预算，不将该失败路径缺口归为通过单元测试后的网络首因。 |
| A11：Runner 补丁测试诊断 | `external` 为 undefined 的断言遮蔽了此前操作的原始异常。诊断修正已通过 28/28 项定向验证，相关首错定位与修复继续进行。 | 在新候选 Windows 完整测试中保留原始异常并复验回滚行为。 |

Windows release staging 的定向日志为 `.audit/staging-lock-tests2.log`（39/39 通过）。此前 `.audit/staging-lock-tests.log` 为 38/39 通过：原有 SIGTERM 抵抗探针测试在 5 秒准备窗口内未读到就绪标记。测试随后加入阶段提前结束与就绪等待的竞争检查，以保留阶段原始异常；此次通过不作为此前准备迟滞根因已修复的证明。

文件身份定向首轮 `.audit/exact-file-identity-runner-tests.log` 记录 94 通过、1 失败、3 跳过。失败来自分页快照的旧夹具使用非精确数字身份；修正该夹具后，`.audit/exact-file-identity-snapshot-tests.log` 记录对应文件 25/25 通过，定向集合因此记为 95 通过、3 跳过。此计数按测试集合归并，未将重叠复验累加为更多独立测试。测试进程收尾的完整日志为 `.audit/process-fixture-cleanup-tests.log`，两文件 118 通过、4 跳过、0 失败，总耗时 195.92 秒。

阶段诊断定向验证使用 Node 22.23.2：Worker 的 `control-plane-receipts.test.ts`、`reauthorization-budget.test.ts`、`mcp-failure-chain.test.ts` 串行运行，3 文件 264/264 通过，耗时 13.51 秒；根级 `verification-tools.test.mjs` 按 MCP、运行时生命周期、控制面及负载诊断名称筛选，18/18 通过，耗时 3.85 秒。结果已由执行工具输出确认；`.audit/runner-audit-verified-results.json` 后续保存了参数、环境和计数，明确标记为工具结果摘要，并非这两次运行的原始日志。该摘要也记录 Registry 索引 33 项定向通过。

Jobs/Context 后续定向原始日志为 `.audit/exact-job-context-tests.log`：8 文件 139 通过、1 既有平台跳过，耗时 26.56 秒。配置、元数据、Git 和维护链路分两组执行：新增及维护 3 文件 73 通过、17 平台跳过，耗时 5.81 秒，记录在上述工具结果摘要；既有 5 文件 24 通过、47 平台跳过，耗时 29.46 秒，原始日志为 `.audit/runner-identity-existing-tests.log`。两组合计 97 通过、64 跳过，各组与其他专项存在覆盖重叠，因此保留各自计数。源码架构检查 473 模块、2,422 条边、0 环通过；共享精确身份 helper 只允许 `node:fs` 类型导入，并保持无 I/O、异步或调度行为。

本批 Windows 完整 Runner 复验于 2026-10-12 13:06:50（Asia/Shanghai）开始，使用 Node 22.23.2，75 文件中 72 通过、3 平台跳过；共 1,636 项测试，1,494 通过、142 平台跳过、0 失败，耗时 580.30 秒。原始日志为 `.audit/runner-full-identity-repair.log`。这一结果覆盖本机 Runner 套件；完整架构、package-verification/verification-tools、类型检查、测试收集与构建随后通过，新一轮功能负载 594/594 通过；源码/安装包 E2E 等待冻结提交后分别验收。

A08 同时扩展至 `scripts/evidence-io.mjs`：读取路径及已打开描述符均使用 BigIntStats，完整保留 `dev`、`ino`、`size`、`mtimeNs`、`ctimeNs` 进行前后比较。先按 8 MiB 总上限及调用方限额验证大小，再仅将已接纳的 `size` 转为 number 进行字节计数。新增 9 项模拟元数据回归及原生 UTF-8/大小边界测试共 10/10 通过、0 跳过，原始日志为 `.audit/evidence-identity-metadata-tests.log`，耗时 326.54 ms。package-verification/verification-tools 两文件完整验证随后通过，结果见下文。

本批最终静态与工具验证结果如下：

| 项目 | 结果与原始证据 |
| --- | --- |
| 完整架构测试 | 301 项中 300 通过、0 失败、1 项按 Windows 符号链接条件跳过，耗时 16.55 秒；`.audit/architecture-full-identity-repair.log`。 |
| package-verification 与 verification-tools | 两文件完整复验 127 通过、3 跳过、0 失败，耗时 116.37 秒；`.audit/verification-tools-identity-repair2.log`。 |
| 固定工具链类型检查与构建 | 显式使用 `npm.cmd` 后两项通过，`check-toolchain` 确认 Node 22.23.2/npm 10.9.3；`.audit/typecheck-identity-repair-pinned.log`、`.audit/build-identity-repair-pinned.log`。 |
| 测试清单与收集 | 9 组、259 文件通过契约检查；`.audit/collection-identity-repair.log`。该检查核对收集范围，不计为测试执行通过。 |

工具验证首轮 `.audit/verification-tools-identity-repair.log` 为 126 通过、1 失败、3 跳过：测试环境的 `npm-exact` 自定义 shim 缺少标准邻接 CLI 布局，被项目的 npm 发现检查按约定拒绝。PATH 改为同一 npm 10.9.3 的标准安装前缀后取得上述复验结果，Node 保持 22.23.2。随后发现 PowerShell 的 `npm.ps1` 会转到 10.9.8，因而显式使用 `npm.cmd` 重新完成类型检查与构建，并确认固定工具链。这些记录属于本机测试准备与命令选择问题。

新一轮本地功能负载 594/594 通过，耗时 9.276 秒；4 次搜索均完整返回 24 条、无截断。文件新增/更新 P95 为 145.65/220 ms，日志分页/文件读取 P95 为 5.85/17.16 ms，取消最大耗时为 292.32 ms。驱动器峰值常驻内存 103,718,912 字节（约 98.914 MiB），仅覆盖驱动器进程。原始 JSON 已独立归档为 [Runner 第二轮指标](runner-functional-load-2026-10-12-r2.json)，SHA256 为 `2f05511aabfc9c7f9403a70433bfdcfda39d5f3ef6b984a9cd366a6bf406f291`，原始日志为 `.audit/runner-functional-load-identity-repair.log`。两轮沿用相同功能负载，但历史运行承载更高的并行验证压力，119.754 秒至 9.276 秒的差异不直接归因于本批修复。

负载驱动加入可选输出文件参数，各次结果分别保存，历史文件保持原样。新增输出变量最初与既有 payload 变量重名，esbuild 在负载执行前拒绝构建；改为 `reportPath` 后，`node --check` 与 bundle 检查通过，再完成上述新一轮负载。该准备问题未记为一次失败的产品负载运行。

本批用户文档复核确认 `release/release-state.json` 为 0.1.8 candidate，中英文发行状态均列出正式版 0.1.7 与正在验证的 0.1.8，README 引导读者查看该状态。0.1.8 双语发行说明仅补充大型 Runner 部署的维护读取优化，以及文件编辑和分页读取的完整系统标识校验。文档契约与源码事实、3 项 runbook 检查通过；145 份 Markdown 的 963 个本地链接及 30 个标题锚点再次通过，未据此改变发行状态。

### `5984ae8` 候选的完整观测

候选提交为 `5984ae8609373390230b6a97b9f6993dec173d89`，源码树为 `2360913788b45611b3a737c940c8fbe177c57640`。本机源码与安装包 E2E 均在此提交的干净源码上执行。托管 push 产物绑定该提交；PR 产物绑定合成提交 `e1be7c5862f29ee081550394c6055326c970288b`，源码树与候选一致。以下运行均为 attempt 1，完整保留首轮结果。

| 工作流 | 终态与覆盖 |
| --- | --- |
| [push CI 38208199049](https://github.com/aloneio/runmesh/actions/runs/38208199049) | `verify` 的 unit 门禁与 Windows 网络 E2E 失败，`verify-all` 失败；Linux/macOS native、两个 Node LTS 及 browser jobs 成功。 |
| [PR CI 38208203605](https://github.com/aloneio/runmesh/actions/runs/38208203605) | 与 push 相同的两个失败门禁，`verify-all` 失败；其余五个 jobs 成功。 |
| [Main Source Policy 38208203616](https://github.com/aloneio/runmesh/actions/runs/38208203616) | 成功，PR118 的来源符合策略。 |
| [Dev Runner Prerelease 38208199360](https://github.com/aloneio/runmesh/actions/runs/38208199360) | cadence 成功，`due=false`、push number 316、remaining 4、sequence 62；plan、verification、build 与 publish 按节奏跳过，产物数为 0。 |

Linux 两侧 unit 日志各记录 4,695 通过、1 失败、36 跳过：domain 530、contracts 50、protocol 57、Runner 1,600 通过及 36 跳过、Worker 2,458 通过及 1 失败。失败位于 `apps/worker/test/registry-domains.test.ts:95` 的 AR06 精确成本对照，`heartbeat.writes` 与 `session_begin.writes` 的实际值均为 2，历史预期均为 1。其余对应调用数、读取数、SQL 顺序摘要与回执保持一致。push/PR unit 门禁分别耗时 180,946/223,450 ms；门禁工件中的 `test_counts` 为 null，上述测试数来自独立日志汇总。

Registry 维护索引使 1,000 条 Runner 的例行维护读取量由至少 1,000 降至最多 2，同时在更新该索引时增加计量写入。成本回归应精确体现 heartbeat 与 session_begin 的 2 次写入，保留历史 JSON，以及调用、读取、顺序和回执的现有断言。该取舍用于解释本轮 AR06 差异；Windows 网络首错仍按自己的证据定位。

两侧 Linux 的工具链、安装、依赖、文档、runbook、版本、格式、空白、架构、类型、清单、CI 策略和提升策略门禁通过。unit 之后的 tooling、安全专项、构建、源码/安装包网络与发布契约等工件记录为 `not_run`；独立 browser jobs 的 E2E 各 5/5 通过、0 跳过。

Windows push 与 PR 的完整 Runner 套件各 1,494 通过、142 平台跳过、0 失败；75 个文件中 72 通过、3 平台跳过，Vitest 总耗时分别为 225.13/239.95 秒。其后的网络门禁失败，原始工件仅提供失败及跳过数，完整通过计数按缺失保留。

| 执行 | 有界首错 | 首错时的负载快照 |
| --- | --- | --- |
| push，测试索引 21 | `mcp_http_failure`，HTTP 500；`job_logs` 阶段，文本非 JSON，RPC code/id 缺失，固定运行时特征 `network_connection_lost`。位置 `test/e2e/mcp-runner.e2e.test.ts:1193:42`。共 1 个失败测试、0 跳过。 | 并发 8；started 57、completed 49、elapsed 17,767 ms；pending_headers 7、pending_body 1。 |
| PR，测试索引 19 | `test_timeout`，位置 `test/e2e/mcp-runner.e2e.test.ts:1186:24`。 | 并发 1；started 87、completed 86、elapsed 60,014 ms；pending_headers 1、pending_body 0。 |
| PR，测试索引 22 | `mcp_http_failure`，HTTP 500；`read_initial` 阶段，文本非 JSON，RPC code/id 缺失，固定运行时特征 `network_connection_lost`。位置 `test/e2e/mcp-runner.e2e.test.ts:1193:42`。PR 共 2 个失败测试、0 跳过。 | 并发 16；started 85、completed 69、elapsed 24,824 ms；pending_headers 15、pending_body 1。 |

两侧均记录一次 `proxy_upstream_connection_lost`，方法 POST、attempts 1。`launcher_snapshot` 显示 `test_failed` 时退出码与信号为 null，teardown 尚未开始，进程也未提前退出。失败列表无截断；本轮未观察到控制面阶段或运行时重启事件。因此现有字段支持连接丢失与等待停滞的定位，尚未确定触发它们的运行时路径。Windows push/PR 网络门禁分别耗时 203,301/254,659 ms。

Windows 本机源码与安装包 E2E 各 41/41 通过、0 跳过，每组混合负载在并发 1/4/8/16 下各完成 128 请求，总计各 512 请求、0 失败。以下延迟来自各自原始日志，属于本轮本机条件。

| 并发 | 源码 P50/P95（ms） | 安装包 P50/P95（ms） |
| --- | --- | --- |
| 1 | 97 / 146 | 94 / 128 |
| 4 | 311 / 669 | 317 / 521 |
| 8 | 788 / 1,159 | 587 / 835 |
| 16 | 1,511 / 1,836 | 893 / 1,080 |

源码 Vitest 总耗时 152.31 秒、测试耗时 146.42 秒，门禁 wrapper 为 158,457 ms；Vitest JSON 单文件 wall 为 114.390 秒，各字段保留原口径。安装包 Vitest 总耗时 101.92 秒，wrapper 为 138,550 ms；包 1,206,785 字节，SHA256 `d3e4b189f58d5de200acae76f0e54531122af3c481f7c4b37dfc864d0320042a`，`signed=false`、`published=false`。源码证据为 `.audit/source-e2e-5984ae8` 的 log、json、evidence.json 与 gate.json；安装包证据为 `.audit/package-e2e-5984ae8.json` 和对应 log。

四个工作流的运行/attempt/作业身份、6 份产物 ZIP、5 份必要日志及其 SHA256 归档在 `.audit/5984ae8-ci`。固定来源验证后的 `safe-summary.json` SHA256 为 `4c4539e30f414fd07404bf99e67e7eff0e9214a166dd77fc01fb67e9321e2389`；`state=complete` 表示观测结束，`validation_state=failed` 表示候选门禁结论。本机通过证据单独记录于 `local_validation`。新修复的执行日志与该候选归档分开计量，成本断言修正与后续网络修复由新候选重新验收。

运行时版本使用 Node 22.23.2 的实际模块解析核对：`createRequire` 从每个 owner 的 `package.json` 解析 Miniflare，再从该 Miniflare 解析 workerd。Wrangler 4.135.0 实际解析到自身嵌套的 Miniflare `5.20260918.0-alpha` 与 workerd `1.20260918.1`；`@cloudflare/vitest-pool-workers` 0.22.0 解析到顶层 Miniflare `5.20260815.0-alpha` 与 workerd `1.20260815.1`。`scripts/worker-fixture.mjs` 启动 `node_modules/wrangler/bin/wrangler.js dev`，因此 E2E 运行时按前一条链路分析。解析原始记录为 `.audit/5984ae8-ci/runtime-resolution.json`，对应 `package-lock.json` SHA256 为 `62ffc6f22c9569c2de400b801c8c4cad84c4a7640b415d7b5e2f8e38a9673570`。仅凭顶层安装版本推断 E2E 运行时的早期判断已收窄至测试池依赖范围。

### `5984ae8` 之后的成本断言复验

修正仅在 `apps/worker/test/registry-domains.test.ts` 为 `session_begin` 与 `heartbeat` 各覆盖精确 `writes: 2`，历史 baseline 文件及其他成本、回执和顺序断言保持原样。4 文件定向回归 28/28 通过，耗时 22.50 秒；完整 Worker 114 文件、2,459 项测试全部通过，0 失败、0 跳过，Vitest 总耗时 509.18 秒。原始日志分别为 `.audit/5984ae8-ci/registry-cost-regression.log`（SHA256 `cea058aa37fcc09001ec26ac34029dd473edd18790eb26b1bd981a40038a694e`）和 `.audit/5984ae8-ci/worker-full-after-cost-fix.log`（SHA256 `11a63ca49453797f9b59ed4a64851d82f97a9b63dfad3d52c2dd3a019e7ad527`）。

这两次运行使用成本断言修改后的本机工作区，属于 `5984ae8` 之后的修复证据；上述固定候选 `safe-summary.json` 不包含这两份修复日志。新候选 CI 继续验收完整门禁，Windows 网络故障仍保留独立定位结论。

### `5984ae8` 之后的 HTTP 资源清理修正与生命周期核查

只读核查发现，`test/e2e/mcp-runner.e2e.test.ts` 中两处管理 API 注册 Runner 的成功 HTTP 200 响应只断言状态，未消费 JSON 正文：一处为混合负载前的第二 Runner 注册，另一处为混合负载后的根目录 Git 测试注册。`apps/worker/src/http/runner-api.ts` 的成功契约为 `{ runner_id, token }`。两处现已在状态断言后增加 `await response.json()` 并仅断言返回的 `runner_id`，让正文读取在各自测试作用域结束前完成，断言也避免输出完整凭据回执。

此项归类为测试 HTTP 资源清理修正。它没有增加重试、延迟或改变测试负载；网络初始原因尚未确证，不能将这两行修改列为 `network_connection_lost` 的根因修复。修改后 `git diff --check` 通过，完整 E2E 等待新候选冻结后验证；`5984ae8` 的既有通过与失败结果均保留原归属。

HTTP 作用域的 `finally` 会取消该测试尚未结束的请求，`beforeAll` 准备请求保持自身生命周期。成功表单重定向由 `apps/worker/src/http/html-response.ts` 返回 body 为 null 的 303；成功 MCP 响应通过 `readMcp().text()` 完整读取。当前安装的 Agents legacy adapter 为每个请求建立局部 server/transport，在 SSE EOF 时等待两者的 close 调用结束后才关闭响应流。上述源码核查确认了每请求的响应消费与清理路径，未提供成功 SSE 跨测试遗留的证据。

`5984ae8` PR Windows 的首个失败可以进一步定位：并发 1、started 87、completed 86、pending_headers 1、pending_body 0，表示唯一在途请求为从 0 计数的 index 86。夹具按 `index % 4` 轮换 read、workspace_list、job/get、job/logs，因此该请求是省略 `workspace_id` 的 `job/get`，在 60,014 ms 的用例超时时仍等待 HTTP 响应头。push 的并发 8 与 PR 后续并发 16 的首错快照各有一条 pending_body；`mcpMessage` 对非 200 响应同样先进入 body 阶段再分类错误，所以这两条分别包含正在分类的 `job_logs`、`read_initial` HTTP 500，不能据此判断成功 SSE 正文读取停滞。这些是既有工件与夹具源码的联合定位，未新增一次测试执行。

前序恢复测试先关闭传输，再终止并重启 Runner 进程，随后确认恢复 Job 为 `interrupted`。Runner 当前连接的 close 路径清理心跳/同步计时器并拒绝 pending RPC；旧进程的内存状态不跨进程延续。混合负载前其余后台 Job 已观察到成功终态；排队、busy 与历史模式变更测试均在混合负载之后。现有源码核查没有建立前序测试遗留传输与首错之间的因果关系。

下一项诊断为夹具原生进程观察器，用于补足 Wrangler launcher 状态与实际运行时子进程状态之间的证据缺口。该方案处于实现与待验证阶段，本节暂不记录成功计数或将其视为网络修复；后续以独立运行结果补录。

### 原生进程观察器的实现与本机验证

上述待验证方案随后完成实现。`scripts/worker-fixture.mjs` 通过 fixture 专用 preload 加载 `scripts/worker-runtime-observer.mjs`，按 Wrangler 实际解析的 Miniflare→workerd 链路匹配原生进程，仅输出固定的覆盖状态、spawn/exit 阶段、有界启动序号、耗时、原生退出码及信号分类。观察器最多跟踪 16 次匹配启动，保留原 spawn 的接收者、参数对象、返回值和异常行为；生产入口与运行时依赖版本保持原样。诊断接收器接受完整的 Windows/POSIX 原生退出码范围。

Windows、Node 22.23.2 的真实 Wrangler 健康检查 smoke 通过。`.audit/runtime-observer-smoke.json` 记录 bin 与 CLI 两层各一次 `coverage=installed`，以及嵌套 workerd 的两次实际启动：index 1 为 6,963 ms，index 2 为 11,858 ms。该结果确认 preload 与实际运行时的观测覆盖；两次 spawn 本身不构成运行时重启或崩溃证据，也不证明历史网络故障已修复。

新增 observer 定向验证 10/10、browser-fixture 定向验证 5/5、完整原生退出码诊断定向验证 8/8 通过。随后 verification-tools 与 observer 两文件完整执行 107/107 通过、0 跳过，耗时 35.076 秒，原始日志为 `.audit/runtime-observer-tools-full.log`。这些定向集合与完整集合分别记录，存在覆盖重叠。

CI 接线首轮将观察器测试并入冻结的旧 native 命令，触发 5 项布局契约失败；原始日志 `.audit/observer-ci-wiring-tests.log` 保留 238 通过、5 失败、2 跳过，共 245 项的结果。随后改为 `NATIVE_ADDED_COMMANDS` 中的独立 step，旧 native 命令继续保留；ci-layout 复验 6/6 通过、0 跳过，耗时 362.823 ms，证据为 `.audit/observer-ci-layout-corrected.log`。这一修正属于 CI 测试接线，未改变产品网络行为。

本轮静态检查通过：format 覆盖 1,051 文件；架构为 473 模块、2,422 条依赖边、0 环；测试清单为 9 组、260 文件；CI 契约为 26 门禁；文档源码事实、3 项 runbook、版本一致性及 TypeScript 检查均通过。以上结果属于冻结前工作区验证，新的干净提交源码 E2E 将另行记录，Windows 网络首因继续保留独立调查结论。

### `aab0b18` 候选的完整观测

候选提交为 `aab0b183a4b6759fe92d944847f445b1cacbbdf6`，源码树为 `7fed2f3c6b498c4c13a594ee1e7d351b32c777e1`。Windows 本机源码与安装包证据均绑定此提交的干净源码。PR 工件绑定合成提交 `6727f81fb8dddd19254b5b3e495c840f1ba3fe20`；Git 提交 API 与全部工件的源码字段共同确认其树与候选一致，父提交为 main 的 `a18f3c0` 与该候选。以下运行均为 attempt 1。

#### 该候选的验证矩阵

下表保留该候选归档时的验证结果与发布状态，来源绑定 `aab0b183a4b6759fe92d944847f445b1cacbbdf6`，源码树 `7fed2f3c6b498c4c13a594ee1e7d351b32c777e1`；其余候选结果按源码身份分别记录。不同专项与完整测试存在覆盖重叠，计数分别列示。

| 功能面 | 验证内容 | 该候选证据 |
| --- | --- | --- |
| 协议与 API | Schema、帧编解码、输出契约、分页、客户端选择 | 本地退出码专项 106 项通过；候选 Linux protocol 57 项、contracts 50 项通过。 |
| 任务与连接 | 并发排队、输入、取消、完成、持久化、恢复、重连 | 本地新一轮 Runner 功能负载 594/594 通过；候选 Linux Runner 单元测试各 1,600 通过、36 跳过。Windows 本机源码与安装包 E2E 各 41/41、混合请求各 512/512；托管 push Windows E2E 41/41，PR Windows 记录 3 项失败。 |
| 工作区 | 文件、搜索、Git、补丁、Context 存储 | 本地真实文件/Git/Context 并发负载、候选 Runner 完整套件及本机两组网络 E2E 通过；云端网络首错继续定位。 |
| 中央能力 | Skills 迁移与版本、远程 MCP 目录与调用、OAuth 状态 | 本地迁移专项 42 项及集成 28 项通过；候选 Worker 单元测试各 2,459/2,459 通过，Registry 精确成本断言复验通过。历史 Skills 512 请求证据保留原提交归属；本候选两路 Linux 综合门禁全部通过。 |
| 管理界面 | 登录、导航、Runner、客户端、Skills、语言及窄屏 | 候选 push 与 PR 的 browser job 均成功，浏览器 E2E 各 5/5、0 跳过；根级 Node 测试各 305/305 通过，并单独计入 unit 门禁。 |
| 安装与升级 | Windows/Linux/macOS 服务、安装锁、排空、更新恢复 | 候选 Linux/macOS native jobs、Node 22.23.2/24.21.0 LTS jobs 成功；push/PR Windows Runner 单元测试各 1,494 通过、142 平台跳过。push Windows native 整体成功；PR 在后续网络 E2E 失败。 |
| 发布物 | 编译、打包、离线安装、包级端到端、签名与校验和 | 固定工具链本地构建通过；候选 Windows 本机安装包 E2E 41/41、0 跳过，包 1,206,785 字节，签名与发布状态均为 false。正式签名制品另行验收。 |
| 文档与治理 | 文档链接、版本事实、许可证、架构、测试收集、CI 一致性 | 本地文档契约 39 项、安全配置 10 项及 963 个链接、30 个锚点通过；候选两路 Linux verify 的 26 个门禁及 main-source-policy 全部通过。 |
| 正式发布 | 同一候选提交双端 CI、受保护 dev→main、签名发布、激活与线上来源 | 候选 GitHub push 成功，PR 的 Windows 网络门禁失败；开发预发布 cadence 成功且 due=false，plan/verification/build/publish 按节奏跳过。[PR118](https://github.com/aloneio/runmesh/pull/118) 的 main-source-policy 成功。现有生产为 0.1.7；0.1.8 的双端 main CI、签名发布与 activation 按后续证据验收。 |

#### 托管与本机执行记录

| 工作流 | 终态与覆盖 |
| --- | --- |
| [push CI 38211958047](https://github.com/aloneio/runmesh/actions/runs/38211958047) | 全部 jobs 成功，含 verify、browser、Windows/Linux/macOS native 及 Node 22.23.2/24.21.0 LTS。 |
| [PR CI 38211962274](https://github.com/aloneio/runmesh/actions/runs/38211962274) | Windows 的 `Verify Windows MCP transport and Runner recovery` 失败；verify、browser、Linux/macOS native 与两个 Node LTS jobs 成功。 |
| [Main Source Policy 38211962290](https://github.com/aloneio/runmesh/actions/runs/38211962290) | 成功，PR118 来源符合策略。 |
| [Dev Runner Prerelease 38211958173](https://github.com/aloneio/runmesh/actions/runs/38211958173) | cadence 成功，`due=false`、push number 317、remaining 3、sequence 62；plan、verification、build、publish 按节奏跳过，产物数为 0。 |

两路 Linux verify 的 26 个门禁全部通过。unit 各记录 Vitest 4,696 通过、36 跳过，分为 domain 530、contracts 50、protocol 57、Runner 1,600 通过及 36 跳过、Worker 2,459；同一 unit 步骤的根级 Node 测试另有 305/305 通过。因此 unit 门禁合计 5,001 通过、0 失败、36 跳过，共 5,037 项。tooling 属于独立门禁，各为 1,050 通过、0 失败、23 跳过，共 1,073 项。计数来自日志中的独立 Vitest/TAP 汇总，门禁工件中的 `test_counts=null` 保留原值。

两路 Linux 源码 E2E 与安装包 E2E 均各 41/41 通过、0 跳过，browser 各 5/5 通过。四组 Linux 混合负载均按并发 1/4/8/16 各完成 128 请求，每组共 512 请求、0 失败；下表依次记录各并发档位延迟。

| Linux 负载 | P50，按并发 1/4/8/16 | P95，按并发 1/4/8/16 |
| --- | --- | --- |
| push 源码 | 25 / 69 / 140 / 250 ms | 32 / 126 / 173 / 338 ms |
| push 安装包 | 25 / 68 / 146 / 251 ms | 30 / 136 / 231 / 332 ms |
| PR 源码 | 33 / 104 / 201 / 344 ms | 39 / 176 / 267 / 451 ms |
| PR 安装包 | 33 / 99 / 200 / 350 ms | 41 / 171 / 264 / 459 ms |

Windows 两侧 Runner 单元测试各 1,494 通过、142 平台跳过、0 失败，Vitest 总耗时分别为 222.32/271.87 秒。push 网络 E2E 41/41 通过、0 跳过，Vitest 总耗时 180.04 秒，wrapper 为 182,174 ms。混合负载各档 128 请求全部成功，P50 为 139/499/1,190/2,457 ms，P95 为 2,186/887/2,298/3,008 ms；各档耗时 51,326/16,732/19,739/18,109 ms。单并发耗时已接近其 60 秒测试预算，这一观测用于继续评估正常路径延迟，不据此判定历史连接丢失已解决。

PR Windows 网络工件记录 3 个失败测试、0 跳过，失败列表未截断；完整通过计数和成功负载汇总未由该失败工件提供，按缺失保留。wrapper 用时 291,786 ms，子进程退出码 1，低于 300,000 ms 的整体执行截止，门禁状态为 `failed`。

| PR Windows 失败 | 有界首错 | 首错时的负载快照 |
| --- | --- | --- |
| 测试索引 19，并发 1 | `test_timeout`，位置 `test/e2e/mcp-runner.e2e.test.ts:1188:24`。 | started 122、completed 121、elapsed 60,020 ms；pending_headers 1、pending_body 0。 |
| 测试索引 21，并发 8 | `mcp_http_failure`，HTTP 500；`job_get` 阶段，文本非 JSON、RPC code/id 缺失、固定运行时特征 `network_connection_lost`。位置 `test/e2e/mcp-runner.e2e.test.ts:1195:42`。 | started 122、completed 114、elapsed 54,610 ms；pending_headers 7、pending_body 1。 |
| 测试索引 22，并发 16 | 同类 HTTP 500 与 `network_connection_lost`，安全阶段分类为 `other`，位置同上；保留分类原值。 | started 35、completed 19、elapsed 13,040 ms；pending_headers 15、pending_body 1。 |

该 PR 工件记录 3 条 POST `proxy_upstream_connection_lost`，各 attempts 1。`launcher_snapshot` 的原因是 `test_failed`，退出码和信号均为 null，`teardown_started=false`、`exited_before_teardown=false`。原生观察器记录两层 `coverage=installed`，以及 index 1 在 2,763 ms、index 2 在 3,529 ms 的 spawn；已归档日志与工件中未记录原生 exit 或 runtime restart。push Windows 同样有两层 installed，spawn 分别为 3,293/4,212 ms，未记录 exit/restart。Linux 的源码及安装包运行每个夹具也各记录两次 native spawn。以上说明实际记录到的生命周期事件；事件缺席本身不证明进程始终存活，也不能独立确定网络故障原因。

Windows 本机干净源码与安装包各 41/41 通过、0 跳过，混合负载各 512 请求、0 失败。源码 Vitest 总耗时 97.93 秒、wrapper 100,368 ms；安装包 Vitest 总耗时 104.94 秒、wrapper 132,382 ms。

| 本机并发 | 源码 P50/P95（ms） | 安装包 P50/P95（ms） |
| --- | --- | --- |
| 1 | 76 / 97 | 92 / 177 |
| 4 | 244 / 386 | 308 / 444 |
| 8 | 513 / 625 | 665 / 1,435 |
| 16 | 1,013 / 1,281 | 1,025 / 1,363 |

本机源码日志在上述通过结果之外，明确记录 index 1 于 `elapsed_ms=87126` 以退出码 1 退出，随后为 `runtime_lifecycle: crash_restarting`、`crash_count=1`，并在 `elapsed_ms=87175` 启动 index 3。`elapsed_ms` 从观察器启动计时，不是该子进程存活时长；当前事件没有 teardown 字段，Vitest JSON 也未提供各 describe 收尾的绝对时刻。因此本轮仅确认退出与重启发生，保留测试执行阶段与收尾阶段两种时序可能，未归因于测试中的崩溃或收尾终止。本机安装包日志记录两次 native spawn，未记录 exit/restart。

本机包为 1,206,785 字节，SHA256 `d3e4b189f58d5de200acae76f0e54531122af3c481f7c4b37dfc864d0320042a`；Linux 两路包同为 1,206,785 字节，SHA256 `93654393365c6f8c6293fe5abf24e1dc5745d2bda504d5a4a2ae90a9ef203d19`。各自的包证据均为 `signed=false`、`published=false`，分别保留其构建与执行归属。源码本机证据为 `.audit/source-e2e-aab0b18` 的 log/json/evidence.json/gate.json；安装包为 `.audit/package-e2e-aab0b18.json` 与对应 log。

四个工作流身份、6 份产物 ZIP、5 份必要日志和各自 SHA256 完整归档至 `.audit/aab0b18-ci`。`safe-summary.json` 的 SHA256 为 `9e99cbfa359393834dba855205181ebf884025064ec021f54da4bef10eead3a2`，其中 `state=complete`、`archive_state=complete` 表示观测与归档完成，`validation_state=failed` 表示本候选门禁结论。PR 失败事件同时保存在原工件及 `artifact_worker_events`，本机通过与生命周期记录保存在 `local_validation`。`5984ae8` 的归档与摘要 hash 保持原样；后续文档编辑及新的修复使用各自的源码身份另行验收。

### `aab0b18` 之后的测试阶段观测

本批调整用于区分正常 MCP 调用的身份核验、SDK 准备、再次授权、业务操作、首个 SSE 字节与流结束阶段，属于测试观测补充。独立审阅确认当前 Agents 0.21.0 与 MCP server SDK 2.2.0 按每个 POST 创建独立 server/transport，最终响应关闭请求流，客户端完整消费响应；本轮没有形成可证明的正常 POST 生命周期缺陷或 Windows 网络根因修复结论。

Worker 仅在 `RUNMESH_TEST_MODE=1` 时采集固定阶段与数值，正常请求路径不新增定时器、重试或外部请求。单个 isolate 最多保留 32 个活动项与 16 个最近结束项，导出操作分类、阶段、依赖分类、计数和有界耗时，不保留 URL、凭据、参数、响应正文或请求对象。生产模式保持原有响应路径。测试模式的响应流按下游读取转发，并传播 EOF、错误与取消。

`Server-Timing` 的 total 取样于响应头返回前，最近结束项中的 total 取样于 EOF、取消或错误，两者终点不同。Registry 的 sign/fetch/body 分别观察签名、等待响应头、正文及回执解析；身份核验复用既有 facade，其 fetch 跨度包含签名。上述指标允许阶段重叠，不将各字段相加解释为总耗时。客户端的“等待响应头”还包含服务端首字节准备，不能直接视为网络连接排队。

E2E 对 read、workspace_list、job/get、job/logs 分别保留响应头、正文和完整结果的有限分布样本；四档并发、每档 128 请求、每档 60 秒测试预算和产品请求预算保持原值。只有失败后追加一次独立健康快照请求，单独设置 1 秒截止；该探测属于失败收尾开销，不计入原混合负载。快照描述当前 isolate，缺失或换代均不作为运行时健康证明。

安全日志与补充工件分别计量。补充工件继续执行 65,536 字节上限，先保留源码身份、失败详情与既有运行时事件，再按优先级和并发档位选择新增阶段及耗时记录，明确记录省略数量；主证据本身超限时仍拒绝写入。裁剪使用独立投影，完整安全日志与输入证据保持原样。

Worker 定向验证 4 个文件、252/252 通过、0 跳过，耗时 48.19 秒；涵盖请求隔离、固定容量、生产路径、逐块转发、EOF、取消、挂起读取时取消、取消失败、身份异常和首字节错误边界。工具层 4 套测试为 394 通过、14 跳过，耗时 91.661 秒，日志为 `.audit/mcp-timing-tooling-full.log`；其中已包含此前独立通过的 5 项解析器测试，独立日志为 `.audit/mcp-timing-parser-tests.log`，两组计数存在重叠。工具完整集合运行于容量裁剪修改之前；容量修改随后以 3/3 定向用例验证，包含 579 条事件的极值输入、小工件逐字节一致、主证据超限拒绝。Worker 与容量用例以本轮工具执行回执为证据，未另存日志文件。

本批 TypeScript 检查通过；format 覆盖 1,054 文件，架构检查为 474 模块、2,426 条依赖边、0 环，测试清单为 9 组、261 文件，CI 契约为 26 门禁。文档、runbook 与版本一致性检查通过。这些结果验证观测与证据处理边界；截至该阶段归档时，最近完成的托管 CI 属于候选 `aab0b18`，其 push 成功、PR Windows 三项失败，正式版保持 0.1.7，0.1.8 保持 candidate。

### `d73d909` 的本机源码失败证据

本轮 Windows x64、Node 22.23.2 运行绑定干净提交 `d73d909ea8106efd7374ae3cc9ecdc03dc7bebd9`，源码树为 `ab171416219ab8103e8700760f27a60e5139c60a`。源码 E2E 共 41 项，40 通过、1 失败、0 跳过；wrapper 耗时 265,426 ms，以退出码 1 结束，处于原有 300,000 ms 预算内。本次归档时，该提交尚未推送，托管 CI 状态为 `not_run`，远端 dev 仍为 `aab0b18`；本轮没有签名或正式发布。

唯一失败为 test22 的并发 16 档，分类为 read_initial、HTTP 500、`network_connection_lost`，用例耗时 14,230.952 ms，属于 HTTP 失败而非 60 秒测试超时。此前并发 1/4/8 的 test19–21 全部通过，耗时分别为 24,615.242 / 23,506.334 / 18,546.357 ms。test22 之后的 test23–41 共 19 项全部通过，合计 72,865.460 ms；紧邻的 test23 耗时 23,975.362 ms。失败前 21 项全部通过，合计 87,888.263 ms。后续通过说明测试继续完成，不能反向抹去本次连接丢失。

原始 JSON 的时间字段按 Vitest reporter 实现解释：reporter 初始化至首项测试为 69,131 ms，占 wrapper 的 26.05%；首项至末项测试跨度为 191,938.327 ms，占 72.31%。41 项用例耗时合计 174,984.674 ms，跨度内另有 16,953.653 ms 的组间 hooks 与间隙；wrapper 剩余 4,356.673 ms 同时包含 reporter 之前与末项测试之后的开销。这些字段没有提供每项测试的绝对开始时刻，也不能单独拆出启动与收尾。客户端与服务端阶段样本具有不同起止点和覆盖范围，未覆盖的计时差值不归为 Worker 外部耗时。

安全证据完整保留 216 条 Worker 事件，完整安全日志与工件一致，失败详情和事件均未截断；`worker_event_truncation` 字段未出现，省略数为 0。并发 16 失败后的单次健康快照在独立 1 秒窗口内超时，仅表明该探测未完成。它没有提供活动请求快照，不能据此判断请求未进入 Worker、运行时健康或网络根因，也不据 CPU 使用率作因果结论。

固定本机归档为 `.audit/d73d909-ci/local-evidence-summary.json`，SHA256 为 `d7d13b8144cdb2a06b122313a5556fe2aa8388d17bcb80b936b668a11b34efaa`，状态为 `local_evidence_archived`、`validation_state=failed`。原始文件为 `.audit/source-e2e-d73d909` 的 log/json/evidence.json/gate.json。该归档及 `aab0b18`、`5984ae8` 历史证据保持原样；后续候选按新的源码身份验证。

### `d73d909` 之后的候选修正

后续候选将失败后的单次健康快照窗口由 1 秒调整为 5 秒，保持 32 KiB 正文上限与原失败结果。该调整仅增加失败收尾的观测机会；四档并发、每档 128 请求、每档 60 秒测试预算、300 秒 wrapper 门禁与产品调用行为保持原值。本节改动发生于上述 `d73d909` 归档之后，按新的源码身份验证。

轻量验证 12/12 通过，覆盖快照读取、32 KiB 边界、超限取消、异常、迟到拒绝、原错误保留和独立 5 秒探测超时；未处理拒绝数为 0。驱动与日志分别为 `.audit/mcp-snapshot-probe-tests.mjs`、`.audit/mcp-snapshot-probe-tests.log`。本组结果只验证探测边界；对应完整负载与托管 CI 结果见下节 `0274535` 候选记录。

A12 修正保留原有授权投影、一次请求、5 秒截止、16 KiB 正文与 256 次读取上限。定向验证为 `reauthorization-budget.test.ts` 与 `central-identity.test.ts`，45/45 通过、0 跳过，耗时 15.50 秒；日志 `.audit/reauthorization-lifecycle-tests.log`。独立复核覆盖有效收据、流错误、字节与片段边界、超时和迟到响应的资源清理。Registry 与 RunnerDO 常规等待链的静态审阅未发现输入／输出 gate 循环；该结论不排除存储排队或调度延迟。

随后执行完整 Worker 套件：115 文件、2,488/2,488 通过、0 跳过，耗时 334.77 秒，日志 `.audit/reauthorization-worker-full.log`。该轮在修正工作区执行，构建来源标记为 dirty，属于本机代码回归；完整网络与托管 CI 的后续观测见下节 `0274535` 候选记录。上述 45 项已包含在完整集合内，计数不累加。

A06 的日志解析进一步识别 pinned Wrangler 的固定 `[wrangler:error]` 与 `[wrangler:warn]` 前缀，仍只输出完整固定消息对应的分类，事件上限与字段投影保持原值。新增回归在修正前复现漏解析，修正后与既有生命周期、代理及证据出口回归共 11/11 通过。日志 `.audit/wrangler-runtime-prefix-tests.log`，SHA256 为 `ea635b804311a4076ca7f8c824793e0f1e8efd2dd0207d36d40afdb124ae39c8`。这证明解析缺口，尚无原始日志证据证明 `d73d909` 失败时曾出现被遗漏的该类消息。

本批工具层完整复验包含 verification-tools、package-verification、browser-fixture 与 ci-remediation：399 通过、14 既有条件跳过、0 失败，共 413 项，耗时 97.362 秒。日志 `.audit/reauthorization-tooling-full.log`。该完整集合包含前缀修正和此前容量裁剪测试，专项计数与本组结果分别保留。

### `0274535` 候选的完整观测

候选提交为 `0274535b261ec995ef85903085b391d2bc5d429e`，源码树为 `8c82b4153053424a22eb2e9be1530d912dbfb23a`。本机源码与安装包 E2E 在干净检出上执行。GitHub push 产物绑定候选提交；PR 产物绑定真实合成提交 `42bae438745557a3c8aad1c5c5c5fa14a34d1fff`，GitHub commit API 确认其源码树与候选一致，父提交包含候选。以下托管运行均为 attempt 1，保留原始结果。

| 执行位置与对象 | 结果 | 时间口径 |
| --- | --- | --- |
| Windows 本机源码 E2E | 41/41 通过、0 跳过 | transport wrapper 193,377 ms |
| Windows 本机实际安装包 E2E | 41/41 通过、0 跳过 | installed transport wrapper 251,137 ms；包证据内部 elapsed 246,180 ms |
| push Linux 源码 / 安装包 E2E | 各 41/41 通过、0 跳过 | wrappers 分别 26,074 / 28,517 ms |
| PR Linux 源码 / 安装包 E2E | 各 41/41 通过、0 跳过 | wrappers 分别 39,270 / 41,472 ms |
| push Windows 源码 E2E | 2 项失败、0 跳过；归档直接提供 failed/skipped，passed/total 未保留 | wrapper 194,160 ms，退出码 1 |
| PR Windows 源码 E2E | 41/41 通过、0 跳过 | wrapper 142,214 ms，退出码 0 |

这些执行覆盖同一套或相互重叠的功能，因此分别报告。本机源码归档保存全部 41 项 reporter 原始 duration；包级临时 reporter 由包装器清理，托管安全工件保存投影结果。push 失败包装器仅发布安全失败摘要，本次归档据此保留 failed=2、skipped=0，passed 和 total 不由预期用例清单倒推。用例 duration、混合请求 elapsed 与 wrapper elapsed 使用各自的计时起止点。

[push CI 38221700299](https://github.com/aloneio/runmesh/actions/runs/38221700299) 的 Windows native 在 `Verify Windows MCP transport and Runner recovery` 步骤失败，`verify-all` 随之失败；verify、browser、Linux/macOS native 和两个 Node LTS jobs 均成功。[PR CI 38221706094](https://github.com/aloneio/runmesh/actions/runs/38221706094) 的全部 8 个 jobs 成功。两个运行的 Linux verify 各有 26 个门禁通过，browser 各 5/5、0 跳过。

Windows push 的两处业务观察如下：

| 首错所属负载 | 失败原貌 | 失败时进度与后置观察 |
| --- | --- | --- |
| 并发 4，test index 20 | `job_get` 收到 HTTP 500；正文为 text/non_json，RPC code/id 均 absent，固定运行时签名为 `network_connection_lost`；代理记录 POST、1 attempt。 | 混合阶段 31,659 ms；含作业准备的进度 elapsed 为 32,600 ms，started/completed 为 103/99，pending headers/body 为 3/1。独立 5 秒健康快照超时。 |
| 并发 8，test index 21 | `read` 返回 `registry_unavailable`，分类为 availability，operation_state 为 not_started，next_action 为 wait_and_retry。 | 混合阶段 18,215 ms；含准备的进度 elapsed 为 25,816 ms，started/completed 为 14/6，pending headers/body 为 6/1。后置快照 received，entered=finished=330、dropped=0；16 条 recent 记录均 EOF，active 为空。 |

后置快照在客户端取消并汇合测试请求之后读取，描述的是该时刻的 Worker 观察结果。EOF 表示响应流结束，业务结果仍以工具返回值判定；客户端请求汇合也不证明所有服务端内部 await 已结束。

完整事件中有 4 条控制面 deadline：`mcp_active_runner` 的 body_read 与 fetch 各 1 条，`mcp_registry_post` 的 fetch 为 2 条，status 均为 200。`bounded-json.ts` 在取得响应、保存 status 后检查截止时间，因此 fetch/status=200 表示 200 响应返回时已超过该观察的 5 秒期限；正文阶段的 deadline 可由计时器或读取后的续体检查报告。事件缺少逐请求关联，可能包含前一负载取消后的迟到观察，不能全部归属并发 8。`active_runner` 的期限结果可以解释操作尚未开始时的业务失败；审计 POST 的超时仅追加 audit_status=unknown，不自行改变工具 isError。

再授权分支没有相应失败事件，后置 recent 样本中的 reauth 最高为 2,578 ms。只读 await 链核查显示 Registry 的构造门禁和维护队列依赖自身 SQL/storage，未发现回调 RunnerDO 的依赖边；RunnerDO 等待 WebSocket 回执的路径未持有 `blockConcurrencyWhile`。现有观察未形成可证实的互相等待循环，也未确定新的生产逻辑缺陷。

并发 1 与 16 各完成 128 请求，其混合阶段 elapsed 分别为 24,573 与 31,347 ms。失败工件和完整日志逐项一致，均含 238 条事件：192 条 load_metric、16 条 load_timing、16 条请求阶段、2 条健康快照、2 条负载进度、4 条控制面 deadline、2 条 observer、2 条 native spawn、1 条代理连接丢失及 1 条启动器快照。`worker_event_truncation` 字段不存在，失败详情 `truncated=false`。原生观察器记录 spawn elapsed 2,942 / 3,688 ms；本轮归档没有 exit 或 restart 事件。启动器快照为 exit_code=null、teardown_started=false。缺少 exit 记录不作为运行时持续存活的证明。

上述失败事件整包发布于 job log 的单行 JSON，GitHub 行时间为 `2026-10-12T08:18:52.5003833Z`。它表示包装器发布摘要的时间，各事件顺序及自身相对 elapsed 保留原值，不将该行时间当作逐事件发生时刻。

#### 本机通过结果与生命周期记录

本机源码、安装包混合请求均采用四档并发 1/4/8/16，每档 128 请求，各完成 512 请求。下表为 mixed-request 阶段 elapsed，独立于作业准备及整个用例 duration：

| 执行 | 并发 1 | 并发 4 | 并发 8 | 并发 16 |
| --- | ---: | ---: | ---: | ---: |
| Windows 本机源码 | 18,176 ms | 11,077 ms | 12,066 ms | 12,649 ms |
| Windows 本机安装包 | 14,427 ms | 13,204 ms | 10,768 ms | 10,444 ms |

本机源码通过日志保存 215 条事件，其中包含 native runtime index 1 在 observer elapsed 162,503 ms 以 code 1 退出、`crash_restarting` count 1、index 3 于 162,623 ms 启动。raw reporter 没有逐测试 startTime 或 hook 区间，observer 使用每个 Wrangler preload 的独立时间原点；日志中的最后测试上下文不足以判定事件是否发生于 teardown。该记录与 41 项通过结果一并保留。本机安装包日志保存 212 条事件，记录两次 native spawn，未见对应退出或重启事件。

成功补充工件按既有格式不写 `worker_events`，完整事件从 log 的安全 marker 单独保存。这种格式差异与失败工件的容量裁剪分别记录；字段缺省不计为一条事件。

本机安装包为 1,206,785 字节，SHA256 为 `d3e4b189f58d5de200acae76f0e54531122af3c481f7c4b37dfc864d0320042a`，`signed=false`、`published=false`。包级验证证明该归档的安装和运行行为，正式签名制品具有独立验收记录。

#### 固定归档与发布判定

| 归档 | SHA256 | 归属与结论 |
| --- | --- | --- |
| `.audit/0274535-ci/local-evidence-summary.json` | `c86a0324f3b7a0b67b4617f2d58214b052f6ac47ca5618537c8bb6b9cc0782c8` | 本机源码；41 项原始 duration、215 条事件；passed。 |
| `.audit/0274535-ci/local-package-summary.json` | `862f12a0c783c57191d3e6dd2ca3ad99dbbb8365e096833cf548a336ab3a69b2` | 本机安装包；包哈希、四档负载、212 条事件；passed。 |
| `.audit/0274535-ci/safe-summary.json` | `5b50971dfd0a588962178f7b6e8d72f2e7cc7450f0d39f47dfe3d5bacd97add3` | 托管原始终态与本机摘要引用；state/archive_state=complete，validation_state=failed。 |

原始本机文件逐字复制至该目录的 `raw` 子目录，尺寸和 SHA256 写入各自摘要。托管归档含 6 份 ZIP、push/PR 的 verify 与 Windows 四份必要 job logs、开发 cadence log，以及 5 个运行的完整终态 jobs。PR 合成提交、各工件源码树和 clean 状态均已核对。首份本机摘要中的 CI not_run、pushed=false 明确属于本机归档当时的状态；后续推送与 CI 结果保存在独立记录中。

[main-source-policy 38221706033](https://github.com/aloneio/runmesh/actions/runs/38221706033) 与 [38221715146](https://github.com/aloneio/runmesh/actions/runs/38221715146) 均成功，分别保留。[Dev Runner Prerelease 38221700772](https://github.com/aloneio/runmesh/actions/runs/38221700772) 的 cadence 为 `due=false`、push_number=318、remaining=2、sequence=62；plan、verification、build、publish 均 skipped，工件数为 0。该工作流成功表示本次节奏检查完成。

本候选的发布结论保持阻塞：本机通过与 PR 成功分别证明各自覆盖范围，push Windows 的失败结果仍需新候选完成验收。main 和正式版本保持原状态，本轮未执行正式签名或生产激活。

## Windows 本地运行时组合的独立对照

### 实验来源与准备

本节独立记录 A1、B1、A2、B2 四轮本地对照。A 为候选 `0274535b261ec995ef85903085b391d2bc5d429e`，源码树 `8c82b4153053424a22eb2e9be1530d912dbfb23a`；B 为实验提交 `8f61ffec2ab6ed0a4cf242574e462bfcb9a7a3f2`，源码树 `70e33e96535528714f94fdbe2f4c2d94c3031e0a`。两组跟踪差异只有根 `package.json` 和 `package-lock.json`，应用、测试、配置与观察代码相同。

| 实际依赖链 | A | B |
| --- | --- | --- |
| E2E Wrangler | 4.135.0 | 4.149.0 |
| 对应 Miniflare | 5.20260918.0-alpha | 5.20261006.1-alpha |
| 对应 workerd | 1.20260918.1 | 1.20261006.1 |
| Wrangler esbuild / unenv-preset | 0.28.1 / 2.16.1 | 0.28.2 / 2.16.2 |
| workers-types | 5.20260919.1 | 5.20261006.1 |

根 esbuild 与 Runner 依赖保持原值；Vitest workers pool 0.22.0 继续使用 Wrangler 4.124.0、Miniflare 5.20260815.0-alpha、workerd 1.20260815.1。实际解析路径、锁文件与原生二进制摘要保存在对照归档中。

首个准备序列在 B1 后按可比性规则中止。其 A1 在 Runner 注册 CLI 的 15 秒退出等待中发生 setup 失败，3 项独立测试通过、38 项主套件测试跳过，gate 为 88,260 ms；其 B1 因缺协议 dist 导出入口在收集阶段失败，业务测试为 0 项，gate 为 14,218 ms。A2/B2 未执行。该序列保存在 `.audit/runtime-comparison/comparison-summary.json`，SHA256 为 `c1fcefe0c7a2826524ef0aefe764567d52d6c7f55e22a00aa5655e531d5d2d4f`；这些结果与随后四轮分别计量。

双方随后执行相同的 `npm.cmd run build`，核对协议 dist 的 19 个 JavaScript 文件摘要一致，并验证三个导出入口。新计划在 2026-10-12T10:53:01.6206091Z 冻结于 `.audit/runtime-comparison-built`，采用固定 A1→B1→A2→B2 顺序，在同一 Windows x64 主机串行执行，各轮使用独立 fixture 状态。Node 为 22.23.2，npm 为 10.9.3；每轮计划执行同套 41 项测试、四档并发 1/4/8/16、每档 128 个混合请求。既有每档 60 秒与 wrapper 300 秒预算、断言及重试规则保持原值，四轮结束后没有追加轮次。

### 四轮观察

| 轮次 | 通过 / 失败 / 跳过 | transport wrapper | 混合请求完成情况 |
| --- | --- | --- | --- |
| A1 | 40 / 1 / 0 | 171,399 ms | 并发 1/4/8 各 128 请求完成；并发 16 首错后停止调度 |
| B1 | 41 / 0 / 0 | 163,916 ms | 四档各 128 请求完成，共 512 |
| A2 | 40 / 1 / 0 | 166,530 ms | 并发 1/4/8 各 128 请求完成；并发 16 首错后停止调度 |
| B2 | 41 / 0 / 0 | 148,094 ms | 四档各 128 请求完成，共 512 |

A1、A2 的唯一失败均为 test index 22：并发 16 的 `job_logs` 返回 HTTP 500、text/non_json，固定运行时特征为 `network_connection_lost`。A1 首错进度为 started/completed 76/60，A2 为 46/30；两轮 pending headers/body 均为 15/1。每轮 512 是计划请求数，A 的实际完成量按原始进度保留。B1、B2 各完成全部 512 个混合请求、0 失败，测试计数分别为 41/41、0 跳过。

下表为各档 mixed-request 阶段 elapsed，单位 ms；失败档记录到首错停止时，独立于作业准备和整个用例 duration。

| 轮次 | 并发 1 | 并发 4 | 并发 8 | 并发 16 |
| --- | ---: | ---: | ---: | ---: |
| A1 | 14,727 | 10,809 | 11,023 | 16,616（失败） |
| B1 | 10,180 | 9,050 | 7,684 | 6,532 |
| A2 | 11,961 | 16,447 | 10,882 | 8,742（失败） |
| B2 | 10,579 | 8,898 | 7,397 | 6,902 |

四轮完整安全事件数分别为 242、213、239、212。A 的日志与失败工件事件逐项一致；B 成功工件按既有格式省略 worker_events，完整事件从日志单独归档。失败详情及出口事件均无裁剪标记。A 两轮各有 8 条代理连接丢失事件，达到该类日志的固定上限，数量按观测上限解释。

A1 另记录 native index 1 在 observer elapsed 144,001 ms 以 code 1 退出、crash_restarting=1，以及 index 3 在 144,119 ms 启动。通过的 B1 同样记录 native index 1 在 132,539 ms 以 code 1 退出；A2、B2 的日志记录各两次 spawn。观察器与 reporter 缺少共享时间锚点和 teardown 标记，生命周期事件与测试结论分别保留，现有记录未确定退出事件是否属于收尾或与请求首错存在因果关系。

四轮起止源码身份保持一致，端点 Node PID 集合相同，匹配 fixture 进程数均为 0。端点检查只描述采样时刻；四轮结束时 CPU 样本均为 100%，可用内存和主机负载随时间变化。这些观察保留为实验条件，不用于确定资源耗尽或组件根因。

### 固定归档与判定

四轮汇总为 `.audit/runtime-comparison-built/comparison-summary.json`，SHA256 为 `fdd534a16df49f298c336497d0a641688d37305302f38bf04778b84cacbb9260`，`state=complete`、`validation_state=mixed_outcomes`。归档保存 24 份原始文件摘要、4 份独立轮次摘要、164 个原始用例 duration 和 906 条安全事件；164 是同套 41 项测试的四轮记录，分别引用，不能视作独立功能覆盖总数。

下列文件均位于 `.audit/runtime-comparison-built`：

| 轮次摘要 | SHA256 |
| --- | --- |
| `A1-summary.json` | `06f3baa9515bc55cea6de78e4e45a80e54f9f80f413793e558c70f1584a5a4ff` |
| `B1-summary.json` | `fb551333e281b0abe9079ee7dd3d19cd58294d68c237f81ecd171cfd2d9d1827` |
| `A2-summary.json` | `63883ee23c770f2259d0fd2747bf73e408c4f53e6716d3a41d3e1f872e1857b7` |
| `B2-summary.json` | `b1fca92d2a8242c8f396f49a57d6418804fd9cd1afbc07e12065dea2f4264283` |

冻结计划 SHA256 为 `b3f027b73db4b9afbd746dfbfd6fd7fde95b9fdecc826dfdab259ce21f523c62`，统一构建准备记录 SHA256 为 `a1b7eab69ecbc65acb5eb7fe55f6a487c1e6c6c5b44de0e3ce804e02d0df0feb`。首次中止序列及 `0274535` 的原始本机、push、PR 证据继续保留。

按预先冻结的判定规则，B 两轮完整通过，支持进入工具链升级候选的完整项目验证。该结论限于本机固定序列：ABAB 顺序存在缓存与时间趋势混杂，主机负载也随轮次变化；两轮重复不足以证明低频故障消失。升级同时改变 Wrangler、Miniflare、workerd 及其依赖组合，证据不能单独归因于某个组件。`0274535` 的 push Windows 失败与发布门禁结论保持原样。

### B 的本机补充验证

实验提交 `8f61ffe` 的六文件工具验证为 417 通过、14 项既有条件跳过、0 失败，共 431 项，耗时 180,818.6325 ms。原始日志位于 B 工作区的 `.audit/runtime-validation/tooling.log`。该集合与既有专项有重叠，计数单列。

同一干净 B 身份的 Worker 三环境 dry-run 均通过，原始 JSON 与对应 log 位于 B 工作区 `.audit/runtime-validation`：

| 门禁 | 结果 | 证据 |
| --- | --- | --- |
| worker_default | passed，36,171 ms | `worker_default.json` |
| worker_dev | passed，19,800 ms | `worker_dev.json` |
| worker_prod | passed，20,418 ms | `worker_prod.json` |

B 本机静态及三环境构建门禁共 17 项通过，覆盖工具链、全量与生产依赖审计、类型、文档、CI 一致性、runbooks、版本、格式、架构、测试清单、空白、许可证与发行契约；详细日志独立保存。上述 dry-run 未进行生产部署，签名与正式发布均未执行；正式版保持 0.1.7，0.1.8 保持 candidate。

#### B 的安装包与浏览器入口验证

干净提交 `8f61ffec2ab6ed0a4cf242574e462bfcb9a7a3f2` 的本机 Windows 实际安装包 E2E 为 41/41 通过、0 跳过。`installed_transport` 门禁耗时 235,691 ms，安装包证据内部 elapsed 为 230,676 ms。包大小为 1,206,785 字节，SHA256 为 `d3e4b189f58d5de200acae76f0e54531122af3c481f7c4b37dfc864d0320042a`；与升级前 Runner 包一致，签名与发布状态均为 false。原始记录保留于该 worktree 的 `.audit/runtime-validation/installed-transport.log`、`installed-transport-gate.json` 和 `package-e2e.json`，与源码对照结果分别计数。

随后在 Windows 调用浏览器门禁时，`scripts/run-browser-e2e.mjs:26` 的 Linux 平台要求在 configuration 阶段中止执行，门禁报告 failed、耗时 1,183 ms，浏览器 reporter 未生成。该次准备错误保留在 `.audit/runtime-validation/browser.log`、`browser.json`、`browser-tests.json`，不计为浏览器功能覆盖。新候选按项目规定在 Linux CI 执行浏览器及 guided product 检查；全部托管门禁另按其精确提交验收。

## 工具链候选的托管复验与发布状态

### `bc31153` 的完整 CI

提交 `bc3115372b1e2a3643dd7ed851ad0a7356e807b4`、树 `4320feb2257a41284233b8bfc5c053d05c796bc5` 的 [push CI 38242619138](https://github.com/aloneio/runmesh/actions/runs/38242619138) 与 [PR CI 38242628296](https://github.com/aloneio/runmesh/actions/runs/38242628296) 各 8/8 jobs 成功，均为 attempt 1。PR 实际检出合成提交 `42be44215760611f9f0ac2fbceedab92122e83e2`，源码树与候选一致。

两路 Linux verify 各 26 个门禁通过；Linux 源码、Linux 安装包与 Windows 源码六次 transport 各 41/41、0 跳过。两路浏览器各 5/5，并完成 guided product 检查；Windows Runner 各 1,494 通过、142 平台跳过。Linux/macOS native 和 Node 22.23.2/24.21.0 LTS jobs 分别通过。开发节奏检查为 `due=false`，未产生该候选的开发发布。

完整归档为 `.audit/bc31153-ci/safe-summary.json`，SHA256 `36cbe15115ce1e2595ee810cb46e158f8838dc10f4ccb1eea423ec860ed77f26`。该结果属于本提交，不能替代后续提交的完整验证。

### `6a849a2` 的混合结果

提交 `6a849a2e58c29217ae604c82ef06b174efbd7909`、树 `4d2d8a1334d2ecf38142dced46cd0f648be3ede2` 仅进一步修订四份双语文档：使用公开功能名称、目录预算与恢复链接以及部署检查步骤。相对 `bc31153`，应用代码、依赖、测试、请求次数、超时及并发预算均相同。

| 独立运行 | 原始终态与覆盖 |
| --- | --- |
| [push CI 38244104298](https://github.com/aloneio/runmesh/actions/runs/38244104298) | Windows transport 的 test index 38 断言失败，verify-all 随之失败，其余 6 jobs 成功。Windows Runner 单元测试通过。 |
| [PR CI 38244110481](https://github.com/aloneio/runmesh/actions/runs/38244110481) | 全部 8 jobs 成功；实际合成提交 `70b156f595688c2906bedea5dda3a4e4a7ee3b58`，树与候选一致。 |
| [source policy 38244110451](https://github.com/aloneio/runmesh/actions/runs/38244110451) | cancelled，尚未分配 runner，steps 为空；时序与同 PR 并发替代一致，API 未给出取消操作者。 |
| [source policy 38244112436](https://github.com/aloneio/runmesh/actions/runs/38244112436) | 后续 PR 描述编辑触发，成功；取消记录单独保留。 |
| [开发预发布 38244105039](https://github.com/aloneio/runmesh/actions/runs/38244105039) | attempt 1，12 jobs 全部成功；按节奏实际发布 `v0.1.8-dev.63`。 |

push Windows 的 transport 门禁耗时 129,897 ms，工件报告 1 项失败、0 跳过。失败位置为 `test/e2e/mcp-runner.e2e.test.ts:1138`：停止真实 Runner 并等待既有 200 ms 后，单次读取应得到 `runner_offline`。其并发 1/4/8/16 的混合负载均通过，各完成 128 请求，共 512；四档 mixed 阶段分别为 20,373 / 10,773 / 9,334 / 6,257 ms。

该失败日志与工件的 214 条安全事件逐项一致，未截断；包括一条 `mcp_active_runner`、`deadline`、HTTP 200、`phase=fetch` 事件，192 条负载指标、16 条负载计时、两条观察器记录、两条 spawn 与一条 launcher 快照。未记录 native exit、restart 或代理连接丢失。工件没有保存失败断言收到的实际值，也没有把这条控制面事件关联到某个测试请求，因此不能确定该断言实际收到 `registry_unavailable`。

静态复核确认：`boundedJsonReceipt` 会在 fetch 返回后、读取正文前检查总期限；超过 5 秒时，`registryCall` 返回 `registry_unavailable`、`not_started`。只有取得有效选择收据后，`resolveActiveRunner` 才能报告 `runner_offline`。该区分符合现有语义。Runner 断开通过独立的 WebSocket/Registry 通知链传播，200 ms 延时本身不证明远端完成；现有证据也没有证明该传播链失败。复核未找出可归因于本次失败的确定性应用修复点。

失败后补充了 test 38 的安全诊断：在原断言消息中加入固定 `runner_disconnect` 阶段及白名单错误字段；原 200 ms 等待、单次请求、`runner_offline` 期望与所有预算保持原值。投影回归验证实际错误码能进入失败工件，正文、消息、路径及任意 details 留在私有范围。该改动修复证据缺口，不构成网络问题已解决的结论。

| 固定证据 | SHA256 |
| --- | --- |
| `.audit/6a849a2-ci/safe-summary.json` | `815693cdf13d18ff555ada083cf8d2d61763d16dc755daf60530971790c2db87` |
| `.audit/6a849a2-ci/push-windows-failure-summary.json` | `f1c745559b48f630095655528e7f15e12c1265fb3d82879c187a6460b05a5db9` |
| `.audit/6a849a2-ci/dev-prerelease-summary.json` | `9814b7d2c595a49395223a66ea4d78e167db997c1a16c9c6fd48f6b121b52bf2` |
| `.audit/6a849a2-ci/disconnect-static-review.zh-CN.md` | `811499a83846d6d2f70d62a0220bae6e0d81ec4fc4cb9dcdb7f295e3e07a6130` |

### 断线诊断补丁的单次本机验证

在运行前冻结一次完整源码 transport 计划，保留 41 项测试、四档并发共 512 个计划请求、既有 30 秒普通用例/60 秒负载/300 秒 wrapper 预算。计划 SHA256 为 `2f64d5d7a6a5aa0755e675272261e676e81289566be89fb9b46cf90967634825`。执行来源为 `6a849a2` 加诊断与报告修改的 dirty 工作树，七个相关文件的前后哈希一致；它不是原 clean CI 的补跑或替代结果。

本机 Windows、Node 22.23.2/npm 10.9.3 的单次结果为 41/41、0 跳过，门禁 124,844 ms；test 38 通过，耗时 634.503 ms。四档各完成 128 个请求，共 512。归档保存 214 条事件，其中 native index 1 在 observer elapsed 104,916 ms 以 code 1 退出，并出现一次 `crash_restarting`；没有后续 spawn 记录。观察器与测试收尾缺少公共时间锚点，暂不将该事件解释为收尾或指定为应用故障。

完整摘要 `.audit/runner-disconnect-source-once/summary.json` 的 SHA256 为 `ad752f06f4d80a219a7860458fb6ff937d1571aaddd17eff6297e776bbc7e77f`，包含冻结计划、源码文件摘要、原始日志/私有 reporter/门禁文件的哈希、41 项用例时间及完整安全事件。该计划只执行一次，没有追加本机轮次；结果说明诊断补丁下这次功能验证通过，原托管失败及根因未确定的结论保持不变。

### 发布判定

[开发预发布 v0.1.8-dev.63](https://github.com/aloneio/runmesh/releases/tag/v0.1.8-dev.63) 为公开、immutable 的 prerelease；独立读取 annotated tag 确认绑定 `6a849a2` 与对应源码树，并验证九个公开资产的摘要、manifest Ed25519 签名及 SHA256SUMS。开发预发布的通过结果与独立 push CI 的失败分别保留。

0.1.8 正式签名发布和生产激活尚未执行。当前候选的完整验证仍有阻塞，因此没有提升受保护 main、改写发行状态或套用待发布文档。后续需要先取得失败请求的完整安全分类并完成有依据的修复，再按项目流程验证精确候选、双端 main、正式资产和线上激活。所有历史失败继续保留；用户 docs 维持当前使用说明，调查事实集中存放于 reports。

## `a455499` 诊断提交的完整托管验证

诊断及上述工程记录已提交到 GitHub `dev`：`a4554990080830b9d4086fe838b53e857e3fca3c`，树 `fb8b243172d6700356df4b9595178d39a59dd93d`。应用代码与依赖保持 `6a849a2` 的值；改动限于三个诊断/测试文件和两份工程报告。类型、docs、格式、runbooks 与空白检查通过。该提交按计划执行一轮原 attempt 1 的 push/PR CI，没有重跑或取消任一路完整 CI。

| 独立运行 | 最终结果 |
| --- | --- |
| [push CI 38247797192](https://github.com/aloneio/runmesh/actions/runs/38247797192) | 8/8 jobs 成功。Windows transport 41/41、0 跳过，门禁 122,529 ms；四档共 512 请求全部完成。 |
| [PR CI 38247804514](https://github.com/aloneio/runmesh/actions/runs/38247804514) | Windows transport `timed_out`、verify-all 失败，其余 6 jobs 成功。实际合成提交 `17a16ea4ff1dc95c99902a60fcab3a298c89e065`，树与候选一致。 |
| 两路 Linux verify 与浏览器 | 各自 26 个 verify 门禁通过；源码/安装包 transport 各 41/41、0 跳过，浏览器及 guided product 检查通过。 |
| 两路 source policy | 原同步及描述编辑触发的检查分别成功。 |
| 开发节奏检查 38247797671 | run 321，`due=false`，remaining=4；cadence 成功，其余四项 skipped，工件为 0，本轮未发布新包。 |

push Windows 的四档 mixed elapsed 为 15,007 / 10,853 / 7,083 / 4,951 ms，完整日志保存 212 条安全事件；未记录 native exit、restart、控制面失败或代理连接丢失。它与 PR 的失败分别计量。

PR Windows 的门禁记录为 301,377 ms：原有 300,000 ms wrapper 到期后终止测试进程，`report_available=false`，因此没有最终通过/失败/跳过计数，也没有 test 38 的实际错误码。不能把四档计划的 512 请求写成已完成。首错前的原始负载进度如下；这些快照不等于收尾后的完成数。

| 并发 | first-failure operation | started / completed | 首错时 elapsed | pending headers / body |
| --- | --- | --- | --- | --- |
| 1 | job_get | 127 / 126 | 60,021 ms | 1 / 0 |
| 4 | read | 104 / 100 | 60,005 ms | 4 / 0 |
| 8 | workspace_list | 78 / 70 | 23,461 ms | 7 / 1 |
| 16 | job_get | 89 / 73 | 16,199 ms | 15 / 1 |

完整 job log 保存 296 条安全事件；工件受既有大小边界保留其中 199 条，明确标记省略 97 条，二者保留顺序及字段投影已逐项核对。记录有 8 条代理 POST connection-lost 事件，达到该类固定上限；没有控制面失败事件。由于最终 reporter 未生成，具体首错的 HTTP/结构化结果分类仍缺失，不能用代理事件替代某次请求的实际返回值。

四档失败回调快照均取得响应：并发 1 的 entered/finished 为 208/208、active 为空；并发 4 为 314/312，active 是 `job_get` 的 action（676 ms）和 identity/fetch（1 ms）；并发 8 为 393/391，active 的 `job_logs` 与 `job_get` 均处于 action、各 985 ms；并发 16 为 475/475、active 为空。各档 recent 16 条均为 EOF。快照由失败回调采集；测试超时路径没有等待底层负载的汇合完成，也没有对应完成标记。缺少与首错请求的关联标识，EOF 不代表业务成功，active 项也不能据此认定为首错或死锁。

限定范围的独立静态复核检查了 Windows native job 的前置测试及进程回收，没有找到可证明的正常成功路径持久 subprocess/workerd 遗留。该结论不是动态泄漏证明，也不覆盖全部第三方内部行为；`inherited_pipe` 夹具的清理只发出 kill 而未等待退出，作为保证弱点记录，没有证据证明其跨后续步骤存活。没有据此修改生产逻辑或预算。

| 最终证据 | SHA256 |
| --- | --- |
| `.audit/a455499-ci/safe-summary.json` | `4a149e9dad188b3be4504f0154f4d3e2e5a6261ea2710d354499c3e6bf33d303` |
| `.audit/a455499-ci/pr-windows-failure-summary.json` | `e913c4ade4e7cfb437089db7772b676ee54c89f5883c69d24ca9bb536d2385f5` |
| `.audit/a455499-ci/dev-prerelease-summary.json` | `dc9a3d2f8fb3c4bbd9c9787cbb89c5928fe739d993b2ad7a3519394d8ec7a233` |
| `.audit/a455499-ci/pre-transport-resource-review.zh-CN.md` | `fea96e52a952087cad19564776c9e13d607f565a73eb488b29fd488cf0ee9f27` |

### 本轮终审状态

本轮工程修正、用户文档整理、检查书及各阶段验证记录已经落地；正式发布条件尚未满足。确定的阻塞是 Windows 真实网络压力门禁未通过，根因尚未建立。保留原有期限、请求数、断言、分支保护和完整失败记录，未以通过的 push 结果覆盖 PR 超时，也未继续追加跑次。

2026-10-12T12:21:32Z 对生产环境的只读核验确认：`/health` 的 `ok=true`，部署为 `main`、`a18f3c015740458cfc90ce9b6c1626580937e6b9`、干净来源且 provider 身份匹配；测试模式关闭。`/runner/releases/stable` 的 current/latest 均为 0.1.7、`distributable=true`。原始观察 `.audit/production-status-20261012.json` 的 SHA256 为 `6fbabf8b848d109f2eb093a75328fdb2a99502746ca03cf519a8f6a554bc10a9`。

两端受保护 main 保持原提交，GitHub dev 为 `a455499`，GitLab dev 保持 `0274535`。PR 118 与 MR 59 保持未合并状态。0.1.8 正式资产、发行状态更新及生产激活没有执行；四份发布后用户文档草稿保留为未应用状态。本节是测试结束后的工程记录，所列 CI 源码身份固定为 `a455499`，不把后续报告编辑冒充已执行的代码验证。

## 后续修复记录：测试生命周期与同步预检

本节记录 2026-10-12T13:24Z 时的后续工作，来源为 `aebf4e2d020cb2c110df0437cd9b9ede81425f31` 加本轮修复的 dirty 工作树。前文各轮终态继续归属于其原始提交和执行时间；本节的定向结果不覆盖历史失败，也不替代新候选的完整验证。

### 已复现的测试清理乱序与修复

使用实际 Vitest 4.1.11、Node 22.23.2 的隔离探针，旧实现记录了 `signal_abort → body_cleanup_begin → onTestFinished → onTestFailed → scope_end → next_test_begin → restore_rejected → raw_body_settled`。测试超时后，失败回调与下一测试已开始，原始测试函数的清理仍未结束；恢复请求沿用已取消的业务请求信号而被拒绝。观察文件 `.audit/http-lifecycle-repair/before-events.json` 只记录到 `/held`，没有恢复请求。这是已复现的测试生命周期缺陷，尚未建立它与最初单并发 60 秒超时之间的因果联系。

修复由 `trackTestBodies` 追踪 Vitest 超时包装之下的完整测试函数，`afterEach` 在既有 30 秒 hook 预算内取消业务请求并等待函数结束。queue、busy、job sharing 和 history 模式恢复使用显式清理作用域，恢复完成后原业务续体仍保持取消状态。若内部清理或 Vitest hook 先触及期限，共享夹具进入隔离状态，后续测试函数不会继续使用未清理的夹具。实际 Vitest 回归确认恢复先于 finished/failed 回调及下一测试，且 hook 超时路径保留原始测试超时并阻止下一业务函数执行；两条路径均无未处理拒绝。

### 减少正常请求的重复 Registry 往返

`workspacePreflight` 将当前 workspace 权限与策略就绪信息合并到一次已签名的 `effective-permissions` GET 中。Registry 路由在同一同步执行段先读取权限，许可成立后再读取 readiness；拒绝权限仍优先返回，缺失或异常收据保持失败结果，不新增缓存或降级读取。在线 read、job/get、job/logs 的对应路径各减少一次 Registry 往返；workspace 列表和离线 Job 快照保留原有读取与权限语义。

独立代码复核确认，合并预检后的 `authorize-rpc`、RunnerDO 最终 `mcp-authorization`、连接身份校验、nonce 与审计链均保留。回归在合并收据返回后撤销 workspace 权限、撤销或轮换客户端凭证、收缩 scope，均确认没有 RPC 派发。该优化减少了确定存在的重复请求，不能单独证明历史网络首错已解决。

### 首个失败的分类保全

补充 `request_failure` 与 `test_failure` 白名单事件：仅在 `mcpMessage` 已抛错的 catch 和 mixed-load 的 `onFirstFailure` 回调同步写入 stderr，原异常继续原样抛出。事件只保存固定错误类别、经过现有解析器重新投影的 HTTP/RPC 与工具结果分类；预期返回的 `isError` 不自动视作测试失败。每类独立保留首条，不依赖最终 JSON reporter。定向回归实际终止超时子进程，确认 `report_available=false` 时仍有安全分类，且没有虚构测试计数或输出原始正文、路径与错误消息。

本轮保持 41 项源码 E2E、并发 1/4/8/16 各 128 个计划请求、原 30 秒普通测试/60 秒负载/300 秒 wrapper 预算、断言与重试规则。首错事件的新增范围限于上述两个失败边界；没有扩展为全测试关联追踪。

### 定向验证与结论边界

| 独立验证 | Node 22.23.2 结果 |
| --- | --- |
| Worker 七个相关测试文件 | 386/386 通过，分两组 256 与 130；覆盖权限链、预检错误、MCP 输入与 Job 集成。 |
| Registry route domain | 65/65 通过。 |
| HTTP 生命周期与实际 Vitest 集成 | 17/17 通过，0 跳过、0 取消，20,340.6564 ms。内部 8 用例成功夹具与 2 用例预期失败隔离夹具不重复累加。 |
| 首错投影与缺 reporter 的超时归档 | 3/3 通过。此前默认 Node 24.19.0 的早期三项尝试也通过，单独保留运行时归属。 |
| Worker TypeScript 构建检查 | `tsc -b apps/worker` 通过。 |

生命周期定向日志为 `.audit/http-lifecycle-repair/targeted-final.log`，SHA256 `14caa610a0c9766e5611872e16c0ffd3a7491773b487bfba2f0b0999b64e6e83`；完整收据 `.audit/http-lifecycle-repair/verification.json` 的 SHA256 为 `1cca0784c87d884761c8512d9eb7e10f50ce4ce952a30cb6150e79a2f5a3355b`，保存基线、运行时、源码摘要及前后事件。各集合单独计数，完整套件随后仍可能覆盖同一用例。

运行时静态审查确认，ProxyWorker 的固定 POST connection-lost 日志来自本地代理向 UserWorker 的 fetch 失败；测试端正常 MCP 正文完整消费，非 200 响应的诊断读取有界并取消 reader。最新失败归档没有 native exit/restart 事件，既有本机退出记录又缺少与 teardown 的公共时间锚点。当前证据未建立 Node 连接池、workerd 退出或代理队列中的单一根因，未据猜测调整连接池、重放请求或放宽预算。

本轮完整 Worker、资源隔离对照和源码 E2E 的实际结果见下一节；本节定向结果继续按原集合计数。

## 本轮完整复验记录（2026-10-12T13:51Z）

### 默认完整 Worker 的实际失败

按原命令 `npm run test --workspace=@aloneio/runmesh-worker` 执行的默认三运行时完整套件自然结束：Node 22.23.2、Vitest 4.1.11，115 个文件中 114 通过、1 失败，2,504 项测试中 2,503 通过、1 失败。Vitest 耗时 603.32 秒，命令总耗时 612,624 ms，退出码 1；未手动终止，没有 termination 记录。

唯一失败位于 `apps/worker/test/mcp-client-lifecycle.test.ts:205`，检查列表页和详情页的本地化撤销/删除操作，参数 `computer access=true`。该用例耗时 10,123 ms，管理页实际 HTTP 503、期望 200。原日志没有保存本次失败的具体页面/语言组合或 503 依赖分类，当前不将其归因为同步预检、主机资源或某一运行时。定向 386/386 Worker 结果与本次完整套件分别保留。

### 单次资源隔离对照

默认失败后，冻结计划 `.audit/transport-repair-20261012/plan.json`，SHA256 `33a8992dd2d44815a6e747c536b87be6ae5c5297a99b6c6d93b979fda8960132`。计划记录 `aebf4e2` dirty 来源、20 个文件摘要，并对两个后续 lane 的执行前后校验相同指纹；每个 lane 仅一次，原始结果独立保存。

`worker_serial` 覆盖原 115 个 Worker 文件，使用 `--maxWorkers=1 --no-file-parallelism`，保留 30 秒测试/hook 预算，进程期限为 600 秒。该对照于 2026-10-12T13:34:04.371Z 开始，600,792 ms 后触及进程期限，退出码 1、`termination_reason=timeout`。最终 reporter 未生成，`report_available=false`，不补写最终通过/失败/跳过计数。改变文件并行方式的本机对照明确 `ci_equivalent=false`，其超时与默认配置的 2,503/1 结果分别记录，不据此确定资源因素是根因。

### 单次源码 E2E 的准备阶段失败

`source_transport` 于 2026-10-12T13:45:28.522Z 开始，外层归档总耗时 66,944 ms、退出码 1；内部 transport 门禁耗时 65,595 ms、状态 `failed`，没有触及原 300 秒期限。私有 reporter 可用，41 项中 3 通过、0 测试断言失败、38 跳过。主测试组发生 suite 级准备失败；安全摘要记录 1 个失败文件，原 reporter 的 `numFailedTestSuites=2` 保留其自身统计口径，不能与失败测试数混用。

主夹具已经通过 Worker 健康准备及管理端建号/Enrollment code 创建。在 `test/e2e/mcp-runner.e2e.test.ts:230` 等待 Enrollment CLI 退出时，原 `waitForExit(enrollmentCli, 15_000, ...)` 到期。安全投影中的 `:1518` 是该通用等待函数的定时失败分支；`scripts/worker-fixture.mjs:98` 是包装层接收测试子进程非零退出的位置。本次应归为 Enrollment CLI 准备阶段退出等待失败，不写作 Worker 健康检查失败或混合请求首错。

独立 SQLite session 测试组实际完成的三个用例如下，索引与时间来自私有 reporter：

| 测试索引 | 已通过的行为 | 耗时 ms |
| --- | --- | --- |
| 39 | 乱序 sync 保持连接，并隔离同凭证替换后的旧 session | 397.960 |
| 40 | Runner 发起带状态码的正常关闭握手 | 130.488 |
| 41 | Runner 发起不带状态码的正常关闭握手 | 185.364 |

原主测试组的 38 项因准备失败跳过，四档混合负载均未进入执行，512 仍为计划请求数。安全事件有两条 observer installed、两条 native spawn（elapsed 15,468/21,371 ms）和一条 `setup_failed` launcher 快照；快照中 launcher 退出码/信号为 null，teardown 尚未开始。日志、summary 与复制的 transport 工件按安全字段核对，事件来自 `safe_wrapper_failure_summary`，不把事件缺席解释为组件健康证明。

| 本轮证据 | SHA256 |
| --- | --- |
| `.audit/transport-repair-20261012/worker-full.log` | `ccf5a4f1f33b554036815f86ef11b569ed91bafc5e6f401cd6a09e91daa29c6f` |
| `.audit/transport-repair-20261012/worker-full-execution.json` | `8da538d0932adda15fdee729797a76323240deea06d26dd1ee44fcea0b3926f5` |
| `.audit/transport-repair-20261012/worker_serial-summary.json` | `ab9688ea3acfa985e21dc5aa60566dda435f2aca8a86786b8bc02d5ed28f71ab` |
| `.audit/transport-repair-20261012/source_transport-summary.json` | `8a68c135057945831287d130a2f86d33a49e8399fde7a6bfec21116357ba8785` |
| `.audit/transport-repair-20261012/transport-tests.json` | `40a44eefea428a4df214ae8927ffb6a8699d6d6d601736fee959b3f79e57e47c` |

本次记录在两个冻结 lane 均结束后追加，报告编辑不冒充其执行时的原文件摘要。默认 Worker 503、单运行时超时和 Enrollment CLI 准备失败的调查继续进行；后续确定性修复及验证按新的源码状态另行记录。

## 入口与夹具修复后的单次完整验证（2026-10-12T14:12Z）

### 两项新增修复及探针精化

Enrollment CLI 的可执行入口原先静态加载完整 `cli` 模块，使注册命令在发出首个 HTTP 请求前也初始化 supervisor、connection、runtime、jobs 和 update agent 等依赖。入口现先检查 Node 版本，再按命令加载：help/version 直接输出既有文本，enroll 只加载原注册实现，其余命令继续委派原 `runCli`。公共导出、stdin 读取、错误去重及退出码语义保持原值。七项新回归在真实 Node 子进程中执行入口并观察模块加载，覆盖长短 help、version、两种注册错误、普通命令委派和不受支持的 Node 版本；独立复核同时检查了 CJS 打包结果。

原 Enrollment 退出等待使用 `Promise.race`，成功后仍留下期限定时器，超时路径也没有自行回收子进程树。新增 `waitForFixtureExit` 在正常退出、已退出和 spawn error 路径清理监听器与期限；超时先保留原始失败，再执行既有有界进程树终止，诊断函数或清理失败也不会把超时改成成功。Enrollment 句柄改由 suite 持有，收尾通过 `allSettled` 尝试停止 Enrollment、Runner 和 Worker，保留全部停止失败。原 15,000 ms 注册等待保持不变。

实际 Vitest 生命周期探针进一步消除调度偶然性：`beforeEach` 先取得已打开的 `/held` 正文，再开始原 100 ms 人工超时；清理通过由 `afterEach` 释放的明确屏障汇合，替代固定 sleep。隔离探针的 50 ms 期限只作用于目标 `afterEach`，其余准备及收尾 hook 使用 5 秒预算。该调整只作用于探针，产品 E2E 的 30/60/300 秒预算保持原值。精化后的 17 项全部通过，实际顺序仍为清理结束先于 finished/failed 回调及下一业务函数，隔离路径仍阻止后续业务进入，两条路径均无未处理拒绝。

一次隔离注册对照中，旧入口首个 HTTP 为 3,716 ms、退出为 3,854 ms；新入口分别为 3,428/3,552 ms。两次均在原 15 秒内成功、各发出一次请求、保存 profile，输出未含凭证。单次样本用于确认行为与记录启动阶段，不据此宣称显著性能提升或重现此前注册超时。

| 验证集合 | Node 22.23.2 结果 |
| --- | --- |
| 精化后的 HTTP 生命周期与实际 Vitest 探针 | 17/17 通过，0 跳过，12,666.8725 ms。 |
| 受控 fixture 退出与后代进程回收 | 4/4 通过，0 跳过，4,383.6273 ms。 |
| Runner product | 134 通过、4 项既有平台跳过；其中包含上述新增 7 项入口回归，不另行累加。 |
| 安装包 smoke | 自包含 Runner 0.1.8 打包通过。 |
| 根项目类型与验证清单 | typecheck 通过；验证清单仍为 261 文件、9 组，七个 lane 收集通过。 |
| 文档、格式与架构检查 | 通过。 |

### 新冻结计划与完整源码压力结果

新计划 `.audit/transport-followup-20261012/plan.json` 于 2026-10-12T14:10:07.079Z 冻结，SHA256 为 `be0b9284403577b15bcc24c78833f56a7e180cf2c8c3bb01da7b236302b8dddf`。来源是 `aebf4e2d020cb2c110df0437cd9b9ede81425f31`、树 `d15f5a8b99dc8704ec2bd11b9d6716a0956aed16` 加本轮 dirty 修改，记录 23 个文件摘要；执行前后校验通过。每个 lane 仅一次，保留原测试清单、并发、请求量、断言和期限。

Windows x64、Node 22.23.2 的 `source_transport` 于 14:10:08.792Z 开始，外层耗时 111,448 ms、退出码 0；内部 transport 门禁耗时 110,768 ms。41/41 测试通过，0 失败、0 跳过、0 TODO。每档 read、workspace_list、job_get、job_logs 各完成 32/32 请求、0 失败；四档合计完成 512/512 请求。

| 并发 | 实际完成请求 | 混合负载 elapsed ms |
| --- | --- | --- |
| 1 | 128/128 | 9,336 |
| 4 | 128/128 | 7,377 |
| 8 | 128/128 | 6,766 |
| 16 | 128/128 | 7,226 |

日志保存 212 条安全事件：2 条 observer、2 条 native spawn、16 条 operation timing 和 192 条 metric；本次未记录 native exit/restart、代理连接丢失或首错事件。这些是本次执行的观察范围，不外推为所有运行环境的健康证明。

| 新增证据 | SHA256 |
| --- | --- |
| `.audit/http-lifecycle-repair/probe-determinism-targeted.log` | `f7321d681b7088986ac7295feaca72e3e376074dfa8f404bd57efe8628bb8021` |
| `.audit/http-lifecycle-repair/enrollment-fixture-verification.json` | `c0a59ac89a41f2a462920099faf907e05c94a6f481ce64bea38bbc06a1819e5e` |
| `.audit/transport-repair-20261012/runner-product.log` | `032e7d4ef156239912d8e517d599f33ea7b13b4b881243824b6a7cfa3184f7a8` |
| `.audit/transport-repair-20261012/pack-followup.log` | `25ac358a0dc10a86e98506f94a17b627a27fb70a759caef97d98f22a860a504a` |
| `.audit/transport-followup-20261012/source_transport-summary.json` | `193e45816ef2d4dec688a601031506579ccbbbb9dbf1c7f81c340574890a799d` |
| `.audit/transport-followup-20261012/source_transport.log` | `842b8eeaafd21567cb408e26f497116eb4d5b4e419e96610986ca02422733888` |

本轮建立并修复了可验证的测试隔离、恢复顺序和进程等待清理缺陷，去除了注册入口的无关依赖初始化与在线预检的重复往返。此前默认 Worker 503、单运行时超时、注册准备失败和 `a455499` 托管 Windows 首次负载超时各自保留原始证据；本次本机通过不将这些不同现象合并为一个已证明的根因。后续以新干净候选的两平台完整托管 CI 验收，正式版本签名、受保护 main 提升和生产激活按对应门禁另行记录。当前追加的是完整测试结束后的报告文字，其新文件摘要不回写到原冻结计划。

## `73d7309` 托管验收与认证回执修复

候选 `73d7309c72d27b17c221f574aa1f2b7fb4e2e1c1` 的树为 `c1fe3b231b32e43f017c5c523d1333d6fdddb08c`。GitHub Push CI [38262421966](https://github.com/aloneio/runmesh/actions/runs/38262421966) 首次执行 8/8 job 成功。PR CI [38262430118](https://github.com/aloneio/runmesh/actions/runs/38262430118) 首次执行 6 个实质 job 成功，Windows job 与汇总 job 失败。PR 实际执行的合成提交为 `4b3b1e48637dfd30ac2d1b35b32bfa4568e2dc19`，其树与候选相同；两个执行身份分别保留。源码策略检查通过。失败的 PR 门禁继续阻止正式提升，没有对原 SHA 重跑 CI。

两次 CI 各 8 个 job 日志及 verify、Windows、browser 工件均已下载，校验 provider ZIP 摘要、展开后完整文件集合与逐文件摘要；归档摘要均为 `archive_state=complete`。证据目录为 `.audit/73d7309-ci/`，原始 run/jobs 响应和下载收据采用独立文件保存。完整归档表示证据完整，不表示失败检查已经通过。

Push Windows 源码 E2E 为 41/41 通过、0 跳过，transport 耗时 114,280 ms。四档混合负载均完成 128/128 请求，各档 read、workspace_list、job_get、job_logs 分别为 32/32；并发 1/4/8/16 的耗时分别为 37,439/11,164/7,465/6,218 ms。两次 Linux verify job 均通过其完整 Worker、源码 E2E、安装包 E2E 与其余门禁。

PR Windows transport 在 21,969 ms 结束，主测试组在 `test/e2e/mcp-runner.e2e.test.ts:1183` 的首次 `POST /setup` 状态断言失败。前一个 setup 页面 GET 已返回 200 并完成正文读取；随后 POST 已取得 Response，状态不等于 303，但旧投影没有保留实际状态。该失败是 suite 准备错误，38 项主测试跳过，混合负载尚未执行；独立 SQLite session 组仍执行了 3 项。安全事件记录了两次初始 native spawn 和一次 POST proxy connection lost，launcher 在 teardown 前仍无退出状态。此记录与此前 Enrollment CLI 15 秒退出等待失败分别保留。

多角度静态审查确认：根 Wrangler `4.149.0` 实际解析到自身嵌套 Miniflare `5.20261006.1-alpha` 和 workerd `1.20261006.1`；单元测试池的另一组依赖不参与源码 E2E。正常 Miniflare 配置更新会 dispose 并重启 native 进程。构建 provenance 与自定义构建在夹具启动前完成，没有找到 setup 期间写入监视目录的路径。PBKDF2 的 Promise 属于当前调用，HMAC 缓存保存已完成的 CryptoKey。当前记录尚未建立这次代理断连的单一根因。

### 已证实的状态回执生命周期缺陷

认证限流 `/auth/throttle/record` 的契约为无正文 204，调用者却使用只接受 200 JSON 的读取入口；正常 204 因此进入异常完成分支，随后中止已取得完成回执的请求。修复改为显式接受 204，并在通用有界读取器确认状态、正文为空、长度、父取消和期限后正常完成。失败和迟到响应继续释放正文并取消传输，5 秒预算保持不变。

定向 Worker 验证 58/58 通过（两个文件，7.09 秒），独立 TypeScript 检查通过。新增 9 项覆盖正常完成后信号、异常状态正文释放、忽略取消的上游、迟到回执及父请求中止。日志为 `.audit/73d7309-ci/worker-status-receipts.log`，私有 reporter 已保留到根私有目录 `.audit/73d7309-ci/worker-status-receipts-private.json`。

独立内存对照直接读取原提交与修复源码，分别使用其真实调用形态：原调用取得 204 后发生 1 次 abort，修复后取得相同 204 且 abort 为 0，两侧均只发起 1 次调用并保留原 5 秒期限。收据 `.audit/73d7309-ci/receipt-before-after.json` 保存源码摘要及结果。该探针只验证已完成回执的取消行为，不冒充托管断连复现；早先两次探针构造错误（TypeScript 7 编译 API、旧调用形态）也分别保存。

### 失败证据补全

setup/login 的页面和提交各自接入既有有界安全诊断，失败时记录固定阶段、HTTP 状态、内容类型和已知运行时签名；正文、cookie、凭证及自由文本不进入公共工件。Wrangler 的两种固定 reload 日志采用完整白名单匹配，按顺序保留前 16 个转换，与 crash/native 事件分别限额。原断言、业务期限和请求次数保持原值。

相关定向 Node 22 测试 15/15 通过，耗时 708.5444 ms。首轮新增测试的大小写样本构造错误及修正后的验证均已保留，见 `.audit/73d7309-ci/setup-reload-diagnostics-verification.json`。诊断覆盖的增加用于缩小后续失败的位置，不作为根因已修复的证据。

### 相邻响应所有权检查

沿状态型回执调用链继续检查并修复：setup 非 204 的 Registry 响应先释放正文再记录失败；login 创建 session 的 409 响应统一经过清理分支；开发版本缓存写入只在成功 204 后正常完成，其余结果保留原 5 秒单次写入与取消规则；Runner enrollment mutation 的释放明确接受 204，409/503 的诊断白名单保持原样。凭证、Cookie、回滚和最终授权状态没有扩大。另一 agent 独立检查五个源文件和四个测试文件，未发现阻断项。

Node 22 的六个关联 Worker 文件串行执行 287/287 通过，0 跳过，70.39 秒；其中包含先前 58 项，分别列出结果而不累计为独立总数。集合为 dev-runner-distribution 168、enrollment-fence-recovery 29、setup-hardening 10、control-plane-receipts 50、runner-action-responses 22、http-observation-cost 8。Worker 独立类型检查 2.49 秒通过，根项目 typecheck 也通过。新增认证清理测试以实际 HTTP 完成和仍待释放的清理门闩验证行为，不通过推进虚拟时钟推断密码派生已经结束。证据为 `.audit/73d7309-ci/worker-status-lifecycle.log` 及同名前缀的私有 JSON、typecheck 日志。

继续沿注册调用链确认并修复了两个异常回执的正文所有权遗漏：fence 失败返回前释放响应，取消 mutation 的结果在状态判定前释放响应。两处都采用非阻塞取消，状态、Cookie、凭证提交和回滚次序保持原样。既有 enrollment-fence-recovery 文件增加 7 个内存回执场景，最终单文件 36/36 通过、0 跳过、30.19 秒；既有 29 项与前述集合重叠，单独记录。该补丁通过另一 agent 的独立复核，证据为 `.audit/73d7309-ci/worker-enrollment-receipts.log`、同名前缀私有 JSON 和 `-hashes.json`。

### 健康探测完整完成后交接夹具

原 `waitForWorker` 收到成功健康响应头后直接取消正文，随后又中止整次探测。固定 Node 22.23.2 内置 Undici 6.28.0 的实现确认，未完成正文的取消会进入 fetch abort 与连接终止路径；若传输已经完成，不能推断每次调用都会关闭物理连接。该行为让夹具在尚未观察完整健康响应时宣布就绪，也造成正常准备路径的主动取消。

修复在原单一准备期限内，完整读取成功健康正文至 EOF；读取上限 64 KiB，连续空 chunk 上限 64，并在循环检查单调时钟。成功后释放 reader、移除监听器并清理定时器，保留未中止的请求信号。非成功响应继续立即非阻塞释放正文并按原 100 ms 间隔重试；超时、进程退出、诊断函数抛错及迟到响应均保留原失败并有界清理。未更改实际 Worker 的 60 秒准备期限、90 秒 suite 准备期限和业务测试预算。

另一 agent 独立复核期间指出并修正了初稿中非成功开放正文会阻碍重试的回归；主审补齐了迟到响应正文所有权和单调时钟边界。最终新增 10 项测试，加上既有真实 IPC 进程启动用例，Node 22.23.2 单次定向执行 11/11 通过、0 跳过，3,031.7892 ms。证据为 `.audit/73d7309-ci/fixture-health-targeted-first.log` 及 `fixture-health-targeted-first-source.json`。这是可验证的夹具生命周期修复；是否解释此前代理 POST 断连仍须与后续运行证据区分。

### 本轮完整 Worker/Runner 复验（2026-10-12T15:30Z）

冻结计划 `.audit/setup-repair-20261012/plan.json` 于 15:27:38.027Z 写入，SHA256 `55aaf77dd89d36bbdf05aae8126ecd520e04023f7caf5798c6a9302d97754df7`。来源为 `73d7309` 加本轮修改，计划保存全部修改文件和配置摘要，执行前后指纹核对一致。原 41 项清单、1/4/8/16 并发、512 请求、30 秒业务测试、60 秒负载和 300 秒内部 transport 期限保持原值；断线场景仍为原 200 ms、单次请求。

Windows x64、Node 22.23.2 的单次完整源码 E2E 于 15:27:39.654Z 开始，41/41 通过，0 失败、0 跳过，外层 193,640 ms、transport 门禁 191,806 ms。每档 read、workspace_list、job_get、job_logs 均实际完成 32/32 请求、0 失败，合计 512/512。

| 并发 | 完成请求 | 混合负载 elapsed ms |
| --- | --- | --- |
| 1 | 128/128 | 12,232 |
| 4 | 128/128 | 8,906 |
| 8 | 128/128 | 7,587 |
| 16 | 128/128 | 6,199 |

本次日志保留 212 条安全事件，未出现代理断连或测试失败事件。摘要 SHA256 为 `4819b3829e9e88ae8224b5b05ae59cb53ee911c3592f70508582d1155a9e8e73`，完整日志 SHA256 为 `045389a2315b0556a3ec52e8faedfbd6d82e0983c53635c052cb20f5a939a6d0`；文件分别为该目录的 `source_transport-summary.json` 和 `source_transport.log`。类型、文档、格式、架构和 whitespace 检查通过；本段在测试完成后追加，不回写冻结计划的源文件摘要。

用户文档与四份发布激活草稿另经只读复核，版本能力、中英文说明和历史条目保持一致；实际签名发布完成后再更新正式版本选择和已核验的发布证据。本轮仅在工程检查书保存故障调查、用例和计数。

## `04d50ba` 修复候选首次托管 CI 验收

本轮修复候选为 `04d50baadc774abc328d065cfe4fdde3c7370382`，源码树为 `c5a71e48c15dbe29a94499a0eb7891c67413fcb5`。GitHub Push CI [38271142398](https://github.com/aloneio/runmesh/actions/runs/38271142398) 与 PR CI [38271150342](https://github.com/aloneio/runmesh/actions/runs/38271150342) 均在首次执行（attempt 1）完成 8/8 作业，全部成功。Push 实际执行候选提交；PR 实际执行合成提交 `296b8dac7f50a4e48aa66c17652abe5ef16d7aa4`，其父提交为原 main `a18f3c015740458cfc90ce9b6c1626580937e6b9` 与上述候选，源码树与候选完全一致。两套执行身份分别核验并保存，没有将 PR 合成提交写成候选提交。

每套归档包含 8 份作业日志和 verify、Windows、browser 三个 ZIP，展开文件数分别为 57、3、3。六个 ZIP 的 SHA256 均与提供方摘要匹配，ZIP 条目、下载收据及展开后的完整文件集合逐项一致；两个汇总均为 `archive_state=complete`。每套 28 份 `ci_gate_execution` 记录均为 `passed`、退出码 0、源码状态 `clean`，提交分别匹配对应执行身份，源码树全部匹配上述候选树。归档与核验过程只读取既有 CI 结果，没有追加测试或远端写入。

| 验证项 | Push CI | PR CI |
| --- | --- | --- |
| 全部作业 | 8/8 成功 | 8/8 成功 |
| Windows 源码 E2E | 41/41，0 失败、0 跳过；160,909 ms | 41/41，0 失败、0 跳过；94,289 ms |
| Windows 混合负载 | 512/512 请求，0 失败 | 512/512 请求，0 失败 |
| Linux 源码 E2E | 41/41，0 失败、0 跳过 | 41/41，0 失败、0 跳过 |
| Linux 安装包 E2E | 41/41，0 失败、0 跳过 | 41/41，0 失败、0 跳过 |
| 真实浏览器 E2E | 5/5，0 失败、0 跳过 | 5/5，0 失败、0 跳过 |

两套 Windows 均使用 Node 22.23.2、x64。并发 1、4、8、16 各完成 128/128 请求；每档 read、workspace_list、job_get、job_logs 分别启动并完成 32/32，失败数均为 0。Push 四档混合负载耗时依次为 32,733/24,205/16,991/6,468 ms，PR 为 17,506/8,731/6,971/6,588 ms。上述 512 是各次实际完成数量，完整 41 项测试包含这些负载用例，计数分别按测试与请求口径保存。

| 核验摘要 | SHA256 |
| --- | --- |
| `.audit/04d50ba-ci/push-summary-20261012T1552317885959Z.json` | `946c898c3dd48ea038fc0cb93ae523df5147b876b305f7564c433247ee7808cf` |
| `.audit/04d50ba-ci/pr-summary-20261012T1552318529632Z.json` | `f9c366658d5a9501402ed9fec753cae2f75aef050234e2505a7091c7bb6363d8` |
| `.audit/04d50ba-ci/source-load-verification-20261012T1555507365801Z.json` | `4627fe4e4a7148e4839b5667bb1537da3a06d609a59f8011fb5df2e6b0c1a13c` |

最后一份摘要保留六个 ZIP 的摘要、每套 16 行操作完成记录及各测试报告来源，并通过 `supersedes` 引用同目录早先 `source-load-verification-20261012T1554554825207Z.json`。早先摘要的四档原始计数完整，但聚合字段因 PowerShell 字典投影写为 null；更正稿依据保留记录重算为每套 512/0，原稿继续保留。

这是新修复候选的首次双套托管 CI 成功，支持本轮回执与夹具生命周期修复通过该源码状态下的验证。此前 `73d7309` PR Windows 的 setup POST 断连和其他历史失败继续保留独立证据；本次通过不构成其单一根因已经证明的结论。

候选验收后的提升阶段记录：GitHub 已于 `2026-10-12T15:54:35Z` 通过 [PR 118](https://github.com/aloneio/runmesh/pull/118) 按正常保护流程将 main 快进到上述候选，main CI [38273637739](https://github.com/aloneio/runmesh/actions/runs/38273637739) 仍在运行。GitLab MR 59 已设置门禁满足后自动合并，正在等待门禁。正式 0.1.8 尚未发布、尚未激活；后续主分支、跨平台合并、签名资产及线上激活结果按各自实际证据另行追加。

### main 首次 CI 的 Windows 混合负载失败

上述 main CI [38273637739](https://github.com/aloneio/runmesh/actions/runs/38273637739) 随后结束，6 个作业成功，Windows 作业 `114893724160` 与汇总作业 `114897692686` 失败。执行来源仍为 `04d50baadc774abc328d065cfe4fdde3c7370382`、树 `c5a71e48c15dbe29a94499a0eb7891c67413fcb5`、状态 `clean`。本次结果与此前通过的 Push、PR 两次执行分别保留；此前通过不替代这次主分支门禁。

main 的 8 份作业日志及 verify、Windows、browser 三个 ZIP 均已完整归档。三份 ZIP 与提供方摘要一致，分别展开 57、3、3 个文件，逐文件摘要和完整集合校验通过，汇总为 `archive_state=complete`。28 份门禁记录全部匹配该源码身份，其中 27 份通过，Windows transport 失败；完整归档仅表示证据齐全。

Windows transport 在 115,028 ms 后以退出码 1 结束。失败摘要为 `stage=test_execution`、`report_available=true`、1 个失败文件、1 项失败、0 跳过，定位到第 19 项测试中的 `job_logs` 请求：HTTP 500，正文分类为非 JSON 文本，固定运行时签名为 `network_connection_lost`。原始 Vitest reporter 在包装器执行时可用，但公开的三个工件及作业日志只保留失败安全投影，未保留最终 passed/total 计数；本记录不将已知测试清单减去失败数写成实际报告的“40/41”。

首错出现在并发 1 的混合负载第 104 个已启动请求。现场进度为 started 104、completed 103、pending_headers 0、pending_body 1；四类操作分别为 read 26/26、workspace_list 26/26、job_get 26/26、job_logs 26 次启动、25 次完成和 1 次失败。负载计时记录为 26,872 ms，包含任务准备的进度记录为 27,315 ms，两种计时口径分别保存。代理诊断同时记录一次 POST 上游连接丢失、attempts 1。

后续并发 4、8、16 的用例继续完成，各档四种操作均为 32/32、0 失败，即每档实际完成 128 次请求；耗时分别为 26,490、7,409、5,083 ms。首错后的 Worker 阶段快照记录 entered 194、finished 194、dropped 0；最近一项为 sequence 194 的 `job_get`，状态 `eof`。这些记录限定了当前观察窗口中的进度和事件，不能单独证明底层连接丢失的原因，也不将该快照外推为所有 Worker 实例或后续请求的完整状态。

| main 失败证据 | SHA256 |
| --- | --- |
| `.audit/04d50ba-ci/main-summary-20261012T1610129802710Z.json` | `5f36f8d02ca7a3ecfec3ca807324c870dd2b4bb52fa512ccbb2d7362b9891cce` |
| `.audit/04d50ba-ci/main-job-114893724160.log` | `d2723986c71125f490db553916fa2e8cc54ad4531b1e4dfffb06eca600732145` |
| `.audit/04d50ba-ci/main-windows-artifact/transport-tests.json` | `9413751ecf3d4228dc3e3993b74921ad16335e0736ded7abcf2b1936dbfed398` |
| `.audit/04d50ba-ci/main-windows-artifact.zip` | `52f652c69d3b03dc63c66d670d6cd404cf41956762a509e82e75c953dc13f3d9` |

本段据首次 main 执行的保留证据追加，未重新触发 CI。正式 0.1.8 的签名发布与激活继续等待后续验收结论。

## 原生 Worker 传输夹具修复与单次双通道验证

GitLab [MR 59](https://gitlab.com/aloneio/runmesh/-/merge_requests/59) 随后于 `2026-10-12T16:06:23.840Z` 完成受保护合并，GitHub 与 GitLab 的 dev、main 均落在 `04d50baadc774abc328d065cfe4fdde3c7370382`。该事实记录于 `.audit/04d50ba-ci/gitlab-promotion-after.json`；主分支 Windows 失败仍是本轮发布门禁，未重新运行旧提交的 CI。

上述首错发生于 Wrangler ProxyWorker 向 UserRuntime 转发 POST、尚未收到响应头的阶段。失败后的业务入口快照没有该条 `job_logs`，原生运行时观察窗口中没有退出、重启或重载证据；负载取消发生在首错之后。这将修复范围收窄到本地开发代理的网络跳转。现有证据尚不足以认定底层 TCP/keepalive 机制，未据此改写业务截止时间或增加 POST 重试。

实际依赖链为 Wrangler `4.149.0` → Wrangler 嵌套 Miniflare `5.20261006.1-alpha` → 对应 workerd `1.20261006.1`。新增 `scripts/worker-runtime-launcher.mjs` 使用 Wrangler 公开导出的 `unstable_DevEnv`，从同一配置建立运行时，并交叉核对唯一 local runtime 的 `mf.ready` 与 `reloadComplete.proxyData.userWorkerUrl`。传输测试连接其真实 `127.0.0.1` HTTP socket，经 Miniflare core/资源路由进入 Worker，保留 D1、Durable Object、变量绑定、持久化目录、Runner 和 WebSocket。浏览器夹具与默认 CLI 启动契约继续使用 Wrangler 开发服务器入口。实现没有修改依赖包或直接调用应用 handler。

夹具关闭文件监听和实时重载；意外的第二次 reload 会使验证失败关闭。启动错误、父 IPC 断开、teardown 拒绝和挂起均有有界清理；超时清理只回收当前夹具拥有的进程组或 Windows 子进程树。十项新增契约使用独立真实 HTTP 端口、IPC 和后代进程验证这些行为。

### 契约验证中的退出等待修正

首次轻量契约命令保留在 `.audit/native-worker-fixture-20261013/contracts.log`：原有启动契约通过，首个 native 用例在约 326 ms 后因 pending Promise 且事件循环已结束而被取消，其余九项随父取消，总计 1 passed、10 cancelled。独立 IPC 小复现及 Node 22.23.2 内置源码核对确认：父进程主动 `child.disconnect()` 后，两条输出流已结束、子进程已以 0 退出，但 `ChildProcess.close` 未发出，关闭计数为 3/4。新增测试将日志收集绑定到该事件造成永久等待。

修正为分别等待 stdout/stderr 结束，并设置 1 秒有引用的排空期限。相同筛选命令在修正后通过 11/11，0 failed/cancelled/skipped；其中包含 teardown 挂起及拒绝时真实后代服务的回收验证。首次失败、小复现和修正后的完整日志分别保存，未覆盖旧结果。

| 契约证据 | SHA256 |
| --- | --- |
| `contracts.log` | `036d870baea652510b0ffa765d23bd90c0553bb224caee5a2f58fc9c42d3cb90` |
| `ipc-close-repro-result.json` | `32487af3b6de8d7b6187266ceb493582aced3f2976df5cbdc0a45ef0caa01f7d` |
| `contracts-v2.log` | `27d81d01b7dc846a566f61d7a58f42a99d9f678861bfb52a5234688ebc5adf9e` |

### 冻结源码与安装包验证

完整验证前，私有驱动冻结 20 个输入文件、staged/unstaged diff、工作区状态、Node 可执行文件及命令预算。计划位于 `.audit/native-worker-fixture-20261013/plan.json`，SHA256 `2ade65e9c8d0fc0d2a7275d90d130656e65ac15f954146c53420d82223ed067f`。身份为 `04d50ba` 基线上包含本轮修复的 dirty 工作区；基线 tree 不是修复后的 tree。每条通道执行一次，启动占位与结果均写入新文件，执行前后快照深比较一致；独立复核确认全部 20 个输入指纹保持不变。

两条通道均保留 41 项测试、每档 128 次请求、并发 1/4/8/16、30 秒普通测试期限、60 秒负载期限、200 ms 后断开且仅发送一次的断线场景和 300 秒 E2E 期限。安装包验证还保留原有 420 秒 package 及 480 秒 gate 期限。310/490 秒外层观察器只收集结果并回收进程树。

| 验证项 | 源码 | 实际安装包 |
| --- | --- | --- |
| 命令 | `node scripts/run-e2e.mjs` | `node scripts/ci-check.mjs installed_transport` |
| 测试结果 | 41/41，0 失败、0 跳过 | 41/41，0 失败、0 跳过 |
| 混合负载 | 512/512，0 失败 | 512/512，0 失败 |
| 四档耗时（ms） | 8,816 / 7,180 / 6,205 / 5,780 | 8,928 / 7,667 / 6,037 / 5,104 |
| 外层观察耗时 | 133,479 ms | 167,661 ms |
| 原始 gate 耗时 | 127,289 ms | 162,680 ms |
| 结果摘要 SHA256 | `0162baf7b95ccdeb229b49c5ea921c3d892e9d8bd4244c7c9558d04668b66584` | `a3dea979553d2e0458078afbb139519d80f0d46e097f8f1833585ed4acc26a14` |

结果摘要文件分别为同目录 `source_transport-summary.json` 与 `installed_transport-summary.json`。每档四种操作均启动并完成 32/32 次。两个主夹具的运行时 observer 均记录已安装，归档安全事件中没有失败或重载事件；该观察范围不等同于完整进程生命周期。安装包 SHA256 为 `7040077f3e3bbb55978a3efc7c979e40e3dce4d403bf687c464e88d1092e025b`，大小 1,217,455 字节，是本地打包验收产物，尚未签名或发布。

类型、架构、测试收集、版本同步、文档、格式及 whitespace 检查通过。中英文验证文档准确说明传输和浏览器的验收入口，故障调查保留在工程检查书。此段在冻结验证结束后追加；后续新候选 CI、公开签名资产和生产激活依据各自执行记录继续验收。

## a259abd 候选 push/PR 首轮双失败归档

记录日期：2026-10-13（Asia/Shanghai）。本节依据已保存的 GitHub push、PR 首轮运行及安全报告整理。这里的“双事件”是同一 GitHub 候选的 push 和 pull_request 两次独立运行，不表示 GitHub 与 GitLab 两个平台。

### 结论与发布状态

候选 `a259abddfb8a5d6e0dc293c60040f2e0edb5882d` 将源码和安装包传输验收切换到真实本地 Miniflare/workerd 原生 HTTP 入口，保留 Wrangler 配置、绑定和资源路由；浏览器继续使用 Wrangler 本地开发入口。本轮两次 GitHub Windows 传输检查均失败，因此这一入口修复尚未满足 Windows CI 验收要求。

两次运行各有 6 个作业成功，Windows native 作业与依赖它的 `verify-all` 失败。每次 28 份 `ci_gate_execution` 报告中有 27 份通过、1 份 Windows `transport` 失败。Linux 源码 E2E、Linux 实际安装包 E2E 和浏览器检查通过的事实分别保留，不能替代 Windows 结果。

旧候选中 Wrangler 开发代理的拒绝边界只定位了当次可观察的失败位置；本轮原生入口仍出现客户端 fetch 失败及控制面读取截止，现有证据不能把旧代理层、HTTP 空闲复用、某一 socket 或某个运行时退出认定为这些失败的唯一底层原因。继续修复需要新增的被动 cause/socket 观察；本附录不将计划中的诊断当作已取得证据。

0.1.8 正式版尚未发布。本轮继续保持候选状态，暂停晋级、签名发布及生产激活；Linux 测试包报告中的 `signed: false`、`published: false` 也仅描述测试产物。本轮没有重跑旧 CI、修改并发档位或提高测试预算。

### 源码身份与归档完整性

| 项目 | push | PR119 |
| --- | --- | --- |
| GitHub run | [38279653518](https://github.com/aloneio/runmesh/actions/runs/38279653518) | [38279812176](https://github.com/aloneio/runmesh/actions/runs/38279812176) |
| attempt | 1 | 1 |
| 事件 | push / dev | pull_request / dev → main |
| 候选 head | `a259abddfb8a5d6e0dc293c60040f2e0edb5882d` | `a259abddfb8a5d6e0dc293c60040f2e0edb5882d` |
| 实际执行 commit | `a259abddfb8a5d6e0dc293c60040f2e0edb5882d` | `bf2717ea651bd873d3e2bbaa699fe9f2266fc58e` |
| 实际 tree | `c1645c9cb9a195ac199e9033c5c4fec42a53210f` | `c1645c9cb9a195ac199e9033c5c4fec42a53210f` |
| 报告源码状态 | clean | clean |
| Provider conclusion | failure | failure |
| 归档状态 | complete | complete |
| Windows job | `114913535766` | `114914069292` |
| Windows transport elapsed / exit | 99,499 ms / 1 | 156,868 ms / 1 |

PR 合成提交的有序父提交为：

1. main：`04d50baadc774abc328d065cfe4fdde3c7370382`
2. 候选：`a259abddfb8a5d6e0dc293c60040f2e0edb5882d`

`git ls-remote` 对 PR merge ref 的只读观察和 GitHub commit 对象确认了上述拓扑。PR 的 7 个执行 checkout 日志均记录该合成提交；28 份 gate 报告的 commit、tree、clean 状态均与之匹配。push 的 28 份 gate 报告均匹配原候选和同一文件树。

每次归档包含 8 份完整 job 日志及 3 个 ZIP：verify 57 个文件、Windows 3 个、browser 3 个。6 个 ZIP 均与 GitHub provider digest 匹配；ZIP 清单、展开文件集及文件摘要由 download receipts 和 summary 串联保留。`verify-all` 是汇总失败，不另计为业务测试失败。

### Windows 实际失败计数

两次安全报告均记录：`state=failed`、`stage=test_execution`、`subprocess_exit_code=1`、`report_available=true`、`failed_files=1`、`failed_tests=2`、`skipped_tests=0`。包装器错误分类为 `process_exit`，坐标为 `scripts/worker-fixture.mjs:137:42`。

`report_available=true` 表示包装器执行时取得了私有机器报告。归档的安全报告保留失败数、跳过数及分类，没有保留 Windows 最终 passed/total；原始私有 Vitest reporter 未随产物保存。因此本附录不写成“39/41”，也不从源码用例库存反推最终通过数。

| 运行 | test_index | 分类与位置 | 对应混合负载档位 |
| --- | --- | --- | --- |
| push | 20 | `fetch_failed`；`test/e2e/mcp-runner.e2e.test.ts:1291:24` | c4 |
| push | 21 | `fetch_failed`；`test/e2e/mcp-runner.e2e.test.ts:1291:24` | c8 |
| PR | 21 | `fetch_failed`；`test/e2e/mcp-runner.e2e.test.ts:1291:24` | c8 |
| PR | 22 | `assertion_failed`；`test/e2e/mcp-runner.e2e.test.ts:685:85` | c16 |

PR index22 的 MCP 结果分类为 `phase=mixed_load`、`result=error`、`error_code=control_plane_unavailable`、`failure_class=availability`、`operation_state=not_started`。报告里的 `next_action=wait_and_retry` 是被测协议的返回字段，不是本次验证执行过重试的证据，也不是要求重跑 CI 的指令。

### 混合负载的完成记录与首错快照

原计划每次包含 c1、c4、c8、c16 各 128 个混合请求，合计 512 个；每档均包含 `read`、`workspace_list`、`job_get`、`job_logs` 四种操作。失败档位下表中的 started/completed 是首错误冻结时的快照，不是后续取消和清理结束后的最终总数。并发运行中的“已启动 N 个”也不等于“第 N 个请求就是失败请求”。本轮任何一次 Windows 结果都不记为 512/512。

`load_progress.elapsed_ms` 从该用例开始计时，包含任务准备；`load_timing.elapsed_ms` 从混合请求阶段开始计时。两个时钟不能互换。通过档位使用最终 `load_timing`；失败档位使用首错冻结记录。

| 运行 | 并发 | 观察 | started | completed | 首错 pending headers / body | progress elapsed ms | mixed elapsed ms | 首错操作分类 |
| --- | ---: | --- | ---: | ---: | --- | ---: | ---: | --- |
| push | 1 | passed | 128 | 128 | — | — | 13,001 | — |
| push | 4 | first failure snapshot | 82 | 78 | 4 / 0 | 11,041 | 10,650 | `job_logs` fetch failure |
| push | 8 | first failure snapshot | 46 | 38 | 8 / 0 | 22,280 | 9,943 | `read` fetch failure |
| push | 16 | passed | 128 | 128 | — | — | 6,971 | — |
| PR | 1 | passed | 128 | 128 | — | — | 15,958 | — |
| PR | 4 | passed | 128 | 128 | — | — | 21,170 | — |
| PR | 8 | first failure snapshot | 10 | 2 | 8 / 0 | 37,060 | 29,545 | `workspace_list` fetch failure |
| PR | 16 | first failure snapshot | 33 | 17 | 15 / 0 | 15,483 | 10,048 | `read` MCP error result |

每个 passed 档位的四种操作均为 started=32、completed=32、failed=0。失败快照保留的操作计数如下，单元格依次表示 started / completed / failed：

| 运行 / 并发 | read | workspace_list | job_get | job_logs |
| --- | --- | --- | --- | --- |
| push / c4 | 21 / 20 / 0 | 21 / 20 / 0 | 20 / 19 / 0 | 20 / 19 / 1 |
| push / c8 | 12 / 10 / 1 | 12 / 10 / 0 | 11 / 9 / 0 | 11 / 9 / 0 |
| PR / c8 | 3 / 0 / 0 | 3 / 2 / 1 | 2 / 0 / 0 | 2 / 0 / 0 |
| PR / c16 | 9 / 4 / 1 | 8 / 5 / 0 | 8 / 4 / 0 | 8 / 4 / 0 |

首错冻结记录保留在触发停止调度和取消前；失败后 Worker 快照中的 `cancelled` 请求可能来自这一清理路径，不能直接倒置为首错原因。四档按顺序分别执行，后续档位通过不撤销此前失败。

### 控制面截止与运行时观察边界

PR c16 附近保留一条固定字段事件：`control_plane_failure`，`stage=runner_mcp_authorization`，`outcome=deadline`，`kind=other`，`reason=unknown`，`status=200`，`phase=body_read`。候选源码 `apps/worker/src/runner-do.ts:592` 为该授权读取设置 5,000 ms 边界。这说明当次控制面读取已取得 HTTP 200 状态，随后在响应体读取阶段达到既定截止；HTTP 状态本身不证明授权回执读取完成。它也不等同于负载用例的 60 秒预算耗尽。

push 安全事件中没有保留该 `control_plane_failure` 记录；这只描述现有记录范围，不能据此排除控制面延迟。两次客户端首错均保留 `request_failure/test_failure kind=type_error` 分类；现有安全字段不包含足以确定底层 socket 单因的 cause/连接细节。

失败后的 Worker 快照：push c4 为 `unavailable`；push c8 为 entered=338、finished=337、dropped=0；PR c8 为 353/352/0；PR c16 为 381/376/0。它们是失败后的有界观测，不是所有请求和依赖的完整追踪。不得把快照缺少某条请求解释为该请求必然没有抵达任何 Worker。

两次都观察到两个 native runtime spawn；push 的 elapsed 为 1,669/2,082 ms，PR 为 2,206/2,635 ms。两次 launcher 快照均为 `reason=test_failed`、exit/signal 为 null、`teardown_started=false`、`exited_before_teardown=false`。这些字段描述 launcher 和已记录事件，不构成所有底层进程或连接均健康的证明。

### 同轮通过的检查

每次成功的 6 个作业为：`verify`、`browser`、Linux native、macOS native、Node LTS 22.23.2、Node LTS 24.21.0。

| 观察 | push | PR |
| --- | --- | --- |
| Linux source transport | 41 passed / 41 total；failed/skipped/todo 均 0 | 41 passed / 41 total；failed/skipped/todo 均 0 |
| Linux installed-package transport | 41 passed / 41 total；failed/skipped/todo 均 0 | 41 passed / 41 total；failed/skipped/todo 均 0 |
| Browser | 5 passed / 5 total；failed/skipped/todo 均 0 | 5 passed / 5 total；failed/skipped/todo 均 0 |

两次 Linux package 报告均记录测试 tarball 为 1,217,457 bytes，SHA256 `33f1a65af0fae61a295d78c53fddace867363cffe2488d72c53c378fb7e9ff7b`。这些是独立执行的相同覆盖范围，不相加为唯一测试总数。

PR119 的独立 `main-source-policy` run `38279812282` attempt1 成功，job `114914069207`；该结果验证 PR 来源规则，不替代失败的普通 CI。

### 完整归档索引与 SHA256

以下路径均相对于 `.audit/a259abd-ci/`。归档摘要还保留 terminal snapshot、原始 run/jobs 响应的指纹；每份 `*-download.json` 保留对应日志或 ZIP、完整展开文件清单及其摘要，可沿索引追溯原字节。

| 归档文件 | SHA256 |
| --- | --- |
| `push-summary-20261012T1659512912074Z.json` | `e7beaa22d0e5e4692efd389c46a1c7a16aed51f33424981afd4ac8c5cd98f2e4` |
| `pr-summary-20261012T1701533597966Z.json` | `0952dcc1a1a3a2d066621d07a77a3f835de480c6e59d4ca2619795494e6dff6b` |
| `pr-source-artifact-verification-20261012T1703361500071Z.json` | `bd3e3b90a43238ee55456f9385b8f06c4ed476e3d052b3ba6e591d5d87763dec` |
| `pr-source-20261012T1649581099088Z-summary.json` | `6be452c24cc89e3f93299ca305feef3ca699c203b4a75690fd07ec26b23add16` |
| `policy-summary-20261012T1650119977809Z.json` | `081bb937e3d5a884885cd81a4758d7b37638a89938806761d1ef2ef97e08eee7` |
| `policy-job-114914069207.log` | `911d34c76324f64825812fad1dab22668d649deaabcbf2535b4a0927e467c6f0` |
| `push-verify-artifact.zip` | `482ddc8f33523c3b92a03dfc278e3bcd957d2eefd706e5a5efb456c05615e7db` |
| `push-windows-artifact.zip` | `fea6f49b8661c4dd8382548633d115b6822a60cb26a487f25eca6b8780260e95` |
| `push-browser-artifact.zip` | `ae3135824d1b8f399e5e785acb7b5cfb9d703df4b1fb28c8d0831a24997ef77f` |
| `pr-verify-artifact.zip` | `b7086830eba4173fa08d1c11b51d323588a40bce9c655509c7a5a6c5d49aac3f` |
| `pr-windows-artifact.zip` | `9c37f00531378229bb0679eb9db3673f962dada6f48156dcf664669082c2f554` |
| `pr-browser-artifact.zip` | `42883ff8aef48951254a70964448d4890779a4f9636f4af98e51fa036a4e10dd` |
| `push-windows-artifact/transport-tests.json` | `344c6b48c6b5d573666e54e431570de305afdff7ee98518da771d2ec76605027` |
| `pr-windows-artifact/transport-tests.json` | `1fcba7fce996823fce04792701155601215984b2ef1552fee85fbf094d2951ba` |

全部 push job 日志：

| 作业 / 日志 | SHA256 |
| --- | --- |
| LTS22 · `push-job-114913535330.log` | `d90a5cee95f24d049c3c7abdc8061fde4f53fcd7674501c812557bdf6d5834d3` |
| LTS24 · `push-job-114913535569.log` | `f5cfd2ff03261c55c4eb2c3aadee2b577a3a2636d6e793094731bd941e89531d` |
| verify · `push-job-114913535715.log` | `f740d5af86f8164543085dce57431fe819a4dfa050405fe5713d8acf5dd58612` |
| macOS · `push-job-114913535734.log` | `51694753ad387c784fb4cb47a68712bea3fb2302b107e17a9e786b257d8afbe9` |
| Windows · `push-job-114913535766.log` | `1e89335ce53edac6bc9d6b38c102a558a3dd186345081438e7be4fe232773a93` |
| Linux · `push-job-114913535769.log` | `30f6cc6cf1c94b2a85b15ec44ac469964700d83c4faf3fdb9ac2261db39377e8` |
| browser · `push-job-114913535862.log` | `3cbd96533ee57cb97e4a99ed5567a3a41d5c1ec0eba41866d75ca0e1af181975` |
| verify-all · `push-job-114916936775.log` | `7741856acc69bf52cc7476d4f47ae3c218fde8b12dbb0ca7c4165a133f762652` |

全部 PR job 日志：

| 作业 / 日志 | SHA256 |
| --- | --- |
| verify · `pr-job-114914069023.log` | `d7e0cf20b41b38f854ea9c22e8ee0090cc9391bc9cc96b40c487624b49c58e91` |
| Windows · `pr-job-114914069292.log` | `df148cf4b79dfcccde5ec4d57f77e22ed7f11780dee80b101be8e84167088345` |
| browser · `pr-job-114914069407.log` | `c58c430c36b46967a0edfa18e814a89d7a4c20c3b9d89e875d196d61c71d885c` |
| LTS24 · `pr-job-114914069411.log` | `7c39aa55693bde57934c5a6b078d92908df969c80b505a48e68b57609c2de4ca` |
| Linux · `pr-job-114914069414.log` | `0eced370520e7b9c8730b7e18526823c05da37b6f139d8436c90cfd647b1f78a` |
| macOS · `pr-job-114914069425.log` | `46f4bbb919adac232e3e4fcc08a1bc1b500b3ed1c0a978d741eb37608fb0f810` |
| LTS22 · `pr-job-114914069463.log` | `7c1de404b770f05edb64cb259ae518e3b352353844e0cdb5999be3549aff51da` |
| verify-all · `pr-job-114918102417.log` | `44ed41bf00c01333f2bf1bb869e128d2c8cd3918a6c8cdd4e74666168072509b` |

后续补充被动诊断、修复和新候选验证时，应另记源码身份、计划、首次执行和结果，保留本轮失败原始字节与归档指纹。

## 原生连接的被动诊断补充

在 `a259abd` 基线上新增仅观察夹具 HTTP origin 的 Undici diagnostics_channel 订阅，使用弱引用关联请求、连接与错误。错误发生时冻结连接序号、观察到的发送次数、复用与空闲情况、响应头状态及有界字节计数；未观察到连接创建时，首次连接年龄保留未知。同一错误对象对应多个请求时不提供有歧义的连接归属。该观察器不改变 fetch、连接池、请求、取消信号、重试或截止。

每个负载档位在同伴取消前分别记录首错的固定 cause 分类、操作、请求索引、响应头/正文/结果验证阶段和取消状态。日志按固定枚举和数值重新构建，不包含地址、请求内容、凭据、错误消息或堆栈。安全事件包络由 768 调整至 2,048 字符，以容纳已有 HTTP/工具结果详情与新增观察的组合；总捕获上限和测试预算保持原值。这一变更补齐证据，尚不构成 Windows 底层连接故障的修复结论。

首次完整契约验证保存在 `.audit/native-transport-diagnostics-20261013/`：`contracts.mjs` 使用固定 Node 22.23.2 串行运行 browser-fixture、verification-tools 两个完整文件，共 192 项，181 通过、2 失败、9 平台跳过，0 取消，耗时 53,428 ms。执行前后源码和驱动指纹一致。`contracts.log` SHA256 为 `b7028b8ad4c15d44260aaf683a6aa954a29d7791fae88a7a8c34b92b887e0f73`。

两项失败分别定位为新增测试夹具问题：Node 的 mock.restore 将继承的 ActiveChannel 方法写回通道实例，随后通道变为 inactive 时留下了错误的实例方法，导致下一项真实 HTTP 观察未订阅成功；测试现精确恢复原属性描述符或继承状态。另一项原长度夹具实际为 698 字符，未超过旧包络；现保留其准确长度断言，并构造带 HTTP、工具详情的合法组合验证更大记录的完整往返。真实 POST 单次发送、错误关联和全部测试断言均保留，首次失败原始证据独立保存。

上述夹具修正后的完整验证由独立 `contracts-v2.mjs` 执行：192 项中 183 通过、9 平台跳过、0 失败、0 取消，耗时 67,337 ms，执行前后源码及驱动指纹一致。全部 12 项连接观察契约通过，包括一次真实本地 POST 的错误关联与恰好一次发送；698、910、1,055、1,256 字符的合法记录均完整往返，超过包络的记录被拒绝。`contracts-v2.log` SHA256 为 `c34b790b47ed96479337b3095a80e80f7a42128c5af997254da11c65d4c61234`。类型、架构、版本、文档与项目事实、验证清单及测试收集检查均通过。

### 被动诊断候选的单次完整验证

冻结计划位于 `.audit/native-transport-diagnostics-20261013/plan.json`，SHA256 为 `b6e18b7c86a3171bb5972066e13822813a47a2ddc8e5707814cb8d550a45b8ff`，包含 19 个文件。两条路径使用原有入口串行执行，各自一次，保留 41 个用例、并发 1/4/8/16 每档 128 次请求、普通用例 30 秒、负载 60 秒及 200 ms 单次断连预算。两条路径的执行前后源码、文件、差异与运行时指纹均等于冻结计划；工程记录在验证后追加。

| 证据 | 源码路径 | 实际安装包路径 |
| --- | --- | --- |
| 测试 | 41/41，0 失败、0 跳过 | 41/41，0 失败、0 跳过 |
| 压力请求 | 512/512 | 512/512 |
| 门禁 / 外层耗时 | 126,888 / 132,322 ms | 102,379 / 105,859 ms |
| c1 / c4 / c8 / c16 负载耗时 | 9,571 / 7,359 / 7,092 / 5,843 ms | 8,104 / 4,728 / 3,974 / 2,911 ms |
| 安全观察事件 | 211 | 211 |
| summary SHA256 | `5ae3442c33468df8b59a6933135efd0c00aa8dbb95aa1490016b7931cd8c3ff4` | `82c3a1fff68b3193f2eb8e01ea1e1e96500ee361704bc5641a3931a428f4e376` |

每个并发档位的四种操作均完成 32/32 次，失败数为 0。两条路径分别保留 6、5 个归档文件，其大小、摘要、日志负载行与 211 条安全事件已独立复核；事件仅涵盖已记录的运行时观察、进程启动与负载指标，没有保留失败或 reload 事件，不据此声称所有生命周期均已观察。安装包报告记录本地测试 tarball 为 1,217,455 bytes，SHA256 `7040077f3e3bbb55978a3efc7c979e40e3dce4d403bf687c464e88d1092e025b`，`signed=false`、`published=false`。这些本机结果验证诊断补充后的功能覆盖；托管 Windows 的底层故障仍按新提交的独立 CI 证据定位。

## `e465647` 首轮验收与 0.1.8 正式发布

记录日期：2026-10-13（Asia/Shanghai）。以下结果均来自已经完成的执行及其独立归档核验。发布源码为 `e4656476f2b7ad8f1f873c1362ef0262404c0a45`，直接父提交为 `a259abddfb8a5d6e0dc293c60040f2e0edb5882d`，源码树为 `3db3b8127fbf0a3ba910e3891662309efe4e3b39`。各次执行沿用既定入口、并发档位、请求数量与预算，按独立事件分别记录。

### 候选、受保护 main 与发布工作流

| 阶段 | GitHub run / attempt | 实际执行提交 | 作业 / 关卡结果 |
| --- | --- | --- | --- |
| push / dev | [38286664298](https://github.com/aloneio/runmesh/actions/runs/38286664298) / 1 | `e4656476f2b7ad8f1f873c1362ef0262404c0a45` | 8/8 作业成功，28/28 关卡通过 |
| PR119 / dev → main | [38286668446](https://github.com/aloneio/runmesh/actions/runs/38286668446) / 1 | `6583828918114a36f41ddc04dae7896439f0d121` | 8/8 作业成功，28/28 关卡通过 |
| push / main | [38288877911](https://github.com/aloneio/runmesh/actions/runs/38288877911) / 1 | `e4656476f2b7ad8f1f873c1362ef0262404c0a45` | 8/8 作业成功，28/28 关卡通过 |
| 正式发布 / main | [38291058364](https://github.com/aloneio/runmesh/actions/runs/38291058364) / 1 | `e4656476f2b7ad8f1f873c1362ef0262404c0a45` | 10/10 作业成功，复用 CI 的 28/28 关卡通过 |

PR119 的实际合成提交按顺序以 `04d50baadc774abc328d065cfe4fdde3c7370382`、`e4656476f2b7ad8f1f873c1362ef0262404c0a45` 为父提交，tree 与发布源码一致。push、PR、main 各七个实际 checkout 作业的日志与对应执行身份吻合；每轮关卡报告的 commit、tree、clean 状态分别与自身运行一致。独立来源策略 [38286668497](https://github.com/aloneio/runmesh/actions/runs/38286668497) attempt 1、job `114936575419` 成功，回执为 `main-from-dev-v1`、`allowed=true`、PR119。

GitHub main 在 `2026-10-12T18:08:12Z` 的提升记录之后执行上述精确提交 push CI。GitLab 同源 main 验收由正常发布工作流的 provider 门禁确认：发布 job `114954733405` 在 `2026-10-12T18:44:29.8729849Z` 记录 `observed_provider_ci`、commit=e465647、branch=main，GitHub run `38288877911` attempt 1 和 GitLab project `85844627` / pipeline `2939775389` 均为 `passed`。该门禁输出先于签名步骤，原始日志独立保存。

每轮 28 项关卡包含 verify 的 26 项以及 Windows transport、browser 各 1 项。各轮 Linux 源码传输和已打包 Runner 传输分别通过 41/41，browser 通过 5/5，这些测试的 failed / skipped / todo 均为 0。其他测试层按其原始日志保留平台跳过计数，重复执行的覆盖不相加为唯一测试总数。

| Windows 执行 | transport 通过 / 总数 | 混合请求完成 / 总数 | gate 耗时 ms | c1 / c4 / c8 / c16 的 p95 ms |
| --- | ---: | ---: | ---: | --- |
| push / dev | 41/41 | 512/512 | 128820 | 498 / 1761 / 1619 / 1827 |
| PR119 | 41/41 | 512/512 | 161487 | 701 / 1930 / 1134 / 1656 |
| push / main | 41/41 | 512/512 | 75497 | 213 / 478 / 602 / 855 |
| release 复用 CI | 41/41 | 512/512 | 84676 | 175 / 469 / 636 / 908 |

四轮 Windows transport 均为 failed / skipped / todo=0。每档 128 次请求包含 `read`、`workspace_list`、`job_get`、`job_logs` 各 32 次；p95 是客户端请求延迟，gate 耗时覆盖整套验证。main 的 Linux 源码、安装包、browser gate 耗时分别为 33442、35402、115668 ms；release 的对应耗时为 31636、34203、136333 ms。

push、PR、main 每轮八份日志和三份 CI ZIP 均完整归档，ZIP provider digest、展开文件集合、字节数和哈希已核对。release 的十份日志、三份 CI ZIP、63 个展开文件及原始 run/jobs/终态快照共 79 项文件指纹也逐项吻合。全部关卡报告仍保留 `ci_gate_execution`、`self_reported` 证据属性。

### 正式资产与公开独立校验

[Runmesh v0.1.8](https://github.com/aloneio/runmesh/releases/tag/v0.1.8) 的 Release ID 为 `410904870`，GitHub 原始元数据记录于 `2026-10-12T18:44:39Z` 公开发布，`draft=false`、`prerelease=false`、`immutable=true`。工作流始于 `18:27:44Z`，终态更新时间为 `18:44:44Z`，结果为 success。annotated tag `v0.1.8` 的对象为 `b12f17556ea4b0b1525acb2193c0b1808cc6c3cb`，创建者为 `aloneio <git@aloneio.aleeas.com>`，指向发布提交 e465647；原始 Git data commit 响应确认 tree3db3b812。

发布 job 先对最终 `release/assets/runmesh-runner-0.1.8.tgz` 执行 `scripts/test-packed-runner.mjs`，于 `18:44:04.6812909Z` 输出 `EXACT_PACKAGED_RUNNER_E2E_OK 0.1.8`。该正式包在 Linux 完成 41/41 项测试、512/512 次混合请求，failed / skipped / todo 均为 0；四档 p95 为 34、128、180、357 ms。随后 22 项安全回归、11 个测试文件通过，`security_readiness=verified` 绑定同一发布提交。打包后的 tracked 源码一致性检查、双平台 main 门禁、签名、draft 回读校验、公开发布、immutable 检查和公开回读校验按工作流顺序完成。

公开下载于 `18:45:58.0896940Z` 开始、`18:46:14.3407564Z` 完成，保留四份原始 provider JSON、九项资产及 13 次初始资源 GET 的 URL、时间、字节数与 SHA256。资产从官方公开 URL 无授权头下载；永久文件使用 CreateNew，helper 的四份原始暂存响应再经逐字节复制校验进入永久归档。13 个请求目标与四份暂存的 17 项指纹已复核。

独立离线验签收据于 `18:47:21.626Z` 记录 `state=verified`。校验覆盖版本、release/tag/source/tree、官方 URL、资产 ID/大小/digest、严格九项资产集合与 Ed25519 签名。签名直接覆盖 `manifest.json`，key ID 为 `runmesh-preview-2026-01`；清单中的大小和 SHA256 将 Runner 包绑定到已认证清单。源码中的 trust keyring、LICENSE、NOTICE、THIRD_PARTY_NOTICES.md 与公开字节一致，SHA256SUMS 精确覆盖其余八项资产。

| 正式资产身份 | 核验值 |
| --- | --- |
| manifest SHA256 | `88eda689c8ce877f4c66ef464e1c465047855444fdd7e2aa79060bc3aba98408` |
| Runner 资产 / GitHub Asset ID | `runmesh-runner-0.1.8.tgz` / `634654776` |
| Runner 字节数 / SHA256 | 1217457 / `33f1a65af0fae61a295d78c53fddace867363cffe2488d72c53c378fb7e9ff7b` |
| 签名 CI artifact | `11766697573`，ZIP 1223415 字节 |
| 签名 CI ZIP SHA256 | `0213bac6e748e5dede7a1241f10f8f1688ccaf485bb52ca668e55a93e79eabde` |

九项官方资产为 LICENSE、NOTICE、SHA256SUMS、THIRD_PARTY_NOTICES.md、manifest.json、manifest.sig、manifest.signature.json、runmesh-runner-0.1.8.tgz、trust-keyring.json。签名 CI ZIP 内九项条目、对应展开文件和九项公开下载资产的大小及 SHA256 逐项一致。清单的 `published_at=2026-10-12T17:47:39Z` 按工作流取自源码提交时间，实际公开时间采用 GitHub release 的 `18:44:39Z`。

### 公开安装包的本机 Windows 单次验收

公开下载的同一 tarball 经过离线安装，以既有 `scripts/test-packed-runner.mjs` 入口在 Windows x64、Node 22.23.2、npm 10.9.3 下执行一次完整验证。执行窗口为 `2026-10-12T18:47:56.012Z` 至 `18:50:02.723Z`，外层驱动耗时 126711 ms，exit_code=0、attempt=1、`problems=[]`。实际公开包直接作为输入，源码 commit/tree/clean 和四项输入指纹在执行前后保持一致。

原始 Vitest 报告为 1 文件、41/41 通过、failed / skipped / todo=0，封存报告与工作副本逐字节一致；`EXACT_PACKAGED_RUNNER_E2E_OK 0.1.8` 出现一次。41 项覆盖安装后读取、权限、分页、文件变更、命令与队列、Context、服务发现、Git、离线快照、会话替换和正常关闭等路径。

| 并发 | 完成请求 | 失败 | p50 ms | p95 ms | 混合阶段耗时 ms |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 128 | 0 | 75 | 107 | 8998 |
| 4 | 128 | 0 | 193 | 577 | 7474 |
| 8 | 128 | 0 | 343 | 549 | 5690 |
| 16 | 128 | 0 | 579 | 1947 | 6132 |

独立复核从封存日志重新提取 16 条 load_timing 与 192 条 load_metric。四类操作和四档并发的全部组合各有一条完成记录，均为 started=32、completed=32、failed=0；完成数在响应解析、错误检查与操作结果断言通过后累加，合计 512/512。测试用例数与压力请求数分别报告。八项封存文件、四项执行输入的字节数和哈希均与收据匹配。外层预算保持 420000 ms、既有 E2E 入口预算保持 300000 ms，每输出流 8388608 字节；该次没有超时覆盖，signal 与 termination_reason 均为 null。

### 历史 Windows 失败的归属边界

Runner 与 Worker 的补充复核没有建立由现有代码和历史归档共同证明的新产品缺陷，`a259abd` 的 Windows 传输失败底层原因仍未归属。被动诊断、后续通过及公开包验收各自保留证据，不据其倒推历史故障已经根治。

一次 Windows 自有进程探针在直接父进程 exit 7 后未观察到仍存活的子孙进程；前置测试中的继承输出管道用例已有精确 PID 清理或 80 ms 自然退出路径。该观察支持保留当前生命周期实现，其覆盖限于已测试拓扑。历史 PR c8 的两次 workspace_list 客户端响应头等待为 24.345–24.380 秒，Worker header 的 server_total 为 295–308 ms。固定 native workerd 的该时钟读取宿主墙钟毫秒，客户端使用 Node 单调时钟；差值仅说明未被测得的 Worker begin→header 区间解释，不能据此指定客户端、系统、运行时调度或某一传输组件负责。

历史授权 deadline 缺少请求级关联，5 秒预算包含签名、fetch 与正文读取。SSE 首个非空块可能是 keepalive；客户端请求汇合、SDK close 和 HTTP trace 完成也不代表内部 handler 或 RunnerDO 工作全部排空。当前材料没有形成请求级因果关联或应用等待环；本轮保持请求数量、预算及生产取消语义。完整归属记录与失败原字节保存在下列索引中。

### 发布证据索引与后续验收

以下为私有归档索引，路径相对于仓库根目录；各摘要继续索引原始 run/jobs、完整日志、ZIP 及展开文件清单。公开工作流链接见本节运行表。

| 归档文件 | SHA256 |
| --- | --- |
| `.audit/e465647-ci/push-summary-20261012T1803024854476Z.json` | `9f0c2ac07e13d00c69b59c8fb7b3637ff0886280f71a1a10d08375514a324026` |
| `.audit/e465647-ci/pr-summary-20261012T1803458882658Z.json` | `db70b0d7d289961d6884a36fda170c42569caab8419eeede4b0385cd4a36dd8e` |
| `.audit/e465647-ci/pr-source-artifact-verification-20261012T180457493Z.json` | `e9448a3e400ba57f41024a2b8376f021015e4b75161ebc5247fb5be420361903` |
| `.audit/e465647-ci/policy-summary-20261012T1751337041914Z.json` | `5a53f8468363c33a43b8929310010323000f4f25088101e5a3d705de1cb11acd` |
| `.audit/e465647-ci/main-summary-20261012T1819257640675Z.json` | `b35458c3a2c1d3c6331ecafc5567f666d427e555c3a684634fb8995141263e01` |
| `.audit/release-0.1.8/release-summary-20261012T1847221248039Z.json` | `63b99db3b32f1bfde5e1ff474e761ff15ae2c1fea45a78962e9cc259f9271b75` |
| `.audit/release-0.1.8/release-job-114954733405.log` | `62f314bdd913dd44bba84a0eb80eaaab89f446b644a84a0edf41448f93addc9c` |
| `.audit/release-0.1.8/public-metadata/download-provenance.json` | `286ae332c77a8e9e872bf46a9a2f07a685bc5857389bda234ca96978b6286d71` |
| `.audit/release-0.1.8/public-metadata/independent-verification.json` | `52e3764a973f900a9583bfbcc1a5c81e798693516070bac1fe60a83d953e4a0f` |
| `.audit/release-0.1.8/signed-ci-public-comparison.json` | `35d7451b109947129467bc0c952a93c9c2f1fbedcb529ad0cef079eff8d27476` |
| `.audit/release-0.1.8/public-package-windows/receipt.json` | `4ce54e3d6408517a3d00e1cdb71f7f72fc97addfe2b7d03570bdb987fe8ff8e8` |
| `.audit/e465647-ci/success-appendix-draft.md` | `f0909f99eed573de72aaa5b2bc085da29a466fe8fd63a1ddbe0d72a161106771` |
| `.audit/e465647-ci/main-appendix-draft.md` | `9938a268f8b32b9f1b3f4a8314a1c67d6f63f25b24eb81bde57c0f4425ed36dd` |
| `.audit/release-0.1.8/publication-appendix-draft.md` | `be3dccdfa4ca347c916bad215504db806ea52cbb40fe749a9df35d7579bde8e5` |
| `.audit/release-0.1.8/windows-public-appendix-draft.md` | `3ccb67fb8f169a032b94b86881d7f15a882c77426232f243e9a8128f86908c94` |
| `.audit/e465647-ci/runner-root-cause-followup.md` | `88020c96279178f454a169a10969c706e0ccfab8db48dcb96706aacff90bf324` |
| `.audit/e465647-ci/worker-root-cause-followup.md` | `f21b118c1b3b91b14599bace867c585c5e4f49fbad2827c7bf36268ae179ceb9` |

本节确认 0.1.8 正式发布、公开资产独立校验和公开安装包的上述 Windows 验收。后续激活按受保护分支流程提交真实 publication commit 与 manifest hash，部署后以实际生产健康和稳定分发响应独立验收；不可变发布提交持续保留 `e4656476f2b7ad8f1f873c1362ef0262404c0a45`。

## `ef72e2a` 激活门禁与 Windows 版本目录修正

激活候选 `ef72e2a82128854945c70be5728ceffba46db273`、tree `3dfb8159d0f74641a34ccc8afdca11e14c9f9307` 仅包含发行状态、生成激活值、用户文档和本检查书，共八个文件。原主目录的八个暂存文件及三个未跟踪目录保留。本机文档、发行契约、类型、格式和空白检查通过后，候选推送到 dev 并建立 [PR120](https://github.com/aloneio/runmesh/pull/120)。dev 推送返回绕过 PR 与两项状态检查的 provider 警告，原文完整归档；没有将该警告描述为受保护 main 验收。main 的管理员保护、来源策略和 verify-all 要求保持启用。

| 原始执行 | 来源身份 | 结果 |
| --- | --- | --- |
| [push CI 38295144099](https://github.com/aloneio/runmesh/actions/runs/38295144099)，attempt 1 | `ef72e2a82128854945c70be5728ceffba46db273` / tree3dfb8159 | 8/8 jobs 成功，28/28 gates 通过；Windows transport 41/41、512/512 混合请求 |
| [PR CI 38295152345](https://github.com/aloneio/runmesh/actions/runs/38295152345)，attempt 1 | 合成提交 `2c46ad93d269c2043371c76ae74a8fbd070ba169` / 同一 tree | Windows native 和汇总失败，其余六个 jobs 成功；27 gates 通过，Windows transport 为 not_run |
| [来源策略 38295152342](https://github.com/aloneio/runmesh/actions/runs/38295152342)，attempt 1 | 同源 dev → main / PR120 | `main-source-policy` 成功 |

PR Windows job `114964335473` 的 Runner 单元测试记录 1,500 通过、1 失败、142 跳过，共 1,643 项。唯一失败为 `release-stager.test.ts` 的首个签名旧版本安装用例：新复制的运行时完成版本探测后，`commitStagingDirectory` 对其父目录执行 `.staging` → 最终目录的 rename 返回 `EPERM`。失败发生在既有六次尝试、五次 50 ms 等待耗尽后；单元步骤之后的 Windows transport 没有执行。push Windows 的独立成功记录保留：transport gate 129579 ms，并发 1/4/8/16 各 128 请求、零失败，p95 分别为 509/565/714/1025 ms。成功记录不覆盖 PR 的失败。

两路八份作业日志、三份 CI ZIP 及其展开文件已完整归档。PR 的原始失败日志提前封存，63743 bytes、SHA256 `3763c85180890c1af61f186790dfb2c2a57692fb63271be7526541dea41d416e`。push 汇总 `.audit/ef72e2a-ci/push-summary-20261012T1917121729312Z.json` 的 SHA256 为 `a328afe2784dc13fcd9a2cf0e69286047ada027153194933ba52f9a9c7610796`；PR 汇总 `.audit/ef72e2a-ci/pr-summary-20261012T1913525074471Z.json` 的 SHA256 为 `6de55fb2b2fe20374ba7b9583bc564fa34a06f9c80f2fd0f6301f7641013c19b`。本候选未提升 main、未推送 GitLab dev、未部署生产，也未重跑原工作流。

独立代码复核确认：首个失败夹具在内存中构建压缩包与响应，目标脚本仅输出版本；文件级测试在 Windows 串行执行。产品已在成功、失败和取消路径等待版本探针 `close`，因此当前证据不支持“遗漏等待子进程退出”的解释。日志未记录锁持有者，不能将 `EPERM` 归因于特定扫描器或残留进程。确定的设计依赖是：运行刚复制的 Windows 可执行文件后，仍必须立即重命名包含它的目录。

0.1.9 候选将完整版本树先放到唯一最终路径，再用该路径下的私有运行时与目标 bundle 执行原版本探针，成功后写入发行回执并返回。成功 rename 后立即更新自有目录变量，失败和取消清理实际自有目录，保留操作原错与清理错。探针的 15000 ms、65536 字节、关闭等待、强制终止语义及目录提交的五次 50 ms 等待均保持原值。

协调器只有收到 stage 的成功结果并核对版本、摘要后，才持久化 next 并进入 draining/switching。安装指针仅解析明确传入的目录与 current；它不扫描 versions，也不以发行回执作为授权凭据。目录放置后、探针完成前的崩溃可能留下未选中的私有目录，与原暂存孤儿同属清理范围；已有 claimed 记录恢复为失败，不自动激活该目录。对应测试分别验证实际探针路径、错误版本、非零退出、取消、清理双错，以及 stage 挂起或拒绝期间保持原安装。

该修正改变已经发布的 Runner 产品字节，因此使用新的 0.1.9 版本与候选发布状态，0.1.8 的不可变标签、清单和安装包保留。后续验收按新源码身份记录。

### 目录顺序修正的定向验证

在固定 Node 22.23.2、npm 10.9.3 的本机 Windows 环境中，单次执行 `release-stager.test.ts` 与 `update-coordinator.test.ts`，共 142/142 项通过（43 + 99），失败、跳过及 todo 均为 0，Vitest 耗时 18.89 秒。该结果绑定 `ef72e2a` 基础上的修改工作树，三项直接源码与测试文件在执行前后字节一致；不将尚未提交的工作树标为干净提交。

| 已测文件 | SHA256 |
| --- | --- |
| `apps/runner/src/updates/release-stager.ts` | `f71835d0aa6180a49c77f4c3438fabac64bd5b63860b875d1642bad5f78e8993` |
| `apps/runner/test/release-stager.test.ts` | `6cd376125560dba8ebda24e5032211d5806e0fcadb4a9fa429dd025c2a3c8045` |
| `apps/runner/test/update-coordinator.test.ts` | `8904f2f4f3bc9a4176e28c5817681a06fe75cb8a498cbfceaa0d80d6c235a5e1` |

收据为 `.audit/stager-0.1.9/targeted-receipt.json`。原始日志 SHA256 为 `9cb058736907327208f10982fde29d3f8eb48e8f075e4032d67d9c435119f8eb`；原始 Vitest JSON 为 50382 字节，SHA256 为 `b9022d97c424e87cb7508a90c55ced693b634c92c2edb944d61aba9d4d2f054b`。Vitest 按 Runner 配置根目录写出的报告与私有归档副本逐字节一致。

### 已有独立管理器的修复送达路径

升级链路复核发现 A13：管理器安装逻辑保留已存在的独立程序，普通 Runner 版本切换只替换所选 Runner。此隔离保护了版本切换的控制进程，同时意味着已有管理器继续使用原版本的暂存器。为使 A09 的新实现送达已有安装，0.1.9 增加显式 `manager-refresh`，由管理员从独立校验的发行目录调用新维护入口。

刷新目标固定为维护入口的编译版本；签名直接验证 `manifest.json`，清单中的包大小和摘要认证 tarball，再从中取得维护入口字节并核对当前执行入口。替换范围为 `manager/runmesh.cjs`，原 Node、manager ID、配置、历史记录、Runner 版本目录与 current 均保留。刷新与版本切换共用安装锁；本地 `active-operation.json` 即使已进入终态也需先由原管理器完成上报与收尾。中断恢复依据持久化记录和新旧 bundle 摘要判定，恢复原启用及运行状态。对应实现、独立复核与测试结果随实际验收补充。

实现同时核对磁盘服务定义与实际注册的 systemd、launchd 或 Task Scheduler 启动参数；Windows 任务按 COM `Principal.LogonType` 枚举核验，Linux 与 macOS 核对实际有效启动参数。原本停止、禁用、已注册但空闲，以及“禁用但仍有运行实例”的状态均按原状态恢复；启动和停止过渡在固定截止时间内观察，不将队列或启动中的中间态当作稳定状态。租约在每次服务、文件和恢复记录变更前后复核；租约丢失时停止后续写入和启动。
### 0.1.9 管理器刷新与版本提交回归

固定 Windows Node 22.23.2、npm 10.9.3，本地单次执行五个相关测试文件，共 240/240 项通过，失败、跳过及 todo 均为 0，耗时 28.50 秒。覆盖管理器刷新事务 45 项、原生平台状态 6 项、维护 CLI 47 项、版本目录提交 43 项和协调器 99 项；测试文件之间按 Runner 配置串行执行。源码树在执行前后保持一致，工作树状态为 dirty，未把该结果伪装成已提交源码。

| 项目 | 结果与收据 |
| --- | --- |
| 统一定向回归 | `.audit/manager-refresh-0.1.9/final-targeted/receipt.json`；原始 Vitest JSON 80705 字节，SHA256 `adc8f0723112249da72a43c31c555035bd0bf91ddf70b477cbfaa396906e7985` |
| 标准输出 | 1634 字节，SHA256 `aa95e8d98ef28375628672e982b2285a5798f4dec1ea7a0bec2b1cfabc808cd4` |
| 输入源码指纹 | `b98fbf55892d2dd84d66c2ecb84343e5a678638ad4399c14caba0d3a274fe370`（收据中的文件集合摘要） |
| 真实 Windows 刷盘补充 | 只读句柄 `fsync` 返回 `EPERM` 的观察保留在 `.audit/manager-refresh-0.1.9/windows-readonly-fsync.json`；读写句柄 `fsync` 成功且内容未变，见 `windows-readwrite-fsync.json`。实现已采用 Windows 读写句柄，并由真实临时文件回归覆盖。 |

回归矩阵包括错误签名、摘要、归档条目、入口字节和 Node 版本下限在原生变更前拒绝；已有安装锁忙碌、所有活动阶段记录（包括终态记录）、安装身份或状态目录链接、服务实际定义漂移均不停止服务。事务测试验证候选探针失败、替换失败、启动失败、租约丢失、恢复失败时保留双错和恢复文件；提交完成后清理失败不会回滚已验证的新管理器。原 Runner 选择、配置、身份、工作区和管理器私有运行时在各平台夹具中逐字节保留。

随后对原生适配最后一轮恢复边界（已注册但空闲的 launchd、启动过渡、外部启动后恢复停止、Windows 排队任务及 COM 登录类型）与核心事务重新执行 51/51 项，失败、跳过及 todo 均为 0；该轮收据 `.audit/manager-refresh-0.1.9/native3/receipt.json`，Vitest JSON SHA256 为 `c85644e02256968b066d03c223766f7fefc74380ae31f56b9f29275d79729414`。前述 240 项收据仍保留，作为全范围基线；51 项复验覆盖其后 native 状态修正。

### 0.1.9 候选完整 Runner 与安装包压力回归

在固定 Windows Node 22.23.2 环境中，完整 Runner 回归覆盖 74 个测试文件，1,588 项通过、142 项按平台跳过、0 项失败，执行耗时 407.80 秒。管理器刷新专项随后独立复验 52/52 项通过；两类结果分别计数，不将专项用例重复计入完整 Runner 总数。

同一候选的打包安装包 E2E 使用实际生成 tarball，41/41 项通过，失败、跳过及 todo 均为 0；并发 1、4、8、16 各完成 128 次请求，共 512/512。四档请求 p95 分别为 84、236、324、511 ms。安装包大小为 1,249,156 bytes，SHA256 为 `c7fc2d97ceb550738e303e129ae18544f19574e609d895f8093d674045dc255c`；完整收据为 `.verification/package-e2e.json`，其中明确记录来源提交 `ef72e2a82128854945c70be5728ceffba46db273`、dirty 工作树、Node `v22.23.2` 及未签名未发布状态。

本机门禁在该候选上重新通过：文档与项目事实、格式、架构、版本、验证清单、测试收集、类型检查、构建和 pack smoke 均成功。文档面向使用者描述升级、管理器刷新与恢复步骤；内部测试身份、失败原文和根因取证继续留在本检查书及 `.audit/` 归档中。

### 历史 Windows 传输故障的当前根因边界

对 `a259abd` 的 push/PR 原始工件、Runner、Worker、native launcher 与新诊断记录的交叉复核，确认客户端在 `fetch` 尚未交回 `Response` 时失败，同时保留了失败后的 Worker 聚合快照。两组观察缺少同一请求标识和同一时刻的跨进程采样，因此仍不能区分请求发送前或到达前、Worker 处理期间、响应返回链路以及取消收尾中的具体边界。现有材料没有请求级 socket cause、连接复用/空闲状态与 native ingress 首包之间的关联，因此不能把故障归因于某个 TCP、keepalive、客户端、系统调度或单一传输组件。

当前候选已补充被动诊断并完成源码、安装包及 512 请求压力验证；这些结果证明诊断不改变功能路径，也没有复现历史失败。下一次托管 Windows 故障需要同时保留 Undici 的连接建立、发送、响应头、trailer/error cause、socket 复用/空闲/字节计数，以及 native listener 的首包和 dispatch ingress 时间，才能继续完成请求级归因。故障归属保持开放，不据通过结果宣称历史问题已经根治。

### 2026-10-13 迟到 I/O 生命周期修复与复验

本轮在上述边界内继续检查所有带有有限截止时间的网络和流读取路径，定位到同一类可复现的生命周期缺陷：调用方已因超时或取消结束，但底层传输仍可能忽略 `AbortSignal` 并在之后交回 `Response` 或完成挂起的 `reader.read()`；原续体随后仍可能触碰响应正文或提前释放读取锁。该路径会把已结束请求的异步工作带入后续 Worker/Runner 生命周期，属于高风险资源边界问题。

修复覆盖 Worker 的有界 JSON 收据、开发版本 Registry 缓存写入、MCP 再授权与请求体读取，以及 Runner 的注册请求、版本包下载和维护接口。超时或取消现在先封闭观察状态；迟到 `Response` 被隔离，不再读取或取消其正文；已取得的正文读取器在挂起读取完成后再释放锁。正常完成仍保留原有正文消费、状态判断、授权和资源清理顺序。

当前源码候选提交序列为 `87cd398`、`132352a`、`a4bb12f`、`26bd257`、`02b79fc`，基于 `a92b782`。本机固定 Windows Node `v22.23.2`、npm `10.9.3` 的复验结果如下：

| 验证面 | 结果 |
| --- | --- |
| Worker 全套 | 115 个文件，2,540 项通过，0 失败 |
| Runner 全套 | 74 个文件，1,589 项通过，142 项平台跳过，0 失败 |
| Domain / Contracts / Protocol | 537 / 50 / 57 项通过 |
| 迟到 I/O 定向回归 | Worker 380 项；Runner 181 项（4 项平台跳过）；均 0 失败 |
| 类型检查 | Worker、Runner 通过 |
| 文档、事实、格式检查 | 通过；0.1.9 candidate 合约一致 |

Worker、Runner 全套均在修复后的当前源码上完成；安装包 E2E 与跨平台托管门禁须在清洁提交推送后重新生成收据，不能复用此前 dirty 工作树的报告。安全回归仍以 Linux 门禁为准，正式标签、双 provider main 同 SHA、发布工作流和生产激活在这些外部证据齐备前保持候选状态。

### 2026-10-13 发布预检与发行物读取边界复核

后续逐条复核发现发布预检、开发发行物发现、精确版本校验及 provider 证据读取仍共享同一类截止时间边界。现已在 `fetch` 返回后增加请求所有权栅栏；外层截止时间结束后，迟到响应不会再被读取、解析或主动取消。发行物正文读取增加可中断的 `reader.read()` 等待，取消后立即结束调用，待读取完成后再释放 reader lock；重试逻辑在所属刷新已结束时直接收敛为超时，避免迟到响应再次占用刷新预算。

本轮验证：发布工具、实时来源、跨 provider、开发发行物和 UI 诊断脚本测试共 95/95 通过（另 1 项按平台条件跳过）；Worker 开发发行物分发回归 168/168 通过；Worker 与 Runner 类型检查、版本、格式和架构检查通过。该修复尚未改变正式版本状态，0.1.9 继续保持 candidate，清洁提交后的跨平台 CI、双 provider main 同 SHA、签名标签与生产验收仍是发布前置条件。

### 2026-10-13 Windows 原生传输复核与本地代理边界修复

针对历史 Windows 门禁中复用连接上的 `ECONNRESET`，对请求时序、Worker 进程生命周期、响应读取和 Wrangler 依赖链进行了交叉复核。`.audit/04d50ba-ci/upstream-issue-14641.json` 保存的上游复现给出了稳定的时间关系：Wrangler 本地 ProxyWorker 到 UserWorker 的两端 keep-alive 都采用约 5 秒空闲窗口，固定 5 秒发送节奏会让代理复用刚由内层关闭的连接。该请求在收到响应字节前被关闭，非 GET/HEAD 请求直接得到连接丢失；因此 `job_logs` 的 POST 会表现为 `ECONNRESET` 或代理生成的 5xx。Worker 业务代码、Runner WebSocket 和原生进程均没有对应的退出或重启证据。

这属于 Wrangler 本地开发代理的外部实现边界，当前版本无法从 Runmesh Worker 代码中改变其内层连接池。项目内的传输和安装包验收已改用 Wrangler 同一依赖链提供的原生 Worker HTTP 入口，绕过有问题的 ProxyWorker 跳转；需要验证代理行为的测试显式保留 `transport: "proxy"`。fixture 默认入口改为原生运行时，防止新增压力测试无意间重新进入该外部连接竞态，同时保留代理专门测试对参数和错误面的覆盖。该调整没有改变生产 Worker 的请求路径或用户协议。

修复后的 Windows 本地验证覆盖源码和安装包传输各 41/41 项，混合负载 1、4、8、16 并发各 128 次请求，共 512/512 成功；Runner、Worker、发布工具和文档门禁均通过。历史代理竞态的根因、复现条件和边界保留在本检查书与 `.audit/` 证据中，面向用户的文档只描述稳定的安装、升级和运行方式。

本机复验还记录了运行时门槛的分离结果：Node `v24.19.0` 按项目版本策略在 enrollment CLI 启动前被拒绝，随后使用锁定的 Node `v22.23.2` 重新执行同一源码 E2E，41/41 项通过，1、4、8、16 并发各 128 次请求均为零失败。该次失败属于本机工具链选择，不属于传输实现或 Worker 业务回归；托管 Windows 工作流使用锁定版本并以其结果为准。

### 2026-10-13 0.1.10 取消完成判定修正与根因边界

本轮继续检查维护响应和发行物读取在取消时的完成判定。修复在记录成功前再次检查 `AbortSignal`：当正文已经完整到达、但底层流的关闭或 EOF 仍在等待时，如果取消先到达，调用会保留取消结果并结束后续读取；只有在完成检查时仍属于当前请求，才记录成功。这样可以让中断更新安全重试，并避免迟到的流收尾把取消操作标记为成功。

定向验证包括 Runner `update-cloud` 27/27、Worker 开发版分发 170/170，以及 Worker、Runner 类型检查，均通过。0.1.9 继续是已公开的 immutable stable release；0.1.10 仍处于 candidate 准备阶段，尚未发布或激活到生产。

本节同时固定历史 Windows 传输故障的归属边界。上游 issue #14641 所示约 5 秒 keep-alive 代理竞态，是 Wrangler `ProxyWorker` 与 `UserWorker` 之间的独立机制；它解释的是本地代理链路在固定节奏下复用已关闭连接的现象。`a259abd` 的源码和公开安装包验证均显式使用 native transport，并没有把该失败放在同一代理路径上。现有工件缺少与请求对应的 socket cause、native listener 首包和 ingress 时间关联，因此不能声称 `a259abd` 的历史 native 失败已由 #14641 归因。两条证据链继续分别记录，后续若需完成 native 故障归属，必须取得请求级跨进程网络证据。

### 2026-10-14 0.1.10 根因修复、跨平台门禁与发布前复核

本轮针对托管 Windows native transport 的 `ECONNRESET` 完成请求级边界复核。失败表现为请求在响应头返回前遇到已被 Worker 回收的旧 HTTP socket，Worker 与 Runner 进程均保持运行。最终测试修复在 MCP E2E 请求中使用 `Undici Agent({ pipelining: 0 })`，让每个请求使用独立连接，避免依赖 native server 的 HTTP socket 生命周期；测试收尾显式释放请求资源。该修复对应 `test/e2e/mcp-runner.e2e.test.ts` 的 native transport 变更，保留原生入口与 proxy 专项覆盖的边界。

| 验证面 | 结果 |
| --- | --- |
| Windows 本地源码与安装包 E2E | 各 41/41 通过，0 失败、0 跳过 |
| Windows 本地混合负载 | 并发 1、4、8、16 各 128 请求，合计 512/512，0 失败 |
| GitHub CI | main push run `38441360445` 的 8 个 jobs 全部通过（Windows `115454776507`、verify-all `115460142627`），提交 `e06b2b695f59a576c4d30b60698bea512934e3b3` |
| GitLab 受保护分支 | pipeline `2943538161` 的 verify、browser、Workers Builds 全部通过，提交 `6d5da177ad27f4a7464a96c27bb0c65f81a45c93`；两端源码树一致，最终提升将把受保护 main 对齐到同一提交 |
| 面向用户的文档 | `docs` 发布说明提交 `d38e33992c69ef23f5163ee4d9b46dcf212fd24b`，中英文发行状态与版本说明均切换到 0.1.10 正式版表述 |

本节记录的是发布前的源码、门禁与文档证据。正式 `v0.1.10` 标签、签名公开资产、manifest 校验和、release-state 的 `released` 记录以及生产 `/health` 和 `/runner/releases/stable` 验收，待发布流程完成后另行追加；本节不将尚未取得的发行物或生产响应计为已完成。
