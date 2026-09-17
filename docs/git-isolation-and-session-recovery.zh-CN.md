# Git 隔离与会话恢复

[English](git-isolation-and-session-recovery.md)

## 文件系统根目录 workspace

路径包含关系与可执行文件信任是两个不同判断。`/.git`、`/usr/bin` 都位于 `/` 内；边界函数应规范化点路径、保留根目录分隔符，并拒绝名称前缀相似的同级目录。Windows 原生测试同时覆盖盘符根目录、大小写和 UNC 共享边界。

正确的包含关系不代表 workspace 内的 Git 可执行文件可信。只读 Git 检查不能成为命令执行入口。POSIX 和 Windows 的可信可执行文件列表均排除 workspace 的字面路径和规范路径，包括常见的系统级 Git 安装目录。可信 PATH 为空时拒绝执行，不回退到继承环境或系统隐式搜索。

在这一信任模型下，明确不支持文件系统根目录的隔离 Git 检查。Runner 会在读取 Git 元数据、创建临时隔离仓库之前拒绝规范化后的文件系统根目录或盘符根目录。五个 Git 方法统一返回 `git_unavailable`，本地诊断明确要求配置独立 workspace 目录。这项 Git 专属限制不会禁用其他文件系统、执行、Job 或 Context 权限。

MCP 继续过滤 Runner 原始错误和主机路径。`git_unavailable` 的安全恢复提示要求管理员检查 Git 安装，并配置非文件系统根目录的独立 workspace，使可信 Git 位于该 workspace 之外。提示不泄露真实路径，也不建议绕过 Git 隔离。

对于中央管理的 Runner，必须由合法管理员在控制面修改 workspace，例如指定 `/workspace` 下的独立仓库。不要修改本地 central profile，不要把引导 Bearer Token 当作管理员会话，也不要在文件系统根目录重新创建仓库。重新验收 Git 前应确认 desired/applied/reported policy 一致。

## Registry 错误与重连行为

| Registry 结果 | WebSocket 关闭方式 | 含义与恢复 |
| --- | --- | --- |
| `401` 或 `403` | `4001`，`runner credentials rejected` | 明确拒绝凭据；Runner 停止，不无限重试。 |
| `409` | `4000`，`stale runner session` | 会话或同步 fencing 冲突；保留现有凭据，重新连接并完成握手。 |
| 可用性失败，包括 `429` 和 `5xx` | `1013`，`control plane temporarily unavailable` | 保留服务不可用时较慢的退避重连。 |

映射覆盖 hello、connect 成功到 welcome 前的二次校验、heartbeat、sync、Job 事件、policy acknowledgement，以及 RPC 回复前的 session 校验。冲突仍会拒绝待处理桥接回复，绝不放行旧会话输出。未完成 welcome 的本地帧和协议不匹配独立处理，不再声称凭据被撤销。真正的 revoke/rotate 仍保留原有凭据版本隔离。

Runner 将可恢复的 `4000` 记录为 `session_conflict`，沿用带抖动的网络重连退避，且不替换凭据。是否致命由关闭码判断，不能由对端任意错误文案决定。这项修复不能反向证明以前没有详细 trace 的掉线一定来自 Registry `409`。

## 回归与交付边界

`git_unavailable` 明确归为 availability，默认状态为 `not_started`；旧 Runner 明确报告的状态（包括 `unknown`）仍予保留。恢复动作是由管理员修正配置，不是重放 Job 或自动重试。只更新 Worker 不能声称已升级 Runner 的状态报告。

完整 MCP 链路测试使用独立的根目录 Runner 与只读客户端，检查五个 Git 错误以及省略或部分提供历史查询可选参数的情况。`git_log` 数量和 `git_blame` 行范围未提供时，不向 RPC 对象写入 `undefined`，避免被严格 JSON 校验误拒绝。另一个独立 SQLite Worker 先接受 sync sequence 2，再以 `4000` 拒绝 sequence 1，随后以相同凭据完成新连接和 echo。这与普通 socket replacement、D1 历史批处理语义不同。

线上验收首先核对实际 dev 域名及干净源码提交，再通过已获授权的 dev MCP 客户端检查根目录 Git 错误。`test/helpers/session-conflict-probe.ts` 中的可复用会话探针只能用于明确授权的隔离测试 Runner；它会替换该身份现有的连接。即使测试失败也应恢复暂停的测试服务。不得增加公开测试后门、绕过管理员认证，或仅凭本地测试、健康响应声称线上通过。

回归覆盖根目录、普通目录、同级前缀、路径穿越；五个 Git 方法的根目录安全拒绝；独立只读 workspace 内真实执行 status、diff、log、show、blame；各传输路径的上游错误分类；旧会话 RPC 输出拦截；真实 WebSocket 冲突与重试。既有所有者、符号链接、元数据竞争和握手测试仍需通过。

源码测试不能替代已安装签名 Runner 的验收。源码修改不会更新中央 workspace 策略，也不会升级服务。应保留不可变发布资产和当前 Runner。要求先不部署时，不应向会自动部署的分支推送；先保留经过验证的本地提交。
