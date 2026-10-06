# 模块职责与回归检查

移动模块或修改适配器时，可按本文确认职责和验证方法。AR 编号用于追溯历史实施阶段。
参见[英文版](architecture-remediation.md)；组件部署按[升级指南](upgrading.zh-CN.md)执行。

## 职责与依赖方向

Runner 的 Git 基线判断位于 `git/baseline.ts`；`git-service.ts` 负责解析工作区
并设置观察期限。`git/execution.ts` 管理进程上限与请求内快照清理。状态与索引
标志共用一个隔离上下文，最后的 HEAD 查询重新创建上下文。不跨请求缓存快照
或 I/O Promise。基线回归通过操作边界验证并发索引变化和预算耗尽。

| 层 | 职责 | 应放在其他层的依赖 |
| --- | --- | --- |
| Worker 入口 | fetch／scheduled 装配、顶层分发 | 重复的业务决策 |
| HTTP | 解析、认证、CSRF、响应格式 | Registry 实现与持久化记录类型 |
| Application | 生命周期／策略编排、数据投影 | HTTP、页面、平台适配器、Registry facade |
| Contracts／Domain | 稳定类型、窄接口、纯决策 | 平台与表现层实现 |
| MCP Server | SDK 装配、逐次授权、输出验证 | Registry、RunnerDO 具体类 |
| MCP Results | 安全字段投影、有界输出 | 处理器、派发、审计、传输执行 |
| Views | 同步呈现明确的视图模型 | Registry 记录和 HTTP 操作 |
| Registry | 单一权限与事务所有者 | 领域模块中的页面依赖 |
| Runner 协调者 | 状态转换、持久化与副作用顺序 | 同一状态的其他竞争所有者 |

`scripts/architecture-policy.mjs` 将依赖矩阵作为检查规则。普通导入、类型导入、
重新导出、字面量动态导入和浏览器源码均受检查。新增平台适配器需要显式登记。
无法解析或动态计算的依赖、运行时环和包含类型边的环都会失败。负向回归覆盖
反向依赖、facade 回引和改名后的中间模块。

## 共享用例与展示模型

`application/delete-runner.ts` 管理网页和管理员 API 共用的删除顺序：
确认、唯一变更 ID、fence、状态观测、取消和收尾。各入口先完成请求认证，
再调用用例。保留拒绝、依赖故障和结果未知的区别；决定重试前先核对结果不明的变更。

Registry 管理 HMAC 路由与同步事务，RunnerDO 管理会话派发。
`contracts/admin-views.ts` 定义展示类型，`application/admin-projections.ts`
在授权后选择字段。凭据校验值由权限层保管。MCP 工作区元数据省略配置的绝对根路径；
请求的文件内容和命令输出仍可能带有路径。

认证回执、注册和 Runner 查询通过 `contracts/control-plane-receipts.ts` 的操作端口
接收依赖。平台适配器管理签名请求、有界响应读取和机密访问，由 HTTP／入口层注入
业务用例。Application 模块不能导入平台模块，包括平台类型。MCP 和管理操作通过
共享契约校验策略是否已应用，再决定是否派发操作。

渲染器直接引用 `contracts/admin-views.ts` 的展示类型。`runnerDetailPage` 接收一个
具名输入对象，避免诊断、历史和注册码等可选数据在位置参数中混淆。

Runner 和 Client 列表通过 `admin/responsive-table.ts` 共用列定义，统一生成桌面表头、
移动端翻译标签及单元格顺序。CSS 负责布局，两种标签使用相同的翻译键。
`browser/fragment.js` 为首次页面加载和动态页面挂载提供目标查找与固定页头偏移，
导航生命周期仍由各自的调用者管理。

Connector 和远程能力的超时包装共用 `async-deadline.ts` 管理本地取消、定时器与清理，
各功能分别提供等待时长和超时结果。Skill 正文与摘要读取使用同一份存储 JSON 预算，
由导入时的 bundle 上限加 `digest` 字段的开销推导，涵盖 UTF-8 编码和 JSON 转义。
通过导入校验的内容在重新打开存储后仍可读取。

## 原生适配器与包声明

