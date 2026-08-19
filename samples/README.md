# Temu 图搜响应样本

> 真实抓包的 Temu 图搜 API 响应 JSON 落盘区。**仅供字段抽取规则调试用**，不包含任何 Cookie / Token / 用户凭证。

文件命名：

- `search_response_<timestamp>.json` —— 一次图搜响应
- `search_request_<timestamp>.txt` —— 对应请求头（不含 Cookie）

## 如何抓样本

1. 本地 Chrome 启动 `--remote-debugging-port=9225`。
2. 打开 https://www.temu.com 并登录。
3. 在 DevTools Network 面板 filter `image` / `searchByImage` / `poppy`。
4. 触发一次图搜。
5. 右键请求 → Copy → Copy response，把 JSON 粘到这里。
6. 文件名用当天日期时间，便于回溯。