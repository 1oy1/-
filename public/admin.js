const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  user: null,
  view: 'dashboard',
  dashboard: null,
  products: [],
  orders: [],
  threads: [],
  config: null,
  orderFilter: 'all',
  orderSearch: '',
  productSearch: '',
  selectedThreadId: ''
};

const VIEW_TITLES = {
  dashboard: '经营仪表盘',
  products: '商品管理',
  orders: '订单管理',
  support: '客服中心',
  settings: '营销设置'
};

const ORDER_STATUS = {
  paid: '已付款',
  packed: '已出库',
  shipped: '运输中',
  delivered: '已签收',
  cancelled: '已取消',
  refunded: '已退款'
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function money(value) {
  return `¥${(Number(value) || 0).toLocaleString('zh-CN', { minimumFractionDigits: Number(value) % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

function formatTime(value, withDate = true) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('zh-CN', withDate ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false } : { hour: '2-digit', minute: '2-digit', hour12: false });
}

function imagePath(value) {
  return value && String(value).startsWith('/') ? value : '/images/placeholder.svg';
}

function toast(message, type = '') {
  const element = document.createElement('div');
  element.className = `admin-toast ${type}`.trim();
  element.textContent = message;
  $('#admin-toast-region').append(element);
  setTimeout(() => element.remove(), 2800);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `请求失败（${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function closeDialog() {
  const dialog = $('#admin-dialog');
  if (dialog.open) dialog.close();
}

async function initialize() {
  try {
    const [session, config] = await Promise.all([api('/api/admin/session'), api('/api/config')]);
    state.config = config;
    if (session.authenticated) {
      showApp(session.user);
      await navigate('dashboard');
    } else {
      showLogin();
    }
  } catch (error) {
    showLogin();
    $('#login-error').textContent = error.message;
  }
}

function showLogin() {
  $('#admin-loading').hidden = true;
  $('#admin-app').hidden = true;
  $('#login-screen').hidden = false;
  $('#admin-username').focus();
}

function showApp(user) {
  state.user = user;
  $('#admin-loading').hidden = true;
  $('#login-screen').hidden = true;
  $('#admin-app').hidden = false;
  $('#admin-user-name').textContent = user?.username || 'admin';
}

async function navigate(view) {
  if (!VIEW_TITLES[view]) return;
  state.view = view;
  $('#admin-page-title').textContent = VIEW_TITLES[view];
  $$('#admin-nav [data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  $('#admin-content').innerHTML = '<div class="empty-admin">正在加载...</div>';
  try {
    if (view === 'dashboard') await renderDashboard();
    if (view === 'products') await loadProductsView();
    if (view === 'orders') await loadOrdersView();
    if (view === 'support') await loadSupportView();
    if (view === 'settings') await loadSettingsView();
  } catch (error) {
    if (error.status === 401) {
      showLogin();
      return;
    }
    $('#admin-content').innerHTML = `<div class="empty-admin"><h2>加载失败</h2><p>${escapeHtml(error.message)}</p></div>`;
  }
}

function updateBadges() {
  const unreadOrders = state.orders.length
    ? state.orders.filter((order) => ['paid', 'packed'].includes(order.status)).length
    : (state.dashboard?.recentOrders || []).filter((order) => ['paid', 'packed'].includes(order.status)).length;
  const unreadSupport = state.threads.length
    ? state.threads.filter((thread) => Number(thread.unreadAdmin) > 0 || thread.status === 'waiting').length
    : Number(state.dashboard?.supportOpenCount || 0);
  $('#order-menu-badge').textContent = unreadOrders || '';
  $('#order-menu-badge').classList.toggle('visible', unreadOrders > 0);
  $('#support-menu-badge').textContent = unreadSupport || '';
  $('#support-menu-badge').classList.toggle('visible', unreadSupport > 0);
}

async function renderDashboard() {
  const data = await api('/api/admin/dashboard');
  state.dashboard = data;
  updateBadges();
  const maxSales = Math.max(...data.salesByDay.map((item) => item.total), 1);
  $('#admin-content').innerHTML = `
    <section class="metric-grid">
      <article class="metric-card"><span class="metric-icon"><svg><use href="#icon-trend"></use></svg></span><div><strong>${money(data.revenue)}</strong><span>累计有效交易额</span><small>不含取消与退款订单</small></div></article>
      <article class="metric-card"><span class="metric-icon blue"><svg><use href="#icon-receipt"></use></svg></span><div><strong>${data.orderCount}</strong><span>累计订单</span><small>${data.validOrderCount} 笔有效订单</small></div></article>
      <article class="metric-card"><span class="metric-icon amber"><svg><use href="#icon-box"></use></svg></span><div><strong>${data.activeProductCount}</strong><span>在售商品</span><small>共 ${data.productCount} 个商品档案</small></div></article>
      <article class="metric-card"><span class="metric-icon red"><svg><use href="#icon-alert"></use></svg></span><div><strong>${data.lowStockCount}</strong><span>低库存版本</span><small>库存不高于 20 件</small></div></article>
    </section>
    <section class="dashboard-grid">
      <div class="admin-panel">
        <header class="panel-header"><h3>近 7 日销售额</h3><small>按订单创建日期统计</small></header>
        <div class="panel-body">
          <div class="sales-chart">
            ${data.salesByDay.map((item, index) => {
              const height = Math.max(4, Math.round(item.total / maxSales * 165));
              const date = new Date(`${item.date}T00:00:00`);
              return `<div class="sales-bar-item"><strong>${item.total ? money(item.total) : '0'}</strong><div class="sales-bar-wrap"><div class="sales-bar" style="height:${height}px;opacity:${0.68 + index * 0.04}"></div></div><span>${date.getMonth() + 1}/${date.getDate()}</span></div>`;
            }).join('')}
          </div>
        </div>
      </div>
      <div class="admin-panel">
        <header class="panel-header"><h3>库存预警</h3><small>${data.lowStockCount} 个版本需关注</small></header>
        <div class="panel-body">
          <div class="stack-list">
            ${data.lowStock.length ? data.lowStock.map((item) => `<div class="stack-item"><div><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.variantName)} · ${escapeHtml(item.sku)}</small></div><b>${item.stock}</b></div>`).join('') : '<div class="empty-admin">库存状态良好</div>'}
          </div>
        </div>
      </div>
    </section>
    <section class="admin-panel" style="margin-top:18px">
      <header class="panel-header"><h3>最近订单</h3><button class="admin-button" type="button" data-go-view="orders">查看全部</button></header>
      <div class="table-scroll">
        <table class="admin-table"><thead><tr><th>订单号</th><th>客户</th><th>商品</th><th>金额</th><th>状态</th><th>时间</th></tr></thead><tbody>
          ${data.recentOrders.map((order) => `<tr><td><strong>${escapeHtml(order.orderNo)}</strong></td><td>${escapeHtml(order.customer.name)}<br><small>${escapeHtml(order.customer.phone)}</small></td><td>${order.items.reduce((sum, item) => sum + item.qty, 0)} 件</td><td><strong>${money(order.total)}</strong></td><td><span class="status-pill ${escapeHtml(order.status)}">${escapeHtml(ORDER_STATUS[order.status] || order.status)}</span></td><td>${formatTime(order.createdAt)}</td></tr>`).join('')}
        </tbody></table>
      </div>
    </section>`;
}

async function loadProductsView() {
  const payload = await api('/api/admin/products');
  state.products = payload.products;
  renderProductsView();
}

function renderProductsView() {
  const query = state.productSearch.trim().toLowerCase();
  const products = state.products.filter((product) => !query || `${product.name} ${product.subtitle} ${product.id}`.toLowerCase().includes(query));
  $('#admin-content').innerHTML = `
    <div class="content-heading"><div><h2>商品与版本</h2><p>维护商品信息、价格、库存和上下架状态</p></div><div class="heading-actions"><button class="admin-button admin-button-primary" type="button" data-new-product><svg><use href="#icon-plus"></use></svg>新建商品</button></div></div>
    <section class="table-panel">
      <div class="admin-toolbar">
        <label class="admin-search"><svg><use href="#icon-search"></use></svg><input id="product-search" value="${escapeHtml(state.productSearch)}" placeholder="搜索商品名称或 ID"></label>
        <span class="spacer"></span>
        <span class="status-pill">${products.length} 个商品</span>
      </div>
      <div class="table-scroll">
        <table class="admin-table">
          <thead><tr><th>商品</th><th>分类</th><th>版本价格</th><th>总库存</th><th>销量</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            ${products.length ? products.map((product) => {
              const prices = product.variants.map((variant) => Number(variant.price));
              return `<tr>
                <td><div class="table-product"><img src="${imagePath(product.images?.[0])}" alt=""><div><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.id)} · ${product.variants.length} 个版本</small></div></div></td>
                <td>${escapeHtml(categoryName(product.category))}</td>
                <td>${money(Math.min(...prices))} - ${money(Math.max(...prices))}</td>
                <td><strong>${product.stock}</strong> 件</td>
                <td>${Number(product.sold).toLocaleString('zh-CN')}</td>
                <td><span class="status-pill ${product.status === 'draft' ? 'draft' : ''}">${product.status === 'draft' ? '已下架' : '在售'}</span></td>
                <td><div class="table-actions"><button class="table-action" type="button" data-edit-product="${escapeHtml(product.id)}" title="编辑商品"><svg><use href="#icon-edit"></use></svg></button><button class="table-action danger" type="button" data-delete-product="${escapeHtml(product.id)}" title="删除商品"><svg><use href="#icon-trash"></use></svg></button></div></td>
              </tr>`;
            }).join('') : '<tr><td colspan="7"><div class="empty-admin">没有找到商品</div></td></tr>'}
          </tbody>
        </table>
      </div>
    </section>`;
}

