# 安装依赖与故障处理

使用管理员注册页面提供的安装命令。托管安装器会下载并校验专用 Node.js 运行时，无需事先安装 Node 或 npm。该 Worker 的发行通道必须已开放安装；入口不可用时，请参阅[手动安装说明](portable-runner-installation.md)。

## 安装前准备

在受支持的 x64 或 ARM64 主机上，以管理员权限运行命令。为运行时下载、解压文件和 Runner 安装包预留足够空间，并允许访问你的 Worker、nodejs.org 和固定的 GitHub 发行资产。

Linux/macOS 需要可信的标准系统工具、Bash、curl、tar、gzip，以及 `sha256sum`、`shasum`、OpenSSL 中任意一种校验工具，不需要 xz 或 awk。安装器先校验官方 gzip 包的固定 SHA-256，再解压和提取。Windows 需要 Windows PowerShell 5.1 或 PowerShell 7、`Invoke-WebRequest`、`Get-FileHash` 和系统 .NET ZIP 库，不依赖可选的 `Expand-Archive` 模块。

Linux 系统服务安装要求 systemd 可访问；无 systemd 的容器应手动管理进程。macOS 需要 launchctl。缺少工具时，安装器会列出缺失项和包管理器建议，但不会自动执行这些命令。 `--auto-deps` 只启用专用运行时下载，不会安装系统软件包。

官方 Linux 运行时需要兼容的 glibc 系统；存在 `getconf` 时，安装器会在下载前拒绝低于 2.28 的版本，随后还会实际启动运行时进行检查。这些官方包不支持 Alpine/musl 或任意旧系统，请勿替换系统 libc 来强行安装。

POSIX 下隐藏输入注册码需要 `stty` 和终端；已包含注册码的完整命令不需要它们。Windows 的提示输入需要交互式管理员 PowerShell：如果从复制的命令中去掉注册码，也要去掉 `-NonInteractive`。包含注册码的完整命令可能留在命令历史或进程参数中，请按凭据保管。

## 已有安装

只有完整、受管且版本与所选安装器**完全相同**的 Runner 才能原地重新注册。此操作使用已安装运行时，更新凭据和服务配置，并**重启服务**；不会下载或升级安装包，也不需要仅供下载使用的 curl、gzip 或校验工具。操作前先处理完运行中的 Job。版本不同时，请按[升级指南](upgrading.md)操作。

托管安装、重新注册和托管卸载共用操作锁。等待当前操作结束；异常中断后，先确认没有安装进程仍在运行，再处理残留锁。不要同时执行手动安装来绕过锁。

## 处理安装错误

引导诊断包含 `RMI_*` 代码、阶段和处理建议：

| 代码 | 处理方法 |
| --- | --- |
| `RMI_MISSING_TOOLS` / `RMI_CHECKSUM_TOOL` | 安装列出的工具后重试，仍需完成校验 |
| `RMI_SERVICE_MANAGER` | 检查 systemd/launchctl，或采用手动进程管理 |
| `RMI_TEMP_DIRECTORY` / `RMI_DOWNLOAD_WRITE` | 检查临时目录空间和权限 |
| `RMI_TLS_CERTIFICATE` | 检查 CA 证书、系统时间和代理信任配置 |
| `RMI_DOWNLOAD` / `RMI_CURL_VERSION` | 检查网络，或通过系统包管理器更新 curl |
| `RMI_CHECKSUM_MISMATCH` | 停止安装，下载内容与固定摘要不符 |
| `RMI_DECOMPRESS` / `RMI_EXTRACT` / `RMI_ZIP_SUPPORT` | 检查 gzip/tar 或 .NET ZIP 支持、空间和权限 |
| `RMI_RUNTIME_COMPATIBILITY` / `RMI_RUNTIME_VERSION` | 检查系统、架构、运行库、noexec 挂载和固定运行时版本 |
| `RMI_RUNTIME_DISABLED` | 新安装时去掉 `--no-auto-deps` |

`/tmp` 不允许执行时，可通过标准 `TMPDIR` 选择可信、可写且允许执行的位置；安装器仍会创建私有子目录。gzip 包和中间 tar 需要额外空间。请保留 TLS、哈希和签名校验。

下载有时间和大小限制，响应停滞会导致下载失败。注册码发送前失败会说明未尝试注册，修复后可以重试，但注册码仍可能按有效期过期。发送后则可能已经消耗注册码，应先检查 Runner 状态，必要时生成替代码；不要反复提交原码。此阶段不会输出可能包含凭据的子进程日志。

首次安装失败时，清理仅尝试删除本次创建的状态；重新注册失败不会恢复旧凭据。重试前检查服务状态和残留文件。

## 确认安装结果

使用已安装 Runner 的绝对路径执行 `doctor --json`，并在管理员页面检查连接和策略状态。Worker 构建成功或健康接口正常，不等于主机安装成功。更新 Worker 或安装器不会替换已有 Runner 安装包，也不会自动重启它。

运行时要求见 [Node 官方校验和](https://nodejs.org/dist/v22.23.2/SHASUMS256.txt)及[平台要求](https://github.com/nodejs/node/blob/v22.23.2/BUILDING.md)。
