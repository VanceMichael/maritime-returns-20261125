import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createPeer } from '../support/peer.mjs';
import { PeerClient } from '../support/peer-client.mjs';
import { Store } from '../support/store.mjs';
import { createApp } from '../support/app.mjs';

const partnerConfig = JSON.parse(await readFile(new URL('../fixtures/partner.json', import.meta.url)));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => server.close(resolve));

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'app-'));
  const stateFile = join(dir, 'app.json');
  const peer = createPeer(partnerConfig, join(dir, 'peer.json'));
  const peerUrl = await listen(peer);
  const store = new Store(stateFile);
  const app = createApp(store, new PeerClient(peerUrl, partnerConfig.key, partnerConfig.group, partnerConfig.id));
  const appUrl = await listen(app);
  const call = async (method, path, body, actorId) => {
    const res = await fetch(appUrl + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(actorId ? { 'Actor-Id': actorId } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const json = await res.json();
    return { status: res.status, json };
  };
  const ok = async (...args) => {
    const r = await call(...args);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json;
  };
  const fail = async (status, ...args) => {
    const r = await call(...args);
    assert.equal(r.status, status, JSON.stringify(r.json));
    return r.json;
  };
  return {
    dir, app, peer, call, ok, fail, stateFile,
    cleanup: async () => { await close(app); await close(peer); await rm(dir, { recursive: true, force: true }); },
    peerUrl,
  };
}

// 建立与 fixtures 同构的最小合成世界：两个主体、两个供应商、两个方案。
async function seedWorld(h) {
  await h.ok('POST', '/entities', { id: 'LE-A', group: 'GR-1', covered: true }, 'tax-a');
  await h.ok('POST', '/entities', { id: 'LE-B', group: 'GR-1', covered: false }, 'tax-a');
  await h.ok('POST', '/activities', { id: 'ACT-1', entity: 'LE-A', year: '2026', kind: 'commodity', profitMinor: 10000000 }, 'tax-a');
  await h.ok('POST', '/activities', { id: 'ACT-2', entity: 'LE-A', year: '2026', kind: 'shipping', profitMinor: 5000000 }, 'tax-a');
  await h.ok('POST', '/activities', { id: 'ACT-3', entity: 'LE-B', year: '2026', kind: 'shipping', profitMinor: 6000000 }, 'tax-a');
  await h.ok('POST', '/suppliers', { id: 'VEN-A', locationProof: 'HK-registered' }, 'tax-a');
  await h.ok('POST', '/suppliers', { id: 'VEN-B' }, 'tax-a');
  await h.ok('POST', '/schemes', { id: 'HALF', allowed: ['commodity', 'shipping'], localRatio: '0.50', rate: '0.0825' }, 'tax-a');
  await h.ok('POST', '/schemes', { id: 'COVERED15', allowed: ['commodity', 'shipping'], coveredOnly: true, localRatio: '0', rate: '0.15' }, 'tax-a');
}

test('角色引导、权限边界与不可改原始发票', async () => {
  const h = await harness();
  try {
    // 首个角色允许 bootstrap 建立，之后只有 tax 能建角色。
    await h.ok('POST', '/actors', { id: 'tax-a', role: 'tax' }, 'bootstrap');
    await h.ok('POST', '/actors', { id: 'tax-b', role: 'tax' }, 'tax-a');
    await h.ok('POST', '/actors', { id: 'accountant', role: 'accountant' }, 'tax-a');
    await h.ok('POST', '/actors', { id: 'book-a', role: 'bookkeeper', entity: 'LE-A' }, 'tax-a');
    await h.ok('POST', '/actors', { id: 'book-b', role: 'bookkeeper', entity: 'LE-B' }, 'tax-a');
    await h.fail(403, 'POST', '/actors', { id: 'x', role: 'tax' }, 'bootstrap');
    await h.fail(401, 'GET', '/entities', undefined, 'nobody');
    await seedWorld(h);
    // 财务只能登记本主体发票。
    await h.fail(403, 'POST', '/entities/LE-B/invoices', { id: 'INV-X', supplier: 'VEN-B', year: '2026', lines: [{ id: 'L1', amountMinor: 100 }] }, 'book-a');
    const invoice = await h.ok('POST', '/entities/LE-A/invoices', { id: 'INV-1', supplier: 'VEN-A', year: '2026', lines: [{ id: 'INV-1-1', amountMinor: 300000 }] }, 'book-a');
    assert.equal(invoice.immutable, true);
    // 会计与税务都不能改原始发票：没有任何修改接口，重复登记被拒。
    await h.fail(409, 'POST', '/entities/LE-A/invoices', { id: 'INV-1', supplier: 'VEN-A', year: '2026', lines: [{ id: 'INV-1-1', amountMinor: 1 }] }, 'book-a');
    await h.fail(403, 'POST', '/entities/LE-A/invoices', { id: 'INV-9', supplier: 'VEN-A', year: '2026', lines: [{ id: 'L', amountMinor: 1 }] }, 'accountant');
  } finally { await h.cleanup(); }
});

test('全流程：登记、证据、分摊、选用、申报、受理确认与追踪视图', async () => {
  const h = await harness();
  try {
    await h.ok('POST', '/actors', { id: 'tax-a', role: 'tax' }, 'bootstrap');
    await h.ok('POST', '/actors', { id: 'accountant', role: 'accountant' }, 'tax-a');
    await h.ok('POST', '/actors', { id: 'book-a', role: 'bookkeeper', entity: 'LE-A' }, 'tax-a');
    await h.ok('POST', '/actors', { id: 'book-b', role: 'bookkeeper', entity: 'LE-B' }, 'tax-a');
    await seedWorld(h);
    await h.ok('POST', '/entities/LE-A/invoices', { id: 'INV-1', supplier: 'VEN-A', year: '2026', lines: [{ id: 'INV-1-1', amountMinor: 300000 }] }, 'book-a');
    // 三类证据登记，会计判断；供应商证据必须带 proofRef 才能接受。
    const ev1 = await h.ok('POST', '/invoices/INV-1/evidence', { kind: 'supplier_location', docRef: 'D1', proofRef: 'HK-CR-1' }, 'book-a');
    const ev2 = await h.ok('POST', '/invoices/INV-1/evidence', { kind: 'service_place', docRef: 'D2', proofRef: 'PORT-LOG' }, 'book-a');
    const ev3 = await h.ok('POST', '/invoices/INV-1/evidence', { kind: 'invoice_title', docRef: 'D3', proofRef: 'TITLE' }, 'book-a');
    for (const ev of [ev1, ev2, ev3]) await h.ok('POST', `/evidence/${ev.id}/assessment`, { decision: 'accepted' }, 'accountant');
    // 无证明引用的供应商证据不能被接受。
    const bad = await h.ok('POST', '/invoices/INV-1/evidence', { kind: 'supplier_location', docRef: 'D4' }, 'book-a');
    await h.fail(422, 'POST', `/evidence/${bad.id}/assessment`, { decision: 'accepted' }, 'accountant');
    // 分摊到两笔交易，合计不超过发票净额；超额被拒。
    const al1 = await h.ok('POST', '/entities/LE-A/allocations', { invoiceId: 'INV-1', lineId: 'INV-1-1', activityId: 'ACT-1', amountMinor: 200000 }, 'book-a');
    await h.ok('POST', '/entities/LE-A/allocations', { invoiceId: 'INV-1', lineId: 'INV-1-1', activityId: 'ACT-2', amountMinor: 100000 }, 'book-a');
    await h.fail(422, 'POST', '/entities/LE-A/allocations', { invoiceId: 'INV-1', lineId: 'INV-1-1', activityId: 'ACT-1', amountMinor: 1 }, 'book-a');
    // 不能跨主体：LE-B 的财务在本主体路径引用 LE-A 抬头发票，被禁止搬用（422）。
    await h.fail(422, 'POST', '/entities/LE-B/allocations', { invoiceId: 'INV-1', lineId: 'INV-1-1', activityId: 'ACT-3', amountMinor: 100 }, 'book-b');
    // 会计不能自审自己登记的分摊；登记人是 book-a，accountant 可审。
    await h.ok('POST', `/allocations/${al1.id}/review`, { decision: 'confirmed' }, 'accountant');
    const allocs = await h.ok('GET', '/allocations?entityId=LE-A&year=2026', undefined, 'tax-a');
    for (const a of allocs.filter(x => x.status === 'proposed')) {
      await h.ok('POST', `/allocations/${a.id}/review`, { decision: 'confirmed' }, 'accountant');
    }
    // 发票追踪：未用余额为 0，全部已确认且证据合格。
    const trace = await h.ok('GET', '/invoices/INV-1', undefined, 'tax-a');
    assert.equal(trace.lines[0].view.unused, 0);
    assert.equal(trace.lines[0].view.confirmed, 300000);
    // 主体年度：HALF 需要 50% 本地比例，证据齐全时比例为 100%，可用。
    const viewBefore = await h.ok('GET', '/entities/LE-A/years/2026', undefined, 'tax-a');
    const half = viewBefore.schemeAvailability.find(s => s.schemeId === 'HALF');
    assert.equal(half.available, true);
    assert.equal(half.localRatio, '1.0000');
    // 提案与年度确认（确认人 tax-a 不是提案人 book-a）。
    const { selection } = await h.ok('POST', '/entities/LE-A/years/2026/proposals', { schemeId: 'HALF', activityId: 'ACT-1' }, 'book-a');
    const confirmed = await h.ok('POST', `/selections/${selection.id}/confirm`, {}, 'tax-a');
    assert.equal(confirmed.version.version, 1);
    assert.equal(confirmed.version.status, 'selected');
    // 申报批次并同步为 confirmed。
    const batch = await h.ok('POST', '/filings/batches', { entries: [{ entityId: 'LE-A', year: '2026' }] }, 'tax-a');
    assert.equal(batch.batch.status, 'submitted');
    const lineId = batch.batch.lines[0].id;
    // 受理台给终态。
    await fetch(`${h.peerUrl}/control/settle`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: lineId, status: 'confirmed', details: { note: '最终确认' } }) });
    const synced = await h.ok('POST', `/filings/batches/${batch.batch.id}/sync`, {}, 'tax-a');
    assert.equal(synced.batch.lines[0].peerStatus, 'confirmed');
    const after = await h.ok('GET', '/entities/LE-A/years/2026', undefined, 'tax-a');
    assert.equal(after.selection.status, 'accepted');
    assert.equal(after.selection.versions[0].status, 'accepted');
    // 未明/已受理期间不得重复递交。
    await h.fail(422, 'POST', '/filings/batches', { entries: [{ entityId: 'LE-A', year: '2026' }] }, 'tax-a');
  } finally { await h.cleanup(); }
});

