# 安装依赖与故障处理

Worker 发行通道可用时，使用管理员注册页面提供的安装命令。托管安装器自带经过验证的 Node.js 运行时；手动配置见[便携安装流程](portable-runner-installation.md)。

## 安装前准备

在满足下列条件的 x64 或 ARM64 主机上，以管理员权限运行命令。为运行时下载、解压文件和 Runner 安装包预留足够空间，并允许访问你的 Worker、nodejs.org 和 GitHub 发行资产。

Linux/macOS 需要可信的标准系统工具、Bash、curl、tar、gzip，以及 `sha256sum`、`shasum`、OpenSSL 中任意一种校验工具。安装器先校验固定 gzip 包的 SHA-256，再解压提取。Windows 需要 Windows PowerShell 5.1 或 PowerShell 7、`Invoke-WebRequest`、`Get-FileHash` 和系统 .NET ZIP 库。

Linux 系统服务使用 systemd；在容器中，可选择包含 systemd 的镜像，或通过容器的进程管理工具运行 Runner。macOS 使用 launchctl。缺少系统工具时，按报错中的包管理器建议安装；`--auto-deps` 控制安装器专用运行时的下载。

官方 Linux 运行时要求 glibc 2.28 或更新版本。在 Alpine/musl 环境中使用托管安装器时，请为 Runner 选择基于 glibc 的系统或容器镜像。安装器会通过可用的 `getconf` 检查库版本，并确认下载的运行时可以启动。

POSIX 下隐藏输入注册码需要 `stty` 和终端；命令已提供注册码时走非交互路径。Windows 的提示输入需要交互式管理员 PowerShell：如果从复制的命令中去掉注册码，也要去掉 `-NonInteractive`。包含注册码的完整命令可能留在命令历史或进程参数中，请按凭据保管。

## 已有安装

为完整的受管安装重新注册时，选择与当前 Runner 版本一致的安装器。它使用已有运行时，更新凭据和服务配置，并重启服务，安装包保留当前版本。重新注册前先处理完任务。需要更新安装包版本时，按[升级指南](upgrading.zh-CN.md)操作。

每次执行一项安装、重新注册或卸载操作；这些操作共用操作锁。中断后，先检查是否还有维护进程在运行，再清理残留锁或修改安装文件。

## 处理安装错误

引导诊断包含 `RMI_*` 代码、阶段和处理建议：

| 代码 | 处理方法 |
| --- | --- |
| `RMI_MISSING_TOOLS` / `RMI_CHECKSUM_TOOL` | 安装列出的工具，再重新运行安装器和校验步骤 |
| `RMI_SERVICE_MANAGER` | 检查 systemd/launchctl，或采用手动进程管理 |
| `RMI_TEMP_DIRECTORY` / `RMI_DOWNLOAD_WRITE` | 检查临时目录空间和权限 |
| `RMI_TLS_CERTIFICATE` | 检查 CA 证书、系统时间和代理信任配置 |
| `RMI_DOWNLOAD` / `RMI_CURL_VERSION` | 检查网络，或通过系统包管理器更新 curl |
| `RMI_CHECKSUM_MISMATCH` | 停止安装，下载内容与固定摘要不符 |
| `RMI_DECOMPRESS` / `RMI_EXTRACT` / `RMI_ZIP_SUPPORT` | 检查 gzip/tar 或 .NET ZIP 支持、空间和权限 |
| `RMI_RUNTIME_COMPATIBILITY` / `RMI_RUNTIME_VERSION` | 检查系统、架构、运行库、noexec 挂载和固定运行时版本 |
| `RMI_RUNTIME_DISABLED` | 新安装时去掉 `--no-auto-deps` |

`/tmp` 不允许执行时，可通过标准 `TMPDIR` 选择可信、可写且允许执行的位置；安装器仍会创建私有子目录。gzip 包和中间 tar 需要额外空间。请保留 TLS、哈希和签名校验。

下载中断时，按上表对应代码排查。注册前失败时，注册码可在有效期内继续使用。尝试注册后，先检查 Runner 状态；原注册码已使用时，再生成新的注册码。

首次安装失败后，先查看清理结果、服务状态和残留文件，再重试。重新注册中断时，先核对本地配置与控制台，因为凭据可能已经完成替换。

## 确认安装结果

使用已安装 Runner 的绝对路径执行 `doctor --json`，在管理员页面确认连接与策略状态，再从实际 MCP 客户端列出工作区并读取无害文件。后续安装包更新按[升级指南](upgrading.zh-CN.md)安排。

运行时要求见 [Node 官方校验和](https://nodejs.org/dist/v22.23.2/SHASUMS256.txt)及[平台要求](https://github.com/nodejs/node/blob/v22.23.2/BUILDING.md)。
