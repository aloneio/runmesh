# Runmesh 项目检查书

检查日期：2026-10-12（Asia/Shanghai）

检查基线：`dev`，`115ba45`
阶段：候选 `510bc2a` 的本机源码、安装包及托管 push 验收通过；PR 侧 Windows 网络 E2E 仍有 2 项失败。首错取消和诊断补充已通过定向验证，准备新候选完整验收。

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
| A06 | P2 | 网络负载首错后的主动停止、在途请求取消与汇合需要完整绑定；失败工件曾遗漏负载进度、内部运行时生命周期和控制面失败阶段，Windows ASCII 日志前缀也未被识别。已有测试 HTTP 作用域会在结束时取消请求，因此该缺口本身不能解释首次 Windows 故障。 | 已实现首错快照、停止领取、主动取消与请求汇合，13/13 项定向回归通过；前置控制面 217/217、日志诊断 17/17 项定向回归及架构、类型检查通过。新增完整门禁待执行。 |

## 验证矩阵

下表中的托管结果绑定候选 `510bc2aa98e4caf7d459b2e4c8cdd6dd397f57e3`；更早提交的结果按源码身份保留在下文。后续首错取消修改需使用新提交重新完成门禁。不同专项与完整测试存在覆盖重叠，计数分别列示。

| 功能面 | 验证内容 | 当前证据 |
| --- | --- | --- |
| 协议与 API | Schema、帧编解码、输出契约、分页、客户端选择 | 本地退出码专项 106 项通过；候选 Linux protocol 57 项、contracts 50 项通过。 |
| 任务与连接 | 并发排队、输入、取消、完成、持久化、恢复、重连 | 本地 Runner 负载 594 次操作通过；候选 Linux Runner 单元测试 1,564 通过、34 跳过，源码与安装包网络 E2E 各 41/41；Windows 本机源码、安装包及托管 push E2E 均 41/41，PR 侧 2 项失败。 |
| 工作区 | 文件、搜索、Git、补丁、Context 存储 | 本地真实文件/Git/Context 并发负载通过；候选 Runner 单元测试及 Linux 网络 E2E 通过。 |
| 中央能力 | Skills 迁移与版本、远程 MCP 目录与调用、OAuth 状态 | 本地迁移专项 42 项及集成 28 项通过；候选 Worker 单元测试 2,422 项通过，Skills 四档共 512 请求、0 失败；本机曾出现的瞬时失败保留在下文。 |
| 管理界面 | 登录、导航、Runner、客户端、Skills、语言及窄屏 | 候选 push 与 PR 的 browser job 均成功，push 浏览器 E2E 5/5；根级 UI/导航测试 305 项通过。 |
| 安装与升级 | Windows/Linux/macOS 服务、安装锁、排空、更新恢复 | 候选 Linux/macOS native jobs、Node 22.23.2/24.21.0 LTS jobs 成功；两侧 Windows Runner 单元测试均 1,457 通过、141 跳过。Windows native push 成功，PR 因网络 E2E 失败结束。 |
| 发布物 | 编译、打包、离线安装、包级端到端、签名与校验和 | 候选 Linux 构建、包校验及安装包 E2E 通过；该测试包未签名、未发布，正式签名制品另行验收。 |
| 文档与治理 | 文档链接、版本事实、许可证、架构、测试收集、CI 一致性 | 本地文档契约 39 项、安全配置 10 项；文档调整后，145 份 Markdown 的 963 个链接和 30 个锚点通过；候选 verify job 与 main-source-policy 成功。 |
| 正式发布 | 同一候选提交双端 CI、受保护 dev→main、签名发布、激活与线上来源 | 候选 GitHub push 总门禁成功，PR 总门禁失败；[PR118](https://github.com/aloneio/runmesh/pull/118) 为 ready。正式版本仍为 0.1.7，0.1.8 的双端 main CI、签名发布与 activation 尚待完成。 |

## 判定原则

测试记录保留命令、环境、源码身份、通过/失败/跳过数量及负载指标。失败经修复后使用新证据复验。已通过的本地测试只证明其覆盖范围；原生平台、托管 CI 与正式部署使用各自证据。正式版本号、发行状态及校验和以实际发布结果为准。

## 修复与验收记录

### 已完成的修复

- A01：迁移按 rowid 每次读取一条记录，读取游标耗尽后再写入。保留完整事务，新增第 13 条写入失败后的回滚与重试验证。最初直接遍历游标的实现被新回归发现会在重试时保留 SQLite 读取锁，已改为有界分页。
- A02：本地记录、MCP 输出和 Context 证据共享完整的原生退出码范围。保持 v2 完成通知的既有范围；超范围退出码在该摘要中表示为 null，详细任务结果保留真实值。真实 Windows 子进程的 3010 与 3221225477 已通过完成和恢复验证。
- A03：23 份历史审计记录归档至 `reports/history`，保留失败事实和后续验证。用户文档按安装、配置、升级与恢复组织；发行后的界面改动从 0.1.7 说明移入 0.1.8 候选说明。
- A04：错误分类从实际错误消息识别超时，避免将通用堆栈包装函数当作原因；8 项轻量回归通过。
- A05：Runtime shell 发现加入有界重试与共享恢复，修复和恢复验证已完成；36 项定向回归与本机完整网络 E2E 41 项通过。首次 shell 发现失败的具体原因尚未捕获，缓存缺陷与触发原因分别追踪。
- A06：在 `510bc2a` 的首错快照、停止调度与请求汇合基础上，进一步加入首错主动取消在途 HTTP 请求。13/13 项定向回归及 TypeScript 检查通过，等待新提交的完整验收；该修复结论限于测试任务收尾。

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
| 测试首错取消 | A06 后续修复的 13/13 项定向回归及 TypeScript 检查通过，完整门禁待新提交验收 |
| Runner 本地负载 | 594 次操作通过，18 个成功任务与 4 次取消；详见 [Runner 验证记录](runner-validation-2026-10-12.zh-CN.md) |
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

### Skills 历史观测

Skills 新负载夹具在准备阶段曾出现瞬时 `skill_unavailable`，直接服务预检成功；后续成功运行分别保留在 [Skills 验证记录](skills-validation-2026-10-12.zh-CN.md)。新增安全阶段诊断后的一次串行运行完成 512 请求、0 失败，P95 为 67 / 208 / 703 / 546 ms。前次失败的原始阶段未被捕获；成功复测不抹去先前记录，也不作为历史根因已修复的证明。

候选版本为 0.1.8，源码发行状态保持 candidate。正式发布、双端 CI 与线上激活将按实际执行结果补录。

### Windows 首次故障的诊断补充

A06 的修改保留每档 128 请求、并发 1/4/8/16、每档 60 秒测试时限及生产控制面 5 秒预算。`510bc2a` 已在首错后停止发起新请求并等待同组请求结束；后续修改进一步主动取消在途 HTTP 请求，汇合全部任务后重新抛出首错，HTTP 作用域同时保留测试超时取消。首错快照在取消前冻结，区分响应头与响应体等待；准备阶段单独标记。主动取消修改已通过 13/13 项定向回归及 TypeScript 检查，尚待新提交完整门禁。

已补充的控制面诊断包括 Registry 初始化与 HTTP 请求、Runner 请求、内部签名与传输、最终授权回执；运行时诊断包含 Miniflare 内部重启等固定分类。日志与工件仅输出固定阶段、原因、状态和有界计数。首批控制面定向回归 38/38、诊断定向回归 16/16 已通过。

`510bc2a` 后补齐前置 `reauthorizePrincipal` 与 Registry RPC 路径的九个固定阶段，以及现有碎片上限对应的 `fragment_limit` 分类。200 成功、404 缺失、403/409 权限拒绝、合法 202 延迟审计回执均保持静默；签名异常仍原样抛出。两个 Worker 定向文件共 217/217 项通过，架构检查覆盖 472 模块、2,402 条依赖边、0 环，TypeScript 和差异检查通过。另使用 Wrangler 实际依赖的 esbuild 0.28.1 验证 Windows `X [ERROR]` 格式，修正严格日志解析器，17/17 项定向回归通过。

只读运行时源码核对发现，Miniflare core 的外层 `service.fetch` 异常路径可以返回无专用诊断头的文本 500，且无需经过 ProxyWorker 的 fetch 拒绝日志。因此缺少代理事件不足以排除该路径；目前没有证据确认它是本次故障来源。正常 MCP 请求与响应的成功路径均完成正文读取，已安装的 Miniflare loopback server 也已设置 `keepAliveTimeout=0`。这些核对结果用于约束后续判断，现有证据确认了测试收尾与观测缺口，Windows 初始故障原因尚待确认。