JobManager 管理准入、运行记录、终态落盘及取消／恢复顺序。ContextStore 管理
共享串行化和意图／记录／索引顺序。通过内部依赖注入文件、进程和仓储故障。
公开构造签名保持稳定，声明生成会去除内部重载。`pack:smoke` 使用发布包声明
编译 ESM 和 CommonJS 使用者。

systemd、launchd、Task Scheduler 分别有自己的适配器。CLI 输入、注册、诊断和
生命周期命令分别维护。补丁规划、Git 投影与原生执行分开，由协调者管理完整操作。
`registry/schema.ts` 在 Registry 同步启动阶段提供 DDL 和结构检查。

`packages/protocol/src/job-history.ts` 统一定义历史记录 welcome 扩展的类型、上传间隔、
保留天数及双方共用的严格解析。Worker 的默认配置和分页大小保持为纯数据，历史设置
建表归 Registry schema 管理，历史存储使用同一份协议取值校验保留天数。

## Runner 版本管理器

`updates/contracts.ts` 统一定义更新端口和适配器错误类型。
原生服务快照与维护端口定义在自包含的公开契约 `services/contracts.ts`，由更新契约和
原生适配器共同引用，使发布的服务类型声明与内部协议包保持独立。
更新协调器依赖更新契约和共享协议，由装配层提供 HTTP、原生服务、存储及发行版适配器。
发行版准备过程复用同一份目标与验证结果类型，架构回归检查普通导入和类型导入的依赖方向。

`apps/runner/src/maintenance-entry.ts` 与 `maintenance-cli.ts` 构建独立的
`dist/maintenance.cjs`。首次安装管理器时，该产物复制到
`<installRoot>/manager/runmesh.cjs`，Node 复制到管理器自己的 runtime 目录。
原生服务始终使用这些固定路径；选定的 Runner 通过 `current` 切换。
服务管理命令交给固定管理器，Runner 启动命令使用选定发行版。
管理器复用配置文件 I/O 和原生服务适配器，依赖图与任务执行、普通 Runner CLI 分离。

已有管理器在 Runner 版本切换和重复执行 `install` 时保留原运行时与程序包。
管理器自身的修复需要单独部署并在主机上验证。仅发布或安装新的 Runner 包，
已有管理器仍使用原代码；交付记录应分别确认 Runner 和管理器的实际部署结果。

`apps/runner/src/maintenance-contract.ts` 定义跨版本读取的本地字段。
凭据加载复用受保护的配置文件读取器，只取得服务地址、Runner ID、令牌和本地开发标记。
工作区与执行设置由 Runner 的完整配置校验处理。任务排空通过同一份小契约读取持久化
Job ID、时间戳和状态；写入端与读取端共用 ID 规则、状态分类和元数据字节上限。
修改配置版本、命令内容或恢复注解时，保持这些字段可读。新增 Job 状态需要先明确
它表示任务仍在运行还是已经结束，再用于管理器的排空判断。

`packages/protocol/src/runner-update.ts` 定义独立的 HTTPS v1 契约。
`apps/worker/test/fixtures/maintenance-v1-client.ts` 冻结 `0.1.8-dev.45` 发布的客户端；
`runner-update-v1-compatibility.test.ts` 通过真实 Worker 路由发送请求，并用该旧客户端
解析响应。实现演进时保留这份夹具。将测试两端一起改成新格式会掩盖已安装管理器的
兼容问题。新版本契约使用独立定义与夹具，同时保留面向现有安装的 v1 回归。
`test/public-contract-baseline.test.mjs` 将 CRLF 统一为 LF 后核对已审阅夹具的 SHA-256，
因此同步修改当前 Schema 和旧客户端夹具时，各平台仍会在基线检查中发现变化。

三个既有 CI 环节共同检查隔离边界：

- `check:architecture` 检查维护模块的直接和传递依赖，允许复用经过审阅的主机适配器与契约。
- `build-runner-bundle.mjs` 在写入维护产物前检查真实 esbuild 输入图；普通 CLI、执行模块
  和未经审阅的包依赖会使构建失败。
- `pack:smoke` 与 `test-packed-runner.mjs` 将实际包内的维护产物单独放入临时目录，
  配置一个故意损坏的普通 Runner，检查维护入口的版本、帮助、参数校验与命令边界。
  这些检查纳入原生平台验证和准确发行包验证。

## 浏览器源码与文案

