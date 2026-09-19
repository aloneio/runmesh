# 运行时配置与密钥

[English](runtime-config.md) · [管理员指南](admin-guide.zh-CN.md)

使用源码默认值和两个独立的 Worker 密钥开始部署；有特殊需要时再增加覆盖配置。

## 必要密钥

| 名称 | 用途 | 升级时 |
| --- | --- | --- |
| `INTERNAL_CONTROL_SECRET` | 验证控制面内部请求 | 保留现有值 |
| `RUNNER_TOKEN_PEPPER` | 保护 Runner 凭据校验值 | 保留现有值；替换会使已有凭据失效 |

每个值分别使用至少 32 字节的密码学安全随机数，编码为文本，保存在 Cloudflare secrets 中。密钥应避开源码、日志和对话。管理员密码通过首次设置页面填写。

需要通过 API 管理 Runner 时，再配置 `ADMIN_TOKEN`；只使用管理页面的实例保留两个必要密钥即可。

## 默认值与覆盖项

| 配置 | 默认行为与适用场景 |
| --- | --- |
| `WORKER_ID` | 由生产或开发模式确定，也支持现有的显式 ID |
| `RUNMESH_PUBLIC_ORIGIN` | 校验后的 HTTPS 请求地址与匹配的 Host；反向代理传入内部地址时，显式设置公网 HTTPS origin |
| `RUNMESH_AUDIT_BACKEND` | 生产默认 D1；保留有意设置的后端覆盖项 |
| `RUNMESH_JOB_HISTORY_BACKEND` | 生产默认使用打包的 D1 历史；保持 `HISTORY_DB` 绑定可用 |
| `RUNMESH_SIGNED_RELEASE_AVAILABLE` | 生产使用经过审核的正式版本，候选版关闭；开发使用 `dev` 发现。显式空值会关闭托管安装 |
| `RUNMESH_DEPLOYMENT_BRANCH` / `RUNMESH_DEPLOYMENT_COMMIT` | 部署身份由构建时核实的 Git 来源生成，并与提供商元数据比较；通过[来源核验](build-provenance.zh-CN.md)查看 |

公网地址覆盖项必须是完整的 HTTPS origin，省略路径、查询、片段、凭据和空白。空值或无效值会使需要公网地址的请求被拒绝。Runmesh 校验请求本身，转发主机头不参与地址选择。

开发环境使用 `RUNMESH_ENVIRONMENT=development`，测试变量保留在本地测试环境。更新已有实例时，保留 Registry/Runner Durable Object 命名空间、`HISTORY_DB`、静态资源和 `CF_VERSION_METADATA` 绑定。

## 选择发行物与环境

当前源码为 **0.1.4 候选版**，正式分发关闭。完成签名发布、独立验证和经过审核的 `release/release-state.json` 激活后，才可用于生产安装。安装可用性以这份发布记录为准。

生产使用受保护的 `main`，候选版测试使用独立的 `dev` Worker。开发环境从自己的通道选择已验签预发布；选择不可用时会关闭托管安装。详见[开发预发布](dev-runner-prereleases.zh-CN.md)。

## 初始化缺失密钥

完成 Cloudflare CLI 管理授权并创建 Worker 后，先检查必要密钥名称：

```sh
npm run setup:secrets -- --env production
```

创建缺失项：

```sh
npm run setup:secrets -- --env production --apply
```

工具再次检查清单，在内存中生成独立随机值，并通过 Wrangler 标准输入上传缺失项；已有值保持原样。每次由一位管理员执行初始化。清单读取失败时先解决 Cloudflare 访问问题；上传结果不确定时，先核对密钥清单再决定是否重试。

生成的密钥由 Cloudflare 保存。需要独立恢复备份时，应先通过自己的密钥管理流程生成并保留，再上传。

## 更新或迁移实例

保留 Worker 名称、现有数据绑定、两个必要密钥，以及反向代理地址或紧急关闭安装等有意设置的覆盖项。部署更新后的 Worker，再按[升级指南](upgrading.zh-CN.md)逐台处理 Runner。

新账号可以创建自己的资源并使用自己的 HTTPS 域名。迁移已有数据需要单独的转移方案，并包含原来的凭据保护密钥。

发行签名密钥保存在 GitHub 发布环境，Cloudflare API 凭据保存在授权 CLI 或构建连接；Worker 运行时只接收应用所需密钥。

参考：[Cloudflare secrets](https://developers.cloudflare.com/workers/configuration/secrets/)、[版本元数据](https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/)、[资源创建](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning)。
