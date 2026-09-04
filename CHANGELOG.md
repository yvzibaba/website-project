# CHANGELOG

记录规则（宪法第13条）：每次修改追加**版本号 + 时间 + 原因 + 内容 + 效果**；不得直接覆盖生产版本；必要时可回滚（Git revert 对应提交）。
时间时区：Asia/Shanghai。

## [0.28.0] - 2026-09-05 · Phase 13 里程碑 6：后台「审核发布队列」——跨实体人工裁决待办的单一入口（复用既有写端点，零 schema/零新端点）

- 原因：宪法核心分工是「**AI 做大量劳动，人做关键决策**（战略/商业判断/项目选择/最终发布）」，总控 §13 要求后台对管理员操作可控。Phase 9 之后，方案与案例将由多角色 AI 流水线**批量产出草稿并推入待人工裁决态**——方案进 `UNDER_HUMAN_REVIEW`、案例停在内部阶段（`CANDIDATE`/`KEY_RESEARCH`）。但后台至今只有两张**各自的全量长列表**（`/admin/cases`、`/admin/solutions`），运营要逐屏翻找「哪些在等我拍板」，且**能不能发布、还差什么**要到详情页或点按钮吃 409 才知道。人工决策这一步在后台既散点又缺就绪预览，直接拖累「…→ 购买」闭环的吞吐。（本里程碑**零 schema、零新写逻辑、零新 HTTP 端点**——队列上的动作全复用 Phase 13 M1 的 `PATCH /api/admin/solutions/[id]`、`/api/admin/cases/[id]`，服务端仍跑发布守卫 + 角色 + CSRF，UI 只是薄壳。）
- 内容：
  - `src/server/solution-admin.ts`（改，纯加性）：导出**只读**发布就绪预览 `solutionPublishBlockers(sol)`——它**复用同一个私有 `publishGuard`**，把按字段归类的拒绝原因摊平成人类可读串数组（空=就绪）。刻意与真实发布走同一函数，杜绝「队列说能发、点了被拦」的口径漂移（宪法第 16 条单一真源）；不写库、不改状态。
  - `src/server/admin-review.ts`（新，server-only by comment）：`getReviewQueue()` 单事务两查聚合待办——**等待审核的方案**（`status=UNDER_HUMAN_REVIEW`，带挂靠案例标题/行业中文名、价格 `toFixed(2)`/`priceDisplay`、`riskDomains`/`needsProfessionalReview`、经 `solutionPublishBlockers` 就地算出的 `publishBlockers`、`unknowns`/`orders` 实时 `_count`、`isDemo` 由关联案例 `sourceType` 判定）与**等待晋升到橱窗的案例**（`stage∈{CANDIDATE,KEY_RESEARCH}`，带证据 `_count`、机会分/可信度标量、行业中文名、`isDemo`）。各自 `take:REVIEW_QUEUE_LIMIT+1` 判 `truncated`、`updatedAt` 倒序；导出 `PENDING_CASE_STAGES`/`PENDING_SOLUTION_STATUS` 常量为口径单一真源。**未知变量数取实时 `_count.unknowns` 而非缓存标量列**（与 `listAdminSolutions` 同一取向——缓存列可漂移，直插 nested create 不触发 `addSolutionUnknown` 的同步，实测踩到后改）。不做鉴权（信任已过 `requireRole` 的后台页），只读失败如实上抛交页面 error 边界（不静默降级编造空队列）。
  - `src/components/admin/ReviewQueueActions.tsx`（新，client）：一条待办的多动作按钮（`{label,body,variant,confirm}` 数组），全部经共享 `mutateJson` 打**既有** PATCH 端点；成功 `router.refresh()` 让服务端队列重取（该条自然消失/徽章更新），被守卫拒时如实回显 409 字段原因，**UI 不自判「能不能发」**（服务端唯一权威）。
  - `src/app/admin/review/page.tsx`（新路由 `ƒ /admin/review`）：layout + page **双层防御**（取数据前 `requireRole(STAFF_ROLES)`，越权 `return null` 使 `getReviewQueue` 根本不被调用、不进 RSC flight）+ `force-dynamic` + `noindex`；两栏（待审核方案 / 待发布案例），每方案卡就地渲染发布缺口（有缺口显 `Alert warning`，就绪显「条件齐备，可发布。」），案例卡链向既有编辑台。
  - `src/app/admin/page.tsx`（改）：「内容入口」卡置顶加「审核发布队列（待我处理）→」链接。
- 验证：`tsc`/`eslint` 0 错；`next build` 新增 `ƒ /admin/review` 无回归；新增**单元测试 `tests/unit/review-readiness.test.ts` 5 例**（`vi.mock("@/lib/prisma")` 无 DB：已定价无高风险→就绪 / 未定价→命中「价格」/ 涉高风险未确认→点名「N 个高风险领域」+ 领域名 / 已勾确认→就绪 / 双缺口都列，锁「预览口径=真实守卫」）；新增**集成测试 `tests/integration/admin-review.test.ts` 4 例**（真连 Neon，夹具 afterAll 按外键序清理：① 只收 UNDER_HUMAN_REVIEW·DRAFT/PUBLISHED 干扰项不入队·未定价方案给价格缺口·就绪方案空缺口·`unknownVariableCount` 取实时；② 只收内部阶段·带证据数/评分·已公开阶段不入队；③ 方案 `isDemo` 由关联案例判定·行业映射中文名非字面量·缺口点名领域；④ `updatedAt` 倒序不变式 + `total≥items` + `truncated` 自洽）。**修测记录**：初版读缓存标量 `unknownVariableCount`，直插 nested create 未同步致队列显 0，改用 `_count.unknowns` 实时后转绿。基线全绿 **378 tests / 34 files**（Phase 9 M1 的 369 + 本里程碑 5 单元 + 4 集成）。**审核队列端到端冒烟 29/29**（`smoke-admin-review.mjs -p 3129`：未登录 307 跳登录 / USER 200 但「无访问权限」且不泄露队列栏与自建方案标题 / ADMIN 200 见「待审核方案」「待发布案例」两栏 + 未定价方案「发布前需补齐…价格」缺口 + 就绪方案「条件齐备，可发布。」/ **动作即复用端点**：就绪方案 `status→PUBLISHED` 200、未定价方案→409 含 `price` 字段（守卫未放松）、候选案例 `stage→DEEP_CASE` 200 且 DB 变更 / 发布·晋升后该条离开队列、仍未定价者留队 / 跨站 Origin 403 CSRF、USER 403 / 四项 leftover=0）。
- 效果：**Phase 13 M6 达成**——后台首次有了跨实体的「等人拍板」单一入口，AI 流水线的产出（待审方案 / 内部阶段案例）汇聚一处并**就地显示发布缺口**，把「人做关键决策」这步从翻两张长列表压缩成一屏裁决，为 Phase 8 M3 / Phase 9 M2 批量灌草稿后的规模化人工审核铺好操作面。守卫、鉴权、CSRF、审计全部复用既有链路（**零新写路径**），队列动作与真实发布共享 `publishGuard` 故预览与实际发布永不各说各话。**刻意最小竖切**：不含驳回理由填写/重新提交工作流细粒度状态机、不含审核人分配、不含批量操作——留后续按需再补。

## [0.27.0] - 2026-09-05 · Phase 9 里程碑 1：Model Router 骨架（provider 解耦 + 任务路由 + 结构化输出校验 + 成本记录契约）

- 原因：本系统的立身之本是「**AI 驱动**的产业案例研究 / 解决方案生成」，但截至目前所有案例/方案都靠运营在后台手填，**没有任何模型接入层**——上游自动化（Phase 8 M3 真实方案流水线、Phase 10 GitHub Scout、Phase 11 企业诊断）全部悬空。宪法明确要求「**模型经 Model Router 解耦、不绑定单一模型**」，总控 §16 规定「业务代码只能调用 Model Router，不得直接依赖具体模型」，§31 要求「每个 AI 任务记录 model/tokens/estimated_cost/latency/status」，§32 定「按任务复杂度分档路由、不要所有任务都用最贵模型」，§17 定「所有生成内容用结构化 JSON 作中间格式」。这些是**关键路径上的基础 plumbing、非投机式花活**（宪法第 13 条反例警告的正是「因终局宏大提前把 V1 做复杂」——但解耦层不做，后续每接一个模型都要改一片）。（本里程碑**零 schema、零 DB、零 HTTP 端点、零 UI**，与 `scoring.ts` 同构的纯函数 + 判别联合，可完全离线测试。）刻意把**真实 provider 接线、`ModelCall` 落库、成本看板**留后续——真实模型调用阻塞在 ROADMAP #4（模型 API Key），无 key 时用**确定性 StubProvider** 把契约立起来并测死，key 到位只需新增一个实现 `ChatProvider` 的类注入即可，`runTask` 一行不改。
- 内容：
  - `src/server/model-router.ts`（新）：
    - **任务分类与统一入口（§16）**：`MODEL_TASK_KINDS` = `generate_text/structured_output/research/embedding/vision/code` 六字面值；`runTask` 为唯一原语，另导出 `generateText/structuredOutput/research/embed/vision/code` 六个语义化薄封装（全部委托 `runTask`），使「业务代码只调 Model Router」这条铁律有自然入口且可被 grep 审计。
    - **路由策略（§32，标注为 v1 设计假设）**：`ROUTING_POLICY: Record<taskKind, tier>`——`research→high`（复杂研究才升档）、`generate_text/embedding→low`、`vision/code/structured_output→medium`；调用方可用 `tier` 显式覆盖（为「核心财务/项目判断 = 模型 + 程序 + QA」的高价值组合预留升档通道，但不为未建成的流水线预调）。
    - **模型目录与成本（§31，程序计算 > 模型口算，宪法第 7 条）**：`MODEL_CATALOG` 每层级一个占位 `ModelSpec`（含 `inputPer1kUsd/outputPer1kUsd`，**单价是 v1 占位假设、同证据可信度公式一样标注可调、真实值到位替换并升 `MODEL_ROUTER_VERSION`**）；`estimateCost(model,usage)` 纯函数 `(pt/1000)·in+(ct/1000)·out`、round 到 6 位小数、**负/NaN token 一律按 0**（脏输入不污染、结果不为负/NaN）。
    - **Provider 解耦点**：`ChatProvider` 接口（`{ id, complete(req):Promise<ProviderResult> }`）；`StubProvider` 为确定性离线替身——给 `respondWith` 原样回放为 `json`、`embedding` 由 FNV-1a 哈希派生固定维向量、其余回 `[stub:<kind>] <prompt>`，token 数按 ~4 char/token 估算，**恒同入同出**（无网络 / 无 key / 无时钟 / 无随机）。
    - **调用记录与记录器（§31）**：`CallRecord` 携 `taskId/timestamp/providerId/modelId/tier/taskKind/latencyMs/usage/estimatedCostUsd/status` + 可选成本归因 `agent/caseId/solutionId`（为「每 Agent/案例/方案成本」看板预埋字段，看板延后）；`CallRecorder` 接口，默认 `loggingRecorder`（结构化日志、**绝不落任何密钥明文**）、另给 `createMemoryRecorder()`（收集 + `totalCostUsd()` 聚合，测试/上层用）。
    - **编排契约**：`runTask` ①按 `tier ?? ROUTING_POLICY[kind]` 选层级/模型/provider；②`provider.complete` 抛错 → **归一为 `provider_error` 判别联合、绝不向业务抛裸异常**；③带 `schema` 则对结构化输出做 `z.safeParse`，不过 → `schema_invalid` + **指名 `issues`（不静默放过）**、原始输出仍带回供审计；④**无论何种结局都产出一条 `CallRecord` 并经 recorder 记录**（成本可追踪）；⑤成本由 `estimateCost` 程序计算。返回 `RunTaskResult` 判别联合（`ok/schema_invalid/provider_error`）。
- 验证：`tsc`/`eslint` 0 错、`next build` 无回归（**本里程碑不新增任何路由**，纯 server 侧逻辑）；新增**单元测试 `tests/unit/model-router.test.ts` 18 例**（无 DB/无网络/无 key）：常量守护（6 入口 / 3 层级 / 每 kind 路由到合法 tier / 目录 id 唯一且单价为正）、`estimateCost` 黄金值（high 1K+1K=0.032、low 2K=0.001、**负/NaN→0**、6 位小数上限）、StubProvider 确定性（同 prompt 两次 embedding/usage 全等、`respondWith` 原样回放）、`runTask` 编排（自由文本→ok 落 low、显式 `tier:high` 覆盖路由、结构化合法→ok 且 cost>0、结构化非法→`schema_invalid` 且 `issues` 指名 `n` 路径但记录仍产出、**provider 抛错→`provider_error` 不崩且 usage/成本归零但记录 status/tier 仍在**、`embed`→ok 向量维度 8、`taskId` 形如 `<kind>-<n>` 且跨调用递增唯一、内存 recorder 聚合总成本、`agent/caseId/solutionId` 归因透传）。基线全绿 **369 tests / 32 files**（Phase 14 M1 的 351 + 本里程碑 18）。
- 效果：**Phase 9 M1 达成**——立起「业务代码 → Model Router → provider」这条解耦缝，把总控 §16/§17/§31/§32 的**契约**（统一入口、按复杂度路由、结构化输出必须经 schema 校验、每调用产出可追踪成本记录、错误归一不裸抛）以纯函数形式落死并有 18 例离线测试护航。真实模型接入（Phase 8 M3 流水线 / Phase 10 Scout / Phase 11 诊断）从此有唯一挂载点：实现 `ChatProvider` 注入即可，无需触碰业务代码；`ModelCall` 落库与后台成本看板留 Phase 9 M2。**刻意最小竖切**：不含真实 provider（阻塞 #4 API Key）、不含 Agent 多角色框架（§33 Bull/Bear/Judge/QA，须先有真实 provider）、不含 HTTP/UI。

## [0.26.0] - 2026-09-05 · Phase 14 里程碑 1：SEO 元数据契约 + robots.txt / sitemap.xml（环境门控，先不开 JSON-LD）

- 原因：商业闭环「…→ 用户查看 → 购买」的**上游获客**依赖搜索引擎可发现性，但此前全站根 layout 写死 `robots:{index:false}`、无 `/robots.txt`、无 `/sitemap.xml`、各页无 canonical/OpenGraph——根 layout 注释本身即预告「Phase 14 打开 SEO 时再改」。（宪法：用户价值 > 方案质量 > 自动化效率；一次一个明确任务，简单优先；本里程碑**零 schema、零新数据层写逻辑**，纯元数据契约。）刻意**把 JSON-LD 结构化数据留到 M2**，M1 只立「可被索引与否的单一裁决 + 静态清单 + 逐页 canonical/OG」这一条最小可验证竖切。
- 内容：
  - `src/lib/site.ts`（新，client/server 两侧安全，仅类型引用 next `Metadata`）：站点级 SEO **单一真源**（宪法第 16 条防漂移）——`SITE_URL / SITE_NAME / SITE_DESCRIPTION` + 纯函数 `isIndexable()` / `absoluteUrl(path)` / `seoMetadata({title,description,path,type})`。`isIndexable()` 采**环境门控**：仅当「生产构建 **且** `NEXT_PUBLIC_SITE_URL` 配了非本地域名」才放开索引；localhost/127.0.0.1/0.0.0.0/::1、URL 解析失败一律保守判为不可索引——未部署/开发/预览站点绝不进搜索引擎。`SITE_URL` 归一时把「空串/纯空白」也视同未配置回落本地（`?? ` 只兜 undefined/null，`.env` 写 `NEXT_PUBLIC_SITE_URL=` 会得到 `""` 造成 canonical 残缺串——冒烟前自查修正）。`seoMetadata` 只产出 `alternates.canonical`（相对 path，交 `metadataBase` 解析）+ `openGraph`（绝对 `og:url`、`siteName`、`locale:zh_CN`）+ `twitter.card:summary`，缺 title/description 时**不写入空字段**（避免以站点默认覆盖页面自身标题）；V1 无 OG 图故不虚构图片。
  - `src/server/seo.ts`（新，server-only）：`getSitemapEntries()` 只读枚举「应进 sitemap 的公开 URL + lastModified」——真实公开案例（`stage∈PUBLIC_CASE_STAGES` 且非 DEMO）→ `/cases/<id>`、已发布方案（`status=PUBLISHED` 且其关联案例非 DEMO）→ `/solutions/<id>`；两查询各用 **AND 数组**容纳 DEMO 的 OR 片段（规避「两个 OR 片段做兄弟键互相覆盖」的已记录 Prisma 坑），只 `select{id,updatedAt}`、`take:SITEMAP_PER_TYPE`（4000）兜底防 URL 爆炸。**诚实降级**：任一侧查询失败 → `log.warn` 跳过该侧，绝不抛错令整张 sitemap 生成失败。DEMO 排除复用 `demo.ts`（宪法第 20 条：DEMO 非真实产出，不被收录）。
  - `src/app/robots.ts`（新，MetadataRoute，`force-dynamic`）：不可索引 → `Disallow: /`（全站）；可索引 → `Allow: /` + 显式禁抓私有/动态前缀（`/admin /account /orders /api /login /register /search /ui`）+ `Sitemap` + `Host` 指引。**关键教训**：MetadataRoute 默认**构建期快照成静态文件**——若构建与运行时 `NEXT_PUBLIC_SITE_URL` 不一致，会出现「robots 仍 `Disallow:/`、但 force-dynamic 的 sitemap 已放开」的分裂；`isIndexable()` 是纯运行时判定，故 robots 亦置 `force-dynamic`，与 sitemap.xml 永远同源一致。
  - `src/app/sitemap.xml`（新 `src/app/sitemap.ts`，MetadataRoute，`force-dynamic`）：不可索引 → `[]`（空 urlset，不暴露任何 URL）；可索引 → 静态页（`/ /industries /cases /solutions /about /privacy /terms`）+ 7 个行业页（枚举 `INDUSTRIES`，无需查库）+ `getSitemapEntries()` 动态案例/方案，按 `url` 去重。
  - `src/app/layout.tsx`（改）：删本地 `const siteUrl=…` 改 `import` `SITE_URL/SITE_DESCRIPTION` 复用单一真源；根 `robots` 由写死 `index:false` 改为 `isIndexable() ? {index:true,follow:true} : {index:false,follow:false}`。
  - 公开页加 `seoMetadata` canonical+OG：首页 `/`、`/industries`、`/industries/[slug]`（SSG `generateMetadata`，notFound 分支补 `robots noindex`）、`/cases`、`/solutions`、`/about`；`/cases/[id]`、`/solutions/[id]` 的 `generateMetadata` found 分支加 canonical+OG（`type:"article"`），not_found/error 分支补 `robots noindex`，且 **DEMO 视图（`?demo=1`）一律 noindex**。`/search` 设 `robots:{index:false,follow:true}`（查询串页收录会产生大量重复低价值页，但允许顺链接抓取）。隐私/条款仍各自 noindex（当前为待法务审定的占位草稿，诚实不上索引）。私有/后台页既有 noindex 不动。
- 验证：`tsc`/`eslint --max-warnings=0` 0 错；新增**单元测试 `tests/unit/site.test.ts` 17 例**（`vi.stubEnv`+`vi.resetModules` 重导入以覆盖不同 NODE_ENV/域名组合：SITE_URL 归一（尾斜杠 / 空串回落本地 / 非法）、isIndexable 六种门控、absoluteUrl 四边界含无前导斜杠与已绝对、seoMetadata 形状与「缺字段不写空值」不变量）；新增**集成测试 `tests/integration/seo.test.ts` 4 例**（真连 Neon，一次性夹具 + `afterAll` 全量清理：真实公开案例与已发布方案 URL 出现且带 lastModified、CANDIDATE 内部阶段与 DEMO 案例被排除、**挂在 DEMO 案例下的已发布方案亦被 `solutionDemoVisibility` 顺 case 排除**、path 均为站内相对路径、`SITEMAP_PER_TYPE` 上限合理）。基线全绿 **351 tests / 31 files**（M5b 的 330 + 本里程碑 17 单元 + 4 集成）；`next build` 新增 `ƒ /robots.txt`（改 force-dynamic 后由 ○ 静态转 ƒ 动态）与 `ƒ /sitemap.xml` 两路由、行业 SSG 与既有页无回归。**SEO 端到端冒烟 20/20**（`smoke-seo.mjs`，起两实例 A=无域名 B=`example.com`，真实 `next start`）：A 分支 robots 全站 `Disallow:/`、sitemap 无任何 `<loc>`、首页 `noindex`；B 分支 robots `Allow:/` + 逐条禁抓私有前缀 + `Host`/`Sitemap` 指引、sitemap 含行业页与 `/about` 且不含 `/search` `/admin`、首页 canonical 与 `og:url` 为绝对 URL、`og:site_name` 存在、meta robots `index, follow`。
- 效果：**Phase 14 M1 达成**——站点具备可被搜索引擎正确发现的元数据契约（canonical + OG + robots + sitemap），并以「生产 + 正式域名才放开」的环境门控守住诚实性：未部署时对外零收录，部署到 `yvzibaba.com` 并设 `NEXT_PUBLIC_SITE_URL` 后无需改代码即自动放开。仍是刻意最小竖切：**JSON-LD 结构化数据（Product/Offer/Article/BreadcrumbList）留 M2**，OG 分享图、hreflang、分页 canonical 等留后续。

