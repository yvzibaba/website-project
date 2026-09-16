# 真实用户测试工具包（V1.1 · 上线运营阶段）

> 目的：把 `docs/REAL_USER_VALIDATION_V1_1.md` 里的验证设计，落成**当场能用、算得清、且防作弊**的执行物料。
> 纪律：本工具包**只测量与记录，不改产品、不碰模型 / 财务 / 数据库 / 黄金样本**。发现的问题按 §7 分级登记，测试结束前不动代码。

## 目录内容

| 文件 | 用途 | 交给谁 |
|---|---|---|
| `OBSERVATION_TEMPLATE.csv` | 观察记录表（一行 = 一名真实用户，逐人记录 §4 的判定位 + 秒表 + 红线） | 主持人现场速记 |
| `FEEDBACK_FORM.md` | 收尾反馈表（§5 六维度，打分 + 原话） | 受访者自填 / 主持人代读 |
| `../../scripts/tally-real-user-test.mjs` | 计分器：读填好的 CSV → 出 A–F 通过率、红线信号、§10 建议分支（**带反伪造护栏**） | 测试结束后跑 |
| `../../scripts/ops-metrics.mjs` | 运营快照：只读拉 DB 里注册 / 项目 / 方案 / Lead 真实数（交叉核对 F 判据） | 每天 / 每批跑 |

---

## 一、观察表怎么填（`OBSERVATION_TEMPLATE.csv`）

复制模板、**一用户一行**填写。列含义（判定位直接对应 `REAL_USER_VALIDATION_V1_1.md` §6 的 A–F）：

| 列 | 填什么 | 对应 |
|---|---|---|
| `user_id` | 匿名编号 U01、U02…（勿写真名，护隐私） | |
| `persona` | P-1 / P-2 / P-3 / P-4 / P-5 | §1 画像 |
| `device` | desktop / mobile / tablet | §2 |
| `q1_understood` | 30 秒能否说清产品用途：`pass` / `fail` | **A** |
| `five_min_done` | 5 分钟内改到参数并点到「生成动态报告」：`pass`/`fail` | **B** |
| `core_results_understood_count` | 能用自己话讲对几个核心结果（0–5，≥3 过 C） | **C** |
| `independent_params_changed` | 未经提示、自主改了几个**不同含义**的滑块（≥2 过 D） | **D** |
| `next_step_found` | 是否自己找到联系 / 询价路径：`pass`/`fail` | **E** |
| `real_lead` | 该用户是否留下**真实可反查**的 RFQ：`yes`/`no` | **F** |
| `lead_ref` | 若 yes：`/admin/leads` 里那条的 id 或可定位凭证（无凭证不许标 yes） | F 佐证 |
| `q3_top_param` / `q4_focus_metric` / `q5_distrust_metric` | 改最多的参数 / 最关注的结果 / 最不信任的结果（**Q5 每人必填，无质疑写"无"**） | §4 |
| `q8_honesty_reaction` | 对"示例·待核实"的反应：`a`(更信)/`b`(无感)/`c`(更不敢信) | §4 Q8 |
| `storage_notfound_redflag` | 是否"完全找不到储能细化参数且放弃"：`yes`/`no` | 红线 |
| `truckcount_misread_redflag` | 是否把"日均服务重卡数 60"误读成自有车数：`yes`/`no` | 红线 |
| `needed_hint` | 是否给过轻推（"你可以随便点点"级）：`yes`/`no` | §3 红线① |
| `enter_sandbox_sec` / `storage_sec` / `report_sec` / `lead_sec` | 4 个秒表数（秒） | §4 量化 |
| `notes` | 用户一句原话吐槽 / 关键观察（照录，勿转译成形容词） | §3 |
| `recorder` / `run_date` | 主持人 / 日期（**真实性署名**） | 反伪造 |

> 表里预置的 `EXAMPLE-DO-NOT-TALLY` 行**只演示格式**，计分器会自动剔除；照抄它的真实记录会被判为示例丢弃。

## 二、跑计分器（真实数据 → 自动 A–F + 决策建议）

```bash
# 先不带确认：只看过程量，会拒绝下结论
node scripts/tally-real-user-test.mjs docs/real_user_test/filled-YYYYMMDD.csv

# 人工确认"全部数据来自当场、真实、未经诱导的用户记录"后，追加确认位再裁定
node scripts/tally-real-user-test.mjs docs/real_user_test/filled-YYYYMMDD.csv --confirm-real
# 或：npm run test:tally -- docs/real_user_test/filled-YYYYMMDD.csv --confirm-real
```

反伪造护栏（宁拒不假）：样本 <8 拒；示例行自动剔除；判定位空/非法拒；≥2 行逐字段雷同判疑似复制拒；全体零方差硬警告；标了真实 Lead 却无 `lead_ref` 凭证拒。
**它绝不自行宣布商业成功**——只给"通过率 + 红线 + §10 建议分支"，最终判定交创始人。

## 三、交叉核对真实商业意向（DB 侧，只读）

```bash
node --env-file=.env scripts/ops-metrics.mjs            # 默认回看 7 天
node --env-file=.env scripts/ops-metrics.mjs --days=30
# 或：npm run ops:metrics
```

看 ④「询价留资 Lead」与 ⑤「Lead 画像分布」：F 判据的"真实 Lead"以这里的 DB 计数为准，与 CSV 里的 `real_lead=yes` 逐条对齐，防"表里说留了、库里没有"。

## 四、隐私与伦理

- 观察表用匿名编号，录音 / 记录需口头同意；测毕告知"参数为示例、结论需专业确认、本次不承诺报价"。
- 反馈表不索取身份信息；付费意向是**主观意愿**，不等于订单。
- 严禁主持人代填 Lead、代答反馈、事后补造判定——`tally` 脚本会因无凭证 / 零方差 / 逐字段雷同等信号拒算。

## 五、测试结束 → 交棒

跑完两个脚本后，按 `REAL_USER_VALIDATION_V1_1.md` §10 步骤 4 输出一页纪要（样本构成、A–F 通过率、红线、P0/P1/P2/P3 清单、§9 疑点证实情况、建议 + 需创始人裁决事项），然后 **STOP**。是否进更大样本 / 进 P5，由创始人据真实证据决定，**不自动推进**。
