# 测试与发行验证

[English](verification.md) · [文档目录](README.zh-CN.md) · [发行状态](release-readiness.md)

验证源码修改或准备发行时，可按本文选择检查。在仓库根目录使用固定工具链执行 `npm ci` 安装依赖，再运行相应命令。本地修改选择与改动相关的检查；发行候选仍须通过全部必需 CI。验收已经部署的实例，请先阅读[升级指南](upgrading.zh-CN.md)。

## 选择需要的检查

| 层次 | 入口 | 成功执行能够支持的结论 |
| --- | --- | --- |
| 共享协议 | `npm run test --workspace=@aloneio/runmesh-protocol` | 被测运行时中的协议、Schema 和确定性规则 |
| 纯领域规则 | `npm run test:domain` | 通过公开 API 测队列、授权结果投影及保留规划，不构造 Worker、进程管理器或磁盘适配器 |
| 适配与文档契约 | `npm run test:contracts` | 文档参数符合真实 Schema；文件适配器在隔离临时数据上满足契约 |
| Runner 单元与集成 | `npm run test --workspace=@aloneio/runmesh-runner` | 该平台的文件、进程、权限和恢复行为 |
| Cloudflare 本地集成 | `npm run test --workspace=@aloneio/runmesh-worker` | 本地 workerd/Miniflare 与隔离 SQLite/D1 场景 |
| 构建与发行工具 | `npm run test:release-tools` | 构建、安装器、发行、架构和验证工具的行为 |
| 源码传输链路 | `npm run test:e2e` | 真实本地 MCP → Worker → 源码 Runner |
| 安装包传输链路 | `npm run test:package:e2e` | 新打包并独立安装的 Runner 通过相同本地链路场景 |
| 浏览器操作 | 先运行 `npm run browser:install`，再运行 `npm run test:browser` | 浏览器连接本地 Worker 时的页面行为 |
| 已登记安全回归 | Linux 上从干净工作区运行 `npm run test:security` | 当前候选提交的安全回归结果和发行准入证据 |

`npm run test:unit` 包含领域、契约、工作区和部分界面测试，其中既有单元测试，也有集成测试。`npm test` 另加源码 E2E，仍不等于完整 CI。本地 Worker 和浏览器测试不检查已部署的 Cloudflare 账号。

`test:security` 要求 Linux 和没有未提交源码变更的候选工作区。在 Windows/macOS 或有本地修改时，运行相关的单项回归测试；发行证据应取自干净候选提交的 Linux 验证结果。

新增测试文件时，在 `test/verification-plan.json` 中指定唯一归属，并运行 `npm run check:verification` 检查遗漏、重复和 Node 测试的执行入口。

领域测试应通过公开 API 验证规则，不依赖文件系统、进程、网络或 Cloudflare 适配器，也不通过私有字段强转检查内部状态。源码导入检查允许确定性的 `node:crypto`。这项检查约束源码依赖，不提供运行沙箱，也不审计第三方包内部实现。

## 验证实际安装包

GitHub 和 GitLab 的 Linux 验证任务在源码 E2E 后执行 `test:package:e2e`：打包当前 Runner，要求新临时目录内只有一个 tarball，计算其 SHA256，再调用 `test-packed-runner.mjs`，使用空依赖缓存进行 `--offline --ignore-scripts` 安装。随后启动安装目录内的 CLI。

整个过程使用临时 Worker、临时状态和合成注册码，不启动或重启主机服务，也不接触生产数据库。可用的 CI 提交声明必须与检出提交一致；完成后再检查源码身份和包摘要没有变化。

通过需要同时满足进程成功退出、机器测试报告一致且至少有一项真正通过。仅 exit 0、缺失报告、全部跳过、错误计数、未完成状态或失败 suite 均不能伪装成功。跳过和 todo 分开计数；失败重跑会覆盖旧成功报告。

`.verification/package-e2e.json` 和 CI 的 JSON 摘要只包含提交、文件树、干净或脏状态、包哈希及大小、实际平台/架构/Node、耗时和测试计数，不复制测试名、异常堆栈、主机路径、邮箱或凭据型 fixture。详细测试日志另行保留。报告被 Git 忽略，不写入 Worker，更不会每次生产请求生成。

这是自报的测试证据，不是密码学证明或可复现构建认证。脏源码保持 `dirty`，不能被称为该提交的干净构建；被忽略输入、依赖与其他构建环境仍在此身份声明之外。同一工作树不要并发构建。

## 检查文档与示例

`docs/current-facts.md` 根据源码包版本、协议、实际工具目录、绑定配置及已审阅发布记录生成。`docs/tool-examples.md` 根据 `docs/tool-examples.json` 生成；每个工具及映射动作都有有效示例，反例必须被实际 Zod Schema 拒绝，包含跨字段限制。

示例校验从不调用 handler，也不执行 shell、patch、注册或清理。合成 ID、命令和哈希不代表真实资源存在或权限已经获得。生成范围内的文档由 `check:docs` 校验，过期则失败，不自动重写。只有明确修改源码或示例后才运行 `npm run generate:facts` 并审阅差异；此门禁不覆盖历史文档里的所有自由文本代码块。

## 分别记录发行与部署结果

GitHub 的 Linux/macOS/Windows 原生任务运行领域、契约、Runner 与适用工具测试。完整安装包传输检查目前在两端 Linux 验证任务中执行；Linux 结果不能证明另外两个系统的安装包 E2E 通过，平台跳过项应单独记录。

签名资产验证、生产 Worker/Runner 实际观测、账户级配额/休眠验收和真实 MCP 宿主目录更新仍是独立检查。安装包测试报告把这四项标为 `not_run`；源码发布记录不是刚刚下载验证过的资产，历史 CI 不能替代新提交证据。

发行验收时，保留每项必需检查对应的提交、CI 运行、平台、跳过项和结果。发布要求见[发行状态](release-readiness.md)；核对线上 Worker 与源码的对应关系见[构建来源](build-provenance.zh-CN.md)。