## [0.25.0] - 2026-09-05 · Phase 13 里程碑 5b：后台「案例 10 维度机会评分录入台」——把造好的评分内核接上操作龙头（复用 M1 写端点）

- 原因：案例评分内核 `src/server/scoring.ts`（Phase 7）早已建成并锁定 26 条黄金样本，`recomputeCaseScores` 也在每次案例/证据写入时联动，但后台**没有任何 UI 能录入 `scoreInput`**——运营只能靠种子或裸 API 打分，等于"水管造好却没接上龙头"，10 维机会评分这条「案例拆解 → 打分 → 排序优先级」的关键闭环在人工侧断开。M5 详情页刻意留了只读评分卡与"待 M5b 补齐"占位。（宪法：商业闭环 > 数据质量 > 开发效率；一次一个明确任务，简单优先；**零 schema、零新数据层写逻辑、零公式/权重改动**，故不触碰黄金样本与 `SCORING_RUBRIC_VERSION`，全复用 M1 的 `PATCH /api/admin/cases/[id]`。）
- 内容：
  - `src/server/admin-cases.ts`（扩展，server 读层）：`getAdminCaseDetail` 新增两字段透传——`scoreInput`（原始 10 维输入，供表单取初值；仅接受"字符串→有限数"的普通对象，脏形状/缺省一律诚实降为 `null`，不伪造）与 `scoreBreakdown`（数据层复算落库的 `CaseScores`，供只读审计卡逐维度回显；对持久化 json **再走一遍 `CaseScoresSchema.safeParse` 防御性复核**，结构漂移即降为 `null`，绝不渲染半截数据）。故 `hasScoreBreakdown`（看原始 json 是否存在）与 `scoreBreakdown`（是否 schema 合法）可不等价——真实反映"有历史脏数据但不轻信"。`select` 增补 `scoreInput: true`。
  - `src/components/admin/CaseOpportunityScoreForm.tsx`（新，client）：10 个受控数字输入。维度/满分/极性**全部由服务端从 `OPPORTUNITY_DIMENSIONS` 常量传入**（本组件不抄一份权重，杜绝口径漂移，第 16 条）；即时校验严格对齐内核 `OpportunityInputSchema`——每项须为 0..max 的整数、10 项齐全才允许提交，反向维度（竞争强度/实施难度）标「越低越好」、按直觉填"越高越糟"由程序 `max-raw` 负责；实时预览合计（正向取 raw、反向取 max-raw）与"有效 k/10"仅作辅助，**最终机会分一律以服务端复算为准**（`router.refresh()` 后回显），客户端绝不算权威分、不写库（程序计算 > 前端口算，且前端可被绕过）。提交走 `PATCH /api/admin/cases/[id] { scoreInput }` → `updateCase` → `recomputeCaseScores`，复用 `mutate.ts`。
  - `src/app/admin/cases/[id]/page.tsx`（扩展，RSC）：只读评分卡文案由"待 M5b 补齐"改为指向下方录入台；卡下挂载 `CaseOpportunityScoreForm`；新增**服务端渲染的「评分明细（服务端复算 · 只读）」审计卡**——仅当 `scoreBreakdown.opportunityBreakdown` 存在时渲染，逐维度表格（录入/满分、计入总分、反向标记）、合计行、公式版本、按 FACT/ASSUMPTION/INFERENCE/PREDICTION 分类的证据计数、关键未知变量数、越界 `issues` 告警条，以及"综合评分 ≠ 项目一定成功"免责条。数字比值串均渲染为**单一模板串**（`` {`录入 ${row.raw} / ${row.max}`} `` 等）规避 React SSR `<!-- -->` 隔断坑（Phase 8 M2 / 13 M4 / 13 M5 同源）。
- 验证：`tsc`/`eslint` 0 错；`tests/integration/admin-case-detail.test.ts` 由 5 例扩至 **6 例**（真连 Neon）：既有 CANDIDATE 案例补断言 `scoreInput=null` + 历史漂移 json `{total,dims}` 使 `scoreBreakdown` 防御性降为 `null`（但 `hasScoreBreakdown=true`）；新增 M5b 夹具——一条挂黄金 10 维 `scoreInput` + 2 条 FACT 证据、随即 `recomputeCaseScores` 落库真实 breakdown 的案例，断言 `scoreInput` 原样回读、`scoreBreakdown` 非空、`opportunityScore=74`（正向和 68 + 两反向各 3）三处一致（标量 / breakdown.total / 逐维度贡献和）、`opportunityBreakdown` 10 行、`evidenceConfidence=69`（conf90 有源 + conf80 无源加权）、`unknownVariableCount=0`（皆 FACT）。基线 **249 单元 + 81 集成** 全绿（330 总数，较 M5 的 329 +1）；`next build` 路由无新增（复用既有 `ƒ /admin/cases/[id]`）无回归。**后台评分录入台端到端冒烟 32/32**（`smoke-admin-cases-score.mjs`，`next start -p 3128`，自种 USER/ADMIN + 一条无评分 DEEP_CASE 案例，真实 Auth.js 登录）：无评分时 SSR 出「机会评分（10 维度）」录入台 + 「尚未评分」提示且**不渲染**明细审计卡；ADMIN `PATCH` 合法 10 维 → 200 且 `recompute=computed`、重开详情 SSR 出现「评分明细（服务端复算」审计卡含维度标签「商业价值」/反向标记「（反向）」/免责条、**DB 确证 `opportunityScore=74`**；追加 FACT 证据（conf90 有源）→ 单条 FACT 可信度复算 `=90`、SSR 页脚见「证据可信度」「关键未知变量」；**越界不污染**——`PATCH {commercialValue:99}` → 200 但 `recompute=invalid`（内核裁决非静默），DB 机会分**仍 74**、`scoreBreakdown` 未被半截数据覆盖；跨站 Origin PATCH→403 CSRF、USER PATCH→403、USER 详情不泄露录入台、未登录→307；finally FK 序删 case→evidence→solution→user，四项 leftover=0。
- 效果：**Phase 13 M5b 达成**——沉睡的评分内核第一次在后台有了可操作的录入入口，"案例发现 → 拆解 → 打分 → 优先级排序"在人工侧真正闭合；且以"程序复算 + 只读明细 + 越界不污染"的方式守住宪法第 7/20 条（关键数字来源可追溯、公式可复算、绝不口算/虚构）。仍是有意的最小竖切：`scoreInput` 清除入口、`regionId/businessModelId` 关联选择器、审核发布队列（M6）、成本看板、更细粒度权限矩阵留后续里程碑。



- 原因：M2 让运营能「浏览全量案例 + 新建候选案例」，M1 早已备好 `PATCH/DELETE /api/admin/cases/[id]` 与证据增删端点，却**没有任何后台 UI 消费**——补一条证据、纠正阶段、删除录错的候选案例都得裸调 API。案例是「案例发现 → 案例拆解 → 证据可信度积累」这条商业闭环最上游的数据源，缺编辑台直接卡住后续评分与方案的证据基础（宪法最高优先级：商业闭环 > 用户价值 > 数据质量）。M5 把一份案例的可编辑面（基本信息 / 证据逐条增删 / 删除）收敛到一处，与 M4 方案编辑台合龙成"案例 + 方案"两条内容后台竖切。（一次一个明确任务，简单优先；零 schema、零新数据层写逻辑，全复用 M1 已测端点。）
- 内容：
  - `src/server/admin-cases.ts`（扩展，server 读层）：新增 `getAdminCaseDetail(id)`——`findUnique` 带 `evidences`（createdAt 正序，与公开详情一致）+ `_count:{solutions}` + `solutions:{where:{status:"PUBLISHED"}}`（专取已发布数，作为删除守卫依据）+ `scoreBreakdown`；先以 `if (!id || !/^[a-z0-9]{10,}$/i.test(id))` 早退 `notFound`（挡无形 id 探测）；`isDemo` 由案例自身 `sourceType=DEMO_FIXTURE` 判定、行业映射为可读中文名/slug；`evidenceCount = evidences.length`（实时）、`solutionCount` 取全量、`publishedSolutionCount` 只数 PUBLISHED；证据逐条透传 `type/grade/statement/sourceUrl/sourceType/confidence`、null 如实保留（第 7 条不伪造 0）；机会分/可信度标量 + `hasScoreBreakdown` 只读透传（评分录入留 M5b）；找不到→`notFound:true`、异常→`ok:false` 诚实降级，**不鉴权**（信任调用方为已过 `requireRole` 的后台页）。
  - `src/components/admin/EditCaseMetaForm.tsx`（新，client）：PATCH `/api/admin/cases/[id]` 保存基本信息（标题非空才提交、英文名/摘要/英文摘要/来源链接/来源类型常提允许清空、行业与阶段下拉）；**刻意不提交 `scoreInput`**——10 维度评分录入是"程序复算"高敏感区（黄金样本 + `SCORING_RUBRIC_VERSION`），单独留 M5b，本表单不改动评分避免绕过复算口径；成功 `router.refresh()` 拉回最新 version/徽章/标量。复用 M4 的 `mutate.ts`（`mutateJson`/`fieldHints`），逐字段回显服务端 `details.fields`。
  - `src/components/admin/AdminCaseEvidences.tsx`（新，client）：证据逐条列 + 行内增删。`POST /api/admin/cases/[id]/evidence`（类型 FACT/ASSUMPTION/INFERENCE/PREDICTION、来源等级 S–D、置信度 0–100 整数客户端先校验、陈述必填）；`DELETE .../evidence/[evidenceId]`；二者在数据层内**联动 `recomputeCaseScores`**，故保存后 `router.refresh()` 让服务端 `evidenceConfidence` 与计数重取，本组件绝不自行改分。置信度渲染为单一模板串 `` {`置信度 ${ev.confidence}/100`} ``——规避 React SSR 相邻动态节点插 `<!-- -->` 令整串断言落空的复现坑（与 Phase 8 M2 `5/34`、Phase 13 M4 `60/100` 同源）。
  - `src/components/admin/DeleteCaseButton.tsx`（新，client）：`DELETE /api/admin/cases/[id]`；**不因订单数禁用按钮**（与方案侧不同——案例删除守卫专指"仍挂 PUBLISHED 方案"，是否可删由服务端裁决），客户端只把 `publishedSolutionCount` 作为提示、被拒时如实回显 `fieldHints`（如「仍有 N 个已发布方案，禁止删除」）；成功 `router.push("/admin/cases")` 回列表。
  - `src/app/admin/cases/[id]/page.tsx`（新，RSC）：`force-dynamic` + noindex；**layout+page 双层防御**——页首 `requireRole(STAFF_ROLES)`，越权 `return null` 前**绝不调用 `getAdminCaseDetail`**（否则 Next 为 leaf 段生成 RSC flight 泄露未公开案例，含 CANDIDATE/KEY_RESEARCH 中间态与 DEMO 夹具）；`params` 为 Promise（Next16 必 `await`）；渲染阶段/DEMO/行业徽章 + 公开橱窗预览链接 + 只读评分快照卡（机会分/可信度/证据数/关联方案数 + "评分录入待 M5b"说明）+ 删除按钮 + 基本信息表单 + 证据编辑台 + 审计脚注。`src/app/admin/cases/page.tsx` 行尾加「编辑内容 →」链接进本页，并把文档注释从"只列表+新建"更新为"M5 承载详情/证据/删除"。
  - 顺带修一处真实 lint 违规：`src/components/admin/NewSolutionForm.tsx` 内链 `/admin/cases` 用裸 `<a>` 触发 `@next/next/no-html-link-for-pages`（该规则在新增 `/admin/cases/[id]` 路由后开始拦截）——改 `next/link` 的 `<Link>`，恢复 `eslint --max-warnings=0` 绿。无 schema 变更、无新写端点（全复用 M1）、无删除文件。
- 验证：`tsc`/`eslint` 0 错；新增集成测试 `tests/integration/admin-case-detail.test.ts` **5 例**（真连 Neon，挂在一条 CANDIDATE 真实案例上、3 条多形态证据 + 1 PUBLISHED/1 DRAFT 方案 + 一条 DEMO 夹具）：① 内部阶段 CANDIDATE 可全量读到（不受公开 DEEP_CASE+ 门控）+ 行业映射中文名（非枚举字面量）+ 版本/评分标量透传 + `hasScoreBreakdown=true` ② 证据逐条透传、缺 `grade/sourceUrl/sourceType/confidence` 一律诚实留 null、`evidenceCount=3` ③ `solutionCount=2`、`publishedSolutionCount=1`（只数 PUBLISHED，删除守卫依据）④ DEMO 夹具 `isDemo=true`、无评分明细 `hasScoreBreakdown=false`、无证据→count 0、`opportunityScore=null` ⑤ 有形但缺失 id 与「nope」均 `notFound` 且无 `error`。基线 **249 单元 + 80 集成（75+5）** 全绿（329 总数）；`next build` 新增 `ƒ /admin/cases/[id]` 动态路由、与既有路由并列无回归。**后台案例编辑台端到端冒烟 33/33**（`smoke-admin-cases-edit.mjs`，`next start -p 3127`，自种 USER/ADMIN + 一条预置合法 10 维 `scoreInput` 的 DEEP_CASE 案例 + 一条 CANDIDATE 门禁案例，真实 Auth.js 登录）：详情页 SSR 含「基本信息 / 证据（案例拆解）/ 删除案例」三块、既有证据陈述与「置信度 80/100」经单模板串连续回读可见；PATCH 标题/摘要/阶段 200 且透出改后标题与「重点研究」徽章；新增 FACT 证据 200、透出「置信度 88/100」连续、**DB 确证 `evidenceConfidence` 由 recompute 算出（conf=50）**——关键发现：recompute 有意 gated on `scoreInput`，无输入分的案例诚实跳过、绝不反推（宪法第 20 条），故冒烟预置合法 `scoreInput` 才能真实演示"证据增删联动复算"链路；删除证据 200 后该陈述消失、初始证据仍在；案例挂 PUBLISHED 方案时删案例→409 且 reason 含「仍有 1 个已发布方案」、详情页透出「个已发布方案」连续提示；撤掉该方案后删案例→200、删后详情→404；跨站 Origin PATCH→403 CSRF；USER GET 详情→200 但「无访问权限」且**不泄露**「证据（案例拆解）」编辑块；未登录→307 跳 `/login`；不存在 id→404；finally 按 FK 序删 solution→evidence→case→user，四项 leftover=0。
- 效果：**Phase 13 M5 达成**——案例从"只能列表 + 新建"升级为"可在后台完整维护：基本信息 + 逐条证据增删（联动复算可信度）+ 删除守卫"，与 M4 方案编辑台共同把"案例发现 → 拆解 → 证据 → 方案"这条最上游内容生产链在后台真正闭合、可运营。仍是有意的最小竖切：10 维度评分录入台（M5b）、审核发布队列、成本看板、更细粒度权限矩阵留后续里程碑（M6+）。**不引入新外部依赖、不碰 schema**。

## [0.23.0] - 2026-09-05 · Phase 13 里程碑 4：后台「方案内容编辑台」——把可售方案的付费交付主体变得可录入（复用 M1 写端点）

- 原因：M3 让运营能「建 / 定价 / 发布」一条方案，但方案的**正文（34 分节）、财务测算、关键未知变量、删除**此前只能靠裸 API 写——没有编辑台，卖的就是一份空壳，直接拖累「方案质量」这一宪法高优先级，也让 Phase 12「购买 → 解锁正文」解锁出来的内容无从录入。M4 把一份可售方案的全部可编辑面收敛到一处，闭合"后台可完整录入一条能卖的方案"这条链。（宪法优先级：商业闭环 > 用户价值 > 方案质量 > 数据质量；一次一个明确任务，简单优先；零 schema、零新数据层写逻辑。）
- 内容：
  - `src/server/admin-solutions.ts`（扩展，server 读层）：新增 `getAdminSolutionDetail(id)`——`findUnique` 带 `case` + `financials`（createdAt 倒序）+ `unknowns`（createdAt 倒序）+ `_count:{orders}`；先以 `if (!id || !/^[a-z0-9]{10,}$/i.test(id))` 早退 `notFound`（挡无形 id 探测）；价格与所有 Decimal 字段（capex/opexAnnual/revenueAnnual/roiPct/irrPct/paybackYears）统一 `toFixed(2)` 两位小数字符串、null 如实保留；`unknownVariableCount`/`financialCount` 取实时 `_count`（非缓存字段）、`isDemo` 由关联案例判定、行业映射为可读中文名；`unknowns`/`body` 原样带回供编辑初值；找不到→`notFound:true`、捕获异常→`ok:false` 诚实降级，**不鉴权**（信任调用方为已过 `requireRole` 的后台页）。顺带修一处真实竞态：`listAdminSolutions` 的 `$transaction([findMany, count])` 两条语句各有 READ COMMITTED 快照，并发兄弟测试插删可致 `count < items.length` → `total<items` 自相矛盾，用 `total = Math.max(rawCount, items.length)` 兜底（绝不报出小于已返回行数的 total）。
  - `src/server/admin-cases.ts`（同修）：`listAdminCases` 应用同一 `Math.max(rawCount, items.length)` 竞态兜底。
  - `src/components/admin/mutate.ts`（新，client 共享工具）：`mutateJson(url, method, body?)` 收敛「fetch + 解析 api-guard 判别联合」——2xx 且 `json.ok`→`{ok:true}`，否则带回 `{ok:false, status, message, fields}`，网络异常→`status:0`；`fieldHints(fields)` 把 `details.fields` 展平成可读原因串。**五个编辑组件共用**，杜绝各写一遍 fetch/错误处理而漂移（第 16 条）。
  - `src/components/admin/EditSolutionMetaForm.tsx`（新，client）：PATCH `/api/admin/solutions/[id]` 保存基本信息（标题非空才提交、英文名/摘要常提、价格留空=不改动、币种、高风险领域按 `/[,，\n]/` 分隔成组、需专业确认勾选）；**刻意不提交 `status`**（状态由发布/审核动作单独驱动，避免表单误改）；`notice:{tone,text}` + 逐字段回显。
  - `src/components/admin/SolutionBodyEditor.tsx`（新，client）：按 `solution-body.ts` 的 `SOLUTION_SECTIONS` canonical key 渲染 34 个受控 `Textarea`（不另立分节规则，防漂移）；保存以 `{...extras, [key]: tryStructured(text)}` 重建 body——非空节写入、空节省略，以 `{`/`[` 开头的文本尝试 `JSON.parse`（可直接粘贴结构化内容）、失败按原文存字符串不吞；34 分节之外的历史未知键（`extras`）原样带回并显式提示「保留 N 个契约外字段」供审计发现漂移（不静默丢弃）；显示「已填 n/34」计数徽章。
  - `src/components/admin/AdminSolutionFinancials.tsx` / `AdminSolutionUnknowns.tsx`（新，client）：行内「增删」——财务 `POST .../financial`（只提交非空十进制、要求至少一个数字字段）+ `DELETE .../financial/[id]`；关键未知变量 `POST .../unknown`（变量名必填、严重度 0–100 整数客户端先校验）+ `DELETE .../unknown/[id]`；保存后 `router.refresh()` 让服务端列表/计数重取（`unknownVariableCount` 由数据层事务内回写实时条数，不手动改本地 state）。
  - `src/components/admin/DeleteSolutionButton.tsx`（新，client）：`DELETE /api/admin/solutions/[id]`；`disabled={pending || orderCount>0}` 提前拦、被服务端守卫拒时如实回显 `fieldHints`（如「仍有 N 条订单，禁止删除」）；成功 `router.push("/admin/solutions")` 回列表。
  - `src/app/admin/solutions/[id]/page.tsx`（新，RSC）：`force-dynamic` + noindex；**layout+page 双层防御**——页首 `requireRole(STAFF_ROLES)`，越权 `return null` 前**绝不调用 `getAdminSolutionDetail`**（否则 Next 会为 leaf 段生成 RSC flight 泄露正文，Phase 6/12/13 反复踩过的坑）；`params` 为 Promise（Next16 必 `await`）；渲染状态/DEMO/未定价/需专业确认徽章 + 发布/删除按钮 + 基本信息表单 + 正文编辑台 + 财务卡片 + 未知变量卡片 + 审计脚注。`src/app/admin/solutions/page.tsx` 行尾加「编辑内容 →」链接进本页。无 schema 变更、无新写端点（全复用 M1）、无删除文件。
