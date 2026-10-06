# 升级已有实例

[English](upgrading.md) · [文档目录](README.zh-CN.md)

兼容的协议 v2 升级保留现有 Worker、Durable Object 命名空间、D1 数据库、密钥、Runner 配置和服务布局。较早的安装请先核对[旧版本迁移](migration.md)说明中的适用版本。

## 选择目标版本

升级前核对实例向客户端共享的 MCP 和 Skill，部署后刷新客户端目录和 Skill 版本。共享内容和客户端访问可在控制端管理，具体操作见[MCP 和 Skill 指南](central-administration.zh-CN.md)。计算机访问继续使用已配置的 Runner 和工作区权限。

先读[版本说明](release-notes.zh-CN.md)和[发行状态](release-readiness.zh-CN.md)。生产升级使用已发布、独立验签的正式包；候选版和开发预发布放在独立测试环境。

保留 MCP、Skill 绑定，以及现有 Registry 和 Runner 命名空间。资源标识和已有的两个密钥保持不变；OAuth 加密使用 `INTERNAL_CONTROL_SECRET`。先部署正式版本，核对运行中的 Worker，再更新 Runner。下文的受管系统服务流程用于将 Runner 0.1.6 更新到 0.1.7。

分别安排以下更新：

| 组件 | 更新步骤 |
| --- | --- |
| Worker | 部署经过审核的控制面代码 |
| Runner | 在控制台选择发行版，见[更换 Runner 版本](runner-versions.zh-CN.md) |
| MCP 客户端 | Worker 更新后刷新缓存的工具定义 |

功能取决于整套组件是否兼容。例如 Context `storage` 和 `prune` 从 Runner 0.1.4 开始提供。动作返回 `runner_upgrade_required` 时，安装兼容 Runner 并重新连接，使 Worker 读取其当前能力。

## 准备维护窗口

记录预期 Worker 提交、各 Runner 安装版本、服务实际程序路径和客户端工具目录。使用服务实际程序单独运行 `runmesh --version`，再运行 `runmesh doctor --json`。给 `doctor` 加 `--profile` 检查自定义配置，加 `--user` 检查用户级服务。

备份部署配置、密钥、控制面数据、Runner 配置与状态、服务清单、已验证包和项目数据，并在独立实例演练恢复。

重启 Runner 前暂停新任务，并完成或取消运行中和排队的任务。恢复后的任务若显示 `unknown` 或 `cancelling`，请在主机上核对进程，并保留任务 ID 以便跟进。撤销访问时也要检查这些运行中的任务。

## 执行升级

1. **演练目标组合。** 验证签名发行物，在测试环境使用目标 Worker、Runner、服务账号和 MCP 客户端。
2. **部署 Worker。** 通过现有生产 `main` 路径更新，保留资源绑定和密钥值。替换 `RUNNER_TOKEN_PEPPER` 会使已注册 Runner 凭据失效。
3. **逐台更新 Runner。** 已配备版本管理器的受管安装使用[远程版本管理](runner-versions.zh-CN.md)。首次更新程序包或使用自定义部署时，按下文适用流程操作，保留配置、状态和上一份已验证包。
4. **刷新客户端目录。** 在各 MCP 客户端重新加载 Runmesh 连接和工具定义。
5. **完成验收后**恢复日常工作。

[便携式安装示例](portable-runner-installation.md)用于首次安装。已有实例在包更新期间保留注册信息；凭据恢复和完整卸载分别按对应维护流程操作。

## 更新用户级服务

Linux、macOS 和 Windows 的用户级服务，均使用服务所属账号完成更新。先完成上文的维护准备，通过系统服务管理器停止服务，再按原部署方式更新已经验签的程序包。让服务原有的程序路径指向更新后的包，并保留配置、状态和服务定义。

使用更新后的程序和原配置文件运行以下命令。`install --user` 会更新服务定义并启动服务；从 0.1.7 起，还会自动补齐用户级启动标记，保留自定义程序路径和其他参数。

Linux 或 macOS：

```sh
set -e
RUNNER='/absolute/path/to/service/bin/runmesh'
PROFILE='/absolute/path/to/existing/profile.json'
"$RUNNER" --version
"$RUNNER" install --user --profile "$PROFILE"
"$RUNNER" doctor --user --profile "$PROFILE" --json
```

Windows 在服务所属账号的 PowerShell 会话中执行：

```powershell
$Runner = 'C:\path\to\service\runmesh.cmd'
$RunnerProfile = 'C:\path\to\existing\profile.json'
& $Runner --version
if ($LASTEXITCODE -ne 0) { throw '请检查 Runner 程序路径。' }
& $Runner install --user --profile $RunnerProfile
if ($LASTEXITCODE -ne 0) { throw '请检查服务安装命令的输出。' }
& $Runner doctor --user --profile $RunnerProfile --json
if ($LASTEXITCODE -ne 0) { throw '请检查 Runner 健康检查结果。' }
```

确认显示的版本与目标一致，再完成下文的验收。原有 Runner 注册信息和配置继续沿用。

## 将标准受管 Runner 从 0.1.6 更新到 0.1.7

托管命令用于首次安装和同版本重新注册。已有 0.1.6 安装先在旁边准备经过验签的 0.1.7 目录，在维护窗口切换 `current` 链接，再按原服务定义启动。这样保留 Runner ID、凭据、工作区策略、配置和状态，以及服务账号与启动参数。

