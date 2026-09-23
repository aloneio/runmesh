# Current checkout facts / 当前源码事实

Generated from the checked-out source by `npm run generate:facts` and validated by `check:docs`. To identify running components, follow [build provenance](build-provenance.md) and the [upgrade guide](upgrading.md).

此表由当前源码生成，并通过 `check:docs` 校验。核对运行中的组件时，请按[构建来源](build-provenance.zh-CN.md)和[升级指南](upgrading.zh-CN.md)操作。

```json
{
  "schema_version": 1,
  "evidence": "source_checkout_only",
  "product_version": "0.1.5",
  "protocol": {
    "minimum": 2,
    "current": 2
  },
  "catalog_sha256": "97046f987be6c3593ca2f316a73bff76f58a4c6bb5478a7bb5d88c567c8d8bd5",
  "tools": [
    "runner_list",
    "runner_current",
    "runner_select",
    "workspace_list",
    "inspect",
    "read",
    "edit",
    "shell",
    "job",
    "context"
  ],
  "actions": [
    {
      "tool": "inspect",
      "action": "list",
      "method": "fs.list",
      "scope": "coding:read"
    },
    {
      "tool": "inspect",
      "action": "search",
      "method": "fs.search",
      "scope": "coding:read"
    },
    {
      "tool": "inspect",
      "action": "stat",
      "method": "fs.stat",
      "scope": "coding:read"
    },
    {
      "tool": "inspect",
      "action": "git_status",
      "method": "git.status",
      "scope": "coding:read"
    },
    {
      "tool": "inspect",
      "action": "git_diff",
      "method": "git.diff",
      "scope": "coding:read"
    },
    {
      "tool": "inspect",
      "action": "git_log",
      "method": "git.log",
      "scope": "coding:read"
    },
    {
      "tool": "inspect",
      "action": "git_show",
      "method": "git.show",
      "scope": "coding:read"
    },
    {
      "tool": "inspect",
      "action": "git_blame",
      "method": "git.blame",
      "scope": "coding:read"
    },
    {
      "tool": "inspect",
      "action": "diagnostics",
      "method": "env.info",
      "scope": "coding:read"
    },
    {
      "tool": "read",
      "action": "read",
      "method": "fs.read",
      "scope": "coding:read"
    },
    {
      "tool": "edit",
      "action": "preview",
      "method": "fs.preview_patch",
      "scope": "coding:write"
    },
    {
      "tool": "edit",
      "action": "apply",
      "method": "fs.apply_patch",
      "scope": "coding:write"
    },
    {
      "tool": "shell",
      "action": "start",
      "method": "exec.start",
      "scope": "coding:exec"
    },
    {
      "tool": "shell",
      "action": "run",
      "method": "exec.run",
      "scope": "coding:exec"
    },
    {
      "tool": "job",
      "action": "list",
      "method": "job.list",
      "scope": "coding:read"
    },
    {
      "tool": "job",
      "action": "get",
      "method": "job.get",
      "scope": "coding:read"
    },
    {
      "tool": "job",
      "action": "logs",
      "method": "job.logs",
      "scope": "coding:read"
    },
    {
      "tool": "job",
      "action": "cancel",
      "method": "job.cancel",
      "scope": "coding:exec"
    },
    {
      "tool": "job",
      "action": "input",
      "method": "job.input",
      "scope": "coding:exec"
    },
    {
      "tool": "context",
      "action": "bootstrap",
      "method": "context.bootstrap",
      "scope": "coding:read"
    },
    {
      "tool": "context",
      "action": "read",
      "method": "context.read",
      "scope": "coding:read"
    },
    {
      "tool": "context",
      "action": "search",
      "method": "context.search",
      "scope": "coding:read"
    },
    {
      "tool": "context",
      "action": "checkpoint",
      "method": "context.checkpoint",
      "scope": "coding:write"
    },
    {
      "tool": "context",
      "action": "rebuild",
      "method": "context.rebuild",
      "scope": "coding:write"
    },
    {
      "tool": "context",
      "action": "storage",
      "method": "context.storage",
      "scope": "coding:read"
    },
    {
      "tool": "context",
      "action": "prune",
      "method": "context.prune",
      "scope": "coding:write"
    }
  ],
  "protected_rpc_methods": [
    "env.info",
    "workspace.list",
    "fs.stat",
    "fs.read",
    "fs.list",
    "fs.search",
    "fs.preview_patch",
    "fs.apply_patch",
    "git.status",
    "git.diff",
    "git.log",
    "git.show",
    "git.blame",
    "exec.start",
    "exec.run",
    "job.list",
    "job.get",
    "job.logs",
    "job.cancel",
    "job.input",
    "context.bootstrap",
    "context.read",
    "context.search",
    "context.checkpoint",
    "context.rebuild",
    "context.storage",
    "context.prune"
  ],
  "required_secrets": [
    "INTERNAL_CONTROL_SECRET",
    "RUNNER_TOKEN_PEPPER"
  ],
  "production_plaintext_vars": {},
  "development_plaintext_vars": {
    "RUNMESH_ENVIRONMENT": "development"
  },
  "durable_objects": [
    {
      "binding": "REGISTRY",
      "class": "RegistryDOv2"
    },
    {
      "binding": "RUNNER",
      "class": "RunnerDOv2"
    }
  ],
  "history_bindings": [
    "HISTORY_DB"
  ],
  "reviewed_release_record": {
    "version": "0.1.5",
    "state": "released",
    "commit": "77e82a1b59737a42cc090064651d1b0531890f21",
    "manifest_sha256": "34da9baefabddd882aeef79151b132b1de4086fce54de7a46fe853a7e8dac18a"
  },
  "observations": {
    "test_execution": "not_run",
    "signed_assets": "not_run",
    "deployed_worker": "not_run",
    "installed_runner": "not_run",
    "account_quotas": "not_run",
    "host_catalog": "not_run"
  }
}
```
