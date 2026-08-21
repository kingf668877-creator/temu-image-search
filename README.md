# Temu 批量图搜工作台

保留原 GitHub Pages 页面视觉，增加本机批量上传、串行 VMOS 图搜、Frida 商品模型导出、失败重试和 JSON/CSV 导出。

## 本机启动

1. 安装依赖：`npm install`
2. 复制 `.env.example` 为 `.env`，填写本机 `ADB_BIN`
3. 确认 ADB 转发 `127.0.0.1:61750` 和 Frida 转发 `127.0.0.1:27042` 可用
4. 确认 Temu 主进程与 `/data/local/tmp/fsrv` 正在运行
5. 启动真实服务：`npm start`
6. 本机调试打开 `http://127.0.0.1:15443/`；线上打开 `https://yidong.dianleida.net:21998/`

Mock 模式使用 `npm run start:mock`。服务默认监听 `0.0.0.0:15443`，可通过 `HOST` 和 `PORT` 环境变量覆盖；端口被占用时会退出，不会终止其他服务。

## 数据边界

商品仅来自 Temu 图搜结果页内存模型 `Um.g.d`。执行器不会进入商品详情页，不使用首页列表、文字搜索或可见卡片补采。

每张源图独立保存状态和商品结果。队列严格串行，单项失败不会阻塞后续项，失败项可以单独重试。运行数据保存在 `runtime`，并被 Git 忽略。

## 测试

运行 `npm test`。测试覆盖串行队列、失败隔离、单项重试、服务重启恢复、文件上传、20 商品分组和 CSV 导出。

## GitHub Pages

线上入口：`https://yidong.dianleida.net:21998/`。健康检查：`https://yidong.dianleida.net:21998/api/health`。前端默认请求该 HTTPS 后端，也可通过 `window.TEMU_BACKEND` 覆盖；运维反向代理应将公网端口转发到服务的 `15443` 端口。