test('信用票冲减产生影响通知与人工复核，且不就地替换原证据', async () => {
  const h = await harness();
  try {
    await h.ok('POST', '/actors', { id: 'tax-a', role: 'tax' }, 'bootstrap');
    await h.ok('POST', '/actors', { id: 'accountant', role: 'accountant' }, 'tax-a');
    await h.ok('POST', '/actors', { id: 'book-a', role: 'bookkeeper', entity: 'LE-A' }, 'tax-a');
    await seedWorld(h);
    await h.ok('POST', '/entities/LE-A/invoices', { id: 'INV-1', supplier: 'VEN-A', year: '2026', lines: [{ id: 'L1', amountMinor: 300000 }] }, 'book-a');
    for (const [kind, ref] of [['supplier_location', 'HK-1'], ['service_place', 'P1'], ['invoice_title', 'T1']]) {
      const ev = await h.ok('POST', '/invoices/INV-1/evidence', { kind, docRef: ref, proofRef: ref }, 'book-a');
      await h.ok('POST', `/evidence/${ev.id}/assessment`, { decision: 'accepted' }, 'accountant');
    }
    const al = await h.ok('POST', '/entities/LE-A/allocations', { invoiceId: 'INV-1', lineId: 'L1', activityId: 'ACT-1', amountMinor: 300000 }, 'book-a');
    await h.ok('POST', `/allocations/${al.id}/review`, { decision: 'confirmed' }, 'accountant');
    // 超额冲减被拒；合规冲减导致占用超净额。
    await h.fail(422, 'POST', '/invoices/INV-1/credit-notes', { id: 'CN-BIG', amountMinor: 300001 }, 'book-a');
    await h.ok('POST', '/invoices/INV-1/credit-notes', { id: 'CN-1', amountMinor: 80000, reason: '服务费部分退回' }, 'book-a');
    const trace = await h.ok('GET', '/invoices/INV-1', undefined, 'tax-a');
    assert.equal(trace.lines[0].view.overOccupied, true);
    assert.equal(trace.lines[0].view.netAmount, 220000);
    const notes = await h.ok('GET', '/notifications?entityId=LE-A', undefined, 'tax-a');
    assert.ok(notes.some(n => n.topic === 'credit_note_impact'));
    const reviews = await h.ok('GET', '/manual-reviews?status=open', undefined, 'accountant');
    assert.ok(reviews.some(r => r.topic.includes('信用票')));
    // 原发票金额保持不变。
    assert.equal(trace.invoice.lines[0].amountMinor, 300000);
  } finally { await h.cleanup(); }
});

