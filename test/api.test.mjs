import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourceData = path.join(__dirname, '..', 'data', 'db.json');

async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xingye-store-'));
  const dataFile = path.join(directory, 'db.json');
  await fs.copyFile(sourceData, dataFile);
  const { server, store } = await createApp({ dataFile });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { base, store };
}

async function json(response) {
  const payload = await response.json();
  return { response, payload };
}

test('商品目录、筛选和详情接口返回一致数据', async (t) => {
  const { base } = await setup(t);
  const health = await json(await fetch(`${base}/api/health`));
  assert.equal(health.response.status, 200);
  assert.equal(health.payload.ok, true);

  const catalog = await json(await fetch(`${base}/api/products?category=cleaning&sort=price-asc&pageSize=20`));
  assert.equal(catalog.response.status, 200);
  assert.equal(catalog.payload.products.length, 2);
  assert.ok(catalog.payload.products.every((product) => product.category === 'cleaning'));
  assert.ok(catalog.payload.products[0].minPrice <= catalog.payload.products[1].minPrice);

  const detail = await json(await fetch(`${base}/api/products/r1-pro`));
  assert.equal(detail.response.status, 200);
  assert.equal(detail.payload.variants.length, 3);
  assert.equal(detail.payload.variants[0].sku, 'XY-R1-STD');
  assert.ok(detail.payload.stock > 0);
});

test('下单会服务端计价、校验手机号、扣减库存并支持物流查询', async (t) => {
  const { base } = await setup(t);
  const before = await json(await fetch(`${base}/api/products/r1-pro`));
  const stockBefore = before.payload.variants.find((variant) => variant.id === 'r1-standard').stock;

  const invalidPayload = {
    customer: { name: '测试用户', phone: '123', email: '' },
    address: { province: '浙江省', city: '杭州市', district: '西湖区', detail: '文三路 100 号', postalCode: '310000' },
    items: [{ productId: 'r1-pro', variantId: 'r1-standard', qty: 1 }],
    paymentMethod: 'wechat'
  };
  const invalid = await json(await fetch(`${base}/api/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(invalidPayload) }));
  assert.equal(invalid.response.status, 400);
  assert.match(invalid.payload.error, /手机号/);

  const afterInvalid = await json(await fetch(`${base}/api/products/r1-pro`));
  assert.equal(afterInvalid.payload.variants.find((variant) => variant.id === 'r1-standard').stock, stockBefore);

  const payload = {
    ...invalidPayload,
    customer: { name: '测试用户', phone: '13800138000', email: 'test@example.com' },
    couponCode: 'STAR50',
    invoice: { needed: true, type: 'company', title: '测试科技公司', taxNo: '91330000TEST000001' },
    customerNote: '工作日送达'
  };
  const created = await json(await fetch(`${base}/api/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }));
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  assert.equal(created.payload.subtotal, 1899);
  assert.equal(created.payload.discount, 50);
  assert.equal(created.payload.shipping, 0);
  assert.equal(created.payload.total, 1849);
  assert.equal(created.payload.status, 'paid');
  assert.match(created.payload.orderNo, /^XY\d{12}$/);

  const after = await json(await fetch(`${base}/api/products/r1-pro`));
  const stockAfter = after.payload.variants.find((variant) => variant.id === 'r1-standard').stock;
  assert.equal(stockAfter, stockBefore - 1);

  const wrongPhone = await json(await fetch(`${base}/api/orders/track?orderNo=${created.payload.orderNo}&phone=13900139000`));
  assert.equal(wrongPhone.response.status, 400);

  const tracked = await json(await fetch(`${base}/api/orders/track?orderNo=${created.payload.orderNo}&phone=13800138000`));
  assert.equal(tracked.response.status, 200);
  assert.equal(tracked.payload.orderNo, created.payload.orderNo);
  assert.equal(tracked.payload.customer.phone, '138****8000');
  assert.equal(tracked.payload.statusHistory.at(-1).status, 'paid');
});

