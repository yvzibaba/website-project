# 部署一份可发给陌生人的测试网址（DEPLOY_TEST_ENV_V1_1）

> 配套 `docs/REAL_USER_VALIDATION_V1_1.md`。目的：拿到**一个公网 https 网址**，让 §3 脚本能真正发给
> 8–12 名真实用户跑。这是"真实用户测试"唯一的硬前置——当前产品只在 localhost，陌生人打不开。
>
> 本文是**运维部署 runbook**，不改任何产品代码、模型、财务口径、数据库结构。经济/技术/参数版本与
> 黄金样本照旧冻结。生产部署与密钥录入属创始人裁决项（见文末"只有你能做的"）。
>
> 状态核对（2026-09-16）：v0.73.0；`npm run build` 干净通过，路由表完整，
> `/`（首页）、`/workbench`、`/enterprise` 为静态预渲染（○），可直接公网分发、成本低。

---

## 0. 一页速览（最短路径）

1. 用 **Vercel**（原生支持 Next.js 16 + 免费额度 + 自动 preview URL）导入 `github.com/yvzibaba/website-project`。
2. 建一个**独立的 Neon 测试库分支**（不要用主库），拿它的 **pooled** 连接串。
3. 在 Vercel 环境变量里填 §3 的清单（**尤其 `NEXT_PUBLIC_SITE_URL`**）。
4. 部署 → 拿到 `https://xxx.vercel.app` → 用它跑 §1 的部署后验收 → 把该网址发给真实用户。

---

## 1. 为什么先解决网址，而不是别的

`REAL_USER_VALIDATION_V1_1.md` §3 要求"只给用户网址和最少说明"。而现在：
- `src/lib/site.ts` 的 `SITE_URL` 默认回落到 `http://localhost:3000`；
- 仓库无任何部署配置（无 vercel.json / Dockerfile / 生产域名）；
- `.env` 里**没有** `NEXT_PUBLIC_SITE_URL`。

结论：不部署就没有可发送的链接，真人测试无法开始。这一步不做，后面 A–F 全部无从谈起。

---

## 2. 平台选择

**首选 Vercel。** 理由：本项目是 Next.js 16 App Router + Neon（serverless 友好），Vercel 对
App Router / Middleware / Edge 运行时零配置；`postinstall: prisma generate` 会在其构建镜像内自动重生成
Prisma Client；免费 Hobby 版足够跑一轮 8–12 人测试；每次推送自带 preview 域名，正式部署给 production 域名。

备选（仅当你更熟）：任意支持 Docker 的平台。注意——那需要在 `next.config.ts` 打开 `output: "standalone"`，
**属产品配置改动**，本轮冻结下不建议；如坚持 Docker，请单独授权我改这一处。

---

## 3. 环境变量清单（部署时必填，逐项对照代码真实读取的名字）

> ⚠️ **命名坑（务必注意）**：`.env.example` 里写的是 `NEXT_PUBLIC_APP_URL`，但代码实际读取的是
> **`NEXT_PUBLIC_SITE_URL`**（`src/lib/site.ts`）。在托管后台**一定要填 `NEXT_PUBLIC_SITE_URL`**，
> 填 `NEXT_PUBLIC_APP_URL` 不生效，站点会停在 localhost 口径。这是本轮自查发现的一个文档/代码命名不一致，
> **已记录，暂不改代码**（改 `.env.example` 注释或统一到 `NEXT_PUBLIC_TEST_RESULTS` 属后续 P2）。

必填（缺任一项要么启动即报错、要么关键链路断）：

| 变量 | 值 | 为什么 |
|---|---|---|
| `DATABASE_URL` | **独立 Neon 测试库的 pooled 连接串**（带 `-pooler` / PgBouncer） | serverless 短连接多，必须用 Neon 池化串；指向测试分支库（见 §4） |
| `AUTH_SECRET` | 新生成的随机串（≥32 字节 base64，别复用本机 dev 值） | Auth.js v5 签发/校验 JWT；`src/auth.ts` `trustHost:true`，生产缺 `AUTH_SECRET` 直接报错 |
| `NEXT_PUBLIC_SITE_URL` | 最终部署域名，如 `https://rvuc.vercel.app` | 决定 canonical/OpenGraph/回调绝对 URL；并触发 `isIndexable`（见下） |

强烈建议填（否则"留资→被人联系"这条商业闭环在测试里是假的，E/F 无法真实判定）：

| 变量 | 值 | 为什么 |
|---|---|---|
| `SUPPORT_EMAIL` 或 `SUPPORT_WECHAT`（至少一个） | 你真实能收到询价的邮箱/微信 | `/enterprise` RFQ 表单与联系入口据此呈现；**三者全缺时页面统一显示"客服联系信息待配置"**——那样用户根本无从"获得企业服务"，标准 E/F 直接失真 |

按需（决定"AI 解释此结果"这个按钮的行为）：

| 变量 | 值 | 为什么 |
|---|---|---|
| `DEEPSEEK_API_KEY`（+ 可选 `DEEPSEEK_BASE_URL` / `MODEL_ID_*` / `MODEL_PRICE_*`） | 有额度才填 | 沙盘经济计算是本地确定性引擎、**不依赖它**；但界面上有"AI 解释此结果"按钮，**不配 key 则该按钮报错**。两条路：① 配 key 让它可用；② 不配 → 测试中若用户点它会撞错，如实记为发现（本轮不建议为此改代码去隐藏按钮） |

不需要（属于暂缓的收费/自动支付/证据上传，本轮测试用不到，留空即可）：
`STRIPE_SECRET_KEY` / `ALIPAY_APP_ID` / `WECHATPAY_MCHID` / `PAYMENT_*` / `S3_*` / `AUTH_GITHUB_*`。

