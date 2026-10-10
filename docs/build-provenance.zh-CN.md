# 核对 Worker 实际部署的源码

[English](build-provenance.md)

将 `/health` 返回的 Git 提交与计划部署的提交比较。即使多个提交共用同一个产品版本号，也能据此识别源码。升级时另行核对已安装 Runner 的版本。

## 配置构建

在 Cloudflare Workers Builds 中选择仓库根目录，设置构建命令：

```sh
npm run build
```

使用仓库固定的 Node/npm 版本，保留构建和打包步骤。Workers Builds 的设置页需要明确填写这条构建命令。

独立开发 Worker 连接 `dev`：

```sh
npm run deploy:worker -- --env development
```

生产使用受保护的 `main`，在签名发行物完成验证和激活后执行：

```sh
npm run deploy:worker -- --env production
```

生产部署使用已通过测试、包含[发行状态](release-readiness.zh-CN.md)所列正式版本激活记录的 `main` 提交。后续控制端更新可以继续使用同一正式 Runner 包。新改动先在 development 测试，再按下文核对部署后实际运行的源码。

从干净的 Git 工作区构建，并在打包完成前保持源码不变。部署前提交应用改动，确认子模块位于记录的版本。构建会将这些源码与 Cloudflare、GitHub 或 GitLab 报告的提交比较。出现来源不一致时，可重新检出目标提交，再执行构建和部署。

## 部署后核验

在仓库中运行：

```sh
npm run check:deployment -- https://your-worker.example <实际40位提交> main
```

填写实际的 40 位提交；开发环境将最后一个参数改为 `dev`。首个参数必须是精确的 HTTPS origin，例如 `https://your-worker.example`，省略尾斜杠、路径、查询参数和凭据。核验器读取一次 `/health`，确认编译来源的提交和分支符合预期。请求超时时，先检查 Worker 是否可访问，再重新运行。

| 返回结果 | 含义与处理 |
| --- | --- |
| `state=identified`，提交和分支符合预期 | Worker 报告了预期的编译来源 |
| `agreement=matched` | 可识别的 Cloudflare 版本元数据与编译来源一致 |
| `agreement=not_comparable` | 没有可用于比较的提供商标签，检查编译来源的 `state`、提交和分支 |
| `state=conflict` | 检查构建和部署，解决来源声明冲突 |
| 来源缺失或不可确认 | 检查构建命令、Git 工作区和日志 |

健康响应使用 `Cache-Control: no-store`。较旧 Worker 可能只返回产品版本；通过经过审核的部署流程更新后，可获得提交级来源信息。

完成来源核验后，依次验证管理员登录、Runner 连接、策略确认，以及日常工作所需的 MCP 操作。具体流程见[升级指南](upgrading.zh-CN.md)。

## 处理构建或上传失败

| 失败阶段 | 下一步 |
| --- | --- |
| Cloudflare 安装工具或依赖 | 检查完整日志、工具链版本和缓存设置，修正日志指出的问题后重试 |
| 部署预检 | 修正分支、源码或发布状态问题，再开始上传 |
| Wrangler 上传 | 先检查线上来源；即使响应失败，提供商也可能已接收部署 |

重试成功后，再运行上面的来源比较命令。

## 提供商配置与来源记录

使用 GitLab 镜像时，按[部署说明](deployment.md)配置同步程序和 Cloudflare 构建连接。记录该次部署选用的提交，再用上面的命令与线上 Worker 比较。

健康记录中的 `attestation=self_reported` 表示 Git 来源由构建主机记录。使用可信的构建环境并保留 CI 结果。在升级记录中一并保存 Worker 提交、Cloudflare 版本 ID 和已安装 Runner 的版本，安装时核验 Runner 包的签名。

参考：[Workers Builds 配置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)、[Git 元数据变量](https://developers.cloudflare.com/changelog/post/2025-06-10-default-env-vars/)、[版本元数据](https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/)。
