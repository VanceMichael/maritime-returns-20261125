# 业务服务接口与运行说明（海运服务优惠申报）

本服务把三件事严格分开，互不替代：

1. **有一张发票**——财务登记真实业务、费用行与后续信用票/退款，原始发票登记后不可修改；
2. **这笔业务可能符合**——会计对供应商所在地、服务发生地、发票抬头三类证据作判断，并确认费用分摊；缺证保持“未决”，不默认合格也不默认不合格；
3. **已经递交了哪种申报**——集团税务人员按主体年度确认选用方案、向外部受理台递交，并逐主体查明受理结果；受理确认后只能更正，不能覆盖。

所有机构、人员、金额、文书均为合成数据，服务不产生真实法律结论；未列明事项进入人工复核（`/manual-reviews`）。

## 一、运行

需要 Node.js 22.23.4，无第三方依赖。

```bash
npm ci --ignore-scripts
npm run build
npm test

# 终端 1：外部受理台（合成合作方，默认 4317）
npm run start:partner
# 终端 2：业务服务（默认 4318）
npm run start:app
```

环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | 应用 4318 / 受理台 4317 | 监听端口 |
| `APP_STATE` | `.local/app.json` | 业务服务持久化文件（tmp+rename 原子落盘，重启保留） |
| `PARTNER_STATE` | `.local/partner.json` | 受理台持久化文件 |
| `PEER_BASE_URL` | `http://127.0.0.1:4317` | 业务服务访问受理台的地址 |

健康检查：`GET http://127.0.0.1:4318/health`。

端到端冒烟（两个服务都已启动时）：

```bash
bash support/smoke.sh
```

Docker：

```bash
docker build -t maritime-returns:local .
docker run --rm -p 4318:4318 -p 4317:4317 maritime-returns:local
# 持久化：挂载可写目录到 /app/.local（容器以非特权 node 用户运行）
docker run --rm -p 4318:4318 -p 4317:4317 -v "$PWD/.local:/app/.local" maritime-returns:local
```

## 二、身份与权限

每个请求（`/health` 除外）必须带头 `Actor-Id: <角色编号>`。首次启动用 `Actor-Id: bootstrap` 建立第一个税务角色，之后由税务角色建立其余角色。

| 角色 | 能做 | 不能做 |
| --- | --- | --- |
| `bookkeeper` 财务（绑定一个主体） | 登记本主体发票、信用票、证据、分摊提案 | 操作其他主体资料；做会计/税务判断 |
| `accountant` 会计 | 判断证据、确认/退回分摊、处理人工复核 | 自审自己登记的证据或分摊；改原始发票 |
| `tax` 集团税务 | 主数据、方案、年度确认、申报、更正、结算、审计查询 | 改原始发票；自审自己提出的提案/更正 |

分摊审核人与年度确认人都不能自审；集团税务也没有任何修改原始发票的接口。

## 三、数据模型与状态

- 金额一律为整数“分”；比例阈值（`localRatio`、`rate`）只来自登记的合成方案，服务不推断法规。
- 发票可多行；信用票/退款按行登记，只追加不改原票。分摊占用 = 待决提案 + 已确认（被取代的旧版本不占用）。
- 证据三类：`supplier_location`、`service_place`、`invoice_title`。供应商证据**仅凭香港地址文本不能认定合格**，必须带 `proofRef` 并被会计接受。
- 本地比例 = 已确认且三类证据齐全的合格本地费用 ÷ 全部已确认指明海事服务费用；分母为零或缺证不自动满足。
- 选用状态流转：`proposed`（可多业务线提案，方案冲突不得确认）→ `selected`（税务独立复核+快照）→ `filed` → `accepted`/`returned`/`rejected`；受理后只能走更正。

## 四、HTTP 接口

### 1. 角色与主数据（税务）

```
POST /actors                 首次用 bootstrap；{"id","role":"bookkeeper|accountant|tax","entity"?}
GET  /actors
POST /entities               {"id","group","covered":true|false}
POST /activities             {"id","entity","year","kind","profitMinor"}
POST /suppliers              {"id","locationProof"?}
POST /suppliers/{id}/proofs  追加供应商证明（带 proofRef），旧证明保留
POST /schemes                {"id","allowed":[...],"coveredOnly"?,"localRatio":"0.50","rate":"0.0825"}
GET  /schemes/{id}/availability?entityId=&year=   方案可用性与不满足原因
```

### 2. 发票、证据、信用票（财务登记，会计判断）

```
POST /entities/{entityId}/invoices            发票登记（不可变）；{"id","supplier","year","lines":[{"id","amountMinor"}]}
GET  /invoices/{id}                            发票追踪：每行净额、占用、未用余额、全部分摊、信用票
POST /invoices/{id}/credit-notes               信用票/退款；{"id","lineId"?,"amountMinor","reason"}，累计不得超过行金额
POST /invoices/{id}/evidence                   证据登记；{"kind","docRef","proofRef"?}，初始 pending
POST /evidence/{id}/assessment                 会计判断；{"decision":"accepted|rejected"}，供应商证据无 proofRef 拒绝接受
GET  /evidence
```

