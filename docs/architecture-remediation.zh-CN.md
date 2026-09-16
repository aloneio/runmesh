# 模块化架构整改约束

此文描述源码维护约束，不表示 Worker 已部署或本机 Runner 已升级。它延续 AR01–AR08，不新增运行时依赖、权限范围、远程服务、存储迁移或自动升级。参见[英文版](architecture-remediation.md)。

## 职责与依赖方向

| 层 | 职责 | 禁止反向依赖 |
| --- | --- | --- |
| Worker 入口 | fetch／scheduled 装配、顶层分发 | 在多个入口复制同一业务决策 |
| HTTP | 解析、认证、CSRF、响应格式 | Registry 具体实现和持久化记录类型 |
| Application | 生命周期／策略编排、数据投影 | HTTP、页面、Registry facade |
| Contracts／Domain | 稳定类型、能力接口、纯决策 | 平台与表现层实现 |
| MCP Server | SDK 装配、逐次重验授权、输出验证 | Registry、RunnerDO 具体类 |
| MCP Results | 安全字段投影、有界输出 | 处理器、派发、审计、传输执行 |
| Views | 同步呈现明确的视图模型 | Registry 记录和 HTTP 操作 |
| Registry | 单一权限与事务所有者 | 领域模块中的页面依赖 |
| Runner 协调者 | 状态转换、持久化与副作用顺序 | 同一状态的多个竞争所有者 |

`scripts/architecture-policy.mjs` 中的依赖矩阵参与构建检查。未知 Worker 模块不能自动获得基础层豁免。普通导入、类型导入、重新导出、字面量动态导入和浏览器源码均受检查。无法解析或动态计算的模块依赖失败；运行时环和包含类型边的环都失败。负向回归覆盖反向导入、facade 回引以及借中间文件改名绕过边界。

## 共享用例与视图契约

`apps/worker/src/application/delete-runner.ts` 是网页和管理员 API 共用的 Runner 删除流程。请求级接口保持确认、唯一变更 ID、fence、提交状态观测、取消和收尾顺序。拒绝、依赖不可用和结果未知保持区分；不因响应不明自动重试变更。原有入口仍各自完成认证，业务用例不是缓存授权或新授权能力。

其余生命周期和策略函数已移出 Worker 顶层入口。Registry 的内部 HMAC 路由及 RunnerDO 的会话派发有意保留原有一致性所有者。`contracts/admin-views.ts` 管理展示类型，`application/admin-projections.ts` 显式选择字段。详情投影发生在授权之后，不将凭据校验值交给页面，也不将管理员可见的工作区根路径送入公开 MCP 结果。

## 原生适配器与包兼容性

JobManager 继续拥有准入、运行记录、终态落盘和取消／恢复顺序。ContextStore 保留共享串行化及意图／记录／索引顺序。内部装配可注入文件、进程和仓储故障，但不是新增 CLI、RPC 或用户配置。内部构造重载从发布声明中去除，原有公开签名保留。`pack:smoke` 实际编译 ESM 与 CommonJS 使用者，不要求安装 `@types/node` 或未发布的工作区包。

systemd、launchd、Windows Task Scheduler 分开维护；`service.ts` 保留兼容入口。CLI 解析、注册、诊断、生命周期命令分离。补丁规划和 Git 结果投影不再与文件／进程实现混放，但完整操作仍由原协调者管理。Registry 表结构与检查移入 `registry/schema.ts`，调用位置仍是原同步启动边界。命名空间、数据库与密钥身份不变。

## 浏览器源码与文案

`apps/worker/browser/admin-client.js` 是独立维护的浏览器源码。构建器限制输入大小，不执行脚本，只检查语法并原子生成被 Git 忽略的 Worker 模块；普通构建、类型检查和 Wrangler 构建钩子都会生成它。含／不含 nonce 的输出哈希与原脚本保持一致。

`i18n/messages.ts` 是双语文案的稳定键来源。`message()` 只接收类型化键和语言，不把用户标签解释为键。参数化文案按键约束参数类型，进行字面量替换；真实编译器回归验证错误调用不能通过。旧 HTML 本地化保留在具名兼容适配器中，维持数字原样、转义、语言选择和不透明用户数据保护。新文案应使用键；改文案不等于可以重命名键或移除兼容保护。

## 验证与交付

全部 Vitest 配置显式限定根目录与收集范围。`check:verification` 从仓库根及子项目目录实际执行 `vitest list`，将结果与归属清单逐项对照；漏收、重复、外部路径和归档测试都会失败。收集正确不等于测试执行通过，历史审计证据不因此删除。

