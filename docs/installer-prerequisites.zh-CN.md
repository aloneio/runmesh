# 安装依赖与报错

Linux/macOS 改用同版本官方 gzip 包，不再要求 xz 或 tar 的 -J 选项。仍先核对固定 SHA256，再分别解压和提取。Windows 改用系统 .NET ZIP 库，不依赖 Expand-Archive 模块。本次是 Worker 安装脚本修复，不覆盖不可变 Runner v0.1.3 安装包，也不会重启已安装服务。

新安装仍需要标准系统工具、Bash、curl、tar、gzip，以及 sha256sum、shasum、OpenSSL 中任意一种。shasum 分支不再依赖 awk。只有隐藏输入注册码时需要 stty 和终端；完整私密安装命令不需要它们。缺失项会集中显示并给出包管理器建议，但脚本不会自动执行 apt/dnf 等系统安装命令。

Linux 系统服务安装先检查 systemd 是否可访问；无 systemd 的容器应使用手动进程管理路线。macOS 检查 launchctl。官方 Linux 运行时要求兼容 glibc，本次不代表支持 Alpine/musl 或任意旧系统。

报错包含 RMI_* 代码、阶段和处理建议：RMI_MISSING_TOOLS 是缺失工具，RMI_CHECKSUM_TOOL 是缺少校验工具，RMI_SERVICE_MANAGER 是服务管理器不可用，RMI_TLS_CERTIFICATE 是证书或时间等信任问题，RMI_DOWNLOAD 是下载失败，RMI_CHECKSUM_MISMATCH 是内容不匹配，RMI_DECOMPRESS/RMI_EXTRACT 区分解压与提取失败，RMI_RUNTIME_COMPATIBILITY 则指运行库、架构或 noexec 问题。

/tmp 不允许执行时，可通过标准 TMPDIR 选择受信任、可写且允许执行的临时位置；脚本仍会建立私有子目录。gzip 包和中间 tar 需要足够空间。不要关闭 TLS、跳过哈希、放宽目录权限或替换系统 libc 来绕过错误。

注册码发送前失败会说明未进行注册，修复后可再试，但代码仍可能正常过期。发送后则提示可能已消耗，必须核对凭据，不能自动反复注册。此阶段不打印可能带注册码的日志或 PowerShell 源码位置。

隔离测试覆盖无 xz/awk/系统 Node、缺少依赖、损坏包、错误哈希、证书失败、写入失败和运行时无法启动。oci0 还完成真实 ARM64 官方 gzip 包的校验、解压和启动测试，没有注册或修改服务。Windows 的实际 .NET 提取测试由原生 Windows CI 执行。

代码合并后仍必须核实 CF 实际部署及公开脚本，不能把 CI 或推送成功当作安装器已经更新。完整技术边界见英文安装依赖文档。