test('虚拟客服能保留会话、推荐商品并识别订单号', async (t) => {
  const { base, store } = await setup(t);
  const first = await json(await fetch(`${base}/api/support/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: '', message: '小户型养猫，推荐哪款扫地机器人？' })
  }));
  assert.equal(first.response.status, 200);
  assert.match(first.payload.sessionId, /^[a-f0-9]{32}$/);
  assert.ok(first.payload.productIds.length >= 1);
  assert.match(first.payload.text, /推荐|扫地|机器人/);

  const order = await json(await fetch(`${base}/api/support/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: first.payload.sessionId, message: '订单 XY202609280001 到哪里了？' })
  }));
  assert.equal(order.response.status, 200);
  assert.match(order.payload.text, /运输中|顺丰/);

  const threads = await store.listSupportThreads();
  const thread = threads.find((item) => item.sessionId === first.payload.sessionId);
  assert.ok(thread);
  assert.equal(thread.messages.filter((message) => message.sender === 'user').length, 2);
  assert.ok(thread.messages.some((message) => message.sender === 'bot'));
});

test('后台登录、商品维护、订单流转和设置更新可用', async (t) => {
  const { base } = await setup(t);

  const unauthorized = await fetch(`${base}/api/admin/dashboard`);
  assert.equal(unauthorized.status, 401);

  const wrong = await json(await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'wrong-password' })
  }));
  assert.equal(wrong.response.status, 401);

  const login = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const dashboard = await json(await fetch(`${base}/api/admin/dashboard`, { headers: { cookie } }));
  assert.equal(dashboard.response.status, 200);
  assert.ok(dashboard.payload.revenue > 0);

  const newProductPayload = {
    name: '测试智能设备 T1',
    subtitle: '用于自动化测试的商品',
    category: 'light',
    badge: '',
    images: ['/images/lamp.jpg'],
    rating: 4.8,
    reviews: 0,
    sold: 0,
    description: '测试商品说明',
    features: ['自动测试'],
    specs: { 功率: '10W' },
    warranty: '整机 1 年',
    status: 'active',
    variants: [{ name: '标准版', subtitle: '基础版', price: 199, originalPrice: 299, stock: 10, sku: 'TEST-T1' }]
  };
  const created = await json(await fetch(`${base}/api/admin/products`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(newProductPayload)
  }));
  assert.equal(created.response.status, 201);
  assert.match(created.payload.id, /^product_/);

  const updated = await json(await fetch(`${base}/api/admin/products/${created.payload.id}`, {
    method: 'PUT',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ ...newProductPayload, id: created.payload.id, name: '测试智能设备 T1 Pro' })
  }));
  assert.equal(updated.response.status, 200);
  assert.equal(updated.payload.name, '测试智能设备 T1 Pro');

  const orderList = await json(await fetch(`${base}/api/admin/orders`, { headers: { cookie } }));
  const order = orderList.payload.orders.find((item) => item.orderNo === 'XY202609300002');
  const updatedOrder = await json(await fetch(`${base}/api/admin/orders/${order.id}`, {
    method: 'PUT',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'shipped', shippingCompany: '顺丰速运', trackingNo: 'SF-TEST-001', note: '测试出库' })
  }));
  assert.equal(updatedOrder.response.status, 200);
  assert.equal(updatedOrder.payload.status, 'shipped');
  assert.equal(updatedOrder.payload.trackingNo, 'SF-TEST-001');

  const settings = await json(await fetch(`${base}/api/admin/settings`, {
    method: 'PUT',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ storeName: '星野智家测试', slogan: '测试标语', announcement: '测试公告', freeShippingThreshold: 199, supportHours: '09:00 - 22:00', supportWelcome: '欢迎咨询测试', coupons: [{ code: 'TEST20', title: '测试券', type: 'fixed', value: 20, minSpend: 100, description: '测试', active: true }] })
  }));
  assert.equal(settings.response.status, 200);
  assert.equal(settings.payload.storeName, '星野智家测试');
  assert.equal(settings.payload.coupons[0].code, 'TEST20');

  const deleted = await fetch(`${base}/api/admin/products/${created.payload.id}`, { method: 'DELETE', headers: { cookie } });
  assert.equal(deleted.status, 200);
  const afterDelete = await fetch(`${base}/api/products/${created.payload.id}`);
  assert.equal(afterDelete.status, 404);
});
