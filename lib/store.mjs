import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

function safeCompare(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

const ORDER_STATUSES = ['paid', 'packed', 'shipped', 'delivered', 'cancelled', 'refunded'];
const PAYMENT_METHODS = ['wechat', 'alipay', 'unionpay', 'cod'];
const STATUS_LABELS = {
  paid: '已付款',
  packed: '已出库',
  shipped: '运输中',
  delivered: '已签收',
  cancelled: '已取消',
  refunded: '已退款'
};

function clone(value) {
  return structuredClone(value);
}

function money(value) {
  return Math.round(Number(value) * 100) / 100;
}

function cleanText(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function productMinPrice(product) {
  return Math.min(...product.variants.map((variant) => Number(variant.price)));
}

function productStock(product) {
  return product.variants.reduce((sum, variant) => sum + Math.max(0, Number(variant.stock) || 0), 0);
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
    customer: { name: order.customer.name, phone: order.customer.phone.replace(/^(\d{3})\d+(\d{4})$/, '$1****$2') },
    address: {
      province: order.address.province,
      city: order.address.city,
      district: order.address.district,
      detail: order.address.detail
    }
  };
}

function normalizeVariant(variant, index) {
  const name = cleanText(variant?.name, 40);
  if (!name) throw new Error(`第 ${index + 1} 个版本缺少名称`);
  const price = Number(variant?.price);
  if (!Number.isFinite(price) || price <= 0 || price > 1000000) throw new Error(`版本「${name}」价格无效`);
  return {
    id: cleanText(variant?.id, 60) || `variant-${randomBytes(4).toString('hex')}`,
    name,
    subtitle: cleanText(variant?.subtitle, 80),
    price: money(price),
    originalPrice: Math.max(money(price), money(variant?.originalPrice || price)),
    stock: Math.max(0, Math.floor(Number(variant?.stock) || 0)),
    sku: cleanText(variant?.sku, 60) || `XY-${randomBytes(3).toString('hex').toUpperCase()}`
  };
}

export class Store {
  constructor(dataFile) {
    this.dataFile = path.resolve(dataFile);
    this.data = null;
    this.queue = Promise.resolve();
  }

  async init() {
    const raw = await fs.readFile(this.dataFile, 'utf8');
    this.data = JSON.parse(raw);
    if (!Array.isArray(this.data.products)) throw new Error('商品数据格式错误');
    if (!Array.isArray(this.data.orders)) this.data.orders = [];
    if (!Array.isArray(this.data.supportThreads)) this.data.supportThreads = [];
    if (!Array.isArray(this.data.auditLog)) this.data.auditLog = [];
    return this;
  }

  async persist() {
    const temp = `${this.dataFile}.${process.pid}.tmp`;
    await fs.mkdir(path.dirname(this.dataFile), { recursive: true });
    await fs.writeFile(temp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    await fs.rename(temp, this.dataFile);
  }

  async read(handler) {
    await this.queue;
    return handler(clone(this.data));
  }

  async mutate(handler) {
    let result;
    const operation = this.queue.then(async () => {
      const snapshot = clone(this.data);
      try {
        result = await handler(this.data);
        await this.persist();
        return result;
      } catch (error) {
        this.data = snapshot;
        throw error;
      }
    });
    this.queue = operation.then(() => undefined, () => undefined);
    await operation;
    return clone(result);
  }

  getConfig() {
    return this.read((data) => ({
      settings: data.settings,
      categories: data.categories
    }));
  }

  listProducts(query = {}) {
    return this.read((data) => {
      const q = cleanText(query.q, 80).toLocaleLowerCase('zh-CN');
      const category = cleanText(query.category, 40);
      const min = Number(query.min) || 0;
      const max = Number(query.max) || Number.POSITIVE_INFINITY;
      const inStock = query.inStock === 'true' || query.inStock === true;
      const rating = Number(query.rating) || 0;
      const sort = cleanText(query.sort, 30) || 'recommended';
      const page = Math.max(1, Number(query.page) || 1);
      const pageSize = Math.min(48, Math.max(1, Number(query.pageSize) || 12));

      let products = data.products
        .filter((product) => product.status === 'active')
        .map((product) => ({ ...product, minPrice: productMinPrice(product), stock: productStock(product) }));

      if (category && category !== 'all') products = products.filter((product) => product.category === category);
      if (q) {
        products = products.filter((product) => {
          const searchable = [
            product.name,
            product.subtitle,
            product.description,
            ...(product.features || []),
            ...product.variants.map((variant) => `${variant.name} ${variant.subtitle}`)
          ].join(' ').toLocaleLowerCase('zh-CN');
          return searchable.includes(q);
        });
      }
      products = products.filter((product) => product.minPrice >= min && product.minPrice <= max);
      if (inStock) products = products.filter((product) => product.stock > 0);
      if (rating) products = products.filter((product) => product.rating >= rating);

      const sorters = {
        'price-asc': (a, b) => a.minPrice - b.minPrice,
        'price-desc': (a, b) => b.minPrice - a.minPrice,
        sales: (a, b) => b.sold - a.sold,
        rating: (a, b) => b.rating - a.rating || b.reviews - a.reviews,
        newest: (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
        recommended: (a, b) => Number(Boolean(b.badge)) - Number(Boolean(a.badge)) || b.sold - a.sold
      };
      products.sort(sorters[sort] || sorters.recommended);

      const total = products.length;
      const offset = (page - 1) * pageSize;
      return { products: products.slice(offset, offset + pageSize), total, page, pageSize, pages: Math.ceil(total / pageSize) };
    });
  }

  getProduct(id) {
    return this.read((data) => {
      const product = data.products.find((item) => item.id === id && item.status === 'active');
      if (!product) return null;
      return { ...product, minPrice: productMinPrice(product), maxPrice: Math.max(...product.variants.map((item) => item.price)), stock: productStock(product) };
    });
  }

  createOrder(payload) {
    return this.mutate((data) => {
      const customer = {
        name: cleanText(payload?.customer?.name, 40),
        phone: cleanText(payload?.customer?.phone, 20),
        email: cleanText(payload?.customer?.email, 100)
      };
      const address = {
        province: cleanText(payload?.address?.province, 30),
        city: cleanText(payload?.address?.city, 30),
        district: cleanText(payload?.address?.district, 40),
        detail: cleanText(payload?.address?.detail, 160),
        postalCode: cleanText(payload?.address?.postalCode, 12)
      };
      if (!customer.name) throw new Error('请填写收货人姓名');
      if (!/^1\d{10}$/.test(customer.phone)) throw new Error('请填写有效的 11 位手机号');
      if (!address.province || !address.city || !address.district || address.detail.length < 5) throw new Error('请填写完整收货地址');
      if (!Array.isArray(payload?.items) || payload.items.length === 0) throw new Error('购物车为空');
      if (!PAYMENT_METHODS.includes(payload?.paymentMethod)) throw new Error('请选择有效的支付方式');

      const quantities = new Map();
      for (const item of payload.items) {
        const productId = cleanText(item?.productId, 60);
        const variantId = cleanText(item?.variantId, 60);
        const qty = Math.floor(Number(item?.qty));
        if (!productId || !variantId || !Number.isInteger(qty) || qty < 1 || qty > 20) throw new Error('购物车商品数量无效');
        const key = `${productId}:${variantId}`;
        quantities.set(key, (quantities.get(key) || 0) + qty);
      }

      const orderItems = [];
      let subtotal = 0;
      for (const [key, qty] of quantities) {
        const [productId, variantId] = key.split(':');
        const product = data.products.find((item) => item.id === productId && item.status === 'active');
        if (!product) throw new Error('部分商品已下架，请刷新购物车');
        const variant = product.variants.find((item) => item.id === variantId);
        if (!variant) throw new Error(`「${product.name}」所选版本已下架`);
        if (variant.stock < qty) throw new Error(`「${product.name} ${variant.name}」库存仅剩 ${variant.stock} 件`);
        subtotal += Number(variant.price) * qty;
        orderItems.push({
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
      const couponCode = cleanText(payload?.couponCode, 30).toUpperCase();
      if (couponCode) {
        const found = data.settings.coupons.find((item) => item.code === couponCode && item.active);
        if (!found) throw new Error('优惠券不存在或已失效');
        if (subtotal < Number(found.minSpend || 0)) throw new Error(`订单满 ${found.minSpend} 元才可使用该优惠券`);
        coupon = { code: found.code, title: found.title, amount: found.type === 'fixed' ? Number(found.value) : 0 };
        discount = found.type === 'fixed' ? Number(found.value) : 0;
      }

      let shipping = subtotal >= Number(data.settings.freeShippingThreshold || 299) ? 0 : 15;
      if (couponCode === 'FREESHIP') shipping = 0;
      const total = money(Math.max(0, subtotal - discount + shipping));
      const now = new Date().toISOString();
      const datePart = now.slice(0, 10).replaceAll('-', '');
      const sequence = String(data.orders.length + 1).padStart(4, '0');
      const orderNo = `XY${datePart}${sequence}`;

      const invoice = {
        needed: Boolean(payload?.invoice?.needed),
        type: payload?.invoice?.type === 'company' ? 'company' : 'personal',
        title: cleanText(payload?.invoice?.title, 100),
        taxNo: cleanText(payload?.invoice?.taxNo, 40)
      };
      if (invoice.needed && invoice.type === 'company' && !invoice.title) throw new Error('请填写企业发票抬头');

      for (const [key, qty] of quantities) {
        const [productId, variantId] = key.split(':');
        const product = data.products.find((item) => item.id === productId);
        const variant = product.variants.find((item) => item.id === variantId);
        variant.stock -= qty;
      }


      const order = {
        id: `ord_${randomUUID()}`,
        orderNo,
        createdAt: now,
        updatedAt: now,
        status: 'paid',
        statusHistory: [{ status: 'paid', label: '已付款', at: now, note: payload.paymentMethod === 'cod' ? '货到付款订单已确认' : '支付成功，等待仓库处理' }],
        customer,
        address,
        items: orderItems,
        subtotal,
        discount: money(discount),
        shipping: money(shipping),
        total,
        coupon,
        paymentMethod: payload.paymentMethod,
        invoice,
        shippingCompany: '',
        trackingNo: '',
        customerNote: cleanText(payload?.customerNote, 200)
      };
      data.orders.unshift(order);
      data.auditLog.unshift({ id: `audit_${randomUUID()}`, action: 'order.create', actor: customer.name, at: now, detail: `${orderNo} 创建订单，金额 ${total} 元` });
      return publicOrder(order);
    });
  }

  trackOrder(orderNo, phone) {
    return this.read((data) => {
      const normalizedNumber = cleanText(orderNo, 40).toUpperCase();
      const normalizedPhone = cleanText(phone, 20);
      const order = data.orders.find((item) => item.orderNo.toUpperCase() === normalizedNumber);
      if (!order) throw new Error('未查询到该订单');
      if (order.customer.phone !== normalizedPhone) throw new Error('手机号与订单不一致');
      return publicOrder(order);
    });
  }

  authenticate(username, password) {
    return this.read((data) => {
      void data;
      const expectedUser = process.env.ADMIN_USERNAME || 'admin';
      const expectedPassword = process.env.ADMIN_PASSWORD || 'admin123';
      return safeCompare(username, expectedUser) && safeCompare(password, expectedPassword);
    });
  }

  dashboard() {
    return this.read((data) => {
      const validOrders = data.orders.filter((order) => !['cancelled', 'refunded'].includes(order.status));
      const revenue = validOrders.reduce((sum, order) => sum + Number(order.total || 0), 0);
      const lowStock = [];
      for (const product of data.products) {
        for (const variant of product.variants) {
          if (variant.stock <= 20) {
            lowStock.push({ productId: product.id, name: product.name, variantName: variant.name, stock: variant.stock, sku: variant.sku });
          }
        }
      }
      lowStock.sort((a, b) => a.stock - b.stock);
      const salesByDay = [];
      const now = new Date();
      for (let offset = 6; offset >= 0; offset -= 1) {
        const day = new Date(now);
        day.setDate(now.getDate() - offset);
        const key = day.toISOString().slice(0, 10);
        const total = validOrders
          .filter((order) => order.createdAt.slice(0, 10) === key)
          .reduce((sum, order) => sum + Number(order.total || 0), 0);
        salesByDay.push({ date: key, total });
      }
      return {
        revenue,
        orderCount: data.orders.length,
        validOrderCount: validOrders.length,
        productCount: data.products.length,
        activeProductCount: data.products.filter((product) => product.status === 'active').length,
        lowStockCount: lowStock.length,
        lowStock: lowStock.slice(0, 8),
        supportOpenCount: data.supportThreads.filter((thread) => thread.status !== 'resolved').length,
        recentOrders: data.orders.slice(0, 6),
        salesByDay
      };
    });
  }

  listAdminProducts() {
    return this.read((data) => data.products.map((product) => ({ ...product, stock: productStock(product) })));
  }

  saveProduct(payload) {
    return this.mutate((data) => {
      const isUpdate = Boolean(payload?.id && data.products.some((product) => product.id === payload.id));
      const categoryIds = new Set(data.categories.map((category) => category.id));
      const name = cleanText(payload?.name, 100);
      if (!name) throw new Error('商品名称不能为空');
      const category = cleanText(payload?.category, 40);
      if (!categoryIds.has(category)) throw new Error('商品分类无效');
      if (!Array.isArray(payload?.variants) || payload.variants.length === 0) throw new Error('至少需要一个商品版本');
      const variants = payload.variants.map(normalizeVariant);
      const ids = new Set(variants.map((variant) => variant.id));
      if (ids.size !== variants.length) throw new Error('商品版本 ID 重复');

      const input = {
        id: cleanText(payload?.id, 80) || `product_${randomBytes(5).toString('hex')}`,
        name,
        subtitle: cleanText(payload?.subtitle, 140),
        category,
        badge: cleanText(payload?.badge, 30),
        images: Array.isArray(payload?.images) ? payload.images.map((item) => cleanText(item, 300)).filter(Boolean).slice(0, 6) : [],
        rating: Math.min(5, Math.max(0, Number(payload?.rating) || 4.8)),
        reviews: Math.max(0, Math.floor(Number(payload?.reviews) || 0)),
        sold: Math.max(0, Math.floor(Number(payload?.sold) || 0)),
        description: cleanText(payload?.description, 1500),
        features: Array.isArray(payload?.features) ? payload.features.map((item) => cleanText(item, 100)).filter(Boolean).slice(0, 12) : [],
        specs: payload?.specs && typeof payload.specs === 'object' ? Object.fromEntries(Object.entries(payload.specs).slice(0, 20).map(([key, value]) => [cleanText(key, 50), cleanText(value, 120)])) : {},
        variants,
        warranty: cleanText(payload?.warranty, 120) || '整机 1 年',
        status: payload?.status === 'draft' ? 'draft' : 'active',
        createdAt: cleanText(payload?.createdAt, 40) || new Date().toISOString()
      };
      if (!input.images.length) input.images = ['/images/placeholder.svg'];
      const index = data.products.findIndex((product) => product.id === input.id);
      if (index >= 0) data.products[index] = { ...data.products[index], ...input };
      else data.products.unshift(input);
      const now = new Date().toISOString();
      data.auditLog.unshift({ id: `audit_${randomUUID()}`, action: isUpdate ? 'product.update' : 'product.create', actor: 'admin', at: now, detail: `${name} 已保存` });
      return input;
    });
  }

  deleteProduct(id) {
    return this.mutate((data) => {
      const index = data.products.findIndex((product) => product.id === id);
      if (index < 0) throw new Error('商品不存在');
      const [removed] = data.products.splice(index, 1);
      data.auditLog.unshift({ id: `audit_${randomUUID()}`, action: 'product.delete', actor: 'admin', at: new Date().toISOString(), detail: `${removed.name} 已删除` });
      return removed;
    });
  }

  listAdminOrders(query = {}) {
    return this.read((data) => {
      const status = cleanText(query.status, 30);
      const q = cleanText(query.q, 80).toLocaleLowerCase('zh-CN');
      let orders = data.orders.map(clone);
      if (status && status !== 'all') orders = orders.filter((order) => order.status === status);
      if (q) orders = orders.filter((order) => `${order.orderNo} ${order.customer.name} ${order.customer.phone}`.toLocaleLowerCase('zh-CN').includes(q));
      return orders;
    });
  }

  updateOrderStatus(id, status, tracking = {}) {
    return this.mutate((data) => {
      if (!ORDER_STATUSES.includes(status)) throw new Error('订单状态无效');
      const order = data.orders.find((item) => item.id === id);
      if (!order) throw new Error('订单不存在');
      const previous = order.status;
      if (previous === status && !tracking.shippingCompany && !tracking.trackingNo) return order;
      if (['cancelled', 'refunded'].includes(previous) && !['cancelled', 'refunded'].includes(status)) throw new Error('已取消或退款订单不可恢复到处理中状态');
      if (['cancelled', 'refunded'].includes(status) && !['cancelled', 'refunded'].includes(previous)) {
        for (const item of order.items) {
          const product = data.products.find((candidate) => candidate.id === item.productId);
          const variant = product?.variants.find((candidate) => candidate.id === item.variantId);
          if (variant) variant.stock += item.qty;
        }
      }
      order.status = status;
      order.shippingCompany = cleanText(tracking.shippingCompany, 60) || order.shippingCompany;
      order.trackingNo = cleanText(tracking.trackingNo, 80) || order.trackingNo;
      order.updatedAt = new Date().toISOString();
      order.statusHistory.push({
        status,
        label: STATUS_LABELS[status],
        at: order.updatedAt,
        note: cleanText(tracking.note, 160) || `${STATUS_LABELS[status]}，状态已由后台更新`
      });
      data.auditLog.unshift({ id: `audit_${randomUUID()}`, action: 'order.status', actor: 'admin', at: order.updatedAt, detail: `${order.orderNo} 更新为 ${STATUS_LABELS[status]}` });
      return order;
    });
  }

  updateSettings(payload) {
    return this.mutate((data) => {
      const settings = data.settings;
      settings.storeName = cleanText(payload?.storeName, 60) || settings.storeName;
      settings.slogan = cleanText(payload?.slogan, 120) || settings.slogan;
      settings.announcement = cleanText(payload?.announcement, 180) || settings.announcement;
      settings.supportHours = cleanText(payload?.supportHours, 80) || settings.supportHours;
      settings.supportWelcome = cleanText(payload?.supportWelcome, 300) || settings.supportWelcome;
      settings.freeShippingThreshold = Math.max(0, Number(payload?.freeShippingThreshold) || settings.freeShippingThreshold);
      if (Array.isArray(payload?.coupons)) {
        settings.coupons = payload.coupons.map((coupon) => ({
          code: cleanText(coupon.code, 30).toUpperCase(),
          title: cleanText(coupon.title, 60),
          type: coupon.type === 'shipping' ? 'shipping' : 'fixed',
          value: Math.max(0, Number(coupon.value) || 0),
          minSpend: Math.max(0, Number(coupon.minSpend) || 0),
          description: cleanText(coupon.description, 100),
          active: Boolean(coupon.active)
        })).filter((coupon) => coupon.code && coupon.title);
      }
      data.auditLog.unshift({ id: `audit_${randomUUID()}`, action: 'settings.update', actor: 'admin', at: new Date().toISOString(), detail: '营销与店铺设置已更新' });
      return settings;
    });
  }

  listSupportThreads() {
    return this.read((data) => data.supportThreads.slice().sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)));
  }

  getSupportThread(sessionId, create = false) {
    return this.mutate((data) => {
      let thread = data.supportThreads.find((item) => item.sessionId === sessionId);
      if (!thread && create) {
        const now = new Date().toISOString();
        thread = {
          id: `sup_${randomUUID()}`,
          sessionId,
          createdAt: now,
          updatedAt: now,
          status: 'open',
          unreadAdmin: 0,
          unreadUser: 0,
          messages: []
        };
        data.supportThreads.unshift(thread);
      }
      return thread || null;
    });
  }

  appendSupportMessage(sessionId, message) {
    return this.mutate((data) => {
      let thread = data.supportThreads.find((item) => item.sessionId === sessionId);
      const now = new Date().toISOString();
      if (!thread) {
        thread = {
          id: `sup_${randomUUID()}`,
          sessionId,
          createdAt: now,
          updatedAt: now,
          status: 'open',
          unreadAdmin: 0,
          unreadUser: 0,
          messages: []
        };
        data.supportThreads.unshift(thread);
      }
      const normalized = {
        id: `msg_${randomUUID()}`,
        sender: ['user', 'bot', 'human'].includes(message.sender) ? message.sender : 'bot',
        text: cleanText(message.text, 1200),
        at: now,
        productIds: Array.isArray(message.productIds) ? message.productIds.slice(0, 4) : []
      };
      thread.messages.push(normalized);
      thread.updatedAt = now;
      if (normalized.sender === 'user') thread.unreadAdmin += 1;
      if (normalized.sender === 'bot' || normalized.sender === 'human') thread.unreadUser += 1;
      return normalized;
    });
  }

  setSupportStatus(id, status) {
    return this.mutate((data) => {
      const thread = data.supportThreads.find((item) => item.id === id);
      if (!thread) throw new Error('客服会话不存在');
      if (!['open', 'waiting', 'resolved'].includes(status)) throw new Error('会话状态无效');
      thread.status = status;
      thread.updatedAt = new Date().toISOString();
      if (status === 'resolved') {
        thread.unreadAdmin = 0;
        thread.unreadUser = 0;
      }
      return thread;
    });
  }

  markSupportRead(id) {
    return this.mutate((data) => {
      const thread = data.supportThreads.find((item) => item.id === id);
      if (!thread) throw new Error('客服会话不存在');
      thread.unreadAdmin = 0;
      return thread;
    });
  }

  findOrderByNumber(orderNo) {
    return this.read((data) => {
      const order = data.orders.find((item) => item.orderNo === cleanText(orderNo, 40));
      return order ? publicOrder(order) : null;
    });
  }
}
