const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
import { api } from './api-adapter.js';

const state = {
  config: null,
  products: [],
  filters: {
    q: '',
    category: 'all',
    price: '',
    stock: false,
    rating: false,
    sort: 'recommended',
    page: 1,
    pageSize: 9
  },
  cart: readStorage('xy_cart_v1', []),
  couponCode: readStorage('xy_coupon_v1', ''),
  currentProduct: null,
  currentVariantId: '',
  currentImage: '',
  detailQty: 1,
  checkoutTotals: null,
  chatSessionId: readStorage('xy_chat_session', ''),
  chatMessages: readStorage('xy_chat_messages', []),
  lastOrder: readStorage('xy_last_order', null)
};

function readStorage(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Browser storage can be unavailable in private mode.
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function money(value) {
  const number = Number(value) || 0;
  return `¥${number.toLocaleString('zh-CN', { minimumFractionDigits: number % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

function imagePath(value) {
  return value ? String(value).replace(/^\/images\//, 'images/').replace(/^\/assets\//, 'assets/') : 'images/placeholder.svg';
}

function categoryName(id) {
  return state.config?.categories.find((category) => category.id === id)?.name || '智能生活';
}

function productPrice(product) {
  return Math.min(...product.variants.map((variant) => Number(variant.price)));
}

function productOriginalPrice(product) {
  const selected = product.variants.find((variant) => Number(variant.price) === productPrice(product)) || product.variants[0];
  return Number(selected.originalPrice || selected.price);
}


function toast(message, type = '') {
  const region = $('#toast-region');
  const element = document.createElement('div');
  element.className = `toast ${type}`.trim();
  element.textContent = message;
  region.append(element);
  setTimeout(() => element.remove(), 2800);
}

function cartCount() {
  return state.cart.reduce((sum, item) => sum + item.qty, 0);
}

function cartSubtotal() {
  return state.cart.reduce((sum, item) => sum + item.price * item.qty, 0);
}

function configuredCoupon() {
  return state.config?.settings.coupons.find((coupon) => coupon.code === state.couponCode && coupon.active) || null;
}

function cartTotals() {
  const subtotal = cartSubtotal();
  const coupon = configuredCoupon();
  let discount = 0;
  if (coupon?.type === 'fixed' && subtotal >= Number(coupon.minSpend)) discount = Number(coupon.value);
  const baseShipping = subtotal >= Number(state.config?.settings.freeShippingThreshold || 299) ? 0 : 15;
  const shipping = coupon?.type === 'shipping' ? 0 : baseShipping;
  return { subtotal, discount, shipping, total: Math.max(0, subtotal - discount + shipping), coupon };
}

function productCard(product, compact = false) {
  const minPrice = productPrice(product);
  const maxPrice = Math.max(...product.variants.map((variant) => variant.price));
  const priceLabel = minPrice === maxPrice ? `${money(minPrice)}起` : `${money(minPrice)}起`;
  return `
    <article class="product-card" data-product-card="${escapeHtml(product.id)}">
      <button class="product-card-media" type="button" data-open-product="${escapeHtml(product.id)}" aria-label="查看 ${escapeHtml(product.name)}">
        <img src="${imagePath(product.images?.[0])}" alt="${escapeHtml(product.name)}" loading="lazy">
        ${product.badge ? `<span class="product-badge">${escapeHtml(product.badge)}</span>` : ''}
      </button>
      <div class="product-card-body">
        <span class="product-category">${escapeHtml(categoryName(product.category))}</span>
        <h3>${escapeHtml(product.name)}</h3>
        ${compact ? '' : `<p class="product-subtitle">${escapeHtml(product.subtitle)}</p>`}
        <div class="rating-line">
          <svg aria-hidden="true"><use href="#icon-star"></use></svg>
          <strong>${Number(product.rating).toFixed(1)}</strong>
          <span>${Number(product.reviews).toLocaleString('zh-CN')} 条评价</span>
          <span>· 已售 ${Number(product.sold).toLocaleString('zh-CN')}</span>
        </div>
        <div class="price-row">
          <span class="price">${priceLabel}</span>
          <span class="original-price">${money(productOriginalPrice(product))}</span>
        </div>
        <div class="product-card-footer">
          <span class="variant-count">${product.variants.length} 个版本可选</span>
          <button class="button" type="button" data-open-product="${escapeHtml(product.id)}">查看版本</button>
        </div>
      </div>
    </article>`;
}

function renderConfig() {
  const settings = state.config.settings;
  document.title = `${settings.storeName} · 智能生活官方商城`;
  $('#announcement').textContent = settings.announcement;
  $('#category-links').innerHTML = state.config.categories
    .map((category) => `<a href="#all-products" data-category="${escapeHtml(category.id)}">${escapeHtml(category.name)}</a>`)
    .join('');

  $('#category-grid').innerHTML = state.config.categories.map((category) => `
    <a class="category-card" href="#all-products" data-category="${escapeHtml(category.id)}">
      <svg aria-hidden="true"><use href="#icon-${escapeHtml(category.icon)}"></use></svg>
      <span><strong>${escapeHtml(category.name)}</strong><br>${escapeHtml(category.description)}</span>
    </a>`).join('');

  $('#filter-categories').innerHTML = [
    '<label><input type="radio" name="filter-category" value="all" checked><span>全部商品</span></label>',
    ...state.config.categories.map((category) => `<label><input type="radio" name="filter-category" value="${escapeHtml(category.id)}"><span>${escapeHtml(category.name)}</span></label>`)
  ].join('');
}

function renderHero() {
  const heroProduct = state.products.find((product) => product.id === 'r1-pro') || state.products[0];
  if (!heroProduct) return;
  $('#hero-product').innerHTML = `
    <div class="hero-product-card">
      <img src="${imagePath(heroProduct.images?.[0])}" alt="${escapeHtml(heroProduct.name)}">
      <div class="hero-product-info">
        <small>编辑推荐 · ${escapeHtml(categoryName(heroProduct.category))}</small>
        <h3>${escapeHtml(heroProduct.name)}</h3>
        <div class="price-row">
          <span class="price">${money(productPrice(heroProduct))}起</span>
          <button class="button button-primary" type="button" data-open-product="${escapeHtml(heroProduct.id)}">查看详情</button>
        </div>
      </div>
    </div>`;
}

function renderSpotlight() {
  const product = state.products.find((item) => item.id === 'a3') || state.products[0];
  if (!product) return;
  $('#spotlight-product').innerHTML = `
    <img src="${imagePath(product.images?.[0])}" alt="${escapeHtml(product.name)}">
    <div class="spotlight-content">
      <p class="eyebrow light">好物主推</p>
      <h3>${escapeHtml(product.name)}</h3>
      <p>${escapeHtml(product.subtitle)}</p>
      <div class="spotlight-price"><strong>${money(productPrice(product))}</strong><span>起</span></div>
      <button class="button button-primary" type="button" data-open-product="${escapeHtml(product.id)}">进入商品页</button>
    </div>`;
}

function renderFeatured() {
  const products = state.products
    .slice()
    .sort((a, b) => b.sold - a.sold)
    .slice(0, 4);
  $('#featured-product-grid').innerHTML = products.map((product) => productCard(product, true)).join('');
}

async function loadProducts(options = {}) {
  const params = new URLSearchParams({
    page: String(state.filters.page),
    pageSize: String(state.filters.pageSize),
    sort: state.filters.sort
  });
  if (state.filters.q) params.set('q', state.filters.q);
  if (state.filters.category !== 'all') params.set('category', state.filters.category);
  if (state.filters.price) {
    const [min, max] = state.filters.price.split('-');
    params.set('min', min);
    params.set('max', max);
  }
  if (state.filters.stock) params.set('inStock', 'true');
  if (state.filters.rating) params.set('rating', '4.8');
  const payload = await api(`/api/products?${params}`);
  $('#product-grid').innerHTML = payload.products.map((product) => productCard(product)).join('');
  $('#product-empty').hidden = payload.products.length > 0;
  $('#result-count').textContent = `共 ${payload.total} 件商品`;
  $('#product-section-title').textContent = state.filters.category === 'all' ? '智能生活精选' : categoryName(state.filters.category);
  renderPagination(payload);
  updateFilterUi();

  const searched = Boolean(state.filters.q || state.filters.category !== 'all' || state.filters.price || state.filters.stock || state.filters.rating);
  $('#clear-filters').hidden = !searched;
  if (options.scroll) {
    document.querySelector('#all-products').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function renderPagination(payload) {
  if (payload.pages <= 1) {
    $('#pagination').innerHTML = '';
    return;
  }
  const buttons = [];
  buttons.push(`<button type="button" data-page="${payload.page - 1}" ${payload.page <= 1 ? 'disabled' : ''}>上一页</button>`);
  for (let page = 1; page <= payload.pages; page += 1) {
    buttons.push(`<button type="button" data-page="${page}" class="${page === payload.page ? 'active' : ''}">${page}</button>`);
  }
  buttons.push(`<button type="button" data-page="${payload.page + 1}" ${payload.page >= payload.pages ? 'disabled' : ''}>下一页</button>`);
  $('#pagination').innerHTML = buttons.join('');
}

function updateFilterUi() {
  const categoryRadio = $(`input[name="filter-category"][value="${state.filters.category}"]`);
  if (categoryRadio) categoryRadio.checked = true;
  const priceRadio = $(`input[name="price"][value="${state.filters.price}"]`);
  if (priceRadio) priceRadio.checked = true;
  $('#filter-stock').checked = state.filters.stock;
  $('#filter-rating').checked = state.filters.rating;
  $('#sort-select').value = state.filters.sort;
  $$('[data-category]').forEach((element) => {
    element.classList.toggle('active', element.dataset.category === state.filters.category && state.filters.category !== 'all');
  });
}

function findProduct(id) {
  return state.products.find((product) => product.id === id) || null;
}

async function getProduct(id) {
  return findProduct(id) || api(`/api/products/${encodeURIComponent(id)}`);
}

async function openProduct(id) {
  try {
    const product = await getProduct(id);
    if (!product) throw new Error('商品不存在');
    state.currentProduct = product;
    state.currentVariantId = product.variants[0].id;
    state.currentImage = product.images[0];
    state.detailQty = 1;
    renderProductDialog();
    const dialog = $('#product-dialog');
    if (!dialog.open) dialog.showModal();
  } catch (error) {
    toast(error.message, 'error');
  }
}

function renderProductDialog() {
  const product = state.currentProduct;
  const variant = product.variants.find((item) => item.id === state.currentVariantId) || product.variants[0];
  const saving = Math.max(0, Number(variant.originalPrice) - Number(variant.price));
  const specs = Object.entries(product.specs || {});
  $('#product-dialog-content').innerHTML = `
    <button class="icon-button dialog-close light" type="button" data-close-product aria-label="关闭">
      <svg><use href="#icon-close"></use></svg>
    </button>
    <div class="product-detail">
      <div class="product-gallery">
        <img class="product-gallery-main" id="product-gallery-main" src="${imagePath(state.currentImage)}" alt="${escapeHtml(product.name)}">
        <div class="product-gallery-thumbs">
          ${product.images.map((image, index) => `<button type="button" data-gallery-image="${escapeHtml(image)}" class="${image === state.currentImage ? 'active' : ''}" aria-label="查看第 ${index + 1} 张图片"><img src="${imagePath(image)}" alt=""></button>`).join('')}
        </div>
      </div>
      <div class="product-detail-info">
        ${product.badge ? `<span class="detail-badge">${escapeHtml(product.badge)}</span>` : ''}
        <p class="product-category">${escapeHtml(categoryName(product.category))}</p>
        <h2>${escapeHtml(product.name)}</h2>
        <p class="product-detail-subtitle">${escapeHtml(product.subtitle)}</p>
        <div class="detail-rating">
          <span class="rating-line"><svg><use href="#icon-star"></use></svg><strong>${Number(product.rating).toFixed(1)}</strong></span>
          <span>${Number(product.reviews).toLocaleString('zh-CN')} 条评价</span>
          <span>已售 ${Number(product.sold).toLocaleString('zh-CN')}</span>
        </div>
        <div class="detail-price">
          <strong>${money(variant.price)}</strong>
          <del>${money(variant.originalPrice)}</del>
        </div>
        ${saving > 0 ? `<p class="detail-saving">已优惠 ${money(saving)}，含税价，满 299 元包邮</p>` : '<p class="detail-saving">官方含税价，满 299 元包邮</p>'}
        <div class="option-group">
          <div class="option-title">选择版本 <span>库存 ${variant.stock} 件</span></div>
          <div class="variant-options">
            ${product.variants.map((item) => `
              <button class="variant-option ${item.id === variant.id ? 'active' : ''}" type="button" data-variant="${escapeHtml(item.id)}" ${item.stock <= 0 ? 'disabled' : ''}>
                <strong>${escapeHtml(item.name)}</strong>
                <small>${escapeHtml(item.subtitle || '')} · ${money(item.price)}</small>
              </button>`).join('')}
          </div>
        </div>
        <div class="option-group">
          <div class="option-title">数量 <span>单个订单最多 20 件</span></div>
          <div class="quantity-control">
            <button type="button" data-detail-qty="-1" aria-label="减少数量"><svg><use href="#icon-minus"></use></svg></button>
            <span>${state.detailQty}</span>
            <button type="button" data-detail-qty="1" aria-label="增加数量"><svg><use href="#icon-plus"></use></svg></button>
          </div>
        </div>
        <div class="detail-actions">
          <button class="button button-secondary" type="button" data-chat-product="${escapeHtml(product.id)}"><svg><use href="#icon-message"></use></svg>咨询</button>
          <button class="button button-primary" type="button" data-add-detail ${variant.stock <= 0 ? 'disabled' : ''}>加入购物车 · ${money(variant.price * state.detailQty)}</button>
        </div>
        <div class="detail-service-list">
          <span><svg><use href="#icon-shield"></use></svg>${escapeHtml(product.warranty)}</span>
          <span><svg><use href="#icon-truck"></use></svg>预计 24 小时内出库</span>
          <span><svg><use href="#icon-refresh"></use></svg>7 天无理由退换</span>
        </div>
        <div class="detail-sections">
          <details open>
            <summary>商品说明</summary>
            <div>
              <p>${escapeHtml(product.description)}</p>
              <ul class="feature-list">${product.features.map((feature) => `<li>${escapeHtml(feature)}</li>`).join('')}</ul>
            </div>
          </details>
          <details>
            <summary>核心参数</summary>
            <div>
              <table class="spec-table"><tbody>${specs.map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(value)}</td></tr>`).join('')}</tbody></table>
            </div>
          </details>
          <details>
            <summary>配送与售后</summary>
            <div><p>${escapeHtml(state.config.settings.logisticsNote)}</p><p>${escapeHtml(state.config.settings.returnPolicy)}</p></div>
          </details>
        </div>
      </div>
    </div>`;
}

function addToCart(product, variantId, qty = 1) {
  const variant = product.variants.find((item) => item.id === variantId);
  if (!variant) throw new Error('版本不存在');
  if (variant.stock <= 0) throw new Error('该版本暂时无货');
  const existing = state.cart.find((item) => item.productId === product.id && item.variantId === variant.id);
  const nextQty = (existing?.qty || 0) + qty;
  if (nextQty > variant.stock) throw new Error(`该版本库存仅剩 ${variant.stock} 件`);
  if (existing) existing.qty = nextQty;
  else {
    state.cart.push({
      productId: product.id,
      variantId: variant.id,
      name: product.name,
      variantName: variant.name,
      price: Number(variant.price),
      image: product.images?.[0] || 'images/placeholder.svg',
      stock: Number(variant.stock),
      qty
    });
  }
  writeStorage('xy_cart_v1', state.cart);
  renderCart();
  toast(`${product.name} ${variant.name} 已加入购物车`, 'success');
  openCart();
}

function updateCartQuantity(productId, variantId, delta) {
  const item = state.cart.find((entry) => entry.productId === productId && entry.variantId === variantId);
  if (!item) return;
  const next = item.qty + delta;
  if (next <= 0) {
    state.cart = state.cart.filter((entry) => entry !== item);
  } else if (next > item.stock) {
    toast(`库存仅剩 ${item.stock} 件`, 'error');
    return;
  } else {
    item.qty = next;
  }
  writeStorage('xy_cart_v1', state.cart);
  renderCart();
}

function renderCart() {
  const count = cartCount();
  $('#cart-count').textContent = count;
  $('#cart-drawer-count').textContent = count;
  const empty = state.cart.length === 0;
  $('#cart-empty').classList.toggle('visible', empty);
  $('#cart-items').hidden = empty;
  $('#cart-footer').hidden = empty;
  $('#cart-progress').hidden = empty;

  if (empty) {
    $('#cart-items').innerHTML = '';
    return;
  }

  $('#cart-items').innerHTML = state.cart.map((item) => `
    <article class="cart-item">
      <img src="${imagePath(item.image)}" alt="${escapeHtml(item.name)}">
      <div class="cart-item-info">
        <h3>${escapeHtml(item.name)}</h3>
        <p>${escapeHtml(item.variantName)} · 库存 ${item.stock} 件</p>
        <div class="cart-item-bottom">
          <div class="quantity-control">
            <button type="button" data-cart-qty="-1" data-product-id="${escapeHtml(item.productId)}" data-variant-id="${escapeHtml(item.variantId)}" aria-label="减少数量"><svg><use href="#icon-minus"></use></svg></button>
            <span>${item.qty}</span>
            <button type="button" data-cart-qty="1" data-product-id="${escapeHtml(item.productId)}" data-variant-id="${escapeHtml(item.variantId)}" aria-label="增加数量"><svg><use href="#icon-plus"></use></svg></button>
          </div>
          <strong class="cart-item-price">${money(item.price * item.qty)}</strong>
        </div>
        <button class="cart-item-remove" type="button" data-remove-cart data-product-id="${escapeHtml(item.productId)}" data-variant-id="${escapeHtml(item.variantId)}">移除</button>
      </div>
    </article>`).join('');

  const totals = cartTotals();
  const threshold = Number(state.config.settings.freeShippingThreshold);
  if (totals.subtotal >= threshold) $('#cart-progress').textContent = '已满足包邮条件，预计不收取基础运费';
  else $('#cart-progress').textContent = `再买 ${money(threshold - totals.subtotal)} 即可包邮`;
  $('#cart-subtotal').textContent = money(totals.subtotal);
  $('#cart-shipping').textContent = totals.shipping ? money(totals.shipping) : '免运费';
  $('#cart-discount-row').hidden = totals.discount <= 0;
  $('#cart-discount').textContent = `-${money(totals.discount)}`;
  $('#cart-coupon-input').value = state.couponCode || '';
  if (state.couponCode && !totals.coupon) {
    state.couponCode = '';
    writeStorage('xy_coupon_v1', '');
  }
}

function openCart() {
  $('#cart-drawer').classList.add('open');
  $('#cart-drawer').setAttribute('aria-hidden', 'false');
  $('#drawer-backdrop').hidden = false;
  document.body.classList.add('no-scroll');
}

function closeCart() {
  $('#cart-drawer').classList.remove('open');
  $('#cart-drawer').setAttribute('aria-hidden', 'true');
  $('#drawer-backdrop').hidden = true;
  document.body.classList.remove('no-scroll');
}

function applyCoupon(code) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!normalized) {
    state.couponCode = '';
    writeStorage('xy_coupon_v1', '');
    $('#coupon-message').textContent = '已取消优惠券';
    renderCart();
    return false;
  }
  const coupon = state.config.settings.coupons.find((item) => item.code === normalized && item.active);
  const message = $('#coupon-message');
  if (!coupon) {
    message.textContent = '优惠码不存在或已失效';
    message.classList.add('error');
    return false;
  }
  if (cartSubtotal() < Number(coupon.minSpend || 0)) {
    message.textContent = `还差 ${money(coupon.minSpend - cartSubtotal())} 可使用`;
    message.classList.add('error');
    return false;
  }
  state.couponCode = coupon.code;
  writeStorage('xy_coupon_v1', coupon.code);
  message.classList.remove('error');
  toast(`已使用 ${coupon.title}`, 'success');
  renderCart();
  $('#coupon-message').textContent = `${coupon.title} 已生效`;
  return true;
}

