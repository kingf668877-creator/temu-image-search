/**
 * temuParse.js
 * 把 Temu 图搜响应 JSON 抽取成统一字段结构。
 *
 * 字段对账（基于 OZON 版 README 的设计要点 + 当前 CSV 已知字段）：
 *   goods_id / link_url / full_url / thumb_url / title / price / price_old /
 *   sales / score / review_count / category / source
 *
 * Temu 响应路径是推测的（实测后会调整）。本解析器采用**多路径尝试**策略：
 *   - 对每个字段，依次尝试若干常见路径，找到第一个非空的命中。
 *   - 找不到则置为 null，前端按 fallback 显示。
 *   - 解析失败的商品跳过，不影响其他商品。
 */

const pick = (obj, keys) => {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    if (k in obj && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return null;
};
const firstNumber = (v) => {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const m = String(v).replace(/[^0-9.]/g, '');
  if (!m) return null;
  const n = Number(m);
  return Number.isFinite(n) ? n : null;
};
const firstString = (v) => (v == null ? null : String(v));

function extractGoodsList(response) {
  if (!response) return [];
  const candidates = [
    response.goodsList,
    response.data && response.data.goodsList,
    response.data && response.data.items,
    response.data && response.data.list,
    response.result && response.result.goodsList,
    response.items,
    response.data,
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length) return c;
  }
  if (Array.isArray(response)) return response;
  return [];
}

function normalizeItem(raw, sourceHint = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const goodsId =
    pick(raw, ['goodsId', 'goods_id', 'skuId', 'sku_id', 'id', 'itemId', 'productId']) ||
    pick(raw.goods, ['id', 'goodsId', 'skuId']) ||
    null;
  const title =
    pick(raw, ['title', 'goodsTitle', 'goodsName', 'name', 'productName']) ||
    pick(raw.goods, ['title', 'name']) ||
    null;
  const thumb =
    pick(raw, ['thumbUrl', 'thumb_url', 'imageUrl', 'image', 'mainImage', 'pic', 'squarePic', 'cover']) ||
    pick(raw.image, ['url', 'src']) ||
    null;
  const priceRaw =
    pick(raw, ['price', 'currentPrice', 'minPrice', 'salePrice', 'goodsPrice']) ||
    pick(raw.price, ['current', 'min', 'value']) ||
    null;
  const price = priceRaw == null ? null : (typeof priceRaw === 'object' ? firstNumber(priceRaw.value || priceRaw.amount) : firstString(priceRaw));
  const priceOldRaw =
    pick(raw, ['originPrice', 'marketPrice', 'oldPrice', 'originalPrice']) ||
    pick(raw.price, ['origin', 'market']) ||
    null;
  const priceOld = priceOldRaw == null ? null : (typeof priceOldRaw === 'object' ? firstNumber(priceOldRaw.value) : firstString(priceOldRaw));
  const sales = firstNumber(pick(raw, ['sales', 'soldCount', 'saleCount', 'sold', 'volume']));
  const score = firstNumber(pick(raw, ['score', 'rating', 'averageScore']));
  const reviewCount = firstNumber(pick(raw, ['reviewCount', 'reviews', 'comments', 'commentCount']));
  const category =
    pick(raw, ['categoryName', 'category', 'catName', 'catNameEn']) ||
    pick(raw.category, ['name']) ||
    null;
  const fullUrl =
    pick(raw, ['goodsUrl', 'itemUrl', 'url', 'link', 'shareLink']) ||
    (goodsId ? `https://www.temu.com/goods.html?goods_id=${goodsId}` : null);

  return {
    goods_id: goodsId ? String(goodsId) : null,
    title: firstString(title),
    thumb_url: firstString(thumb),
    price: price == null ? null : firstString(price),
    price_old: priceOld == null ? null : firstString(priceOld),
    sales,
    score,
    review_count: reviewCount,
    category: firstString(category),
    link_url: fullUrl ? firstString(fullUrl) : null,
    full_url: fullUrl ? firstString(fullUrl) : null,
    source: sourceHint.source || null,
    _confidence: {
      title: title !== null,
      thumb: thumb !== null,
      price: price != null,
      price_old: priceOld != null,
      sales: sales != null,
      score: score != null,
      review_count: reviewCount != null,
      category: category !== null,
    },
  };
}

function parseSearchResponse(response, meta = {}) {
  if (!response) return { items: [], summary: { ok: false, reason: 'empty_response' } };
  const raw = extractGoodsList(response);
  const items = [];
  for (const r of raw) {
    const n = normalizeItem(r, meta);
    if (n && n.goods_id) items.push(n);
  }
  return {
    items,
    summary: {
      ok: items.length > 0,
      total_raw: raw.length,
      parsed: items.length,
      captured_at: Date.now(),
    },
  };
}

module.exports = {
  parseSearchResponse,
  normalizeItem,
  extractGoodsList,
};