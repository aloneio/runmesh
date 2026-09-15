# main 只接受本仓库 dev 的发布请求

开发修改先进入 `dev`，只有本仓库 `dev -> main` 的 PR/MR 才允许发布晋级。
`fix/*`、`feature/*` 和 fork 中同名的 `dev` 都不是合法来源。
本次增加门禁不代表批准将全部开发代码部署到生产。

## 服务端保护与 CI 分工

禁止直推由仓库服务端执行，不使用推送后才运行的 Action 冒充拦截。
GitHub 保留必须 PR、管理员同样遵守、禁止强推和删除，除 `verify-all` 外
还要求 GitHub Actions 提供唯一的 `main-source-policy` 检查。
GitLab 的 Allowed to push and merge 必须显式为 No one，保留维护者通过
MR 合并，并要求流水线成功、不能用 skipped 流水线放行。

来源检查只读取平台事件元数据，同时校验分支名与仓库/项目身份，不检出
PR 代码、不安装依赖、不访问签名密钥、不执行部署。错误来源必须失败，
不能靠 job 的 `if` 跳过后被平台当作成功。GitHub 还处理修改目标分支事件。

GitLab 项目 CI 配置入口设置为
`.gitlab/main-policy.yml@aloneio/runmesh:dev`：从受保护的开发主线读取门禁，
再包含待测提交自己的普通 CI 配置。这样旧分支即使没有新门禁文件，也不能
仅凭旧测试通过直接进入 main。其他仓库部署时替换设置中的项目路径即可，
不增加运行时配置或秘密。修改 MR 目标后须重新执行当前目标的 MR 流水线。

## 维护与验收

`scripts/main-promotion-policy.mjs` 是检查规则来源，生成后的两端配置由
`npm run check:promotion-policy` 校验，变更规则后显式运行
`node scripts/check-main-policy.mjs --write` 并审阅差异。
正常 `dev` 推送不生成 GitHub 的 main 来源检查，避免把其他场景的成功用于晋级。

新保护上线时分别核对远端设置、合法 dev 来源、非法来源和同名 fork 反例。
测试用草稿 PR/MR 只用于检查，不能合并；main 的代码、正式安装包和生产服务
保持不变。`git push --dry-run` 不等于服务端已经拒绝了一次真实推送。

正式发布要通过两端各自的 `dev -> main` 合并流程，不再直接同步推送 main，
不临时解除保护，不使用强推解决两端合并提交差异。

GitHub 当前使用只读 `pull_request` 工作流，使门禁可从 dev 引入而不擅自升级
生产 main。这不是独立管理的不可篡改组织策略；拥有仓库写入/管理权限并故意
篡改 CI 文件或撤销保护的人仍在信任边界内。门禁代码、可信 CI 入口及保护设置
必须作为安全配置审阅，不能声称管理员永远无法绕过。