function openCheckout() {
  if (!state.cart.length) {
    toast('购物车为空', 'error');
    return;
  }
  const totals = cartTotals();
  state.checkoutTotals = totals;
  closeCart();
  $('#checkout-dialog-content').innerHTML = `
    <div class="checkout-layout">
      <form class="checkout-main" id="checkout-form">
        <div class="checkout-heading">
          <div><p class="eyebrow">确认订单</p><h2>填写配送与支付信息</h2></div>
          <div class="step-indicator"><span class="step-dot">1</span><span>信息确认</span><span>·</span><span>2</span><span>提交订单</span></div>
        </div>
        <section class="form-section">
          <h3><span>1</span>收货信息</h3>
          <div class="form-grid">
            <div class="field"><label for="checkout-name">收货人</label><input id="checkout-name" name="name" required maxlength="40" placeholder="请输入姓名"></div>
            <div class="field"><label for="checkout-phone">手机号</label><input id="checkout-phone" name="phone" required inputmode="numeric" pattern="1[0-9]{10}" maxlength="11" placeholder="11 位手机号"></div>
            <div class="field"><label for="checkout-province">省份</label><input id="checkout-province" name="province" required maxlength="30" placeholder="例如：浙江省"></div>
            <div class="field"><label for="checkout-city">城市</label><input id="checkout-city" name="city" required maxlength="30" placeholder="例如：杭州市"></div>
            <div class="field"><label for="checkout-district">区 / 县</label><input id="checkout-district" name="district" required maxlength="40" placeholder="例如：西湖区"></div>
            <div class="field"><label for="checkout-postal">邮编</label><input id="checkout-postal" name="postalCode" maxlength="12" inputmode="numeric" placeholder="选填"></div>
            <div class="field full"><label for="checkout-detail">详细地址</label><input id="checkout-detail" name="detail" required minlength="5" maxlength="160" placeholder="街道、门牌号、楼栋和房间号"></div>
            <div class="field full"><label for="checkout-note">配送备注</label><textarea id="checkout-note" name="customerNote" maxlength="200" placeholder="例如：工作日送货，送达前电话联系"></textarea></div>
          </div>
        </section>
        <section class="form-section">
          <h3><span>2</span>支付方式</h3>
          <div class="radio-cards">
            <label class="radio-card"><input type="radio" name="paymentMethod" value="wechat" checked><span>微信支付</span></label>
            <label class="radio-card"><input type="radio" name="paymentMethod" value="alipay"><span>支付宝</span></label>
            <label class="radio-card"><input type="radio" name="paymentMethod" value="unionpay"><span>银联云闪付</span></label>
          </div>
          <p class="cart-note">演示环境不会发起真实扣款，提交后订单直接进入已付款状态。</p>
        </section>
        <section class="form-section" style="border-bottom:0;margin-bottom:0">
          <h3><span>3</span>发票信息</h3>
          <label class="checkbox-line"><input type="checkbox" name="invoiceNeeded" id="invoice-needed">我需要发票</label>
          <div class="form-grid" id="invoice-fields" hidden style="margin-top:14px">
            <div class="field"><label for="invoice-type">发票类型</label><select id="invoice-type" name="invoiceType"><option value="personal">个人电子普票</option><option value="company">企业专票</option></select></div>
            <div class="field"><label for="invoice-title">发票抬头</label><input id="invoice-title" name="invoiceTitle" maxlength="100" placeholder="个人可填姓名"></div>
            <div class="field full"><label for="invoice-tax">税号</label><input id="invoice-tax" name="invoiceTaxNo" maxlength="40" placeholder="企业专票必填"></div>
          </div>
        </section>
      </form>
      <aside class="checkout-summary">
        <h3>订单摘要</h3>
        <div class="checkout-summary-items">
          ${state.cart.map((item) => `
            <div class="checkout-summary-item">
              <img src="${imagePath(item.image)}" alt="">
              <p>${escapeHtml(item.name)}<span>${escapeHtml(item.variantName)} × ${item.qty}</span></p>
              <strong>${money(item.price * item.qty)}</strong>
            </div>`).join('')}
        </div>
        <div class="checkout-totals">
          <span>商品小计 <strong>${money(totals.subtotal)}</strong></span>
          <span>优惠 <strong>-${money(totals.discount)}</strong></span>
          <span>运费 <strong>${totals.shipping ? money(totals.shipping) : '免运费'}</strong></span>
        </div>
        <div class="checkout-grand"><span>应付总额</span><strong>${money(totals.total)}</strong></div>
        <button class="button button-primary button-wide" type="submit" form="checkout-form" id="place-order-button">提交订单</button>
        <div class="checkout-trust"><svg><use href="#icon-shield"></use></svg>支付信息仅用于演示，不会上传至第三方支付平台</div>
      </aside>
    </div>`;
  $('#checkout-dialog').showModal();
}

