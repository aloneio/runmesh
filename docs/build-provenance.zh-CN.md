# 核对 Worker 实际部署的源码

使用 `/health` 查看 Worker 编译时的 Git 提交，并与计划部署的提交比较。多个提交可能共用一个产品版本号，所以不能只检查版本。更新 Worker 不会升级已安装 Runner，也不会发布带签名的 Runner 安装包。

## 配置构建

在 Cloudflare Workers Builds 中选择仓库根目录，构建命令使用：

```sh
npm run build
```

生产 Worker 连接受保护的 `main` 分支，部署命令为：

```sh
npm run deploy:worker -- --env production
```

独立开发 Worker 连接 `dev` 分支，部署命令为：

```sh
npm run deploy:worker -- --env development
```

当前 **0.1.4 仍为候选版本**，未激活生产发行。生产部署脚本会拒绝候选状态并保留现有部署；完成正式发行审核与激活后才能使用生产命令。

保留明确的构建命令：Cloudflare Workers Builds 不会用 Wrangler Custom Builds 替代构建页面配置。使用仓库固定的 Node/npm 版本，不要通过 `--no-build` 或 `--no-bundle` 绕过构建。

构建会记录实际 Git 提交和文件树，无需新增运行时变量或密钥。Cloudflare、GitHub、GitLab 的提交声明必须与检出源码一致。使用干净的工作区；已修改文件、未跟踪的应用文件、隐藏索引标记、源码符号链接或未核实的子模块都会阻止确认来源。没有 Git 的源码压缩包可以本地构建，但不能为部署脚本提供已确认的 Git 来源。

## 部署后核验

在仓库中运行：

```sh
npm run check:deployment -- https://your-worker.example <实际40位提交> main
```

开发 Worker 将最后一个参数改成 `dev`。核验器只发出一次 HTTPS 健康请求，要求来源已确认、源码干净，且提交和分支与预期一致；不会重新部署或自动重试。请求期限为 10 秒，包含响应正文，响应大小上限为 16 KiB。

| 返回结果 | 含义与处理 |
| --- | --- |
| `state=identified`，提交和分支符合预期 | Worker 报告了预期的编译来源 |
| `agreement=matched` | 可识别的 Cloudflare 版本元数据与编译来源一致 |
| `agreement=not_comparable` | 没有可用于比较的提供商标签，编译来源仍可能已确认 |
| `state=conflict` | 来源与提供商元数据冲突，验收前检查构建和部署 |
| 来源缺失或不可确认 | 检查构建命令、Git 工作区和日志，不要手填提交号代替核验 |

健康响应使用 `Cache-Control: no-store`。旧 Worker 只返回版本号时，会无法通过来源核验，但不等于服务不可用。 `ok=true` 只表示健康处理器能响应；登录、Runner 连接和所需 MCP 操作还需单独检查。

## 构建失败时

若 Cloudflare 在安装工具或依赖阶段失败，Worker 尚未开始上传。先检查完整日志、工具链版本和缓存设置，再重试。仅凭这条错误不能断定是 Node 版本错误、缓存损坏或应用缺陷。重试成功后，仍应使用上述命令确认线上实际提交。

部署预检失败发生在 Wrangler 上传之前。上传器失败时，提供商可能已经接收了部分操作；重试前先检查实际部署来源。

## 部署与信任边界

维护中的开发环境可通过单独配置的宿主同步程序，在精确提交的 GitHub `verify-all` 成功后快进 GitLab `dev`，再由已连接的 Cloudflare Worker 构建该次推送。仓库不会替你安装同步程序、定时任务或提供商连接，详见[部署说明](deployment.md)。

来源记录标为 `attestation=self_reported`，依赖可信构建主机和 Git 元数据，不是数字签名或可复现构建证明。依赖包、忽略的生成文件和环境相关变换不属于 Git 文件树本身；构建期间不要修改源码。Runner 签名发行、Worker 源码提交、Cloudflare 版本 ID 和已安装 Runner 版本应分别核对。

参考：[Workers Builds 配置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)、[Git 元数据变量](https://developers.cloudflare.com/changelog/post/2025-06-10-default-env-vars/)、[版本元数据](https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/)。