test('断线后按原流水查明，未明期间禁止重复递交，其他主体可继续整理', async () => {
  const h = await harness();
  try {
    await h.ok('POST', '/actors', { id: 'tax-a', role: 'tax' }, 'bootstrap');
    await h.ok('POST', '/actors', { id: 'accountant', role: 'accountant' }, 'tax-a');
    await h.ok('POST', '/actors', { id: 'book-a', role: 'bookkeeper', entity: 'LE-A' }, 'tax-a');
    await h.ok('POST', '/actors', { id: 'book-b', role: 'bookkeeper', entity: 'LE-B' }, 'tax-a');
    await seedWorld(h);
    await h.ok('POST', '/entities/LE-A/invoices', { id: 'INV-1', supplier: 'VEN-A', year: '2026', lines: [{ id: 'L1', amountMinor: 300000 }] }, 'book-a');
    for (const [kind, ref] of [['supplier_location', 'HK-1'], ['service_place', 'P1'], ['invoice_title', 'T1']]) {
      const ev = await h.ok('POST', '/invoices/INV-1/evidence', { kind, docRef: ref, proofRef: ref }, 'book-a');
      await h.ok('POST', `/evidence/${ev.id}/assessment`, { decision: 'accepted' }, 'accountant');
    }
    const al = await h.ok('POST', '/entities/LE-A/allocations', { invoiceId: 'INV-1', lineId: 'L1', activityId: 'ACT-1', amountMinor: 300000 }, 'book-a');
    await h.ok('POST', `/allocations/${al.id}/review`, { decision: 'confirmed' }, 'accountant');
    const { selection } = await h.ok('POST', '/entities/LE-A/years/2026/proposals', { schemeId: 'COVERED15' }, 'book-a');
    await h.ok('POST', `/selections/${selection.id}/confirm`, {}, 'tax-a');
    // 全新状态下首批编号为 B1，逐行编号可预知；先让受理台“先持久受理再断线”。
    const predictedLine = 'B1-LE-A-2026';
    await fetch(`${h.peerUrl}/control/rules`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: predictedLine, mode: 'accepted_disconnect' }) });
    const drop = await h.ok('POST', '/filings/batches', { entries: [{ entityId: 'LE-A', year: '2026' }], filingReference: 'FR-DROP' }, 'tax-a');
    assert.equal(drop.warning.includes('连接中断'), true);
    assert.equal(drop.batch.status, 'submitted_unverified');
    // 未明期间不能重复递交同一主体年度。
    await h.fail(422, 'POST', '/filings/batches', { entries: [{ entityId: 'LE-A', year: '2026' }], filingReference: 'FR-OTHER' }, 'tax-a');
    // 受理台其实已持久受理，回查可查明。
    const synced = await h.ok('POST', `/filings/batches/${drop.batch.id}/sync`, {}, 'tax-a');
    assert.equal(synced.report[0].peerStatus, 'accepted');
    // LE-B 不受影响，可继续登记整理资料。
    const invB = await h.ok('POST', '/entities/LE-B/invoices', { id: 'INV-2', supplier: 'VEN-B', year: '2026', lines: [{ id: 'L1', amountMinor: 100000 }] }, 'book-b');
    assert.equal(invB.id, 'INV-2');
  } finally { await h.cleanup(); }
});