async function submitOrder(form) {
  const formData = new FormData(form);
  const button = $('#place-order-button');
  button.disabled = true;
  button.textContent = '正在提交...';
  try {
    const payload = {
      customer: {
        name: formData.get('name'),
        phone: formData.get('phone'),
        email: ''
      },
      address: {
        province: formData.get('province'),
        city: formData.get('city'),
        district: formData.get('district'),
        detail: formData.get('detail'),
        postalCode: formData.get('postalCode')
      },
      items: state.cart.map((item) => ({ productId: item.productId, variantId: item.variantId, qty: item.qty })),
      paymentMethod: formData.get('paymentMethod'),
      couponCode: state.couponCode,
      customerNote: formData.get('customerNote'),
      invoice: {
        needed: Boolean(formData.get('invoiceNeeded')),
        type: formData.get('invoiceType') || 'personal',
        title: formData.get('invoiceTitle') || '',
        taxNo: formData.get('invoiceTaxNo') || ''
      }
    };
    const order = await api('/api/orders', { method: 'POST', body: JSON.stringify(payload) });
    state.lastOrder = { orderNo: order.orderNo, phone: payload.customer.phone, total: order.total, createdAt: order.createdAt };
    writeStorage('xy_last_order', state.lastOrder);
    state.cart = [];
    state.couponCode = '';
    writeStorage('xy_cart_v1', []);
    writeStorage('xy_coupon_v1', '');
    renderCart();
    $('#checkout-dialog').close();
    showSuccess(order);
    await refreshProducts();
  } catch (error) {
    toast(error.message, 'error');
    button.disabled = false;
    button.textContent = '提交订单';
  }
}

