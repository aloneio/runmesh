# 第三方通知

## 范围

本文件记录源码仓库中的第三方依赖和资产边界。仓库的 PolyForm Noncommercial License 1.0.0
只适用于适用权利人按该条款授权的 Runmesh 材料，不重新许可第三方软件、依赖项、外部贡献
或商标。

根据当前设计研究审计，源码树中没有被识别为复制进入的第三方源码或资产。如果后续加入复制
或 vendored 材料，应在合并或分发前记录准确来源、许可证、所需通知和再分发影响。

## 运行时依赖通知

当前 lockfile 版本中的直接运行时依赖包括：

| Workspace | 依赖 | 锁定版本 | 声明许可证 |
| --- | --- | ---: | --- |
| root / Runner | [`ws`](https://www.npmjs.com/package/ws) | 8.21.3 | MIT |
| Worker | [`@modelcontextprotocol/server`](https://www.npmjs.com/package/@modelcontextprotocol/server) | 2.0.0 | MIT |
| Worker | [`agents`](https://www.npmjs.com/package/agents) | 0.21.0 | MIT |
| Worker / Protocol | [`zod`](https://www.npmjs.com/package/zod) | 4.4.3 | MIT |

lockfile 还记录了传递依赖和开发依赖的许可证。它是本版本的可复现依赖清单，但不能替代
上游包随附的许可证文件。发行构建必须根据实际依赖集审查并包含 artifact 所需的全部上游
通知。依赖清单包含 MIT、Apache-2.0、ISC、BSD、MPL-2.0、LGPL-3.0-or-later、CC0-1.0、
CC-BY-4.0 等表达式，但每种 artifact 不一定包含全部表达式。

公开 Runner 和 protocol package 携带当前的 `LICENSE`、`NOTICE` 和
`THIRD_PARTY_NOTICES.md`。npm 会分别安装依赖项；重新分发依赖时必须保留上游许可证文件和
通知。私有 Worker workspace 不是已发布 npm artifact。

## 分发提醒

不要删除、替换或遮蔽上游许可证文件或通知。如果创建 bundled、container、binary 或
vendored 分发包，应根据实际包含的输入生成并审查该发行版本的第三方通知。本文件是清单
辅助，不是法律意见，也不是所有构建场景的完整 SBOM。
