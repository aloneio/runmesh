# Install and update a Skill

[简体中文](central-skills.zh-CN.md) · [MCP and Skill guide](central-administration.md)

Install a Skill's instructions and supporting text files once, then make them available to your connected AI clients.

## Prepare the files

Place `SKILL.md` at the root of the selected folder. Put references and other text files beneath that root:

```text
project-review/
  SKILL.md
  references/
    checklist.md
```

Start `SKILL.md` with YAML metadata containing a name and description. Descriptions can span several lines:

```markdown
---
name: project-review
description: >-
  Review a project using its checklist
  and report actionable findings.
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

Reading `SKILL.md` returns a file manifest with each file's path, UTF-8 size and SHA-256 hash. Use its paths and the same Skill digest to read the supporting files you need.

Skill files are delivered as text. An AI client follows the instructions through its available tools, with each tool using its own permissions. Review a Skill's source and content before sharing it.

## Import from GitHub

In the Skill section, expand **Import from GitHub** and enter a public repository URL, the full 40-character commit SHA, and the Skill folder path. Leave the path empty when `SKILL.md` is at the repository root. Select **Preview Skill**, review the files, then select **Install Skill** or **Update Skill**.

The installed source links to that exact commit. To update later, enter the new commit SHA and preview it again. One import can include up to 32 text files; use folder upload for a larger collection.

## Update, pause and resume

To update, keep the same `name` in `SKILL.md`, select the updated folder or files, and select **Install Skill**. Review the displayed files, then select **Update Skill**. The new version becomes active for every client.

**Pause** stops subsequent reads and retains the selected version. To resume that version, select **View files → Enable Skill**. Content already read into a conversation remains in that conversation; begin a fresh conversation when the task should use only the new version.

The card's description and **View files** show the selected version, including a version chosen from history. When the latest upload differs, select **View latest upload** to review it, then **Update Skill** to make it active. For a paused Skill, that action is labeled **Enable Skill**.

After an update, clients should call `skill_list` again and use the returned digest for both `SKILL.md` and its attachments. This keeps the task on one version of the Skill.

## Manage versions and storage

Open **Version history** on the Skill card to see retained versions, their file counts and sizes, and the Skill library's capacity. Each version is identified by its content digest. Versions with a recorded installation time also show that time.

- Select two versions and choose **Compare versions** to review changed files and metadata. Open either version's files for the full text.
- Choose **Use this version**, then **Confirm**, to make a retained version active for all clients.
- Choose **Keep version** to retain a version for later. **Unpin version** removes that choice.
- Select older versions, choose **Preview cleanup**, review the list and space to free, then confirm. The active version, latest upload and kept versions stay in the library.

Cleanup previews remain valid for five minutes. Changing the selection or updating the Skill calls for a fresh preview. After cleanup, the capacity display updates and you can install the next version.

## File and storage limits

| Item | Limit |
| --- | --- |
| Files per uploaded Skill | 256 |
| Files per GitHub import | 32 |
| One file | 1 MiB |
| File path length | 200 characters |
| Upload bundle, including encoded paths and metadata | 8 MiB |
| Retained versions per Skill | 32 |
| Skills per instance | 1,000 |
| Stored Skill bundles per instance | 256 MiB |

File sizes use UTF-8 bytes. Stored capacity counts the logical size of retained bundles, including JSON encoding, paths and metadata; Cloudflare storage and billing usage are available in its dashboard. Installing identical content again keeps the same stored version and its recorded time.

Keep the selected folder focused on the Skill's instructions and references; leave out dependency directories, generated output and unrelated files. Use relative paths with forward slashes and names made of English letters, digits, periods, underscores and hyphens, such as `references/checklist.md`. Choose names valid on Windows, and keep file paths unique when letter case is ignored. When the version or storage limit is reached, open **Version history** to clean up older versions.

If an upload needs correction, follow the panel's message, select the revised files and submit again. See [troubleshooting](troubleshooting.md) for common upload and update issues.

API pagination, optional dependency metadata and version administration are documented in the [Skill reference](maintainers/central-skills.md).
