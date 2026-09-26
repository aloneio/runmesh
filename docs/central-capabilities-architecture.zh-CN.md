# 中央 MCP 与 Skill 架构

[English](central-capabilities-architecture.md)

当前开发版本采用实例共享能力库：同一实例内，所有通过身份验证且凭证有效的客户端，都可使用已启用、已发布的 MCP 工具和当前 Skill。管理员在控制台连接服务、安装 Skill，无需再逐客户端分配能力。生产启用仍须满足[发布门槛](central-rollout.md)。

## 所有权与依赖方向

一个 MCP 连接可提供原生 Runner 工具、中央远程 MCP 工具和 Skill 内容。中央操作不选择 Runner、不创建原生 Job，也不向执行机器安装内容。原生 scope、Runner 策略、工作区权限和 Worker–Runner 协议保持原有含义。

| 边界 | 所有者 | 依赖约束 |
| --- | --- | --- |
| 客户端身份与原生权限 | Registry 与现有身份验证 | 原生验证不依赖中央存储 |
| 共享发现与调用 | application/capabilities | 只依赖身份、配置、目录、传输等窄接口，不持有 SQL 或 SDK |
| 发布与版本规则 | domain/capabilities 与 contracts | 不依赖平台 I/O、SDK 或 Runner |
| 远程连接协议与凭证 | platform/connectors | 不依赖 Skill 实现或主机执行 |
| Skill 内容与启用 | Skill 应用、领域、平台模块 | 不自动执行或分配权限 |
| 公共 MCP provider | mcp/providers | 适配契约，不导入应用实现或存储 |
| 组合层 | capabilities-do.ts 与 HTTP 入口 | 注入特性接口，不复制准入规则 |

托管 OAuth 的应用层通过不依赖 SDK 的契约管理授权状态、持久化声明、刷新顺序和凭证租约；平台适配器负责协议发现、有界 HTTP 和 SQLite。仅组合根连接这些实现。连接器与 Skill 内部通过接口通信，不相互导入实现。

架构门禁检查模块所有权、反向依赖、运行时和类型循环，以及契约中的 SDK 泄漏。纯中央模块不得直接进行平台全局 I/O 或动态代码求值。这些是可维护性检查，并非操作系统沙箱。

## 共享准入与发布

客户端身份验证仍是必需条件。无效、已轮换或已撤销的凭证不能发现或调用中央能力。版本 2 身份可在原生 scope 为空时使用共享库，但不会因此获得 Runner 文件或执行权限；既有身份保留原生 scope 行为。

目录读取返回已启用服务中经审核且兼容的工具。调用跨越异步等待时重新检查客户端身份、服务状态、已审核目录和 schema、上游当前 schema，以及凭证代次。已经列出的工具不是可复用的授权凭证。调用过程中身份、配置或发布版本变化会阻止结果返回。截止时间仍有界，结果不确定的远程写操作不会自动重放。

remote_profiles 从本地元数据发现已发布服务的 ID 和名称；remote_tools 分页读取服务目录；remote_call 执行受控调用。较小的能力库也暴露直接工具名。超过直接目录上限时使用上述发现工具，避免较大共享库变成不可发现。

Skill 列表返回每个已启用 Skill 当前生效的 digest。读取要求该摘要仍为当前版本，返回前再次检查身份和 head revision。发布新版本会同步影响所有客户端；缓存旧摘要的请求被拒绝，客户端需刷新 skill_list。历史内容保留，供管理员检查或显式回滚。依赖状态只供提示，不会执行、启用或授权能力。

## 存储与升级

CapabilitiesDOv1 继续拥有中央状态，不重写 Registry 或 Runner 的表、身份、凭证和命名空间。中央 schema 初始化保留旧 v1 grant 行，但实时目录、调用和 Skill 读取不再访问它们，也不创建默认通配 grant 或备用 ACL。

客户端访问分配界面、grant RPC 和 toolset 分配实现已退役。/admin/central/grants 与 /admin/central/toolsets 路径返回 HTTP 410 和 central_client_access_retired，不修改状态，也不解析中央 owner。因此旧的限制性或已禁用 grant 不再限制有效客户端。

目录游标使用版本 2 和版本 2 MAC 命名空间，继续绑定客户端身份、凭证代次、服务和目录 revision、页大小及有效期。旧游标被拒绝，客户端需刷新目录。本次变化无需替换已存储的客户端密钥。

停用某个客户端时撤销其凭证；从所有客户端撤回能力时禁用服务、发布内容或 Skill。需要不同能力库的信任边界应使用独立实例。上游 OAuth 授权与客户端能力分配不同：托管连接保留服务授权，既有按客户端绑定的 OAuth 账户仍保留自身凭证边界。

旧 Worker 可能恢复历史 grant 行为，也可能拒绝版本 2 身份；回滚并不保证保留新的共享访问语义。切换版本前请阅读[管理与迁移说明](central-administration.zh-CN.md)。

## 有界操作

| 项目 | 上限与行为 |
| --- | --- |
| 已存储连接配置 | 1,000 个；按顺序分页扫描元数据 |
| 目录服务 | 200 个；只发现已启用且已发布的服务 |
| 直接工具目录 | 8 个服务 / 32 个工具；超出后使用 remote_profiles 和 remote_tools |
| 工具目录 | 每个快照最多 128 个工具；客户端每页最多 20 个 |
| 目录游标 | 最多 2,048 字节，5 分钟有效；绑定版本、revision 和身份 |
| Skill | 最多 1,000 个 head；skill_list 每页扫描最多 128 个 head |
| Skill 续页 | after / next_after；禁用项可能形成带续页指针的空页 |
| Skill resources/list | 有界遍历，拒绝重复或不前进的结果，不返回部分成功 |
| Skill 内容包 | 最多 32 个文本文件，每文件 64 KiB，总计 256 KiB，每 Skill 保留最多 32 个版本 |

这些是安全上限，并非延迟承诺；字节、数量和超时以契约为准。遇到异常状态拒绝操作，不自动修复或清空数据。

## 控制台与验证

普通连接流程只需服务名、MCP URL，以及无身份验证或 OAuth。工具发布仍需明确审核；安装或更新 Skill 后，当前版本进入共享库。管理操作保留同源、会话和 CSRF 检查；过期预览、刷新失败或 revision 冲突不能静默成为成功写入。

回归覆盖两个独立客户端无 grant 行使用共享库、忽略历史 grant、Skill 当前版本切换、超过 128 个 head、较大远程目录、凭证撤销和轮换、禁用服务、schema 变化、OAuth 边界、退役接口，以及不变的 Runner 准入。浏览器检查覆盖产品流程且不截图。完整验证计划、架构门禁和精确提交 CI 仍是发布要求。

细节参见[控制台管理](central-administration.zh-CN.md)、[目录审核](central-catalog.zh-CN.md)、[远程 MCP](central-remote-mcp.zh-CN.md)、[Skill](central-skills.zh-CN.md) 和 [OAuth](central-oauth.zh-CN.md)。
