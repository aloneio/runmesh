# Schema-checked tool examples / Schema 校验示例

Generated from `tool-examples.json`. Synthetic inputs only; validation never invokes a handler or performs an edit, shell command, registration or deletion.

示例只校验参数，不执行操作。有效参数不等于已授权或资源存在；实际权限每次重验。Job、Context 和摘要均为合成值，不要盲目执行示例中的写操作。

## runner-list — schema accepts / 参数有效

```json
{
  "name": "runner_list",
  "arguments": {}
}
```

## runner-current — schema accepts / 参数有效

```json
{
  "name": "runner_current",
  "arguments": {}
}
```

## runner-select — schema accepts / 参数有效

```json
{
  "name": "runner_select",
  "arguments": {
    "runner_id": "example-runner",
    "confirm_switch": true
  }
}
```

## workspace-list — schema accepts / 参数有效

```json
{
  "name": "workspace_list",
  "arguments": {}
}
```

## inspect-list — schema accepts / 参数有效

```json
{
  "name": "inspect",
  "arguments": {
    "workspace_id": "example-workspace",
    "action": "list",
    "path": "."
  }
}
```

## inspect-search — schema accepts / 参数有效

```json
{
  "name": "inspect",
  "arguments": {
    "workspace_id": "example-workspace",
    "action": "search",
    "query": "example",
    "mode": "literal",
    "max_results": 20
  }
}
```

## inspect-stat — schema accepts / 参数有效

```json
{
  "name": "inspect",
  "arguments": {
    "workspace_id": "example-workspace",
    "action": "stat",
    "path": "src/example.ts"
  }
}
```

## inspect-git-status — schema accepts / 参数有效

```json
{
  "name": "inspect",
  "arguments": {
    "workspace_id": "example-workspace",
    "action": "git_status",
    "path": "."
  }
}
```

## inspect-git-diff — schema accepts / 参数有效

```json
{
  "name": "inspect",
  "arguments": {
    "workspace_id": "example-workspace",
    "action": "git_diff",
    "path": "."
  }
}
```

## inspect-git-log — schema accepts / 参数有效

```json
{
  "name": "inspect",
  "arguments": {
    "workspace_id": "example-workspace",
    "action": "git_log",
    "path": "."
  }
}
```

## inspect-git-show — schema accepts / 参数有效

```json
{
  "name": "inspect",
  "arguments": {
    "workspace_id": "example-workspace",
    "action": "git_show",
    "path": ".",
    "revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
}
```

## inspect-git-blame — schema accepts / 参数有效

```json
{
  "name": "inspect",
  "arguments": {
    "workspace_id": "example-workspace",
    "action": "git_blame",
    "path": "src/example.ts",
    "start_line": 1,
    "end_line": 20
  }
}
```

## inspect-diagnostics — schema accepts / 参数有效

```json
{
  "name": "inspect",
  "arguments": {
    "workspace_id": "example-workspace",
    "action": "diagnostics"
  }
}
```

## read-live — schema accepts / 参数有效

```json
{
  "name": "read",
  "arguments": {
    "workspace_id": "example-workspace",
    "path": "src/example.ts",
    "limit": 1024
  }
}
```

## read-snapshot — schema accepts / 参数有效

```json
{
  "name": "read",
  "arguments": {
    "workspace_id": "example-workspace",
    "path": "src/example.ts",
    "consistency": "snapshot",
    "limit": 1024
  }
}
```

## edit-preview — schema accepts / 参数有效

```json
{
  "name": "edit",
  "arguments": {
    "workspace_id": "example-workspace",
    "patch": "*** Begin Patch\n*** Add File: example.txt\n+example\n*** End Patch",
    "preview": true
  }
}
```

## edit-apply — schema accepts / 参数有效

```json
{
  "name": "edit",
  "arguments": {
    "workspace_id": "example-workspace",
    "patch": "*** Begin Patch\n*** Add File: example.txt\n+example\n*** End Patch",
    "expected_hashes": {
      "example.txt": null
    }
  }
}
```

## shell-start — schema accepts / 参数有效

```json
{
  "name": "shell",
  "arguments": {
    "workspace_id": "example-workspace",
    "command": "printf 'synthetic example\\n'",
    "background": true,
    "queue": true
  }
}
```

## shell-run — schema accepts / 参数有效