test('受理后只能更正不能覆盖；退补保留原版本；结算不改资格', async () => {
  const h = await harness();
  try {
    await h.ok('POST', '/actors', { id: 'tax-a', role: 'tax' }, 'bootstrap');
    await h.ok('POST', '/actors', { id: 'tax-b', role: 'tax' }, 'tax-a');
    await h.ok('POST', '/actors', { id: 'accountant', role: 'accountant' }, 'tax-a');
    await h.ok('POST', '/actors', { id: 'book-a', role: 'bookkeeper', entity: 'LE-A' }, 'tax-a');
    await seedWorld(h);
    await h.ok('POST', '/entities/LE-A/invoices', { id: 'INV-1', supplier: 'VEN-A', year: '2026', lines: [{ id: 'L1', amountMinor: 300000 }] }, 'book-a');
    for (const [kind, ref] of [['supplier_location', 'HK-1'], ['service_place', 'P1'], ['invoice_title', 'T1']]) {
      const ev = await h.ok('POST', '/invoices/INV-1/evidence', { kind, docRef: ref, proofRef: ref }, 'book-a');
      await h.ok('POST', `/evidence/${ev.id}/assessment`, { decision: 'accepted' }, 'accountant');
    }
    const al = await h.ok('POST', '/entities/LE-A/allocations', { invoiceId: 'INV-1', lineId: 'L1', activityId: 'ACT-1', amountMinor: 200000 }, 'book-a');
    await h.ok('POST', `/allocations/${al.id}/review`, { decision: 'confirmed' }, 'accountant');
    const { selection } = await h.ok('POST', '/entities/LE-A/years/2026/proposals', { schemeId: 'HALF' }, 'book-a');
    await h.ok('POST', `/selections/${selection.id}/confirm`, {}, 'tax-a');
    const batch = await h.ok('POST', '/filings/batches', { entries: [{ entityId: 'LE-A', year: '2026' }] }, 'tax-a');
    await fetch(`${h.peerUrl}/control/settle`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: batch.batch.lines[0].id, status: 'confirmed' }) });
    await h.ok('POST', `/filings/batches/${batch.batch.id}/sync`, {}, 'tax-a');
    // 已受理：直接修订被拒，必须更正。
    await h.fail(422, 'POST', `/selections/${selection.id}/revise`, { schemeId: 'COVERED15' }, 'tax-a');
    // 同额缩减已受理份额不允许；不能补其他年度发票（这里用同年度增量做合规更正）。
    await h.fail(422, 'POST', '/entities/LE-A/years/2026/corrections', { reason: '缩减', allocationAdjustments: [{ allocationId: al.id, amountMinor: 100000 }] }, 'tax-a');
    const correction = await h.ok('POST', '/entities/LE-A/years/2026/corrections', {
      reason: '追加本地份额并改按受涵盖方案', targetSchemeId: 'COVERED15',
      allocationAdjustments: [{ allocationId: al.id, amountMinor: 250000 }],
    }, 'tax-a');
    // 更正不能自审。
    await h.fail(403, 'POST', `/corrections/${correction.id}/confirm`, {}, 'tax-a');
    const confirmedCorrection = await h.ok('POST', `/corrections/${correction.id}/confirm`, {}, 'tax-b');
    // 新分摊需会计确认后才能递交。
    await h.fail(422, 'POST', `/corrections/${correction.id}/submit`, {}, 'tax-b');
    for (const id of confirmedCorrection.newAllocations) {
      await h.ok('POST', `/allocations/${id}/review`, { decision: 'confirmed' }, 'accountant');
    }
    const submitted = await h.ok('POST', `/corrections/${correction.id}/submit`, {}, 'tax-b');
    assert.equal(submitted.status, 'submitted');
    await fetch(`${h.peerUrl}/control/settle`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: submitted.peerLineId, status: 'returned', details: { reason: '资料待补' } }) });
    const synced = await h.ok('POST', `/corrections/${correction.id}/sync`, {}, 'tax-b');
    assert.equal(synced.correction.status, 'returned');
    // 原受理版本仍在，且仍为 accepted。
    const view = await h.ok('GET', '/entities/LE-A/years/2026', undefined, 'tax-a');
    assert.equal(view.selection.versions.length, 1);
    assert.equal(view.selection.versions[0].status, 'accepted');
    // 结算事实不改变资格：登记补税后视图仍保留受理方案。
    await h.ok('POST', '/entities/LE-A/years/2026/settlements', { kind: 'supplemental_tax', amountMinor: 5000, reference: 'PAY-1' }, 'tax-a');
    const after = await h.ok('GET', '/entities/LE-A/years/2026', undefined, 'tax-a');
    assert.equal(after.selection.status, 'accepted');
    assert.ok(after.settlements.length === 1);
    assert.equal(after.settlementDifferenceMinor !== null, true);
    // 本地核对视图包含冲减与逐主体受理信息。
    const recon = await h.ok('GET', '/reconciliation?year=2026', undefined, 'tax-a');
    assert.equal(recon.entities.length, 2);
    assert.ok(recon.entities.find(e => e.entityId === 'LE-A').acceptedVersion === 1);
  } finally { await h.cleanup(); }
});

