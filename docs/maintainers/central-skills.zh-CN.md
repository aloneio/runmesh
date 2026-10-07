# 共享 Skill 内容

> 维护者参考：接口、协议和验证边界。日常操作请阅读[用户指南](../central-skills.zh-CN.md)。

[English](central-skills.md)

## 模块职责

以下路径均相对于 `apps/worker/src/`。

| 模块 | 职责 |
| --- | --- |
| `contracts/skill-lifecycle-values.ts`、`contracts/skill-lifecycle-receipts.ts` | 校验生命周期协议值，投影有界的成功回执。 |
| `application/skills/admin.ts` | 通过管理员会话权威协调安装、暂存、发布和库内容查看。 |
| `application/skills/reader.ts` | 通过只读仓储端口列出和读取已发布内容，复查客户端身份与发布状态，并生成文件清单。 |
| `application/skills/lifecycle.ts`、`domain/skills/lifecycle.ts` | 应用层协调已授权的维护操作；领域层负责清理资格规则和有界版本比较。 |
| `platform/skills/store.ts`、`platform/skills/lifecycle-store.ts` | 管理内容、head 与维护数据，持有发布和清理的同步事务。 |
| `platform/skills/capacity.ts` | 统一读取安装准入、版本历史和清理结果使用的元数据容量统计。 |
| `http/central-skill-lifecycle.ts`、`capabilities-do.ts` | HTTP 负责会话/CSRF 准入和响应状态；Durable Object 组装身份权威、仓储与用例。 |

## 安装与发布

控制端可选择 SKILL.md 与配套文本文件、Skill 文件夹，或导入 GitHub 公开仓库中
固定提交下的 Skill 目录。
POST /admin/central/skill-installations 从已验证元数据提取标识、名称和说明，原子
保存、批准并启用 bundle。同名更新需显式确认并携带当前 revision。所有凭据有效
的客户端共享当前版本，无需逐客户端授权或模板分配，不执行脚本。

底层 GET/POST /admin/central/skills/{skill_id} 保留 preview、stage、activate、
disable 和旧内容查看功能。修改要求管理员会话、同源 CSRF 和精确 revision。
preview 不写入；stage 不发布；activate 发布选定摘要。日常安装无需手填来源和许可证。

GET /admin/central/skills 返回 `active_digest ?? staged_digest` 对应的摘要元数据，
暂停时继续展示选用版本。head 分别保留选用版本和最近上传版本。GET
/admin/central/skills/{skill_id} 默认查看最近上传版本；携带 `?digest=` 可查看选用
或其他保留版本。卡片的当前版本入口使用明确摘要查看文件和恢复启用。

CAPABILITIES 与 CENTRAL_SKILLS_ENABLED=1 启用这些可选接口，开发与生产源码配置均已包含，部署与升级步骤见[发行状态](../release-readiness.zh-CN.md)。发现请求实时验证客户端凭据；故障保留原生工具，原生调用不读取中央
状态。Skill 内容、allowed-tools 和注解不授予 Runner、计算机或工作区权限。

## 内容与存储边界

SKILL.md 的 name、description 元数据必须为字符串。YAML core 解析器可读取引号
标量、多行标量、集合及附加元数据；转换为对象前先检查语法树，上限为 8 KiB、512 个
节点和八层深度，并拒绝别名、显式标签、合并键、重复键及原型键。名称使用小写字母、
数字和内部连字符，最多 64 UTF-8 字节。内容摘要绑定已存储的元数据和文件；解析器
更新后验证历史版本时，沿用其原始元数据和摘要。

安装内容为 UTF-8 文本集合，文件对象只含 path、text。相对路径检查涵盖路径穿越、
空段、Windows 保留名及数据流、反斜杠和大小写冲突。上限为 256 文件、单文件 1 MiB、
规范化 bundle 8 MiB、管理上传请求 12 MiB、每 Skill 32 版本、1,000 个 Skill 和
256 MiB 已存储 bundle。清理通过下述显式生命周期操作完成；再次安装已有摘要时，
沿用内容行和创建时间。

文件大小按 UTF-8 字节计算，容量统计 bundle 的逻辑字节数，包含 JSON 编码和元数据。
Cloudflare 物理存储及计费用量另行统计。浏览器从服务端合同获取上传限制。文件内容
分行存储，保持在 SQLite 单行大小上限内。Schema 2 内容的摘要、修订号和发布状态
保持原值，生命周期元数据由新存储适配器管理的附属表保存。

## 固定 GitHub 来源

POST `/admin/central/skill-source/preview` 接受
`{source:{repository,commit,path},expected_revision:0}`。repository 为公开的
`https://github.com/owner/repo` 地址，commit 为完整的 40 位小写提交 SHA，path 为
Skill 目录，仓库根目录使用空字符串。平台读取器验证固定提交，每次读取最多 32 个
文本文件。所选文件夹路径最多八段，每份树响应最多 2,048 个条目和 512 KiB 元数据，
操作期限为 25 秒，同时遵守常规文件与 bundle 上限。符号链接和子模块会被拒绝。

预览返回 `{state:"previewed",source,bundle}`，此时尚未写入内容。
POST `/admin/central/skill-source/install` 接受同一来源、预览得到的 digest 和当前
expected_revision。安装重新读取固定提交并核对预览摘要，再复用常规安装事务。
修订号变化时返回冲突。bundle 中的来源链接标识具体提交和目录，网络读取通过独立
平台端口完成。

## 历史、比较、保留与清理

