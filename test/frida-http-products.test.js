const test = require('node:test');
const assert = require('node:assert/strict');

const {
  findProductArray,
  productsFromResponses,
} = require('../src/frida-export-daemon');

function product(id) {
  return {
    goods_id: id,
    title: `product-${id}`,
    price_info: { price: '199', price_str: '$1.99' },
  };
}

test('findProductArray 识别 data.goods_list 中的商品数组', () => {
  const products = [product('g1'), product('g2'), product('g3')];
  assert.deepEqual(findProductArray({ data: { goods_list: products } }), products);
});

test('findProductArray 识别 result.items 中的 goodsId 商品数组', () => {
  const products = [
    { goodsId: 'g1', title: 'one' },
    { goodsIdStr: 'g2', title: 'two' },
    { id: 'g3', title: 'three' },
  ];
  assert.deepEqual(findProductArray({ result: { items: products } }), products);
});

test('findProductArray 不把少量普通对象数组误判为商品', () => {
  const value = {
    data: {
      items: [
        { id: 'one', name: 'category' },
        { id: 'two', name: 'filter' },
      ],
    },
  };
  assert.equal(findProductArray(value), null);
});

test('productsFromResponses 返回第一个包含有效商品数组的响应', () => {
  const products = [product('g1'), product('g2'), product('g3')];
  const captured = productsFromResponses([
    { url: 'https://api.example.invalid/noise', capturedAt: 1, body: '{"ok":true}' },
    {
      url: 'https://api.example.invalid/image-search',
      capturedAt: 2,
      body: JSON.stringify({ data: { goodsList: products } }),
    },
  ]);

  assert.equal(captured.responseUrl, 'https://api.example.invalid/image-search');
  assert.equal(captured.capturedAt, 2);
  assert.deepEqual(captured.products, products);
});

test('productsFromResponses 忽略无效 JSON 和无商品响应', () => {
  assert.equal(productsFromResponses([
    { url: 'bad', capturedAt: 1, body: '{bad json' },
    { url: 'empty', capturedAt: 2, body: JSON.stringify({ data: { items: [] } }) },
  ]), null);
});