test('冲突提案不能确认；缺证保持未决，方案不可用', async () => {
  const h = await harness();
  try {
    await h.ok('POST', '/actors', { id: 'tax-a', role: 'tax' }, 'bootstrap');
    await h.ok('POST', '/actors', { id: 'accountant', role: 'accountant' }, 'tax-a');
    await h.ok('POST', '/actors', { id: 'book-a', role: 'bookkeeper', entity: 'LE-A' }, 'tax-a');
    await seedWorld(h);
    await h.ok('POST', '/entities/LE-A/invoices', { id: 'INV-1', supplier: 'VEN-A', year: '2026', lines: [{ id: 'L1', amountMinor: 300000 }] }, 'book-a');
    // 只登记发票抬头与服务地证据，供应商证据缺证。
    for (const [kind, ref] of [['service_place', 'P1'], ['invoice_title', 'T1']]) {
      const ev = await h.ok('POST', '/invoices/INV-1/evidence', { kind, docRef: ref, proofRef: ref }, 'book-a');
      await h.ok('POST', `/evidence/${ev.id}/assessment`, { decision: 'accepted' }, 'accountant');
    }
    const al = await h.ok('POST', '/entities/LE-A/allocations', { invoiceId: 'INV-1', lineId: 'L1', activityId: 'ACT-1', amountMinor: 300000 }, 'book-a');
    await h.ok('POST', `/allocations/${al.id}/review`, { decision: 'confirmed' }, 'accountant');
    const availability = await h.ok('GET', '/schemes/HALF/availability?entityId=LE-A&year=2026', undefined, 'accountant');
    assert.equal(availability.available, false);
    assert.ok(availability.reasons.some(r => r.includes('本地开支比例')));
    const p1 = await h.ok('POST', '/entities/LE-A/years/2026/proposals', { schemeId: 'HALF', activityId: 'ACT-1' }, 'book-a');
    await h.ok('POST', '/entities/LE-A/years/2026/proposals', { schemeId: 'COVERED15', activityId: 'ACT-2' }, 'book-a');
    await h.fail(409, 'POST', `/selections/${p1.selection.id}/confirm`, {}, 'tax-a');
  } finally { await h.cleanup(); }
});