### 3. 分摊（财务提案，会计确认）

```
POST /entities/{entityId}/allocations   {"invoiceId","lineId","activityId","amountMinor"}
                                        禁止跨主体；超过未用余额拒绝
POST /allocations/{id}/review           {"decision":"confirmed|rejected"}，不能自审
POST /allocations/{id}/adjustment       申报前修订：旧记录 superseded 保留，生成新提案
GET  /allocations?entityId=&year=
```

### 4. 年度选用（业务线提案 → 税务独立确认）

```
POST /entities/{entityId}/years/{year}/proposals   {"schemeId","activityId"?}
POST /selections/{selectionId}/confirm             冲突方案/未明批次/门槛不满足均拒绝；确认时留存快照
POST /selections/{selectionId}/revise              申报前修订；受理后拒绝（提示走更正）
POST /selections/{selectionId}/reopen              仅退补（returned/rejected）后重新打开，受理台流水保留，回到提案态修订重报
GET  /entities/{entityId}/years/{year}             主体年度总账（见下）
```

### 5. 申报批次与断线查明

```
POST /filings/batches                 {"entries":[{"entityId","year"}...],"filingReference"?}
                                      逐主体校验：未到 selected、存在未明批次均拒绝
POST /filings/batches/{id}/sync       按原流水逐行回查受理台，归并 accepted/returned/rejected
GET  /filings/batches
GET  /filings/batches/{id}
```

连接中断时批次为 `submitted_unverified`，**禁止重复递交同一主体年度**；`sync` 按原 `submissionLine` 查明（受理台已持久受理的会查回 `accepted`）。批次可逐主体出现受理与退补并存；其他主体不受影响，可继续整理。被退补的主体年度用 `reopen` 回到提案态、修订后用新的 Filing-Reference 重新申报，原退补流水仍保留可查；已受理方不受影响也不能用 reopen 绕过更正。

### 6. 更正（受理后唯一变更途径）

```
POST /entities/{entityId}/years/{year}/corrections
       {"reason","targetSchemeId"?,"allocationAdjustments":[{"allocationId","amountMinor"}],
        "evidenceSupplements":[{"invoiceId","kind","docRef","proofRef"?}]}
       约束：不得把其他年度发票/证据补进旧年度；不得直接缩减已受理份额（退减走退补）
POST /corrections/{id}/confirm        另一税务角色复核（不能自审），旧分摊 superseded、新分摊待会计确认
POST /corrections/{id}/submit         新分摊全部 confirmed、补充证据全部有结论后才可递交
POST /corrections/{id}/sync           查明结果；returned/rejected 不删除原受理版本
GET  /corrections
```

更正获 `confirmed` 后形成选用的新版本，原版本仍保留可追溯。

### 7. 结算、核对与待办

```
POST /entities/{entityId}/years/{year}/settlements   {"kind":"payment|supplemental_tax|refund","amountMinor","reference"}
                                                     只记结算事实，不回写资格/证据
GET  /settlements
GET  /reconciliation?year=2026                        本地核对：共享费用冲减 + 逐主体受理/退补 + 结算差异
GET  /notifications?entityId=                         冲减影响、证据变化、退补等影响范围通知
GET  /manual-reviews?status=open                      缺证、冲减超额、断线未明、待补事项
POST /manual-reviews/{id}/close
GET  /audit                                           仅税务；全部操作的审计轨迹
```

## 五、两个追踪视角

- **从费用追起**：`GET /invoices/{id}` 返回每行的毛额、累计冲减、净额、提案/确认/退回占用、未用余额，以及引用该行的全部分摊和信用票。
- **从主体年度追起**：`GET /entities/{entityId}/years/{year}` 返回适用依据（各方案可用性与原因）、已确认费用与本地比例、待补证据门槛、全部批次受理版本、更正记录、结算事实与“结算金额 − 受理版本优惠估算”的差异。

## 六、红线如何落地

| 业务要求 | 服务约束 |
| --- | --- |
| 同一金额不得重复计作本地开支 | 分摊占用按行汇总，提案+确认不得超过发票行净可用额；超额拒绝并挂人工复核 |
| 不得跨主体搬用 | 分摊主体必须等于发票抬头主体，否则 422 |
| 香港地址文本不足以认定 | 供应商证据无 `proofRef` 时会计无法接受，门槛保持未决 |
| 缺证保持未决 | 证据默认 `pending`；缺证只影响“合格本地费用”，不自动判不合格 |
| 原始证据不得就地替换 | 发票不可变；信用票、证明、证据全部追加并留历史，变化经通知/复核留痕 |
| 已申报份额受影响要可知 | 证据结论变化、信用票超额均生成逐主体通知与人工复核 |
| 未明批次不得重复递交 | `pendingFilingLine` 拦截同主体年度新批次；只允许 `sync` 按原流水查明 |
| 受理后不能覆盖 | 修订接口在 filed/accepted 状态拒绝；更正产生新版本，旧版本保留 |
| 结算不证明资格 | 结算独立登记，不修改任何证据、比例或选用字段 |
| 不能自审、不能越权 | 证据/分摊/提案/更正均校验提出人与复核人不同；财务限定本主体 |
