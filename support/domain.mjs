// 领域纯函数：金额、证据门槛、分摊占用、本地比例、方案可用性、申报状态判断。
// 金额一律以“分”（整数）保存；阈值字符串按整数交叉相乘比较，避免浮点误差。
// 本模块不产生法律结论：缺证一律保持未决，不默认合格也不默认不合格。

export class DomainError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.name = 'DomainError';
    this.status = status;
  }
}

// 把 "0.50" 这样的十进制字符串转成 BigInt 分子和 10 的幂分母。
export function decimalParts(text) {
  const s = String(text).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new DomainError(`数值格式不符：${text}`, 400);
  const [whole, frac = ''] = s.split('.');
  const scale = 10n ** BigInt(frac.length);
  return { numerator: BigInt(whole) * scale + BigInt(frac || '0'), scale };
}

// numerator/denominator（整数金额）是否 >= 阈值字符串；分母为零或缺证不自动满足。
export function ratioAtLeast(numerator, denominator, thresholdText) {
  if (denominator <= 0n) return false;
  const t = decimalParts(thresholdText);
  return BigInt(numerator) * t.scale >= BigInt(denominator) * t.numerator;
}

// 按 rate（如 0.0825）计算金额（分），四舍五入到整分。
export function applyRate(amountMinor, rateText) {
  const t = decimalParts(rateText);
  const value = BigInt(amountMinor) * t.numerator * 2n + t.scale;
  return Number((value / 2n) / t.scale);
}

export function requireRecord(map, id, label) {
  const row = map[id];
  if (!row) throw new DomainError(`${label}不存在：${id}`, 404);
  return row;
}

// 当前有效分摊：被新版本取代的记录不参与占用。
export function activeAllocations(state) {
  return Object.values(state.allocations).filter(a => a.status !== 'superseded');
}

export function allocationsOfLine(state, invoiceId, lineId) {
  return activeAllocations(state).filter(a => a.invoiceId === invoiceId && a.lineId === lineId);
}

// 某发票行累计冲减额（信用票/退款按行登记，原发票不修改）。
export function creditedOnLine(state, invoiceId, lineId) {
  return Object.values(state.creditNotes)
    .filter(c => c.invoiceId === invoiceId && c.lineId === lineId)
    .reduce((n, c) => n + c.amountMinor, 0);
}

// 发票行视图：实际净可用额、各状态占用、未用余额。
export function lineView(state, invoice, line, credited = creditedOnLine(state, invoice.id, line.id)) {
  const netAmount = line.amountMinor - credited;
  const rows = allocationsOfLine(state, invoice.id, line.id);
  const sum = status => rows.filter(a => a.status === status).reduce((n, a) => n + a.amountMinor, 0);
  const proposed = sum('proposed');
  const confirmed = sum('confirmed');
  const rejected = sum('rejected');
  // 占用以“已确认 + 待决提案”为准，防止同一金额被重复计作本地开支。
  const occupied = proposed + confirmed;
  return {
    invoiceId: invoice.id,
    lineId: line.id,
    grossAmount: line.amountMinor,
    credited,
    netAmount,
    proposed,
    confirmed,
    rejected,
    occupied,
    unused: netAmount - occupied,
    overOccupied: occupied > netAmount,
  };
}

export function invoiceTrace(state, invoiceId) {
  const invoice = requireRecord(state.invoices, invoiceId, '发票');
  return {
    invoice,
    lines: invoice.lines.map(line => ({
      line,
      view: lineView(state, invoice, line),
      allocations: allocationsOfLine(state, invoice.id, line.id),
    })),
    creditNotes: Object.values(state.creditNotes).filter(c => c.invoiceId === invoiceId),
  };
}

// 三类证据门槛。supplier_location 仅凭香港地址文本不能认定合格，
// 必须存在被会计接受、且带证明引用（proofRef）的供应商证据。
export function evidenceGate(state, invoiceId) {
  const docs = Object.values(state.evidence).filter(d => d.invoiceId === invoiceId);
  const accepted = kind => docs.find(d => d.kind === kind && d.status === 'accepted');
  // 供应商证据可能多次提交：存在任意一份带证明引用且被接受的记录即视为该门槛通过。
  const supplierWithProof = docs.find(d =>
    d.kind === 'supplier_location' && d.status === 'accepted' && d.proofRef);
  const checks = {
    invoice_title: Boolean(accepted('invoice_title')),
    service_place: Boolean(accepted('service_place')),
    supplier_location: Boolean(supplierWithProof),
  };
  const missing = Object.entries(checks).filter(([, ok]) => !ok).map(([kind]) => kind);
  const pending = docs.filter(d => d.status === 'pending').map(d => d.id);
  return { qualified: missing.length === 0, checks, missing, pendingEvidence: pending };
}

