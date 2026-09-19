# 模块职责与回归检查

移动模块或修改适配器时，可按本文确认职责和验证方法。AR 编号用于追溯历史实施阶段。
参见[英文版](architecture-remediation.md)；组件部署按[升级指南](upgrading.zh-CN.md)执行。

## 职责与依赖方向

| 层 | 职责 | 应放在其他层的依赖 |
| --- | --- | --- |
| Worker 入口 | fetch／scheduled 装配、顶层分发 | 重复的业务决策 |
| HTTP | 解析、认证、CSRF、响应格式 | Registry 实现与持久化记录类型 |
| Application | 生命周期／策略编排、数据投影 | HTTP、页面、Registry facade |
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

## 原生适配器与包声明

JobManager 管理准入、运行记录、终态落盘及取消／恢复顺序。ContextStore 管理
共享串行化和意图／记录／索引顺序。通过内部依赖注入文件、进程和仓储故障。
公开构造签名保持稳定，声明生成会去除内部重载。`pack:smoke` 使用发布包声明
编译 ESM 和 CommonJS 使用者。

systemd、launchd、Task Scheduler 分别有自己的适配器。CLI 输入、注册、诊断和
生命周期命令分别维护。补丁规划、Git 投影与原生执行分开，由协调者管理完整操作。
`registry/schema.ts` 在 Registry 同步启动阶段提供 DDL 和结构检查。

## 浏览器源码与文案

在 `apps/worker/browser/admin-client.js` 修改浏览器行为。生成器限制输入大小、
检查语法，并在构建、类型检查和 Wrangler 准备阶段原子生成忽略的 Worker 模块。
含／不含 nonce 的呈现哈希覆盖原脚本字节。

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

同一字段验证器编译进 POSIX 和 PowerShell 验证正文。签名夹具差分测试执行
Worker 验证和两种生成代码，原生平台任务覆盖宿主特有行为。

缓存读取和失败刷新在异步工作后重验当前值；已提交的新刷新优先于晚到的旧结果。
成功验签才更新时间，软缓存复用受原一小时期限限制。stable 选择固定源码目标，
development 选择已验签的 dev 通道。

新 Job、Context、Patch 和 Connection 文件默认纯模块，I/O 适配器显式登记。
纯哈希、路径计算和平台类型端口有具名例外。Patch 契约使用 `path-contracts.ts`，
保留 `PathSnapshot` 兼容导出及解析路径形状。

八个 Job 故障场景使用原子文件端口。并发、注册围栏恢复和上报桥接测试使用
RegistryRequestPort，保留真实 DO 存储、进程执行、取消和可观察状态断言。

四个 Runtime 测试保留私有持久化协调器拦截，以维持特定时点：快速退出耐久性、
晚到 running 快照、spawn 设置／取消、发信号前子进程退出。
架构回归登记这些名称；替换例外前先验证等价的时点和断言。

继续由 JobManager 和 RunnerDO 管理状态。运行生成代码、契约、依赖和故障回归，
配合必需的安装包、原生平台与浏览器检查；按候选 SHA 记录通过、跳过和未执行环境。
