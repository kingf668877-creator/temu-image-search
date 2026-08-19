# Temu 图搜批量寻源

借助本地 Chrome 接管 + CDP 协议，**复用本机已登录 temu.com 的会话**完成"上传图片 → 自动化图搜 → 拿到真实接口数据"的批量寻源流程。

- **三种批量入口**（首版仅链接 + 图片）：图片批量上传 / 链接批量上传 / 表格批量上传（后续版本加入）
- **零凭证**：所有调用都在用户自己的 temu.com 会话里执行，不存 Cookie / Token
- **字段丰富**：商品 ID、链接、主图、标题、价格、销量、评分、评分数、类目
- **结果导出**：JSON / CSV
- **串行调度**：单设备单会话，避免 Temu 风控

## 快速开始

```bash
# 1) 安装依赖
npm install

# 2) 启动 Chrome（端口 9225），有窗口版用于登录
powershell -ExecutionPolicy Bypass -File scripts/start-temu-visible.ps1

# 在打开的 Chrome 里完成登录，然后切换到无窗口
powershell -ExecutionPolicy Bypass -File scripts/start-temu-headless.ps1

# 3) 启动后端
node server.js

# 4) 浏览器打开
open http://localhost:5443/
# 或 GitHub Pages 静态页：
open https://kingf668877-creator.github.io/temu-image-search/
```

环境变量：

- `PORT`（默认 5443）：后端服务端口
- `TEMU_CDP_PORT`（默认 9225）：Chrome 远程调试端口
- `TEMU_HTTP_CONCURRENCY`（默认 1）：Temu 风控严格，串行稳
- `TEMU_CHROME_PATH`（默认 `C:\Program Files\Google\Chrome\Application\chrome.exe`）：浏览器路径
- `TEMU_PROFILE_DIR`（默认 `%LOCALAPPDATA%\TemuImageSearchChrome`）：浏览器 user-data-dir
- `TEMU_SEARCH_PATH`（默认 `/api/oak/v1/marketing/searchByImage`）：Temu 图搜 API 端点（**待实测校准**）

## 健康检查

```bash
curl http://localhost:5443/api/health
curl http://localhost:5443/api/session
```

`/api/session` 返回 `{ ok: true, tab: { url: ..., title: ... } }` 表示会话在线。

## 目录结构

| 路径 | | 作用 |
|------|---|------|
| `server.js` | | Express 服务 |
| `src/temuSession.js` | | 通过 CDP 9225 发现 temu.com 标签页 |
| `src/temuHttp.js` | | 浏览器内并发 fetch（CDP `Runtime.evaluate`）|
| `src/temuParse.js` | | Temu 响应字段抽取（多路径尝试 + 自适应） |
| `src/taskQueue.js` | | 任务队列与状态机 |
| `index.html` / `css/style.css` / `js/app.js` | | 前端 UI |
| `scripts/` | | Chrome 启动 / 守护脚本 |
| `samples/` | | 真实响应 JSON 落盘 |
| `docs/superpowers/specs/` | | 设计 spec |

## 工作流

1. 用户在网页里上传图片 / 粘贴图片 URL / 提交 CSV。
2. 前端 POST 到 `/api/upload/:taskId` 或 `/api/upload_urls`，后端把图片写入 `uploads/<taskId>/`，分片累积 URL。
3. 任务调度器从队列取一条任务，通过 CDP 接管已登录的 `temu.com` 标签页。
4. 后端在浏览器内执行 `Runtime.evaluate`：构造 Blob → POST Temu 图搜 API → 拿响应。
5. `temuParse.js` 按多路径策略抽取字段（标题 / 主图 / 价格 / 销量 / 评分 / 评分数 / 类目 / 链接）。
6. 前端轮询 `/api/status/:taskId`，完成后展示结果卡，支持导出 JSON / CSV。

## 字段对账（结论）

> 下面字段路径**是预测**——需要一次实测抓包确认准确路径。`temuParse.js` 已经实现"多路径尝试 + 自适应"，**任意字段缺失时显示为"待校准"**，不阻塞其它字段。

| 字段 | CSV 已有 | 推测在 Temu 响应里的路径 | 备注 |
|---|---|---|---|
| `goods_id` | ✅ | `goodsId` / `skuId` | 已知 20 条 |
| `link_url` | ✅ | `shareLink` / 模板拼接 | 已知前缀 `goods.html?_bg_fs=1` |
| `full_url` | ✅ | `https://www.temu.com/goods.html?goods_id=...` | |
| `thumb_url` | ❌ 缺 | `imageUrl` / `thumbUrl` / `mainImage` | 实测校准 |
| `title` | ❌ 缺 | `title` / `goodsTitle` / `goodsName` | 实测校准 |
| `price` | ❌ 缺 | `price` / `currentPrice` / `minPrice` | |
| `price_old` | ❌ 缺 | `originPrice` / `marketPrice` | |
| `sales` | ❌ 缺 | `sales` / `soldCount` / `volume` | |
| `score` | ❌ 缺 | `score` / `rating` | |
| `review_count` | ❌ 缺 | `reviewCount` / `comments` | |
| `category` | ❌ 缺 | `categoryName` / `catName` | |

## 安全 / 限制

- 本仓库不包含任何 GitHub Token / Cookie。
- 上传图片存在 `uploads/<taskId>/` 并已被 `.gitignore` 忽略。
- 所有 Temu 数据只用于内部比对，不上传第三方服务。

## 已知限制

1. **必须本机 Chrome 已登录 temu.com** ——CDP 接管的是本地 Chrome，云端跑不通。
2. **首版仅支持"链接批量 + 图片批量"** ——表格批量后续版本加入。
3. **Temu 真实图搜 API 路径待实测** ——默认 `/api/oak/v1/marketing/searchByImage`，用 `TEMU_SEARCH_PATH` 覆盖。
4. **风控**：单设备单会话串行调度，建议单批 ≤ 200 张。
5. **滑块 / CAPTCHA**：Temu 偶尔弹验证，需在浏览器里手动通过一次后 Cookie 才能继续使用。

## License

Internal project.