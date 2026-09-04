# Neon 免费 Postgres 注册与 DATABASE_URL 获取指引

面向：零编码背景的创始人。
目标：10 分钟内拿到一个可用的 PostgreSQL 连接串（`DATABASE_URL`），发给我后我就能建表并开工 Phase 4。
成本：0 元。Neon 的 Free 计划对个人开发者足够跑通整个 V1-A（案例→方案→购买）闭环的开发与小规模上线。

---

## 0. 前置说明（先看这一段，避免踩坑）

- **Neon 是什么**：一个"云端 PostgreSQL 数据库托管服务"，官方网址 <https://neon.tech>（也可用 <https://neon.com>）。它给你的东西本质上就是一个 Postgres 服务器 + 一个连接串，你不需要在自己电脑上装任何数据库。
- **为什么选 Neon 而不是 Supabase/Vercel Postgres**：Neon 的 Free 计划最宽松（0.5 GB 存储 + 每月 191.9 计算小时，够开发用），注册流程最短（不需要绑信用卡），从中国大陆访问相对稳定，且官方明确支持 Prisma。
- **Free 计划的一个"特性"**：数据库 5 分钟无请求会自动"睡眠"，下次访问冷启动约 1 秒。这在开发阶段完全没问题，上线前我们再决定是否升级。
- **安全提醒**：`DATABASE_URL` 里包含数据库密码，等同于"你家钥匙"。**只发给我一个人**（在本对话里），不要发到公开群、GitHub Issue、截图到微博/朋友圈。我拿到后会写进 `.env.local`，这个文件已被 `.gitignore` 排除，永远不会上传到 GitHub。

---

## 1. 注册 Neon 账号（约 2 分钟）

**Step 1.1** 打开浏览器，访问 <https://neon.tech>。

**Step 1.2** 点击右上角 **Sign Up**（注册）。

**Step 1.3** 选择注册方式。**强烈推荐用 GitHub 账号登录**，因为：
- 你已经有 GitHub 账号（`yvzibaba`），一键授权即可，不用记新密码；
- 未来把 Neon 数据库和 GitHub 仓库联动（比如自动迁移）会更顺；
- 免去邮箱验证环节。

点击 **Continue with GitHub** → 浏览器会跳到 GitHub 授权页 → 点击 **Authorize neon**（授权 Neon 读取你的邮箱和用户名，**不会**给它任何仓库权限）→ 自动跳回 Neon，注册完成。

> 如果你不想用 GitHub 登录，也可以选 **Continue with Google** 或 **Continue with Email**。用邮箱注册的话需要去邮箱点验证链接，多一步。

---

## 2. 创建你的第一个项目（约 3 分钟）

注册后 Neon 会自动引导你创建第一个 Project（项目 = 一个独立的数据库实例）。

**Step 2.1** 页面标题通常是 **Create your first project**。你会看到几个填空：

| 字段 | 填什么 | 说明 |
|---|---|---|
| **Project name** | `industry-cases-v1` | 项目名，随便起，我建议这个（对应你的产品名"产业案例引擎 V1"）。 |
| **Database name** | `neondb`（保持默认） | 数据库名，默认就好。 |
| **Postgres version** | `17`（默认，最新稳定版） | 我们的 Prisma schema 兼容 14+，用最新的没问题。 |
| **Region** | **AWS Asia Pacific (Singapore)** `ap-southeast-1` | **重要**：新加坡是距离中国大陆最近、访问最稳定的区域。别选 US/EU，会慢。 |

**Step 2.2** 点击 **Create project** 按钮。

**Step 2.3** 等 5–15 秒，Neon 会给你分配一台"迷你 Postgres 服务器"。创建成功后页面会跳到 **Dashboard**（仪表板）。

---

## 3. 拿到 DATABASE_URL（约 1 分钟）

**Step 3.1** 在 Dashboard 页面，你会看到一个大标题写着 **Connect to your database** 或 **Connection Details**，右侧有一个下拉框写着 **Role**（默认是 `neondb_owner`）和 **Database**（默认是 `neondb`）。保持默认。

**Step 3.2** 下方有一段代码框，最上面有几个 Tab：**URI**、**Psql**、**Prisma**、**Node.js**、**Python** 等。**点击 URI 这个 Tab**（通常已经默认选中）。