`apps/worker/browser/admin-client.js` 是浏览器入口。中央产品模块位于
`browser/central/`：`controller.js` 统一管理忙碌状态、写入准入和刷新快照；
`api.js` 管理 HTTP 回执与分页；`services.js` 和 `skills.js` 分别管理各自流程；
`view.js` 管理共用 DOM 操作；`messages.js` 管理中央产品浏览器双语文案。
流程依赖由控制器注入，不互相导入。架构回归拒绝反向依赖和流程直接联网。

控制器提供视图挂载状态检查和导航端口。已移除的视图不能消费迟到回执、发起后续
请求或跳转新页面。已发出的服务端操作仍可能完成；新视图重新读取状态，不自动重放。
回执必须匹配列表、单项或写入操作；无法确认的写入必须刷新后才能继续修改。

导航所有者在挂载控制器或修改浏览器历史前，丢弃已被后续目的地取代的成功响应。
只由最终目的地改变页面和 URL，完整页面跳转的回退也使用最终目的地。

生成器只打包本地静态 JavaScript 模块，输出一个符合 CSP 的脚本。它限制整个输入图
和输出大小，拒绝外部／动态依赖及路径／符号链接越界，在不执行 DOM 代码的情况下
检查语法，并在构建、类型检查和 Wrangler 准备阶段原子生成忽略的 Worker 模块。
含／不含 nonce 的哈希覆盖审阅后的打包字节，DOM 测试验证交互行为。

`i18n/messages.ts` 管理稳定双语 ID。`message()` 接收类型化键、语言和对应参数，
编译器回归覆盖非法调用。新文案使用这些键，修改措辞时保留键名。
具名 HTML 兼容适配器保留数字原样、转义、语言选择和原始数据保护。

## 验证与交付

Vitest 配置显式指定根目录和收集范围。`check:verification` 从仓库与包目录运行
`vitest list` 并对照清单；漏收、重复、外部路径和归档测试都会失败。
随后执行已收集的测试，并保留历史审计档案。

基线回归覆盖十个 MCP 工具的 Schema、说明、注解和线协议字节。针对候选 SHA
执行受影响的认证 Worker、竞态／恢复、安装包、原生平台和 Chromium 检查。

开发目标为 `runmeshdev`，生产目标为 `runmesh`。Cloudflare 连接 GitLab 时，
在准确 SHA 的 GitHub `verify-all` 通过后快进 GitLab `dev`；可以使用单独配置的
`sync-gitlab-dev.mjs` 宿主桥接，也可手动快进。部署脚本上传前核对分支、环境、
配置和 `WRANGLER_CI_OVERRIDE_NAME`，再显式指定 Worker 名称，详见[部署参考](deployment.md)。
开发安装要求存在可发现、已验签的不可变预发布包。

保留兼容 facade 和有状态协调者，将操作逐步移到窄接口后面。
白盒竞态测试只有在替代方式保留故障时点和可观察断言后再迁移。

## AR09–AR14：平台边界与故障注入接口

实施基线：`1a05c4db85881ae80c2b8f0c11985ababeddc44f`（dev，2026-09-16）。

| 工作包 | 落地边界 | 保留的所有者 |
| --- | --- | --- |
| AR09 | 外部平台依赖按 Worker 角色检查，包含类型；Node 使用 `isBuiltin`；统一支持的扩展名；新 Job/Context 文件默认纯模块。 | 显式审阅的平台适配器和源码依赖检查 |
| AR10 | Connection 运行时、策略与传输端口；提取故障分类、主机元数据、策略候选和 Job 帧投影。 | Connection 管理 socket 身份、代次、期望／已应用策略、定时器和异步顺序 |
| AR11 | Context repository、Job 原子文件、Connection socket、Worker Registry／待回复接口可注入。 | 内部测试接口保留崩溃、取消和故障断言 |
| AR12 | 可选功能故障状态存储和纯维护决策。 | RegistryDO 管理事务、跨领域协调与 alarm |
| AR13 | 纯日志容量、保留候选与到期判断。 | JobManager 管理计数器、记录身份、持久化预留、进程和删除重验 |
| AR14 | 测试清单及双语职责／验证说明。 | 分别记录源码、原生主机、安装包、签名发行和线上结果 |