- 验证：`tsc`/`eslint` 0 错；新增集成测试 `tests/integration/admin-solution-detail.test.ts` **5 例**（真连 Neon，挂在一条真实 NEW_ENERGY/DEEP_CASE 案例上、含 DECISION 意图的价格「2999.00」草稿 + 一条 DEMO 关联方案）：① DRAFT 可读 + `price`/`priceDisplay`（¥ 前缀两位小数）+ body 结构 + 案例标题/行业中文名（非枚举字面量）② 财务 Decimal→字符串「1200000.00」/「42.50」/「3.50」、null 保留、createdAt 倒序、`financialCount` 一致 ③ 未知变量严重度 70/null 透传 + `unknownVariableCount` 实时 ④ DEMO 关联方案 `isDemo=true` ⑤ 有形但缺失 id 与「nope」均 `notFound`。基线 **249 单元 + 75 集成（70+5）** 全绿（324 总数）；`next build` 新增 `ƒ /admin/solutions/[id]` 动态路由、与 `ƒ /admin/solutions` 并列无回归。**后台内容编辑台端到端冒烟 33/33**（`smoke-admin-solutions-edit.mjs`，`next start -p 3126`，自种 USER/ADMIN + 一条 DEEP_CASE 案例，真实 Auth.js 登录）：详情页 SSR 含「基本信息 / 方案正文（34 分节）/ 财务测算 / 关键未知变量」四块；PATCH 正文 + 价格 200、编辑初值透传自 DB、价格回填 1888.00；新增财务/未知变量 200 且 capex 数字与「严重度 60/100」经 SSR 回读可见；发布带价方案 200；买家下单 200 后**删方案→409 且 reason 含「仍有…订单」**（守卫端到端，撤单/退款属 ROADMAP #5 支付域）；无订单的第二条草稿→删除 200、删后详情→404；跨站 Origin PATCH→403 CSRF；USER GET 详情→200 但「无访问权限」且**不泄露**正文块/财务编辑表单；未登录→307 跳 `/login`；不存在 id→404；finally 按 FK 序删 order→solution→case→user，四项 leftover=0。
- 效果：**Phase 13 M4 达成**——后台从"能建/发布方案"升级为"能完整录入一条可售方案的全部交付内容（正文 34 分节 + 财务测算 + 关键未知变量 + 删除）"，与 Phase 12 购买闭环、M3 发布动作合龙成一条真正可运营的竖切：录入 → 补正文 → 定价 → 发布 → 被下单 → 解锁读正文。仍是有意的最小竖切：案例详情页 / 证据增删 / 删除 的后台 UI、审核发布队列、成本看板、更细粒度权限矩阵留后续里程碑（M5+）。**不引入新外部依赖、不碰 schema**。

## [0.22.0] - 2026-09-05 · Phase 13 里程碑 3：后台「方案管理 UI」——方案从录入到可售的运营入口（消费 M1 写端点）

- 原因：Phase 12 刚打通「购买闭环」（下单→支付说明→后台确认→解锁），但**方案本身在后台还只能靠裸 API 建**——`prisma/seed.ts` 刻意不灌方案（Phase 5 裁决），Phase 13 M1 只给了 `/api/admin/solutions` 写端点、M2 只做了「案例列表+新建」的后台 UI。没有方案管理界面，就没人能真正把一条方案录入、定价、发布，"方案生成 → 用户查看 → 购买"这条链路对运营仍是断的。M3 补上后台方案运营入口，让刚建好的购买闭环真正可被端到端操作。（宪法优先级：商业闭环 > 用户价值 > 数据质量；一次一个明确任务，简单优先。）
- 内容：
  - `src/server/admin-solutions.ts`（新，server 读层）：`listAdminSolutions()` 返回**全量**方案（含 DRAFT / UNDER_HUMAN_REVIEW / 挂在 DEMO 案例上的方案——刻意区别于公开橱窗 `listPublishedSolutions` 只暴露 PUBLISHED），`updatedAt` 倒序；经 `include case` 带出挂靠案例标题/行业/`isDemo`（方案无 `sourceType`，DEMO 与否取决于关联案例），`_count` 带出 financials/unknowns/orders 数，价格用 `Decimal.toFixed(2)` 两位小数字符串（`price`+`priceDisplay`，未定价如实 null）；V1 不分页但设硬上限 `ADMIN_SOLUTION_LIST_LIMIT=500`、超出标 `truncated`（与 `admin-cases` 同构）。**不做鉴权**，信任调用方是已过 `requireRole` 的后台页面。
  - `src/components/admin/NewSolutionForm.tsx`（新，client）：`fetch` 到 `POST /api/admin/solutions`（**刻意走 HTTP 而非另起 Server Action**——门禁 + 判别联合翻译已收敛在 `api-guard` 一处，抄第二遍必漂移，第 16 条）。字段：标题 / slug / 挂靠案例（下拉，选项由服务端把 `listAdminCases` 结果作 props 传入，client 不 import server 模块）/ 价格（留空=未定价）/ 币种 / 英文名 / 高风险领域（逗号或换行分隔→数组）/ 摘要 / 「需专业确认」勾选。成功 `router.refresh()` 让列表重取（新方案以 DRAFT 出现）；400 `details.fields`→逐字段回显；无案例时禁用提交并引导去「案例管理」。
  - `src/components/admin/PublishSolutionButton.tsx`（新，client）：行内「发布」动作，`PATCH /api/admin/solutions/[id]` 带 `{status:"PUBLISHED"}`——发布守卫（缺价 / 涉高风险未勾专业确认）在**数据层**，被拦时端点回 409 `details.fields`，UI 如实回显「发布被拦：<原因>」，绝不假装成功。已发布则按钮转「已发布」禁用。成功后 `router.refresh()`。
  - `src/app/admin/solutions/page.tsx`（新，RSC）：`force-dynamic` + noindex；**layout+page 双层防御**（页首 `requireRole(STAFF_ROLES)`，越权 `return null`，绝不在无权限时调用 `listAdminSolutions`/`listAdminCases` 免敏感数据进 leaf flight）；渲染新建表单 + 全量方案卡片列表（状态/DEMO/未定价/需专业确认徽章、价格、挂靠案例、财务·未知·订单计数、发布按钮、详情页预览链接）。`src/app/admin/page.tsx` 在「解决方案」概览卡加 `方案管理（录入 / 定价 / 发布）→ /admin/solutions` 入口。无 schema 变更、无新写端点（复用 M1）、无删除文件。刻意只做「列表+新建+发布」最小闭环，正文 34 分节 / 财务 / 未知变量 / 删除的逐条子资源录入留 M4。
- 验证：`tsc`/`eslint` 0 错；新增集成测试 `tests/integration/admin-solutions.test.ts` **4 例**（真连 Neon）：① 内部态（DRAFT）+ DEMO 关联方案均可见（后台读层立身之本）+ `isDemo` 由关联案例判定 ② `price`/`priceDisplay`（¥ 前缀两位小数）/未定价 null + `financialCount`/`unknownVariableCount`/`orderCount` 与真实建表数一致 + `riskDomains`/`needsProfessionalReview` 透传 ③ 挂靠案例标题 + 行业映射为可读中文名（非枚举字面量）④ `updatedAt` 倒序全局不变式 + `total≥items`、`items≤LIMIT`、`truncated ⟺ total>items` 自洽。基线 **249 单元 + 70 集成（66+4）** 全绿、`next build` 新增 `ƒ /admin/solutions` 动态路由无回归。**HTTP 渲染 + 金钱 shot 端到端冒烟 33/33**（`smoke-admin-solutions.mjs`，`next start -p 3125`，自种 USER/ADMIN + 一条 DEEP_CASE 案例，真实 Auth.js 登录）：未登录 `/admin/solutions`→307 跳 `/login`；USER→200「无访问权限」且**不泄露**「新建方案」表单/「方案列表」；ADMIN→200 见「方案管理」+表单+列表；经 HTTP 建「未定价」草稿 200、建「带价」草稿 200、二者标题透传进 SSR 列表且显「未定价」徽章；**发布未定价草稿→409 CONFLICT 且 `details.fields.price` 指名「发布前必须填写价格」**（守卫端到端）；发布带价草稿→200、DB 复核 `status=PUBLISHED`+`publishedAt` 落库；**已发布方案标题透传进公开 `/solutions` 橱窗（打通"发布→可售→可被 Phase12 购买"闭环），未发布草稿不出现在公开橱窗**；非法入参→400 VALIDATION_ERROR、跨站 Origin→403 CSRF、未登录建方案→401；`/admin` 仪表盘见「方案管理」入口链接；finally 先按 caseId 收集全部 solutionId 再删 order→ChangeLog→solution→case→user，末尾方案/案例/用户三项 leftover=0。
- 效果：**Phase 13 M3 达成**——方案从"只能裸 API 建、无运营入口"升级为"后台可录入 / 定价 / 发布"，Phase 12 刚建好的购买闭环自此**真正可被端到端操作**：创始人能在后台把一条方案推到 `PUBLISHED`，它随即进入公开橱窗、可被下单-确认-解锁。仍是有意的最小竖切：方案详情页（正文 34 分节录入、财务测算、关键未知变量、删除）留 M4；证据级后台深化同属 M4。**不引入新外部依赖、不碰 schema**。

## [0.21.0] - 2026-09-05 · Phase 12 里程碑 3：购买闭环「用户界面」——详情页解锁门控 + 支付说明 + 我的订单 + 后台确认台

- 原因：M1 交付订单数据层、M2 打通 HTTP 端点，但用户侧仍是详情页那个 `disabled` 的「购买方案（即将开放）」假按钮——商业闭环「用户查看 → **购买** → 解锁」对人尚未真正闭合。M3 把 M2 的端点接上"人面"：详情页真购买、下单后进支付说明页、买家可回看「我的订单」、正文按 `hasPaidEntitlement` 服务端解锁门控、后台一键确认收款/取消。零 schema 变更、零新数据层逻辑，全部复用已测的 `orders.ts` + `api-guard`（宪法第 16 条单一真源）。
- 内容：
  - `src/server/solutions.ts`：`SolutionDetail` 加 `isFree: boolean`（`price` 为 null/undefined 或 `toNumber()===0` 即免费），供详情页判定「是否锁正文」。
  - `src/components/solutions/BuyButton.tsx`（新，client）：`fetch` 到 `POST /api/orders`，**只提交 `solutionId`**（身份服务端从会话注入、金额服务端快照，客户端一概不传，杜绝改价）；成功（含幂等复用）→ `router.push("/orders/<id>")`；409 已拥有→引导「我的订单」、401→登录、其它如实报错，绝不假装成功。刻意走 HTTP 而非另起 Server Action——门禁 + 判别联合翻译已收敛在 `api-guard` 一处，抄第二遍必漂移（第 16 条）。
  - `src/app/solutions/[id]/page.tsx`（改造）：服务端算 `entitled = isFree||isDemo ? true : await hasPaidEntitlement(...)`、`locked=!entitled`、`loginHref`（带 callbackUrl）；购买卡按四态渲染（免费/DEMO→正文开放徽章、已购→已解锁 + `#solution-body` 锚、待购登录→`BuyButton`、游客→登录引导）。**`SolutionBodySection` 加 `locked` 入参**：locked 时服务端**根本不渲染 34 分节**、只出「正文未解锁」锁面板（内嵌 `BuyButton`/登录 CTA），未付费者拿不到正文任何字节（前端无从绕过，正文是付费交付物）。
  - `src/app/orders/[id]/page.tsx`（新，RSC 支付说明页）：未登录 redirect /login（带 callbackUrl）；`getOrderById` 后**属主校验**（会话 userId 命中 或 归一 email 命中 `buyerEmail`），不匹配统一 `notFound()`（不区分「不存在」与「无权」，防 IDOR 探测）；展示 `amountDisplay` 快照 + 状态徽章 + **V1 站外付款三步指引**（未接网关，ROADMAP #5）；PAID→引导回详情页读已解锁正文。
  - `src/app/account/orders/page.tsx`（新，RSC 我的订单）：登录门禁 → `listOrdersForBuyer({userId,email})`（数据层按属主过滤，绝不显示他人单）；每卡状态徽章 + 金额 + 「去支付 / 查看正文」入口。`src/app/account/page.tsx` 加「我的订单」链接、更新「即将开放」文案。
  - `src/components/admin/AdminOrderActions.tsx`（新，client）：行内「确认收款 / 取消」，`fetch` M2 的 `/api/admin/orders/[id]/{confirm,cancel}`（CSRF + 角色 + 状态机全在既有端点），成功 `router.refresh()` 重取列表。`src/app/admin/orders/page.tsx`（新，RSC）：layout+page 双层防御自守（越权 `return null` 前绝不调 `listOrdersForAdmin`）、状态过滤 + 分页。`src/app/admin/page.tsx` 订单卡加「订单管理」入口。
  - V1 有意识的最小化 / 待记录假设：**只有 price>0 且非 DEMO 的方案正文才锁**（免费与 DEMO 恒开放）；**购买需登录**（游客 buyerEmail 数据层/端点支持，但 UI 不暴露游客下单）；不接支付网关，人工确认到账即解锁。无删除文件。
- 验证：`tsc`/`eslint` 0 错；`tests/integration/cases-solutions.test.ts` 扩 `isFree` 断言（¥1999 方案 `isFree=false`、新种 price=0 免费方案 `isFree=true` 且 found）——**基线 315（249 单元 + 66 集成）全绿**、`next build` 新增 **3 条 `ƒ` 动态路由**（`/orders/[id]`·`/account/orders`·`/admin/orders`）无回归。**购买闭环 UI 端到端冒烟 29/29**（`smoke-orders-ui.mjs`，`next start -p 3124`，自种 ¥3999 带正文标记方案 + 买家/管理员/路人三账号真实 Auth.js 登录）：钱-shot——**付款前游客/未购登录者/他人的详情页 HTML 全不含正文标记、显锁面板；后台确认 PAID 后仅属主再访问标记出现、锁面板消失、显「已解锁」，游客与他人仍不含标记**（正文从不泄露非属主，RSC 服务端拒渲染含 flight 负载）；下单后仍 PENDING 不解锁；支付说明页含金额 + 站外指引；**他人访问该单支付页 → 404**（防 IDOR 不泄露金额）；我的订单含本人单、路人不含金主单；`/admin/orders` USER→无权限面板、ADMIN 见单号；属主已购后不再出「立即购买方案」。finally 先收集本次 orderId 再删单→清审计→删方案/案例/用户，leftover=0（订单/审计/案例/用户四项）。
- 效果：**Phase 12 购买闭环全部达成（M1 数据层 + M2 端点 + M3 UI）**——「用户查看 → 购买 → 支付说明 → 后台确认 → 解锁读正文」这条商业闭环主干从用户侧端到端可用且经真实 HTTP + 服务端门禁验证成立，且解锁判定守住"钱与付费内容"的安全底线。仍是有意的最小版：**不依赖 ROADMAP #5 支付网关**（人工确认收款即解锁，在线支付/自动对账属后续增量）；退款（REFUNDED 态 UI）、企业批量授权、订单明细编辑留后。下一步候选：Phase 13 M3 后台 UI 深化（方案/证据管理）、Phase 9 Model Router（stub provider 可先搭）、Phase 14 SEO、§11 grade 并入可信度公式（须升 `SCORING_RUBRIC_VERSION`）。


 
## [0.20.0] - 2026-09-05 · Phase 12 里程碑 2：订单「HTTP 端点」——购买闭环经 HTTP 打通（复用 api-guard，不含 UI）

- 原因：M1 只交付了订单**数据层**（`src/server/orders.ts`），诚实标注「HTTP 端点延 M2」。数据层有函数无入口，用户点不动、后台确认不了，闭环仍断在「下单→确认」这一环。M2 就是把已测数据层用**已就绪的 `api-guard` 门禁**薄薄包一层 HTTP 端点——零业务逻辑、零 schema 变更，门禁 + 结果翻译全复用 M1/Phase13 沉淀的单一真源（宪法第 16 条防逐端点漂移）。UI（详情页真按钮 + 支付说明页 + 我的订单 + 正文按权益解锁门控）留 M3。
- 内容：
  - `src/server/api-guard.ts`（扩展，非另起炉灶）：把 `requireStaffWrite` 里的 CSRF 同源判定抽成共享纯函数 `sameOriginBlock(request)`（逻辑一字未改）；**新增 `requireSameOriginActor(request)`**——只做 CSRF 同源 + 从服务端会话注入 `userId/actor`，**不设角色门禁**（下单是"任何登录用户或游客"都能做的公开动作，与后台 staff 写明确分层）；`MutationLike` 显式补 `orderId?/deduped?/order?`（interface 无隐式索引签名，不补则 TS2345 不可赋值）。
  - `POST /api/orders`（新，公开/游客可下单）：`requireSameOriginActor` 挡跨站 → 解析 body → **先 `delete raw.userId/actor` 再 `{...raw, userId: guard.user?.id ?? undefined}`**（客户端伪造的 userId/actor 一律丢弃、身份只从会话注入）→ `createOrder` → `mutationResponse`。金额防篡改由 M1 数据层白名单守，端点不碰。
  - `GET /api/admin/orders`（新，staff 只读）：安全 GET 不做 CSRF，仅 `requireRole(STAFF_ROLES)`（未登录 401 / USER 403）+ `PaginationSchema` + 可选 `status` 过滤，调 `listOrdersForAdmin`。
  - `POST /api/admin/orders/[id]/confirm` · `POST /api/admin/orders/[id]/cancel`（新，staff 写）：`requireStaffWrite`（CSRF + 角色）→ 调 `confirmOrderPaid`/`cancelOrder`（actor 由会话注入）→ `mutationResponse`。
  - 4 路由全 `export const dynamic="force-dynamic"`、Next16 `params:Promise<{..}>` await、只「门禁→调数据层→翻译」，无任何业务/校验/schema。**`hasPaidEntitlement` 刻意不暴露为公开 HTTP 端点**（无额外面鉴权会引 IDOR），留 M3 在 RSC 页面服务端调用。无删除文件。
- 验证：`tsc`/`eslint` 0 错；`tests/unit/api-guard.test.ts` 扩到 **22 例**（`vi.mock` authz，新增 `requireSameOriginActor` 3 例：跨站→403 且根本不查会话、登录→ok+actor、游客→ok 且 user/actor 为 null、以及绝不触碰 `requireRole`；`mutationResponse` orderId/deduped/order 透传 1 例）。基线 **249 单元（245+4）+ 66 集成**全绿、`next build` 新增 **4 条 `ƒ` 动态路由**无回归。**HTTP 端到端冒烟 29/29**（`smoke-orders.mjs`，`next start -p 3123`，自种 case+PUBLISHED 方案(¥2999)+USER/ADMIN，真实 Auth.js 登录拿 cookie）：游客下单金额服务端快照=2999.00（客户端夹带 `0.01/USD/PAID` 全被剥离、DB 侧复核）、同游客重复下单幂等复用同 orderId 且 DB 仅 1 张、跨站 Origin 下单 403 CSRF、缺身份 400、登录用户伪造 userId 被会话覆盖、后台列表 401/403/200 门禁矩阵、确认 PAID+paidAt+version=2+UPDATE 审计 `changedBy=human:<adminId>`、重复确认幂等 deduped、已 PAID 买家再下单 409 blocked、取消 PENDING→CANCELED、取消已 PAID 409、跨站确认 403 CSRF、`status=PAID` 过滤 items 全 PAID；finally 先收集本次 orderId 再删单→清其 ChangeLog→删 solution/case/user，末尾 leftover=0（订单/审计/案例/用户四项）。
- 效果：**Phase 12 M2 达成**——「下单 → 后台确认 PAID」这条购买闭环主干从"只有数据层函数"升级为"经真实 HTTP、带会话身份、抗 CSRF、防篡改、防重复收钱、状态机守卫、全程审计"的可调用端点，M1 数据层自此获得首个真实外部消费者并端到端验证成立。仍是有意的最小竖切：面向用户的 UI（详情页购买按钮、支付说明页、「我的订单」、方案正文按 `hasPaidEntitlement` 解锁门控（price>0 才锁、免费保持开放——V1 假设））与后台订单管理页留 M3。**依旧不接、也不依赖 ROADMAP #5 支付网关**——人工确认（后台点确认收款）本身即跑通"下单→确认→（M3 可）解锁"，支付自动化对账属后续增量。




## [0.19.0] - 2026-09-05 · Phase 12 里程碑 1：订单「数据层」——购买闭环的可信底座（不含 HTTP/UI）

- 原因：商业闭环「用户查看 → **购买** → 企业适配 → 真实验证 → 项目机会」里，"购买"这一环至今只在详情页留了个 `disabled` 的「购买方案（即将开放）」占位（Phase 5 M2 埋的），链路是断的。创始人裁决 + 总控 §5/PRODUCT_SPEC 把 V1 购买流明确为**「下单 → 支付说明（站外、无网关）→ 后台人工确认 PAID → 解锁」**——刻意**不接支付网关**，用"后台把 PENDING 确认为 PAID"这一最简闭环先跑通商业链路。所以 ROADMAP #5（支付渠道）**不是本环的阻塞项**：阻塞的是自动对账/在线收款，人工确认可现在做。且 `Order` 表早在 Phase 4/5 随 schema 建好（状态机 + `amount Decimal` + `paymentProvider` 预留），**无需任何 schema 迁移**——这是当下价值最高、又不撞外部阻塞的一环，按「一次一个明确任务」先切**数据层竖切**（对齐 Phase 7 M5 / Phase 8 M1 的"数据层先行、HTTP+UI 后到"节奏），HTTP 端点留 M2、UI + 解锁门控留 M3。
- 内容：
  - `src/server/orders.ts`（新，server-only，判别联合返回、不抛裸异常、**不做鉴权**信任上层门禁）：
    - `createOrder(input, actor?)`：**金额只从服务端读取的 `Solution.price` 快照进 `Order.amount`（`decimal.toFixed(2)`，两位小数字符串，绝不用 JS 浮点），客户端传入的 `amount/currency/status` 因不在 Zod 白名单内被剥离**——"钱"的路径来源唯一、程序可复算（宪法第 7/20 条；否则用户可把 1999 改成 0.01 下单）。只能对 `status=PUBLISHED` 且 price 非空的方案下单（DRAFT/审核中/无价→`blocked`，与公开详情门控同口径）；`solutionId` 不存在→`invalid.solutionId`。身份 `userId`（登录，由上层会话注入透传）或归一小写 `buyerEmail`（游客）至少其一，否则 `invalid`（错误挂 `path:["identity"]`）。**同一买家对同一方案重复下单幂等去重**：已有一张 PENDING 直接复用返回 `{orderId, deduped:true}` 不新建（避免误点堆一堆待支付单）、已有 PAID 返回 `blocked`（不重复收钱）。落库 `$transaction`[建单 + `ChangeLog`(entityType=Order, action=CREATE, actor/reason/after)]。
    - `confirmOrderPaid(orderId, actor?)`：仅 `PENDING→PAID`，`paidAt` **只在首次落库**、再次确认幂等（`deduped:true`、不刷新时间戳），`version` 自增 + UPDATE 审计；非 PENDING 的 PAID/REFUNDED/CANCELED 终态不误伤（已 PAID 幂等、其它→`blocked`）。`cancelOrder`：仅 `PENDING→CANCELED`（V1 无退款流程，PAID 不可 cancel，属 #5）。
    - `getOrderById`（坏 cuid→not_found）、`listOrdersForBuyer`（`OR userId/buyerEmail` 找回名下、createdAt 倒序）、`listOrdersForAdmin`（`$transaction`[findMany skip/take, count]，状态可选过滤、分页自洽）、`hasPaidEntitlement`（**解锁判定**：数该买家在此方案下是否存在 PAID 单；无身份 / DB 异常一律保守返回 `false`——宁可少放行也不错误赠送付费内容）。
    - Prisma 写错误归一：P2003→`invalid(relation)`、P2025→`not_found`；`amountDisplay` 按币种加 ¥/$ 前缀。
  - 无 schema 变更、无新 HTTP 端点（延 M2 走 `api-guard`，届时给 `MutationLike` 补 `orderId/deduped` 字段）、无 UI、无删除文件。
