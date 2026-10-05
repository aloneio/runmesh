# 安装与更新 Skill

[English](central-skills.md) · [MCP 和 Skill 指南](central-administration.zh-CN.md)

安装一份 Skill 的说明与配套文本文件，已连接的 AI 客户端即可使用。

## 准备文件

把 `SKILL.md` 放在所选文件夹根目录，参考资料等文本文件放在该目录内：

```text
project-review/
  SKILL.md
  references/
    checklist.md
```

`SKILL.md` 开头提供名称和说明，各占一行：

```markdown
---
name: project-review
description: 按项目检查清单进行审查，并报告可执行的改进项。
---

阅读 references/checklist.md，检查项目并汇总发现。
```

名称使用小写字母、数字和内部连字符，最多 64 个 UTF-8 字节。所有文件保存为 UTF-8 文本。下载得到压缩包时，先解压，再选择包含 `SKILL.md` 的 Skill 文件夹。选择文件夹会保留子目录结构，单独选择的文件放在根目录。

## 安装

1. 打开「MCP 和 Skill → Skill」。
2. 通过「Skill 文件夹」选择整个目录，或通过「Skill 文件」选择 `SKILL.md` 与配套文件。
3. 点击「安装 Skill」。
4. 在已安装卡片上点击「查看文件」，核对内容。

Skill 随即向实例中的所有有效 AI 客户端开放。在客户端刷新 Runmesh 工具或资源列表，再用 `skill_list` 查找，用 `skill_read` 读取正文与附件。提供 MCP 资源浏览功能的客户端也可从资源列表打开 Skill。

Skill 文件以文本交付。AI 客户端根据说明使用可用工具，每个工具按各自权限执行。共享前请核对 Skill 的来源和内容。

## 更新、暂停与恢复

更新时保持 `SKILL.md` 中的 `name` 相同，选择更新后的文件夹或文件，点击「安装 Skill」，核对展示的文件后点击「更新 Skill」。新版本会对所有客户端生效。

「暂停」停止后续读取并保留文件。恢复时点击「查看文件 → 启用 Skill」。已经读入对话的内容仍留在该对话中；任务需要全程使用新版本时，可开启新对话。

更新后，客户端重新调用 `skill_list`，使用返回的新摘要读取 `SKILL.md` 和所有附件，使任务始终使用同一版本的内容。

## 文件与存储上限

| 项目 | 上限 |
| --- | --- |
| 每个 Skill 的文件数 | 256 个 |
| 单文件大小 | 1 MiB |
| 文件路径长度 | 200 个字符 |
| 上传包，含编码后的路径与元数据 | 8 MiB |
| 每个 Skill 保留的版本数 | 32 个 |
| 每个实例的 Skill 数 | 1,000 个 |
| 每个实例的 Skill 内容总存储 | 256 MiB |

大小按 UTF-8 字节计算。所选目录保留 Skill 说明和相关参考资料，将依赖目录、构建产物与无关文件移出。文件使用正斜杠分隔的相对路径，名称由英文字母、数字、点、下划线和连字符组成，例如 `references/checklist.md`。名称应符合 Windows 文件命名规则，完整文件路径在忽略大小写后也应各不相同。达到存储上限时，已有内容会保留，页面提示相应上限。

上传内容需要调整时，按页面提示修正文件，重新选择并提交。常见上传与更新问题见[故障排查](troubleshooting.zh-CN.md)。

API 分页、可选依赖元数据和版本管理见[Skill 参考](maintainers/central-skills.zh-CN.md)。
