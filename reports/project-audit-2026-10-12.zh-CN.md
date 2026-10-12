# Runmesh 项目检查书

检查日期：2026-10-12（Asia/Shanghai）

检查基线：`dev`，`115ba45`
阶段：候选 `5984ae8` 在干净源码上完成 Windows 本机源码与安装包 E2E，各 41/41 通过，每组混合负载完成 512 请求、0 失败。托管 push 与 PR 的 Windows Runner 单元测试各 1,494 通过、142 平台跳过，后续网络 E2E 分别记录 1 与 2 项失败。两侧 Linux verify 同时发现 Registry 索引写入成本的历史断言需更新；其余原生平台、Node LTS 与浏览器 jobs 成功。精确成本断言修正后的本机完整 Worker 2,459/2,459 通过，原候选失败证据完整保留。Windows 网络首因继续定位，0.1.8 保持 candidate。

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

## 验证矩阵

下表中的候选结果绑定 `5984ae8609373390230b6a97b9f6993dec173d89`，源码树 `2360913788b45611b3a737c940c8fbe177c57640`；更早提交的结果按源码身份保留在下文。成本断言及后续修复使用新提交重新完成门禁。不同专项与完整测试存在覆盖重叠，计数分别列示。

| 功能面 | 验证内容 | 当前证据 |
| --- | --- | --- |
| 协议与 API | Schema、帧编解码、输出契约、分页、客户端选择 | 本地退出码专项 106 项通过；候选 Linux protocol 57 项、contracts 50 项通过。 |
| 任务与连接 | 并发排队、输入、取消、完成、持久化、恢复、重连 | 本地新一轮 Runner 功能负载 594/594 通过；候选 Linux Runner 单元测试 1,600 通过、36 跳过。Windows 本机源码与安装包 E2E 各 41/41、混合请求各 512/512；托管 push/PR 的 Windows 网络 E2E 分别失败 1/2 项。 |
| 工作区 | 文件、搜索、Git、补丁、Context 存储 | 本地真实文件/Git/Context 并发负载、候选 Runner 完整套件及本机两组网络 E2E 通过；云端网络首错继续定位。 |
| 中央能力 | Skills 迁移与版本、远程 MCP 目录与调用、OAuth 状态 | 本地迁移专项 42 项及集成 28 项通过；候选 Worker 单元测试 2,458 通过、1 项 Registry 成本断言失败。历史 Skills 512 请求证据保留原提交归属；该候选 Linux 后续门禁为 `not_run`。 |
| 管理界面 | 登录、导航、Runner、客户端、Skills、语言及窄屏 | 候选 push 与 PR 的 browser job 均成功，浏览器 E2E 各 5/5、0 跳过；历史根级 UI/导航 305 项证据按原提交保留。 |
| 安装与升级 | Windows/Linux/macOS 服务、安装锁、排空、更新恢复 | 候选 Linux/macOS native jobs、Node 22.23.2/24.21.0 LTS jobs 成功；push/PR Windows Runner 单元测试各 1,494 通过、142 平台跳过，随后网络 E2E 失败。 |
| 发布物 | 编译、打包、离线安装、包级端到端、签名与校验和 | 固定工具链本地构建通过；候选 Windows 本机安装包 E2E 41/41、0 跳过，包 1,206,785 字节，签名与发布状态均为 false。正式签名制品另行验收。 |
| 文档与治理 | 文档链接、版本事实、许可证、架构、测试收集、CI 一致性 | 本地文档契约 39 项、安全配置 10 项及 963 个链接、30 个锚点通过；候选托管文档、runbook、架构、类型、CI 策略与 main-source-policy 通过。完整 verify 在 unit 门禁停止。 |
| 正式发布 | 同一候选提交双端 CI、受保护 dev→main、签名发布、激活与线上来源 | 候选 GitHub push、PR 为 failure；开发预发布 cadence 成功且 due=false，plan/verification/build/publish 按节奏跳过。[PR118](https://github.com/aloneio/runmesh/pull/118) 的 main-source-policy 成功。现有生产为 0.1.7；0.1.8 的双端 main CI、签名发布与 activation 按后续证据验收。 |

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