- 验证：`tsc`/`eslint` 0 错；新增 `tests/integration/orders.test.ts` **10 例**（真连 Neon）——① 金额服务端快照（夹带 `amount:"0.01"/currency:"USD"/status:"PAID"` 全被剥离，订单实得 `1999.00 CNY ¥1999.00`、status 仍 PENDING、CREATE 审计=1）② 缺身份→`invalid.identity` ③ DRAFT 方案→`blocked` ④ 不存在方案→`invalid.solutionId` ⑤ 同买家重复下单幂等复用同一 orderId、DB 仅 1 张 ⑥ confirmPaid 首落 paidAt·version=2·UPDATE 审计=1、二次确认幂等 paidAt 不变 ⑦ 已 PAID 再下单→`blocked` ⑧ PAID 不可 cancel（blocked）、新 PENDING 可 cancel→CANCELED ⑨ `hasPaidEntitlement` 确认前 false / 确认后属主 email true / 陌生人 email false / 无身份 false ⑩ 买家列表按 email 找回且全属该方案 + 后台按 PAID 过滤 + pageSize=1 时 `hasNext ⟺ total>1` 自洽 + `getOrderById` found/not_found；新增 `tests/unit/orders-schema.test.ts` **7 例**（无 DB，`vi.mock` prisma）锁 schema 契约（白名单剥离 amount/status/currency/price、身份二选一、邮箱归一小写、buyerType 缺省 INDIVIDUAL 与枚举、solutionId cuid 形状）。基线 **245 单元（238+7）+ 66 集成（56+10）** 全绿、`next build` 无回归（数据层不新增路由）。**修测记录（不掩盖，宪法第 20 条）**：集成测试 ⑨ 首次把反例邮箱写成 `buyerEmail`，但该邮箱在 ⑥ 已真实确认过 PAID，故 `hasPaidEntitlement` 返回 `true` 是**代码正确、断言错**——改用从未下过单的 `stranger-${runId}` 作非属主反例后 10/10 绿。
- 效果：**Phase 12 M1 达成**——购买闭环从"详情页一个禁用的假按钮"升级为一层守住钱与安全的数据底座：金额不可篡改、只对可售方案开放、重复下单幂等、状态机 + 审计 + 保守的解锁判定俱备。仍是有意的最小竖切：用户下单 HTTP 端点、后台确认/取消/列表端点（M2，复用已就绪 `api-guard`）、详情页真按钮 + 支付说明页 + 「我的订单」+ 方案正文按 PAID 权益解锁门控（M3）待接。**不依赖、也不解锁 ROADMAP #5 支付网关**——人工确认闭环本身即可端到端跑通"下单→确认→解锁"，支付自动化属后续增量。



## [0.18.0] - 2026-09-05 · Phase 13 里程碑 2：最小后台管理 UI（案例「列表 + 新建」竖切，消费 M1 写端点）

- 原因：Phase 13 M1 把后台写门禁收敛成 `/api/admin/**` 一批已鉴权、抗 CSRF 的 HTTP 端点，但**造了还没人用**——没有真实调用方既浪费、也无法端到端验证门禁在浏览器同源场景下真的成立（宪法第 20 条：不虚构"已完成"）。「方向一：把案例/方案 CRUD 包成后台 HTTP 写路由 + 最小后台 UI」还剩另一半：一个能录入并浏览案例的最小后台页面。刻意只切**「案例列表 + 新建」这一条闭环**（MVP / 简单优先，一次一个明确任务），详情页/证据增删/删除案例/方案管理全部留 M3。
- 内容：
  - `src/server/admin-cases.ts`（新，server 读层）：`listAdminCases()` 返回**全量**案例（含 CANDIDATE/KEY_RESEARCH 等内部阶段 + DEMO 夹具），按 `updatedAt` 倒序，`_count` 关联带出证据数/方案数，行业 enum→可读名/slug；V1 不分页但设硬上限 `ADMIN_CASE_LIST_LIMIT=500`、超出如实标 `truncated=true`（无界拉全表的兜底，非静默丢弃）。**本模块不做鉴权**——信任调用方是已过 `requireRole` 门禁的后台页面（页面仍双层防御自守）。之所以不复用公开 `listPublicCases`：那是给「用户查看→购买」的商店橱窗，刻意排除内部阶段与 DEMO；后台运营要看的是全量真相，否则刚录的候选案例会"消失"、误判没写进去。
  - `src/components/admin/NewCaseForm.tsx`（新，client）：录入表单，`fetch` 到 `POST /api/admin/cases`（**刻意走 HTTP 端点而非另起 Server Action**——否则要把 M1 的 requireRole + CSRF + 结果翻译逻辑抄第二遍、必然漂移，违反第 16 条单一真源；且让端点获得真实调用方）。成功 `router.refresh()` 让服务端列表重取（无需手动拼列表）；端点回 400 `details.fields` → 逐字段回显（与数据层 Zod 同口径，UI 不另立校验）；401/403/500 → 顶部 Alert 如实报错，绝不假装成功。**注意**：把可序列化的行业/阶段选项从服务端 page 作 props 传入，client 组件不 import 任何 server 模块（避免把 prisma/authz 打进浏览器包）。
  - `src/app/admin/cases/page.tsx`（新）：`force-dynamic` + noindex；**layout+page 双层防御**（沿用 Phase 6 M2 教训）——页首 `requireRole(STAFF_ROLES)`，越权 `return null`，绝不在无权限时调用 `listAdminCases` 以免敏感数据被序列化进 leaf RSC flight；渲染 `NewCaseForm` + 全量案例卡片（DEMO/阶段/行业徽章、版本·日期、证据/方案数、机会分·可信度）。
  - `src/app/admin/page.tsx`：「内容入口」卡加 `案例管理（录入 / 浏览全量）→ /admin/cases` 链接。
  - 无 schema 变更、无新写端点（复用 M1）、无删除文件。
- 验证：`tsc`/`eslint` 0 错；新增集成测试 `tests/integration/admin-cases.test.ts` **4 例**（真连 Neon）：① 内部阶段 + DEMO 夹具均可见（后台读层区别于公开橱窗的立身之本）② `evidenceCount`/`solutionCount` 与真实建表数一致 + 评分透传 ③ `updatedAt` 倒序全局不变式 + `total/items/truncated` 自洽 ④ 行业映射为可读中文名而非枚举字面量。基线 **238 单元 + 56 集成（52+4）** 全绿、`next build` 新增 `ƒ /admin/cases` 动态路由无回归。**HTTP 渲染端到端冒烟 18/18**（`smoke-admin-ui.mjs`，`next start -p 3122`，自种 USER/ADMIN + 一条唯一标题案例走真实 Auth.js 登录）：未登录 GET `/admin/cases`→307 跳 `/login` / USER→200「无访问权限」且**不泄露**「新建案例」表单与真实案例标题（证 page 自守挡在数据前）/ ADMIN→200 见「案例管理」+「新建案例」表单 +「案例列表」，且**服务端 `listAdminCases` 的真实标题透传进 SSR HTML**（DB→Server 组件→HTML 端到端）/ `/admin` 仪表盘出现「案例管理」入口链接；finally 硬删临时数据、末尾 leftover=0。
- 效果：**Phase 13 M2 达成**——后台从"只有 API"补上"能用的人面"，运营可真正登录后台录入并浏览全量案例，M1 的写门禁由此获得首个真实消费者、并在同源浏览器场景下端到端验证成立。仍是有意的最小竖切：详情页/证据增删/删除案例/方案管理留 M3（复用已就绪的 M1 端点即可，主要是 UI 工作量）。购买闭环仍阻塞 ROADMAP #5 支付。

## [0.17.0] - 2026-09-05 · Phase 13 里程碑 1：后台「写」HTTP 端点（requireRole + CSRF 统一门禁）

- 原因：Phase 7 M5（案例 CRUD）、Phase 8 M1（方案 CRUD）两期数据层当时刻意都留了一句「**不做鉴权、HTTP 写路由延 Phase 13**」——没有可信门禁就上线公开写端点违反安全底线（宪法优先级：安全/数据质量 > 功能数量）。Phase 6 M2 的 `requireRole` 原语与 layout+page 双层防御经验已就绪，这一层把「谁在写」收敛到**一处**，让 `/api/admin/**` 写端点共用同一套 CSRF 同源 + 角色门禁 + 结果翻译，为 Phase 13 M2 后台 UI（以及 Phase 8 M4 AI 流水线的服务端写入）提供安全入口。**这一步是"方向一：把案例/方案 CRUD 数据层用 requireRole 包成后台 HTTP 写路由"的安全地基**；最小后台 UI 拆到 M2。
- 内容：
  - `src/server/api-guard.ts`（新）：后台写端点的**唯一门禁 + 翻译点**（宪法第 16 条单一真源，防逐端点漂移）。
    - `actorOf(user)` → `human:<userId>`（actor **只从服务端会话**派生，绝不接受客户端传入的 actor/role，宪法第 20 条）。
    - `isSameOrigin(originHeader, reqHost)` 纯函数：无头信息放行（真正防线是会话 cookie 的 `SameSite=Lax` + 鉴权）、有头则 host 必须精确相等、解析失败按不安全拒绝（SECURITY：CSRF 判定禁止口算，拆纯函数便于单测锁边界）。
    - `requireStaffWrite(request)`：先 CSRF 同源（Origin 优先、退化到 Referer 的 origin；跨站直接 403、**根本不查角色**），再 `requireRole(STAFF_ROLES)`——未登录 401、USER 越权 403（透出 `required`）；通过返回 `{ok,user,actor}`。
    - `mutationResponse(result)`：把数据层判别联合统一翻译成 HTTP——`ok`→200 `{ok:true,...派生字段}`（剔除 status、透出 caseId/solutionId/evidenceId/financialId/unknownId/recompute）、`invalid`→400 VALIDATION_ERROR（`details.fields`）、`not_found`→404、`blocked`→409 CONFLICT、`error`→500（生产屏蔽原始 message）。`errorResponse`/`readJsonSafe`（非法 JSON→400）配套。
  - 10 个薄封装写路由（每个仅 `requireStaffWrite` → 解析 body → 调既有数据层 → `mutationResponse`，`export const dynamic="force-dynamic"`）：案例 `POST /api/admin/cases`、`PATCH|DELETE /api/admin/cases/[id]`、`POST /api/admin/cases/[id]/evidence`、`DELETE /api/admin/cases/[id]/evidence/[evidenceId]`；方案 `POST /api/admin/solutions`、`PATCH|DELETE /api/admin/solutions/[id]`、`POST|DELETE .../financial[/[financialId]]`、`POST|DELETE .../unknown[/[unknownId]]`。**零业务逻辑、零 schema 变更**——校验/审计/守卫/复算全在已测数据层，路由只加门禁与翻译。
- 验证：`tsc`/`eslint` 0 错；新增 `tests/unit/api-guard.test.ts` **18 例**（`vi.mock` authz）：`isSameOrigin` 无头/同源/跨站 host·端口·子域/解析失败/空串 + `actorOf` + `mutationResponse` 五态映射与默认兜底 + `errorResponse` 两形态 + `requireStaffWrite` 组合（跨站先挡且不查角色 / 未登录 401 / USER 403 带 required / ADMIN 放行注入 `human:<id>` / 无 Origin 但同源 Referer 放行 / 跨站 Referer 拒）。基线 **238 单元（220+18）+ 52 集成**全绿、`next build` 新增 10 条 `ƒ /api/admin/**` 路由无回归。**HTTP 端到端冒烟 24/24**（`next start -p 3121`，直插 USER/REVIEWER/ADMIN 三账号走真实 Auth.js 登录拿 cookie）：未登录写案例→401 UNAUTHORIZED / USER→403 FORBIDDEN 且透出 `required` / ADMIN 跨站 Origin→403 含 CSRF 字样 / 非法入参→400 VALIDATION_ERROR / ADMIN 全链路写成功（建案例 200 + `ChangeLog.changedBy=human:<adminId>` 服务端注入审计 + 改案例 + 加证据带 recompute + 删证据 + 建方案 DRAFT + 加关键未知量后 `unknownVariableCount=1` + 删后回落 0 + 删方案 + 删案例），finally 硬删全部临时数据、末尾确认 leftover=0。**踩坑**：冒烟用 `127.0.0.1` 作 host 时 `request.url` 被 Next 归一化后与 Origin `host` 不同源导致全量 CSRF 误拒，改 `localhost` 一致后全过（同源判定 host 精确相等的现实体现）。
- 效果：**Phase 13 M1 达成**——「案例/方案 CRUD」从"只有数据层"升级为"受鉴权、抗 CSRF、口径统一的可信 HTTP 写 API"，兑现 M5/M8-M1 两期数据层的安全承诺，为后台 UI 与 AI 流水线服务端写入扫清门禁障碍。**仍不含限流/幂等**（V1 延后，见 ROADMAP）；更细粒度权限矩阵（按资源/动作）随需要再补。下一步：Phase 13 M2 最小后台管理 UI（表单消费本批端点）、Phase 8 M3 方案评分内核（须走 SCORING §5 升版）；购买闭环仍阻塞 ROADMAP #5 支付。

## [0.16.0] - 2026-09-05 · Phase 8 里程碑 2：方案 34 分节正文（Solution.body）结构化渲染

- 原因：总控 §3「产业解决方案 Solution Package」**已逐字给定一份可售方案的 34 个分节**（项目名称…AI 假设标注），ROADMAP §8 的「Solution.body 34 分节规范」正是这一节——无需另等裁决。M1 已能写入 `Solution.body`（`z.record(z.string(), z.unknown())`），但详情页仅在 `body` 为空时显示一句占位、有 body 时**不渲染**，用户看不到「买的是什么」。M2 补齐展示契约：把任意入库 body 归一成固定 34 分节有序视图并渲染，让「方案详情」从"摘要+数字"升级为"结构化正文包"，直接服务商业闭环里的「用户查看→理解价值→购买」环节。刻意**不动 schema、不开 HTTP 写端点、不等真实流水线**（后者属 M4 + ROADMAP #4 模型 Key）。
- 内容：
  - `src/server/solution-body.ts`（新，纯函数、零 DB、零 Next 依赖）：`SOLUTION_SECTIONS` 常量表——34 分节的**单一真源**（`key` 稳定英文标识 + `title` 照抄总控 §3 中文标题）。`parseSolutionBody(body)` 把任意输入归一为固定 34 节有序数组：按 `key` 或中文 `title` 命中即 `filled`、取到内容；空串/空数组/空对象/`null`/`undefined` 视为未填 `pending`（但数字 `0`/布尔 `false` 算有内容，绝不当空丢掉）；落在 34 节之外的未知键收进 `extras` 供审计透出、**不静默丢弃**；另回 `filledCount/totalCount/empty`。传非对象（含 null）判 `empty=true`、全 pending。规则 12「结构化保存而非纯文章」+ 宪法第 16 条单一真源。
  - `src/server/solutions.ts`：`getPublishedSolutionById` 的 `SolutionDetail` 增 `body: ParsedSolutionBody` 字段（保留 `hasBody`），返回前对库中 `Solution.body` 调 `parseSolutionBody` 归一——数据层做薄透传、语义全在纯函数（避免录入端与展示端两套规则漂移）。
  - `src/app/solutions/[id]/page.tsx`：新增 `SolutionBodySection` + `renderSectionContent`——`empty` 时显示**诚实占位**（说明正文须走多角色流水线、禁单模型直出，与 Phase 7 M3 `scoreBreakdown=null` 占位同构）；有内容时按 canonical 顺序渲染 34 张分节卡（`Badge` 显「分节完成度 n/34（%）」），未填节标「待补充」不臆造，`extras` 以一行小字提示契约外字段。内容渲染兼容字符串成段 / 标量直显 / 数组列点 / 对象转键值。
  - **刻意保留的可控冗余**（已在代码注释标注）：成本模型/收入模型/ROI/回收期/关键未知变量/来源等节在详情页另有结构化卡片（`SolutionFinancial`/`UnknownVariable`/`Evidence`）——结构化卡为可复算真源、body 分节为叙述说明，待真实流水线接入后再收敛，不在 M2 提前优化。
- 验证：`tsc`/`eslint` 0 错；unit **220/220**（209 + 新 `solution-body.test.ts` 11 例：常量恰 34 节且顺序稳定 / null 及非对象判空 / 按 key 命中 / 按中文 title 命中 / 空值判 pending / 0 与 false 算有内容 / extras 不静默丢弃且空未知键不入 / key 优先于 title / 顺序严格等于常量表 / 全填满 34）；integration **52/52** 无回归；`next build` 路由清单不变（无新增 HTTP 端点）。**HTTP 渲染端到端冒烟 15/15**（`next start -p 3111` + 临时「已发布+带 body」方案挂既有 DEMO 案例，验证后即硬删）：有 body 页 200 且出「方案正文」+完成度徽章 + key/中文 title/数组/嵌套对象各类型内容 + 未填节「待补充」+ extras 审计提示；空 body 页出诚实占位、不含完成度徽章；临时数据清理干净（leftover=0）。精确 `filledCount` 由单测锁定，HTML 侧只断言徽章标签存在（SSR 会在动态文本间插注释节点，不宜正则匹配 `5/34`）。
- 效果：**Phase 8 M2 达成**——方案详情页具备 34 分节结构化正文的展示能力，「用户查看」能直观看到一份 Solution Package 的完整骨架与当前完成度。无 schema/DB 变更。下一步：Phase 8 M3 方案评分内核建模（含 SCORING §5 升版）/ M4 AI 多角色流水线灌真实方案（阻塞 ROADMAP #4 模型 Key）；HTTP 写路由 + 后台 UI 延 Phase 13；购买闭环延 Phase 12（阻塞 #5）。

## [0.15.0] - 2026-09-05 · Phase 8 里程碑 1：方案数据层 CRUD（受校验写入 + 审计 + 发布守卫）

- 原因：Phase 5 里程碑 2 刻意**不灌 DEMO 方案**（方案涉及定价/购买，宪法第 20 条：真数据必须走真实多角色流水线），因此方案表当前 0 行、"案例→方案→购买"闭环卡在**没有真实写入口**。Phase 7 M5 已把案例侧的 CRUD 数据层打样（`src/server/case-admin.ts`），Phase 6 M2 又备好鉴权原语——横向复制同样模式给方案，就能让 Phase 8 M2+ 的多角色 AI 流水线与 Phase 13 后台 UI 有真实落地路径。M1 只交付**数据层**（server-only，不开 HTTP 写端点），沿用 M5 一致的边界与错误策略避免"两处口径漂移"。
- 内容：
  - `src/server/solution-admin.ts`（新，server-only 注释）：`createSolution`（强制 DRAFT，走 publishGuard 才能升态）/`updateSolution`（version 自增、支持状态迁移、`publishedAt` 只在非 PUBLISHED→PUBLISHED 首次打时间戳）/`deleteSolution`（安全守卫：任一 Order 关联 → `blocked`，V1 无退款流程属 ROADMAP #5）/`addSolutionFinancial`/`removeSolutionFinancial`（Decimal 一律 string 输入避免 JS 浮点污染）/`addSolutionUnknown`/`removeSolutionUnknown`（自动同步 `Solution.unknownVariableCount` = 表内实时条数，规则 6/9：不确定性显式列出）。每个写操作 `$transaction` [写库 + 写 `ChangeLog`(entityType=Solution, CREATE/UPDATE/DELETE + before/after + actor + reason)]。
  - **发布守卫 `publishGuard`**（宪法第 21 条）：升 PUBLISHED 时若 price 为 null 或"列了 riskDomains 却没勾 needsProfessionalReview" → 返 `blocked` 且**不改状态不落 publishedAt**；guard 的 fieldErrors 指名缺失字段。测试用例覆盖两种 blocked 分支 + 一次成功发布 + 二次更新不刷新 publishedAt。
  - **不做**（诚实）：不自动计算 Solution 的 opportunityScore/evidenceConfidence——方案侧评分公式形态未定（可能引入"复用度""供应链复杂度"等新维度），属公式变更须走 SCORING §5 升版流程，M1 留 null 或人工填；`unknownVariableCount` 是唯一自动派生的标量（可计算事实）。
  - 边界：本模块**不做鉴权**，`actor` 仅审计标注非已鉴权；对外 HTTP 写路由统一延后 Phase 13（M2 `requireRole` 原语已就绪，届时薄薄一层包起来即可）。Prisma 错误归一：P2002→`invalid`（多为 slug 撞）、P2003→`invalid.relation`（case FK）、P2025→`not_found`；判别联合返回，绝不抛裸异常。
  - `tests/integration/solution-admin.test.ts`（新，9 例真连 Neon）：createSolution 成功建 DRAFT + 落 CREATE 审计（price Decimal `toFixed(2)` 比对，Prisma Decimal 默认去尾零）/ slug 冲突 P2002→invalid / case 不存在（合法 cuid 格式但库无行）→invalid+fieldErrors.caseId / version 1→2 + UPDATE 审计 + 空 patch 拒绝 + 不存在 id→not_found / 无价格升 PUBLISHED → blocked / 有 riskDomains 未勾 review → blocked（消息含"高风险领域"）/ 全条件通过升 PUBLISHED 且 publishedAt 落库 + 二次更新不刷新时间戳 / deleteSolution 有 Order → blocked→撤单后成功 + 级联删 financial+unknown + DELETE 审计 / removeSolutionFinancial + removeSolutionUnknown 归属回查 + unknownVariableCount 自动回写。afterAll 严格按外键序（order→solution→case→changeLog 兜底）+ runId 兜底清理。
