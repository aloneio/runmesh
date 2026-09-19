# main 发布晋级规则

开发修改先进入 `dev`。经过明确批准后，通过**本仓库的 `dev -> main` PR/MR**
晋级生产版本。来源检查同时核对仓库身份和分支名称。

## 配置提供商保护

GitHub 要求通过 PR 合并，管理员同样遵守。必需检查包括 `verify-all` 和
GitHub Actions 提供的唯一 `main-source-policy`；关闭强推和分支删除权限，
保留讨论解决及现有验证要求。

GitLab 将 **Allowed to push and merge** 设置为 **No one**，保留维护者通过
MR 合并的角色权限，并要求成功且非 skipped 的流水线。服务端分支保护负责
限制引用变更，来源检查负责验证 PR/MR 是否来自获准分支。

来源检查读取平台事件元数据。GitHub 覆盖创建、重新打开、同步提交、修改目标
和转为待评审等事件；错误来源返回失败，缺少必需检查会阻止合并。
`main-source-policy` 名称只用于该工作流，因为检查结果属于提交 SHA，
普通 `dev` CI 应使用自己的检查名称。

## 配置 GitLab 可信入口

将项目的 **CI/CD configuration file** 设为：

```text
.gitlab/main-policy.yml@aloneio/runmesh:dev
```

入口从经过审阅的 `dev` 读取，再包含实际流水线提交的 `.gitlab-ci.yml`，
最后应用必需的元数据 `.pre` 任务和流水线创建规则。早于门禁的旧分支也使用
同一策略。分叉仓库应在该管理设置中替换为自己的项目路径。

将可信入口的修改作为安全配置审阅，并保留平台预定义的 CI 来源变量。
修改 MR 目标后，先针对当前目标运行新的 MR 流水线，再合并。

## 维护与验收

`scripts/main-promotion-policy.mjs` 定义来源判定。生成器将同一组独立函数嵌入
GitHub 和 GitLab 任务。修改规则后，生成配置、审阅差异并执行检查：

```sh
node scripts/check-main-policy.mjs --write
npm run check:promotion-policy
node --test test/main-promotion-policy.test.mjs
```

两端 CI 使用 `check:promotion-policy` 验证生成文件；新测试登记到验证清单。

通过提供商 API 核对实际分支保护，再用草稿 PR/MR 验证合法 dev、非法来源及
同名 fork 分支。检查完成后关闭这些草稿。引用更新保护使用一次性的受保护
测试分支验证；`git push --dry-run` 不会执行远端 pre-receive 检查。

## 晋级正式版本

获准晋级后创建 `dev -> main`，等待来源策略与所有必需检查通过，再通过
提供商 PR/MR 接口或界面合并。GitLab 镜像晋级使用对应的 `dev -> main` MR。
处理两端合并策略与提交身份差异时，持续保留禁止强推和直推的保护。

正式发行从受保护的 `main` 进入发布检查。分别核对两端最终提交和实际部署的 Worker。

GitHub 当前采用只读 `pull_request` 工作流，其信任范围包含能够修改工作流
或仓库规则的维护者。这些修改应作为安全配置审阅；需要独立执行权限的组织
可采用由另一管理边界维护的必需工作流。
