# 中央 Skill 内容（开发中）

[English](central-skills.md)

W07 在可选 Capabilities 状态所有者内提供有界、经审核的文本 bundle。这是开发
实现，不代表已启用生产或通过真实宿主验收。导入和读取均不安装 Runner、运行模型、
执行 shell，也不授予工具权限。

## 启用与导入

同时具备 CAPABILITIES 绑定和 CENTRAL_SKILLS_ENABLED=1 才暴露 Skill HTTP/MCP
入口。关闭时，原生十工具及原生调用不访问中央存储。development Wrangler 配置
现已增加独立的 CapabilitiesDOv1 SQLite 命名空间并显式启用 Skills，生产仍关闭。
候选通过既有检查后推送 GitLab dev，由已连接的开发构建触发部署。

发现请求重新检查客户端身份和当前授权。只有具备已启用 Skill 规则的客户端才会
看到 skill_list、skill_read 和资源模板；空规则、停用或缺失的 grant 均隐藏入口。
可见性查询失败时保留原生目录；缓存调用仍执行实时授权，隐藏入口不能替代访问
控制。原生工具调用不执行这次中央发现查询。

管理员使用原有会话打开 /admin/central。写请求必须同源并提供当前 CSRF token。
JSON API 为 GET/POST /admin/central/skills/{skill_id}，ID 来自路径而非请求正文。

1. 使用 action preview，提交 source、license 和 files（path/text 对象数组）。
2. 审阅返回内容和 digest；preview 不写入存储。
3. 使用 action stage 和 expected_revision 提交相同文件集合，首次创建为 0。
4. 读取暂存 bundle，核对后用 action activate、digest、expected_revision 启用。
5. 单独为客户端授予精确 Skill ID 和 digest；可直接授权或应用可复用工具集。

必须包括 SKILL.md，frontmatter 包含 name 和 description。首版仅支持单行标量
（包括简单引号），不支持多行 YAML、锚点、别名或通用 YAML 解析。name 使用小写
字母、数字和内部连字符，最多 64 UTF-8 字节。正文和 frontmatter 始终是用户提供
的内容；allowed-tools 和能力声明不能改变 ACL。来源、许可证由管理员填写，哈希
只证明内容一致，不证明可信作者。

仅接受文本文件集合，不支持压缩包、链接或自动安装。拒绝绝对路径、路径穿越、空
段、Windows 保留名称及数据流、反斜杠和大小写冲突。文件对象只能含 path 和 text。
限制：32 文件、单文件 64 KiB、规范化 bundle 256 KiB、管理请求 512 KiB、每个
Skill 32 版本、1,000 个 Skill、存储总量 16 MiB。达到上限时拒绝新增；不会自动
删除旧批准版本。这些是安全上限，不是实测容量承诺。

## 读取、更新与撤权

skill_list 只读授权后的批准元数据，不加载正文；最多返回客户端的 128 条授权
规则对应条目。首版不分页，对任意 cursor 明确拒绝。skill_read 使用 skill_id、
digest、path（默认 SKILL.md），同一任务所有附件必须复用同一 digest。

MCP resources 使用同一授权用例，URI 为
runmesh-skill://bundle/{skill_id}/{digest}/{path}。资源目录列出 SKILL.md，附件
按精确路径读取。两个入口返回前都复核凭据代次与授权。依赖故障明确失败，不伪造
成功空列表。

更新产生不可变新 bundle。启用会批准目标摘要并更新当前指针；旧批准版本只有在
匹配授权下才能继续读取。回退需使用当前 revision 显式启用保留摘要。停用阻止该
Skill 后续所有版本读取，但保留数据。撤权不能清除已进入客户端上下文的内容。
scripts 始终是文本，不自动执行。

可选 runmesh.json 文本附件声明 Runmesh 专有依赖：schema_version 为 1，
requiredCapabilities 为最多八个精确 CapabilityTarget 的数组，字段为 kind、
resource_id、version，remote_tool 另需 connection_profile_id。这是产品扩展，
不是标准 Skill frontmatter。附件计入不可变摘要，拒绝重复、额外字段及不支持的种类。
skill_list 只返回声明；skill_read 返回 dependencies，状态为 configured、
not_configured、not_authorized、disabled、incompatible 或 unavailable。
resources/read 在内容的 _meta.runmesh/dependencies 返回同样观察。未授权目标
不会被探测；检查仅使用有界的存储元数据，configured 不保证供应商在线或 OAuth
令牌有效。不会联网探测、递归加载、安装或提权。原生前置条件仍是内容，在执行时
检查；读取不选择 Runner，实际调用仍独立执行实时准入检查。

## 验证边界

领域、SQLite 和真实本地 Worker/Registry/MCP 入口测试覆盖恶意路径、preview
不写入、revision 冲突、回退、旧附件、读取期间撤权、摘要不加载正文、两套独立
客户端凭据、resources/工具一致性和关闭时零中央 I/O。它们不是两个真实 AI 产品
或公网供应商验收；剩余外部门禁见[灰度清单](central-rollout.md)。
