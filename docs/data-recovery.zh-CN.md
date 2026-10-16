# 数据与凭据恢复

[English](data-recovery.md) · [升级指南](upgrading.zh-CN.md) · [验证指南](verification.zh-CN.md)

恢复是运维流程，不代表允许重放 Job 或替换身份。先在隔离部署中使用合成数据演练。计划、导出、恢复点和执行证据保存在 Git 之外。本流程不增加公开修复接口或自动恢复服务。

## 历史隔离与保留

D1 历史是可选功能，不是授权来源。损坏快照明确返回不可用，其他健康 Runner 的历史继续可读。非法输入和版本竞争失败不触发共享熔断；只有实际 D1 操作失败才触发依赖熔断。绑定工作区的实时 Job 查询仍执行原有授权检查。

每次清理最多扫描 20 个快照。非法 JSON、非法 Job、重复或不匹配的身份、超限正文会在原行标记 `corrupt_revision`、`corrupt_detected_at_ms`、`corrupt_reason`，不复制正文到其他存储。重复扫描不延长首次发现时间。隔离和删除都保留 revision CAS；D1 写入失败时停止本批，不提交游标。

正文在首次发现后的 `min(retention_days, 7)` 天满足清除条件；保留期元数据非法时按七天计算。清除后留下明确的不可用标记，**不会变成空历史成功**。当前生命周期的标记保留到人工修复；权威确认退休的生命周期遵循原有保留规则。对于保留期元数据损坏的已退休快照，仅在退休时间可信、已满七天隔离期、距离退休也已满七天且正文清空并标记过期后回收；不可信的退休时间仍需人工核对。故障和扫描积压可能延迟物理清除，不应宣传为精确时限保证。独立取证导出也必须有访问控制和有限保留期。

清理回执中的 `complete` 仅表示这一批扫描完成，不代表所有快照健康。隔离计数包含已经标记的行，不等于新增写入数。定时任务仅在延后或不可用时记录有界状态和计数，不输出快照正文。日志只包含有界分类和行 ID，不包含 `jobs_json` 或验证载荷。

带版本保护的游标保存在 `runmesh_job_cleanup_v2`。旧的两列 `runmesh_job_cleanup_v1` 保持原样，避免破坏旧版本回退。新游标从零开始有界重访，不复制旧进度。完整结构初始化不执行 DDL；缺失索引单独补建，失败不禁用健康读取。索引定义异常只报告，不自动删除。

## 单条快照修复

使用有权限的 D1 运维会话，确认账户和数据库，不以普通 Runner 权限代替数据库授权。维护期间暂停受影响生命周期的归档上传，不停止其他连接。修改前保留受保护、有容量上限及过期时间的备份。

使用绑定参数读取 `snapshot_id`、`runner_id`、`lifecycle_id`、`revision`、`retention_days`、`retired_at_ms` 和三个损坏标记，不直接输出正文。数据只能来自核验过的备份或原 Runner，必须对账当前记录偏好、保留期和较新的执行回执。缺少本地记录不代表 Job 没有执行，不能重跑命令制造历史。

在已构建的可信源码中，使用产品解析器将恢复数据规范化为新的私有文件；不要直接把包含未知字段的原始 JSON 写回：

```sh
node --import tsx --input-type=module - SOURCE_JSON CANONICAL_JSON RUNNER_ID <<'JS'
import { readFile, stat, writeFile } from 'node:fs/promises';
import { decodeHistorySnapshot, HISTORY_MAX_BYTES } from './apps/worker/src/contracts/history-snapshot.ts';
const [source, target, runner] = process.argv.slice(2);
if (!source || !target || !runner || (await stat(source)).size > HISTORY_MAX_BYTES) throw new Error('Invalid repair input');
const jobs = decodeHistorySnapshot(await readFile(source, 'utf8'), runner);
await writeFile(target, JSON.stringify(jobs), { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ validated_jobs: jobs.length }));
JS
```

通过已有、已认证的 D1 客户端绑定规范化 JSON、namespace、快照 ID、Runner ID、生命周期 ID 和刚读取的 revision，不拼接正文到 shell：

```sql
UPDATE runmesh_job_snapshots_v1
SET jobs_json = ?, revision = revision + 1,
    corrupt_revision = NULL, corrupt_detected_at_ms = NULL, corrupt_reason = NULL
WHERE namespace = ? AND snapshot_id = ? AND runner_id = ? AND lifecycle_id = ?
  AND revision = ? AND retired_at_ms IS NULL;
```

