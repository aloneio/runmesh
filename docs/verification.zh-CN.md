# 测试与发行验证

[English](verification.md) · [文档目录](README.zh-CN.md) · [发行状态](release-readiness.md)

验证源码修改或准备发行时，可按本文选择检查。在仓库根目录使用固定工具链执行 `npm ci` 安装依赖，再运行相应命令。本地修改选择与改动相关的检查；发行候选仍须通过全部必需 CI。验收已经部署的实例，请先阅读[升级指南](upgrading.zh-CN.md)。

## 选择需要的检查

| 层次 | 入口 | 成功执行能够支持的结论 |
| --- | --- | --- |
| 共享协议 | `npm run test --workspace=@aloneio/runmesh-protocol` | 被测运行时中的协议、Schema 和确定性规则 |
| 纯领域规则 | `npm run test:domain` | 通过公开 API 隔离测试队列、授权结果投影及保留规划 |
| 适配与文档契约 | `npm run test:contracts` | 文档参数符合真实 Schema；文件适配器在隔离临时数据上满足契约 |
| Runner 单元与集成 | `npm run test --workspace=@aloneio/runmesh-runner` | 该平台的文件、进程、权限和恢复行为 |
| Cloudflare 本地集成 | `npm run test --workspace=@aloneio/runmesh-worker` | 本地 workerd/Miniflare 与隔离 SQLite/D1 场景 |
| 构建与发行工具 | `npm run test:release-tools` | 构建、安装器、发行、架构和验证工具的行为 |
| 源码传输链路 | `npm run test:e2e` | 真实本地 MCP → Worker → 源码 Runner |
| 安装包传输链路 | `npm run test:package:e2e` | 新打包并独立安装的 Runner 通过相同本地链路场景 |
| 浏览器操作 | 先运行 `npm run browser:install`，再运行 `npm run test:browser` | 浏览器连接本地 Worker 时的页面行为 |
| 已登记安全回归 | Linux 上从干净工作区运行 `npm run test:security` | 当前候选提交的安全回归结果和发行准入证据 |

`npm run test:unit` 包含领域、契约、工作区和部分界面测试，`npm test` 另加源码 E2E。完整发行 CI 还会运行安装包、浏览器、平台、工具和安全检查。Worker 与浏览器测试命令使用本地测试环境，已部署实例按[升级指南](upgrading.zh-CN.md)验收。

候选提交的 `test:security` 在 Linux 的干净工作区中运行。使用 Windows/macOS 或带本地修改开发时，先运行相关单项回归，再从干净候选提交的 Linux 运行中收集发行证据。

新增测试文件时，在 `test/verification-plan.json` 中指定唯一归属，并运行 `npm run check:verification` 检查遗漏、重复和 Node 测试的执行入口。

领域规则通过公开 API 验证，适配器集成放在对应测试套件中。[源码依赖检查](architecture-gates.md)定义允许的导入关系，其中包括确定性的 `node:crypto`。

## 验证实际安装包

GitHub 和 GitLab 的 Linux 验证任务在源码 E2E 后执行 `test:package:e2e`：打包当前 Runner，要求新临时目录内只有一个 tarball，计算其 SHA256，再调用 `test-packed-runner.mjs`，使用空依赖缓存进行 `--offline --ignore-scripts` 安装。随后启动安装目录内的 CLI。

整个过程使用临时 Worker、隔离状态和合成注册码。检查器核对 CI 与检出提交的对应关系，并在结束后再次核对源码身份和包摘要。

通过条件包括：源码身份匹配、包摘要保持一致、进程成功退出、机器报告一致且至少有一项测试通过。报告分别统计通过、失败、跳过和待办；每次运行都会替换上一份报告，包括失败的重跑。

可分享的摘要写入 `.verification/package-e2e.json` 和 CI 日志中的 JSON 行，包含提交、文件树、干净或脏状态、包哈希及大小、平台/架构/Node、耗时和测试计数。详细测试日志单独保留，分享前应检查私有数据。生成报告属于 Git 忽略的本地产物。

本地报告记录测试构建的 `signed: false`、`published: false` 以及观察到的 clean/dirty 状态。准备发行时，另行完成签名与资产验证，并保留依赖、生成输入和构建环境记录。每个工作区同一时间运行一个构建。

## 检查文档与示例

`docs/current-facts.md` 根据源码包版本、协议、实际工具目录、绑定配置及已审阅发布记录生成。`docs/tool-examples.md` 根据 `docs/tool-examples.json` 生成；每个工具及映射动作都有有效示例，反例必须被实际 Zod Schema 拒绝，包含跨字段限制。

示例使用合成 ID、命令和哈希；按指南操作时，替换为自己有权访问的环境值。修改源码约定或示例后，运行 `npm run generate:facts` 并审阅差异，再用 `npm run check:docs` 校验生成文档和已登记示例。正文及登记范围外的示例随改动人工对照相应实现。

## 分别记录发行与部署结果

GitHub 的 Linux/macOS/Windows 原生任务运行领域、契约、Runner 与适用工具测试。完整安装包传输检查在 GitHub 和 GitLab 的 Linux 验证任务中执行。按实际运行环境记录各平台结果和跳过项。

为签名资产、已部署 Worker/Runner、账号用量和 MCP 客户端目录刷新分别保存记录。本地安装包报告将这些外部检查保留为 `not_run`。每项实际完成的观测都应附时间、准确版本或提交、环境和结果。

发行验收时，保留每项必需检查对应的提交、CI 运行、平台、跳过项和结果。发布要求见[发行状态](release-readiness.md)；核对线上 Worker 与源码的对应关系见[构建来源](build-provenance.zh-CN.md)。