// 主体年度的金额计量：分母=已确认分摊净额；分子=其中证据门槛通过的合格本地费用。
export function entityYearNumbers(state, entityId, year) {
  const rows = activeAllocations(state).filter(
    a => a.entityId === entityId && a.year === String(year) && a.status === 'confirmed'
  );
  let denominator = 0n;
  let numerator = 0n;
  const detail = [];
  for (const allocation of rows) {
    const invoice = state.invoices[allocation.invoiceId];
    const credited = invoice ? creditedOnLine(state, invoice.id, allocation.lineId) : 0;
    denominator += BigInt(allocation.amountMinor);
    const gate = evidenceGate(state, allocation.invoiceId);
    const qualified = gate.qualified;
    if (qualified) numerator += BigInt(allocation.amountMinor);
    detail.push({
      allocationId: allocation.id,
      invoiceId: allocation.invoiceId,
      lineId: allocation.lineId,
      activityId: allocation.activityId,
      amountMinor: allocation.amountMinor,
      credited,
      qualified,
      missing: gate.missing,
    });
  }
  return {
    entityId,
    year: String(year),
    confirmedCount: rows.length,
    denominatorMinor: Number(denominator),
    qualifiedLocalMinor: Number(numerator),
    detail,
  };
}

// 方案可用性：是否受涵盖集团、业务范围、本地开支比例阈值，全部来自登记方案。
export function schemeAvailability(state, entityId, year, schemeId) {
  const entity = requireRecord(state.entities, entityId, '主体');
  const scheme = requireRecord(state.schemes, schemeId, '方案');
  const activityKinds = [...new Set(
    Object.values(state.activities)
      .filter(a => a.entity === entityId && String(a.year) === String(year))
      .map(a => a.kind)
  )];
  const inScope = activityKinds.every(kind => scheme.allowed.includes(kind));
  const coveredOk = scheme.coveredOnly ? Boolean(entity.covered) : true;
  const numbers = entityYearNumbers(state, entityId, year);
  const ratioText = numbers.denominatorMinor === 0
    ? null
    : (numbers.qualifiedLocalMinor / numbers.denominatorMinor).toFixed(4);
  const ratioOk = ratioAtLeast(numbers.qualifiedLocalMinor, numbers.denominatorMinor, scheme.localRatio);
  // 分母为零或缺证时不自动满足：ratioOk 已为 false，并给出原因供人工复核。
  const reasons = [];
  if (!coveredOk) reasons.push('主体不属于受涵盖集团');
  if (!inScope) reasons.push('存在方案允许范围之外的业务线');
  if (numbers.denominatorMinor === 0) reasons.push('已确认指明海事服务费用为零，无法形成本地比例');
  else if (!ratioOk) reasons.push(`本地开支比例未达阈值 ${scheme.localRatio}（当前 ${ratioText}）`);
  return {
    entityId,
    year: String(year),
    schemeId,
    coveredRequired: Boolean(scheme.coveredOnly),
    coveredOk,
    activityKinds,
    allowedKinds: scheme.allowed,
    inScope,
    localRatioThreshold: scheme.localRatio,
    localRatio: ratioText,
    ratioOk,
    available: coveredOk && inScope && ratioOk,
    reasons,
    numbers,
  };
}

// 主体年度是否存在“未明”批次行：已递交但受理台尚未给出终态，断线未查明也算未明。
export function pendingFilingLine(state, entityId, year) {
  for (const batch of Object.values(state.batches)) {
    const line = batch.lines.find(l => l.entityId === entityId && l.year === String(year));
    if (!line) continue;
    const settled = line.peerStatus === 'confirmed' || line.peerStatus === 'rejected' || line.peerStatus === 'returned';
    if (!settled) return { batchId: batch.id, lineId: line.id, peerStatus: line.peerStatus };
  }
  return null;
}

// 主体年度最新受理版本（已确认），原版本不被更正覆写。
export function latestAcceptedSelection(state, entityId, year) {
  const key = `${entityId}:${year}`;
  const selection = state.selections[key];
  if (!selection) return null;
  const accepted = [...selection.versions].reverse().find(v => v.status === 'accepted');
  return accepted ? { selection, version: accepted } : null;
}
