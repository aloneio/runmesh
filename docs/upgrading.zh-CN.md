# 升级已有实例

[English](upgrading.md) · [文档目录](README.zh-CN.md)

兼容的协议 v2 升级保留现有 Worker、Durable Object 命名空间、D1 数据库、密钥、Runner 配置和服务布局。较早的安装请先核对[旧版本迁移](migration.md)说明中的适用版本。

## 选择目标版本

升级前核对实例向客户端共享的 MCP 和 Skill，部署后刷新客户端目录和 Skill 版本。共享内容和客户端访问可在控制端管理，具体操作见[MCP 和 Skill 指南](central-administration.zh-CN.md)。计算机访问继续使用已配置的 Runner 和工作区权限。

先读[版本说明](release-notes.zh-CN.md)和[发行状态](release-readiness.zh-CN.md)。生产升级使用已发布、独立验签的正式包；候选版和开发预发布放在独立测试环境。

保留 MCP、Skill 绑定，以及现有 Registry 和 Runner 命名空间。资源标识和已有的两个密钥保持不变；OAuth 加密使用 `INTERNAL_CONTROL_SECRET`。先部署兼容的 Worker 并核对运行结果，再更新 Runner。下文的受管系统服务流程读取实际旧版本，使用明确选择并验签的目标版本，也适用于 `0.1.6-dev.26` 等旧开发版。

