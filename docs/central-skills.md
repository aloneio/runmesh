# Install and update a Skill

[简体中文](central-skills.zh-CN.md) · [MCP and Skill guide](central-administration.md)

Install a Skill's instructions and supporting text files once, then make them available to your connected AI clients. This guide covers the 0.1.6 candidate and development channel.

## Prepare the files

Place `SKILL.md` at the root of the selected folder. Put references and other text files beneath that root:

```text
project-review/
  SKILL.md
  references/
    checklist.md
```

Start `SKILL.md` with a name and description, each on one line:

```markdown
---
name: project-review
description: Review a project using its checklist and report actionable findings.
---

Read references/checklist.md, inspect the project, and summarize the findings.
```

Names use lowercase letters, digits and internal hyphens, up to 64 UTF-8 bytes. Save all files as UTF-8 text. For a downloaded archive, extract it first and select the Skill folder containing `SKILL.md`. Select a folder to preserve nested paths; selecting individual files places them at the root.

## Install

1. Open **MCP & Skill → Skill**.
2. Select the whole **Skill folder**, or select `SKILL.md` and its supporting files through **Skill files**.
3. Select **Install Skill**.
4. Open **View files** on the installed card to check the content.

The Skill becomes available to all active AI clients in the instance. In the client, refresh the Runmesh tool or resource list, then use `skill_list` to find it and `skill_read` to read its instructions and attachments. Clients that browse MCP resources can also open the Skill there.

Skill files are delivered as text. An AI client follows the instructions through its available tools, with each tool using its own permissions. Review a Skill's source and content before sharing it.

## Update, pause and resume

To update, select the new files with the same Skill name and select **Install Skill**. Review the displayed files, then select **Update Skill**. The new version becomes active for every client.

**Pause** stops subsequent reads and retains the files. To resume, select **View files → Enable Skill**. Content already read into a conversation remains in that conversation; begin a fresh conversation when the task should use only the new version.

After an update, clients should call `skill_list` again and use the returned digest for both `SKILL.md` and its attachments. This keeps the task on one version of the Skill.

## File and storage limits

| Item | Limit |
| --- | --- |
| Files per Skill | 256 |
| One file | 1 MiB |
| Upload bundle, including encoded paths and metadata | 8 MiB |
| Retained versions per Skill | 32 |
| Skills per instance | 1,000 |
| Stored Skill bundles per instance | 256 MiB |

Sizes use UTF-8 bytes. Keep the selected folder focused on the Skill's instructions and references; leave out dependency directories, generated output and unrelated files. Use relative paths with forward slashes and distinct filenames, including when compared without case. When a storage limit is reached, existing content is retained and the panel reports the limit.

If an upload needs correction, follow the panel's message, select the revised files and submit again. See [troubleshooting](troubleshooting.md) for common upload and update issues.

API pagination, optional dependency metadata and version administration are documented in the [Skill reference](maintainers/central-skills.md).