本流程适用于**由托管安装器创建的标准系统服务**。先确认服务通过下表的 `current` 路径启动，`current` 链接指向对应的 `versions` 目录，启动器使用相对路径访问私有 Node。用户级服务按[更新用户级服务](#更新用户级服务)操作；自定义系统路径或外部 Node 布局由服务维护者按原程序包部署方式更新。

| 系统 | 保持不变的程序入口 | 保持不变的服务定义 |
| --- | --- | --- |
| Linux | `/opt/runmesh/current/bin/runmesh` | `/etc/systemd/system/runmesh-runner.service` 及已有覆盖配置 |
| macOS | `/opt/runmesh/current/bin/runmesh` | `/Library/LaunchDaemons/io.alone.runmesh.runner.plist` |
| Windows | `C:\Program Files\Runmesh\current\runmesh.cmd` | 已有 `RunmeshRunner` 计划任务；原 XML 位于 `C:\ProgramData\Runmesh\RunmeshRunner.xml` |

在同一个 root／管理员会话中操作，并确保没有其他安装或维护同时运行。先完成上文的备份和任务排空，再按[独立验签与校验和步骤](portable-runner-installation.md#independently-verify-a-downloaded-package)验证 `runmesh-runner-0.1.7.tgz`。暂存包使用可信的 Node/npm；保留的私有 Node 应满足 22.x 中的 22.23.2 及以上版本，或 24.x 中的 24.21.0 及以上版本。

### Linux 与 macOS

执行[共用的 POSIX 暂存命令](upgrading.md#stage-the-package-on-linux-or-macos)，将 `ARTIFACT` 替换为已经独立验签的安装包绝对路径。命令记录旧目录 `OLD`，在新目录安装 0.1.7，保留兼容的私有运行时与相对路径启动器，并核对新版本。这时原服务仍运行旧包。保留输出的 `OLD` 路径，供恢复时使用；新目录保持管理员所有权和服务账号的读取、执行权限。

切换前暂停服务：

- **Linux：**运行 `systemctl stop runmesh-runner.service`，确认 `systemctl show runmesh-runner.service --property=ActiveState --value` 返回 `inactive`，且 `MainPID` 为 `0`。
- **macOS：**运行 `launchctl bootout system/io.alone.runmesh.runner`，确认旧 Runner 进程已退出。这会卸载已加载的任务，避免 `KeepAlive` 在切换期间重新启动它；原 plist 文件保留。

按[POSIX 链接切换命令](upgrading.md#switch-the-posix-service)，通过保留的私有 Node 将新链接原子替换到 `current`。Linux 用 `systemctl start runmesh-runner.service` 启动；macOS 用 `launchctl bootstrap system /Library/LaunchDaemons/io.alone.runmesh.runner.plist` 启动。运行 `/opt/runmesh/current/bin/runmesh --version` 和 `/opt/runmesh/current/bin/runmesh doctor --json`，再执行下文的验收。

### Windows

在管理员 PowerShell 中执行[Windows 暂存与切换命令](upgrading.md#stage-and-switch-on-windows)。将 `$Artifact` 替换为已验签包的绝对路径；确认当前 junction、旧版本和新版本目录均位于标准安装根目录内。

暂存步骤保留私有 Node 与相对路径启动器，安装并核对新的 Runner 包。确认新文件继承了安装根目录的访问策略，服务账号可以读取和执行。切换步骤保存计划任务原启用状态，暂时禁用并停止任务，等待退出后，将旧 junction 留作 `current.previous-0.1.6`，再将新 junction 命名为 `current`。任务的操作、账号、参数和其他设置保持不变。

原本启用的任务会恢复启用并启动；原本禁用的任务保持禁用，由维护者选择启动时间。检查入口程序版本，运行中的服务通过 `doctor --json` 后，再完成下文验收。保留旧版本目录和 `current.previous-0.1.6`，直至验收结束。

### 恢复旧包

验收失败时，按同一平台步骤暂停服务。POSIX 将 `current.next` 指向记录的 `OLD` 目录，再用相同 Node 命令替换 `current`；此时传入的预期旧目标应为当前 0.1.7 目录。Windows 在任务禁用且停止后，把新的 `current` junction 改名为一个尚未使用的 `current.failed-0.1.7`，再把 `current.previous-0.1.6` 改回 `current`。使用原服务定义启动，并恢复任务原启用状态。

保留配置、状态和经过验证的安装包，直到恢复后的服务通过检查。验收完成后，清理本次升级创建的暂存目录和 npm 配置文件，按备份策略保留上一版本。

## 验收结果

确认 Worker 提交符合预期，再检查每台服务实际程序的版本和 `doctor --json` 结果。确认 Runner 在线且已确认工作区策略。

使用真正要接入的 MCP 客户端，核对所选 Runner、列出工作区、读取无害文件，并在获准的测试工作区运行无害命令。保留回执，使用原 `job_id` 和 `workspace_id` 查询同一个任务及保留日志，同时验证一次预期权限拒绝。

工作流依赖输入、取消、排队或云端历史时，用受控测试任务分别验证。记录组件版本和结果，再恢复日常工作。

## 恢复失败步骤

| 情况 | 处理 |
| --- | --- |
| 签名、哈希、版本或来源不匹配 | 停止启用，获取相互匹配且通过验证的发行物 |
| 命令或修改结果不确定 | 先检查原任务或文件，再决定是否重试 |
| 服务或兼容性失败 | 保留日志和状态，恢复经过演练的兼容程序、部署与状态组合 |
| 凭据丢失、到期或撤销 | 使用对应的授权延期、轮换或恢复注册流程 |

按演练方案一起恢复相互匹配的程序、配置和数据版本。排查升级问题期间，保留当前状态和已验证安装包的副本。
