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

当前源码为 **0.1.4 候选版**。生产命令需要先完成发行激活，候选版测试使用 development。

从干净的 Git 工作区构建，并在打包完成前保持源码不变。构建会核对实际提交、文件树与 Cloudflare、GitHub、GitLab 的声明。已修改文件、未跟踪的应用文件、源码符号链接、隐藏索引标记或未核实的子模块会阻止确认来源。需要已核实源码身份的部署，应使用 Git 检出目录，而非仅有源码的压缩包。

## 部署后核验

在仓库中运行：

```sh
npm run check:deployment -- https://your-worker.example <实际40位提交> main
```

填写实际的 40 位提交；开发环境将最后一个参数改为 `dev`。核验器发送一次只读 HTTPS 请求，要求来源已确认、源码干净，且提交和分支符合预期。请求期限为 10 秒，覆盖响应头和正文，响应上限为 16 KiB。

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

维护中的开发环境通过单独配置的宿主同步程序，在精确提交的 GitHub `verify-all` 成功后快进 GitLab `dev`，再由连接的 Cloudflare Worker 构建这次推送。自己的部署应按[部署说明](deployment.md)配置相应连接。

健康记录的 `attestation=self_reported` 表示来源由构建主机按受跟踪的 Git 源码报告，因此需要信任构建主机及其 Git 元数据。依赖和构建环境验证随 CI 记录，Runner 签名验证随发行证据记录。升级记录中一并保留 Worker 提交、Cloudflare 版本 ID 和已安装 Runner 的版本。

参考：[Workers Builds 配置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)、[Git 元数据变量](https://developers.cloudflare.com/changelog/post/2025-06-10-default-env-vars/)、[版本元数据](https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/)。