test('应用重启后从状态文件恢复登记与审计轨迹', async () => {
  const h = await harness();
  try {
    await h.ok('POST', '/actors', { id: 'tax-a', role: 'tax' }, 'bootstrap');
    await h.ok('POST', '/entities', { id: 'LE-A', group: 'GR-1', covered: true }, 'tax-a');
    await h.ok('POST', '/activities', { id: 'ACT-1', entity: 'LE-A', year: '2026', kind: 'shipping', profitMinor: 1 }, 'tax-a');
    await h.ok('POST', '/suppliers', { id: 'VEN-A' }, 'tax-a');
    await h.ok('POST', '/schemes', { id: 'HALF', allowed: ['shipping'], localRatio: '0.50', rate: '0.0825' }, 'tax-a');
    await h.ok('POST', '/actors', { id: 'book-a', role: 'bookkeeper', entity: 'LE-A' }, 'tax-a');
    await h.ok('POST', '/entities/LE-A/invoices', { id: 'INV-1', supplier: 'VEN-A', year: '2026', lines: [{ id: 'L1', amountMinor: 1000 }] }, 'book-a');
    await close(h.app);
    const restarted = createApp(new Store(h.stateFile), new PeerClient(h.peerUrl, partnerConfig.key, partnerConfig.group, partnerConfig.id));
    const url = await listen(restarted);
    const invoices = await (await fetch(`${url}/invoices`, { headers: { 'Actor-Id': 'tax-a' } })).json();
    const auditLog = await (await fetch(`${url}/audit`, { headers: { 'Actor-Id': 'tax-a' } })).json();
    assert.equal(invoices.length, 1);
    assert.equal(invoices[0].id, 'INV-1');
    assert.ok(auditLog.some(a => a.action === 'invoice.register'));
    await close(restarted);
  } finally { await h.cleanup(); }
});