- 验证：`tsc`/`eslint` 0 错；unit **209/209** 无回归；integration **52/52**（43 + 新 9，真连 Neon）；`next build` 无回归，路由清单不变。无 schema/DB 变更（M1 纯服务层）。
- 效果：**Phase 8 M1 达成**——方案聚合根（方案 + 财务 + 未知变量）具备受校验、可审计、可发布的写入能力，"案例→方案"数据入口打通。下一步：Phase 8 M2 方案详情页展示对齐 / M3 方案评分内核建模（含 SCORING §5 升版）/ M4 AI 多角色流水线灌真实方案；HTTP 写路由 + 后台 UI 延 Phase 13。

## [0.14.0] - 2026-09-05 · Phase 6 里程碑 2：RBAC 鉴权原语 + /admin 后台门禁（双层防御）

- 原因：M1 只解决"是谁"（认证），总控 §13 明确要求"后台必须有权限控制 + 管理员操作记录 Audit Log"；且 Phase 7 M5 案例 CRUD 数据层当时刻意**不暴露** HTTP 写端点，正是缺这层可信门禁。M2 补上"能干什么"（授权），既是独立安全里程碑，也解锁后续后台写路由（Phase 13）与订单确认（Phase 12）。
- 内容：
  - `src/server/authz.ts`（新，server-only）：鉴权原语。`hasRole(role, allowed)` 纯函数（权限单元测试主战场，不碰会话）；`getCurrentUser()` 从 JWT 会话读取身份（**绝不信任客户端传入 role**）；`requireUser()`/`requireRole(allowed)` 返回判别联合 `{ok:true,user} | {ok:false,reason:"unauthenticated"|"forbidden",required}`，越权记 `warn` 审计（只记 id/角色，不涉敏）。导出 `STAFF_ROLES=[REVIEWER,ADMIN]`。
  - `src/server/admin.ts`（新）：`getAdminDashboardData()` **只读聚合**（不含鉴权）——案例/方案/用户/证据/订单计数与分维度分布 + 最近 ChangeLog 流水。**总数直接由各维度 groupBy 求和得出**（不再另发 count()），既少 4 次查询、又天然满足"分布之和≡总数"自洽不变式（并发写入下两边不打架）。
  - `src/app/admin/layout.tsx`（新，force-dynamic + noindex）：可见 UI 层门禁——未登录 `redirect("/login")`；越权渲染"无访问权限"`Alert(danger)` 且**不渲染 children**；通过则渲染后台顶栏（角色徽章 + 邮箱 + 退出/账号链接）。
  - `src/app/admin/page.tsx`（新）：运行概览仪表盘（六张统计卡 + 最近审计流水表，全部实时 DB 数字，诚实展示）。**关键安全修正**：页面在拉任何数据前**先自鉴权**（`requireRole` 不通过 → `return null`），与 layout 构成**双层防御**。HTTP 冒烟实测发现：仅靠 layout 拦截时，Next 仍会为 leaf page 段生成 RSC flight 负载，导致越权用户的 HTML 里泄露概览内容——页面自守后 `getAdminDashboardData` 根本不执行，敏感聚合绝不进响应；`metadata.title` 亦改为中性"管理后台"避免可探测指纹。
  - `src/app/account/page.tsx`：`hasRole(profile.role, STAFF_ROLES)` 条件显示"进入管理后台"入口（普通用户不可见）。
  - `scripts/promote-user.ts` + npm `user:promote`（新）：运维受控提权 CLI（`user:promote -- <email> <USER|REVIEWER|ADMIN>`），只改 role 一列、email 归一小写、角色须合法、账号不存在即报错退出不自动建号。注册入口仍永远只建 USER，提权是本机运维动作，不建公开改角色端点。
  - 测试：`tests/unit/authz.test.ts`（新，15 例，`vi.mock("@/auth")` 固定会话）覆盖 hasRole 真值矩阵、STAFF_ROLES 守护、getCurrentUser（含缺 id 保守拒绝）、requireUser、requireRole 的 unauthenticated/forbidden/ok 三分支；`tests/integration/admin.test.ts`（新，4 例，真连 Neon）覆盖四维 groupBy 之和≡total、提权账号体现于 byRole.ADMIN、已发布方案体现于 byStatus.PUBLISHED 且夹具审计可被 recentChanges 查到、recentLimit 截断生效。
- 验证：`tsc`/`eslint` 0 错；unit **209/209**（194 + 新 15）；integration **43/43**（39 + 新 4，真连 Neon）；`next build` 新增 `ƒ /admin`（动态）无回归；**HTTP 门禁端到端冒烟 15/15**（`next start -p 3111`：未登录 `/admin`→3xx 跳 /login；普通用户→200 且含"无访问权限"、**不泄露**"运行概览"/"最近审计流水"；管理员→200 含概览与审计表、顶栏"管理后台"+"管理员"、不显示"无访问权限"）。
- 效果：**Phase 6 M2 达成**——授权层落地且经 HTTP 验证，/admin 为总控 §13"后台权限控制 + 审计"的首个真实受保护面；M5 数据层 CRUD 的 HTTP 化与订单确认从此有了可复用的 `requireRole` 前置。下一步：以 `requireRole` 保护案例 CRUD 写路由（Phase 13）、Phase 8 方案系统（方案须走真实多角色流水线产出，禁伪造；购买闭环阻塞于 ROADMAP #5 支付）。

## [0.13.0] - 2026-09-05 · Phase 7 里程碑 5：案例与证据数据层 CRUD（受校验写入 + 审计 + 复算联动）

- 原因：此前案例只能靠 `prisma/seed.ts` 批量灌 DEMO，运营/AI 流水线无法逐条撰写真实案例（ROADMAP Phase 7「案例系统」后续待做 = 案例 CRUD）。M5 先交付**数据层**写入口，把"能读能展示"升级为"能全生命周期管理"，为 Phase 13 后台与 AI 生产链路打底。
- 内容：
  - `src/server/case-admin.ts`（新，server-only）：`createCase`（可内联证据）/`updateCase`（version 自增）/`deleteCase`（安全守卫：仍挂 PUBLISHED 方案 → `blocked` 拒绝，删前快照）/`addCaseEvidence`/`removeCaseEvidence`。入参经 Zod 校验（复用 `validation.ts` 枚举单一真源；`scoreInput` 只校结构，10 维齐全/越界交由评分内核在复算时裁决，避免两处口径漂移）。每个写操作在事务内落 `ChangeLog`（entityType=Case，CREATE/UPDATE/DELETE，含 before/after 快照与 `actor`）。凡影响评分的写入（scoreInput/证据增删）自动调用 `recomputeCaseScores` 联动复算，结果以 `recompute: computed|skipped|invalid|none|error` 如实回报。**关键边界**：本模块**不做鉴权**、信任调用方；对外 HTTP 写路由与角色门禁有意延后到 Phase 13（无鉴权公开写端点违反安全底线，宪法第 2/4 条）；`actor` 仅作审计标注不代表已鉴权。统一判别联合返回（invalid/not_found/blocked/error），Prisma P2003/P2025 归一，绝不抛裸异常。
  - `tests/integration/case-admin.test.ts`（新，8 例，真连 Neon）：最小建案（CANDIDATE+CREATE 审计）、带 scoreInput+内联证据（computed 88/69/2、DEEP_CASE 详情页透传拆解）、非法行业不落库、评分输入越界仍建成但 recompute=invalid 无 breakdown、update version 自增+审计+空 patch 拒绝+不存在 not_found、证据增删联动可信度变化与还原+两条 UPDATE 审计、deleteCase 挂 PUBLISHED 方案 blocked→撤方案后成功+级联删证据+DELETE 审计、不存在 id not_found。afterAll 按 Restrict 外键序（先方案后案例）+ runId + ChangeLog 全清。
- 验证：`tsc`/`eslint` 0 错；unit **194/194**；integration **39/39**（原 31 + 新 8，真连 Neon）；`next build` 无回归。无 schema/DB 变更（M5 纯服务层）。
- 效果：**Phase 7 M5 达成**——案例聚合根（案例 + 证据）具备受校验、可审计、复算联写的写入能力，Phase 7「案例系统」的 CRUD 项在数据层闭环（UI/门禁留待 Phase 13）。下一步：行业关联收尾、把 §11 grade 并入可信度公式的后续待决、Phase 8 方案系统。

## [0.12.0] - 2026-09-05 · Phase 7 里程碑 4：§11 证据来源权威度分级（元数据 + 标签，不动分数）

- 原因：总控 §11 按来源权威性分 S/A/B/C/D，与已建模的证据"类型"轴正交。创始人 2026-09-05 裁决「只记录 + 标签，不动分数」——先让等级可存、可查、可见，并暴露"仅 D 级支撑却称事实"的复核告警，但暂不并入可信度公式（避免无校准地改动已上线分数）。
- 内容：
  - `prisma/schema.prisma`：新增 `enum EvidenceGrade`（S/A/B/C/D）与 `Evidence.grade EvidenceGrade?`；纯加性迁移 `20260905110000_add_evidence_grade` 已 deploy Neon（表数仍 18，枚举 12→13）。
  - `src/lib/validation.ts`：`EvidenceGradeSchema = z.enum(["S","A","B","C","D"])`。
  - `src/server/cases.ts` + `src/app/cases/[id]/page.tsx`：证据透出 `grade`；详情页每条证据叠一个来源等级徽章（S=success/A=info/B=primary/C=warning/D=danger「来源 D·AI推断」），并对存在 D 级、尤其"FACT 仅 D 级支撑"给 `Alert` 复核告警。公式与 `SCORING_RUBRIC_VERSION` 保持 1.0.0，历史 `scoreBreakdown` 仍有效解析。
  - `prisma/seed.ts`：6 个 DEMO 案例 16 条证据补 `grade` 并在 create 落库（保留 ai_vision 的 FACT=D 以演示"事实被 D 级支撑"告警）。
  - 测试：`validation.test` +1（等级 5 值）；`db-smoke` 枚举 12→13；`cases-solutions.test` 断言 `getPublicCaseById` 随证据透传 grade（FACT→A、PREDICTION→D）。`docs/SCORING_V1.md` §4 缺口#1 记为"已建元数据、暂未并入打分"。
- 验证：`tsc`/`eslint` 0 错；unit **194/194**；integration **31/31**（真连 Neon）；`next build` 无回归；`db:seed` 后 grade groupBy 实测 A1/B2/C2/D10/S1=16，`db:recompute-scores` 6 computed / 0 error；HTTP 冒烟 `GET /cases/demo_case_biogas?demo=1` 实测渲染「来源 D」「来源 B」徽章与「存在 AI 推断 / 待验证来源（D 级）」告警，health 报 0.12.0。
- 效果：**Phase 7 M4 达成**——来源权威度分级可记录、可查询、可展示，D 级不得当已确认事实的宪法约束在 UI 层落地为显式告警。下一步：案例 CRUD、行业关联、把 grade 并入可信度公式的后续待决（属公式形态变更，须走 §5 升版）。

## [0.11.0] - 2026-09-05 · Phase 7 里程碑 3：评分拆解上详情页（可审计展示 + DEMO 端到端）

- 原因：M2 已把 `scoreInput`（输入）与 `scoreBreakdown`（可复算输出）落库，但用户界面尚未展示——评分仍是一个不可解释的标量。M3 把拆解搬到案例详情页，让"机会分从哪些维度来、证据有多强、有多少关键未知变量"对用户可见（宪法第 6/7/9 条），并给 DEMO 种子补输入使 `?demo=1` 能端到端演示。
- 内容：
  - `src/server/cases.ts`：`CaseDetail` 新增 `scoreBreakdown: CaseScores | null`；`getPublicCaseById` 用 `parseCaseScores`（`CaseScoresSchema.safeParse`）校验库中 JSON，缺失/非法一律返回 null（诚实：绝不把无效数据当有效评分展示）。
  - `src/app/cases/[id]/page.tsx`：新增 `ScoreBreakdownCard`——机会评分总分 + 10 维度贡献条（inverse 维度标「越低越好」并显示录入值）+ 证据可信度/证据条数/关键未知变量数 + 证据构成角标 + 公式版本；无拆解时诚实显示"暂未录入/复算，不展示任何推算结果"；重申 `综合评分 ≠ 项目一定成功`（总控 §10 / 规则 9）。
  - `prisma/seed.ts`：6 个 DEMO 案例各补 `scoreInput`（10 维整数），create 时**内联调用 `computeCaseScores`** 派生 `scoreBreakdown` 与两个标量（宪法第 7 条：可复算 > 手填魔数；DEMO 已明确标注，补输入不违宪）。
  - `tests/integration/case-scores.test.ts`：新增 2 例——`getPublicCaseById` 对已复算公开案例透传 scoreBreakdown（opp 88 / conf 69 / 10 维 / 贡献和 88 / 标量一致）；对无输入公开案例诚实返回 null。
- 验证：`tsc`/`eslint` 0 错；`vitest run tests/unit` **193/193**；`next build` 全路由无回归；`vitest run tests/integration` **31/31**（原 29 + 2），真连 Neon；`db:seed` 后 `db:recompute-scores` 显示 6 DEMO 案例全部由 skipped→**computed**；HTTP 冒烟 `GET /cases/demo_case_biogas?demo=1` 实测渲染机会 64 / 证据可信度 39 / 关键未知 3、10 维标签与「越低越好」提示齐全。
- 效果：**Phase 7 M3 达成**——评分从"库里的数字"变成"用户可看懂、可审计、附带不确定性与免责说明的拆解"。下一步：案例 CRUD、证据管理（含总控 §11 证据等级 S/A/B/C/D 轴建模的开放决策——是否给 Evidence 加 grade 并入可信度公式），随后行业关联、Phase 8 方案系统。

## [0.10.0] - 2026-09-05 · Phase 7 里程碑 2：评分持久化 + 可复算（scoreInput / scoreBreakdown / 复算脚本）

- 原因：M1 的评分是纯函数，但分数仍只是 Case 上手填的标量魔数。M2 把"输入"与"输出"都落库，使评分随时可从输入重算、可审计（宪法第 7/13 条）。
- 内容：
  - `prisma/schema.prisma`：Case 新增 `scoreInput Json?`（10 维度原始录入分=评分输入）与 `scoreBreakdown Json?`（computeCaseScores 完整输出，含 rubricVersion + 每维度贡献 + 证据明细）；`opportunityScore`/`evidenceConfidence` 改为由复算从 breakdown 同步写入（便于排序/索引）。迁移 `20260905100000_add_case_score_fields`（**纯加性**：两列可空 JSONB），已 `migrate deploy` 到 Neon（表数不变=18，无新枚举）。
  - `src/server/case-scores.ts`（新增）：`recomputeCaseScores(caseId)` 读 scoreInput+evidences → computeCaseScores → `CaseScoresSchema` 入库前复核 → 写 scoreBreakdown + 两标量；判别联合 computed/skipped(无 scoreInput)/invalid(越界,不写库)/not_found/error。`recomputeAllCaseScores()` 顺序复算全库并汇总各状态计数（V1 库小够用，不提前并发优化）。**诚实铁律**：无 scoreInput 跳过、绝不反推编造；非法输入不写库、不静默截断。
  - `scripts/recompute-scores.ts` + npm `db:recompute-scores`（新增）：批量复算 CLI，如实打印 total/computed/skipped/invalid/notFound/error 与逐条异常（≤50），有 error 则退出码 1。实跑验证：当前 6 个 DEMO 案例无 scoreInput → 全部 skipped、exit 0（不编造）。
  - `tests/integration/case-scores.test.ts`（新增 6 cases，真连 Neon）：合法输入→computed 且 DB 读回 scoreBreakdown 通过 CaseScoresSchema、opportunityScore=88/evidenceConfidence=69/unknownVariableCount=2/breakdown 10 维贡献和=88；无 scoreInput→skipped 且标量与 breakdown 保持 null；非法 scoreInput→invalid+issues 指名 commercialValue 且不写库；不存在 id→not_found；复算幂等（连跑两次 breakdown 全等）；recomputeAllCaseScores 汇总自洽（各状态和=total）且三夹具分别落 computed/skipped/invalid、error=0。
- 验证：`tsc --noEmit` 0 错；`eslint .` 0 问题；`vitest run tests/unit` **193/193**；`next build` 全路由无回归；`vitest run tests/integration` **29/29**（原 23 + case-scores 6），~42s 真连 Neon。
- 效果：**Phase 7 M2 达成**——评分从"手填魔数"变成"输入+输出双落库、随时可复算、非法不入库、无输入不编造"。公式升级（rubricVersion）后只需 `npm run db:recompute-scores` 重跑即可校准全库（旧 breakdown 含其 rubricVersion，配合 Git/ChangeLog 可追溯回滚）。下一步 M3：案例详情页展示评分拆解（getPublicCaseById 返回 scoreBreakdown + UI），并给 DEMO 种子补 scoreInput 使 ?demo=1 可端到端演示；随后案例 CRUD、证据管理（含总控 §11 等级轴建模开放决策）。

## [0.9.0] - 2026-09-05 · Phase 7 里程碑 1：案例评分内核（可复算公式 + 黄金样本 + 版本化文档）

- 原因：在此之前 `Case.opportunityScore` / `Case.evidenceConfidence` / `Solution.unknownVariableCount` 只是几个手填/种子写入的 `Int?` **魔数**——无法复算、无法审计、假设变了也不知道影响了谁，违反宪法第 7 条"关键数字须来源可追溯 + 公式可复算 + 假设可改，程序计算 > LLM 口算"。评分是下游一切（案例排序、方案优先级、后台审核、机会池）的地基，故 Phase 7 先立**评分内核**。按宪法第 2/4 条 MVP 优先，M1 只做"纯函数 + Zod 校验 + 黄金样本测试 + 版本化公式文档"，**不动数据库、不动页面**（持久化 `Case.scoreBreakdown` 与详情页拆解展示 = M2）；本内核无新增运行时依赖。选此任务因其**无阻塞、无需创始人决策、高价值**（Phase 12 购买仍被定价/支付决策 + 模型 Key 阻塞，Phase 8 方案依赖本评分）。
- 内容：
  - **评分内核** `src/server/scoring.ts`（server 域逻辑，纯函数，新增）：
    - `SCORING_RUBRIC_VERSION="1.0.0"`（宪法第 13 条：调权重/改公式必须升版本 + 记录原因 + 可回滚）。
    - `OPPORTUNITY_DIMENSIONS`：10 个维度与权重**逐字照抄总控 Prompt §10**（商业价值 20 / 市场需求 15 / 技术成熟度 15 / 中国本土化空间 10 / 成本优势 10 / 可复制性 10 / 供应链成熟度 5 / 竞争强度 5 / 政策环境 5 / 实施难度 5），`OPPORTUNITY_MAX` 用 `reduce` 求和恒为 100（防维度改动后硬编码失真）。
    - **反向极性设计**：`竞争强度` / `实施难度` 标为 `inverse`——录入者按直觉填"竞争 0=无…5=白热化""难度 0=极易…5=极难"，程序负责 `contribution = max - raw`，避免人工把方向填反。`computeOpportunityScore()` 经 `OpportunityInputSchema`（Zod，逐维度动态生成 0..max 整数约束）校验，非法（缺维度/越界/非整数）→ `{ok:false, issues}` **逐条指名维度、绝不静默截断**（宪法第 20 条诚实优先）；合法则返回 `total` + 每维度 `breakdown`（raw/contribution，作审计线索）。
    - **证据可信度** `computeEvidenceConfidence()`：总控 §10 **只给示例值未给公式**，故本公式是**本项目 v1 假设**（已在文档明确标注、参数可调）。类型权重 `EVIDENCE_TYPE_WEIGHTS`（FACT 1.0 / ASSUMPTION 0.5 / INFERENCE 0.4 / PREDICTION 0.3）+ `EVIDENCE_CONFIDENCE_PARAMS`（无 sourceUrl 打 0.6 折、未填 confidence 缺省 50）；`value = round(100·Σ(w·q·sf)/Σw)`，空证据集 → 0，未知 type 跳过（防御脏数据不静默当 FACT），越界 confidence clamp。
    - `countKeyUnknowns()` = 非 FACT 证据条数（呼应宪法第 6 条：把不确定显式计数暴露）；`computeCaseScores()` 一次算出三件套（机会评分 + 证据可信度 + 关键未知变量数，总控 §10 输出契约），机会评分非法不影响证据两项独立计算；`CaseScoresSchema`（Zod）供 M2 持久化前复核入库结构。
  - **版本化公式文档** `docs/SCORING_V1.md`（新增）：把每个数字标注为**事实/假设/推断/预测**（宪法第 6 条）——维度权重=【事实】照抄总控 §10、反向极性与证据可信度公式=【假设】可调、边界值与样例=【推断】可复算；含机会评分/证据可信度两个**逐维度可复算工作样例**（→88 / →69，其中机会评分 88 与总控 §10 示例"综合价值 88/100"交叉验证一致）；**诚实记录已知缺口**（总控 §11 的证据"等级"S/A/B/C/D 轴尚未建模、当前公式未使用等级，列为 M2+ 开放决策；权重未经真实案例校准；raw 录入的客观性属 Phase 9）；含变更流程与版本历史表。重申铁律：综合评分 ≠"项目一定成功"（总控 §10 / 规则 9）。
  - **测试新增** `tests/unit/scoring.test.ts`（26 cases，黄金样本）：锁定常量结构（满分 100、10 维度权重、恰两个反向维度、类型权重单调递减）；机会评分黄金值（最优 100 / 全填 max 90 / 全填 0 10 / 工作样例 88 / 反向极性 raw↑贡献↓ / 越界与缺维度与非整数与负数 ok:false / 确定性）；证据可信度黄金值（混合集 →69 且 Σnum=1.94、Σw=2.8 精确锁定 / 空集 →0 / 单条 FACT conf100 有源 →100 / 单条时类型权重约掉只由 q·sf 决定 / 缺省 confidence / clamp 越界 / 未知类型跳过 / 确定性）；关键未知变量数；组合契约（三件套 + CaseScoresSchema 一致 + 机会非法时 ok:false 但证据两项照算 + 无证据边界）。
