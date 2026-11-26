# 海运服务优惠申报的证据占用与年度选用

本仓库保存该业务的合成登记资料、原始变更资料、合成申报受理台的本地协议服务，以及区分“有发票 / 可能符合 / 已递交申报”三个层次的业务应用服务。所有机构、人员、金额和文书均为虚构，不连接真实业务系统；服务不替企业作真实法律结论，未列明事项进入人工复核。

## 运行环境

使用 Node.js 22.23.4。没有第三方 npm 依赖，package-lock.json 锁定当前依赖清单。

```bash
npm ci --ignore-scripts
npm run build
npm test
# 分别启动（两个终端）
npm run start:partner   # 外部受理台，默认 4317
npm run start:app       # 业务服务，默认 4318
# 或一个进程同时启动两者（容器默认方式）
npm run start:all
# 两服务启动后的端到端冒烟
npm run smoke
```

业务服务默认监听 4318 端口，GET /health 可查询存活状态。PORT 可更换端口，APP_STATE 可指定业务持久状态文件（默认 .local/app.json），PEER_BASE_URL 指定受理台地址（默认 http://127.0.0.1:4317）。停止进程后用同一状态文件启动会保留全部登记、选用、批次、更正与审计轨迹。

合作方默认监听 4317 端口，PARTNER_STATE 可指定其持久状态文件，默认 .local/partner.json。

也可以使用 Docker 同时启动两个服务：

```bash
docker build -t maritime-returns:local .
docker run --rm -p 4317:4317 -p 4318:4318 maritime-returns:local
```

容器要保留状态时，将可写目录挂载到 /app/.local；该目录需允许容器 node 用户写入。测试使用临时目录与随机本地端口，可独立运行。

## 业务接口

完整 HTTP 接口、权限矩阵、状态流转与红线落地见 [docs/service.md](docs/service.md)。要点：

- 财务（bookkeeper，限本主体）登记不可变发票、信用票、证据与分摊提案；会计（accountant）判断三类证据、确认分摊，且不能自审；集团税务（tax）确认年度选用、递交申报、办理更正与结算，不能改原始发票、不能自审。
- 供应商所在地仅凭香港地址文本不能认定合格，必须带证明引用并经会计接受；缺证保持未决。
- 分摊不得超过发票行净可用额、不得跨主体；信用票/退款只追加不改原票，超额占用生成逐主体通知与人工复核。
- 年度方案阈值只来自登记的合成合同；同年度冲突方案不能确认；受理确认后只能更正、不能覆盖，且不能把其他年度发票补进旧年度。
- 受理批次逐主体返回结果；连接中断按原流水查明，未明期间禁止重复递交同一主体年度，其他主体可继续整理。结算只是事实，不改变优惠资格。

## 资料

fixtures/records.json 是业务原始资料，sourceChanges 保存后续收到的变更或申请，均没有自动导入成已批准决定。fixtures/relations.json 声明登记资料的关联字段，docs/data.md 解释计量和身份语义。fixtures/partner.json 定义合作方接口名称及字段。support/peer.mjs 提供合作方行为，docs/partner.md 是实际协议；tests 检查该协议和资料关系。