function showSuccess(order) {
  $('#success-dialog-content').innerHTML = `
    <div class="success-content">
      <div class="success-icon"><svg><use href="#icon-check"></use></svg></div>
      <h2>订单提交成功</h2>
      <p>商品将从就近仓库发出，预计 1-4 天送达。</p>
      <div class="success-order-number"><small>订单号</small><strong>${escapeHtml(order.orderNo)}</strong><span>实付 ${money(order.total)}</span></div>
      <div class="success-actions">
        <button class="button button-secondary" type="button" data-close-success>继续购物</button>
        <button class="button button-primary" type="button" data-view-order="${escapeHtml(order.orderNo)}">查看订单</button>
      </div>
    </div>`;
  $('#success-dialog').showModal();
}

function openTracking(orderNo = '', phone = '') {
  $('#tracking-dialog-content').innerHTML = `
    <button class="icon-button dialog-close" type="button" data-close-tracking aria-label="关闭"><svg><use href="#icon-close"></use></svg></button>
    <div class="tracking-content">
      <p class="eyebrow">订单与服务</p>
      <h2>查询物流进度</h2>
      <p>请输入订单号和下单手机号。订单仅对验证通过的手机号显示。</p>
      <form class="tracking-form" id="tracking-form">
        <input name="orderNo" value="${escapeHtml(orderNo)}" required placeholder="订单号，例如 XY202609280001">
        <input name="phone" value="${escapeHtml(phone)}" required inputmode="numeric" pattern="1[0-9]{10}" placeholder="下单手机号">
        <button class="button button-primary" type="submit">查询</button>
      </form>
      <div class="tracking-result" id="tracking-result">
        <p class="muted">输入信息后即可查看订单状态和物流节点。</p>
      </div>
    </div>`;
  if (!state.lastOrder) {
    const orderInput = $('#tracking-form [name="orderNo"]');
    const phoneInput = $('#tracking-form [name="phone"]');
    if (!orderInput.value) orderInput.placeholder = '演示订单：XY202609280001';
    if (!phoneInput.value) phoneInput.placeholder = '演示手机号：13800138001';
  }
  $('#tracking-dialog').showModal();
}

