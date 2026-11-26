import test from 'node:test';
import assert from 'node:assert/strict';
import { ratioAtLeast, decimalParts, applyRate, lineView, evidenceGate, schemeAvailability, entityYearNumbers } from '../support/domain.mjs';
import { freshState } from '../support/store.mjs';

const baseState = () => ({
  ...freshState(),
  entities: { E1: { id: 'E1', group: 'G1', covered: true } },
  schemes: {
    HALF: { id: 'HALF', allowed: ['shipping'], coveredOnly: false, localRatio: '0.50', rate: '0.0825' },
    COVERED: { id: 'COVERED', allowed: ['shipping'], coveredOnly: true, localRatio: '0', rate: '0.15' },
  },
  activities: { A1: { id: 'A1', entity: 'E1', year: '2026', kind: 'shipping', profitMinor: 1000 } },
  invoices: {
    I1: {
      id: 'I1', entityId: 'E1', supplierId: 'V1', year: '2026', immutable: true,
      lines: [{ id: 'I1-1', description: '海事服务费', amountMinor: 300000 }],
    },
  },
});

test('十进制比例按整数交叉相乘比较，分母为零不自动满足', () => {
  assert.equal(ratioAtLeast(150000, 300000, '0.50'), true);
  assert.equal(ratioAtLeast(149999, 300000, '0.50'), false);
  assert.equal(ratioAtLeast(0, 0, '0'), false);
  assert.throws(() => decimalParts('0.5x'), /数值格式不符/);
  // 8.25% 优惠估算（四舍五入到分）。
  assert.equal(applyRate(150000, '0.0825'), 12375);
});

test('发票行占用含提案与确认，被取代分摊不占用，冲减后可超额识别', () => {
  const state = baseState();
  state.allocations = {
    AL1: { id: 'AL1', invoiceId: 'I1', lineId: 'I1-1', entityId: 'E1', year: '2026', amountMinor: 100000, status: 'proposed' },
    AL2: { id: 'AL2', invoiceId: 'I1', lineId: 'I1-1', entityId: 'E1', year: '2026', amountMinor: 80000, status: 'confirmed' },
    AL3: { id: 'AL3', invoiceId: 'I1', lineId: 'I1-1', entityId: 'E1', year: '2026', amountMinor: 999000, status: 'superseded' },
  };
  const view = lineView(state, state.invoices.I1, state.invoices.I1.lines[0]);
  assert.equal(view.occupied, 180000);
  assert.equal(view.unused, 120000);
  assert.equal(view.overOccupied, false);
  // 信用票按行冲减 150000 后，净额 150000 < 占用 180000。
  state.creditNotes = { CN1: { id: 'CN1', invoiceId: 'I1', lineId: 'I1-1', amountMinor: 150000 } };
  const after = lineView(state, state.invoices.I1, state.invoices.I1.lines[0]);
  assert.equal(after.netAmount, 150000);
  assert.equal(after.overOccupied, true);
});

test('证据门槛：香港地址文本无证明引用时不合格，缺证保持未决', () => {
  const state = baseState();
  state.evidence = {
    E1: { id: 'E1', invoiceId: 'I1', kind: 'supplier_location', status: 'accepted', proofRef: null },
    E2: { id: 'E2', invoiceId: 'I1', kind: 'invoice_title', status: 'accepted', proofRef: 'x' },
  };
  let gate = evidenceGate(state, 'I1');
  assert.equal(gate.qualified, false);
  assert.deepEqual(gate.missing.sort(), ['service_place', 'supplier_location']);
  // 补上带证明引用的供应商证据和服务发生地证据后通过。
  state.evidence.E3 = { id: 'E3', invoiceId: 'I1', kind: 'supplier_location', status: 'accepted', proofRef: 'HK-registered' };
  state.evidence.E4 = { id: 'E4', invoiceId: 'I1', kind: 'service_place', status: 'accepted', proofRef: 'port-log' };
  gate = evidenceGate(state, 'I1');
  assert.equal(gate.qualified, true);
});

test('本地比例只计已确认且证据合格的分摊；方案可用性覆盖受涵盖与范围规则', () => {
  const state = baseState();
  state.allocations = {
    AL1: { id: 'AL1', invoiceId: 'I1', lineId: 'I1-1', entityId: 'E1', year: '2026', amountMinor: 100000, status: 'confirmed' },
    AL2: { id: 'AL2', invoiceId: 'I1', lineId: 'I1-1', entityId: 'E1', year: '2026', amountMinor: 100000, status: 'proposed' },
  };
  // 无证据：合格本地费用为 0，HALF 不可用；COVERED 阈值 0 但仍受范围/受涵盖约束。
  let numbers = entityYearNumbers(state, 'E1', '2026');
  assert.equal(numbers.denominatorMinor, 100000);
  assert.equal(numbers.qualifiedLocalMinor, 0);
  let half = schemeAvailability(state, 'E1', '2026', 'HALF');
  assert.equal(half.ratioOk, false);
  assert.equal(half.available, false);
  const covered = schemeAvailability(state, 'E1', '2026', 'COVERED');
  assert.equal(covered.coveredOk, true);
  assert.equal(covered.ratioOk, true);
  assert.equal(covered.available, true);
  // 非受涵盖主体不能用 coveredOnly 方案。
  state.entities.E2 = { id: 'E2', group: 'G1', covered: false };
  state.activities.A2 = { id: 'A2', entity: 'E2', year: '2026', kind: 'shipping', profitMinor: 1 };
  const blocked = schemeAvailability(state, 'E2', '2026', 'COVERED');
  assert.equal(blocked.coveredOk, false);
  assert.equal(blocked.available, false);
});