必须恰好修改一行。零行表示数据已变化或退休，应重新读取和对账，不删除版本条件、不盲目重试。随后验证该历史和另一健康 Runner，再执行一次有界清理。空替换代表运维人员明确接受归档损失，不是自动容错。不要清空命名空间、重建表或放宽授权。

## 协同恢复

凭据加密将 Capabilities 对象命名空间用于 HKDF 和 AES-GCM 附加认证，并绑定连接上下文。同一密文只有在身份、密钥和上下文相同时才能解密。密文的 `key_id` 是格式标签，不是实际部署密钥版本；证据只记录独立的密钥版本引用，不记录密钥本体。

1. 记录 commit/tree、已验证制品摘要、Worker/Runner/管理器版本、资源身份、绑定、配置和独立恢复通道，安全保留两项密钥版本、Runner 配置及服务清单。
2. 在隔离目标关闭新任务提交，核对排队、运行及结果未明的 Job。把最新撤销、凭据代次和权限变化保存在回退集合之外，统一维护边界或对账各资源恢复点的偏差。
3. 覆盖 Registry SQL/KV、相关 Runner DO、Capabilities SQL/KV、D1 和 Runner 本地状态、日志与配置；保存恢复点及撤销本次恢复的点，包括损坏标记和已有的两种游标表。
4. 保持执行关闭，恢复兼容程序和数据。普通升级保留原身份、`INTERNAL_CONTROL_SECRET` 和 `RUNNER_TOKEN_PEPPER`。跨身份迁移需要核验过的迁移或重新注册/OAuth 授权，不能移除加密绑定。
5. 开放访问前重新应用并验证备份之后的撤销和策略变化。独立记录不完整时保持关闭，轮换或重新签发相关凭据；不能相信恢复后的旧会话和策略缓存。
6. 检查凭据、外部 OAuth 和 Runner 重连，用原 Job ID 对账本地结果与已知外部影响，处理未决进程；**禁止自动重放恢复出来的 Job**。
7. 在隔离目标演练撤销恢复及回退。真实远端恢复与本地测试分别记录，必需证据齐备后才恢复常规工作。

[D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) 原地覆盖数据库并取消进行中的查询，不是自动克隆。远端演练使用另行创建的合成测试数据库，不恢复生产库来获得证据。[SQLite-backed DO PITR](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) 只恢复单对象 SQL/KV，不覆盖整个部署，且不支持本地开发环境。实际恢复窗口须核验账户及存储后端。

## 离线验收记录

```sh
node scripts/check-recovery-evidence.mjs PRIVATE_RECORD_JSON EXPECTED_COMMIT
```

检查器只验证提交的记录结构及状态，不证明平台真实性，不授权，也不执行恢复。退出码 `0` 表示该提交的必需记录完整，`1` 表示必需证据未齐或失败，`2` 表示输入非法。输出不包含资源身份、恢复点和密钥引用。本地测试不能满足 `remote_pitr`。

版本 1 顶层字段必须为 `schema_version`、`source`、`environment`、`credential_strategy`、`key_version_refs`、`components`、`checks`。其中版本为 `1`，环境为 `isolated`，策略为 `preserve` 或 `reauthorize`；`source` 包含 40 位小写十六进制 `commit`、`tree` 及 64 位 `artifact_sha256`。密钥引用字段为 `internal_control`、`runner_pepper`，不能填写密钥本体。

组件必须包含 `registry`、`runner_do`、`capabilities`、`d1`、`runner_local`；每项包含 `status`、`evidence_ref`、`source_identity`、`target_identity`、`restore_point`。检查项只有 `status` 和 `evidence_ref`。状态为 `passed`、`failed`、`not_run` 或 `unsupported`，只有必需项通过且引用非空才满足验收。引用使用符合 `[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}` 的不透明标签，不使用凭据链接、私有路径或秘密值；缺少证据时引用可为 null。保留身份模式要求 Registry、Runner DO、Capabilities 的源目标身份一致。

必需检查包括 `coordinated_restore_points`、`same_identity_credentials`、`cross_identity_rejection`、`latest_revocations`、`latest_permissions`、`job_results`、`no_job_replay`、`runner_connection`、`external_oauth`、`rollback`、`remote_pitr`。同时记录 `fresh_credentials`、`old_credentials_rejected`，重新授权模式下这两项也必需。平台未执行项保持明确状态并阻止“整体恢复通过”的结论；签名发行、原生 Windows/macOS 和具体客户端继续使用既有验收记录，不借用其他 SHA 的成功。