test('同一批次逐主体一受理一退补：退补方可修订重报，受理方不受影响', async () => {
  const h = await harness();
  try {
    await h.ok('POST', '/actors', { id: 'tax-a', role: 'tax' }, 'bootstrap');
    await h.ok('POST', '/actors', { id: 'tax-b', role: 'tax' }, 'tax-a');
    await h.ok('POST', '/actors', { id: 'accountant', role: 'accountant' }, 'tax-a');
    await h.ok('POST', '/actors', { id: 'book-a', role: 'bookkeeper', entity: 'LE-A' }, 'tax-a');
    await h.ok('POST', '/actors', { id: 'book-b', role: 'bookkeeper', entity: 'LE-B' }, 'tax-a');
    await seedWorld(h);
    // 两个主体各登记发票、三类证据、全额分摊并确认。
    for (const [entity, book, invoice, supplier, line, activity] of [
      ['LE-A', 'book-a', 'INV-1', 'VEN-A', 'L1', 'ACT-1'],
      ['LE-B', 'book-b', 'INV-2', 'VEN-B', 'L1', 'ACT-3'],
    ]) {
      await h.ok('POST', `/entities/${entity}/invoices`, { id: invoice, supplier, year: '2026', lines: [{ id: line, amountMinor: 200000 }] }, book);
      for (const kind of ['supplier_location', 'service_place', 'invoice_title']) {
        const ev = await h.ok('POST', `/invoices/${invoice}/evidence`, { kind, docRef: `${invoice}-${kind}`, proofRef: `${invoice}-${kind}` }, book);
        await h.ok('POST', `/evidence/${ev.id}/assessment`, { decision: 'accepted' }, 'accountant');
      }
      const al = await h.ok('POST', `/entities/${entity}/allocations`, { invoiceId: invoice, lineId: line, activityId: activity, amountMinor: 200000 }, book);
      await h.ok('POST', `/allocations/${al.id}/review`, { decision: 'confirmed' }, 'accountant');
      const { selection } = await h.ok('POST', `/entities/${entity}/years/2026/proposals`, { schemeId: 'HALF' }, book);
      await h.ok('POST', `/selections/${selection.id}/confirm`, {}, 'tax-a');
    }
    const batch = await h.ok('POST', '/filings/batches', {
      entries: [{ entityId: 'LE-A', year: '2026' }, { entityId: 'LE-B', year: '2026' }], filingReference: 'FR-MIX',
    }, 'tax-a');
    const [lineA, lineB] = batch.batch.lines;
    // 受理台逐主体给不同终态。
    await fetch(`${h.peerUrl}/control/settle`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: lineA.id, status: 'confirmed' }) });
    await fetch(`${h.peerUrl}/control/settle`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: lineB.id, status: 'returned', details: { reason: '待补' } }) });
    const synced = await h.ok('POST', `/filings/batches/${batch.batch.id}/sync`, {}, 'tax-a');
    assert.equal(synced.batch.status, 'partially_accepted');
    assert.equal(synced.batch.lines.find(l => l.entityId === 'LE-A').status, 'accepted');
    assert.equal(synced.batch.lines.find(l => l.entityId === 'LE-B').status, 'returned');
    const viewA = await h.ok('GET', '/entities/LE-A/years/2026', undefined, 'tax-a');
    const viewB = await h.ok('GET', '/entities/LE-B/years/2026', undefined, 'tax-a');
    assert.equal(viewA.selection.status, 'accepted');
    assert.equal(viewB.selection.status, 'returned');
    assert.ok(viewB.filings[0].peerStatus === 'returned');
    // 已受理方不能 reopen；退补方 reopen 后修订并重新申报。
    await h.fail(422, 'POST', `/selections/${viewA.selection.id}/reopen`, {}, 'tax-a');
    const reopened = await h.ok('POST', `/selections/${viewB.selection.id}/reopen`, { note: '补证后重报' }, 'tax-a');
    assert.equal(reopened.selection.status, 'proposed');
    await h.ok('POST', `/selections/${viewB.selection.id}/confirm`, {}, 'tax-b');
    const second = await h.ok('POST', '/filings/batches', { entries: [{ entityId: 'LE-B', year: '2026' }], filingReference: 'FR-MIX-2' }, 'tax-a');
    await fetch(`${h.peerUrl}/control/settle`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: second.batch.lines[0].id, status: 'confirmed' }) });
    await h.ok('POST', `/filings/batches/${second.batch.id}/sync`, {}, 'tax-a');
    const finalB = await h.ok('GET', '/entities/LE-B/years/2026', undefined, 'tax-a');
    assert.equal(finalB.selection.status, 'accepted');
    // 核对视图同时呈现两个主体的受理与退补历史。
    const recon = await h.ok('GET', '/reconciliation?year=2026', undefined, 'tax-a');
    const rowB = recon.entities.find(e => e.entityId === 'LE-B');
    assert.equal(rowB.filingLines.length, 2);
    assert.ok(rowB.filingLines.some(l => l.peerStatus === 'returned'));
    assert.ok(rowB.filingLines.some(l => l.peerStatus === 'confirmed'));
  } finally { await h.cleanup(); }
});

