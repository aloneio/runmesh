import { rpcOperation, type RpcOperationName } from "@aloneio/runmesh-protocol";

/** Action-to-RPC bindings also drive diagnostics and catalog checks. Local
 * control operations (selection/listing) are deliberately not Runner grants. */
export const MCP_RPC_ACTIONS = Object.freeze({
  inspect: Object.freeze({ list: "fs.list", search: "fs.search", stat: "fs.stat", git_status: "git.status", git_diff: "git.diff", git_log: "git.log", git_show: "git.show", git_blame: "git.blame", diagnostics: "env.info" }),
  read: Object.freeze({ read: "fs.read" }),
  edit: Object.freeze({ preview: "fs.preview_patch", apply: "fs.apply_patch" }),
  shell: Object.freeze({ start: "exec.start", run: "exec.run" }),
  job: Object.freeze({ list: "job.list", get: "job.get", logs: "job.logs", cancel: "job.cancel", input: "job.input" }),
  context: Object.freeze({ bootstrap: "context.bootstrap", read: "context.read", search: "context.search", checkpoint: "context.checkpoint", rebuild: "context.rebuild" }),
} as const satisfies Record<string, Readonly<Record<string, RpcOperationName>>>);

export const MCP_ACTION_REQUIREMENTS = Object.freeze(Object.entries(MCP_RPC_ACTIONS).flatMap(([tool, actions]) =>
  Object.entries(actions).map(([action, method]) => {
    const requirement = rpcOperation(method);
    if (requirement === undefined) throw new Error("MCP action has no protected RPC contract");
    return Object.freeze({ tool, action, method, ...requirement });
  })));