async function queryTracking(form) {
  const formData = new FormData(form);
  const result = $('#tracking-result');
  result.innerHTML = '<p class="muted">正在查询...</p>';
  try {
    const order = await api(`/api/orders/track?orderNo=${encodeURIComponent(formData.get('orderNo'))}&phone=${encodeURIComponent(formData.get('phone'))}`);
    const statusLabels = { paid: '已付款', packed: '已出库', shipped: '运输中', delivered: '已签收', cancelled: '已取消', refunded: '已退款' };
    result.innerHTML = `
      <div class="order-summary-card">
        <div class="order-summary-head">
          <div><small>订单号</small><strong>${escapeHtml(order.orderNo)}</strong></div>
          <span class="order-status">${escapeHtml(statusLabels[order.status] || order.status)}</span>
        </div>
        <p>${order.items.map((item) => `${escapeHtml(item.name)} ${escapeHtml(item.variantName)} × ${item.qty}`).join('<br>')}</p>
        ${order.trackingNo ? `<p>${escapeHtml(order.shippingCompany)}：<strong>${escapeHtml(order.trackingNo)}</strong></p>` : '<p>仓库正在处理，有运单号后会自动更新。</p>'}
      </div>
      <div class="timeline">
        ${order.statusHistory.slice().reverse().map((entry) => `
          <div class="timeline-item">
            <div><strong>${escapeHtml(entry.label)}</strong><small>${new Date(entry.at).toLocaleString('zh-CN', { hour12: false })}</small></div>
            <span class="timeline-dot"></span>
            <div class="timeline-content"><strong>${escapeHtml(entry.note)}</strong></div>
          </div>`).join('')}
      </div>`;
  } catch (error) {
    result.innerHTML = `<p style="color:var(--coral)">${escapeHtml(error.message)}</p>`;
  }
}

function openMember() {
  const last = state.lastOrder;
  $('#member-dialog-content').innerHTML = `
    <button class="icon-button dialog-close" type="button" data-close-member aria-label="关闭"><svg><use href="#icon-close"></use></svg></button>
    <div class="member-content">
      <div class="member-profile">
        <div class="member-avatar">星</div>
        <div><h2>星野会员</h2><p>普通会员 · 已开通价格保护</p></div>
      </div>
      <div class="member-stats">
        <div><strong>1,280</strong><span>可用积分</span></div>
        <div><strong>2</strong><span>优惠券</span></div>
        <div><strong>${last ? '1' : '0'}</strong><span>近期订单</span></div>
      </div>
      <div class="member-actions">
        <button class="button button-secondary" type="button" data-member-track>订单与物流</button>
        <button class="button button-primary" type="button" data-member-coupon="NEW100">领取新客券</button>
      </div>
      ${last ? `<div class="order-summary-card" style="margin-top:20px"><div class="order-summary-head"><div><small>最近订单</small><strong>${escapeHtml(last.orderNo)}</strong></div><span class="order-status">${money(last.total)}</span></div><button class="text-link" type="button" data-member-track>查看详情 <svg><use href="#icon-arrow"></use></svg></button></div>` : '<p class="cart-note" style="margin-top:20px">完成首单后可在这里查看订单记录。</p>'}
    </div>`;
  $('#member-dialog').showModal();
}