生命周期路由位于 `/admin/central/skills/{skill_id}` 下，共用管理员会话、同源
CSRF 边界和现有 Skill head 修订号。应用策略依赖仓储端口，SQL 事务由平台存储
负责。历史查询只读取摘要元数据和容量计数。

| 路由 | 输入 | 返回 |
| --- | --- | --- |
| GET `/versions` | — | head、最多 32 个版本的摘要、时间、保留状态与容量 |
| POST `/compare` | before、after 摘要 | 同一修订号下的文件和元数据差异 |
| POST `/retention` | digest、pinned、expected_revision | 更新后的保留状态和 head |
| POST `/cleanup-preview` | 精确 digests 数组、expected_revision | 绑定会话、有效五分钟的计划，含 fingerprint 和逻辑字节数 |
| POST `/cleanup` | fingerprint、expected_revision、confirm:true | 删除摘要集合、释放逻辑字节数、更新后的 head 与容量 |

比较会验证两个已存储 bundle，并在返回前复查权限和修订号。变化文件列表保持完整，
展示文本限定每个文件每侧 16 KiB、合计 128 KiB 和 2,048 行。截断标记引导界面打开
保留版本的完整文件。元数据差异包含名称、说明、来源、许可证和依赖声明。

每次成功保留或清理均推进 head 修订号。清理保护使用中的摘要、暂存/最近上传的摘要
和已保留版本，暂停 Skill 的 active 摘要同样保留。预览保存精确选择集合，任一成员
被保护或已缺失时，整批返回相应错误。每个 Skill 保存一份清理计划，新预览替换旧
计划，并绑定管理员会话。确认时在同一事务内核对修订号、会话、有效期、摘要集合、
字节总数与实时保护状态，然后删除文件及元数据、推进 head 并消费计划。此流程无需
周期清理 alarm。

恢复历史版本复用已有 activate 动作，提交目标摘要和当前修订号，保留原始内容摘要。
`created_at_ms:null` 表示旧版本未记录安装时间，界面省略时间展示。
`skill_version_metadata_v1` 和 `skill_cleanup_plans_v1` 两个附属表保留核心 schema 2
及不可变 bundle 内容。

生命周期失败使用 `skill_lifecycle_*` 错误码，operation_state 为 not_started 或
unknown。写入结果未知时先刷新历史，再进行下一次修改。浏览器校验回执，并在更改
选择、刷新或出错后清除旧确认项。

## 列出、读取、更新与停用

skill_list 只返回当前启用且批准的元数据，不读取正文。每页扫描最多 128 个 head，
用 next_after 作为 after 继续，直到 null；停用项目导致空页时也要继续。也可只指定
skill_id，但不能与 after 同时使用。after 仅表示位置，不是授权令牌或快照保证，
每页独立验证凭据与发布 revision，并发更新时可能需要重新发现。

skill_read 接受 skill_id、digest、path（默认 SKILL.md）。只允许当前启用且已批准
的 digest。更新对所有客户端生效，旧摘要请求被拒绝，须重新 skill_list 并使用同一
新摘要读取正文和附件。旧 bundle 保留给管理员检查或使用当前 revision 显式回退。
停用阻止读取但不删数据；撤销客户端凭据阻止该客户端访问，但无法清除已交付的内容。

读取 SKILL.md 还会返回整个 bundle 的 `files:[{path,bytes,sha256}]` 清单。每个
SHA-256 基于原始 UTF-8 文件文本，bytes 为该文本的 UTF-8 字节数。附件读取返回指定
文件正文，客户端始终使用同一 bundle 摘要。文件哈希复用现有 digest 端口，操作中止
时停止计算。MCP 资源读取通过 `_meta["runmesh/files"]` 返回同样清单，通过
`_meta["runmesh/dependencies"]` 返回依赖状态。

资源接口复用同一实时校验，URI 为 runmesh-skill://bundle/{skill_id}/{digest}/{path}。
resources/list 遍历有界分页、列出 SKILL.md；分页失败或循环时明确失败，不返回部分
成功。附件按需读取，读取期间身份或发布变化会扣留内容；脚本始终作为文本返回。

## 依赖元数据

可选 runmesh.json 文本附件包含 schema_version: 1、requiredCapabilities，最多八个
精确 CapabilityTarget（kind、resource_id、version；remote_tool 另含
connection_profile_id）。这是 Runmesh 扩展，不是标准 Skill 元数据。附件计入摘要，
校验覆盖精确字段、条目唯一性及 skill/remote_tool 两种类型。

skill_list 返回声明，skill_read 根据共享发布状态报告 configured、not_configured、
disabled、incompatible、unavailable。resources/read 返回同样的 runmesh/dependencies 元数据。
Skill 依赖的当前摘要须与声明精确一致。检查不证明上游在线或 OAuth 有效，不自动
安装、启用、调用或递归加载依赖，不授予任何权限；实际调用独立检查当前准入条件。

## 验证边界

本地领域、SQLite、Worker/Registry/MCP 和浏览器测试覆盖发布、revision 冲突、旧摘要
拒绝、两个无授权行客户端、不创建旧授权存储、凭据撤销、超过 128 条及空页、资源一致性、
路径拒绝、不读取正文和原生权限不变。生命周期测试涵盖第 33 版容量拒绝、显式清理
后恢复安装、active/staged/pinned 保护、预览替换及过期、并发安装/激活/保留、回执
校验与事务回滚。来源测试涵盖固定提交、有界遍历和预览到安装的一致性。发版前请
结合本次验证报告与[真实宿主验收](../central-rollout.md)核对结果。