function categoryName(id) {
  return state.config?.categories.find((category) => category.id === id)?.name || id || '未分类';
}

function variantEditorRow(variant = {}) {
  return `<div class="variant-editor" data-variant-row data-variant-id="${escapeHtml(variant.id || '')}">
    <input data-field="name" value="${escapeHtml(variant.name || '')}" placeholder="版本名称" required>
    <input data-field="subtitle" value="${escapeHtml(variant.subtitle || '')}" placeholder="版本说明">
    <input data-field="price" type="number" min="1" step="0.01" value="${escapeHtml(variant.price || '')}" placeholder="售价" required>
    <input data-field="originalPrice" type="number" min="1" step="0.01" value="${escapeHtml(variant.originalPrice || '')}" placeholder="原价" required>
    <input data-field="stock" type="number" min="0" step="1" value="${escapeHtml(variant.stock ?? 0)}" placeholder="库存" required>
    <input data-field="sku" value="${escapeHtml(variant.sku || '')}" placeholder="SKU">
    <button type="button" data-remove-variant title="删除版本"><svg><use href="#icon-trash"></use></svg></button>
  </div>`;
}

async function openProductEditor(id = '') {
  if (!state.config) {
    const config = await api('/api/config');
    state.config = config;
  }
  const product = id ? state.products.find((item) => item.id === id) : null;
  const variants = product?.variants || [{ name: '标准版', subtitle: '基础配置', price: '', originalPrice: '', stock: 50, sku: '' }];
  const specsText = Object.entries(product?.specs || {}).map(([key, value]) => `${key}: ${value}`).join('\n');
  $('#admin-dialog-content').innerHTML = `
    <form class="dialog-shell" id="product-form">
      <header class="dialog-header"><div><h2>${product ? '编辑商品' : '新建商品'}</h2><p>版本价格、库存和 SKU 将用于前台结算与库存校验</p></div><button class="admin-icon-button" type="button" data-close-admin-dialog aria-label="关闭"><svg><use href="#icon-close"></use></svg></button></header>
      <div class="dialog-body">
        <input type="hidden" name="id" value="${escapeHtml(product?.id || '')}">
        <div class="product-form-grid">
          <div class="admin-field full"><label>商品名称</label><input name="name" value="${escapeHtml(product?.name || '')}" required placeholder="例如：星野 智能空气净化器 A3"></div>
          <div class="admin-field"><label>分类</label><select name="category">${state.config.categories.map((category) => `<option value="${escapeHtml(category.id)}" ${product?.category === category.id ? 'selected' : ''}>${escapeHtml(category.name)}</option>`).join('')}</select></div>
          <div class="admin-field"><label>角标</label><input name="badge" value="${escapeHtml(product?.badge || '')}" placeholder="例如：热销 TOP 1"></div>
          <div class="admin-field"><label>状态</label><select name="status"><option value="active" ${product?.status !== 'draft' ? 'selected' : ''}>在售</option><option value="draft" ${product?.status === 'draft' ? 'selected' : ''}>下架</option></select></div>
          <div class="admin-field full"><label>一句话卖点</label><input name="subtitle" value="${escapeHtml(product?.subtitle || '')}" required placeholder="用于商品卡片和详情副标题"></div>
          <div class="admin-field full"><label>商品图片路径，每行一个</label><textarea name="images" required placeholder="/images/example.jpg">${escapeHtml((product?.images || ['/images/placeholder.svg']).join('\n'))}</textarea></div>
          <div class="admin-field full"><label>商品说明</label><textarea name="description" required>${escapeHtml(product?.description || '')}</textarea></div>
          <div class="admin-field"><label>评分（0-5）</label><input name="rating" type="number" min="0" max="5" step="0.1" value="${escapeHtml(product?.rating ?? 4.8)}"></div>
          <div class="admin-field"><label>评价数</label><input name="reviews" type="number" min="0" step="1" value="${escapeHtml(product?.reviews ?? 0)}"></div>
          <div class="admin-field"><label>销量</label><input name="sold" type="number" min="0" step="1" value="${escapeHtml(product?.sold ?? 0)}"></div>
          <div class="admin-field full"><label>功能亮点，每行一个</label><textarea name="features">${escapeHtml((product?.features || []).join('\n'))}</textarea></div>
          <div class="admin-field full"><label>核心参数，每行“参数: 值”</label><textarea name="specs" placeholder="吸力: 5500Pa">${escapeHtml(specsText)}</textarea></div>
          <div class="admin-field full"><label>售后保障</label><input name="warranty" value="${escapeHtml(product?.warranty || '整机 1 年')}"></div>
        </div>
        <div class="variant-heading"><h3>商品版本</h3><button class="admin-button" type="button" id="add-variant"><svg><use href="#icon-plus"></use></svg>添加版本</button></div>
        <div id="variant-list">${variants.map(variantEditorRow).join('')}</div>
      </div>
      <footer class="dialog-footer"><button class="admin-button" type="button" data-close-admin-dialog>取消</button><button class="admin-button admin-button-primary" type="submit">保存商品</button></footer>
    </form>`;
  $('#admin-dialog').showModal();
}

