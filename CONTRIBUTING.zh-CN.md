# 参与贡献 Runmesh

感谢你帮助改进 Runmesh。我们欢迎个人和实体提交 Bug、复现步骤、测试、文档、设计讨论、
翻译、无障碍改进和代码贡献。

Runmesh 是依据 [PolyForm Noncommercial License 1.0.0](LICENSE) 发布的源码可见非商业社区版。
项目同时授予范围有限的[贡献开发附加许可](CONTRIBUTION_PERMISSION.zh-CN.md)，允许为了准备
上游贡献而复制、运行、修改和测试 Runmesh；该许可不授权商业生产使用。

## 从这里开始

1. 报告漏洞前阅读 [SECURITY.zh-CN.md](SECURITY.zh-CN.md)。不要在公开 issue 中发布凭据、
   secret URL、私有 Workspace 路径、敏感日志或漏洞细节。
2. 较大的改动先创建 issue，说明问题、方案、替代方案、安全/兼容性影响和验证计划。小型
   修复与文档改进可以直接创建聚焦的 pull request。
3. 保持改动范围清晰，并更新受影响的测试和文档。
4. 运行相关检查，记录已经运行的命令以及本地无法执行的检查。
5. 遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) 和 pull request 模板。

## 贡献者协议与权利

你保留贡献内容的版权，也可以在其他项目中使用自己的代码。Runmesh 采用许可授权而不是
版权转让，因此已接收贡献可以包含在当前社区版及未来取得商业许可的 Runmesh 版本中。

在合并**实质代码贡献**前，请完成适用的[个人 CLA](CLA-INDIVIDUAL.md) 或[实体 CLA](CLA-ENTITY.md)。
当前签署和记录流程见 [docs/zh-CN/cla-setup.md](docs/zh-CN/cla-setup.md)。除非该文档以证据更新，
项目不会声称已启用 CLA 自动化。

只提交你有权贡献的材料。如果你是雇员、承包商或代表实体贡献，请在提交前确认雇主所有权、
开源政策、保密义务和专利义务。实体授权贡献时应使用实体 CLA。贡献不会授予你或雇主商业
生产使用权；请参阅 [COMMERCIAL_LICENSE.zh-CN.md](COMMERCIAL_LICENSE.zh-CN.md)。

## 开发要求

- 保持安全边界，不记录凭据、secret、绝对 Workspace 根路径、敏感文件内容、命令或进程 ID。
- 遵守严格 TypeScript，不能用占位安全控制、宽泛权限、不安全 cast、吞错或无界 I/O 作为捷径。
- 未说明来源、许可证、所需通知和再分发影响时，不要复制代码、资产或商标。
- 行为变化要增加聚焦测试；修改生成文件前先运行对应生成器。
- 使用清晰、可审查的提交，不要混入无关的运行时、法律、发布或文档改动。

## Pull request

说明问题、解决方案、测试、文档、安全影响和兼容性影响。完成 PR 清单，并在需要时注明
CLA 状态。维护者依据 [GOVERNANCE.md](GOVERNANCE.md) 审查；合并决定不会免除许可证、贡献者
协议或安全要求。

## 获取帮助

非敏感问题请使用 [issue tracker](https://github.com/aloneio/runmesh/issues)。商业讨论或安全
报告请先请求私密渠道，不要公开提交机密信息。