test('申报前分摊调整保留旧版本，超额拒绝不产生半成功数据', async () => {
  const h = await harness();
  try {
    await h.ok('POST', '/actors', { id: 'tax-a', role: 'tax' }, 'bootstrap');
    await h.ok('POST', '/actors', { id: 'accountant', role: 'accountant' }, 'tax-a');
    await h.ok('POST', '/actors', { id: 'book-a', role: 'bookkeeper', entity: 'LE-A' }, 'tax-a');
    await seedWorld(h);
    await h.ok('POST', '/entities/LE-A/invoices', { id: 'INV-1', supplier: 'VEN-A', year: '2026', lines: [{ id: 'L1', amountMinor: 300000 }] }, 'book-a');
    const al = await h.ok('POST', '/entities/LE-A/allocations', { invoiceId: 'INV-1', lineId: 'L1', activityId: 'ACT-1', amountMinor: 100000 }, 'book-a');
    // 超额调整被拒，原提案保持 proposed。
    await h.fail(422, 'POST', `/allocations/${al.id}/adjustment`, { amountMinor: 300001 }, 'book-a');
    const unchanged = (await h.ok('GET', '/allocations?entityId=LE-A&year=2026', undefined, 'tax-a')).find(a => a.id === al.id);
    assert.equal(unchanged.status, 'proposed');
    // 合规调整：旧记录 superseded 保留，新提案占用正确。
    const replacement = await h.ok('POST', `/allocations/${al.id}/adjustment`, { amountMinor: 250000 }, 'book-a');
    assert.equal(replacement.supersedes, al.id);
    const trace = await h.ok('GET', '/invoices/INV-1', undefined, 'tax-a');
    assert.equal(trace.lines[0].view.occupied, 250000);
    assert.equal(trace.lines[0].view.unused, 50000);
    const all = await h.ok('GET', '/allocations?entityId=LE-A&year=2026', undefined, 'tax-a');
    assert.equal(all.find(a => a.id === al.id).status, 'superseded');
    // 再调整超过发票行净额被拒，替代口径也不能突破 300000。
    await h.fail(422, 'POST', `/allocations/${replacement.id}/adjustment`, { amountMinor: 300001 }, 'book-a');
    const capped = await h.ok('POST', `/allocations/${replacement.id}/adjustment`, { amountMinor: 300000 }, 'book-a');
    assert.equal(capped.amountMinor, 300000);
    const finalTrace = await h.ok('GET', '/invoices/INV-1', undefined, 'tax-a');
    assert.equal(finalTrace.lines[0].view.unused, 0);
  } finally { await h.cleanup(); }
});