async function saveProduct(form) {
  const formData = new FormData(form);
  const variants = $$('[data-variant-row]', form).map((row) => ({
    id: row.dataset.variantId || undefined,
    name: $('[data-field="name"]', row).value,
    subtitle: $('[data-field="subtitle"]', row).value,
    price: Number($('[data-field="price"]', row).value),
    originalPrice: Number($('[data-field="originalPrice"]', row).value),
    stock: Number($('[data-field="stock"]', row).value),
    sku: $('[data-field="sku"]', row).value
  }));
  const specs = Object.fromEntries(
    String(formData.get('specs') || '').split('\n').map((line) => line.split(/[:：]/, 2)).filter((parts) => parts.length === 2 && parts[0].trim()).map(([key, value]) => [key.trim(), value.trim()])
  );
  const payload = {
    id: formData.get('id'),
    name: formData.get('name'),
    subtitle: formData.get('subtitle'),
    category: formData.get('category'),
    badge: formData.get('badge'),
    status: formData.get('status'),
    images: String(formData.get('images') || '').split('\n').map((item) => item.trim()).filter(Boolean),
    description: formData.get('description'),
    rating: Number(formData.get('rating')),
    reviews: Number(formData.get('reviews')),
    sold: Number(formData.get('sold')),
    features: String(formData.get('features') || '').split('\n').map((item) => item.trim()).filter(Boolean),
    specs,
    warranty: formData.get('warranty'),
    variants
  };
  const button = $('[type="submit"]', form);
  button.disabled = true;
  button.textContent = '正在保存...';
  try {
    if (payload.id) await api(`/api/admin/products/${encodeURIComponent(payload.id)}`, { method: 'PUT', body: JSON.stringify(payload) });
    else await api('/api/admin/products', { method: 'POST', body: JSON.stringify(payload) });
    closeDialog();
    toast('商品已保存', 'success');
    await loadProductsView();
  } catch (error) {
    toast(error.message, 'error');
    button.disabled = false;
    button.textContent = '保存商品';
  }
}

