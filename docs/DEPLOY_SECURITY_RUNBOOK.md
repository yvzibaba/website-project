# 上线部署与安全加固 Runbook（DEPLOY_SECURITY_RUNBOOK）

> 状态：**文档 / 模板，尚未部署、尚未生效**。本文件是给「人」执行的一次性清单，不自动跑任何操作。
> 依据：项目宪法 §13（版本化可回滚）、§20（诚实，不虚构已完成）、§21（高风险关键决策归人）、SECURITY.md（密钥只走环境变量、绝不进 Git）。
> 关联待办：本 Runbook 里标注了 ⚠️【须人工执行】 的项，属高风险，**刻意留给创始人审核后操作**，夜间自主推进不触碰。

本文件解决两件事：把「怎么安全地上线」写清楚（部署 + 加固），以及把「怎么防止密钥/明文 TLS 再次漏进仓库」自动化（CI 护栏模板）。

---

## 0. 当前真实状态（诚实基线，勿当成已完成）

- 站点跑在开发/预览阶段：`isIndexable()` 目前返回 false（`NEXT_PUBLIC_SITE_URL` 未配正式域名 + 非 production 构建），`robots.txt` 全站 `Disallow: /`，`sitemap.xml` 返回空。这是**故意的**，别在没准备好时误放开。
- 数据库：Neon 远程 PostgreSQL（`.env` 里的 `DATABASE_URL`）。`.env` 已被 `.gitignore`（`.env*`，仅放行 `.env.example`），远端仓库里 `.env` 恒为 404，从未通过 Git 泄漏。
- 模型供应商：DeepSeek（OpenAI 兼容）。`DEEPSEEK_API_KEY` 走环境变量；无 key 时 `createChatProvider()` 回落确定性 StubProvider（CI/离线无需 key）。
- 商业闭环：案例发现→拆解→技术/开源匹配→本土化→方案→查看→购买（下单→站外付款→后台确认解锁正文）已打通到 v0.55.0。**支付仍是「支付说明 + 后台人工确认」，未接真实支付网关回调**（高风险，刻意暂缓）。

---

## 1. ⚠️【须人工执行】旧 DeepSeek key 撤销（最高优先，遗留风险）

旧 key（尾号 …1fd0）在会话中曾以明文出现在聊天/内存，应视为**已泄露**。新 key（尾号 …4e87）已放入本机 `.env` 并实测 HTTP 200 可用。

撤销旧 key 只能由人在供应商控制台完成，程序无法代劳：

1. 登录 DeepSeek 开放平台 → API Keys 管理页。
2. 找到旧 key（**核对尾号 …1fd0**，不要误删新 key …4e87）→ 撤销 / 删除。
3. 若旧 key 曾被使用，检查用量/账单页有无异常调用。
4. 撤销后，本机 `.env` 保持新 key 即可；无需改代码（key 名不变）。

红线：任何 key 都**绝不**写进前端、日志、Git、错误信息（SECURITY.md / 宪法 §20）。日志只记长度/掩码。

---

## 2. ⚠️【须人工执行】生产部署清单（顺序敏感）

> 触发条件：创始人决定正式上线。以下每一步都可能对外产生真实影响，逐项确认后执行。

准备
- [ ] 正式域名就绪，并能在 DNS 里配 `NEXT_PUBLIC_SITE_URL=https://<域名>`（**必须 https://**，非 localhost）。
- [ ] 生产 `DATABASE_URL` 指向**独立的生产库**（勿复用开发/预览库），连接串含强密码，走 secret 注入。
- [ ] 新生成 `AUTH_SECRET`：`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`（32 字节 base64，**每个环境不同**，勿复用开发值）。
- [ ] 生产 `DEEPSEEK_API_KEY` 用**专用生产 key**（与开发分离，便于单独轮换/限额）。

构建与运行
- [ ] `npm ci`（锁定 lockfile，勿 `npm install` 漂移）。
- [ ] `npx prisma migrate deploy`（对生产库应用已审迁移；先备份，见 §4 回滚）。
- [ ] `npm run build`（`NODE_ENV=production`；构建期会跑 `next typegen`）。
- [ ] `npm run start`（或反代到该端口）。**不要**在生产设 `NODE_TLS_REJECT_UNAUTHORIZED=0`（见 §3）。
- [ ] 反向代理（Nginx/Caddy/云 LB）配 TLS 证书 + 真实客户端 IP（`X-Forwarded-For`）+ `AUTH_URL`/trustHost。

上线后验证
- [ ] 访问 `/api/health` 返回版本与依赖健康。
- [ ] 访问 `/robots.txt` 应变为放行 + 指向 `/sitemap.xml`；`/sitemap.xml` 出现真实公开 URL。
- [ ] 手动走一遍游客→注册/登录→查看方案→下单→后台确认→正文解锁（E2E 主链，宪法 §17）。
- [ ] 确认没有任何 `.env`、密钥、`NODE_TLS_REJECT_UNAUTHORIZED` 进入构建产物 / 前端 bundle。

