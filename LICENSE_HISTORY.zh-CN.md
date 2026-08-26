# 许可证历史与适用范围

> 本文件是 [`LICENSE_HISTORY.md`](LICENSE_HISTORY.md) 的中文说明译文。它不修改
> [`LICENSE`](LICENSE) 的任何条款；如有不一致，以英文原文和许可证文本为准。

## 当前的源码可用条款

本仓库当前顶层许可证为 [PolyForm Noncommercial License
1.0.0](LICENSE)。该许可证允许其中定义的非商业用途。商业用途需要向适用的版权
权利人另行取得书面许可证；请参阅 [COMMERCIAL_LICENSE.zh-CN.md](COMMERCIAL_LICENSE.zh-CN.md)。

PolyForm Noncommercial 1.0.0 是**源码可用**许可证，而不是 Open Source Initiative
所定义的开源许可证。本文件仅作说明，不修改 `LICENSE` 的文本。

## Apache 2.0 历史

从首个源代码提交到本次迁移前的最后一个源代码版本，仓库的 `LICENSE` 均为 Apache
License 2.0：

- **提交：** `7766f7d4220386d2382170b130ac3b153936a955`
- **提交日期：** 2026-08-26T22:34:02+08:00
- **提交主题：** `feat: harden policy security and runner operations`
- **历史根 LICENSE 的 SHA-256：**
  `75aa71b5be8076ef3fd8775c51a889319aed777649859df377333bce0d208700`

[`LICENSES/Apache-2.0-history.txt`](LICENSES/Apache-2.0-history.txt) 是该提交中
`LICENSE` 的逐字节副本。它作为历史许可证记录保留，并不是本次迁移后新分发版本
选择的许可证。发布的 Runner 和 protocol 包也包含相同的历史记录。

本次迁移仅向前适用。它不会撤销、缩小或更改先前在 Apache 2.0 许可版本下收到的
副本所获得的任何 Apache 2.0 授权。当前树中如含有此前依据 Apache 2.0 收到的材料，
下游接收者仍须遵守适用于这些材料的 Apache 2.0 通知和署名要求。本文件不试图
重新许可第三方拥有的材料，也不授予版权权利人未授权的权利。

## 许可证文本来源

当前 `LICENSE` 是从以下位置下载的完整、未编辑官方文本：

<https://polyformproject.org/licenses/noncommercial/1.0.0.txt>

在迁移准备时，下载文本的 SHA-256 为
`ffcca38841adb694b6f380647e15f17c446a4d1656fed51a1e2041d064c94cc8`。
`npm run check:licenses` 会验证此校验值和保留的 Apache 文本。

## 作者与权利人审计

迁移基线上的 `git shortlog -sne --all` 只记录以下 Git 身份：

| 提交数 | Git 身份 |
| ---: | --- |
| 5 | aloneio `<git@aloneio.aleeas.com>` |
| 1 | aloneio `<aloneio@hotmail.com>` |

在为本次迁移审计的可达 Git 历史中没有外部贡献者身份。同一显示名称并不能证明两个
电子邮件地址属于同一法定主体，也不能证明任一身份转让了重新许可所需的全部权利。
这项审计不是权属链意见。若后续历史、导入内容、生成资产或贡献者协议显示存在其他
权利人，在主张更广泛的许可证范围前必须审查其许可和通知。

请参阅 [THIRD_PARTY_NOTICES.zh-CN.md](THIRD_PARTY_NOTICES.zh-CN.md) 了解依赖项和
第三方材料的边界，并在提交材料前阅读
[CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md)。
