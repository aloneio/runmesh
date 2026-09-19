# 安装依赖与故障处理

Worker 发行通道可用时，使用管理员注册页面提供的安装命令。托管安装器自带经过验证的 Node.js 运行时；手动配置见[便携安装流程](portable-runner-installation.md)。

## 安装前准备

在受支持的 x64 或 ARM64 主机上，以管理员权限运行命令。为运行时下载、解压文件和 Runner 安装包预留足够空间，并允许访问你的 Worker、nodejs.org 和固定的 GitHub 发行资产。

Linux/macOS 需要可信的标准系统工具、Bash、curl、tar、gzip，以及 `sha256sum`、`shasum`、OpenSSL 中任意一种校验工具。安装器先校验固定 gzip 包的 SHA-256，再解压提取。Windows 需要 Windows PowerShell 5.1 或 PowerShell 7、`Invoke-WebRequest`、`Get-FileHash` 和系统 .NET ZIP 库。

Linux 系统服务安装要求 systemd 可访问；无 systemd 的容器应手动管理进程。macOS 需要 launchctl。缺少系统工具时，按报错中的包管理器建议安装；`--auto-deps` 控制安装器专用运行时的下载。

官方运行时使用兼容 glibc 的 Linux 主机，Alpine/musl 需要另选受支持的部署方案。存在 `getconf` 时，安装器要求 glibc 至少为 2.28，再检查运行时能否实际启动。主机不兼容时，请改用兼容的系统或容器镜像。

POSIX 下隐藏输入注册码需要 `stty` 和终端；命令已提供注册码时走非交互路径。Windows 的提示输入需要交互式管理员 PowerShell：如果从复制的命令中去掉注册码，也要去掉 `-NonInteractive`。包含注册码的完整命令可能留在命令历史或进程参数中，请按凭据保管。

## 已有安装

只有完整、受管且版本与所选安装器**完全相同**的 Runner 才能原地重新注册。此操作使用已安装运行时，更新凭据和服务配置，并**重启服务**；安装包保持当前版本，这条路径也省去了仅供下载使用的工具。操作前先处理完 Job。版本不同时，请按[升级指南](upgrading.zh-CN.md)操作。

托管安装、重新注册和托管卸载共用操作锁。等待当前操作结束；异常中断后先检查运行进程，再处理残留锁，手动文件修改也应避开这个维护窗口。

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

下载有时间和大小限制，响应停滞时按上表对应代码排查。注册前失败的代码可在有效期内继续使用；尝试注册后，先检查 Runner 状态，必要时生成替代码，因为原码可能已经消耗。此阶段会省略可能包含凭据的子进程输出。

首次安装失败后，清理会尝试删除本次创建的状态。重试前检查服务和残留文件；凭据刷新失败也可能已经替换旧凭据，应先核对配置与控制台，再恢复连接。

## 确认安装结果

使用已安装 Runner 的绝对路径执行 `doctor --json`，在管理员页面确认连接与策略状态，再从实际 MCP 客户端列出工作区并读取无害文件。后续安装包更新按[升级指南](upgrading.zh-CN.md)安排。

运行时要求见 [Node 官方校验和](https://nodejs.org/dist/v22.23.2/SHASUMS256.txt)及[平台要求](https://github.com/nodejs/node/blob/v22.23.2/BUILDING.md)。
