const CATEGORY_KEYWORDS = {
  cleaning: ['扫地', '扫拖', '清洁', '吸尘', '拖地', '洗地', '宠物毛', '灰尘'],
  air: ['空气', '净化', '除甲醛', '甲醛', '加湿', '过敏', '雾霾', '异味', '干燥'],
  light: ['台灯', '灯', '照明', '护眼', '阅读', '房间暗', '全光谱'],
  coffee: ['咖啡', '咖啡机', '拿铁', '美式', '磨豆', '奶泡'],
  entertainment: ['投影', '音箱', '音乐', '电影', '投屏', '音响', '投影仪'],
  security: ['门锁', '摄像头', '监控', '安全', '防盗', '门铃', '看家']
};

function clean(value) {
  return String(value || '').trim();
}

function minPrice(product) {
  return Math.min(...product.variants.map((variant) => Number(variant.price)));
}

function highestRating(products) {
  return products.slice().sort((a, b) => b.rating - a.rating || b.sold - a.sold)[0];
}

function bestValue(products) {
  return products.slice().sort((a, b) => b.sold / (1 + minPrice(b) / 1000) - a.sold / (1 + minPrice(a) / 1000))[0];
}

function recommendForCategory(category, products, budget) {
  let candidates = products.filter((product) => product.category === category && product.status === 'active');
  if (budget) candidates = candidates.filter((product) => minPrice(product) <= budget);
  if (!candidates.length) return null;
  const cheapest = candidates.slice().sort((a, b) => minPrice(a) - minPrice(b))[0];
  const popular = candidates.slice().sort((a, b) => b.sold - a.sold)[0];
  return {
    candidates,
    cheapest,
    popular,
    recommended: budget ? cheapest : popular
  };
}

function orderStatusReply(order) {
  if (!order) return null;
  const statusText = {
    paid: '已付款，仓库正在备货',
    packed: '已出库，等待快递揽收',
    shipped: '运输中',
    delivered: '已签收',
    cancelled: '已取消',
    refunded: '已退款'
  }[order.status] || order.status;
  const logistics = order.trackingNo ? `承运方为${order.shippingCompany || '快递公司'}，运单号 ${order.trackingNo}。` : '目前还没有物流单号。';
  return `订单 ${order.orderNo} 当前状态：${statusText}。${logistics} 如需修改收货时间，请提供订单尾号和新的收货时间。`;
}

