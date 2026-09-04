# SECURITY — 隐私与安全

来源：总控 Prompt 第13节；宪法第10/11 条。原则：默认安全、最小权限、密钥不落库不入 Git、可审计。

## 1. 密钥与配置

- 所有 API Key / 数据库密码 / 支付密钥 **只放环境变量**（`.env.local`，已被 `.gitignore` 忽略）。
- **禁止**写进前端代码、**禁止**提交进 Git、**禁止**出现在客户端 bundle。
- 仓库提供 [`.env.example`](./.env.example) 作为占位模板，只含变量名与注释，**绝不含真实值**。
- 服务端密钥只在 Server 侧（Route Handler / Server Action / jobs）读取，绝不下发到浏览器。

## 2. 日志脱敏

日志**禁止打印**：API Key、密码、Token、敏感企业资料（企业财务/客户名单/专利细节等）。统一走 `lib/logger`，内置脱敏（redact）字段清单；错误上报只记必要上下文。

## 3. 数据隔离与访问控制

- 用户/企业数据按 `userId` / `organizationId` 隔离；所有查询在服务层强制加归属过滤，避免越权读取（IDOR）。
- 企业上传文件存对象存储，走**带时效的签名 URL**访问，禁止公开可读；下载/查看需鉴权与归属校验。
- 方案解锁：仅 `Order.status=PAID` 且归属当前用户时，才放行完整 `Solution.body`；未付费只返回免费摘要与目录。

## 4. 后台权限

- 后台（`/admin`）需鉴权 + 角色控制（至少：管理员 / 审核员 / 普通用户）。
- 管理员敏感操作（发布/下架/退款/删除/改配置/批准方案）**必须写 Audit Log**（`audit_logs`：who/when/what/before/after/reason）。
- 高危或不可逆操作二次确认；删除走软删除/归档，禁止物理删除生产数据（与宪法版本化/可回滚一致）。

## 5. AI 与内容安全

- LLM 输出一律 Schema 校验后入库，防注入/防幻觉直接上生产（总控第29节）。
- 许可证合规：UNKNOWN/GPL/AGPL/含商业限制 → `NEEDS_HUMAN_REVIEW`，禁止自动判定可商用（宪法第11条 / 总控第14节）。
- 高风险领域方案（法律/投资/能源/医疗/政策等）标 `needsProfessionalReview`，禁止 AI 自动公开发布（宪法第10条 / 总控第9节）。

## 6. 依赖与供应链

- 不增加不必要依赖（总控第26节）；新增依赖需记录用途与许可证。
- 定期 `npm audit`；CI 中加入依赖与许可证检查（Phase 15/16）。

## 7. 传输与存储

- 全站 HTTPS；生产禁用明文密钥回退（注意：本机曾出现 `NODE_TLS_REJECT_UNAUTHORIZED=0` 告警，仅限本地临时排障，**生产严禁**）。
- 数据库连接串走环境变量与连接池；生产用托管 PG 的 TLS。

## 8. 认证、口令与会话（Phase 6 M1 已落地）

- **方案**：Auth.js v5（`next-auth@beta`）Credentials（邮箱 + 密码）+ **JWT 会话**，`trustHost:true`。经创始人裁决选定自建（总控 §21「用成熟现成方案」）。用户表留在自有 Neon 库，零厂商锁定；**不挂 Prisma Adapter**（Credentials+JWT 无需 Account/Session/VerificationToken 表，依赖最少，宪法第 2/4 条）。V1 只做"下单身份"，OAuth/魔法链接延后（避免引入邮件通道依赖与成本）。
- **口令存储**：`src/lib/password.ts` 用 Node 内置 `node:crypto` 的 **scrypt**（N=16384,r=8,p=1,keylen=64,16 字节随机盐），自描述串 `scrypt$N$r$p$salt$hash`；**绝不存明文**（§1 / 宪法第 11 条）。校验用 `timingSafeEqual` 定长比较防时序侧信道；畸形/超长（>1024 字节 DoS 上限）一律返回 false，绝不抛裸异常。
- **防用户枚举**：`authorize()` 对"账号不存在"与"密码错误"都返回 null → 登录页统一提示"邮箱或密码不正确"；登录入参口令只要求非空（不在登录处校验最小长度，避免用"密码太短"泄露账号是否存在）。邮箱统一小写归一存储，防同邮箱多账号。
- **会话最小暴露**：session 只含 `id/email/name/role`，**绝不含 passwordHash**；`getProfileUserById` 的 select 显式排除 passwordHash（集成测试断言 `"passwordHash" in profile === false`，HTTP 冒烟断言 session 响应体不含 passwordHash）。
- **密钥**：`AUTH_SECRET`（32 字节 base64）只在 `.env`（gitignored），`.env.example` 仅留占位与生成说明。教训：脚本日志**绝不拼接密钥明文**（只记长度/掩码），一旦疑似泄露立即轮换。
- **约定**：本仓 vitest/纯 node 下 `import "server-only"` 会抛 "Cannot find module"，故 server-only 模块只在文档注释标注、**不 import**（否则单元测试无法加载）。

## 9. 待办（随 Phase 落地）

- [x] 选定认证方案并接入（Phase 6 M1：Auth.js v5 Credentials + JWT，已落地并冒烟 26/26）
- [ ] 角色/权限模型与中间件（Phase 6 M2+ / 13：`UserRole` 枚举已入库，鉴权中间件与 `/admin` 门禁待接入）
- [ ] 对象存储签名 URL 与文件访问控制（Phase 11/12）
- [ ] `audit_logs` 表与管理员操作埋点（Phase 13）
- [x] 日志脱敏工具 `lib/logger`（Phase 4 已完成：内置 redact 清单 + 深层/数组脱敏，单元测试覆盖）
- [x] `.env.example` 随新密钥需求同步更新（Phase 6：新增 `AUTH_SECRET` / `AUTH_URL` 与可选 OAuth 占位）