**Step 3.3** 你会看到形如以下的一长串字符（**这就是 `DATABASE_URL`**）：

```
postgresql://neondb_owner:npg_XXXXXXXXXXXX@ep-something-12345678-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require
```

各部分的含义（不用记，只是让你放心这不是什么危险东西）：
- `neondb_owner` = 用户名
- `npg_XXXXXXXXXXXX` = 密码（Neon 自动生成的强密码）
- `ep-something-12345678-pooler.ap-southeast-1.aws.neon.tech` = 服务器地址（新加坡节点，`-pooler` 后缀表示走连接池，Prisma 需要这个）
- `neondb` = 数据库名
- `?sslmode=require&channel_binding=require` = 强制加密连接参数（**必须保留，不能删**）

**Step 3.4** 点击代码框右上角的 **Copy** 按钮（一个复印机图标），把整串复制到剪贴板。

**Step 3.5** 直接粘贴发给我。**只粘贴这一串，不需要其他信息。**

---

## 4. 我拿到 URL 之后会做的事（供你了解进度）

1. 写入 `website-project/.env.local`（`.gitignore` 已排除此文件，不会上传 GitHub）。
2. 跑 `prisma migrate deploy`：把 `prisma/migrations/0_init/migration.sql` 里的 17 张表建到你的 Neon 数据库。
3. 跑 `prisma db seed`：塞 3–5 条最小样例数据（1 个行业、1 个案例、1 个证据、1 个方案）验证读写通路。
4. 打开 `prisma studio`（Neon 提供可视化面板，也可以）让你亲眼看到表里已有数据。
5. 提交 CHANGELOG 记录这一步，然后开工 Phase 4：搭项目骨架（目录结构、Prisma Client 单例、日志、错误处理、Vitest 测试框架 + 首个冒烟测试）。

以上每一步做完我都会汇报，你不需要动手。

---

## 5. 常见问题（FAQ）

**Q1：注册时提示 "GitHub authorization failed"？**
A：多半是浏览器网络问题。刷新页面重试；或改用 **Continue with Email** 走邮箱注册。

**Q2：Region 里没有 Singapore，只有 US/EU？**
A：Neon Free 计划的可用区域偶尔调整。如果 Singapore 不可用，退而求其次选 **AWS Asia Pacific (Tokyo)** `ap-northeast-1`。都不行的话选 US-East（`us-east-1`），只是延迟稍高（200ms 左右），不影响开发。

**Q3：复制出来的 URL 里 password 部分带特殊字符（如 `@`、`/`、`=`），Prisma 会不会解析错？**
A：不会。Neon 生成的密码是 URL-safe 的（只含字母数字和下划线/短横线），并且 `?sslmode=...` 之前的部分 Prisma 会正确解析。放心用。

**Q4：我担心免费额度不够？**
A：Free 计划 = 0.5 GB 存储 + 每月 191.9 计算小时。V1-A 阶段（几十个案例、几百个用户以内）远远够用。快用完时 Neon 会邮件提醒，我们再决定升级或换供应商，不用现在焦虑。

**Q5：以后想改密码或换区域怎么办？**
A：Dashboard 里 **Roles** 页可以重置密码，**Settings** 页可以迁移区域。改完把新的 URL 发给我，我更新 `.env.local` 即可。

**Q6：这个 URL 泄漏了会怎样？**
A：拿到 URL 的人可以读/改/删你数据库里的所有数据。所以：（1）只发给我；（2）如果不小心发到别处，立刻到 Dashboard → **Roles** → **Reset password**，然后把新 URL 发我；（3）项目上线前我们会启用 IP 白名单和更严格的角色权限。

**Q7：我能不能不注册 Neon，直接用别家？**
A：可以。Supabase / Vercel Postgres / Railway / PlanetScale（MySQL 不行，我们要 Postgres）都兼容 Prisma。但 Neon 是这几家里注册最快、Free 额度最实在的。如果你有强偏好告诉我，我改指引。

---

## 6. 一句话摘要

**打开 <https://neon.tech> → Sign Up → Continue with GitHub → 创建项目（Region 选 Singapore）→ Dashboard 复制 URI → 粘贴发给我。全程约 10 分钟，0 元。**