首次启用远程版本管理时，选择包含独立 `dist/maintenance.cjs` 的[已验签开发包](dev-runner-prereleases.zh-CN.md)。在共用暂存命令中设置 `ENABLE_MANAGER=1` 或 `$EnableManager = $true`，切换后继续执行[管理器首次启用](#切换程序后首次启用管理器)。仅更新程序包时可关闭该选项；已发布的 0.1.7 包早于此功能。

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

## 更新尚未启用版本管理器的标准受管 Runner

托管命令用于首次安装和同版本重新注册。旧安装先在旁边准备精确目标版本的验签包，在维护窗口切换 `current` 链接，再按原服务启动。保留 Runner ID、凭据、工作区策略、配置、任务状态、服务账号与启动参数。这项迁移不需要重新注册或执行 `uninstall --purge`。

本流程适用于**由托管安装器创建的标准系统服务**。先确认服务通过下表的 `current` 路径启动，`current` 链接指向对应的 `versions` 目录，启动器使用相对路径访问私有 Node。用户级服务按[更新用户级服务](#更新用户级服务)操作；自定义系统路径或外部 Node 布局由服务维护者按原程序包部署方式更新。

| 系统 | 保持不变的程序入口 | 保持不变的服务定义 |
| --- | --- | --- |
| Linux | `/opt/runmesh/current/bin/runmesh` | `/etc/systemd/system/runmesh-runner.service` 及已有覆盖配置 |
| macOS | `/opt/runmesh/current/bin/runmesh` | `/Library/LaunchDaemons/io.alone.runmesh.runner.plist` |
| Windows | `C:\Program Files\Runmesh\current\runmesh.cmd` | 已有 `RunmeshRunner` 计划任务；原 XML 位于 `C:\ProgramData\Runmesh\RunmeshRunner.xml` |

在同一个 root／管理员会话中操作，确保没有其他安装或维护同时运行。安装根目录已有 `manager` 时，使用[已有管理器的升级或恢复流程](runner-versions.zh-CN.md)，不要套用首次启用步骤。先备份和排空任务，再按[独立验证说明](portable-runner-installation.md#independently-verify-a-downloaded-package)取得同一发行版的完整资产，以及通过独立渠道信任的源码副本。共用暂存命令会调用该源码的验签器与可信公钥目录，再次核对签名、发行契约、包大小及摘要。

共用脚本填写三项输入，并选择是否首次启用管理器；必要时另行指定暂存用运行时：

| 输入 | 含义 |
| --- | --- |
| `TARGET_VERSION` / `$TargetVersion` | 已选择的完整签名版本号；旧版本由脚本读取，不要求等于 `0.1.6` |
| `DOWNLOAD` / `$Download` | 该版本完整发行资产所在的绝对目录 |
| `TRUSTED_CHECKOUT` / `$TrustedCheckout` | 独立可信的源码目录，含验签器和可信公钥目录 |
| `STAGING_NODE` / `$StagingNode` | 默认留空，沿用旧私有 Node；旧运行时不兼容时填写另行验签的兼容 Node 程序绝对路径 |
| `ENABLE_MANAGER=1` / `$EnableManager = $true` | 首次启用独立管理器；只更新程序包时使用 `0` / `$false` |

暂存使用可信 Node/npm，新包中的私有 Node 须满足 22.x 中的 22.23.2 及以上版本，或 24.x 中的 24.21.0 及以上版本。兼容性检查不通过时，先准备独立验证过的兼容运行时并设置上述可选输入。脚本将其复制到新目录，保留旧运行时用于恢复。

托管安装可能只保留私有 Node 而没有 `npm`。暂存前可从 [Node.js 官方发行目录](https://nodejs.org/download/release/)获取上述兼容范围内、匹配主机系统及架构的分发包，核验签名校验和后解压到管理员拥有的临时目录。仅在本次维护会话中，将其 `bin` 目录（POSIX）或包含 `node.exe`、`npm.cmd` 的目录（Windows）加入 `PATH`，确认 `node --version`、`npm --version` 可用。[本地 tarball 安装说明](portable-runner-installation.md#install-from-the-verified-local-tarball)采用相同的离线 npm 方法。

首次启用前，检查控制台的待处理目标。没有未完成请求时，选择与暂存包相同的精确版本；已有同目标请求可以保留。不同目标的未完成请求不能通过表单覆盖：先核验该发行版，确认可以让新管理器完成已有请求，待它进入终态后再申请最终目标。不能接受这次中间切换时，只执行程序包更新，设置 `ENABLE_MANAGER=0` / `$EnableManager = $false`，保持管理器未安装；原请求继续等待。管理器启动后会处理原有目标，可能把刚部署的新包切回旧版。首次启用步骤会启动 Runner 和管理器，应安排在允许两项服务运行的维护窗口。

### Linux 与 macOS

执行[共用 POSIX 暂存命令](upgrading.md#stage-the-package-on-linux-or-macos)，填写上述输入。它验证发行资产，记录旧目录 `OLD`、旧版本 `OLD_VERSION` 和原执行模式 `ORIGINAL_MODE`，在 `versions/$TARGET_VERSION` 暂存新包，复制所选兼容运行时并保留相对路径启动器。启用管理器时还会检查独立 `maintenance.cjs` 的 `--help`。原服务此时继续运行旧包；保留这些 shell 变量和打印的旧目录，供切换及恢复使用。

切换前暂停服务：

- **Linux：**运行 `systemctl stop runmesh-runner.service`，确认 `systemctl show runmesh-runner.service --property=ActiveState --value` 返回 `inactive`，且 `MainPID` 为 `0`。
- **macOS：**运行 `launchctl bootout system/io.alone.runmesh.runner`，确认旧 Runner 进程已退出。这会卸载已加载的任务，避免 `KeepAlive` 在切换期间重新启动它；原 plist 文件保留。

按[POSIX 链接切换命令](upgrading.md#switch-the-posix-service)，通过已验证的新私有 Node 将新链接原子替换到 `current`。Linux 用 `systemctl start runmesh-runner.service` 启动；macOS 用 `launchctl bootstrap system /Library/LaunchDaemons/io.alone.runmesh.runner.plist` 启动。运行 `/opt/runmesh/current/bin/runmesh --version` 和 `/opt/runmesh/current/bin/runmesh doctor --json`。选择 `ENABLE_MANAGER=1` 时，在同一 shell 中继续下面的首次启用步骤。

### Windows

在管理员 PowerShell 中执行[共用 Windows 暂存与切换命令](upgrading.md#stage-and-switch-on-windows)，填写上述输入。命令验证发行资产，并确认当前 junction 和两个版本目录均位于标准安装根目录内；不修改原注册信息。

暂存步骤复制所选兼容 Node 并保留相对路径启动器，安装并核对新 Runner 和所需维护包。确认新文件继承安装根目录的访问策略，原服务账号可读取和执行。切换时保存任务原启用状态，暂时禁用并停止任务，等待退出后，将旧 junction 保留为 `$Previous`，再将新 junction 命名为 `current`。保留同一 PowerShell 会话中的 `$Old`、`$Previous`、`$New`、`$OriginalMode` 等变量。

只更新程序包时，原本禁用的任务保持禁用。首次启用管理器需要启动 Runner，因此脚本会拒绝直接改变已禁用任务；先安排明确的服务启用窗口。运行中的 Runner 通过 `doctor --json` 后，选择 `$EnableManager = $true` 的安装继续下面步骤。

### 切换程序后首次启用管理器

在同一 root／管理员会话执行[共用首次启用命令](upgrading.md#enable-the-manager-after-the-package-switch)。命令使用原 canonical profile 和读出的执行模式；原模式为 `privileged_host` 时，显式带上 `--confirm-privileged-host`。这是现有全主机服务执行 `install` 仍要求的确认，不能省略。命令不传 `--executable-path`，保留已有受管服务的程序路径、参数和账号，只允许安装逻辑更新已知生成字段。

脚本检查安装报告中的 `remote_version_management: available` 和原执行模式，并确认系统管理器服务正在运行，然后再次运行 `doctor`。原服务或 profile 显示身份／模式不一致时先处理该问题；不要借首次启用来切换权限模式。若返回 `manual` / `custom_service_layout`，检查实际服务定义及覆盖配置，不要删除自定义参数来强行启用。

独立管理器会从已验签包复制到安装根目录的 `manager`。控制台还需从“等待主机管理器领取”推进到目标版本完成，并保留原 Runner 身份和工作区策略；本地服务启动成功不等于远程请求已经领取。

### 恢复旧包

如果管理器已经启动，手工恢复前先通过系统服务管理器停止它，保留其程序包与 journal。未完成的版本操作必须先完成恢复，不可删除 journal 或安装锁再切换 `current`。重新启动管理器前也要核对控制台的目标，避免再次自动切换。

确认没有维护操作运行后，按同一平台步骤暂停 Runner。重新读取并记录 `current` 的实际物理路径，核对程序包身份，确认它是受管 `versions` 目录的直属子目录。管理器即使安装同版本，也可能已经切换到另一个目录，不能假定当前目标仍为 `NEW` / `$New`。POSIX 将实际路径记为 `ROLLBACK_FROM`，让 `current.next` 指向原 `OLD`，用原 Node 命令替换 `current`，传入 `ROLLBACK_FROM` 作为预期当前目标。Windows 在任务停止后，把实际的 `current` junction 改名为尚未使用的恢复名称，再把 `$Previous` 改回 `current`；重命名前再次确认绝对路径都在 `$Root` 内。使用保留的服务定义启动，恢复任务原启用状态。

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
