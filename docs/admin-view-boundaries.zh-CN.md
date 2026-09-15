# 管理界面呈现边界（AR04）

本开发改动将既有页面呈现代码从 Worker 入口提取出来，不引入前端框架、新路由、存储层或后台轮询。

`src/admin/` 负责页面、格式化、表单、表格、品牌素材和脚本封装。浏览器实现独立维护在 `apps/worker/browser/admin-client.js`，生成模块不手工修改；展示 DTO 属于 `contracts/admin-views.ts`，不依赖 Registry 记录。呈现函数同步接收调用方提供的数据与 CSRF 值，返回 HTML；不查询 Registry，也不接收 Worker 环境绑定。客户端详情函数移除了原先未使用的环境参数和无必要的 Promise。

`src/http/html-response.ts` 保留既有响应头、重定向、Cookie 和应用自有脚本的 nonce 处理，不授予权限。HTTP 适配器负责认证、CSRF、请求体限制与响应；应用模块管理生命周期／策略编排及显示字段投影。注册页面只接受已经验证的公网地址与执行模式，调用呈现函数不等于获得签发注册码的权限。

后续模块化整改已将 HTTP 适配器、应用用例移出入口，Runner 删除由网页与 API 共用单一流程；Registry 持久化和最终 RPC 授权不变。

## 兼容性证据

`test/fixtures/admin-render-golden.json` 保存从 `88b119782d26316d68eeaa98a47d71dbe4382193` 提取的十三组旧版呈现结果及源文件 SHA-256。新旧函数使用相同固定时钟。`admin-view-contracts.test.ts` 对照精确 UTF-8 字节数与哈希，同时测试转义和响应安全头。原有认证页面、注册、CSRF 和语言测试继续保留。

`test/admin-navigation.test.mjs` 改为读取迁移后的浏览器实现，仍检查显式 no-store 导航、没有后台 Jobs／日志请求、旧 DOM 清除和语言稳定性。移动源码不能缩小语言回归检查的标签范围。

本次移动不意味着响应变化、增加 Registry 调用、定时器或生产部署。源码／测试事实不替代浏览器性能或 Cloudflare 计费测量。
