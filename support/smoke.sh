#!/usr/bin/env bash
# 端到端冒烟：需要先启动受理台（4317）与业务服务（4318）。
# 用法：bash support/smoke.sh [应用地址]
set -euo pipefail
BASE="${1:-http://127.0.0.1:4318}"
PEER="${PEER_URL:-http://127.0.0.1:4317}"
post() { curl -fsS -X POST -H 'Content-Type: application/json' -H "Actor-Id:$1" "$BASE$2" -d "$3"; }
get() { curl -fsS -H 'Content-Type: application/json' -H "Actor-Id:$1" "$BASE$2"; }

echo '== 1. 引导角色与主数据 =='
post bootstrap /actors '{"id":"tax-a","role":"tax"}' >/dev/null
post tax-a /actors '{"id":"accountant","role":"accountant"}' >/dev/null
post tax-a /actors '{"id":"book-a","role":"bookkeeper","entity":"LE-A"}' >/dev/null
post tax-a /entities '{"id":"LE-A","group":"GR-1","covered":true}' >/dev/null
post tax-a /activities '{"id":"ACT-1","entity":"LE-A","year":"2026","kind":"shipping","profitMinor":5000000}' >/dev/null
post tax-a /suppliers '{"id":"VEN-A"}' >/dev/null
post tax-a /schemes '{"id":"COVERED15","allowed":["shipping"],"coveredOnly":true,"localRatio":"0","rate":"0.15"}' >/dev/null

echo '== 2. 财务登记发票并补三类证据 =='
post book-a /entities/LE-A/invoices '{"id":"INV-1","supplier":"VEN-A","year":"2026","lines":[{"id":"L1","amountMinor":300000}]}' >/dev/null
for kind in supplier_location service_place invoice_title; do
  ev=$(post book-a /invoices/INV-1/evidence "{\"kind\":\"$kind\",\"docRef\":\"D-$kind\",\"proofRef\":\"P-$kind\"}")
  evid=$(node -e 'process.stdin.on("data",d=>{const o=JSON.parse(d);console.log(o.id)})' <<<"$ev")
  post accountant /evidence/$evid/assessment '{"decision":"accepted"}' >/dev/null
done

echo '== 3. 分摊与会计确认 =='
al=$(post book-a /entities/LE-A/allocations '{"invoiceId":"INV-1","lineId":"L1","activityId":"ACT-1","amountMinor":300000}')
alid=$(node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).id))' <<<"$al")
post accountant /allocations/$alid/review '{"decision":"confirmed"}' >/dev/null

echo '== 4. 年度提案、独立复核与申报 =='
sel=$(post book-a /entities/LE-A/years/2026/proposals '{"schemeId":"COVERED15"}')
slid=$(node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).selection.id))' <<<"$sel")
post tax-a /selections/$slid/confirm '{}' >/dev/null
batch=$(post tax-a /filings/batches '{"entries":[{"entityId":"LE-A","year":"2026"}],"filingReference":"FR-SMOKE"}')
line=$(node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).batch.lines[0].id))' <<<"$batch")
bid=$(node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).batch.id))' <<<"$batch")

echo '== 5. 受理台给终态后回查 =='
curl -fsS -X POST -H 'Content-Type: application/json' "$PEER/control/settle" -d "{\"id\":\"$line\",\"status\":\"confirmed\",\"details\":{\"note\":\"冒烟确认\"}}" >/dev/null
post tax-a /filings/batches/$bid/sync '{}' | node -e 'process.stdin.on("data",d=>{const o=JSON.parse(d);console.log("批次状态:",o.batch.status,"逐行:",o.batch.lines[0].peerStatus)})'

echo '== 6. 追踪与核对视图 =='
get tax-a /invoices/INV-1 | node -e 'process.stdin.on("data",d=>{const o=JSON.parse(d);console.log("发票净额/未用:",o.lines[0].view.netAmount,o.lines[0].view.unused)})'
get tax-a /entities/LE-A/years/2026 | node -e 'process.stdin.on("data",d=>{const o=JSON.parse(d);console.log("主体年度选用状态:",o.selection.status,"受理版本:",o.selection.versions[0].version)})'
get tax-a '/reconciliation?year=2026' | node -e 'process.stdin.on("data",d=>{const o=JSON.parse(d);console.log("核对主体数:",o.entities.length,"受理版本:",o.entities[0].acceptedVersion)})'
echo '冒烟完成'
