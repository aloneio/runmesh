# Install and update a Skill

[简体中文](central-skills.zh-CN.md) · [MCP and Skill guide](central-administration.md)

A Skill is a set of instructions and reference material for an AI client. Once installed, it is available to active clients in the instance.

## Prepare the files

Put `SKILL.md` at the root of the Skill folder and keep references in subfolders:

```text
project-review/
  SKILL.md
  references/
    checklist.md
```

The beginning of `SKILL.md` must include a name and description. Use lowercase letters, digits and hyphens for the name, up to 64 bytes. Save every file as UTF-8 text. Extract an archive before selecting the folder that contains `SKILL.md`.

## Install

1. Open **MCP & Skill → Skill**.
2. Select the whole Skill folder, or select `SKILL.md` and its supporting text files.
3. Choose **Install Skill**, then open **View files** to confirm the content.

Refresh the Runmesh connection in your AI client before using the Skill. Review its source and content before sharing it.

## Import from GitHub

Expand **Import from GitHub**, enter the public repository URL, the commit version to use and the Skill folder path. Leave the path empty when `SKILL.md` is at the repository root. Choose **Preview Skill**, review the files and then install or update it.

The imported content comes from the commit you selected. To update later, choose a new commit and preview it again. If there are too many files or a file is too large, the page will ask you to narrow the selection; folder upload is another option.

## Update, rename, pause and delete

- **Update:** select the new files, review the preview and choose **Update Skill**. The update applies to every client.
- **Rename:** change the friendly name in the Central list. This changes the title shown to people and does not change the Skill's original identity; the name remains after a refresh.
- **Pause:** clients cannot read a paused Skill, while its current content is kept. Choose **Enable** to resume it.
- **Delete:** deletion removes the Skill from use and keeps a deletion record. Its original Skill ID can never be reused, and an old upload does not return after a refresh or re-import.

Content already read into a conversation remains there. Start a new conversation when it must use the new version throughout.

## Version history and capacity

Open **Version history** on a Skill card to review older versions, compare changes, restore a version or clean up old versions. Preview cleanup before confirming; the active and kept versions are protected.

A Skill can retain up to 32 versions. An instance can hold up to 1,000 Skills and 256 MiB of stored content. One file is limited to 4 MiB and one GitHub import to 32 text files. When a limit is reached, clean up old versions before installing another.

If an upload fails, follow the page message, correct the files and select them again. See [troubleshooting](troubleshooting.md) for common issues.