- 验证（宪法第 5/18/20 条）：
  - `next typegen` 成功；`tsc --noEmit` **0 错误**；`eslint .` **0 问题**。
  - `vitest run tests/unit`：**193/193 全绿**（原 167 + scoring 26），~0.9s。
  - `next build`（Turbopack）：编译成功，全部路由无回归（本里程碑不新增路由/页面，故无新增 HTTP 冒烟——评分内核是纯函数，验证以单元黄金样本为准，符合"程序计算 > 口算"）。
  - `node --env-file=.env vitest run tests/integration`：**23/23 全绿**（无回归，本里程碑不动 DB），~43s，真连 Neon us-east-2。
- 效果：**Phase 7 里程碑 1 达成**——评分从"手填魔数"变成"可复算程序 + 版本化公式 + 26 黄金样本锁"，任何调权重/改公式都会被测试挡住并强制升版本（宪法第 7/13 条）。数据质量地基就绪，M2 可把 `computeCaseScores` 的 breakdown 持久化进 `Case.scoreBreakdown` 并在详情页展示（届时提供历史数据重算脚本 + 旧版本号标注）。下一步 Phase 7 M2（评分持久化 + 详情页拆解），随后案例 CRUD/证据管理，再 Phase 8+（方案系统、AI Agent、GitHub Scout）。ROADMAP 阻塞剩余 #3 github.com CLI（API 绕行中）、#4 模型 API Key、#5 部署/支付、#6 对象存储。

## [0.8.0] - 2026-09-05 · Phase 6 里程碑 1：用户系统最小闭环（注册 / 登录 / 会话 / 账号页）

- 原因：V1-A 商业闭环「案例 → 方案 → 购买」的「购买」环节必须有下单身份，故 Phase 6 先立最小可用的用户系统。认证方案是"高价值、影响架构与厂商锁定"的决策，按宪法（AI 做大量劳动、人做关键决策）交创始人裁决 → 选定 **Auth.js 自建**（总控 §21「认证尽可能用成熟现成方案」）。V1 只需"下单身份"，不需要 OAuth / 魔法链接（后者要引入 nodemailer/Resend 邮件通道 = 额外依赖与成本），故按宪法第 2/4 条 MVP 优先：Credentials（邮箱 + 密码）+ JWT 会话，用户表留在自己的 Neon 库，零厂商锁定。口令哈希用 Node 内置 `node:crypto` 的 scrypt，**零额外依赖**、无需本机原生编译（Windows 友好），是 OWASP 认可的内存困难型 KDF。
- 内容：
  - **数据模型** `prisma/schema.prisma`：新增 `enum UserRole { USER REVIEWER ADMIN }`（SECURITY §4 最小角色）与 `model User`（id cuid / email unique / name? / passwordHash / role 默认 USER / emailVerified? / image? / 时间戳 / `orders Order[]`，role 建索引）；`Order` 增补可空 `userId` + `user User?` 关系（`ON DELETE SET NULL`，用户删单不删，符合财务留痕）与 `@@index([userId, status])`。新增迁移 `20260905000000_add_user_auth`（**纯加性**：CREATE TYPE UserRole、ALTER Order ADD userId、CREATE TABLE User、唯一邮箱索引、role 索引、Order(userId,status) 索引、外键），已 `prisma migrate deploy` 部署到 Neon us-east-2 并验证（表 17→18、枚举 11→12）。
  - **口令哈希** `src/lib/password.ts`（server-only，新增）：`hashPassword()` / `verifyPassword()` 用 scrypt（N=16384,r=8,p=1,keylen=64,16 字节随机盐），自描述存储串 `scrypt$N$r$p$saltB64$hashB64`（便于将来无痛升级参数/算法）；校验用 `timingSafeEqual` 定长比较防时序侧信道；对格式非法/算法不符/长度不一致/口令超长（>1024 字节 DoS 上限）一律返回 false 或 `{ok:false}`，绝不抛裸异常（防用户枚举与崩溃）。**绝不存明文**（SECURITY §1 / 宪法第 11 条）。
  - **认证校验** `src/lib/validation.ts`：新增 `UserRoleSchema`（与 prisma 枚举同步）、`PASSWORD_MIN=8` / `PASSWORD_MAX=128`、`EmailSchema`（trim → toLowerCase → max254 → `z.email()`，同邮箱归一小写防多账号）、`PasswordSchema`（注册强制 8–128 位）、`RegisterInputSchema`（email/password/name?，空串 name 归一化为 undefined）、`LoginInputSchema`（口令只要求非空 min1——不在登录处强制最小长度，避免用"密码太短"泄露账号是否存在）。
  - **用户数据层** `src/server/users.ts`（server-only，新增）：`registerUser()`（校验 → 查重邮箱 → scrypt 哈希 → 建号 role=USER；捕获并发唯一约束 P2002 归一为 email_taken；判别联合返回 created/invalid/email_taken/weak_password/error，不抛裸异常给页面）；`getAuthUserByEmail()`（authorize() 用，含 passwordHash，仅服务端）；`getProfileUserById()`（账号页用，**select 明确排除 passwordHash**）。
  - **Auth.js 配置** `src/auth.ts`（新增，next-auth@5 beta）：Credentials provider `authorize()` = LoginInputSchema 校验 + getAuthUserByEmail + verifyPassword，任一失败返回 null（Auth.js 抛 CredentialsSignin，登录页对"账号不存在"与"密码错误"给**同一提示**防枚举）；`session:{strategy:"jwt"}`；jwt/session 回调把稳定的 id/role 透传进 session；`pages:{signIn:"/login",error:"/login"}`；`trustHost:true`（反代/自定义 host 不报 UntrustedHost）；模块增强 JWT 类型须打在 `@auth/core/jwt`（**不是** `next-auth/jwt`）。**不挂 Prisma Adapter**（Credentials+JWT 不需要 Account/Session/VerificationToken 表，依赖更少）。Route Handler `src/app/api/auth/[...nextauth]/route.ts` 导出 `handlers`。
  - **三个页面 + Server Actions**：`/login`（`AuthForm` + `login` action：signIn("credentials",{redirectTo:"/account"})，捕获 AuthError → "邮箱或密码不正确"，NEXT_REDIRECT 必须 rethrow）；`/register`（`register` action：registerUser → 成功后自动 signIn 免二次登录，注册失败按 status 分别回填 fieldErrors）；`/account`（force-dynamic + noindex，`await auth()` 无会话重定向 /login，展示昵称/角色 Badge/邮箱/验证态/注册时间 + 登出表单；第二张卡"即将开放"占位订单=Phase12、报告/画像/诊断=V1-B）。共用客户端组件 `src/components/auth/AuthForm.tsx`（`useActionState` 驱动，pending 态按钮 + Alert 错误 + 登录/注册模式切换）。三页均 force-dynamic，登录/注册页已认证时自重定向 /account（故导航用静态登录/注册链接，不引入 SessionProvider，避免把 SSG 页拖成动态）。
  - **导航/页脚** `src/app/layout.tsx`：header 加「登录」「注册」，footer 加「登录 / 注册 / 我的账号」。
  - **环境变量**：`.env`（gitignored）新增 `AUTH_SECRET`（32 字节 base64）；`.env.example` 认证段改写为 Auth.js v5 Credentials 说明（AUTH_SECRET 生成方式 + AUTH_URL + 可选 OAuth 占位）。
  - **测试新增**：`tests/unit/password.test.ts`（8 cases：自描述格式、同口令随机盐唯一、超长口令 {ok:false}、正确/错误口令往返、畸形与非法存储串一律 false、超长校验 false）；`tests/unit/validation.test.ts` 追加认证 schema describe（7 cases：UserRoleSchema 同步、EmailSchema 归一小写与超长拒绝、PasswordSchema 8/128 边界、RegisterInputSchema 空串 name→undefined、LoginInputSchema min1 不泄露账号存在）；`tests/integration/users.test.ts`（5 cases，真连 Neon：registerUser 建号存哈希非明文+role 默认 USER+邮箱小写归一、重复邮箱 email_taken、非法入参 invalid+fieldErrors、getAuthUserByEmail 返 passwordHash 且 verifyPassword 可校验、getProfileUserById 排除 passwordHash；afterAll 按 runId 清理）；`tests/integration/db-smoke.test.ts` 表/枚举基线随 Phase 6 更新（17→18 表含 User、11→12 枚举含 UserRole）。
- 验证（宪法第 5/18/20 条）：
  - `next typegen` 成功；`tsc --noEmit` **0 错误**；`eslint .` **0 问题**。
  - `vitest run tests/unit`：**167/167 全绿**（原 152 + password 8 + 认证 validation 7）。
  - `next build`（Turbopack）：编译成功，新增 `ƒ /login`、`ƒ /register`、`ƒ /account` 动态路由与 `/api/auth/[...nextauth]` handler；SSG 静态路由（行业/关于/隐私/条款）无回归。
  - `node --env-file=.env vitest run tests/integration`：**23/23 全绿**（原 18 + users 5），~42s，真连 Neon us-east-2。
  - **HTTP 端到端认证冒烟**（`next start -p 3119`，**26/26 全过**）：种测试用户 → `/login` `/register` 200 且含表单标记；首页导航含登录/注册链接；未登录 `/account` → 307 重定向 `/login`；`/api/auth/providers` 含 credentials；完整流程 `GET /api/auth/csrf`（返 csrfToken + 下发 csrf cookie）→ `POST /api/auth/callback/credentials`（正确口令下发 session cookie）→ `GET /api/auth/session`（user.email/role=USER/id 正确，**不含 passwordHash**）→ 登录后 `/account` 200 展示邮箱/角色；**错误口令**与**不存在邮箱**均不下发 session cookie、session 无 user（无差别失败防枚举）；`POST /api/auth/signout` 清除 session cookie，登出后 `/account` 重定向 `/login`。
- 效果：**Phase 6 里程碑 1 达成**——注册/登录/JWT 会话/账号页/登出全链路打通并经 190 测试（167 单元 + 23 集成）+ 26 项 HTTP 认证冒烟验证；V1-A「购买」环节的下单身份就绪（订单绑定 Phase 12）。全程零额外运行时依赖（scrypt 走 node:crypto、Auth.js 不挂 Adapter）。安全教训入库：脚本日志**绝不拼接密钥明文**（只记长度/掩码）；`server-only` 包在本仓 vitest/纯 node 下会抛 "Cannot find module"，约定只在文档注释标注 server-only、**不 import**。下一步 Phase 6 里程碑 2+（角色/权限中间件，SECURITY §4 / Phase 13），随后 Phase 7+（案例系统、方案系统、AI Agent、GitHub Scout）。ROADMAP 阻塞剩余 #3 github.com CLI（API 绕行中）、#4 模型 API Key、#5 部署/支付、#6 对象存储。

## [0.7.0] - 2026-09-04 · Phase 5 里程碑 3：搜索系统 + 首页组装（Phase 5 收官）

- 原因：里程碑 1 立起页面地基、里程碑 2 打通案例/方案的列表与详情。里程碑 3 要补齐总控 Prompt §18「搜索系统」与 §6「首页六段体验」两块前台，让用户能从首页发现→按关键词/行业检索→进入案例/方案详情，闭合 V1-A「用户查看」环节的入口层。搜索为 V1 关键词匹配（标题 + 摘要 ILIKE），语义/向量搜索按宪法第 4 条 MVP 优先原则延后（不提前引入 embedding 依赖）。首页严格照 §6 六段组装，且对空数据保持诚实空态——当前库仅有里程碑 2 的【DEMO】种子，首页默认视图排除 DEMO，故案例/方案区显示"由每日流水线逐步填充"的真实空态，不伪造繁荣（宪法第 20 条）。
- 内容：
  - **搜索编排层** `src/server/search.ts`（server-only，新增）：`SEARCH_PREVIEW_LIMIT = 8`；`searchPublic({ q, industry?, includeDemo, limit? })` 用 `Promise.all` 并行调 `listPublicCases` 与 `listPublishedSolutions`（各自已带 $transaction[findMany,count] + DEMO 门控），复用两者的默认排序（案例 discoveredAt desc、方案 publishedAt desc）；聚合返回 `{ q, cases, solutions, ok: cases.ok && solutions.ok, hits: 案例命中数 + 方案命中数 }`；任一子查询抛错则 catch 记日志并降级为 `ok:false / hits:0`（两侧结果均标失败），页面据此显示 danger 提示而非崩溃——延续里程碑 2 的"DB 不可达软降级"契约。
  - **案例/方案数据层加关键词维度**：`src/server/cases.ts` 与 `src/server/solutions.ts` 的列表参数各新增可选 `q?: string`，并重构出 `buildCaseWhere()` / `buildSolutionWhere()`——把 stage/status 白名单、行业筛选、关键词片段、DEMO 门控统一收集进 `{ AND: [...] }` 数组（关键：关键词的 `OR:[title,summary contains q, mode insensitive]` 与 DEMO 的 `OR:[{sourceType:null},{sourceType:{not}}]` 两个 OR 片段不能并列在同一 where 对象的兄弟键上，必须各自包进 AND 数组元素）。`q` 经 `.trim()` 后为空则不加关键词条件。列表函数签名不变、`q` 自动透传，向后兼容里程碑 2 的调用与测试。
  - **搜索页** `/search`（force-dynamic，新增）：无 JS 亦可用的 GET 表单（`role="search"` + `Input name="q"` + 提交按钮 + 保留 industry/demo 上下文的 hidden input）；行业筛选 chips（保留当前关键词）；四态清晰分离——① 无关键词/纯空白 → EmptyState"输入关键词开始搜索"；② 关键词非法（`SearchQuerySchema.safeParse` 失败，如超 100 字）→ danger Alert"搜索关键词无效"并列出具体的 Zod issue；③ DB 失败 → danger Alert"搜索查询失败"；④ `hits===0` → 诚实空态"没有找到与「q」相关的案例或方案"；有结果则按 案例 / 方案 分两个 `ResultSection` 展示，各带"查看全部 N 个 →"深链到 `/cases?q=…` / `/solutions?q=…`（携带 industry/demo 参数）。
  - **首页重写** `src/app/page.tsx`（force-dynamic，从 Phase 4 骨架文案整体重写为总控 §6 六段体验）：① Hero（`bg-muted/30` + Badge"V1-A · 案例 → 方案 → 购买 最小闭环" + h1"发现全球产业机会，把成功案例重新变成你的解决方案。" + 内联搜索框 GET /search + 双 CTA：主按钮"发现产业方案"→ /cases、次按钮"分析我的企业（即将开放）"disabled 并注明属 V1-B）；② 今日全球产业案例（`listPublicCases` limit 6 discoveredAt desc includeDemo:false，空则诚实 EmptyState，DB 失败则 Alert）；③ 今日产业解决方案（`listPublishedSolutions` limit 3 publishedAt desc，空态说明"里程碑 2 起不种子方案，由真实多角色流水线 + 人工审核发布"）；④ 企业 AI 产业诊断（V1-B 即将开放卡片）；⑤ 我们如何工作（六步工作流 const：全球案例发现 → AI 拆解 → 开源匹配 → 中国本土化重构 → 产业解决方案 → 验证与项目）；⑥ 按行业浏览（`INDUSTRIES` 七张卡片）。两个数据段用 `Promise.all` 并行取。`generateMetadata` 补 title.default 与 template。**移除** Phase 4 遗留的 pg_stat 开发面板（宪法第 4 条：首页是用户价值入口非调试面板）。
  - **列表页加关键词回显**：`/cases`、`/solutions` 读取 `q` 参数、透传给列表函数、并在行业筛选导航前加"关键词：X ✕清除"指示条（Badge info + 清除链接 `buildHref({ ...common, q: undefined, page: undefined })`），使从搜索页"查看全部"深链过来时用户看得到当前检索词。
  - **导航/页脚** `src/app/layout.tsx`：header 与 footer 导航在"方案"后各加入 `/search` 链接。
  - **测试新增**：`tests/unit/search.test.ts`（5 cases，`vi.mock` 隔离 `@/server/cases` + `@/server/solutions`：默认 limit=SEARCH_PREVIEW_LIMIT、q/industry/includeDemo 正确透传、ok 聚合 + hits 求和 + q 回显、一侧失败则整体 ok:false、子查询 reject 时 catch 降级 ok:false/hits:0 且不抛）；`tests/integration/cases-solutions.test.ts` 追加 3 cases（真连 Neon：`searchPublic` 关键词命中自建真实案例 + 已发布方案且默认排除 DEMO/DRAFT、includeDemo:true 纳入匹配的 DEMO 案例、无意义关键词 → ok:true 且 hits:0）。
- 验证（宪法第 5/18/20 条）：
  - `next typegen` 成功；`tsc --noEmit` **0 错误**；`eslint .` **0 问题**。
  - `vitest run tests/unit`：**152/152 全绿**（原 147 + 新增 5），~0.59s（日志里 `"searchPublic failed" ... boom` 是 search.test.ts 故意触发的 catch 路径断言，非失败）。
  - `next build`（Turbopack）：编译成功，新增 `ƒ /search` 动态路由，首页 `ƒ /` 重写后无回归。
  - `node --env-file=.env vitest run tests/integration`：**18/18 全绿**（原 15 + 新增 3），~43s，真连 Neon us-east-2。
  - **HTTP 端到端冒烟**（`next start -p 3117`，**31/31 全过**）：首页 200 且含 hero 文案/我们如何工作/按行业浏览/搜索表单指向 /search/导航含 /search 链接；`/search` 无查询 → 200 + "输入关键词开始搜索"；`/search?q=沼气&demo=1` → 200 + 命中种子 DEMO 沼气案例标题 + DEMO 标记；`/search?q=沼气` 默认 → 200 + 不泄露 DEMO 标题 + 诚实空态"没有找到"；`/search?q=zzznonsense` → 0 命中空态；`/search?q=空白` → 回引导态；`/search?q=超长150字` → "搜索关键词无效"；**M2 404 回归**——`/cases/nonexistent-zzz-9999`、`/solutions/nonexistent-zzz-9999` 仍真 404（确认根 loading.tsx 保持删除）；`/cases?demo=1` 显示种子标题、`/cases` 默认不泄露、`/cases?q=沼气&demo=1` 命中。冒烟首轮 2 项误报（用 `!body.includes("【DEMO】")` 判排除，但"【DEMO】"字面量出现在默认页的帮助文案"开发期可加 ?demo=1 查看【DEMO】示例数据"里）→ 改为断言具体种子案例标题片段 `畜禽粪污沼气工程示例` 是否泄露，语义更准，复测 31/31。
- 效果：**Phase 5 里程碑 3 达成，Phase 5「公共页面」全部完成**——首页六段体验 + 关键词搜索（/search + 案例/方案列表页关键词回显）就绪，全部经 build + 170 测试（152 单元 + 18 集成）+ 31 项 HTTP 冒烟（含 2 个真 404 回归）验证。V1-A 商业闭环的"用户查看"入口层（发现 → 检索 → 详情）打通；"购买"仍为 Phase 12 占位。测试基线扩到 170。下一步进入 Phase 6（用户系统 / 认证，待决：Auth.js vs 托管方案）。ROADMAP 阻塞剩余 #3 github.com CLI（API 绕行中）、#4 模型 API Key、#5 部署/支付、#6 对象存储。安全：旧高风险 PAT 已由创始人撤销（2026-09-05 确认）。