async function deleteProduct(id) {
  const product = state.products.find((item) => item.id === id);
  if (!product || !confirm(`确定删除「${product.name}」吗？该操作不会删除历史订单。`)) return;
  try {
    await api(`/api/admin/products/${encodeURIComponent(id)}`, { method: 'DELETE' });
    toast('商品已删除', 'success');
    await loadProductsView();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function loadOrdersView() {
  const payload = await api('/api/admin/orders');
  state.orders = payload.orders;
  updateBadges();
  renderOrdersView();
}

function renderOrdersView() {
  const query = state.orderSearch.trim().toLowerCase();
  const orders = state.orders.filter((order) => {
    const statusMatch = state.orderFilter === 'all' || order.status === state.orderFilter;
    const queryMatch = !query || `${order.orderNo} ${order.customer.name} ${order.customer.phone}`.toLowerCase().includes(query);
    return statusMatch && queryMatch;
  });
  $('#admin-content').innerHTML = `
    <div class="content-heading"><div><h2>订单处理</h2><p>查看收货信息、商品明细并推进订单状态</p></div><div class="heading-actions"><span class="status-pill paid">${state.orders.filter((order) => order.status === 'paid').length} 笔待出库</span></div></div>
    <section class="table-panel">
      <div class="admin-toolbar">
        <label class="admin-search"><svg><use href="#icon-search"></use></svg><input id="order-search" value="${escapeHtml(state.orderSearch)}" placeholder="搜索订单号、客户或手机号"></label>
        <select id="order-status-filter">
          <option value="all" ${state.orderFilter === 'all' ? 'selected' : ''}>全部状态</option>
          ${Object.entries(ORDER_STATUS).map(([value, label]) => `<option value="${value}" ${state.orderFilter === value ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
        <span class="spacer"></span><span class="status-pill">${orders.length} 笔订单</span>
      </div>
      <div class="table-scroll">
        <table class="admin-table">
          <thead><tr><th>订单号</th><th>客户</th><th>商品</th><th>实付</th><th>支付</th><th>状态</th><th>下单时间</th><th>操作</th></tr></thead>
          <tbody>
            ${orders.length ? orders.map((order) => `<tr>
              <td><strong>${escapeHtml(order.orderNo)}</strong><br><small>${order.trackingNo ? escapeHtml(order.trackingNo) : '暂无运单'}</small></td>
              <td>${escapeHtml(order.customer.name)}<br><small>${escapeHtml(order.customer.phone)}</small></td>
              <td>${order.items.reduce((sum, item) => sum + item.qty, 0)} 件<br><small>${escapeHtml(order.items[0]?.name || '')}</small></td>
              <td><strong>${money(order.total)}</strong></td>
              <td>${{ wechat: '微信', alipay: '支付宝', unionpay: '云闪付', cod: '货到付款' }[order.paymentMethod] || order.paymentMethod}</td>
              <td><select class="order-status-select" data-quick-status="${escapeHtml(order.id)}">${Object.entries(ORDER_STATUS).map(([value, label]) => `<option value="${value}" ${order.status === value ? 'selected' : ''}>${label}</option>`).join('')}</select></td>
              <td>${formatTime(order.createdAt)}</td>
              <td><div class="table-actions"><button class="table-action" type="button" data-view-order="${escapeHtml(order.id)}" title="查看订单"><svg><use href="#icon-edit"></use></svg></button></div></td>
            </tr>`).join('') : '<tr><td colspan="8"><div class="empty-admin">没有符合筛选条件的订单</div></td></tr>'}
          </tbody>
        </table>
      </div>
    </section>`;
}

function openOrderDetail(id) {
  const order = state.orders.find((item) => item.id === id);
  if (!order) return;
  $('#admin-dialog-content').innerHTML = `
    <div class="dialog-shell">
      <header class="dialog-header"><div><h2>订单 ${escapeHtml(order.orderNo)}</h2><p>创建于 ${formatTime(order.createdAt)} · ${escapeHtml(ORDER_STATUS[order.status] || order.status)}</p></div><button class="admin-icon-button" type="button" data-close-admin-dialog aria-label="关闭"><svg><use href="#icon-close"></use></svg></button></header>
      <div class="dialog-body">
        <div class="order-detail-grid">
          <div>
            <div class="detail-block">
              <h3>收货信息</h3>
              <p><strong>${escapeHtml(order.customer.name)}</strong> · ${escapeHtml(order.customer.phone)}</p>
              <p>${escapeHtml(order.address.province)}${escapeHtml(order.address.city)}${escapeHtml(order.address.district)} ${escapeHtml(order.address.detail)}</p>
              ${order.customerNote ? `<p>备注：${escapeHtml(order.customerNote)}</p>` : ''}
            </div>
            <div class="detail-block" style="margin-top:14px">
              <h3>商品明细</h3>
              <div class="order-items">
                ${order.items.map((item) => `<div class="order-item"><img src="${imagePath(item.image)}" alt=""><p>${escapeHtml(item.name)}<span>${escapeHtml(item.variantName)} · ${money(item.price)} × ${item.qty}</span></p><strong>${money(item.price * item.qty)}</strong></div>`).join('')}
              </div>
            </div>
          </div>
          <div>
            <div class="detail-block">
              <h3>物流与状态</h3>
              <div class="admin-field"><label>订单状态</label><select id="order-detail-status">${Object.entries(ORDER_STATUS).map(([value, label]) => `<option value="${value}" ${order.status === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
              <div class="admin-field" style="margin-top:10px"><label>承运公司</label><input id="order-shipping-company" value="${escapeHtml(order.shippingCompany || '')}" placeholder="例如：顺丰速运"></div>
              <div class="admin-field" style="margin-top:10px"><label>运单号</label><input id="order-tracking-no" value="${escapeHtml(order.trackingNo || '')}" placeholder="填写快递运单号"></div>
              <div class="admin-field" style="margin-top:10px"><label>状态备注</label><textarea id="order-status-note" placeholder="可选，会写入订单时间线"></textarea></div>
              <button class="admin-button admin-button-primary admin-button-wide" type="button" data-save-order="${escapeHtml(order.id)}" style="margin-top:12px"><svg><use href="#icon-check"></use></svg>保存订单状态</button>
            </div>
            <div class="detail-block" style="margin-top:14px">
              <h3>金额与发票</h3>
              <p>商品小计：<strong>${money(order.subtotal)}</strong></p>
              <p>优惠：<strong>-${money(order.discount)}</strong></p>
              <p>运费：<strong>${money(order.shipping)}</strong></p>
              <p>实付：<strong>${money(order.total)}</strong></p>
              <p>发票：<strong>${order.invoice.needed ? `${order.invoice.type === 'company' ? '企业发票' : '个人发票'} · ${escapeHtml(order.invoice.title || '')}` : '不需要'}</strong></p>
            </div>
            <div class="detail-block" style="margin-top:14px">
              <h3>状态时间线</h3>
              <div class="status-history">${order.statusHistory.slice().reverse().map((entry) => `<div><strong>${escapeHtml(entry.label)}</strong><small>${formatTime(entry.at)} · ${escapeHtml(entry.note)}</small></div>`).join('')}</div>
            </div>
          </div>
        </div>
      </div>
      <footer class="dialog-footer"><button class="admin-button" type="button" data-close-admin-dialog>关闭</button></footer>
    </div>`;
  $('#admin-dialog').showModal();
}

async function updateOrder(id, payload) {
  try {
    await api(`/api/admin/orders/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(payload) });
    toast('订单状态已更新', 'success');
    await loadOrdersView();
    return true;
  } catch (error) {
    toast(error.message, 'error');
    return false;
  }
}

async function loadSupportView() {
  const payload = await api('/api/admin/support');
  state.threads = payload.threads;
  if (!state.selectedThreadId && state.threads.length) state.selectedThreadId = state.threads[0].id;
  updateBadges();
  const selected = state.threads.find((thread) => thread.id === state.selectedThreadId);
  if (selected?.unreadAdmin) {
    try {
      await api(`/api/admin/support/${encodeURIComponent(selected.id)}/read`, { method: 'PUT', body: '{}' });
      selected.unreadAdmin = 0;
      updateBadges();
    } catch {
      // 阅读状态失败不阻塞会话查看。
    }
  }
  renderSupportView();
}

function renderSupportView() {
  const selected = state.threads.find((thread) => thread.id === state.selectedThreadId) || state.threads[0] || null;
  if (selected) state.selectedThreadId = selected.id;
  $('#admin-content').innerHTML = `
    <div class="content-heading"><div><h2>虚拟客服会话</h2><p>查看智能客服对话，转人工后可在这里直接回复</p></div><div class="heading-actions"><span class="status-pill waiting">${state.threads.filter((thread) => thread.status === 'waiting').length} 个待人工回复</span></div></div>
    <section class="support-layout">
      <div class="thread-list">
        <header class="thread-list-header"><h3>会话列表 <small>(${state.threads.length})</small></h3></header>
        ${state.threads.length ? state.threads.map((thread) => {
          const last = thread.messages.at(-1);
          return `<button class="thread-item ${thread.id === selected?.id ? 'active' : ''}" type="button" data-select-thread="${escapeHtml(thread.id)}">
            <div class="thread-item-top"><strong>访客 ${escapeHtml(thread.sessionId.slice(-6))}</strong>${thread.unreadAdmin ? `<span class="thread-unread">${thread.unreadAdmin}</span>` : ''}</div>
            <p>${escapeHtml(last?.text || '暂无消息')}</p>
            <time>${formatTime(thread.updatedAt)}</time>
          </button>`;
        }).join('') : '<div class="empty-admin">暂无客服会话</div>'}
      </div>
      <div class="conversation">
        ${selected ? `
          <header class="conversation-header"><div><h3>访客 ${escapeHtml(selected.sessionId.slice(-6))}</h3><small>创建于 ${formatTime(selected.createdAt)} · 状态：${selected.status === 'resolved' ? '已解决' : selected.status === 'waiting' ? '等待人工' : '进行中'}</small></div><span class="status-pill ${escapeHtml(selected.status)}">${selected.status === 'resolved' ? '已解决' : selected.status === 'waiting' ? '待人工' : '进行中'}</span></header>
          <div class="conversation-messages">
            ${selected.messages.map((message) => `<div class="admin-message ${message.sender === 'user' ? 'user' : 'bot'}"><div class="admin-message-bubble">${escapeHtml(message.text)}</div><small>${message.sender === 'user' ? '访客' : message.sender === 'human' ? '人工客服' : '智能客服'} · ${formatTime(message.at, false)}</small></div>`).join('')}
          </div>
          <form class="reply-form" id="support-reply-form"><textarea name="message" required maxlength="1200" placeholder="输入人工客服回复..."></textarea><button class="admin-button admin-button-primary" type="submit">发送回复</button></form>
          <div class="conversation-actions"><button class="admin-button" type="button" data-thread-status="open">标记进行中</button><button class="admin-button" type="button" data-thread-status="waiting">等待人工</button><button class="admin-button" type="button" data-thread-status="resolved">标记已解决</button></div>
        ` : '<div class="empty-admin">选择一个会话查看消息</div>'}
      </div>
    </section>`;
}

async function replyToThread(form) {
  const selected = state.threads.find((thread) => thread.id === state.selectedThreadId);
  if (!selected) return;
  const message = new FormData(form).get('message');
  try {
    await api(`/api/admin/support/${encodeURIComponent(selected.id)}/reply`, { method: 'POST', body: JSON.stringify({ message }) });
    toast('回复已发送', 'success');
    await loadSupportView();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function setThreadStatus(status) {
  const selected = state.threads.find((thread) => thread.id === state.selectedThreadId);
  if (!selected) return;
  try {
    await api(`/api/admin/support/${encodeURIComponent(selected.id)}/status`, { method: 'PUT', body: JSON.stringify({ status }) });
    toast('会话状态已更新', 'success');
    await loadSupportView();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function loadSettingsView() {
  state.config = await api('/api/config');
  renderSettingsView();
}

function couponEditor(coupon = {}) {
  return `<div class="coupon-editor" data-coupon-row>
    <input data-field="code" value="${escapeHtml(coupon.code || '')}" placeholder="优惠码">
    <input data-field="title" value="${escapeHtml(coupon.title || '')}" placeholder="活动名称">
    <select data-field="type"><option value="fixed" ${coupon.type !== 'shipping' ? 'selected' : ''}>固定金额</option><option value="shipping" ${coupon.type === 'shipping' ? 'selected' : ''}>免运费</option></select>
    <input data-field="value" type="number" min="0" value="${escapeHtml(coupon.value ?? 0)}" placeholder="优惠金额">
    <input data-field="minSpend" type="number" min="0" value="${escapeHtml(coupon.minSpend ?? 0)}" placeholder="使用门槛">
    <button type="button" data-remove-coupon title="删除优惠券"><svg><use href="#icon-trash"></use></svg></button>
  </div>`;
}

function renderSettingsView() {
  const settings = state.config.settings;
  $('#admin-content').innerHTML = `
    <div class="content-heading"><div><h2>店铺与营销设置</h2><p>变更会在下一次门店请求时生效</p></div></div>
    <form id="settings-form">
      <div class="settings-grid">
        <section class="admin-panel">
          <header class="panel-header"><h3>基础信息</h3><small>门店公告与客服说明</small></header>
          <div class="panel-body">
            <div class="settings-form">
              <div class="admin-field"><label>店铺名称</label><input name="storeName" value="${escapeHtml(settings.storeName)}" required></div>
              <div class="admin-field"><label>店铺标语</label><input name="slogan" value="${escapeHtml(settings.slogan)}" required></div>
              <div class="admin-field full"><label>顶部公告</label><input name="announcement" value="${escapeHtml(settings.announcement)}" required></div>
              <div class="admin-field"><label>包邮门槛（元）</label><input name="freeShippingThreshold" type="number" min="0" value="${escapeHtml(settings.freeShippingThreshold)}"></div>
              <div class="admin-field"><label>客服在线时间</label><input name="supportHours" value="${escapeHtml(settings.supportHours)}"></div>
              <div class="admin-field full"><label>客服欢迎语</label><textarea name="supportWelcome">${escapeHtml(settings.supportWelcome)}</textarea></div>
            </div>
          </div>
        </section>
        <section class="admin-panel">
          <header class="panel-header"><h3>优惠券</h3><button class="admin-button" type="button" id="add-coupon"><svg><use href="#icon-plus"></use></svg>新增</button></header>
          <div class="panel-body"><div class="coupon-list" id="coupon-list">${settings.coupons.map(couponEditor).join('')}</div></div>
        </section>
      </div>
      <div style="display:flex;justify-content:flex-end;margin-top:18px"><button class="admin-button admin-button-primary" type="submit"><svg><use href="#icon-check"></use></svg>保存设置</button></div>
    </form>`;
}

async function saveSettings(form) {
  const formData = new FormData(form);
  const coupons = $$('[data-coupon-row]', form).map((row) => ({
    code: $('[data-field="code"]', row).value,
    title: $('[data-field="title"]', row).value,
    type: $('[data-field="type"]', row).value,
    value: Number($('[data-field="value"]', row).value),
    minSpend: Number($('[data-field="minSpend"]', row).value),
    description: `订单满 ${Number($('[data-field="minSpend"]', row).value)} 元可用`,
    active: true
  }));
  const payload = {
    storeName: formData.get('storeName'),
    slogan: formData.get('slogan'),
    announcement: formData.get('announcement'),
    freeShippingThreshold: Number(formData.get('freeShippingThreshold')),
    supportHours: formData.get('supportHours'),
    supportWelcome: formData.get('supportWelcome'),
    coupons
  };
  const button = $('[type="submit"]', form);
  button.disabled = true;
  button.textContent = '正在保存...';
  try {
    state.config.settings = await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(payload) });
    toast('设置已保存', 'success');
    renderSettingsView();
  } catch (error) {
    toast(error.message, 'error');
    button.disabled = false;
    button.textContent = '保存设置';
  }
}

function bindEvents() {
  document.addEventListener('error', (event) => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || image.src.endsWith('/images/placeholder.svg')) return;
    image.src = '/images/placeholder.svg';
  }, true);

  $('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const button = $('button[type="submit"]', form);
    button.disabled = true;
    button.textContent = '正在登录...';
    $('#login-error').textContent = '';
    try {
      const session = await api('/api/admin/login', {
        method: 'POST',
        body: JSON.stringify({ username: form.username.value, password: form.password.value })
      });
      showApp(session.user);
      await navigate('dashboard');
    } catch (error) {
      $('#login-error').textContent = error.message;
      button.disabled = false;
      button.textContent = '登录后台';
    }
  });

  $('#demo-login').addEventListener('click', () => {
    $('#admin-username').value = 'admin';
    $('#admin-password').value = 'admin123';
  });

  $('#logout-button').addEventListener('click', async () => {
    try {
      await api('/api/admin/logout', { method: 'POST', body: '{}' });
    } catch {
      // Always clear the local admin view.
    }
    state.user = null;
    showLogin();
  });

  $('#admin-nav').addEventListener('click', (event) => {
    const button = event.target.closest('[data-view]');
    if (button) navigate(button.dataset.view);
  });

  $('#refresh-button').addEventListener('click', () => navigate(state.view));

  document.addEventListener('click', async (event) => {
    if (event.target.closest('[data-close-admin-dialog]')) closeDialog();
    const goView = event.target.closest('[data-go-view]');
    if (goView) {
      navigate(goView.dataset.goView);
      return;
    }
    if (event.target.closest('[data-new-product]')) {
      openProductEditor();
      return;
    }
    const editProduct = event.target.closest('[data-edit-product]');
    if (editProduct) {
      openProductEditor(editProduct.dataset.editProduct);
      return;
    }
    const deleteButton = event.target.closest('[data-delete-product]');
    if (deleteButton) {
      await deleteProduct(deleteButton.dataset.deleteProduct);
      return;
    }
    const removeVariant = event.target.closest('[data-remove-variant]');
    if (removeVariant) {
      const rows = $$('[data-variant-row]');
      if (rows.length <= 1) {
        toast('至少保留一个商品版本', 'error');
        return;
      }
      removeVariant.closest('[data-variant-row]').remove();
      return;
    }
    if (event.target.closest('#add-variant')) {
      $('#variant-list').insertAdjacentHTML('beforeend', variantEditorRow());
      return;
    }
    const orderButton = event.target.closest('[data-view-order]');
    if (orderButton) {
      openOrderDetail(orderButton.dataset.viewOrder);
      return;
    }
    const saveOrder = event.target.closest('[data-save-order]');
    if (saveOrder) {
      const saved = await updateOrder(saveOrder.dataset.saveOrder, {
        status: $('#order-detail-status').value,
        shippingCompany: $('#order-shipping-company').value,
        trackingNo: $('#order-tracking-no').value,
        note: $('#order-status-note').value
      });
      if (saved) closeDialog();
      return;
    }
    const thread = event.target.closest('[data-select-thread]');
    if (thread) {
      state.selectedThreadId = thread.dataset.selectThread;
      try {
        await api(`/api/admin/support/${encodeURIComponent(state.selectedThreadId)}/read`, { method: 'PUT', body: '{}' });
        const selected = state.threads.find((item) => item.id === state.selectedThreadId);
        if (selected) selected.unreadAdmin = 0;
        updateBadges();
      } catch {
        // 阅读状态失败不阻塞会话查看。
      }
      renderSupportView();
      return;
    }
    const threadStatus = event.target.closest('[data-thread-status]');
    if (threadStatus) {
      await setThreadStatus(threadStatus.dataset.threadStatus);
      return;
    }
    if (event.target.closest('#add-coupon')) {
      $('#coupon-list').insertAdjacentHTML('beforeend', couponEditor());
      return;
    }
    const removeCoupon = event.target.closest('[data-remove-coupon]');
    if (removeCoupon) {
      removeCoupon.closest('[data-coupon-row]').remove();
    }
  });

  document.addEventListener('input', (event) => {
    if (event.target.id === 'product-search') {
      state.productSearch = event.target.value;
      renderProductsView();
      const input = $('#product-search');
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
    if (event.target.id === 'order-search') {
      state.orderSearch = event.target.value;
      renderOrdersView();
      const input = $('#order-search');
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  });

  document.addEventListener('change', async (event) => {
    if (event.target.id === 'order-status-filter') {
      state.orderFilter = event.target.value;
      renderOrdersView();
    }
    const quickStatus = event.target.closest('[data-quick-status]');
    if (quickStatus) {
      const order = state.orders.find((item) => item.id === quickStatus.dataset.quickStatus);
      if (order && event.target.value !== order.status) await updateOrder(order.id, { status: event.target.value });
    }
  });

  document.addEventListener('submit', async (event) => {
    if (event.target.id === 'product-form') {
      event.preventDefault();
      await saveProduct(event.target);
      return;
    }
    if (event.target.id === 'support-reply-form') {
      event.preventDefault();
      await replyToThread(event.target);
      return;
    }
    if (event.target.id === 'settings-form') {
      event.preventDefault();
      await saveSettings(event.target);
    }
  });

  $('#admin-dialog').addEventListener('click', (event) => {
    if (event.target === $('#admin-dialog')) closeDialog();
  });
}

bindEvents();
initialize();