可选：`LOG_LEVEL`（如 `info`）。

关于**搜索引擎收录**：`src/lib/site.ts` 的 `isIndexable` 规则是"生产构建 + `NEXT_PUBLIC_SITE_URL` 已配 + 非
localhost → 自动放开 robots/sitemap"。测试库通常**不想被公开收录**。两种干净做法：① 用带鉴权/未猜到的
preview 域名、只在私域发链接（Vercel 默认 preview 不进搜索引擎）；② 部署后在 Vercel 加一条
`X-Robots-Tag: noindex` 响应头（属平台设置，不改代码）。推荐 ①。

---

## 4. 数据隔离（关键，别污染主库）

真实用户会在部署站上**注册账号、保存项目、提交 Lead、（若为 staff）导出方案**。若直接指向生产/开发主 Neon 库，
这些测试数据会混进正式数据，违反"公开页面不被测试数据污染"的纪律。

做法：在 Neon 里对现有项目**开一个独立分支（branch）或新建一个 test project**，schema 用同一套
`prisma/migrate`（`npm run db:deploy` 指向测试串）同步。部署的 `DATABASE_URL` 只填这个测试串。
测试结束后导出 Lead/反馈、再 `deleteMany` 或**直接销毁该测试分支**即可，主库零污染。

> 建一个测试管理员账号（用于 §1 验收 + 后台看 Lead）：部署后走 `npm run user:promote` 或在测试库上
> 用 `db:seed`，或注册一个邮箱再手动置 `role=ADMIN`。**别在测试库放任何真实/权威 FACT 之外的东西。**

---

## 5. Vercel 具体步骤

1. Vercel 导入 GitHub 仓库 `yvzibaba/website-project`（分支 `main`）。
2. Framework 自动识别 Next.js；Build Command `npm run build`，Install Command 保持默认
   （会跑 `postinstall: prisma generate`）。
3. Environment Variables：Production / Preview 都填 §3 清单。`NEXT_PUBLIC_SITE_URL` 先填 Vercel
   分配的正式域名（若还没分配，先部署一次拿到域名，再回填该变量重新部署一次——`NEXT_PUBLIC_*` 是构建期注入，
   改了要重新 build 才生效）。
4. Deploy。拿到 `https://<project>.vercel.app`。
5. 域名可选：想更像"正规产品"减少用户疑虑，可绑一个自有域名；不绑也能测。

（若你更愿用别的方式给一个公网 URL，只要满足：https、能连测试 Neon、填了 `AUTH_SECRET` 与
`NEXT_PUBLIC_SITE_URL`，本文其余部分通用。）

---

## 6. 部署后、发人之前的验收清单（先自己扫一遍，别浪费真人样本）

- [ ] `<域名>/api/health` 返回 `db.ok`（Neon 连通）。
- [ ] `<域名>/` 首页 30 秒价值句、主按钮「免费算一个项目」可见可点。
- [ ] `<域名>/workbench` 免登录打开，拖动任一参数右侧 NPV/IRR/回收期**即时变**；
      点「展开高级参数」能找到储能三键；改储能后结论联动变化。
- [ ] 点「生成动态报告」出报告；报告含"示例参数·未经核实"与版本溯源。
- [ ] 游客在 `<域名>/enterprise` 底部 RFQ 表单提交一条真实测试留资 →
      登 `<域名>/admin/leads`（用测试管理员账号）能看到并可流转"待处理→已联系"。
- [ ] 手机浏览器打开首页+沙盘+报告+留资表单，无溢出点不到（对应移动端基础体验）。
- [ ] （若配了 DEEPSEEK_KEY）「AI 解释此结果」能返回；（若没配）确认这不影响其余动线，或知悉该按钮会报错。

跑完这份自查，才把链接投给第一批真人。这样 8–12 个宝贵样本消耗在"理解/信任/付费意愿"上，
而不是消耗在"网站打不开/按钮报错"这种构建级噪声上。

---

## 7. 只有你（创始人）能做的

生产部署 + 密钥录入是创始人裁决项，我不能替你点：

1. 授权一个托管账号（Vercel 或你选的）并把仓库接进去，或给我一个可发布用的 token（token 属密钥，
   你显式提供我才用）。
2. 建 Neon 测试库分支、生成 `AUTH_SECRET`、决定 `SUPPORT_EMAIL/WECHAT` 填哪个真实联系、
   以及本轮**是否配 `DEEPSEEK_API_KEY`**（决定"AI 解释"按钮在测试里是真能用还是会报错——这会直接影响
   §9 疑点 6 的观察，建议你有意做这个选择并记录预期）。
3. 按 §5 部署、按 §6 自查，然后按 `REAL_USER_VALIDATION_V1_1.md` §11 招募真人。

**我不会**：伪造真实用户反馈、凭空填 `REAL_USER_TEST_RESULTS_V1_1.md`、或在你没跑之前替你宣布验证通过/商业成功。
那份结果报告必须由真人一手数据喂出来（我已准备好把它做成"真实数据→自动统计"的模板，随时可搭，见下）。

---

## 8. 可选：我还能立刻帮你搭的（等你说要）

- **数据回收 + 自动分析套件**：把 §4 观察表 / §5 反馈表做成可直接填的表格，外加一个脚本，读入你回收的
  **真实**数据后自动算 A–F 通过率、命中哪条红线、P0–P3 归类，生成 `REAL_USER_TEST_RESULTS_V1_1.md` 骨架
  （"真实用户原话 / Lead 条数"等字段只能来自真实行；对空/无真实样本的输入会**拒绝出结论**，防造假）。

这一步在你确认"要"之后我才做，且仍是造工具、不造数据。
