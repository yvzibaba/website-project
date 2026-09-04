import { prisma } from "@/lib/prisma";
import { UserRoleSchema } from "@/lib/validation";

/**
 * 用户角色授予脚本（Phase 6 M2）。
 *
 * 用途：/admin 门禁只放行 REVIEWER / ADMIN（见 src/server/authz.ts）。V1-A 不做「注册即管理员」，
 *   也不建公开的改角色端点（越权风险）——由运维在服务器本机跑此脚本，把已注册账号提权为审核员/管理员。
 *   注册入口永远只会建 role=USER 的普通账号（src/server/users.ts），提权是一次受控的运维动作。
 *
 * 安全（SECURITY §4 / 宪法第 11 条）：
 *   - 只改 role 一个字段，绝不触碰 passwordHash；
 *   - email 归一小写（与存储一致），role 必须落在 UserRole 枚举内，否则拒绝；
 *   - 目标账号不存在 → 报错退出（不自动建号，避免误造弱口令管理员）。
 *
 * 运行：npm run user:promote -- <email> <USER|REVIEWER|ADMIN>
 *   例：npm run user:promote -- owner@example.com ADMIN
 * 退出码：成功 0；用法/校验/账号不存在等错误 2。
 */

async function main(): Promise<void> {
  const [emailArg, roleArg] = process.argv.slice(2);

  if (!emailArg || !roleArg) {
    process.stderr.write("用法: npm run user:promote -- <email> <USER|REVIEWER|ADMIN>\n");
    process.exitCode = 2;
    return;
  }

  const email = emailArg.trim().toLowerCase();
  const parsedRole = UserRoleSchema.safeParse(roleArg.trim().toUpperCase());
  if (!parsedRole.success) {
    process.stderr.write(`角色非法：${roleArg}（须为 USER / REVIEWER / ADMIN）\n`);
    process.exitCode = 2;
    return;
  }
  const role = parsedRole.data;

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true, role: true } });
  if (!existing) {
    process.stderr.write(`未找到账号：${email}（请先在站点注册，再用本脚本提权；脚本不自动建号）\n`);
    process.exitCode = 2;
    return;
  }

  const updated = await prisma.user.update({
    where: { id: existing.id },
    data: { role },
    select: { id: true, email: true, role: true },
  });

  process.stdout.write(
    `角色已更新：${updated.email}  ${existing.role} → ${updated.role}  (id=${updated.id})\n`,
  );
  if (updated.role === "USER") {
    process.stdout.write("提示：已降为普通用户，该账号将无法进入 /admin。\n");
  }
  process.exitCode = 0;
}

main()
  .catch((err) => {
    process.stderr.write(`user:promote failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