## [0.6.0] - 2026-09-04 · Phase 5 里程碑 2：案例/方案公共页 + DEMO 标注种子数据 + 真 404 修复

- 原因：里程碑 1 立起了不依赖业务数据的页面地基（行业/关于/隐私/条款）。里程碑 2 要打通 V1-A 商业闭环里"用户查看"这一环的前台：案例列表/详情、方案列表/详情，并配套可控的 DEMO 数据用于开发期验证渲染路径。按创始人 2026-09-05 裁决——**只种子标注 DEMO 的案例，不种子任何方案**：案例是免费的研究展示、风险低；方案涉及定价与购买闭环，必须由真实多角色流水线（Research→Bull→Bear→Judge→QA）+ 人工审核产出，伪造可售商品违反宪法第 20 条（禁止虚构）。方案页在真实流水线产出前保持诚实空态。
- 内容：
  - **DEMO 可见性层** `src/server/demo.ts`：`DEMO_SOURCE_TYPE = "DEMO_FIXTURE"` + `DEMO_TITLE_PREFIX = "【DEMO】"`；`isDemoEntity()` 判定；`caseDemoVisibility(includeDemo)` 生成 Prisma where 片段——默认排除 DEMO，且用 `OR: [{ sourceType: null }, { sourceType: { not: DEMO } }]` 规避 Prisma `{ not }` 的 NULL 陷阱（`<> X` 会连带排除 sourceType 为 NULL 的真实行）；`solutionDemoVisibility()` 把门控包到关联 `case` 上（方案本身无 sourceType）。
  - **DEMO 种子脚本** `prisma/seed.ts`（`npm run db:seed` = `node --env-file=.env --import tsx`）：写入 3 地区 / 3 商业模式 / 7 技术能力 / **6 个【DEMO】案例**（覆盖农林牧渔×2、工业制造、新能源、地产建筑、教育培训；每个 stage=DEEP_CASE、sourceType=DEMO_FIXTURE、标题【DEMO】前缀、正文写明"演示数据非真实案例"，含事实/假设/推断/预测分层证据 + 能力关联）。安全护栏：`NODE_ENV=production` 直接拒跑、缺 DATABASE_URL 报错退出；幂等——所有种子行固定 `demo_` id 前缀，运行先级联清理旧 DEMO（案例→CaseCapability→Localization→CapabilityProject→TechCapability→BusinessModel→Region）再重建。**不写入任何 Solution**。
  - **案例数据层** `src/server/cases.ts`（server-only）：`PUBLIC_CASE_STAGES` 白名单（漏斗内部态 CANDIDATE/KEY_RESEARCH 不对外）；`listPublicCases()` 用 `prisma.$transaction([findMany(include region), count])` 一次取回列表 + 总数，支持行业筛选（slug→enum）/分页（offset+limit）/排序（`makeSortSchema` 白名单 discoveredAt|opportunityScore|title），DB 失败降级 `ok:false` + error 而非崩溃；`getPublicCaseById()` 取详情（region/businessModel/evidences asc/capabilities+capability/`_count` 已发布方案数），对不存在 id、非公开阶段、或 DEMO 未带 includeDemo 一律返回 `not_found`（联合返回类型 found|not_found|error）。
  - **方案数据层** `src/server/solutions.ts`（server-only）：仅暴露 `status=PUBLISHED`（DRAFT/UNDER_HUMAN_REVIEW 属内部态，宪法第 10 条高风险方案须人工审核后才发布）；`listPublishedSolutions()` 同 $transaction 模式 + 行业筛选 + DEMO 门控（经关联 case）；`getPublishedSolutionById()` 返回财务明细（capex/opex/年收益/ROI/IRR/回收期，Decimal→string 精确保真）与关键未知变量列表；`formatPrice()` 修复为**金额统一两位小数**（Prisma Decimal 的 `toString()` 会丢尾零使 1999.00→"1999"，改用 `toFixed(2)`，宪法第 7 条数字精确）。
  - **四个页面**：
    - `/cases`（force-dynamic）：PageHeader + 实时计数 Badge + 行业筛选 chips（全部 + 7 行业）+ 案例卡片（DEMO 角标 / 机会评分 / 证据可信度 / 地区）+ 分页导航；`?demo=1` 时顶部 warning Alert 声明"当前为【DEMO】示例数据"；空态区分"暂无已发布深度案例"（默认）与"连 DEMO 都没有，请先 seed"（demo 视图）；DB 失败展示 danger 提示条。
    - `/cases/[id]`（force-dynamic）：概览 + 地区/来源链接 + 机会评分/证据可信度 Metric 网格 + 商业模式拆解（收入来源/成本结构）+ 技术能力关联网格 + **按 事实/假设/推断/预测 分层标注的证据列表**（宪法第 6 条，四类各配色 Badge）+ 已发布方案区；DEMO 案例顶部 warning Alert。
    - `/solutions`（force-dynamic）：结构同案例列表，卡片额外显示需专业人工确认（danger Badge）/价格/风险域；空态诚实说明"方案由每日流水线经多角色质量门禁 + 人工审核生成，当前尚未有方案发布"；`?demo=1` 时 Alert 明示"按创始人裁决里程碑 2 不种子任何方案"。
    - `/solutions/[id]`（force-dynamic）：财务明细（CAPEX/OPEX/年收益/ROI/IRR/回收期）+ 关键未知变量列表 + 风险域 + needsProfessionalReview danger Alert（宪法第 10 条）+ 关联案例链接 + **购买按钮占位（disabled，title 注明"购买与支付闭环将在 Phase 12 接入"）**；34 分节 body 延后 Phase 8。
  - **导航/页脚** `src/app/layout.tsx`：里程碑 1 曾移除的 `/cases` `/solutions` 死链现已建成，重新加回主导航。
  - **删除根 `src/app/loading.tsx`**（关键修复，见验证）：里程碑 1 引入的全局 Suspense 骨架屏与"运行时 DB 查找 + notFound()"的动态详情页存在根本冲突，故移除。
  - **测试新增**：`tests/unit/demo.test.ts`（7 cases：DEMO 常量、isDemoEntity 对 true/false/null/undefined、caseDemoVisibility 的 includeDemo 分支与 OR[null,not] 结构、solutionDemoVisibility 的 case 包裹）；`tests/integration/cases-solutions.test.ts`（8 cases，真连 Neon：自建 realCase/demoCase/candidateCase + publishedSolution/draftSolution 全生命周期夹具，afterAll 按 Restrict 外键顺序清理 + runId 兜底——listPublicCases 默认排除 DEMO 与内部阶段但含真实公开案例、includeDemo=true 纳入并标记 isDemo、行业筛选生效、getPublicCaseById 完整详情/DEMO 门控/内部阶段与不存在 id 均 not_found、listPublishedSolutions 只含 PUBLISHED 且 priceDisplay="¥1999.00"、getPublishedSolutionById 财务与未知变量/DRAFT 与不存在 id not_found）。
- 验证（宪法第 5/18/20 条）：
  - `next typegen` 成功；`tsc --noEmit` **0 错误**（修复 seed.ts 中 `as const` 使 BUSINESS_MODELS.revenueStreams/costStructure 变 readonly 元组、Prisma create 需可变 string[] 的 TS2322 → 建时展开为可变数组）；`eslint .` **0 问题**。
  - `vitest run tests/unit`：**147/147 全绿**（原 140 + 新增 7），~0.56s。
  - `next build`（Turbopack）：编译成功，新增 `ƒ /cases`、`ƒ /cases/[id]`、`ƒ /solutions`、`ƒ /solutions/[id]` 四条动态路由（M1 的行业 SSG / 内容页 / Proxy 无回归）。
  - `npm run db:seed`：成功写入 6 DEMO 案例 / 16 证据 / 7 能力关联（生产护栏未触发，本机 NODE_ENV≠production）。
  - `node --env-file=.env vitest run tests/integration`：**15/15 全绿**（原 7 + 新增 8），~39s，真连 Neon us-east-2；首轮暴露并修复 priceDisplay 尾零问题（¥1999→¥1999.00）。
  - **HTTP 端到端冒烟**（`next start -p 3116`，**14 项全过**）：列表页 `/cases`（默认空态）、`/cases?demo=1`（含种子案例标题 + DEMO Alert）、`/cases?industry=…&demo=1`（行业筛选）、`/cases?demo=1&page=1`（分页）、`/solutions`（空态）、`/solutions?demo=1`（"不种子任何方案"声明）均 200；详情 `/cases/demo_case_biogas?demo=1` 200 且含"证据与判断分层"；**404 语义**——`/cases/demo_case_biogas`（DEMO 未带 demo=1）、`/cases/nonexistent-zzz-9999`、`/solutions/nonexistent-zzz-9999` 均 **404**；回归 `/industries` 200、`/industries/new-energy` 200、`/industries/not-a-real-one` 404、`/api/health` 200。
  - **冒烟暴露并修复的真 404 缺陷（重要）**：首轮冒烟在保留根 `loading.tsx` 时，上述 3 个动态详情页无效 id **全部返回 200 而非 404**（body ~16KB，渲染了 not-found UI 但状态码错误）——根因是 `loading.tsx` 的 Suspense 边界会先 flush 200 响应头 + 骨架 shell，等异步页面组件里 `notFound()` resolve 时已无法回退状态码，会导致无效 URL 被 SEO 误收录。SSG 路由（`/industries/[slug]` + `dynamicParams=false`）在路由器层先判、**免疫**此问题（同轮仍真 404）。对"取值来自固定枚举集合"的路由用 SSG+dynamicParams=false 是正解（里程碑 1 已采用）；但对 `/cases/[id]`、`/solutions/[id]` 这类**取值来自任意 DB id**、无法预渲染的路由，唯一干净解法是移除制造提前 flush 的根 `loading.tsx`。移除后重建，14/14 冒烟全过、3 个无效 id 均真 404。代价是失去全局骨架屏，但热态页面查询 ~100ms、冷启动已在列表页内联降级提示，正确性与 SEO 优先级高于轻微 UX（宪法第 2 条：冲突时选更简单更可验证的方案）。
- 效果：**Phase 5 里程碑 2 达成**——案例/方案的列表与详情四页 + DEMO 标注种子 + 分页/筛选/排序 + 证据分层展示就绪，全部经 build + 162 测试（147 单元 + 15 集成）+ 14 项 HTTP 冒烟（含 3 个真 404）验证；并修复了一个会影响 SEO 收录质量的状态码缺陷。商业闭环"用户查看"环节的前台打通（"购买"仍为 Phase 12 占位）。测试基线扩到 162。里程碑 3（搜索 + 首页组装，首页 `src/app/page.tsx` 仍是 Phase 4 骨架文案待重写）待续。ROADMAP 阻塞剩余 #3 github.com CLI（API 绕行中）、#4 模型 API Key、#5 部署/支付、#6 对象存储。安全待办：提醒创始人撤销此前会话暴露过的旧 PAT。

## [0.5.0] - 2026-09-04 · Phase 5 里程碑 1：公共页面地基（内容页 + 行业页 + 可复用页面骨架）

- 原因：Phase 4 交付清单（Web 骨架 / DB / 基础 UI / env / 日志 / 错误 / 测试）已全部完成，进入总控 Phase 5「公共页面」。按 PRODUCT_SPEC §5 的信息架构，先把 V1-A 里"不依赖案例/方案数据就能立起来"的页面地基做扎实：可复用页面级布局组件、行业列表/详情、关于/隐私/条款内容页、导航页脚与 Suspense 态。案例列表/详情、方案列表/详情依赖真实数据，拆到里程碑 2（配合 DEMO 标注的种子数据），搜索与首页组装拆到里程碑 3（宪法第 4 条 MVP、第 2 条不为"看起来像大平台"而铺空页）。
- 内容：
  - **页面级布局组件** `src/components/page/`（构建在 UI kit 之上，barrel `index.ts`）：
    - `PageHeader.tsx` — 统一页头（title / description / breadcrumb / 右侧 action 区，`as` 可选 h1|h2），所有公共页共用，避免各页各写标题样式。
    - `Breadcrumb.tsx` — `<nav aria-label="面包屑">` + `<ol>`，末项 `aria-current="page"` 不可点，"/" 分隔；SEO 与可及性双收（总控第 19 节）。
    - `EmptyState.tsx` — 诚实空态（icon / title / description / action，虚线边框 + `bg-muted/30`）。数据库尚无内容时用它，而非白屏或假数据（宪法第 20 条禁止虚构）。
  - **行业数据层** `src/server/industries.ts`（server-only）：把 prisma `Industry` 枚举集中映射成 URL slug（kebab-case）+ 中英文名 + 一句话简介 + 图标，`INDUSTRIES` 7 条（六大行业 + OTHER 兜底）与 `prisma/schema.prisma`、PRODUCT_SPEC §2 一一对应；`getIndustryBySlug/ByEnum/getIndustrySlug/isValidIndustrySlug` 双向映射助手；`PUBLIC_CASE_STAGES = {DEEP_CASE, KEY_SOLUTION, PREMIUM_SOLUTION}`（业务规则：漏斗 CANDIDATE/KEY_RESEARCH 是内部中间态不对外，**标注为推断待创始人确认**，集中一处便于修改）；`getIndustryCaseCounts()` 用 `prisma.case.groupBy` 一次查回各行业公开案例数（避免 N+1），DB 不可达时降级为全 0 + `error`，页面据此展示提示条而非崩溃。
  - **行业列表页** `/industries`（force-dynamic）：PageHeader + Breadcrumb + 总计数 Badge，7 张行业卡片（图标 / 名称 / 英文名 / 简介 / 实时案例数 Badge）链到详情页；计数查询失败时展示 warning 提示条，行业仍可浏览。当前库空，计数显示 0 —— 诚实状态，案例由 Phase 9–10 每日流水线填充，不预置假数据。
  - **行业详情页** `/industries/[slug]`：路由策略经实测决策 —— 用 `generateStaticParams` 预渲染 7 个合法 slug + `dynamicParams = false`，非法 slug 由**路由器直接返回真 404**。放弃了 force-dynamic + `notFound()` 方案：根 `loading.tsx` 的 Suspense 会先 flush 200 shell，流式渲染下页面内 `notFound()` 无法把状态码回退成 404（冒烟实测 status=200），会导致无效页被 SEO 误收录。静态化同时让行业页更快、更利于 SEO；实时案例计数保留在 force-dynamic 的列表页。页面展示行业定位 + generateMetadata 独立 title/description（总控第 19 节每行业独立 URL）+ 诚实空态。
  - **内容页**：
    - `/about`（静态）— 产品事实性描述（来源 PRODUCT_SPEC §1/§6）：我们在做什么、六步工作流（全球案例发现 → AI 拆解 → 开源匹配 → 中国本土化重构 → 产业解决方案 → 验证与项目）、六大行业入口、当前 V1-A 阶段诚实说明（数据库内容逐步填充、不夸大已上线/已验证）。
    - `/privacy`、`/terms`（静态，noindex）— **结构化占位大纲，非生效法律文件**。宪法第 21 条：法律文件须由具备资质的法务/律师起草审定，AI 不得自行生成"看起来完整"的隐私政策/条款冒充法律文件。两页顶部均有 warning Alert 明示"待法务审定 · 尚未生效"，正文为上线前必须覆盖的条款清单；`/terms` 额外高亮"AI 生成内容免责声明"拟定要点（内容为 AI 研究产出、区分事实/假设/推断/预测、高风险领域需专业人工确认、不构成投资/法律/工程等专业意见）并标注最终表述待法务确认。
  - **根 Suspense 态** `src/app/loading.tsx`：导航到 force-dynamic 页面（如 /industries 实时查 Neon 计数）或数据流式返回时先展示骨架（Spinner role="status" + Skeleton 网格）而非白屏；对 Neon 免费库冷启动首连 ~5s 的场景尤其有用。
  - **导航/页脚更新** `src/app/layout.tsx`：导航移除死链 `/cases` `/solutions`（里程碑 2 才建），加入 `/industries`；页脚改为多链接导航（行业 / 关于 / 隐私 / 条款 / GitHub）+ 明示"隐私政策与服务条款为占位草稿，待法务审定后生效"。
  - **测试新增**：`tests/unit/industries.test.ts`（15 cases：INDUSTRIES 数量与 IndustrySchema 对齐、枚举无重复无遗漏、slug 合法且唯一、中英文名/简介/图标非空、OTHER 兜底在最后、PUBLIC_CASE_STAGES 内容断言、getIndustryBySlug/ByEnum/getIndustrySlug/isValidIndustrySlug 正常与未知输入、slug↔enum 双向自洽）；`tests/integration/industries-count.test.ts`（2 cases，真连 Neon：getIndustryCaseCounts 返回 ok 且每个行业 slug 有非负整数计数、counts 键恰好等于 7 个 slug；含冷启动预热重试）。
- 验证（宪法第 5/18/20 条）：
  - `next typegen`：路由类型生成成功。
  - `tsc --noEmit`：**0 错误**（修复 terms 页 `SECTIONS` 因 `as const` 导致的联合类型 `highlight` 属性缺失 → 显式 `ReadonlyArray<{…; highlight?: boolean}>` 标注）。
  - `eslint .`：**0 问题**。
  - `vitest run tests/unit`：**140/140 全绿**（原 125 + 新增 15），~0.6s。
  - `node --env-file=.env vitest run tests/integration`：**7/7 全绿**（原 5 + 新增 2），9.1s，真连 Neon us-east-2 无回归。
  - `next build`（Turbopack）：**编译成功**，产出 6 条新路由 —— `○ /about`、`○ /privacy`、`○ /terms`（静态）、`ƒ /industries`（动态计数）、`● /industries/[slug]`（SSG 预渲染 7 个 slug）、`ƒ /`、`ƒ /api/health`、`○ /ui`、`○ /_not-found` + Proxy。
  - **HTTP 端到端冒烟**（`next start -p 3111`，9 项全过）：`/` `/industries` `/industries/new-energy` `/industries/agriculture-forestry-fishery` `/about` `/privacy` `/terms` `/api/health` 均 **200** 且带 `x-request-id` 与内容标记；`/industries/not-a-real-one` **404**（真状态码，验证 dynamicParams=false 生效）。冒烟首轮暴露并修复：force-dynamic + 根 loading.tsx 下 notFound() 返回 200 而非 404 → 改 SSG + dynamicParams=false 彻底解决。
- 效果：**Phase 5 里程碑 1 达成**——公共页面地基（可复用页面骨架 + 行业列表/详情 + 关于/隐私/条款 + 导航页脚 + Suspense 态）就绪，全部经 build + 145 测试 + 9 项 HTTP 冒烟验证。测试基线扩到 147（140 单元 + 7 集成）。里程碑 2（DEMO 标注种子数据 + 案例列表/详情 + 方案列表/详情 + 分页）、里程碑 3（搜索 + 首页组装）待续。ROADMAP 阻塞剩余 #3 github.com CLI（API 绕行中）、#4 模型 API Key、#5 部署/支付、#6 对象存储。

## [0.4.2] - 2026-09-04 · Phase 4 里程碑 3：设计 tokens + 基础 UI 组件库 + API 客户端层 + Proxy 中间件

