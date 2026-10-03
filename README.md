# 星野智家电子商务系统

一个可直接运行的零依赖全栈电商演示系统，主营智能清洁、空气管理、智能照明、咖啡电器、影音和家庭安全设备。

## 功能

- 商品分类、搜索、价格区间、库存和评分筛选
- 商品多版本 SKU、不同版本独立价格、库存、规格与销量
- 购物车、优惠券、包邮门槛、结算、订单生成与物流查询
- 订单状态时间线、发票信息、收货地址与售后提示
- 规则型虚拟客服，可回答商品推荐、价格、物流、退换货和保修问题
- 后台仪表盘、商品增删改查、订单处理、库存预警、客服会话和营销设置
- JSON 文件持久化、HttpOnly 后台会话 Cookie、同源写操作校验
- 桌面端与移动端响应式界面
- Node.js 内置测试和 API 集成测试，无第三方生产依赖

## 运行

需要 Node.js 20 或更高版本。

```bash
npm start
```

浏览器访问 `http://localhost:3000`。后台地址为 `http://localhost:3000/admin.html`。

默认后台演示账号：

- 用户名：`admin`
- 密码：`admin123`

生产环境请通过环境变量设置 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD`，并放在反向代理与 HTTPS 之后。

## 测试

```bash
npm run check
npm test
```

测试使用临时数据文件，不会修改正式数据。

## 数据与重置

业务数据保存在 `data/db.json`。如需初始状态，停止服务后删除运行期间生成的数据或从 Git 恢复该文件。图片素材位于 `public/images`，来源见 `public/images/SOURCES.md`。

## 目录

```text
server.mjs          HTTP 服务与 API 路由
lib/store.mjs       数据校验、库存、订单、统计逻辑
lib/support.mjs     虚拟客服规则与商品推荐
public/             商店与管理后台前端
data/db.json        商品、订单、设置与客服消息
test/               Node.js 集成测试
```

## 安全说明

当前版本定位为可部署的电商系统演示。正式商用前应接入支付网关、短信或邮箱验证、对象存储、数据库、审计日志、限流和合规的隐私政策。后台 Cookie 默认 `HttpOnly`、`SameSite=Strict`，但在 HTTPS 环境部署时应额外设置 `Secure`。