Connection 保留公开 options 和单参数构造；内部重载从发布声明去除。
Worker 传输使用签名 Registry 请求。待回复容器由一个所有者同步管理；
最终本地准入检查和 socket 发送应处于同一同步段。

功能健康构造函数保存依赖。可选 SQL 写失败时保留内存熔断状态，由 RegistryDO
按持久化期限调度 alarm。保留规划返回原记录对象，协调者在删除 I/O 前后核对
身份和持久化状态。

故障时点等价时，测试通过注入端口替代私有连接、索引、持久化和 waiter 方法。
崩溃测试实际退出子进程；队列测试在文件适配器阻塞持久化，通过公开 Job API 取消。
验证包括导入正反例、本机 workerd SQLite、回复 socket 身份、保留记录身份和
日志容量，以及策略、历史、安装包和浏览器回归。

## AR15-AR18：发布契约、显式缓存状态与测试隔离

实施基线：`8ee90367db4db491faa6ebec79a866e81a52da61`（dev，2026-09-17）。

| 范围 | 责任模块 | 契约 |
| --- | --- | --- |
| 已审阅发布常量和地址 | `domain/release-config.ts` | 审阅后的版本、公钥、来源、摘要、大小限制及安装器兼容导出 |
| 签名清单字段 | `domain/release-manifest.ts` | 无导入字段验证、规范 UTC 日期；允许未消费的签名扩展字段 |
| 安装器字段验证 | `generate-release-validation.mjs` | 有界语法编译、确定性生成忽略文件，接入构建／类型检查 |
| 发布／缓存投影 | `domain/release-selection.ts` | 纯值投影 |
| 下载、有界读取、密码学 | `distribution/release-io.ts` | 固定来源、重试、字节限制及安装器实际包大小／摘要／校验和 |
| 单请求发现与刷新 | `distribution/release.ts` | 显式 fetch、验证器、时钟、缓存和值状态端口 |
| 隔离实例装配 | `http/release-cache.ts` | 共享缓存值和启动计数，未完成 I/O 归发起请求所有 |
| 共享发布缓存准入 | `registry/release-cache.ts` | 纯有效期及版本顺序规则，复用发布选择验证器 |

同一字段验证器编译进 POSIX 和 PowerShell 验证正文。签名夹具差分测试执行
Worker 验证和两种生成代码，原生平台任务覆盖宿主特有行为。

缓存读取和失败刷新在异步工作后重验当前值；已提交的新刷新优先于晚到的旧结果。
成功验签才更新时间，软缓存复用受原一小时期限限制。stable 选择固定源码目标，
development 选择已验签的 dev 通道。

发布发现暂时不可用时，已过期的开发版描述符提供此前验证过的固定版本标签。
既有验证器重新核对签名和清单，成功后才更新验证时间。共享存储先按开发版
序号、再按验证时间排序，晚到的验证结果保留已发布的新版本。

新 Job、Context、Patch 和 Connection 文件默认纯模块，I/O 适配器显式登记。
纯哈希、路径计算和平台类型端口有具名例外。Patch 契约使用 `path-contracts.ts`，
保留 `PathSnapshot` 兼容导出及解析路径形状。

八个 Job 故障场景使用原子文件端口。并发、注册围栏恢复和上报桥接测试使用
RegistryRequestPort，保留真实 DO 存储、进程执行、取消和可观察状态断言。

三个 Runtime 协调竞态改用内部 JobPersistencePort：快速退出耐久性、晚到 running
快照、spawn 设置／取消。端口接收 JobManager 提供的入队回调，保留串行化和
身份校验，并允许在入队前或协调完成后暂停。默认生产路径不新增异步边界，
内部构造重载不会进入发布声明。AR18 禁止重新使用私有持久化拦截。

发信号前子进程退出的测试已改用文件／进程端口，等待真实子进程 close 事件，检查
持久化终态和零终止调用。保留策略夹具读取有效的落盘记录，通过公共准入创建运行
和排队 Job，验证主动开启清理后只删除过期终态，四种受保护状态均保留。
这两项测试均不读写 JobManager 私有映射。

Registry 路由解析位于 `registry/route-inputs.ts`；策略／工作区和合并审计记录
的响应投影位于 `registry/route-projections.ts`。这些函数只接收值，不获取状态
或执行 I/O。签名请求准入、事务／nonce 顺序、身份检查、SQL 和异步后的生命周期
重验仍由 RegistryDO 管理。纯函数与路由回归覆盖原有错误、状态码、字段和审计排序。