- 原因：里程碑 2 打通了"能跑能测"的后端骨架，但总控 Phase 4 交付清单里的「基础 UI」仍是空白；同时所有 API Route 需要的横切关注点（request-id 追踪、入参校验、统一 fetch、访问日志、安全头）尚未沉淀。本里程碑把这些一次性补齐，让 Phase 5 的 35 个页面可以"照抄即用"，避免每个页面各写一套样式/校验/错误处理（宪法第 4/5 条：先铺可复用地基；第 12 条：重复 >3 次的人工作业考虑自动化/标准化）。
- 内容：
  - **设计 tokens** `src/app/globals.css`：新增颜色（primary 产业蓝 / success / warning / danger / info / muted / border / ring + 各自 foreground）、圆角（sm/md/lg/xl）、阴影（sm/md/lg）三组 CSS 变量，亮/暗双模式（`prefers-color-scheme`）；经 Tailwind v4 `@theme inline` 暴露为工具类（`bg-primary` / `text-muted-foreground` / `rounded-lg` / `shadow-md` 等）。全局 `:focus-visible` 焦点环走 `--ring` 变量，键盘可达性优先。所有组件颜色一律走 token，零硬编码色值。
  - **className 工具** `src/lib/cn.ts`：零依赖版 `cn()`（不引 clsx + tailwind-merge，减 ~15KB gzip 与版本同步负担），支持 string / number / 数组嵌套 / 对象 truthy / falsy 过滤。
  - **基础 UI 组件库** `src/components/ui/`（11 个组件 + barrel `index.ts`，全部 Server Component 安全）：
    - `Button.tsx` — 5 变体（primary/secondary/ghost/danger/link）× 4 尺寸（sm/md/lg/icon）+ loading 态 + disabled；极简 polymorphic（传 `href` 渲染 `<a>`，否则 `<button>`），不引 Radix Slot。danger 变体满足宪法第 21 条"破坏性操作须视觉区分"。
    - `Card.tsx` — Card / CardHeader / CardTitle / CardDescription / CardContent / CardFooter，支持 `interactive`（悬停阴影 + 边框高亮）。
    - `Badge.tsx` — 7 变体（neutral/primary/success/warning/danger/info/outline）+ compact 模式，语义对齐业务（证据等级、审核状态、许可证风险、行业标签）。
    - `Input.tsx` — Input / Textarea / Label / FieldError / Field（表单字段容器，约定 `${htmlFor}-error` / `-help` 的 aria id）；invalid 态走 `aria-invalid` + 红框。
    - `Alert.tsx` — 4 变体（info/success/warning/danger）+ `role="alert"|"status"` 可及性；warning 变体承载宪法第 21 条"需要专业人工确认"高风险提示。
    - `Skeleton.tsx` — Skeleton（rect/circle/text 三变体，纯 CSS animate-pulse）+ Spinner（role="status" + aria-label，纯 CSS 旋转无 SVG 依赖）。
    - `Container.tsx` — Container（sm/md/lg/xl/full 五档最大宽度，lg 与 layout 导航 max-w-6xl 对齐）+ Separator（水平/垂直，装饰性时 aria-hidden）。
  - **API 客户端层** `src/lib/api-client.ts`：`ApiClient` 类统一 fetch（禁止业务裸 fetch）。baseUrl + path + query 自动拼接（跳过 null/undefined）；JSON body 自动序列化 + content-type；自动注入/透传 `x-request-id`；超时走 `AbortSignal.timeout`（默认 10s）；非 2xx 按状态码/上游 code 还原成对应 AppError 子类（400→Validation … 429→RateLimited，5xx→Upstream）；网络层错误（超时/DNS/连接重置）包成 UpstreamError 保留 cause；幂等方法（GET/HEAD/OPTIONS）可选指数退避重试（±20% 抖动防重试风暴，默认关闭，POST 永不重试）；get/post/put/patch/delete 快捷方法；导出浏览器内调本站 API 的默认单例 `apiClient`。
  - **校验 schema 集** `src/lib/validation.ts`（Zod v4）：ID 类（CuidSchema / UuidSchema / SlugSchema）；PaginationSchema（page 从 1、pageSize 默认 20 上限 100 防拉爆库、自动算 offset/limit、coerce 字符串查询参数）；makeSortSchema（字段白名单 + 自动生成 orderBy，防 SQL 注入/全字段排序）；SearchQuerySchema（trim + 去控制字符 + 1–100 限长）；**11 个业务枚举与 `prisma/schema.prisma` 一一对应**（Industry 7 / CaseStage 5 漏斗 / EvidenceType 事实假设推断预测 / Maturity 4 / LicenseType 11 / LicenseReviewStatus 4 / SolutionStatus 3 态 / Currency / BuyerType / OrderStatus / ChangeAction 含 ROLLBACK）；paginatedResponseSchema 泛型包装 + HealthResponseSchema（与 /api/health 同步）。
  - **request-id 工具** `src/lib/request-id.ts`：`generateRequestId`（node:crypto UUID v4）/ `isValidRequestId`（字符集 `[A-Za-z0-9-]` 长度 8–64，拒绝 CRLF 防日志注入）/ `extractOrGenerateRequestId`（客户端合法 id 才采纳）/ `sanitizeForLog`（去控制字符双保险）/ `REQUEST_ID_HEADER` 常量。
  - **Proxy 中间件** `src/proxy.ts`（Next.js 16：middleware 重命名为 proxy，导出函数名 `proxy`）：① 每个入站请求分配/透传 `x-request-id`，**同时注入下游请求头**（`NextResponse.next({ request: { headers } })`，让 Route Handler 即使客户端没传也能读到）+ 写回响应头；② 结构化访问日志（JSON 一行：requestId/fromClient/method/path/query/durationMs/ua 截断 200/ip/timestamp）；③ 基础安全头（X-Content-Type-Options nosniff / X-Frame-Options DENY / Referrer-Policy strict-origin-when-cross-origin；CSP 留 Phase 14 配 nonce 时再加）；④ matcher 排除静态资源 + 跳过 `/_next`、图片、字体等噪音。Edge 安全：request-id 生成优先用 Edge 原生 Web Crypto `randomUUID()`（与 node 版 UUID 格式一致），不依赖 node:crypto。
  - **/api/health 升级**：GET 接收 `NextRequest`，从请求头读回 request-id 放进 JSON body（`requestId` 字段），与响应头一致，方便前端/监控双向关联；logger 派生 `child({ requestId })`。
  - **/ui 演示页** `src/app/ui/page.tsx`：一页渲染全部组件（Button 全变体/尺寸/态、Badge 7 变体、Alert 4 变体、Card 静态+交互、表单 Field/Input/Textarea/错误态/禁用态、Spinner/Skeleton、设计 tokens 色板），build 后 HTTP 冒烟即可确认组件库无运行时错误；给零基础创始人一个"看得见"的设计系统参考（总控第 41 节）；robots noindex。layout 导航加 `ui` 入口。
  - **测试新增** `tests/unit/`：`cn.test.ts`（9 cases）、`request-id.test.ts`（12 cases：UUID 格式/万次唯一性/字符集校验/CRLF 拒绝/提取或生成/净化）、`validation.test.ts`（33 cases：ID/分页默认值与上限/排序白名单防注入/搜索净化/11 枚举成员数与值断言/响应包装/Health schema）、`api-client.test.ts`（27 cases：URL 构造/query 跳过空值/绝对路径/request-id 注入与透传与非法忽略/JSON 序列化/头合并/响应解析 JSON-text-204/6 种状态码→AppError 子类/5xx→Upstream/上游 code 还原/非 JSON 错误体/网络错误包装/幂等重试与非幂等不重试与重试耗尽与 429 与 404 不重试/AbortSignal 超时）。
- 验证（宪法第 5/18/20 条）：
  - `tsc --noEmit`：**0 错误**（修复 AlertProps 与 div `title` 冲突 → Omit、RequestOptions 重新声明 `body`、测试 `err` unknown → `captureError` 助手）。
  - `vitest run tests/unit`：**125/125 全绿**（原 44 + 新增 81），432ms。
  - `node --env-file=.env vitest run tests/integration`：**5/5 全绿**，8.86s（真连 Neon us-east-2，无回归）。
  - `next build`（Turbopack）：**编译成功**，1333ms 编译 + 3.6s TS + 静态生成；产出 **4 条路由 + Proxy(Middleware)**：`ƒ /` / `○ /_not-found` / `ƒ /api/health` / `○ /ui`（预渲染静态）。
  - **HTTP 端到端冒烟**（`next start -p 3114`）：DB 预热 1 次成功（lat 3706ms 冷启动）；`/api/health` 无客户端 id → **200** 服务端生成 UUID 且 **header 与 body.requestId 一致（match=true，证明 request-id 已透传到 Route Handler）**；带合法 client id → **echo=true**；带非法 id（过短 "abc"）→ **rejected=true regenerated=true**；安全头三件齐全；`/ui` → **200** 44631 字节，Button/Badge/Alert/Spinner 全部渲染；`/` → **200** 22371 字节含"数据库实时状态"；`/definitely-not-here` → **404** 带 request-id。
  - 冒烟中发现并修复 2 个真问题：① proxy 原来只写响应头不注入下游请求头 → Route Handler 读不到（auto-rid 时 body.requestId 为 undefined）；② `edgeGenerateRequestId` 原产出带下划线的 `req_x_y` 过不了自己的 `isValidRequestId`（字符集不含下划线）→ 改用 Web Crypto UUID + 连字符兜底。另记录：CRLF 头注入在 undici 客户端层即被拒（`Headers.append invalid`），服务端净化为纵深防御。
- 效果：**Phase 4 里程碑 3 达成**——总控 Phase 4 交付清单（Web 骨架 / 数据库连接 / 基础 UI / 环境变量 / 日志 / 错误处理 / 测试框架）**全部完成**。设计系统 + API 客户端 + 校验 + 追踪 + 安全头地基就绪，Phase 5（35 公共/用户/后台页面）可直接复用。测试基线扩到 130（125 单元 + 5 集成）。ROADMAP 阻塞剩余 #3 github.com CLI（API 绕行中）、#4 模型 API Key、#5 部署/支付、#6 对象存储。

## [0.4.1] - 2026-09-04 · Phase 4 里程碑 2：项目骨架 + 测试基线全绿

- 原因：DB 上线后立刻铺 V1-A 骨架，把 Next.js 16 约定、Prisma Client 单例、结构化日志、错误层级、env 校验、健康检查 API、Vitest 测试基线一次性打通（宪法第 4 条：先跑通再优化；总控 Phase 4 交付清单）。
- 内容：
  - **依赖**：新增 `zod ^4.5.4`（env 校验）；devDeps 新增 `vitest ^5.0.0`、`tsx ^4.23.13`；`@types/node` 升 `^20` → `^22.20.1`（vitest 5 peer 要求，运行时 Node v24.17 更贴合）。npm scripts 新增 `test` / `test:watch` / `test:unit` / `test:integration` / `typecheck`；`package.json` version 从 0.1.0 → 0.4.0。
  - **核心库** `src/lib/`：
    - `env.ts` — Zod 校验 `DATABASE_URL` / `NODE_ENV` / `LOG_LEVEL` / `NEXT_PUBLIC_SITE_URL`，惰性求值 + 单例缓存，失败时列出所有出错字段并给出 `.env.example` 提示。
    - `logger.ts` — 薄壳结构化 JSON 日志（不引 pino，减依赖面）；内置 21 个敏感字段脱敏（password / token / DATABASE_URL / api_key / cookie / credit_card 等），支持深层嵌套 + 数组 + Error cause + 循环引用 + BigInt / Date / Function 序列化；child(bindings) 派生子 logger；level 阈值 + silent 全静音；error/fatal 走 stderr。
    - `errors.ts` — `AppError` 基类 + 8 个子类（Validation / Unauthorized / Forbidden / NotFound / Conflict / RateLimited / DB / Upstream），code→HTTP 状态映射表；`isAppError` 跨 realm 安全判定；`toErrorResponse` 统一 API 错误出口，自动识别 Prisma P2002 / P2025 / P#### 码，生产环境屏蔽原始 message 防泄漏。
    - `prisma.ts` — Prisma Client 单例（globalThis 挂载避免 Next.js HMR 连接泄漏），按环境分级日志（dev: query+warn+error, test/prod: error only）。
  - **Next.js shell** `src/app/`：
    - `layout.tsx` — 更新 metadata（title template / description / metadataBase / robots noindex 开发期），添加中文导航（案例/方案/关于/health）+ 页脚。**去除 `next/font/google` Geist 依赖**（本机构建时 fonts.googleapis.com 不可达，build 会 fail），改为纯 CSS 系统字体栈。
    - `globals.css` — 定义 `--font-sans`（含 PingFang SC / Microsoft YaHei / Noto Sans SC 中英混排回落）+ `--font-mono`；Tailwind v4 `@theme inline` 接入。
    - `page.tsx` — 首页 Server Component，`force-dynamic`，查 `pg_stat_user_tables` 实时渲染 17 张业务表的行数卡片，DB 失败时显示红色错误面板。
    - `error.tsx` — 全局错误边界（Client Component），显示 message + digest + 重试按钮 + 回首页链接。
    - `not-found.tsx` — 404 页。
    - `api/health/route.ts` — GET `/api/health`，`force-dynamic`，跑 `SELECT 1` 测 DB 往返延迟，返回 `{ ok, service, version, node, uptime_sec, db: {ok, latency_ms}, timestamp }`；错误时经 `toErrorResponse` 统一响应。
  - **测试基线** `tests/`：
    - `vitest.config.ts` — node env、`@/*` 别名、30s 超时（跨太平洋连 Neon us-east-2）、forks pool（避免 Prisma Engine 在 worker_threads 里偶发段错误）。
    - `tests/unit/errors.test.ts` — 19 cases：状态码映射 / httpStatus 覆盖 / 未知 code 兜底 / toJSON 稳定性 / details 可选 / cause 保留 / isAppError 4 分支 / toErrorResponse Prisma P2002 P2025 P#### / prod 屏蔽 message / 非 Error 值处理。
    - `tests/unit/logger.test.ts` — 15 cases：JSON 单行输出 / level 阈值 / silent / stdout-stderr 分流 / 顶层脱敏 / 深层嵌套脱敏 / DATABASE_URL 脱敏 / Error 序列化 / 循环引用 / child 派生 / withLevel / __redact 边界（Date / BigInt / Function / 原始值）。
    - `tests/unit/env.test.ts` — 10 cases：postgresql:// / postgres:// / NODE_ENV / LOG_LEVEL / NEXT_PUBLIC_SITE_URL / 缓存单例 / DATABASE_URL 缺失 / 非 postgres 协议 / NODE_ENV 非法 / LOG_LEVEL 非法 / 多字段错误汇总 + Hint 提示。使用 `vi.stubEnv`（@types/node v22 把 NODE_ENV 声明为只读，直接赋值 TS 报错）。
    - `tests/integration/db-smoke.test.ts` — 5 cases，真连 Neon：SELECT 1 / Region 全 CRUD / 11 枚举存在性 / 17 表存在性 / `_prisma_migrations` 记录 `0_init` 已应用未回滚。afterAll 双兜底清理（by id + by name prefix）。DATABASE_URL 缺失时自动 skip 而非 fail。
  - **Next.js 16 类型**：跑 `next typegen` 生成 `.next/types/{routes,cache-life,root-params,validator}.d.ts`，让全局 `LayoutProps<'/'>` 助手在 tsc 中可见（.next/ 已被 gitignore）。
- 验证（宪法第 5/18/20 条：可验证 + 每 Phase 必测 + 诚实汇报）：
  - `tsc --noEmit`：0 错误。
  - `vitest run tests/unit`：**44/44 全绿**，416ms。
  - `node --env-file=.env vitest run tests/integration`：**5/5 全绿**，8.24s（真连 Neon us-east-2）。
  - `next build`（Turbopack）：**编译成功**，671ms 编译 + 3.3s TS + 790ms 静态生成；产出 3 条路由：`ƒ /`（动态 Server Component）/ `○ /_not-found`（静态）/ `ƒ /api/health`（动态）。
  - **HTTP 端到端冒烟**（`next start -p 3111` + node http.get）：
    - `GET /api/health` → **200**，body `{"ok":true,"service":"website-project","version":"0.4.0","node":"v24.17.0","uptime_sec":4,"db":{"ok":true,"latency_ms":3660},"timestamp":"2026-09-04T15:36:39.858Z"}`（首查 3.6s 含 Neon 冷启动唤醒，热起来 ~200ms）。
    - `GET /` → **200**，22129 字节 HTML，包含"数据库实时状态"、"Phase 4"、"Region" 卡片。
    - `GET /definitely-not-here` → **404**，包含"404"、"页面不存在"。
- 效果：**Phase 4 里程碑 2 达成**——项目骨架完整可运行可测试。ROADMAP 阻塞清单 #1 #2 均已解除，剩余 #3 github.com CLI（走 API 绕过中）、#4 模型 API Key、#5 部署/支付、#6 对象存储。可开工 Phase 5（公共页面）与 Phase 6（用户系统）。

## [0.4.0] - 2026-09-04 · Phase 4 里程碑 1：数据库上线

- 原因：创始人提供了 Neon 免费托管 Postgres 的 `DATABASE_URL`，Phase 4 唯一硬阻塞解除。
- 内容：
  - 写入 `website-project/.env`（已被 `.gitignore` 的 `.env*` 规则排除，验证：`git check-ignore -v .env` → `.gitignore:38:.env*`）。文件仅存本机，**永不入 Git**。
  - `prisma migrate status`：连接成功，识别 1 条待应用迁移 `0_init`。
  - `prisma migrate deploy`：将 `prisma/migrations/0_init/migration.sql`（17 张 CREATE TABLE、391 行）应用到 Neon 数据库 `neondb`（region `us-east-2`）。输出："All migrations have been successfully applied."
  - 验证查询（`PrismaClient.$queryRawUnsafe` 读 `information_schema` 与 `pg_enum`）：
    - **表总数 18**：17 张业务表（BusinessModel / CapabilityProject / Case / CaseCapability / ChangeLog / Evidence / Localization / LocalizationSupplier / Market / OpenSourceProject / Order / Region / Solution / SolutionFinancial / Supplier / TechCapability / UnknownVariable）+ 1 张 `_prisma_migrations`。
    - **`_prisma_migrations` 记录**：`0_init`，applied_steps_count=1，finished_at=`2026-09-04T15:22:16.915Z`，rolled_back_at=NULL。
    - **11 个枚举全部就位**（值与 schema.prisma 一致）：Industry(7) / CaseStage(5) / EvidenceType(4) / Maturity(4) / LicenseType(11) / LicenseReviewStatus(4) / SolutionStatus(3) / Currency(2) / BuyerType(2) / OrderStatus(4) / ChangeAction(4)。
- 效果：**Phase 4 里程碑 1 达成**——V1 核心闭环数据结构在真实 Postgres 上跑通、可读写。ROADMAP 阻塞清单 #1（数据库）已消除。剩余 Phase 4 工作：目录结构、Prisma Client 单例、日志、错误处理、Vitest 测试框架 + 首个冒烟测试、基础 UI shell。

## [0.3.2] - 2026-09-04

- 原因：Phase 4 唯一硬阻塞是"没有可连接的 Postgres"；创始人零编码背景，需要一份可自助照做的托管数据库注册指引，避免注册过程中反复问答（宪法第2条 MVP 优先）。
- 内容：新增 `docs/SETUP_NEON_DATABASE.md`——Neon 免费 Postgres 分步指引（注册 → 创建项目 → 复制 URI → 回传），含区域选择建议（新加坡 `ap-southeast-1` 优先）、Free 计划额度、7 条 FAQ、安全须知（URL 泄漏后如何 reset）。
- 效果：创始人可在 ~10 分钟内自助拿到 `DATABASE_URL`；一旦回传，我即执行 `prisma migrate deploy` → seed → 进入 Phase 4 骨架搭建。

## [0.3.1] - 2026-09-04

- 原因：解除 Phase 4 的"依赖下载卡顿"阻塞（创始人批准使用国内镜像源）。
- 内容：
  - npm 源切至 npmmirror，并设 `PRISMA_ENGINES_MIRROR` 指向 npmmirror 的 Prisma 二进制镜像。
  - `npm install` 成功：1 分钟装完 393 个包；`postinstall` 的 `prisma generate` 成功生成 Prisma Client v6.19.3。
  - **`prisma validate` 通过**：`The schema at prisma\schema.prisma is valid`（此前 0.2.0/0.3.0 记录的"未跑通"已解除）。
  - 用 `prisma migrate diff --from-empty` 离线生成初始迁移 `prisma/migrations/0_init/migration.sql`（17 张表、391 行，无报错）+ `migration_lock.toml`；提交 `package-lock.json` 锁定依赖版本。
  - 保持 Prisma 6.19.3 stable，不升级到 8.0.0-rc（宪法：稳定优先、不追新）。
- 效果：schema 已通过官方校验且能生成合法 Postgres DDL；依赖链就绪。**仍待**：一个可连接的 Postgres 以执行 `prisma migrate deploy`（本机无 DB，创始人将提供免费托管连接串）。

## [0.3.0] - 2026-09-04

- 原因：接收《全自动开发总控 Prompt V1.0》，执行其第一阶段（Phase 0–3：环境检查 + 基础文档），暂不写业务代码（总控第37–39节）。
- 内容：
  - 总控 Prompt 版本化入库 `docs/MASTER_PROMPT_V1.md`。
  - 新增文档集：`README.md`、`PROJECT_RULES.md`（索引+优先级+冲突裁决）、`PRODUCT_SPEC.md`、`ARCHITECTURE.md`、`DATABASE.md`、`AI_WORKFLOW.md`、`SECURITY.md`、`TESTING.md`、`ROADMAP.md`、`CHANGELOG.md`、`.env.example`。
  - 环境检查：Node v24.17 / npm 11.13 / git 2.52 / gh 2.100；本机无 Postgres、无 Docker；npm 重型依赖下载 stall；命令行不可达 github.com（仅 api.github.com）。
- 效果：项目具备完整 Phase 0–3 设计基线与治理文档；明确 V1-A/V1-B 分层与 5 项开放决策、6 项进入 Phase 4 的阻塞资源。**未编写业务代码，未跑通 prisma validate/migrate（环境阻塞，已如实记录）。**

## [0.2.0] - 2026-09-04

- 原因：定义产业能力数据库 V1（宪法第12/13条）。
- 内容：新增 `prisma/schema.prisma`（12 核心实体 + ChangeLog，Postgres），`docs/DATABASE_SCHEMA_V1.md` 设计说明；`package.json` 接入 prisma ^6 / @prisma/client 与 db:* 脚本。
- 效果：核心闭环数据结构就绪（提交 `66fbec5`）；待 Postgres 与依赖就绪后 `prisma validate/migrate`。

## [0.1.1] - 2026-09-04

- 原因：确立项目宪法为最高优先级并版本化（宪法第13条）。
- 内容：新增 `docs/PROJECT_RULES_V2.md`（宪法全文），`AGENTS.md` 顶部加指针（保留 Next.js 自动块）。
- 效果：治理基线入库（提交 `d056391`）。

## [0.1.0] - 2026-09-04

- 原因：项目启动。
- 内容：create-next-app 生成 Next.js 16 + TS + Tailwind + ESLint 脚手架；创建公开仓库 `yvzibaba/website-project`。
- 效果：可开发的空项目基线（提交 `17ad619`）。