function openAdminWorkspace(pushHistory = true) {
  const workspace = $('#admin-workspace');
  const frame = $('#admin-frame');
  if (!frame.src) frame.src = 'admin.html?embedded=1&v=20261004c';
  workspace.hidden = false;
  document.body.classList.add('no-scroll');
  if (pushHistory && new URLSearchParams(location.search).get('view') !== 'admin') {
    history.pushState({ view: 'admin' }, '', '?view=admin');
  }
}

function closeAdminWorkspace(pushHistory = true) {
  $('#admin-workspace').hidden = true;
  document.body.classList.remove('no-scroll');
  if (pushHistory && new URLSearchParams(location.search).get('view') === 'admin') {
    history.pushState({ view: 'store' }, '', location.pathname);
  }
}

function syncAdminWorkspaceFromUrl() {
  if (new URLSearchParams(location.search).get('view') === 'admin') openAdminWorkspace(false);
  else closeAdminWorkspace(false);
}

function ensureChatWelcome() {
  if (state.chatMessages.length) return;
  state.chatMessages.push({
    sender: 'bot',
    text: state.config.settings.supportWelcome,
    at: new Date().toISOString(),
    productIds: []
  });
  writeStorage('xy_chat_messages', state.chatMessages);
}

function renderChat(typing = false) {
  const panel = $('#chat-messages');
  panel.innerHTML = state.chatMessages.slice(-30).map((message) => {
    const time = new Date(message.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    const products = (message.productIds || []).map((id) => findProduct(id)).filter(Boolean).map((product) => `
      <button class="chat-product-card" type="button" data-chat-open-product="${escapeHtml(product.id)}">
        <img src="${imagePath(product.images?.[0])}" alt="">
        <span><strong>${escapeHtml(product.name)}</strong><small>${money(productPrice(product))}起 · 查看版本</small></span>
      </button>`).join('');
    return `<div class="chat-message ${escapeHtml(message.sender)}"><div class="chat-bubble">${escapeHtml(message.text)}${products}</div><time>${time}</time></div>`;
  }).join('');
  if (typing) {
    panel.insertAdjacentHTML('beforeend', '<div class="chat-message bot"><div class="chat-bubble"><span class="typing-indicator"><i></i><i></i><i></i></span></div></div>');
  }
  panel.scrollTop = panel.scrollHeight;
}

function openChat() {
  ensureChatWelcome();
  renderChat();
  $('#chat-panel').classList.add('open');
  $('#chat-panel').setAttribute('aria-hidden', 'false');
  setTimeout(() => $('#chat-input').focus(), 180);
}

function closeChat() {
  $('#chat-panel').classList.remove('open');
  $('#chat-panel').setAttribute('aria-hidden', 'true');
}

async function sendChat(text) {
  const message = String(text || '').trim();
  if (!message) return;
  state.chatMessages.push({ sender: 'user', text: message, at: new Date().toISOString(), productIds: [] });
  writeStorage('xy_chat_messages', state.chatMessages);
  renderChat(true);
  $('#chat-input').value = '';
  try {
    const reply = await api('/api/support/chat', {
      method: 'POST',
      body: JSON.stringify({ sessionId: state.chatSessionId, message })
    });
    state.chatSessionId = reply.sessionId;
    writeStorage('xy_chat_session', reply.sessionId);
    await new Promise((resolve) => setTimeout(resolve, 300));
    state.chatMessages.push({ sender: 'bot', text: reply.text, at: new Date().toISOString(), productIds: reply.productIds || [] });
    writeStorage('xy_chat_messages', state.chatMessages);
    renderChat();
  } catch (error) {
    state.chatMessages.push({ sender: 'bot', text: `暂时无法处理：${error.message}`, at: new Date().toISOString(), productIds: [] });
    renderChat();
  }
}

function openMobileNav() {
  const element = document.createElement('div');
  element.id = 'mobile-nav-layer';
  element.innerHTML = `
    <div class="mobile-nav-backdrop" data-close-mobile-nav></div>
    <aside class="mobile-nav">
      <div class="mobile-nav-header"><strong>商品分类</strong><button class="icon-button" type="button" data-close-mobile-nav><svg><use href="#icon-close"></use></svg></button></div>
      <nav>
        <a href="#all-products" data-category="all" data-close-mobile-nav>全部商品</a>
        ${state.config.categories.map((category) => `<a href="#all-products" data-category="${escapeHtml(category.id)}" data-close-mobile-nav>${escapeHtml(category.name)}</a>`).join('')}
        <a href="#service" data-close-mobile-nav>服务保障</a>
        <a href="admin.html?embedded=1" data-open-admin data-close-mobile-nav>运营后台</a>
      </nav>
    </aside>`;
  document.body.append(element);
  document.body.classList.add('no-scroll');
}

function closeMobileNav() {
  $('#mobile-nav-layer')?.remove();
  document.body.classList.remove('no-scroll');
}

function openMobileFilters() {
  $('#mobile-filter-content').innerHTML = `
    <div class="mobile-filter-content">
      <div class="section-heading compact"><div><p class="eyebrow">筛选商品</p><h2>缩小选择范围</h2></div><button class="icon-button" type="button" data-close-mobile-filter><svg><use href="#icon-close"></use></svg></button></div>
      <fieldset class="filter-group"><legend>分类</legend><div class="filter-options">
        <label><input type="radio" name="mobile-category" value="all" ${state.filters.category === 'all' ? 'checked' : ''}><span>全部商品</span></label>
        ${state.config.categories.map((category) => `<label><input type="radio" name="mobile-category" value="${escapeHtml(category.id)}" ${state.filters.category === category.id ? 'checked' : ''}><span>${escapeHtml(category.name)}</span></label>`).join('')}
      </div></fieldset>
      <fieldset class="filter-group"><legend>价格</legend><div class="filter-options">
        ${[
          ['', '全部价格'],
          ['0-999', '999 元以下'],
          ['1000-1999', '1,000 - 1,999 元'],
          ['2000-2999', '2,000 - 2,999 元'],
          ['3000-99999', '3,000 元以上']
        ].map(([value, label]) => `<label><input type="radio" name="mobile-price" value="${value}" ${state.filters.price === value ? 'checked' : ''}><span>${label}</span></label>`).join('')}
      </div></fieldset>
      <fieldset class="filter-group"><legend>其他</legend><div class="filter-options">
        <label><input type="checkbox" id="mobile-filter-stock" ${state.filters.stock ? 'checked' : ''}><span>仅看有货</span></label>
        <label><input type="checkbox" id="mobile-filter-rating" ${state.filters.rating ? 'checked' : ''}><span>评分 4.8 以上</span></label>
      </div></fieldset>
      <button class="button button-primary button-wide" id="apply-mobile-filters" type="button">查看结果</button>
    </div>`;
  $('#mobile-filter-dialog').showModal();
}

async function refreshProducts() {
  const payload = await api('/api/products?pageSize=48&sort=recommended');
  state.products = payload.products;
}

function applyMobileFilters() {
  state.filters.category = $('input[name="mobile-category"]:checked')?.value || 'all';
  state.filters.price = $('input[name="mobile-price"]:checked')?.value || '';
  state.filters.stock = $('#mobile-filter-stock').checked;
  state.filters.rating = $('#mobile-filter-rating').checked;
  state.filters.page = 1;
  $('#mobile-filter-dialog').close();
  loadProducts({ scroll: true });
}

function bindEvents() {
  window.addEventListener('scroll', () => {
    $('#site-header').classList.toggle('scrolled', window.scrollY > 12);
  }, { passive: true });

  document.addEventListener('error', (event) => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement)) return;
    if (image.src.endsWith('/images/placeholder.svg')) return;
    image.src = 'images/placeholder.svg';
  }, true);

  $('#header-search').addEventListener('submit', (event) => {
    event.preventDefault();
    state.filters.q = $('#search-input').value.trim();
    state.filters.page = 1;
    loadProducts({ scroll: true });
  });

  $('#cart-button').addEventListener('click', openCart);
  $('#admin-entry-button').addEventListener('click', (event) => {
    event.preventDefault();
    openAdminWorkspace();
  });
  $('#admin-workspace-close').addEventListener('click', () => closeAdminWorkspace());
  $('#cart-close').addEventListener('click', closeCart);
  $('#drawer-backdrop').addEventListener('click', closeCart);
  $('#checkout-button').addEventListener('click', openCheckout);
  $('#apply-coupon').addEventListener('click', () => applyCoupon($('#cart-coupon-input').value));
  $('#cart-coupon-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') applyCoupon(event.target.value);
  });

  document.addEventListener('click', async (event) => {
    const adminEntry = event.target.closest('[data-open-admin]');
    if (adminEntry) {
      event.preventDefault();
      closeMobileNav();
      openAdminWorkspace();
      return;
    }
    const openButton = event.target.closest('[data-open-product]');
    if (openButton) {
      await openProduct(openButton.dataset.openProduct);
      return;
    }
    const category = event.target.closest('[data-category]');
    if (category) {
      event.preventDefault();
      const shouldCloseMobileNav = category.hasAttribute('data-close-mobile-nav');
      state.filters.category = category.dataset.category;
      state.filters.page = 1;
      await loadProducts({ scroll: true });
      if (shouldCloseMobileNav) closeMobileNav();
      return;
    }
    const scrollAll = event.target.closest('[data-scroll-all]');
    if (scrollAll) {
      document.querySelector('#all-products').scrollIntoView({ behavior: 'smooth' });
      return;
    }
    const closeCartButton = event.target.closest('[data-close-cart]');
    if (closeCartButton) {
      closeCart();
      document.querySelector('#featured-products').scrollIntoView({ behavior: 'smooth' });
      return;
    }
    const quantity = event.target.closest('[data-cart-qty]');
    if (quantity) {
      updateCartQuantity(quantity.dataset.productId, quantity.dataset.variantId, Number(quantity.dataset.cartQty));
      return;
    }
    const remove = event.target.closest('[data-remove-cart]');
    if (remove) {
      state.cart = state.cart.filter((item) => !(item.productId === remove.dataset.productId && item.variantId === remove.dataset.variantId));
      writeStorage('xy_cart_v1', state.cart);
      renderCart();
      return;
    }
    const page = event.target.closest('[data-page]');
    if (page && !page.disabled) {
      state.filters.page = Number(page.dataset.page);
      await loadProducts({ scroll: true });
      return;
    }
    const coupon = event.target.closest('[data-coupon]');
    if (coupon) {
      state.couponCode = coupon.dataset.coupon;
      writeStorage('xy_coupon_v1', state.couponCode);
      renderCart();
      openCart();
      applyCoupon(state.couponCode);
      return;
    }
    const closeMobile = event.target.closest('[data-close-mobile-nav]');
    if (closeMobile) {
      closeMobileNav();
      return;
    }
    if (event.target.closest('#mobile-filter-button')) {
      openMobileFilters();
      return;
    }
    if (event.target.closest('[data-close-mobile-filter]')) {
      $('#mobile-filter-dialog').close();
      return;
    }
    if (event.target.closest('#apply-mobile-filters')) {
      applyMobileFilters();
      return;
    }
    if (event.target.closest('#track-order-button') || event.target.closest('#footer-track-button')) {
      openTracking();
      return;
    }
    if (event.target.closest('#member-button')) {
      openMember();
      return;
    }
    if (event.target.closest('[data-member-track]')) {
      $('#member-dialog').close();
      openTracking(state.lastOrder?.orderNo || '', state.lastOrder?.phone || '');
      return;
    }
    if (event.target.closest('[data-member-coupon]')) {
      state.couponCode = 'NEW100';
      writeStorage('xy_coupon_v1', 'NEW100');
      $('#member-dialog').close();
      renderCart();
      openCart();
      toast('新客券已放入，满足门槛后自动使用', 'success');
      return;
    }
    if (event.target.closest('[data-close-success]')) {
      $('#success-dialog').close();
      return;
    }
    const viewOrder = event.target.closest('[data-view-order]');
    if (viewOrder) {
      $('#success-dialog').close();
      openTracking(viewOrder.dataset.viewOrder, state.lastOrder?.phone || '');
      return;
    }
  });

  document.addEventListener('change', (event) => {
    if (event.target.matches('input[name="filter-category"]')) {
      state.filters.category = event.target.value;
      state.filters.page = 1;
      loadProducts({ scroll: false });
    }
    if (event.target.matches('input[name="price"]')) {
      state.filters.price = event.target.value;
      state.filters.page = 1;
      loadProducts({ scroll: false });
    }
    if (event.target.id === 'filter-stock') {
      state.filters.stock = event.target.checked;
      state.filters.page = 1;
      loadProducts({ scroll: false });
    }
    if (event.target.id === 'filter-rating') {
      state.filters.rating = event.target.checked;
      state.filters.page = 1;
      loadProducts({ scroll: false });
    }
    if (event.target.id === 'sort-select') {
      state.filters.sort = event.target.value;
      state.filters.page = 1;
      loadProducts({ scroll: false });
    }
  });

  $('#clear-filters').addEventListener('click', () => {
    state.filters = { ...state.filters, q: '', category: 'all', price: '', stock: false, rating: false, page: 1 };
    $('#search-input').value = '';
    loadProducts({ scroll: false });
  });

  const productDialog = $('#product-dialog');
  productDialog.addEventListener('click', (event) => {
    if (event.target === productDialog) productDialog.close();
    if (event.target.closest('[data-close-product]')) productDialog.close();
    const variantButton = event.target.closest('[data-variant]');
    if (variantButton) {
      state.currentVariantId = variantButton.dataset.variant;
      state.detailQty = 1;
      renderProductDialog();
      return;
    }
    const galleryButton = event.target.closest('[data-gallery-image]');
    if (galleryButton) {
      state.currentImage = galleryButton.dataset.galleryImage;
      renderProductDialog();
      return;
    }
    const qtyButton = event.target.closest('[data-detail-qty]');
    if (qtyButton) {
      const variant = state.currentProduct.variants.find((item) => item.id === state.currentVariantId);
      state.detailQty = Math.min(Math.max(1, state.detailQty + Number(qtyButton.dataset.detailQty)), Math.min(20, variant.stock));
      renderProductDialog();
      return;
    }
    if (event.target.closest('[data-add-detail]')) {
      try {
        addToCart(state.currentProduct, state.currentVariantId, state.detailQty);
        productDialog.close();
      } catch (error) {
        toast(error.message, 'error');
      }
      return;
    }
    const chatButton = event.target.closest('[data-chat-product]');
    if (chatButton) {
      productDialog.close();
      openChat();
      sendChat(`我想了解 ${state.currentProduct.name}`);
    }
  });

  const checkoutDialog = $('#checkout-dialog');
  checkoutDialog.addEventListener('click', (event) => {
    if (event.target === checkoutDialog) checkoutDialog.close();
  });
  checkoutDialog.addEventListener('change', (event) => {
    if (event.target.id === 'invoice-needed') $('#invoice-fields').hidden = !event.target.checked;
  });
  checkoutDialog.addEventListener('submit', (event) => {
    event.preventDefault();
    if (event.target.id === 'checkout-form') submitOrder(event.target);
  });

  const trackingDialog = $('#tracking-dialog');
  trackingDialog.addEventListener('click', (event) => {
    if (event.target === trackingDialog) trackingDialog.close();
    if (event.target.closest('[data-close-tracking]')) trackingDialog.close();
  });
  trackingDialog.addEventListener('submit', (event) => {
    event.preventDefault();
    if (event.target.id === 'tracking-form') queryTracking(event.target);
  });

  const memberDialog = $('#member-dialog');
  memberDialog.addEventListener('click', (event) => {
    if (event.target === memberDialog) memberDialog.close();
    if (event.target.closest('[data-close-member]')) memberDialog.close();
  });

  const filterDialog = $('#mobile-filter-dialog');
  filterDialog.addEventListener('click', (event) => {
    if (event.target === filterDialog) filterDialog.close();
  });

  const successDialog = $('#success-dialog');
  successDialog.addEventListener('click', (event) => {
    if (event.target === successDialog) successDialog.close();
  });

  $('#chat-launcher').addEventListener('click', openChat);
  $('#hero-service-button').addEventListener('click', openChat);
  $('#footer-chat-button').addEventListener('click', openChat);
  $('#chat-close').addEventListener('click', closeChat);
  $('#request-human').addEventListener('click', () => sendChat('人工客服'));
  $('#chat-form').addEventListener('submit', (event) => {
    event.preventDefault();
    sendChat($('#chat-input').value);
  });
  $('#chat-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      $('#chat-form').requestSubmit();
    }
  });
  $('#chat-panel').addEventListener('click', (event) => {
    const product = event.target.closest('[data-chat-open-product]');
    if (product) {
      closeChat();
      openProduct(product.dataset.chatOpenProduct);
    }
  });

  const quickActions = ['帮我推荐商品', '退换货政策', '查询订单', '人工客服'];
  $('#chat-quick-actions').innerHTML = quickActions.map((text) => `<button type="button" data-chat-quick="${text}">${text}</button>`).join('');
  $('#chat-quick-actions').addEventListener('click', (event) => {
    const quick = event.target.closest('[data-chat-quick]');
    if (quick) sendChat(quick.dataset.chatQuick);
  });

  $('#mobile-menu-button').addEventListener('click', openMobileNav);
  $('#newsletter-form').addEventListener('submit', (event) => {
    event.preventDefault();
    toast('订阅成功，新品与优惠将发送至您的邮箱', 'success');
    event.target.reset();
  });

  window.addEventListener('popstate', syncAdminWorkspaceFromUrl);
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('#admin-workspace').hidden) closeAdminWorkspace();
  });
}

async function init() {
  try {
    const [config, catalog] = await Promise.all([
      api('/api/config'),
      api('/api/products?pageSize=48&sort=recommended')
    ]);
    state.config = config;
    state.products = catalog.products;
    renderConfig();
    renderHero();
    renderSpotlight();
    renderFeatured();
    renderCart();
    bindEvents();
    await loadProducts();
    syncAdminWorkspaceFromUrl();
  } catch (error) {
    document.body.innerHTML = `<main class="page-shell" style="padding:80px 0"><h1>页面加载失败</h1><p>${escapeHtml(error.message)}</p><p>请确认 Node.js 服务已启动。</p></main>`;
  }
}

init();
