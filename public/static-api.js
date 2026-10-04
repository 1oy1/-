const DB_KEY = 'xingye_static_database_v1';
const ADMIN_KEY = 'xingye_static_admin_session';
const ORDER_STATUS = ['paid', 'packed', 'shipped', 'delivered', 'cancelled', 'refunded'];
const STATUS_LABELS = {
  paid: '已付款',
  packed: '已出库',
  shipped: '运输中',
  delivered: '已签收',
  cancelled: '已取消',
  refunded: '已退款'
};

let memoryDatabase = null;

export function isStaticMode() {
  const params = new URLSearchParams(location.search);
  return location.hostname.endsWith('github.io') || params.has('static');
}

function clone(value) {
  return structuredClone(value);
}

function money(value) {
  return Math.round(Number(value) * 100) / 100;
}

function clean(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`;
}

function productMinPrice(product) {
  return Math.min(...product.variants.map((variant) => Number(variant.price)));
}

function productStock(product) {
  return product.variants.reduce((sum, variant) => sum + Number(variant.stock || 0), 0);
}

function categoryName(database, id) {
  return database.categories.find((category) => category.id === id)?.name || '智能生活';
}

function publicOrder(order) {
  return {
    orderNo: order.orderNo,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    status: order.status,
    statusHistory: order.statusHistory,
    items: order.items,
    subtotal: order.subtotal,
    discount: order.discount,
    shipping: order.shipping,
    total: order.total,
    paymentMethod: order.paymentMethod,
    shippingCompany: order.shippingCompany,
    trackingNo: order.trackingNo,
    customer: {
      name: order.customer.name,
      phone: order.customer.phone.replace(/^(\d{3})\d+(\d{4})$/, '$1****$2')
    },
    address: order.address
  };
}

async function loadDatabase() {
  if (memoryDatabase) return memoryDatabase;
  const saved = localStorage.getItem(DB_KEY);
  if (saved) {
    memoryDatabase = JSON.parse(saved);
    return memoryDatabase;
  }
  const response = await fetch(new URL('./data/db.json', import.meta.url));
  if (!response.ok) throw new Error('在线演示数据加载失败，请刷新页面重试');
  memoryDatabase = await response.json();
  persistDatabase();
  return memoryDatabase;
}

function persistDatabase() {
  localStorage.setItem(DB_KEY, JSON.stringify(memoryDatabase));
}

function requireAdmin() {
  if (localStorage.getItem(ADMIN_KEY) !== 'authenticated') throw new Error('请先登录后台');
}

function parseBody(options) {
  if (!options.body) return {};
  if (typeof options.body === 'string') return JSON.parse(options.body);
  return options.body;
}

function listProducts(database, searchParams) {
  const q = clean(searchParams.get('q'), 80).toLocaleLowerCase('zh-CN');
  const category = clean(searchParams.get('category'), 40);
  const min = Number(searchParams.get('min')) || 0;
  const max = Number(searchParams.get('max')) || Number.POSITIVE_INFINITY;
  const sort = clean(searchParams.get('sort'), 30) || 'recommended';
  const page = Math.max(1, Number(searchParams.get('page')) || 1);
  const pageSize = Math.min(48, Math.max(1, Number(searchParams.get('pageSize')) || 12));
  let products = database.products
    .filter((product) => product.status === 'active')
    .map((product) => ({ ...product, minPrice: productMinPrice(product), maxPrice: Math.max(...product.variants.map((item) => item.price)), stock: productStock(product) }));

  if (category && category !== 'all') products = products.filter((product) => product.category === category);
  if (q) {
    products = products.filter((product) => [
      product.name,
      product.subtitle,
      product.description,
      ...(product.features || []),
      ...product.variants.map((variant) => `${variant.name} ${variant.subtitle}`)
    ].join(' ').toLocaleLowerCase('zh-CN').includes(q));
  }
  products = products.filter((product) => product.minPrice >= min && product.minPrice <= max);
  if (searchParams.get('inStock') === 'true') products = products.filter((product) => product.stock > 0);
  if (Number(searchParams.get('rating'))) products = products.filter((product) => product.rating >= Number(searchParams.get('rating')));

  const sorters = {
    'price-asc': (a, b) => a.minPrice - b.minPrice,
    'price-desc': (a, b) => b.minPrice - a.minPrice,
    sales: (a, b) => b.sold - a.sold,
    rating: (a, b) => b.rating - a.rating,
    newest: (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
    recommended: (a, b) => Number(Boolean(b.badge)) - Number(Boolean(a.badge)) || b.sold - a.sold
  };
  products.sort(sorters[sort] || sorters.recommended);
  const total = products.length;
  return { products: products.slice((page - 1) * pageSize, page * pageSize), total, page, pageSize, pages: Math.ceil(total / pageSize) };
}

function createOrder(database, body) {
  const customer = {
    name: clean(body.customer?.name, 40),
    phone: clean(body.customer?.phone, 20),
    email: clean(body.customer?.email, 100)
  };
  const address = {
    province: clean(body.address?.province, 30),
    city: clean(body.address?.city, 30),
    district: clean(body.address?.district, 40),
    detail: clean(body.address?.detail, 160),
    postalCode: clean(body.address?.postalCode, 12)
  };
  if (!customer.name) throw new Error('请填写收货人姓名');
  if (!/^1\d{10}$/.test(customer.phone)) throw new Error('请填写有效的 11 位手机号');
  if (!address.province || !address.city || !address.district || address.detail.length < 5) throw new Error('请填写完整收货地址');
  if (!Array.isArray(body.items) || !body.items.length) throw new Error('购物车为空');
  if (!['wechat', 'alipay', 'unionpay', 'cod'].includes(body.paymentMethod)) throw new Error('请选择有效的支付方式');

  const quantities = new Map();
  for (const item of body.items) {
    const qty = Math.floor(Number(item.qty));
    if (!item.productId || !item.variantId || qty < 1 || qty > 20) throw new Error('购物车商品数量无效');
    const key = `${item.productId}:${item.variantId}`;
    quantities.set(key, (quantities.get(key) || 0) + qty);
  }

  const items = [];
  let subtotal = 0;
  for (const [key, qty] of quantities) {
    const [productId, variantId] = key.split(':');
    const product = database.products.find((item) => item.id === productId && item.status === 'active');
    const variant = product?.variants.find((item) => item.id === variantId);
    if (!product || !variant) throw new Error('部分商品已下架，请刷新购物车');
    if (variant.stock < qty) throw new Error(`「${product.name} ${variant.name}」库存仅剩 ${variant.stock} 件`);
    subtotal += Number(variant.price) * qty;
    items.push({
      productId,
      variantId,
      name: product.name,
      variantName: variant.name,
      price: Number(variant.price),
      qty,
      image: product.images?.[0] || '/images/placeholder.svg'
    });
  }
  subtotal = money(subtotal);

  let coupon = null;
  let discount = 0;
  const couponCode = clean(body.couponCode, 30).toUpperCase();
  if (couponCode) {
    const configured = database.settings.coupons.find((item) => item.code === couponCode && item.active);
    if (!configured) throw new Error('优惠券不存在或已失效');
    if (subtotal < Number(configured.minSpend || 0)) throw new Error(`订单满 ${configured.minSpend} 元才可使用该优惠券`);
    coupon = { code: configured.code, title: configured.title, amount: configured.type === 'fixed' ? Number(configured.value) : 0 };
    discount = configured.type === 'fixed' ? Number(configured.value) : 0;
  }

  const invoice = {
    needed: Boolean(body.invoice?.needed),
    type: body.invoice?.type === 'company' ? 'company' : 'personal',
    title: clean(body.invoice?.title, 100),
    taxNo: clean(body.invoice?.taxNo, 40)
  };
  if (invoice.needed && invoice.type === 'company' && !invoice.title) throw new Error('请填写企业发票抬头');

  for (const [key, qty] of quantities) {
    const [productId, variantId] = key.split(':');
    const variant = database.products.find((product) => product.id === productId).variants.find((item) => item.id === variantId);
    variant.stock -= qty;
  }

  const shipping = couponCode === 'FREESHIP' || subtotal >= Number(database.settings.freeShippingThreshold || 299) ? 0 : 15;
  const now = new Date().toISOString();
  const datePart = now.slice(0, 10).replaceAll('-', '');
  const orderNo = `XY${datePart}${String(database.orders.length + 1).padStart(4, '0')}`;
  const order = {
    id: randomId('ord'),
    orderNo,
    createdAt: now,
    updatedAt: now,
    status: 'paid',
    statusHistory: [{ status: 'paid', label: '已付款', at: now, note: '支付成功，等待仓库处理' }],
    customer,
    address,
    items,
    subtotal,
    discount: money(discount),
    shipping,
    total: money(Math.max(0, subtotal - discount + shipping)),
    coupon,
    paymentMethod: body.paymentMethod,
    invoice,
    shippingCompany: '',
    trackingNo: '',
    customerNote: clean(body.customerNote, 200)
  };
  database.orders.unshift(order);
  persistDatabase();
  return publicOrder(order);
}

function staticReply(database, message) {
  const lower = message.toLowerCase();
  const orderNo = message.toUpperCase().match(/XY\d{12,16}/)?.[0];
  if (orderNo) {
    const order = database.orders.find((item) => item.orderNo === orderNo);
    if (!order) return { text: `没有查询到订单 ${orderNo}，请检查订单号。`, productIds: [] };
    const status = STATUS_LABELS[order.status] || order.status;
    return { text: `订单 ${order.orderNo} 当前状态：${status}。${order.trackingNo ? `承运方 ${order.shippingCompany}，运单号 ${order.trackingNo}。` : '目前还没有物流单号。'}`, productIds: [] };
  }
  if (/人工|转客服/.test(lower)) return { text: `已为您转接人工客服。当前在线时间 ${database.settings.supportHours}，后台客服中心可以查看您的留言并回复。`, productIds: [], escalate: true };
  if (/物流|快递|发货|到哪/.test(lower)) return { text: database.settings.logisticsNote, productIds: [] };
  if (/退换|退货|退款|7天|七天/.test(lower)) return { text: database.settings.returnPolicy, productIds: [] };
  if (/保修|质保|故障|维修/.test(lower)) return { text: '清洁和咖啡类通常整机 1 年、核心电机 2 年；灯具与音箱整机 2 年；智能门锁整机 3 年。具体以商品详情为准。', productIds: [] };
  if (/优惠|券|折扣|活动/.test(lower)) return { text: `当前可用优惠：${database.settings.coupons.filter((item) => item.active).map((item) => `${item.code}（${item.description}）`).join('、')}。`, productIds: [] };
  if (/推荐|哪款|选购|预算|扫地|净化|咖啡|投影|灯/.test(lower)) {
    let candidates = database.products.filter((product) => product.status === 'active');
    const keywordMap = {
      cleaning: ['扫地', '拖地', '清洁', '吸尘'],
      air: ['空气', '净化', '加湿', '甲醛'],
      light: ['灯', '护眼'],
      coffee: ['咖啡'],
      entertainment: ['投影', '音箱', '音乐'],
      security: ['门锁', '摄像头', '监控']
    };
    const category = Object.entries(keywordMap).find(([, keywords]) => keywords.some((keyword) => lower.includes(keyword)))?.[0];
    if (category) candidates = candidates.filter((product) => product.category === category);
    candidates.sort((a, b) => b.sold - a.sold);
    const product = candidates[0] || database.products[0];
    return { text: `根据您的需求，推荐「${product.name}」。${product.subtitle}，最低 ${productMinPrice(product).toLocaleString('zh-CN')} 元起，可以打开商品卡片查看版本差异。`, productIds: [product.id] };
  }
  return { text: '您可以问我商品推荐、版本差异、优惠券、物流、退换货和保修。发送“人工客服”可转人工。', productIds: [] };
}

export async function staticApi(input, options = {}) {
  const database = await loadDatabase();
  const url = new URL(input, location.href);
  const pathname = url.pathname;
  const method = String(options.method || 'GET').toUpperCase();
  const body = parseBody(options);

  if (pathname === '/api/config' && method === 'GET') return clone({ settings: database.settings, categories: database.categories });
  if (pathname === '/api/products' && method === 'GET') return clone(listProducts(database, url.searchParams));
  const productMatch = pathname.match(/^\/api\/products\/([^/]+)$/);
  if (productMatch && method === 'GET') {
    const product = database.products.find((item) => item.id === decodeURIComponent(productMatch[1]) && item.status === 'active');
    if (!product) throw new Error('商品不存在');
    return clone({ ...product, minPrice: productMinPrice(product), maxPrice: Math.max(...product.variants.map((item) => item.price)), stock: productStock(product) });
  }
  if (pathname === '/api/orders' && method === 'POST') return clone(createOrder(database, body));
  if (pathname === '/api/orders/track' && method === 'GET') {
    const order = database.orders.find((item) => item.orderNo === url.searchParams.get('orderNo'));
    if (!order) throw new Error('未查询到该订单');
    if (order.customer.phone !== url.searchParams.get('phone')) throw new Error('手机号与订单不一致');
    return clone(publicOrder(order));
  }
  if (pathname === '/api/support/chat' && method === 'POST') {
    const message = clean(body.message, 1200);
    if (!message) throw new Error('请输入咨询内容');
    let sessionId = clean(body.sessionId, 100) || crypto.randomUUID();
    let thread = database.supportThreads.find((item) => item.sessionId === sessionId);
    const now = new Date().toISOString();
    if (!thread) {
      thread = { id: randomId('sup'), sessionId, createdAt: now, updatedAt: now, status: 'open', unreadAdmin: 0, unreadUser: 0, messages: [] };
      database.supportThreads.unshift(thread);
    }
    thread.messages.push({ id: randomId('msg'), sender: 'user', text: message, at: now, productIds: [] });
    thread.unreadAdmin += 1;
    const reply = staticReply(database, message);
    thread.messages.push({ id: randomId('msg'), sender: 'bot', text: reply.text, at: now, productIds: reply.productIds || [] });
    thread.updatedAt = now;
    if (reply.escalate) thread.status = 'waiting';
    persistDatabase();
    return clone({ sessionId, ...reply });
  }

  if (pathname === '/api/admin/session' && method === 'GET') {
    const authenticated = localStorage.getItem(ADMIN_KEY) === 'authenticated';
    return { authenticated, user: authenticated ? { username: 'admin' } : null };
  }
  if (pathname === '/api/admin/login' && method === 'POST') {
    if (body.username !== 'admin' || body.password !== 'admin123') throw new Error('用户名或密码错误');
    localStorage.setItem(ADMIN_KEY, 'authenticated');
    return { authenticated: true, user: { username: 'admin' } };
  }
  if (pathname === '/api/admin/logout' && method === 'POST') {
    localStorage.removeItem(ADMIN_KEY);
    return { authenticated: false };
  }
  if (pathname.startsWith('/api/admin/')) requireAdmin();

  if (pathname === '/api/admin/dashboard' && method === 'GET') {
    const validOrders = database.orders.filter((order) => !['cancelled', 'refunded'].includes(order.status));
    const lowStock = database.products.flatMap((product) => product.variants.filter((variant) => variant.stock <= 20).map((variant) => ({ productId: product.id, name: product.name, variantName: variant.name, stock: variant.stock, sku: variant.sku }))).sort((a, b) => a.stock - b.stock);
    const salesByDay = Array.from({ length: 7 }, (_, index) => {
      const date = new Date();
      date.setDate(date.getDate() - (6 - index));
      const key = date.toISOString().slice(0, 10);
      return { date: key, total: validOrders.filter((order) => order.createdAt.startsWith(key)).reduce((sum, order) => sum + order.total, 0) };
    });
    return clone({
      revenue: validOrders.reduce((sum, order) => sum + order.total, 0),
      orderCount: database.orders.length,
      validOrderCount: validOrders.length,
      productCount: database.products.length,
      activeProductCount: database.products.filter((product) => product.status === 'active').length,
      lowStockCount: lowStock.length,
      lowStock: lowStock.slice(0, 8),
      supportOpenCount: database.supportThreads.filter((thread) => thread.status !== 'resolved').length,
      recentOrders: database.orders.slice(0, 6),
      salesByDay
    });
  }
  if (pathname === '/api/admin/products' && method === 'GET') return clone({ products: database.products.map((product) => ({ ...product, stock: productStock(product) })) });
  if (pathname === '/api/admin/products' && method === 'POST') {
    const product = saveProduct(database, body);
    persistDatabase();
    return clone(product);
  }
  const adminProductMatch = pathname.match(/^\/api\/admin\/products\/([^/]+)$/);
  if (adminProductMatch && method === 'PUT') {
    const product = saveProduct(database, { ...body, id: decodeURIComponent(adminProductMatch[1]) });
    persistDatabase();
    return clone(product);
  }
  if (adminProductMatch && method === 'DELETE') {
    const id = decodeURIComponent(adminProductMatch[1]);
    const index = database.products.findIndex((product) => product.id === id);
    if (index < 0) throw new Error('商品不存在');
    const [removed] = database.products.splice(index, 1);
    persistDatabase();
    return clone(removed);
  }
  if (pathname === '/api/admin/orders' && method === 'GET') {
    const status = url.searchParams.get('status');
    const q = clean(url.searchParams.get('q'), 80).toLowerCase();
    let orders = database.orders;
    if (status && status !== 'all') orders = orders.filter((order) => order.status === status);
    if (q) orders = orders.filter((order) => `${order.orderNo} ${order.customer.name} ${order.customer.phone}`.toLowerCase().includes(q));
    return clone({ orders });
  }
  const adminOrderMatch = pathname.match(/^\/api\/admin\/orders\/([^/]+)$/);
  if (adminOrderMatch && method === 'PUT') {
    const order = database.orders.find((item) => item.id === decodeURIComponent(adminOrderMatch[1]));
    if (!order) throw new Error('订单不存在');
    if (!ORDER_STATUS.includes(body.status)) throw new Error('订单状态无效');
    order.status = body.status;
    order.shippingCompany = clean(body.shippingCompany, 60) || order.shippingCompany;
    order.trackingNo = clean(body.trackingNo, 80) || order.trackingNo;
    order.updatedAt = new Date().toISOString();
    order.statusHistory.push({ status: order.status, label: STATUS_LABELS[order.status], at: order.updatedAt, note: clean(body.note, 160) || '后台已更新订单状态' });
    persistDatabase();
    return clone(order);
  }
  if (pathname === '/api/admin/settings' && method === 'PUT') {
    Object.assign(database.settings, {
      storeName: clean(body.storeName, 60),
      slogan: clean(body.slogan, 120),
      announcement: clean(body.announcement, 180),
      supportHours: clean(body.supportHours, 80),
      supportWelcome: clean(body.supportWelcome, 300),
      freeShippingThreshold: Math.max(0, Number(body.freeShippingThreshold) || 0)
    });
    if (Array.isArray(body.coupons)) database.settings.coupons = body.coupons.map((coupon) => ({ ...coupon, code: clean(coupon.code, 30).toUpperCase(), active: coupon.active !== false }));
    persistDatabase();
    return clone(database.settings);
  }
  if (pathname === '/api/admin/support' && method === 'GET') return clone({ threads: database.supportThreads });
  const readMatch = pathname.match(/^\/api\/admin\/support\/([^/]+)\/read$/);
  if (readMatch && method === 'PUT') {
    const thread = database.supportThreads.find((item) => item.id === decodeURIComponent(readMatch[1]));
    if (!thread) throw new Error('客服会话不存在');
    thread.unreadAdmin = 0;
    persistDatabase();
    return clone(thread);
  }
  const replyMatch = pathname.match(/^\/api\/admin\/support\/([^/]+)\/reply$/);
  if (replyMatch && method === 'POST') {
    const thread = database.supportThreads.find((item) => item.id === decodeURIComponent(replyMatch[1]));
    if (!thread) throw new Error('客服会话不存在');
    const message = { id: randomId('msg'), sender: 'human', text: clean(body.message, 1200), at: new Date().toISOString(), productIds: [] };
    thread.messages.push(message);
    thread.updatedAt = message.at;
    persistDatabase();
    return clone(message);
  }
  const statusMatch = pathname.match(/^\/api\/admin\/support\/([^/]+)\/status$/);
  if (statusMatch && method === 'PUT') {
    const thread = database.supportThreads.find((item) => item.id === decodeURIComponent(statusMatch[1]));
    if (!thread) throw new Error('客服会话不存在');
    thread.status = ['open', 'waiting', 'resolved'].includes(body.status) ? body.status : 'open';
    thread.updatedAt = new Date().toISOString();
    persistDatabase();
    return clone(thread);
  }

  throw new Error('在线演示暂不支持该接口');
}

function saveProduct(database, body) {
  const name = clean(body.name, 100);
  if (!name) throw new Error('商品名称不能为空');
  const category = clean(body.category, 40);
  if (!database.categories.some((item) => item.id === category)) throw new Error('商品分类无效');
  const variants = (body.variants || []).map((variant) => ({
    id: clean(variant.id, 60) || randomId('variant'),
    name: clean(variant.name, 40),
    subtitle: clean(variant.subtitle, 80),
    price: Number(variant.price),
    originalPrice: Math.max(Number(variant.price), Number(variant.originalPrice) || Number(variant.price)),
    stock: Math.max(0, Math.floor(Number(variant.stock) || 0)),
    sku: clean(variant.sku, 60) || randomId('SKU').toUpperCase()
  }));
  if (!variants.length || variants.some((variant) => !variant.name || !Number.isFinite(variant.price) || variant.price <= 0)) throw new Error('商品版本信息不完整');
  const id = clean(body.id, 80) || randomId('product');
  const product = {
    id,
    name,
    subtitle: clean(body.subtitle, 140),
    category,
    badge: clean(body.badge, 30),
    images: Array.isArray(body.images) && body.images.length ? body.images : ['/images/placeholder.svg'],
    rating: Math.min(5, Math.max(0, Number(body.rating) || 4.8)),
    reviews: Math.max(0, Number(body.reviews) || 0),
    sold: Math.max(0, Number(body.sold) || 0),
    description: clean(body.description, 1500),
    features: Array.isArray(body.features) ? body.features : [],
    specs: body.specs || {},
    variants,
    warranty: clean(body.warranty, 120) || '整机 1 年',
    status: body.status === 'draft' ? 'draft' : 'active',
    createdAt: clean(body.createdAt, 40) || new Date().toISOString()
  };
  const index = database.products.findIndex((item) => item.id === id);
  if (index >= 0) database.products[index] = product;
  else database.products.unshift(product);
  return product;
}
