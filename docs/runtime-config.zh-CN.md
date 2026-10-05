# 运行时配置与密钥

[English](runtime-config.md) · [管理员指南](admin-guide.zh-CN.md)

使用源码默认值，并通过初始化工具准备 Worker 密钥；有特殊需要时再增加覆盖配置。

## 必要密钥

| 名称 | 用途 | 升级时 |
| --- | --- | --- |
| `INTERNAL_CONTROL_SECRET` | 验证控制面内部请求，并派生 OAuth 加密密钥 | 保留现有值；替换后需重新连接 OAuth |
| `RUNNER_TOKEN_PEPPER` | 保护 Runner 凭据校验值 | 保留现有值；替换会使已有凭据失效 |

初始化工具使用至少 32 字节的密码学安全随机数分别生成这两个密钥。OAuth 加密密钥自动从 `INTERNAL_CONTROL_SECRET` 派生。部署使用的两个值保存在 Cloudflare secrets；需要独立恢复副本时，按下文备份说明处理。管理员密码通过首次设置页面填写。

管理页面使用管理员登录会话。需要通过 API 管理 Runner 时，再配置 `ADMIN_TOKEN`。

## 默认值与覆盖项

| 配置 | 默认行为与适用场景 |
| --- | --- |
| `WORKER_ID` | 由生产或开发模式确定，也支持现有的显式 ID |
| `RUNMESH_PUBLIC_ORIGIN` | 校验后的 HTTPS 请求地址与匹配的 Host；反向代理传入内部地址时，显式设置公网 HTTPS origin |
| `RUNMESH_AUDIT_BACKEND` | 生产默认 D1；保留有意设置的后端覆盖项 |
| `RUNMESH_JOB_HISTORY_BACKEND` | 生产默认使用打包的 D1 历史；保持 `HISTORY_DB` 绑定可用 |
| `RUNMESH_SIGNED_RELEASE_AVAILABLE` | 生产使用经过审核的正式版本，候选版关闭；开发使用 `dev` 发现。显式空值会关闭托管安装 |
| `RUNMESH_DEPLOYMENT_BRANCH` / `RUNMESH_DEPLOYMENT_COMMIT` | 构建工具读取 Git 分支和提交，并核对所传入的配置值；通过[来源核验](build-provenance.zh-CN.md)查看实际部署的源码 |

公网地址覆盖项由协议、主机名和可选端口组成，例如 `https://runmesh.example.com`，省略路径、查询、片段、凭据和空白。填写有效值，或删除覆盖项以恢复自动选择。Runmesh 默认使用直接请求中的 URL 和 Host；代理使用不同的内部地址时，请配置该覆盖项。

开发环境使用 `RUNMESH_ENVIRONMENT=development`，测试变量保留在本地测试环境。更新已有实例时，保留 Registry/Runner Durable Object 命名空间、`HISTORY_DB`、静态资源和 `CF_VERSION_METADATA` 绑定。

## 选择发行物与环境

[发行状态](release-readiness.zh-CN.md)列出当前正式包。`release/release-state.json` 的 released 记录启用经过独立验签的正式包；candidate 记录在准备发布期间关闭该候选版本的正式托管安装。部署包含激活记录的 `main` 源码后，检查该 Worker 的发行描述以确认安装可用情况。显式空值 `RUNMESH_SIGNED_RELEASE_AVAILABLE` 会关闭托管安装。

生产使用受保护的 `main`，候选版测试使用独立的 `dev` Worker。开发面板从自己的通道提供已验签的预发布包，安装前核对面板显示的版本。发布和刷新时间见[开发预发布](dev-runner-prereleases.zh-CN.md)。

## 初始化缺失密钥

完成 Cloudflare CLI 管理授权并创建 Worker 后，先检查必要密钥名称：

```sh
npm run setup:secrets -- --env production
```

创建缺失项：

```sh
npm run setup:secrets -- --env production --apply
```

工具生成并上传缺失的密钥，保留已有值。每次由一位管理员执行初始化。命令报告 Cloudflare 访问或上传错误时，先核对账号连接和密钥清单，再决定是否重试。

生成的密钥由 Cloudflare 保存。需要独立恢复备份时，应先通过自己的密钥管理流程生成并保留，再上传。

## 更新或迁移实例

保留 Worker 名称、现有数据绑定、已有的两个密钥，以及反向代理地址或紧急关闭安装等有意设置的覆盖项。部署更新后的 Worker，再按[升级指南](upgrading.zh-CN.md)逐台处理 Runner。

新账号可以创建自己的资源并使用自己的 HTTPS 域名。迁移已有数据需要单独的转移方案，并包含原来的凭据保护密钥。

发行签名密钥保存在 GitHub 发布环境，Cloudflare API 凭据保存在授权 CLI 或构建连接；Worker 运行时只接收应用所需密钥。

参考：[Cloudflare secrets](https://developers.cloudflare.com/workers/configuration/secrets/)、[版本元数据](https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/)、[资源创建](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning)。