---

## 3. ⚠️【须人工执行】TLS 校验护栏（本仓曾受环境注入污染）

背景：开发机环境曾注入 `NODE_TLS_REJECT_UNAUTHORIZED=0` 以绕过自签证书。这在**生产绝不允许**——它会让对数据库/DeepSeek/回调的 HTTPS 请求失去证书校验，等同把连接敞开给中间人。

加固
- [ ] 生产进程环境**不得**含 `NODE_TLS_REJECT_UNAUTHORIZED`（缺省即 `1`，最安全）。
- [ ] 若确需连自签证书的内部服务：**用正确的 CA 证书链**（`NODE_EXTRA_CA_CERTS=/path/ca.pem`）而非关掉校验。
- [ ] CI 加断言（见 §5 模板）：构建/测试 job 若检测到 `NODE_TLS_REJECT_UNAUTHORIZED=0` 立即 fail。

---

## 4. 回滚（版本化可回滚，宪法 §13）

- 应用层：保留上一次生产构建产物/镜像 tag；异常时回切上一个版本 tag 并重启，再排查。
- 数据层：`prisma migrate` **只往前走**，回滚靠**部署前备份**。每次 `migrate deploy` 前先做 Neon 分支/快照（`pg_dump` 兜底），出问题 `restore` 到该快照，不要手改生产数据覆盖。
- 配置层：环境变量/密钥的变更记 in/out 值掩码台账；回滚即切回上一组 secret 并重启。

---

## 5. CI 密钥扫描 / TLS 护栏 配置模板（**未激活**，供审核后再落 `.github/workflows/`）

> 夜间**不**新建会自动运行的 `.github/workflows/*.yml`（避免意外消耗 Actions / 触发未审流水线）。下面整段是**待审核模板**，另存了一份 `ci-guard.yml.example` 于本目录，确认无误后手动 `cp` 到 `.github/workflows/ci-guard.yml` 即激活。

```yaml
# .github/workflows/ci-guard.yml —— 密钥扫描 + TLS 断言 + 基础质量门（示例，需人工启用）
name: CI Guard
on:
  push: { branches: [main] }
  pull_request:
jobs:
  secret-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      # gitleaks：扫历史与工作区里的密钥/token（含 DeepSeek sk- 前缀、数据库连接串等）
      - uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      # 兜底 grep：任何被跟踪文件里出现明文 sk- 或 password:// 直接失败
      - name: Fail on plaintext secrets
        run: |
          if git grep -nE 'sk-[a-z0-9]{20,}|postgresql://[^:]+:[^@]{6,}@' -- ':!*.example' ':!docs'; then
            echo "Found possible plaintext secret in tracked files"; exit 1
          fi
          echo "No plaintext secrets detected."
  tls-guard:
    runs-on: ubuntu-latest
    steps:
      - name: Assert TLS verification is ON
        run: |
          if [ "${NODE_TLS_REJECT_UNAUTHORIZED:-1}" = "0" ]; then
            echo "NODE_TLS_REJECT_UNAUTHORIZED=0 must NEVER be set in CI/prod"; exit 1
          fi
          echo "TLS verification OK."
  quality:
    runs-on: ubuntu-latest
    needs: [secret-scan, tls-guard]
    env:
      DATABASE_URL: ""          # 单元/tsc/eslint 不连库；集成测试另配服务
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npx tsc --noEmit
      - run: npm run lint
      - run: npm run test          # 单元（Stub provider，无需 key）
      # build 若需要类型/资源，可在通过单元后追加：npm run build
```

本地等价一次性自查（无需 CI，随时可跑，纯只读）：
```bash
# 1) 确认 .env 未被跟踪
git ls-files | grep -E '^\.env$' || echo ".env NOT tracked (good)"
# 2) 扫被跟踪文件里的明文 key（排除模板/文档）
git grep -nE 'sk-[a-z0-9]{20,}' -- ':!*.example' ':!docs' || echo "no plaintext sk- keys"
```

---

## 6. 上线就绪度缺口（对应晨间决策包，均为高风险·归人）

1. 公开收款 / 真实支付网关回调（含对账）——涉及资金，须人工确认。
2. R8.8b 融资模型核心口径（总投资自上而下反推规模、贷款比例、债务现金流、DSCR、Equity IRR、银行可贷性）——改变财务口径，高风险。
3. 法务/合规审定（隐私政策、服务条款目前为占位草稿；页脚已注明）。
4. 生产部署 / 域名 / TLS / 密钥轮换（本 Runbook §1–§3，全部 ⚠️ 归人）。
5. 权威地区真实数据接入（山西电价/光照/补贴/造价等）→ 经 `makeVerifiedFact` 把沙盘入参落成带 `sourceUrl` 的真 FACT（§20：无可靠来源绝不虚构数值）。
