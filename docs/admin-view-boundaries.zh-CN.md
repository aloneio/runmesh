# 管理界面呈现边界

维护管理页面时，请按本文区分页面呈现、HTTP 安全检查和应用操作的职责。新增页面或动作时，应保留这些边界。

`src/admin/` 负责页面、格式化、表单、表格、品牌素材和脚本封装。在 `apps/worker/browser/admin-client.js` 中修改浏览器行为，由构建生成对应的 Worker 模块。`contracts/admin-views.ts` 管理展示 DTO。呈现函数接收明确的数据和 CSRF 值，同步返回 HTML；数据查询和字段选择由调用方在呈现前完成。

`src/http/html-response.ts` 负责响应头、重定向、Cookie 和应用脚本的 nonce。HTTP 适配器完成认证、CSRF、请求体限制及响应格式选择；应用模块管理生命周期、策略编排和展示字段投影。呈现注册页面前先验证公网地址与执行模式；签发注册码的授权检查放在对应请求入口。

入口负责组装 HTTP 适配器和应用用例。网页与 API 共用 Runner 删除流程，使授权和变更顺序集中在一处维护。

## 兼容性证据

`test/fixtures/admin-render-golden.json` 保存从 `88b119782d26316d68eeaa98a47d71dbe4382193` 提取的十三组旧版呈现结果及源文件 SHA-256。新旧函数使用相同固定时钟。`admin-view-contracts.test.ts` 对照精确 UTF-8 字节数与哈希，同时测试转义和响应安全头。原有认证页面、注册、CSRF 和语言测试继续保留。

`test/admin-navigation.test.mjs` 检查显式 no-store 导航、用户触发的 Jobs／日志加载、旧 DOM 清除和语言稳定性。移动源码时保留语言回归的标签覆盖范围。

修改相关模块后，运行对应的 Worker 界面测试和浏览器测试。呈现基准用于检查输出兼容性；浏览器性能和 Cloudflare 用量需单独测量。