export function generateSupportReply(message, context = {}) {
  const text = clean(message);
  const lower = text.toLocaleLowerCase('zh-CN');
  const products = Array.isArray(context.products) ? context.products : [];
  const settings = context.settings || {};
  const order = context.order || null;

  if (!text) {
    return { text: '请告诉我您想咨询的商品或订单问题。', productIds: [] };
  }

  if (/人工|真人|转客服|客服人工/.test(lower)) {
    return {
      text: '已为您转接人工客服。当前在线时段为 ' + (settings.supportHours || '每天 09:00 - 22:00') + '，客服会在这里直接回复您；非在线时段请留言并附上订单号和问题。',
      productIds: [],
      escalate: true
    };
  }

  const orderMatch = text.toUpperCase().match(/XY\d{12,16}/);
  if (orderMatch) {
    const reply = orderStatusReply(order);
    return {
      text: reply || `没有查询到订单 ${orderMatch[0]}。请核对订单号，或提供下单手机号后四位，转人工客服继续查询。`,
      productIds: []
    };
  }

  if (/物流|快递|发货|到哪|多久到|几天能到|配送/.test(lower)) {
    return {
      text: settings.logisticsNote || '现货商品通常在付款后 24 小时内出库，标准快递约 2-4 天送达，偏远地区会增加 1-3 天。发送完整订单号可直接查询进度。',
      productIds: []
    };
  }

  if (/退货|退款|换货|七天|7天|无理由/.test(lower)) {
    return {
      text: settings.returnPolicy || '签收后 7 天内商品及包装保持完好可申请无理由退换；质量问题由平台承担往返运费。',
      productIds: []
    };
  }

  if (/保修|质保|维修|坏了|故障/.test(lower)) {
    return {
      text: '不同商品的保修期不同：清洁和咖啡类通常整机 1 年、核心电机 2 年；灯具与音箱整机 2 年；智能门锁整机 3 年。您可以在商品详情页的「售后保障」中查看准确说明。',
      productIds: []
    };
  }

  if (/发票|开票|专票|普票/.test(lower)) {
    return {
      text: '结算页支持个人电子普票和企业发票。企业专票需要填写完整抬头和税号，订单完成后会发送到预留邮箱。',
      productIds: []
    };
  }

  if (/优惠券|优惠码|折扣|新客|促销|活动/.test(lower)) {
    const couponText = (settings.coupons || [])
      .filter((coupon) => coupon.active)
      .map((coupon) => `${coupon.code}（${coupon.description}）`)
      .join('、');
    return {
      text: `当前可用优惠：${couponText || '请关注店铺活动页'}。每笔订单默认只能使用一张优惠券，满足门槛后会自动计算。`,
      productIds: []
    };
  }

  if (/推荐|买什么|哪款|选择|纠结|预算/.test(lower)) {
    const budgetMatch = lower.match(/(\d{3,5})\s*(元|块)?/);
    const budget = budgetMatch ? Number(budgetMatch[1]) : 0;
    for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
      if (keywords.some((keyword) => lower.includes(keyword))) {
        const result = recommendForCategory(category, products, budget);
        if (result) {
          const recommended = result.recommended;
          const price = minPrice(recommended);
          return {
            text: `按您的需求，我更推荐「${recommended.name}」。${recommended.subtitle}，最低 ${price.toLocaleString('zh-CN')} 元起。${budget ? '它是在您预算内销量和口碑较均衡的选择。' : '它的销量与评分都比较稳定，可以打开商品卡片查看各版本差异。'}`,
            productIds: [recommended.id].filter(Boolean)
          };
        }
      }
    }
    const fallback = highestRating(products);
    return {
      text: fallback ? `可以先告诉我使用场景和预算，例如“小户型清洁”“卧室加湿”或“3000 元内咖啡机”。目前全店口碑最高的是「${fallback.name}」。` : '请告诉我使用场景、房间面积和预算，我会给出具体版本建议。',
      productIds: fallback ? [fallback.id] : []
    };
  }

  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((keyword) => lower.includes(keyword))) {
      const result = recommendForCategory(category, products);
      if (result) {
        const a = result.popular;
        const b = bestValue(result.candidates);
        const productIds = [...new Set([a?.id, b?.id].filter(Boolean))];
        return {
          text: `这个场景可以看「${a.name}」和「${b.name}」。前者销量更靠前，后者价格更适合作为入门款。两款都有不同版本，主要差异是自动化程度、耗材维护和核心性能。`,
          productIds
        };
      }
    }
  }

  if (/你好|您好|在吗|hello|hi|咨询/.test(lower)) {
    return { text: settings.supportWelcome || '您好，我可以帮您选商品、查订单、说明物流和售后。', productIds: [] };
  }

  if (/价格|多少钱|便宜|贵|预算/.test(lower)) {
    const cheapest = products.slice().sort((a, b) => minPrice(a) - minPrice(b))[0];
    return {
      text: `全店价格从 ${cheapest ? minPrice(cheapest).toLocaleString('zh-CN') : '299'} 元起。页面展示的是各版本最低到手价，实际结算会按所选版本、优惠券和发票信息计算。`,
      productIds: cheapest ? [cheapest.id] : []
    };
  }

  return {
    text: '我暂时没有完全理解这个问题。您可以换一种说法，或者发送“人工客服”，我会把会话转给在线客服继续处理。',
    productIds: []
  };
}