```json
{
  "name": "shell",
  "arguments": {
    "workspace_id": "example-workspace",
    "command": "printf 'synthetic example\\n'",
    "background": false,
    "queue": true
  }
}
```

## job-list — schema accepts / 参数有效

```json
{
  "name": "job",
  "arguments": {
    "workspace_id": "example-workspace",
    "action": "list",
    "limit": 10
  }
}
```

## job-get — schema accepts / 参数有效

```json
{
  "name": "job",
  "arguments": {
    "workspace_id": "example-workspace",
    "action": "get",
    "job_id": "example-job"
  }
}
```

## job-logs — schema accepts / 参数有效

```json
{
  "name": "job",
  "arguments": {
    "workspace_id": "example-workspace",
    "action": "logs",
    "job_id": "example-job",
    "stream": "stdout",
    "limit": 1024,
    "consistency": "append"
  }
}
```

## job-cancel — schema accepts / 参数有效

```json
{
  "name": "job",
  "arguments": {
    "workspace_id": "example-workspace",
    "action": "cancel",
    "job_id": "example-job"
  }
}
```

## job-input — schema accepts / 参数有效

```json
{
  "name": "job",
  "arguments": {
    "workspace_id": "example-workspace",
    "action": "input",
    "job_id": "example-job",
    "close_stdin": true
  }
}
```

## context-bootstrap — schema accepts / 参数有效

```json
{
  "name": "context",
  "arguments": {
    "workspace_id": "example-workspace",
    "action": "bootstrap"
  }
}
```

## context-read — schema accepts / 参数有效

```json
{
  "name": "context",
  "arguments": {
    "workspace_id": "example-workspace",
    "action": "read",
    "context_id": "example-context"
  }
}
```

## context-search — schema accepts / 参数有效

```json
{
  "name": "context",
  "arguments": {
    "workspace_id": "example-workspace",
    "action": "search",
    "query": "example",
    "limit": 10
  }
}
```

## context-checkpoint — schema accepts / 参数有效

```json
{
  "name": "context",
  "arguments": {
    "workspace_id": "example-workspace",
    "action": "checkpoint",
    "turn_id": "example-turn",
    "expected_revision": 0,
    "goal": "Synthetic schema example; no execution is implied",
    "missing_checks": [
      "production not verified"
    ]
  }
}
```

## context-rebuild — schema accepts / 参数有效

```json
{
  "name": "context",
  "arguments": {
    "workspace_id": "example-workspace",
    "action": "rebuild"
  }
}
```

## context-storage — schema accepts / 参数有效

```json
{
  "name": "context",
  "arguments": {
    "workspace_id": "example-workspace",
    "action": "storage"
  }
}
```

## context-prune — schema accepts / 参数有效

```json
{
  "name": "context",
  "arguments": {
    "workspace_id": "example-workspace",
    "action": "prune",
    "keep_days": 30,
    "keep_revisions": 2,
    "max_delete": 5
  }
}
```

## reject-traversal — schema rejects / 应拒绝

```json
{
  "name": "read",
  "arguments": {
    "workspace_id": "example-workspace",
    "path": "../private"
  }
}
```

## reject-search-without-query — schema rejects / 应拒绝

```json
{
  "name": "inspect",
  "arguments": {
    "workspace_id": "example-workspace",
    "action": "search"
  }
}
```

## reject-prune-without-preview-hash — schema rejects / 应拒绝

```json
{
  "name": "context",
  "arguments": {
    "workspace_id": "example-workspace",
    "action": "prune",
    "keep_days": 30,
    "keep_revisions": 2,
    "apply": true
  }
}
```

## reject-input-without-data — schema rejects / 应拒绝

```json
{
  "name": "job",
  "arguments": {
    "workspace_id": "example-workspace",
    "action": "input",
    "job_id": "example-job"
  }
}
```

## reject-implicit-runner-override — schema rejects / 应拒绝

```json
{
  "name": "shell",
  "arguments": {
    "workspace_id": "example-workspace",
    "command": "true",
    "runner_id": "another-runner"
  }
}
```

## reject-snapshot-numeric-cursor — schema rejects / 应拒绝

```json
{
  "name": "read",
  "arguments": {
    "workspace_id": "example-workspace",
    "path": "example.txt",
    "consistency": "snapshot",
    "cursor": "1"
  }
}
```
