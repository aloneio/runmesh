# 管理界面呈现边界

维护管理页面时，请按本文区分页面呈现、HTTP 安全检查和应用操作的职责。新增页面或动作时，应保留这些边界。

`src/admin/` 负责页面、格式化、表单、表格、品牌素材和脚本封装。`contracts/admin-views.ts` 管理展示 DTO。呈现函数接收明确的数据和 CSRF 值，同步返回 HTML；数据查询和字段选择由调用方在呈现前完成。

`apps/worker/browser/` 负责浏览器行为。`admin-client.js` 入口组装页面、导航和工作流模块；在负责相应行为的模块中修改，再由构建生成 Worker 脚本。

`src/http/html-response.ts` 负责响应头、重定向、Cookie 和应用脚本的 nonce。HTTP 适配器完成认证、CSRF、请求体限制及响应格式选择；应用模块管理生命周期、策略编排和展示字段投影。呈现注册页面前先验证公网地址与执行模式；签发注册码的授权检查放在对应请求入口。

入口负责组装 HTTP 适配器和应用用例。网页与 API 共用 Runner 删除流程，使授权和变更顺序集中在一处维护。

## 兼容性证据

`apps/worker/test/fixtures/admin-render-golden.json` 保存从 `88b119782d26316d68eeaa98a47d71dbe4382193` 提取的十三组旧版呈现结果及源文件 SHA-256。新旧函数使用相同固定时钟。`admin-view-contracts.test.ts` 对照精确 UTF-8 字节数与哈希，同时测试转义和响应安全头。原有认证页面、注册、CSRF 和语言测试继续保留。

`test/admin-navigation.test.mjs` 检查显式 no-store 导航、旧 DOM 清除、页面所有权、控件绑定和语言稳定性。`test/central-browser.test.mjs` 覆盖 MCP 与 Skill 工作流、操作准入和响应收据。

`apps/worker/test/` 中的 `jobs-dashboard.test.ts` 和 `admin-jobs.test.ts` 检查用户触发的历史与日志加载；`ui-locale.test.ts` 检查呈现语言和标签覆盖。移动源码时保留这些覆盖范围。

修改相关模块后，运行对应的 Worker 界面测试和浏览器测试。呈现基准用于检查输出兼容性；浏览器性能和 Cloudflare 用量需单独测量。
