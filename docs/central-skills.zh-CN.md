# 共享 Skill 内容（开发版）

[English](central-skills.md)

## 安装与发布

控制端选择 SKILL.md 与配套文本文件或文件夹即可安装。
POST /admin/central/skill-installations 从已验证元数据提取标识、名称和说明，原子
保存、批准并启用 bundle。同名更新需显式确认并携带当前 revision。所有凭据有效
的客户端共享当前版本，无需逐客户端授权或模板分配，不执行脚本。

底层 GET/POST /admin/central/skills/{skill_id} 保留 preview、stage、activate、
disable 和旧内容查看功能。修改要求管理员会话、同源 CSRF 和精确 revision。
preview 不写入；stage 不发布；activate 发布选定摘要。日常安装无需手填来源和许可证。

CAPABILITIES 与 CENTRAL_SKILLS_ENABLED=1 启用这些可选接口。开发环境已启用，生产
发布另行验收。发现请求实时验证客户端凭据；故障保留原生工具，原生调用不读取中央
状态。Skill 内容、allowed-tools 和注解不授予 Runner、计算机或工作区权限。

## 内容与存储边界

SKILL.md 必须含 name、description 元数据。仅支持单行标量（包括简单引号），不
支持通用多行 YAML、锚点或别名。名称为小写字母、数字和内部连字符，最多 64 UTF-8
字节。内容由用户提供，摘要只校验一致性，不证明作者或可信度；来源和许可证不独立验证。

仅接受文本文件集合，不支持压缩包、远程链接或可执行安装。拒绝绝对路径、路径穿越、
空段、Windows 保留名及数据流、反斜杠、大小写冲突。文件对象只含 path、text。
上限：32 文件、单文件 64 KiB、规范化 bundle 256 KiB、管理请求 512 KiB、每 Skill
32 版本、1,000 个 Skill、总存储 16 MiB。它们不是实测容量承诺，不自动删除旧内容腾空间。

## 列出、读取、更新与停用

skill_list 只返回当前启用且批准的元数据，不读取正文。每页扫描最多 128 个 head，
用 next_after 作为 after 继续，直到 null；停用项目导致空页时也要继续。也可只指定
skill_id，但不能与 after 同时使用。after 仅表示位置，不是授权令牌或快照保证，
每页独立验证凭据与发布 revision，并发更新时可能需要重新发现。

skill_read 接受 skill_id、digest、path（默认 SKILL.md）。只允许当前启用且已批准
的 digest。更新对所有客户端生效，旧摘要请求被拒绝，须重新 skill_list 并使用同一
新摘要读取正文和附件。旧 bundle 保留给管理员检查或使用当前 revision 显式回退。
停用阻止读取但不删数据；撤销客户端凭据阻止该客户端访问，但无法清除已交付的内容。

资源接口复用同一实时校验，URI 为 runmesh-skill://bundle/{skill_id}/{digest}/{path}。
resources/list 遍历有界分页、列出 SKILL.md；分页失败或循环时明确失败，不返回部分
成功。附件按需读取，读取期间身份或发布变化会扣留内容；脚本始终作为文本返回。

## 依赖元数据

可选 runmesh.json 文本附件包含 schema_version: 1、requiredCapabilities，最多八个
精确 CapabilityTarget（kind、resource_id、version；remote_tool 另含
connection_profile_id）。这是 Runmesh 扩展，不是标准 Skill 元数据。附件计入摘要，
拒绝重复、额外字段及不支持种类。

skill_list 返回声明，skill_read 根据共享发布状态报告 configured、not_configured、
disabled、incompatible、unavailable。resources/read 返回同样的 runmesh/dependencies 元数据。
Skill 依赖的当前摘要须与声明精确一致。检查不证明上游在线或 OAuth 有效，不自动
安装、启用、调用或递归加载依赖，不授予任何权限；实际调用独立检查当前准入条件。

## 验证边界

本地领域、SQLite、Worker/Registry/MCP 和浏览器测试覆盖发布、revision 冲突、旧摘要
拒绝、两个无授权行客户端、不创建旧授权存储、凭据撤销、超过 128 条及空页、资源一致性、
路径拒绝、不读取正文和原生权限不变；不替代[真实宿主验收](central-rollout.md)。
