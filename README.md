# Temu 图搜批量寻源

借助 VMOS 云手机 + Temu Android App 的常驻登录会话，实现"网页端批量上传图片 → 自动化图搜 → 拿到真实接口数据"的批量寻源流程。

- **三种批量方式**：图片批量上传、链接批量上传、表格批量上传（解析 CSV/Excel 中的图片链接列）
- **常驻云端 Temu App 会话**：VMOS 内 Android 13 设备，已通过原生 TLS 明文拦截 + HTTP/2 重组 + gzip 解压管线
- **响应字段**：商品 ID、链接、主图、价格、评分、评分数、销量、标题
- **结果展示与导出**：JSON / CSV / 表格导出
- **串行调度**：单设备单会话，避免 Temu App 状态互相干扰

## 快速开始

```bash
# 启动后端（端口 5443，云端会话通过 VMOS 隧道转发）
node server.js

# 浏览器打开
open http://localhost:5443/
```

### 准备工作

1. 启动 VMOS Cloud，云手机 V06 内登录 Temu App 并保持常驻。
2. 在 VMOS 控制台"本地调试"获取 SSH 隧道命令，保持 61117 端口监听。
3. 后端会通过隧道把云手机内 Temu App 的图搜响应离线解析为商品数据。

### 目录结构

| 路径 | 作用 |
|------|------|
| `server.js` | Express 服务，调度与任务管理 |
| `src/temuSession.js` | Temu App 会话与 VMOS 桥接 |
| `src/temuCapture.js` | TLS 明文分片 → HTTP/2 → gzip 响应解析 |
| `src/temuParse.js` | 业务字段提取（goods_id / title / price …） |
| `src/taskQueue.js` | 任务队列与状态机 |
| `index.html` / `css/style.css` / `js/app.js` | 前端 UI |
| `results/` | 历史结果归档 |

## 健康检查

```bash
curl http://localhost:5443/api/health
curl http://localhost:5443/api/session
```

`/api/session` 返回 `{ ok: true, device: "V06", tunnel: "127.0.0.1:61117" }` 表示会话在线。

## 工作流

1. 用户在网页里上传图片 / 粘贴图片 URL / 上传含图片链接列的 CSV（三种入口：批量上传、URL 批量、表格批量）。
2. 前端 POST 到 `/api/upload/:taskId` 或 `/api/upload_urls`，后端把图片写入云手机 `/sdcard/` 路径并入队。
3. 任务调度器从队列取一条任务，下发到 VMOS 云手机的 Temu App 会话执行端。
4. Temu App 在云端触发图搜，TLS 明文分片经隧道回到本地。
5. `temuCapture.js` 把响应按 HTTP/2 重组 + gzip 解压，按字段抽出商品卡。
6. 前端轮询 `/api/status/:taskId`，完成后展示结果卡并支持导出 JSON / CSV。

## 设计要点

- **TLS 明文拦截**：通过设备侧 Frida hook 或 VMOS 端 SDK 回调拿到 `SSL_read` 明文分片，落到 `temu_search_*.bin`。
- **HTTP/2 帧重组**：9-byte 帧头解析 + 按 stream 合并 DATA + gzip 解压；只关心业务流 stream 5。
- **字段映射**：`identifier` → `goods_id`、`extend_fields.text.text` → `title`、`goods_price` → `price`、`sales / sold_count` → `sold`、`score` → `rating`、`review_count` → `reviews`。
- **串行调度**：单设备单会话，避免 Temu App 内多个图搜请求互相污染或触发风控。
- **会话丢失**：SSH 隧道断或 V06 离线时返回 `{ ok: false, code: 'session_lost' }`，前端可提示重新连接隧道。
- **响应结构自适应**：每个字段缺失或类型变化都会标记 `unknown`，前端按 fallback 显示；解析失败时任务不丢，按状态 `failed_parsing` 入库。

## 安全说明

- 本仓库不包含任何 GitHub Token / Cookie / VMOS 连接密钥。
- 上传的图片存在 `uploads/<taskId>/` 并已被 `.gitignore` 忽略。
- 所有 Temu 数据只用于内部比对，不上传第三方服务。

## 已知限制

1. **必须 VMOS Cloud 在线**：依赖 VMOS 提供的 SSH 隧道与云端 Temu App 会话。
2. **响应字段以图搜为准**：图搜接口本身只返回基础字段；价格 / 评分 / 销量等如果图搜响应不含，仍需进一步调用商品详情接口。
3. **图搜接口可能变动**：每次 Temu 升级都可能影响响应结构；系统做了结构自适应与字段缺失告警。
5. **批量并发数**：第一期 1 台 VMOS 串行调度，建议单批 ≤ 200 张，避免云手机内存吃紧。

## License

Internal project.