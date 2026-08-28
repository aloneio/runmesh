# 参与贡献 Runmesh

感谢你帮助改进 Runmesh。我们欢迎个人和实体提交 Bug、复现步骤、测试、文档、设计讨论、翻译、
无障碍改进和代码贡献。

## 贡献条款

Runmesh 依据 [PolyForm Noncommercial License 1.0.0](../LICENSE) 以源码可见形式提供。向官方
`aloneio/runmesh` 仓库提交 pull request、patch、Issue 附件、文档、测试、设计贡献或其他贡献，
即表示你确认：

- 你有权提交该贡献，并有权授予以下许可；
- 你保留该贡献的版权和署名；
- 你向 Runmesh 及其维护者授予非独占、全球、免版税、永久的许可，可使用、复制、修改、制作
  衍生作品、分发、再许可，并将该贡献纳入源码可见的 Runmesh 社区版和未来取得商业许可的版本；
- 在法律允许的范围内，就该贡献或其与 Runmesh 的组合必然涉及的专利权利要求授予相应的专利许可；
- 你已经处理适用于该贡献的雇主、承包、保密、依赖、专利和第三方许可义务。

贡献许可仅适用于所提交的贡献本身。它不改变 Runmesh 适用的 PolyForm 许可证，也不授予你、你的
雇主或其他组织商业使用权。商业生产使用、收费托管、商业 SaaS、转售、白标分发和商业集成需要
书面授权，请参阅 [COMMERCIAL_LICENSE.zh-CN.md](../docs/legal/COMMERCIAL_LICENSE.zh-CN.md)。

如果你代表雇主或实体贡献，提交即表示你确认自己有权作出提交并授予上述权利。不要提交你无权
分享的保密信息、凭据、个人数据或第三方材料。

## 如何贡献

1. 报告漏洞前阅读 [SECURITY.zh-CN.md](SECURITY.zh-CN.md)，并使用私密安全流程。不要在公开
   Issue 中发布凭据、secret URL、私有 Workspace 路径、敏感日志或漏洞细节。
2. 较大的改动先创建 Issue 或设计讨论，说明问题、方案、替代方案、安全与兼容性影响以及验证计划。
   小型修复、文档、测试和范围明确的维护工作可以直接创建聚焦的 pull request。
3. 保持改动范围清晰，并更新受影响的测试和文档。
4. 在 pull request 中说明问题、方案、验证结果、安全影响和兼容性影响。Pull request 检查表会再次
   提醒关键的贡献确认事项。
5. 遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) 和
   [GOVERNANCE.zh-CN.md](../docs/community/GOVERNANCE.zh-CN.md)。

## 开发要求

- 保持安全边界，不记录凭据、secret、绝对 Workspace 根路径、敏感文件内容、命令或进程 ID；
- 遵守严格 TypeScript，不能用占位安全控制、宽泛权限、不安全 cast、吞错或无界 I/O 作为捷径；
- 未说明来源、许可证、所需通知和再分发影响时，不要复制代码、资产或商标；
- 行为变化要增加聚焦测试；修改生成文件前运行对应生成器；
- 使用清晰、可审查的提交，并解释必要的跨模块改动；
- 在 Git 历史和项目致谢中保留贡献者署名。

## 获取帮助

非敏感问题请使用 [issue tracker](https://github.com/aloneio/runmesh/issues)。商业讨论或安全
报告请请求私密联络渠道，不要公开提交机密信息。

本文件是项目指引，不是法律意见。对于你的权利、义务或计划中的商业使用，请获取合格的专业意见。
