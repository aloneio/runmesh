# 第三方通知

> 本文件是 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) 的中文说明译文。它
> 不是每种构建的完整材料清单，也不修改任何上游许可证；如有不一致，以英文原文和
> 上游许可证为准。

## 范围

本文件记录源代码仓库的第三方许可边界。仓库当前的 PolyForm Noncommercial License
1.0.0 仅适用于适用权利人已授予该条款的材料。它不重新许可第三方软件、依赖项、
此前 Apache 许可副本或商标。

在为许可证迁移所作的可达 Git 历史和文档审计中，没有识别出复制进入本源代码树的
第三方源代码或资产。项目文档只记录独立的设计研究，并不声称这些研究参考提供了
源代码。以后如加入复制材料，必须在合并或分发前添加其准确许可证和所需通知。

## 运行时依赖项通知

在锁文件 0.1.0 版本中，直接运行时依赖由 npm 作为单独包安装。其上游许可证文件
随这些包保留；在打包或再分发它们时必须保留：

| 工作区 | 依赖项 | 锁定版本 | 声明许可证 |
| --- | --- | ---: | --- |
| root / Runner | [`ws`](https://www.npmjs.com/package/ws) | 8.21.3 | MIT |
| Worker | [`@modelcontextprotocol/server`](https://www.npmjs.com/package/@modelcontextprotocol/server) | 2.0.0 | MIT |
| Worker | [`agents`](https://www.npmjs.com/package/agents) | 0.21.0 | MIT |
| Worker / Protocol | [`zod`](https://www.npmjs.com/package/zod) | 4.4.3 | MIT |

锁文件也记录传递依赖和开发依赖的许可证。它是本版本可重现的依赖项清单，并不能
替代上游包随附的许可证文件。发布构建者必须审查实际依赖集，并纳入结果工件所需的
所有上游通知。依赖项条目特别包括 MIT、Apache-2.0、ISC、BSD、MPL-2.0、
LGPL-3.0-or-later、CC0-1.0、CC-BY-4.0 和其他表达式；并非每个特定平台工件都会
包含全部条目。

公开的 Runner 和 protocol npm 包会携带包专用的 `THIRD_PARTY_NOTICES.md`、当前
`LICENSE` 和打包文件列表中的历史 Apache 记录。私有 Worker 工作区不是公开的 npm
工件。

## 历史与研究参考

先前 Apache 2.0 项目许可证逐字保存在
[`LICENSES/Apache-2.0-history.txt`](LICENSES/Apache-2.0-history.txt)；其来源和范围
请参阅 [LICENSE_HISTORY.zh-CN.md](LICENSE_HISTORY.zh-CN.md)。

README 确认了针对 `xyTom/coding-tools-mcp`、`volter-ai/volter-tunnel`、
`Hiroshimeow/agent-mcp-gateway` 以及 Cloudflare 和 MCP 生态文档的设计研究。它们未被
表示为捆绑或复制的源代码。其名称和商标仍属于各自所有人。

## 分发提醒

不得删除、替换或遮蔽上游许可证文件或通知。若创建捆绑、容器、二进制或 vendored
分发，请依据实际随附输入生成并审查发布专用的第三方通知集。本文件是清单辅助，
不是法律意见，也不是每种可能构建的完整材料清单。