基线回归覆盖十个 MCP 工具的 Schema、说明、注解和线协议文件字节。认证页面、竞态、失败恢复、真实安装包及 Chromium 测试继续保留。Linux 验证不能冒充 Windows／macOS 原生验证或托管 CI 结果。

development 固定部署 `runmeshdev`，production 仍为 `runmesh`。oci0 上的 `runmesh-dev-sync.timer` 观察 GitHub `dev`；只有同一 SHA 的 `verify-all` 成功后才以 fast-forward 方式同步到 GitLab `dev`，由该 push 触发 Cloudflare Workers Builds；分叉时停止，不 force push，也不把跨平台长期令牌复制到 GitHub Actions。development 只允许一条命令安装不可变、已签名的 dev prerelease；发现不到合法开发预发布时关闭安装入口，绝不回退稳定版 Runner，也不会把未签名的 dev 分支产物冒充 Runner 发行。部署包装器仍核对分支／环境、Wrangler 配置及 `WRANGLER_CI_OVERRIDE_NAME`。进入 main、线上验收与不可变签名发版仍是独立操作。

兼容 facade、有界旧文本适配器和有状态协调者是有意保留的边界。已有白盒竞态测试应逐步迁到受支持的故障接口，不应为通过重构而删掉。单纯文件缩短不是整改验收标准。

## AR09–AR14：平台边界与故障注入接口

实施基线：`1a05c4db85881ae80c2b8f0c11985ababeddc44f`（dev，2026-09-16）。以下描述源码职责，不表示已安装 Runner 或线上部署已更新。

| 工作包 | 落地边界 | 保留约束 |
| --- | --- | --- |
| AR09 | 外部平台依赖按 Worker 角色检查，包含类型导入；Node 使用 `isBuiltin`；解析前后统一支持的扩展名；新增 Job/Context 文件默认纯模块，适配器需要显式审阅。 | 源码依赖门禁不是沙箱、全局副作用分析或第三方依赖内部审计。 |
| AR10 | Connection 使用运行时、策略存储、socket 工厂窄接口；提取故障分类、主机元数据、策略候选构造和 Job 帧投影。 | socket、代际、期望与已应用策略、定时器及异步顺序仍由单一连接协调器拥有。 |
| AR11 | Context repository、Job 原子文件操作、Connection socket，以及 Worker Registry 请求和待回复接口可注入。 | 保留真实崩溃、取消竞态与故障断言；接口仅内部使用，不成为 RPC、CLI 或部署配置。 |
| AR12 | 提取可选功能故障状态存储和纯维护决策。 | 同步事务、跨领域协调与 alarm 调度仍由 RegistryDO 拥有。 |
| AR13 | 提取纯日志容量、保留候选与到期判断。 | 计数器、记录身份、持久化预留、进程及删除前后重验仍由 JobManager 拥有。 |
| AR14 | 登记测试清单并补齐双语边界与验收说明。 | 源码、本机测试、实际安装包、签名发行和线上验证分别记录。 |

Connection 原有公开 options 与单参数构造接口保留；新增窄接口构造重载仅内部使用，由现有声明构建剥离，不增加可配置的适配器选择。Worker 请求默认继续执行原有签名 Registry 请求。待回复容器只有一个所有者，方法同步执行：请求超时仍在原派发位置创建，最终本地准入栅栏与 socket 发送之间不增加 `await`。

故障状态存储构造不执行 I/O，可选 SQL 写失败后仍保留内存熔断状态；仅 RegistryDO 决定 alarm。维护沿用现有 SQL 与持久化期限，不增加表、缓存、重试循环或远程服务。保留规划返回原记录对象，不是删除授权；协调器仍在 I/O 前后检查身份和持久化状态。

重点故障测试不再替换 `connectOnce`、`ContextStore.writeIndex`、`JobManager.persist` 或 DO 的私有 waiter map，而是操作显式注入的内部接口。其他既有白盒状态与竞态测试仍有保留，不能宣称已清除所有强转或私有访问。崩溃测试仍实际退出子进程；队列测试在文件适配器阻塞持久化，同时通过公开 Job 操作取消。

验收包含导入正反例、本机 workerd SQLite 接口、回复 socket 身份、保留记录身份、日志容量，以及既有故障、策略竞态、无记录历史、安装包和浏览器测试。测试收集不等于测试运行；CI 必须绑定本次准确 SHA，不能借用旧 dev 的通过结果。未增加运行时依赖、定时器、必填设置、云资源、协议版本或存储格式。main 晋级、生产部署、凭据变更和主机 Runner 升级不属于本次结构整改。
