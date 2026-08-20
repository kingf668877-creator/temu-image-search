function parseTracking(raw) {
  const value = raw && raw.p_search;
  if (!value) return {};
  try {
    if (typeof value === 'string') return JSON.parse(value);
    if (typeof value._json === 'string') return JSON.parse(value._json);
    return value;
  } catch {
    return {};
  }
}

function asNumber(value, divisor = 1) {
  const number = Number(value);
  return Number.isFinite(number) ? number / divisor : null;
}

function absoluteTemuUrl(value, goodsId) {
  if (value && /^https?:\/\//i.test(value)) return value;
  if (value) return `https://www.temu.com/${String(value).replace(/^\//, '')}`;
  return goodsId ? `https://www.temu.com/goods.html?goods_id=${goodsId}` : null;
}

function normalizeProduct(raw, position) {
  const tracking = parseTracking(raw);
  const price = raw.price_info || {};
  const tags = raw.tags_info || {};
  const goodsId = String(raw.goods_id || tracking.g || '');
  const sales = asNumber(raw.sales_num);
  const marketPrice = asNumber(price.market_price, 100);
  const goodsTags = [
    ...(Array.isArray(tags.goods_tags) ? tags.goods_tags : []),
    ...(Array.isArray(tags.ad_tags) ? tags.ad_tags : []),
  ].map((tag) => tag && tag.text).filter(Boolean);

  return {
    goodsId,
    skuId: raw.current_sku_id ? String(raw.current_sku_id) : null,
    mallId: raw.mall_id ? String(raw.mall_id) : null,
    title: raw.title || null,
    imageUrl: (raw.image && raw.image.url) || raw.thumb_url || null,
    price: asNumber(price.price, 100),
    priceText: price.price_str || null,
    currency: price.currency || tracking.show_currency || null,
    marketPrice: marketPrice || null,
    marketPriceText: price.market_price_str || null,
    discountText: raw.benefit_text && raw.benefit_text.text || null,
    sales,
    salesText: raw.sales_tip || (sales === null ? null : `${sales} sold`),
    productUrl: absoluteTemuUrl(raw.link_url, goodsId),
    isAd: Boolean(tracking.ad || tracking.ad_goods || goodsTags.includes('AD')),
    tags: [...new Set(goodsTags)],
    position: Number.isFinite(Number(tracking.idx)) ? Number(tracking.idx) : position,
    searchId: tracking.search_id || null,
    scene: tracking.scene || null,
    imageSearchVerified: tracking.scene === 'image_search_result',
  };
}

module.exports = { normalizeProduct, parseTracking };
