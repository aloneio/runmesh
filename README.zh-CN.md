# Runmesh

**智能体控制平面 / Agent Control Plane**

> 本文件是 Runmesh README 的中文入口和法律、运营说明译文索引。完整的英文技术安装、
> 操作和架构说明在 [README.md](README.md)；如有技术或法律解释不一致，以英文原文和
> 许可证文本为准。

Runmesh 是一个模型无关、客户端无关的远程编码运行时：Cloudflare Worker 提供控制平面，
本地 Runner 只通过出站连接执行文件系统、Git 和进程工作。它不会调用 AI 模型。运行
Runner 的主机有本地操作系统权限，因此请将不受信任的代码放在具有限制挂载、密钥、
网络和权限的独立 VM 或容器中。详细的安全边界请阅读
[`docs/security.md`](docs/security.md) 和 [SECURITY.zh-CN.md](SECURITY.zh-CN.md)。

## 快速开始

英文的完整部署步骤、前提条件和验证命令请参阅 [README.md](README.md) 的 **Quick
start** 部分。部署前，请至少：

1. 安装 Node.js 20+、npm、Git、Wrangler，并准备启用 SQLite Durable Objects 的
   Cloudflare 账户；
2. 运行 `npm install`、`npm test`、`npm run typecheck`、`npm run build` 和
   `npm run validate:worker`；
3. 保护管理员密码、MCP URL、Runner 令牌和注册代码；不要将它们提交到 Git、日志或
   截图中；
4. 仅为 Runner 明确配置所需工作区，并采用最小权限；
5. 阅读 [docs/deployment.md](docs/deployment.md)、
   [docs/security.md](docs/security.md) 和 [docs/migration.md](docs/migration.md)。

## 许可证、商业使用与致谢

Runmesh 依据 [PolyForm Noncommercial License 1.0.0](LICENSE) 以源码可用形式提供，
**不是** OSI 认可的开源许可证。该许可证只允许其定义的非商业用途。商业使用或需要
超出公开许可证的权利时，必须向适用版权权利人取得单独书面协议；请参阅
[COMMERCIAL_LICENSE.zh-CN.md](COMMERCIAL_LICENSE.zh-CN.md)。

此变更仅向前适用。最后一个 Apache 许可的源代码版本是
[`7766f7d4220386d2382170b130ac3b153936a955`](LICENSE_HISTORY.md)。此前版本副本所获
Apache 2.0 授权没有被撤销或更改。完整、精确的历史 Apache 文本保存在
[`LICENSES/Apache-2.0-history.txt`](LICENSES/Apache-2.0-history.txt)。关于来源、范围
和贡献者审计，请阅读 [LICENSE_HISTORY.zh-CN.md](LICENSE_HISTORY.zh-CN.md)；关于第三
方边界，请阅读 [THIRD_PARTY_NOTICES.zh-CN.md](THIRD_PARTY_NOTICES.zh-CN.md)；关于
名称和徽标使用，请阅读 [TRADEMARKS.zh-CN.md](TRADEMARKS.zh-CN.md)；报告漏洞请阅读
[SECURITY.zh-CN.md](SECURITY.zh-CN.md)；贡献前请阅读
[CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md)。

项目曾对 `xyTom/coding-tools-mcp`、`volter-ai/volter-tunnel`、
`Hiroshimeow/agent-mcp-gateway` 以及 Cloudflare 和 MCP 生态文档进行独立设计研究。
这些只是研究致谢，并不表示其代码或资产被包含。请求研究的
`davidlosasgonzalez/codeagent-mcp` 公开仓库当时不可用，因此未使用其中的代码或许可。
第三方许可证仍按各自条款适用；本仓库不重新许可它们。

## 中文法律与社区文档

- [许可证历史与范围](LICENSE_HISTORY.zh-CN.md)
- [商业许可](COMMERCIAL_LICENSE.zh-CN.md)
- [商标指引](TRADEMARKS.zh-CN.md)
- [第三方通知](THIRD_PARTY_NOTICES.zh-CN.md)
- [安全策略](SECURITY.zh-CN.md)
- [贡献指引](CONTRIBUTING.zh-CN.md)