Registry 授权路由适配器位于 registry/routes/：admin 负责管理员会话与限流，
clients 负责客户端设置与 Runner 选择，runner-policy 负责受管工作区及策略响应，
identity 负责 MCP 身份与授权响应。每组只接收自身明确的同步操作端口，不导入
RegistryDO、领域实现、存储、平台类型或其他适配器。RegistryDO 完成装配与请求准入，
路由内的身份检查与修改之间不引入 await。架构门禁拒绝反向依赖、异步适配器、
调度及直接网络访问。

打包 Job 与外部审计路由回归通过真实环境契约和 D1 绑定构造 RegistryDO，在 D1
prepare 边界注入故障；Transport 测试使用 DO 测试回调提供的存储，schema 测试调用
schema 模块。测试不再修改私有环境／历史实例或读取私有 ctx，仍检查历史关闭与
退出记录、零写入成本、历史降级及 Runner 可用性。架构回归防止这些私有测试接口回流。

继续由 JobManager 和 RunnerDO 管理状态。运行生成代码、契约、依赖和故障回归，
配合必需的安装包、原生平台与浏览器检查；按候选 SHA 记录通过、跳过和未执行环境。

环境探测实现位于 apps/runner/src/environment.ts，Runtime 与 CLI 的依赖契约
使用 environment-contracts.ts，安装包的 ESM／CJS 类型检查覆盖结构化替换。
domain/runner-handshake.ts 负责纯 hello 协商、Registry 回执解析和 welcome 投影。
RunnerDO 继续独占 socket、epoch、准入和待处理 RPC，保留连接替换重验及同步
派发顺序。架构负例阻止这些纯边界反向导入、访问环境状态或调度异步工作。

RunnerConnection 的公开 runtime 和 policyStore 选项使用导出的
ConnectionRuntimePort 与 ConnectionPolicyStorePort 契约，传入实例只有一条注入
路径；默认运行时通过内部工厂接收同步 Job 事件回调。安装包的 ESM／CJS 消费者
验证结构化替换，内部工厂重载不进入公开声明。连接版本、策略中断、重连确认和
历史上传周期测试通过 hello／welcome、协议帧与注入端口检查行为，AR18 防止这些
已迁移测试再次访问连接私有状态。socket 身份、策略发布及异步顺序仍由
RunnerConnection 管理。

开发版发布发现的共享运行时只保存已验证值和刷新结果计数。冷缓存并发请求各自
管理计时器，最多等待一个刷新预算以取得已验证结果。失败冷却、租约更替和缓存
原始硬过期保持有效，不共享 I/O Promise，也不增加并发上游校验。回归覆盖校验
成功／失败、等待上限、租约更替及过期。

A53-01/A53-02：刷新失败后重新读取持久化的已验证记录，响应头和响应体合计
限时一秒；I/O 结束后重验原始硬过期和并发更新的内存值。HTTP 工厂必须接收
WorkerEnv，从 REGISTRY 同时取得存储和值状态的作用域，删除无作用域运行时
回退。安装引导展示函数接收调用方已解析的版本。真实认证 HTTP 回归覆盖 Runner
详情、创建、轮换和重新注册，检查它们与公共下载在刷新进行中共享同一状态。
通用有界 JSON 读取器移至 Worker 基础层，供分发和平台适配器共用，避免反向依赖。

注册兑换在 Registry facade 与 lifecycle 实现中均要求操作标识。直接调用测试
通过生产使用的变更账本验证竞争兑换，以及响应丢失后的同操作恢复。删除仅为旧
测试保留的可选分支；凭据变更继续在取得 RunnerDO 隔离后由原同步事务完成。

版本恢复属于原请求持有的刷新流程，限时持久缓存重读结束后才发布失败状态，
使冷缓存等待者能够取得恢复后的已验证值。HTTP Registry 适配器为缓存读取
（响应头和正文）及写入分别设置五秒上限，取消晚到响应，不重试结果未明的写入。
分发层继续负责描述符校验、验证时间戳和原始硬过期，不跨请求共享 I/O Promise。
回归覆盖延迟恢复、恢复超时，以及 Registry 读写卡住后仍返回已验证版本。
