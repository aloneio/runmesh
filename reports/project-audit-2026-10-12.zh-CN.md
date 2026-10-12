# Runmesh 项目检查书

检查日期：2026-10-12（Asia/Shanghai）

检查基线：`dev`，`115ba45`
阶段：12 项检查发现已完成对应修正，用户文档已整理。最新诊断提交 `a455499` 的 push CI 全部成功，PR CI 的 Windows 压力验证触及既有 300 秒上限，汇总检查随之失败。正式发布仍受该门禁阻塞，0.1.8 尚未正式发布或激活。线上健康检查通过，稳定分发保持 0.1.7；已验证的开发预发布为 `v0.1.8-dev.63`。

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
| A09 | P2 | Windows 暂存运行时退出后的短暂文件占用会影响暂存提交与清理；测试清理错误还可能覆盖阶段原错。位置：`apps/runner/src/updates/release-stager.ts`、`apps/runner/test/release-stager.test.ts`。 | 私有暂存提交和清理使用有限重试，取消保留调用方原因，双重失败保留主错及清理错。39/39 项定向验证通过；新候选仍需完整安装升级验收。 |
| A10 | P2 | 两处原生测试的提前失败路径未完整回收测试进程：Runtime 的失败终止夹具仅在主路径停止子进程；Windows 锁夹具在持有者未就绪时无法解除维护子进程等待。位置：`apps/runner/test/runtime.test.ts`、`apps/runner/test/update-launchers.test.ts`。 | 测试持有的进程在收尾时独立停止并等待 `close`；维护夹具具有独立停止信号和自身截止。两文件 118 通过、4 跳过，包含 stop/deadline 故障分支。该发现限于测试提前失败路径，不能解释单元测试全通过后的网络失败。 |
| A11 | P2 | 补丁回滚测试在操作原错发生后仍断言 `external` 已创建，可能以 `undefined` 断言覆盖真正的首个异常。位置：`apps/runner/test/patch-persistence-failures.test.ts`。 | 已保留操作原错，28/28 项定向诊断验证通过；在新候选 Windows 完整测试中继续复验回滚行为。该项属于证据完整性修复。 |
| A12 | P2 | MCP 再授权在完整读取有效 200 收据后仍取消 reader 并触发 AbortSignal，使正常完成与失败清理采用同一取消路径。位置：`apps/worker/src/mcp/reauthorization.ts`。 | 完整有效收据（允许及有效主体不匹配的拒绝）释放读取锁并清除计时器；失败、超时、未读正文和迟到回执继续取消。45/45 项定向测试通过，独立复核通过；该资源生命周期修正与 Windows 网络故障的关系另行验证。 |

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
