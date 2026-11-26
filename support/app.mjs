// 业务应用 HTTP 服务：发票登记 → 证据/分摊判断 → 年度选用 → 申报受理 → 更正与结算。
// 设计红线：
// 1) 原始发票登记后不可就地修改，变化只能通过信用票、证明变更、更正申请形成新记录；
// 2) 缺证保持未决，不默认合格也不默认不合格；仅凭香港地址文本不能认定供应商合格；
// 3) 受理确认后不能覆盖原版本，只能走更正；结算事实不改变优惠资格；
// 4) 同一金额不得重复占用，分摊不得跨主体；未明批次不得重复递交同一主体年度。
import { createServer } from 'node:http';
import {
  DomainError, decimalParts, applyRate, requireRecord,
  lineView, invoiceTrace, evidenceGate, entityYearNumbers,
  schemeAvailability, pendingFilingLine, latestAcceptedSelection, activeAllocations,
  creditedOnLine,
} from './domain.mjs';

const ROLES = ['bookkeeper', 'accountant', 'tax'];
const EVIDENCE_KINDS = ['supplier_location', 'service_place', 'invoice_title'];
const clone = value => JSON.parse(JSON.stringify(value));
const now = () => new Date().toISOString();
const isPosInt = n => Number.isInteger(n) && n > 0 && n <= Number.MAX_SAFE_INTEGER;
const yearText = y => {
  const s = String(y);
  if (!/^\d{4}$/.test(s)) throw new DomainError('年度需为四位数字', 400);
  return s;
};

export function createApp(store, peerClient) {
  const state = store.state;

  // ---------- 通用辅助 ----------
  const send = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
  };
  const nextId = (kind, counterKey) => {
    state.counters[counterKey] = (state.counters[counterKey] ?? 0) + 1;
    return `${kind}${state.counters[counterKey]}`;
  };
  const audit = (action, actorId, details) => {
    state.audit.push({ id: nextId('AU', 'audit'), at: now(), action, actorId, details });
  };
  const notify = (entityId, topic, details, severity = 'info') => {
    const id = nextId('NT', 'notification');
    state.notifications[id] = { id, entityId, topic, severity, details, at: now(), read: false };
    return id;
  };
  const openReview = (topic, details) => {
    const id = nextId('MR', 'review');
    state.manualReviews[id] = { id, topic, status: 'open', details, createdAt: now(), closedAt: null };
    return id;
  };
  const requireBody = (body, field) => {
    if (body[field] === undefined || body[field] === null || body[field] === '') {
      throw new DomainError(`缺少字段：${field}`, 400);
    }
    return body[field];
  };
  const authenticate = req => {
    const actorId = req.headers['actor-id'];
    if (typeof actorId !== 'string' || !actorId) throw new DomainError('缺少 Actor-Id 请求头', 401);
    if (actorId === 'bootstrap') return { id: 'bootstrap', role: 'bootstrap' };
    const actor = state.actors[actorId];
    if (!actor) throw new DomainError(`角色不存在：${actorId}`, 401);
    return actor;
  };
  const requireRole = (actor, roles) => {
    if (!roles.includes(actor.role)) throw new DomainError(`角色 ${actor.role} 无权执行该操作，需要：${roles.join('/')}`, 403);
  };
  const requireEntityScope = (actor, entityId) => {
    if (actor.role === 'bookkeeper' && actor.entity !== entityId) {
      throw new DomainError('普通业务人员只能提交本主体资料', 403);
    }
  };
  const notSelf = (actor, otherActorId, label) => {
    if (otherActorId && actor.id === otherActorId) throw new DomainError(`${label}不能自审，请更换有权限的复核人`, 403);
  };
  // 对一组提出人做自审检查（年度确认人不能确认自己提出的提案）。
  const notSelfAny = (actor, otherActorIds, label) => {
    if (otherActorIds.includes(actor.id)) throw new DomainError(`${label}不能自审，请更换有权限的复核人`, 403);
  };
  const findSelection = id => {
    const byId = Object.values(state.selections).find(s => s.id === id);
    if (!byId) throw new DomainError(`选用不存在：${id}`, 404);
    return byId;
  };

  // 发票行被冲减后，若占用超出净额，通知持有分摊的主体并挂人工复核。
  const raiseCreditImpact = (invoice, lineId) => {
    const line = invoice.lines.find(l => l.id === lineId);
    const view = lineView(state, invoice, line);
    if (!view.overOccupied) return;
    const holders = activeAllocations(state)
      .filter(a => a.invoiceId === invoice.id && a.lineId === lineId)
      .map(a => a.entityId);
    for (const entityId of new Set(holders)) {
      notify(entityId, 'credit_note_impact', {
        invoiceId: invoice.id, lineId, netAmount: view.netAmount, occupied: view.occupied,
        allocations: activeAllocations(state)
          .filter(a => a.invoiceId === invoice.id && a.lineId === lineId && a.entityId === entityId)
          .map(a => a.id),
      }, 'warning');
    }
    openReview('信用票冲减后占用超出净额', { invoiceId: invoice.id, lineId, view, holders: [...new Set(holders)] });
  };

  // 已被申报版本引用的分摊不允许直接调整。
  const filedAllocationIds = () => {
    const ids = new Set();
    for (const selection of Object.values(state.selections)) {
      for (const version of selection.versions) {
        for (const item of version.snapshot?.allocations ?? []) ids.add(item.allocationId);
      }
    }
    for (const correction of Object.values(state.corrections)) {
      for (const adj of correction.allocationAdjustments ?? []) ids.add(adj.allocationId);
    }
    return ids;
  };

  // ---------- 处理器 ----------
  const handlers = {
    health: () => ({ status: 'ok', service: 'maritime-returns-app', at: now() }),

    createActor: (actor, body) => {
      if (Object.keys(state.actors).length > 0) requireRole(actor, ['tax']);
      else if (actor.role !== 'bootstrap') throw new DomainError('系统尚未初始化，仅允许 Actor-Id: bootstrap 建立首个角色', 403);
      const id = requireBody(body, 'id');
      const role = requireBody(body, 'role');
      if (!ROLES.includes(role)) throw new DomainError(`角色需为：${ROLES.join('、')}`, 400);
      if (state.actors[id]) throw new DomainError(`角色已存在：${id}`, 409);
      if (role === 'bookkeeper' && !body.entity) throw new DomainError('财务角色必须声明所属主体 entity', 400);
      const record = { id, role, entity: body.entity ?? null, createdAt: now() };
      state.actors[id] = record;
      audit('actor.create', actor.id, { id, role });
      return record;
    },

    createEntity: (actor, body) => {
      requireRole(actor, ['tax']);
      const id = requireBody(body, 'id');
      if (state.entities[id]) throw new DomainError(`主体已存在：${id}`, 409);
      const record = { id, group: requireBody(body, 'group'), covered: Boolean(body.covered), createdAt: now() };
      state.entities[id] = record;
      audit('entity.create', actor.id, { id });
      return record;
    },

    createActivity: (actor, body) => {
      requireRole(actor, ['tax']);
      const id = requireBody(body, 'id');
      const entityId = requireBody(body, 'entity');
      requireRecord(state.entities, entityId, '主体');
      const year = yearText(body.year);
      if (state.activities[id]) throw new DomainError(`业务线已存在：${id}`, 409);
      const profitMinor = body.profitMinor ?? 0;
      if (!Number.isInteger(profitMinor) || profitMinor < 0) throw new DomainError('利润金额需为非负整数（分）', 400);
      const record = { id, entity: entityId, year, kind: requireBody(body, 'kind'), profitMinor, createdAt: now() };
      state.activities[id] = record;
      audit('activity.create', actor.id, { id, entityId, year });
      return record;
    },

    createSupplier: (actor, body) => {
      requireRole(actor, ['tax']);
      const id = requireBody(body, 'id');
      if (state.suppliers[id]) throw new DomainError(`供应商已存在：${id}`, 409);
      const record = { id, locationText: body.locationProof ?? body.locationText ?? null, proofHistory: [], createdAt: now() };
      state.suppliers[id] = record;
      audit('supplier.create', actor.id, { id });
      return record;
    },

    addSupplierProof: (actor, body, params) => {
      requireRole(actor, ['bookkeeper', 'accountant']);
      const supplier = requireRecord(state.suppliers, params.supplierId, '供应商');
      if (actor.role === 'bookkeeper') requireEntityScope(actor, body.entityId ?? actor.entity);
      const proofRef = requireBody(body, 'proofRef');
      // 旧证明保留：只追加，不覆盖 locationText。
      const record = { proofRef, note: body.note ?? null, occurredOn: body.occurredOn ?? now(), registeredBy: actor.id, at: now() };
      supplier.proofHistory.push(record);
      openReview('供应商证明待会计判断', { supplierId: supplier.id, proofRef });
      audit('supplier.proof.append', actor.id, { supplierId: supplier.id, proofRef });
      return supplier;
    },

    createScheme: (actor, body) => {
      requireRole(actor, ['tax']);
      const id = requireBody(body, 'id');
      if (state.schemes[id]) throw new DomainError(`方案已存在：${id}`, 409);
      const allowed = requireBody(body, 'allowed');
      if (!Array.isArray(allowed) || !allowed.length) throw new DomainError('allowed 需为非空业务范围数组', 400);
      const localRatio = String(requireBody(body, 'localRatio'));
      const rate = String(requireBody(body, 'rate'));
      decimalParts(localRatio); decimalParts(rate); // 仅校验格式，阈值含义以合成合同为准
      const record = {
        id, allowed, coveredOnly: Boolean(body.coveredOnly), localRatio, rate,
        contractNote: body.contractNote ?? '合成优惠合同，未列明事项交人工复核', createdAt: now(),
      };
      state.schemes[id] = record;
      audit('scheme.create', actor.id, { id, localRatio, rate });
      return record;
    },

    createInvoice: (actor, body, params) => {
      requireRole(actor, ['bookkeeper']);
      const entityId = params.entityId;
      requireEntityScope(actor, entityId);
      requireRecord(state.entities, entityId, '主体');
      const supplier = requireRecord(state.suppliers, requireBody(body, 'supplier'), '供应商');
      const year = yearText(body.year);
      const id = requireBody(body, 'id');
      if (state.invoices[id]) throw new DomainError(`发票已存在：${id}`, 409);
      const linesInput = requireBody(body, 'lines');
      if (!Array.isArray(linesInput) || !linesInput.length) throw new DomainError('发票至少需要一行', 400);
      const lineIds = new Set();
      const lines = linesInput.map(line => {
        if (!line.id || lineIds.has(line.id)) throw new DomainError('发票行编号缺失或重复', 400);
        lineIds.add(line.id);
        if (!isPosInt(line.amountMinor)) throw new DomainError('发票行金额需为正整数（分）', 400);
        return { id: line.id, description: line.description ?? null, amountMinor: line.amountMinor };
      });
      const invoice = {
        id, entityId, supplierId: supplier.id, year, lines,
        registeredBy: actor.id, registeredAt: now(), immutable: true,
      };
      state.invoices[id] = invoice;
      openReview('新发票三类证据待补', { invoiceId: id, missing: [...EVIDENCE_KINDS] });
      audit('invoice.register', actor.id, { id, entityId, lineCount: lines.length });
      return invoice;
    },

    addCreditNote: (actor, body, params) => {
      requireRole(actor, ['bookkeeper']);
      const invoice = requireRecord(state.invoices, params.invoiceId, '发票');
      requireEntityScope(actor, invoice.entityId);
      if (!isPosInt(body.amountMinor)) throw new DomainError('信用票金额需为正整数（分）', 400);
      let lineId = body.lineId;
      if (!lineId) {
        if (invoice.lines.length !== 1) throw new DomainError('多行发票的信用票必须指定 lineId', 400);
        lineId = invoice.lines[0].id;
      }
      const line = invoice.lines.find(l => l.id === lineId);
      if (!line) throw new DomainError('发票行不存在', 404);
      const already = creditedOnLine(state, invoice.id, lineId);
      if (already + body.amountMinor > line.amountMinor) {
        throw new DomainError(`累计冲减 ${already + body.amountMinor} 超过发票行金额 ${line.amountMinor}`, 422);
      }
      const id = requireBody(body, 'id');
      if (state.creditNotes[id]) throw new DomainError(`信用票编号已存在：${id}`, 409);
      const record = {
        id, invoiceId: invoice.id, lineId, amountMinor: body.amountMinor,
        reason: body.reason ?? null, occurredOn: body.occurredOn ?? now(),
        registeredBy: actor.id, registeredAt: now(),
      };
      state.creditNotes[id] = record;
      audit('credit-note.register', actor.id, { id, invoiceId: invoice.id, lineId });
      raiseCreditImpact(invoice, lineId);
      return record;
    },

    addEvidence: (actor, body, params) => {
      requireRole(actor, ['bookkeeper', 'accountant']);
      const invoice = requireRecord(state.invoices, params.invoiceId, '发票');
      if (actor.role === 'bookkeeper') requireEntityScope(actor, invoice.entityId);
      const kind = requireBody(body, 'kind');
      if (!EVIDENCE_KINDS.includes(kind)) throw new DomainError(`证据类型需为：${EVIDENCE_KINDS.join('、')}`, 400);
      const docRef = requireBody(body, 'docRef');
      const id = nextId('EV', 'evidence');
      const record = {
        id, invoiceId: invoice.id, kind, docRef,
        proofRef: body.proofRef ?? null, note: body.note ?? null,
        status: 'pending', registeredBy: actor.id, registeredAt: now(),
        occurredOn: body.occurredOn ?? now(), history: [],
      };
      state.evidence[id] = record;
      audit('evidence.register', actor.id, { id, invoiceId: invoice.id, kind });
      return record;
    },

    assessEvidence: (actor, body, params) => {
      requireRole(actor, ['accountant']);
      const doc = requireRecord(state.evidence, params.evidenceId, '证据');
      const decision = requireBody(body, 'decision');
      if (!['accepted', 'rejected'].includes(decision)) throw new DomainError('决定需为 accepted 或 rejected', 400);
      notSelf(actor, doc.registeredBy, '证据审核');
      if (decision === 'accepted' && doc.kind === 'supplier_location' && !doc.proofRef) {
        throw new DomainError('仅凭香港地址文本不能认定合格：请先登记带 proofRef 的供应商证明，再行接受', 422);
      }
      const before = evidenceGate(state, doc.invoiceId).qualified;
      doc.history.push({ status: doc.status, at: now(), by: actor.id, note: doc.note });
      doc.status = decision;
      doc.assessedBy = actor.id;
      doc.assessedAt = now();
      doc.assessmentNote = body.note ?? null;
      audit('evidence.assess', actor.id, { id: doc.id, decision });
      // 已被申报引用的发票，其证据结论变化需通知相关主体影响范围。
      const after = evidenceGate(state, doc.invoiceId).qualified;
      if (before !== after) {
        const invoice = state.invoices[doc.invoiceId];
        const touched = new Set(activeAllocations(state).filter(a => a.invoiceId === invoice.id).map(a => a.entityId));
        for (const entityId of touched) {
          const accepted = latestAcceptedSelection(state, entityId, invoice.year);
          if (accepted) {
            notify(entityId, 'evidence_change_impact', {
              invoiceId: invoice.id, qualifiedNow: after, acceptedVersion: accepted.version.version,
            }, 'warning');
          }
        }
      }
      return doc;
    },

    createAllocation: (actor, body, params) => {
      requireRole(actor, ['bookkeeper']);
      const entityId = params.entityId;
      requireEntityScope(actor, entityId);
      requireRecord(state.entities, entityId, '主体');
      const invoice = requireRecord(state.invoices, requireBody(body, 'invoiceId'), '发票');
      if (invoice.entityId !== entityId) throw new DomainError('分摊目标主体必须与发票抬头主体一致，禁止跨主体搬用', 422);
      const line = invoice.lines.find(l => l.id === requireBody(body, 'lineId'));
      if (!line) throw new DomainError('发票行不存在', 404);
      const activity = requireRecord(state.activities, requireBody(body, 'activityId'), '业务线');
      if (activity.entity !== entityId) throw new DomainError('业务线不属于该主体', 422);
      if (activity.year !== invoice.year) throw new DomainError('业务线年度与发票年度不一致', 422);
      if (!isPosInt(body.amountMinor)) throw new DomainError('分摊金额需为正整数（分）', 400);
      const view = lineView(state, invoice, line);
      if (body.amountMinor > view.unused) {
        throw new DomainError(`分摊 ${body.amountMinor} 超过未用余额 ${view.unused}（净额 ${view.netAmount}，已占用 ${view.occupied}）`, 422);
      }
      const id = nextId('AL', 'allocation');
      const record = {
        id, invoiceId: invoice.id, lineId: line.id, activityId: activity.id,
        entityId, year: invoice.year, amountMinor: body.amountMinor,
        status: 'proposed', createdBy: actor.id, createdAt: now(), history: [],
      };
      state.allocations[id] = record;
      audit('allocation.create', actor.id, { id, invoiceId: invoice.id, amountMinor: record.amountMinor });
      return record;
    },

    reviewAllocation: (actor, body, params) => {
      requireRole(actor, ['accountant']);
      const allocation = requireRecord(state.allocations, params.allocationId, '分摊');
      notSelf(actor, allocation.createdBy, '分摊审核');
      const decision = requireBody(body, 'decision');
      if (!['confirmed', 'rejected'].includes(decision)) throw new DomainError('决定需为 confirmed 或 rejected', 400);
      if (allocation.status !== 'proposed') throw new DomainError(`分摊当前状态 ${allocation.status}，不可复核`, 422);
      if (decision === 'confirmed') {
        const invoice = requireRecord(state.invoices, allocation.invoiceId, '发票');
        const line = invoice.lines.find(l => l.id === allocation.lineId);
        // 复核占用时排除本提案自身，其余提案+已确认不得超过净可用额。
        const others = activeAllocations(state)
          .filter(a => a.id !== allocation.id && a.invoiceId === invoice.id && a.lineId === line.id)
          .filter(a => a.status === 'proposed' || a.status === 'confirmed')
          .reduce((n, a) => n + a.amountMinor, 0);
        const credited = creditedOnLine(state, invoice.id, line.id);
        const available = line.amountMinor - credited - others;
        if (allocation.amountMinor > available) {
          throw new DomainError(`确认时可用余额仅 ${available}，分摊 ${allocation.amountMinor} 无法确认`, 422);
        }
      }
      allocation.history.push({ status: allocation.status, at: now(), by: actor.id, note: body.note ?? null });
      allocation.status = decision;
      allocation.reviewedBy = actor.id;
      allocation.reviewedAt = now();
      audit('allocation.review', actor.id, { id: allocation.id, decision });
      return allocation;
    },

    adjustAllocation: (actor, body, params) => {
      requireRole(actor, ['bookkeeper']);
      const old = requireRecord(state.allocations, params.allocationId, '分摊');
      requireEntityScope(actor, old.entityId);
      if (filedAllocationIds().has(old.id)) {
        throw new DomainError('该分摊已被申报版本引用，不能就地调整；受理后请走更正申请，退补按原批次处理', 422);
      }
      if (!isPosInt(body.amountMinor)) throw new DomainError('调整后金额需为正整数（分）', 400);
      if (body.amountMinor === old.amountMinor) throw new DomainError('调整金额与原值相同', 400);
      const invoice = requireRecord(state.invoices, old.invoiceId, '发票');
      const line = invoice.lines.find(l => l.id === old.lineId);
      // 先在“剔除本分摊”的口径上校验容量，再落状态，避免半成功数据。
      const credited = creditedOnLine(state, invoice.id, line.id);
      const otherOccupied = activeAllocations(state)
        .filter(a => a.id !== old.id && a.invoiceId === invoice.id && a.lineId === line.id)
        .filter(a => a.status === 'proposed' || a.status === 'confirmed')
        .reduce((n, a) => n + a.amountMinor, 0);
      const capacity = line.amountMinor - credited - otherOccupied;
      if (body.amountMinor > capacity) {
        throw new DomainError(`调整后金额 ${body.amountMinor} 超过可用额 ${capacity}`, 422);
      }
      // 旧记录标记取代而非删除，保留提出方与发生时间。
      old.status = 'superseded';
      old.supersededAt = now();
      const id = nextId('AL', 'allocation');
      const replacement = {
        id, invoiceId: old.invoiceId, lineId: old.lineId, activityId: old.activityId,
        entityId: old.entityId, year: old.year, amountMinor: body.amountMinor,
        status: 'proposed', createdBy: actor.id, createdAt: now(),
        supersedes: old.id, history: [],
      };
      state.allocations[id] = replacement;
      audit('allocation.adjust', actor.id, { from: old.id, to: id, amountMinor: body.amountMinor });
      return replacement;
    },

    proposeSelection: (actor, body, params) => {
      requireRole(actor, ['bookkeeper', 'accountant']);
      const entityId = params.entityId;
      const year = yearText(params.year);
      requireRecord(state.entities, entityId, '主体');
      const scheme = requireRecord(state.schemes, requireBody(body, 'schemeId'), '方案');
      if (body.activityId) requireRecord(state.activities, body.activityId, '业务线');
      const key = `${entityId}:${year}`;
      let selection = state.selections[key];
      if (!selection) {
        selection = {
          id: nextId('SL', 'selection'), entityId, year, status: 'proposed',
          proposals: [], versions: [], createdAt: now(),
        };
        state.selections[key] = selection;
      }
      if (['filed', 'accepted'].includes(selection.status)) {
        throw new DomainError('该主体年度已递交并获受理，变更只能通过更正申请', 422);
      }
      const proposal = {
        id: nextId('PR', 'proposal'), schemeId: scheme.id, activityId: body.activityId ?? null,
        source: body.source ?? 'business_line', createdBy: actor.id, createdAt: now(), note: body.note ?? null,
      };
      selection.proposals.push(proposal);
      selection.status = 'proposed';
      audit('selection.propose', actor.id, { selectionId: selection.id, schemeId: scheme.id });
      return { selection, proposal };
    },

    confirmSelection: (actor, body, params) => {
      requireRole(actor, ['tax']);
      const selection = findSelection(params.selectionId);
      if (selection.status !== 'proposed') throw new DomainError(`选用状态为 ${selection.status}，仅提案中可确认`, 422);
      if (!selection.proposals.length) throw new DomainError('没有待确认的年度提案', 422);
      const proposers = [...new Set(selection.proposals.map(p => p.createdBy))];
      notSelfAny(actor, proposers, '年度确认');
      const schemeIds = [...new Set(selection.proposals.map(p => p.schemeId))];
      if (schemeIds.length > 1) {
        throw new DomainError(`同年度不同业务线提出互相冲突的方案：${schemeIds.join('、')}，请先统一提案`, 409);
      }
      const pending = pendingFilingLine(state, selection.entityId, selection.year);
      if (pending) throw new DomainError(`存在未明批次 ${pending.batchId}，不得重复递交或确认新方案`, 422);
      const schemeId = schemeIds[0];
      const availability = schemeAvailability(state, selection.entityId, selection.year, schemeId);
      if (!availability.available) throw new DomainError(`方案当前不可用：${availability.reasons.join('；')}`, 422);
      const numbers = entityYearNumbers(state, selection.entityId, selection.year);
      const version = {
        version: (selection.versions.at(-1)?.version ?? 0) + 1,
        schemeId, status: 'selected', confirmedBy: actor.id, confirmedAt: now(),
        snapshot: {
          at: now(), numbers: clone(numbers), availability: clone(availability),
          benefitEstimateMinor: applyRate(numbers.qualifiedLocalMinor, state.schemes[schemeId].rate),
          allocations: numbers.detail.map(d => ({ ...d })),
        },
      };
      selection.versions.push(version);
      selection.status = 'selected';
      audit('selection.confirm', actor.id, { selectionId: selection.id, version: version.version, schemeId });
      return { selection, version };
    },

    reviseSelection: (actor, body, params) => {
      requireRole(actor, ['tax']);
      const selection = findSelection(params.selectionId);
      if (['filed', 'accepted'].includes(selection.status)) {
        throw new DomainError('受理确认后不能直接修订，请提交更正申请', 422);
      }
      const scheme = requireRecord(state.schemes, requireBody(body, 'schemeId'), '方案');
      const proposal = {
        id: nextId('PR', 'proposal'), schemeId: scheme.id, activityId: null,
        source: 'revise', createdBy: actor.id, createdAt: now(), note: body.note ?? null,
      };
      selection.proposals.push(proposal);
      selection.status = 'proposed';
      audit('selection.revise', actor.id, { selectionId: selection.id, schemeId: scheme.id });
      return { selection, proposal };
    },

    // 批次被退补（returned/rejected）后重新打开：受理台流水保留，主体年度回到提案态修订重报。
    // 已受理（accepted）的版本不受影响，也不能用此接口绕过更正流程。
    reopenSelection: (actor, body, params) => {
      requireRole(actor, ['tax']);
      const selection = findSelection(params.selectionId);
      if (!['returned', 'rejected'].includes(selection.status)) {
        throw new DomainError(`仅退补状态可重新打开，当前状态：${selection.status}`, 422);
      }
      const pending = pendingFilingLine(state, selection.entityId, selection.year);
      if (pending) throw new DomainError(`存在未明批次 ${pending.batchId}，请先查明再处理`, 422);
      const previousVersion = selection.versions.at(-1);
      previousVersion.closedAt = now();
      const proposal = {
        id: nextId('PR', 'proposal'), schemeId: body.schemeId ?? previousVersion.schemeId,
        activityId: null, source: 'reopen_after_return', createdBy: actor.id,
        createdAt: now(), note: body.note ?? '退补后修订重报',
      };
      selection.proposals.push(proposal);
      selection.status = 'proposed';
      audit('selection.reopen', actor.id, { selectionId: selection.id, fromStatus: previousVersion.status });
      return { selection, proposal };
    },

    createFilingBatch: async (actor, body) => {
      requireRole(actor, ['tax']);
      const entries = requireBody(body, 'entries');
      if (!Array.isArray(entries) || !entries.length || entries.length > 100) throw new DomainError('每批一至一百个主体年度', 400);
      const keys = new Set();
      for (const entry of entries) {
        const key = `${entry.entityId}:${yearText(entry.year)}`;
        if (keys.has(key)) throw new DomainError(`批次内主体年度重复：${key}`, 400);
        keys.add(key);
      }
      if (body.filingReference && state.batches[body.filingReference]) {
        throw new DomainError('该 Filing-Reference 已存在，请通过批次查明接口或 sync 按原流水核对', 409);
      }
      const lines = [];
      for (const entry of entries) {
        const year = yearText(entry.year);
        const selection = state.selections[`${entry.entityId}:${year}`];
        if (!selection) throw new DomainError(`${entry.entityId} ${year} 尚无年度选用`, 422);
        if (selection.status !== 'selected') throw new DomainError(`${entry.entityId} ${year} 选用状态为 ${selection.status}，未到可递交状态`, 422);
        const pending = pendingFilingLine(state, entry.entityId, year);
        if (pending) throw new DomainError(`${entry.entityId} ${year} 存在未明批次 ${pending.batchId}，不能重复递交`, 422);
        const version = selection.versions.at(-1);
        lines.push({
          id: null, entityId: entry.entityId, year, selectionId: selection.id, version: version.version,
          peerItem: null, peerStatus: 'unknown', peerRevision: null, peerDetails: null,
          lastCheckedAt: null, status: 'pending', snapshot: clone(version.snapshot), schemeId: version.schemeId,
        });
      }
      const batchId = nextId('B', 'batch');
      const filingReference = body.filingReference ?? `FR-${state.counters.batch}-${Date.now()}`;
      lines.forEach(line => {
        line.id = `${batchId}-${line.entityId}-${line.year}`;
        line.peerItem = {
          submissionLine: line.id,
          reference: line.selectionId,
          entityId: line.entityId, year: line.year, schemeId: line.schemeId,
          snapshot: line.snapshot,
        };
      });
      const batch = {
        id: batchId, filingReference, status: 'created', note: body.note ?? null,
        createdBy: actor.id, createdAt: now(), lines, syncs: [],
      };
      state.batches[filingReference] = batch;
      const peerResult = await peerClient.submit(filingReference, lines.map(l => l.peerItem));
      if (peerResult.transportError) {
        batch.status = 'submitted_unverified';
        for (const line of lines) { line.status = 'unverified'; line.peerStatus = 'unknown'; line.lastCheckedAt = now(); }
        openReview('申报批次连接中断，需按原流水查明', { batchId, filingReference, lines: lines.map(l => l.id) });
        audit('filing.submit.disconnect', actor.id, { batchId, filingReference });
        store.save();
        return { warning: '连接中断，受理情况未明；禁止重复递交，请调用 sync 查明', batch };
      }
      if (peerResult.conflict) {
        batch.status = 'conflict';
        audit('filing.submit.conflict', actor.id, { batchId, filingReference });
        store.save();
        throw new DomainError(`受理台报告同键资料冲突：${JSON.stringify(peerResult.value)}`, 422);
      }
      if (!peerResult.ok) {
        batch.status = 'error';
        store.save();
        throw new DomainError(`受理台拒绝：${JSON.stringify(peerResult.value)}`, 502);
      }
      for (const [i, op] of peerResult.results.entries()) {
        lines[i].peerStatus = op.status;
        lines[i].peerRevision = op.revision;
        lines[i].lastCheckedAt = now();
        lines[i].status = op.status === 'rejected' ? 'rejected' : 'submitted';
      }
      batch.status = 'submitted';
      for (const line of lines) {
        const selection = state.selections[`${line.entityId}:${line.year}`];
        selection.status = 'filed';
        selection.versions.at(-1).status = 'filed';
      }
      audit('filing.submit', actor.id, { batchId, filingReference, duplicate: peerResult.duplicate });
      store.save();
      return { duplicate: peerResult.duplicate, batch };
    },

    syncBatch: async (actor, body, params) => {
      requireRole(actor, ['tax']);
      const batch = Object.values(state.batches).find(b => b.id === params.batchId);
      if (!batch) throw new DomainError('批次不存在', 404);
      const report = [];
      for (const line of batch.lines) {
        if (['confirmed', 'rejected', 'returned'].includes(line.peerStatus)) { report.push({ lineId: line.id, unchanged: true }); continue; }
        const resolved = await peerClient.resolve(line.id);
        line.lastCheckedAt = now();
        if (resolved.unknown) {
          report.push({ lineId: line.id, unknown: true, transportError: Boolean(resolved.transportError) });
          continue;
        }
        line.peerStatus = resolved.peerStatus;
        line.peerRevision = resolved.revision;
        line.peerDetails = resolved.details;
        const selection = state.selections[`${line.entityId}:${line.year}`];
        if (resolved.peerStatus === 'confirmed') {
          line.status = 'accepted';
          selection.status = 'accepted';
          selection.versions.at(-1).status = 'accepted';
          selection.versions.at(-1).acceptedAt = now();
        } else if (resolved.peerStatus === 'returned' || resolved.peerStatus === 'rejected') {
          line.status = resolved.peerStatus;
          selection.status = resolved.peerStatus;
          selection.versions.at(-1).status = resolved.peerStatus;
          openReview('主体年度被退补，可修订后重新申报', { batchId: batch.id, lineId: line.id, peerStatus: resolved.peerStatus });
          notify(line.entityId, 'filing_returned', { batchId: batch.id, lineId: line.id, peerStatus: resolved.peerStatus }, 'warning');
        }
        report.push({ lineId: line.id, peerStatus: resolved.peerStatus, terminal: resolved.terminal });
      }
      batch.syncs.push({ at: now(), by: actor.id, report });
      const statuses = batch.lines.map(l => l.status);
      batch.status = statuses.every(s => s === 'accepted') ? 'accepted'
        : statuses.includes('unverified') || statuses.some(s => s === 'submitted') ? 'in_progress'
        : statuses.every(s => s === 'rejected' || s === 'returned') ? 'returned' : 'partially_accepted';
      audit('filing.sync', actor.id, { batchId: batch.id });
      store.save();
      return { batch, report };
    },

    createCorrection: (actor, body, params) => {
      requireRole(actor, ['tax']);
      const entityId = params.entityId;
      const year = yearText(params.year);
      const accepted = latestAcceptedSelection(state, entityId, year);
      if (!accepted) throw new DomainError('只有已受理确认的主体年度才能提出更正', 422);
      const pending = pendingFilingLine(state, entityId, year);
      if (pending) throw new DomainError(`存在未明批次 ${pending.batchId}，不能提出更正`, 422);
      const adjustments = body.allocationAdjustments ?? [];
      for (const adj of adjustments) {
        const allocation = requireRecord(state.allocations, adj.allocationId, '分摊');
        if (allocation.entityId !== entityId || allocation.year !== year) throw new DomainError(`分摊 ${adj.allocationId} 不属于该主体年度`, 422);
        if (!isPosInt(adj.amountMinor)) throw new DomainError('调整金额需为正整数（分）', 400);
        if (adj.amountMinor < allocation.amountMinor) {
          throw new DomainError('更正不能直接缩减已受理份额；退减应按退补流程处理', 422);
        }
        const invoice = requireRecord(state.invoices, allocation.invoiceId, '发票');
        if (invoice.year !== year) throw new DomainError('不能把其他年度的发票补进原期间', 422);
      }
      const supplements = body.evidenceSupplements ?? [];
      const registeredEvidence = [];
      for (const supp of supplements) {
        const invoice = requireRecord(state.invoices, supp.invoiceId, '发票');
        if (invoice.year !== year) throw new DomainError('不能把当前年度发票证据补进旧年度', 422);
        if (!EVIDENCE_KINDS.includes(supp.kind)) throw new DomainError('证据类型不符', 400);
        const id = nextId('EV', 'evidence');
        const doc = {
          id, invoiceId: invoice.id, kind: supp.kind, docRef: requireBody(supp, 'docRef'),
          proofRef: supp.proofRef ?? null, status: 'pending', registeredBy: actor.id,
          registeredAt: now(), occurredOn: supp.occurredOn ?? now(), history: [], correctionOrigin: true,
        };
        state.evidence[id] = doc;
        registeredEvidence.push(id);
      }
      if (body.targetSchemeId) {
        requireRecord(state.schemes, body.targetSchemeId, '方案');
        const availability = schemeAvailability(state, entityId, year, body.targetSchemeId);
        if (!availability.available) throw new DomainError(`目标方案当前不可用：${availability.reasons.join('；')}`, 422);
      }
      const id = nextId('CR', 'correction');
      const correction = {
        id, entityId, year, reason: requireBody(body, 'reason'),
        predecessorVersion: accepted.version.version,
        targetSchemeId: body.targetSchemeId ?? accepted.version.schemeId,
        allocationAdjustments: clone(adjustments),
        evidenceSupplements: registeredEvidence,
        status: 'proposed', createdBy: actor.id, createdAt: now(), confirmedBy: null, submittedAt: null,
      };
      state.corrections[id] = correction;
      if (registeredEvidence.length) openReview('更正证据待会计判断', { correctionId: id, evidenceIds: registeredEvidence });
      audit('correction.create', actor.id, { id, entityId, year });
      return correction;
    },

    confirmCorrection: (actor, body, params) => {
      requireRole(actor, ['tax']);
      const correction = requireRecord(state.corrections, params.correctionId, '更正');
      if (correction.status !== 'proposed') throw new DomainError(`更正状态为 ${correction.status}`, 422);
      notSelf(actor, correction.createdBy, '更正复核');
      // 按发票行分组：被替代的旧分摊先从占用中剔除，再比较新总额与净可用额。
      // 这保证“已用份额”不会与新提案重复计作本地开支。
      const groups = new Map();
      for (const adj of correction.allocationAdjustments) {
        const old = state.allocations[adj.allocationId];
        const key = `${old.invoiceId}:${old.lineId}`;
        if (!groups.has(key)) groups.set(key, { invoiceId: old.invoiceId, lineId: old.lineId, oldIds: [], newTotal: 0 });
        const group = groups.get(key);
        group.oldIds.push(old.id);
        group.newTotal += adj.amountMinor;
      }
      for (const group of groups.values()) {
        const invoice = requireRecord(state.invoices, group.invoiceId, '发票');
        const line = invoice.lines.find(l => l.id === group.lineId);
        const credited = creditedOnLine(state, invoice.id, line.id);
        const otherOccupied = activeAllocations(state)
          .filter(a => a.invoiceId === invoice.id && a.lineId === line.id && !group.oldIds.includes(a.id))
          .filter(a => a.status === 'proposed' || a.status === 'confirmed')
          .reduce((n, a) => n + a.amountMinor, 0);
        const capacity = line.amountMinor - credited - otherOccupied;
        if (group.newTotal > capacity) {
          throw new DomainError(`发票 ${invoice.id} 行 ${line.id} 替代后总额 ${group.newTotal} 超过可用额 ${capacity}`, 422);
        }
      }
      const availability = schemeAvailability(state, correction.entityId, correction.year, correction.targetSchemeId);
      if (!availability.available) throw new DomainError(`目标方案不可用：${availability.reasons.join('；')}`, 422);
      // 落调整：旧分摊 superseded，新分摊提案，需会计确认后才能递交。
      const newAllocations = [];
      for (const adj of correction.allocationAdjustments) {
        const old = state.allocations[adj.allocationId];
        old.status = 'superseded';
        old.supersededAt = now();
        const id = nextId('AL', 'allocation');
        const replacement = {
          id, invoiceId: old.invoiceId, lineId: old.lineId, activityId: old.activityId,
          entityId: old.entityId, year: old.year, amountMinor: adj.amountMinor,
          status: 'proposed', createdBy: actor.id, createdAt: now(),
          supersedes: old.id, correctionId: correction.id, history: [],
        };
        state.allocations[id] = replacement;
        newAllocations.push(id);
      }
      correction.newAllocations = newAllocations;
      correction.status = 'confirmed';
      correction.confirmedBy = actor.id;
      correction.confirmedAt = now();
      audit('correction.confirm', actor.id, { id: correction.id, newAllocations });
      return correction;
    },

    submitCorrection: async (actor, body, params) => {
      requireRole(actor, ['tax']);
      const correction = requireRecord(state.corrections, params.correctionId, '更正');
      if (correction.status !== 'confirmed') throw new DomainError('更正需先经独立复核确认', 422);
      for (const id of correction.newAllocations ?? []) {
        if (state.allocations[id].status !== 'confirmed') throw new DomainError(`更正产生的分摊 ${id} 尚未经会计确认`, 422);
      }
      const pendingDocs = correction.evidenceSupplements.filter(id => state.evidence[id].status === 'pending');
      if (pendingDocs.length) throw new DomainError(`补充证据仍未决：${pendingDocs.join('、')}，缺证项保持未决`, 422);
      const availability = schemeAvailability(state, correction.entityId, correction.year, correction.targetSchemeId);
      if (!availability.available) throw new DomainError(`目标方案不可用：${availability.reasons.join('；')}`, 422);
      const numbers = entityYearNumbers(state, correction.entityId, correction.year);
      const lineId = `${correction.id}-${correction.entityId}-${correction.year}`;
      const item = {
        submissionLine: lineId,
        reference: `correction:${correction.id}`,
        entityId: correction.entityId, year: correction.year,
        predecessorVersion: correction.predecessorVersion,
        targetSchemeId: correction.targetSchemeId,
        reason: correction.reason, snapshot: clone(numbers),
      };
      const filingReference = `CR-FR-${correction.id}`;
      const result = await peerClient.submit(filingReference, [item]);
      correction.submittedAt = now();
      if (result.transportError) {
        correction.status = 'submitted_unverified';
        correction.peerLineId = lineId;
        openReview('更正递交连接中断，需按原流水查明', { correctionId: correction.id, lineId });
        audit('correction.submit.disconnect', actor.id, { id: correction.id });
        store.save();
        return { warning: '连接中断，禁止重复递交，请用 sync-correction 查明', correction };
      }
      if (result.conflict || !result.ok) throw new DomainError(`受理台拒绝更正：${JSON.stringify(result.value)}`, 502);
      const op = result.results[0];
      correction.status = 'submitted';
      correction.peerLineId = lineId;
      correction.peerStatus = op.status;
      correction.peerRevision = op.revision;
      audit('correction.submit', actor.id, { id: correction.id, peerStatus: op.status });
      store.save();
      return correction;
    },

    syncCorrection: async (actor, body, params) => {
      requireRole(actor, ['tax']);
      const correction = requireRecord(state.corrections, params.correctionId, '更正');
      if (!correction.peerLineId) throw new DomainError('该更正尚未递交', 422);
      const resolved = await peerClient.resolve(correction.peerLineId);
      if (resolved.unknown) return { correction, resolved };
      correction.peerStatus = resolved.peerStatus;
      correction.peerRevision = resolved.revision;
      correction.peerDetails = resolved.details;
      if (resolved.peerStatus === 'confirmed') {
        const selection = state.selections[`${correction.entityId}:${correction.year}`];
        const numbers = entityYearNumbers(state, correction.entityId, correction.year);
        const version = {
          version: (selection.versions.at(-1)?.version ?? 0) + 1,
          schemeId: correction.targetSchemeId, status: 'accepted',
          correctionId: correction.id, predecessorVersion: correction.predecessorVersion,
          confirmedBy: actor.id, confirmedAt: now(),
          snapshot: {
            at: now(), numbers: clone(numbers), availability: clone(schemeAvailability(state, correction.entityId, correction.year, correction.targetSchemeId)),
            benefitEstimateMinor: applyRate(numbers.qualifiedLocalMinor, state.schemes[correction.targetSchemeId].rate),
            allocations: numbers.detail.map(d => ({ ...d })),
          },
        };
        selection.versions.push(version);
        selection.status = 'accepted';
        correction.status = 'accepted';
      } else if (['returned', 'rejected'].includes(resolved.peerStatus)) {
        correction.status = resolved.peerStatus;
        openReview('更正被退补，原受理版本仍然有效', { correctionId: correction.id });
        notify(correction.entityId, 'correction_returned', { correctionId: correction.id }, 'warning');
      }
      audit('correction.sync', actor.id, { id: correction.id, peerStatus: resolved.peerStatus });
      store.save();
      return { correction, resolved };
    },

    addSettlement: (actor, body, params) => {
      requireRole(actor, ['tax']);
      const entityId = params.entityId;
      const year = yearText(params.year);
      const accepted = latestAcceptedSelection(state, entityId, year);
      if (!accepted) throw new DomainError('尚无受理版本，不能登记结算事实', 422);
      const kind = requireBody(body, 'kind');
      if (!['payment', 'supplemental_tax', 'refund'].includes(kind)) throw new DomainError('结算类型需为 payment/supplemental_tax/refund', 400);
      if (!isPosInt(body.amountMinor)) throw new DomainError('结算金额需为正整数（分）', 400);
      const id = nextId('ST', 'settlement');
      const record = {
        id, entityId, year, kind, amountMinor: body.amountMinor,
        reference: requireBody(body, 'reference'), occurredOn: body.occurredOn ?? now(),
        acceptedVersion: accepted.version.version, note: body.note ?? null, registeredBy: actor.id, registeredAt: now(),
      };
      state.settlements[id] = record;
      // 明确：结算只是事实记录，不回写任何资格或证据字段。
      audit('settlement.register', actor.id, { id, entityId, year, kind });
      return record;
    },

    closeReview: (actor, body, params) => {
      requireRole(actor, ['accountant', 'tax']);
      const review = requireRecord(state.manualReviews, params.reviewId, '人工复核事项');
      review.status = 'closed';
      review.closedAt = now();
      review.closedBy = actor.id;
      audit('review.close', actor.id, { id: review.id });
      return review;
    },
  };

  // ---------- 视图 ----------
  const views = {
    entityYear: (actor, params, query) => {
      const entityId = params.entityId;
      const year = yearText(params.year);
      requireRecord(state.entities, entityId, '主体');
      const key = `${entityId}:${year}`;
      const selection = state.selections[key] ?? null;
      const numbers = entityYearNumbers(state, entityId, year);
      const schemes = Object.values(state.schemes).map(s => schemeAvailability(state, entityId, year, s.id));
      const filings = [];
      for (const batch of Object.values(state.batches)) {
        for (const line of batch.lines.filter(l => l.entityId === entityId && l.year === year)) {
          filings.push({ batchId: batch.id, filingReference: batch.filingReference, lineId: line.id, status: line.status, peerStatus: line.peerStatus, peerRevision: line.peerRevision, lastCheckedAt: line.lastCheckedAt });
        }
      }
      const settlements = Object.values(state.settlements).filter(s => s.entityId === entityId && s.year === year);
      const accepted = latestAcceptedSelection(state, entityId, year);
      const settledSigned = settlements.reduce((n, s) => n + (s.kind === 'refund' ? -s.amountMinor : s.amountMinor), 0);
      const openItems = Object.values(state.manualReviews).filter(r => r.status === 'open');
      return {
        entityId, year,
        activities: Object.values(state.activities).filter(a => a.entity === entityId && a.year === year),
        numbers,
        schemeAvailability: schemes,
        proposals: selection?.proposals ?? [],
        selection,
        filings,
        corrections: Object.values(state.corrections).filter(c => c.entityId === entityId && c.year === year),
        settlements,
        settlementDifferenceMinor: accepted ? settledSigned - accepted.version.snapshot.benefitEstimateMinor : null,
        openReviews: openItems,
        missingEvidenceGate: numbers.detail.filter(d => !d.qualified).map(d => ({ allocationId: d.allocationId, invoiceId: d.invoiceId, missing: d.missing })),
      };
    },

    invoice: (actor, params) => invoiceTrace(state, params.invoiceId),

    reconciliation: (actor, params, query) => {
      const year = yearText(query.get('year'));
      const entities = Object.values(state.entities);
      const perEntity = entities.map(entity => {
        const numbers = entityYearNumbers(state, entity.id, year);
        const accepted = latestAcceptedSelection(state, entity.id, year);
        const batchLines = Object.values(state.batches).flatMap(b =>
          b.lines.filter(l => l.entityId === entity.id && l.year === year).map(l => ({
            batchId: b.id, lineId: l.id, status: l.status, peerStatus: l.peerStatus,
          })));
        // 共享费用冲减：该主体被分摊发票上的信用票及其影响。
        const invoiceIds = new Set(numbers.detail.map(d => d.invoiceId));
        const offsets = [...invoiceIds].map(invoiceId => {
          const invoice = state.invoices[invoiceId];
          const creditNotes = Object.values(state.creditNotes).filter(c => c.invoiceId === invoiceId);
          return { invoiceId, supplierId: invoice.supplierId, creditNotes, view: invoice.lines.map(l => lineView(state, invoice, l)) };
        }).filter(o => o.creditNotes.length);
        const settlements = Object.values(state.settlements).filter(s => s.entityId === entity.id && s.year === year);
        return {
          entityId: entity.id, group: entity.group, covered: entity.covered,
          numbers,
          acceptedVersion: accepted ? accepted.version.version : null,
          acceptedScheme: accepted ? accepted.version.schemeId : null,
          filingLines: batchLines,
          creditOffsets: offsets,
          settlements,
          corrections: Object.values(state.corrections).filter(c => c.entityId === entity.id && c.year === year).map(c => ({ id: c.id, status: c.status, targetSchemeId: c.targetSchemeId })),
        };
      });
      return {
        year,
        generatedAt: now(),
        note: '本地核对视图：把共享费用冲减与逐主体受理/退补放在一起；金额为合成登记值，不构成法律结论。',
        entities: perEntity,
        openReviews: Object.values(state.manualReviews).filter(r => r.status === 'open'),
      };
    },
  };

  // ---------- 路由 ----------
  const routes = [
    ['GET', /^\/health$/, () => handlers.health()],
    ['POST', /^\/actors$/, (a, b, p) => handlers.createActor(a, b)],
    ['GET', /^\/actors$/, () => Object.values(state.actors)],
    ['POST', /^\/entities$/, (a, b) => handlers.createEntity(a, b)],
    ['GET', /^\/entities$/, () => Object.values(state.entities)],
    ['POST', /^\/activities$/, (a, b) => handlers.createActivity(a, b)],
    ['GET', /^\/activities$/, () => Object.values(state.activities)],
    ['POST', /^\/suppliers$/, (a, b) => handlers.createSupplier(a, b)],
    ['GET', /^\/suppliers$/, () => Object.values(state.suppliers)],
    ['POST', /^\/suppliers\/(?<supplierId>[^/]+)\/proofs$/, (a, b, p) => handlers.addSupplierProof(a, b, p)],
    ['POST', /^\/schemes$/, (a, b) => handlers.createScheme(a, b)],
    ['GET', /^\/schemes$/, () => Object.values(state.schemes)],
    ['GET', /^\/schemes\/(?<schemeId>[^/]+)\/availability$/, (a, b, p, url) => {
      const entityId = url.searchParams.get('entityId');
      const year = url.searchParams.get('year');
      if (!entityId || !year) throw new DomainError('查询需带 entityId 与 year', 400);
      return schemeAvailability(state, entityId, yearText(year), p.schemeId);
    }],
    ['POST', /^\/entities\/(?<entityId>[^/]+)\/invoices$/, (a, b, p) => handlers.createInvoice(a, b, p)],
    ['GET', /^\/invoices$/, () => Object.values(state.invoices)],
    ['GET', /^\/invoices\/(?<invoiceId>[^/]+)$/, (a, b, p) => views.invoice(a, p)],
    ['POST', /^\/invoices\/(?<invoiceId>[^/]+)\/credit-notes$/, (a, b, p) => handlers.addCreditNote(a, b, p)],
    ['POST', /^\/invoices\/(?<invoiceId>[^/]+)\/evidence$/, (a, b, p) => handlers.addEvidence(a, b, p)],
    ['POST', /^\/evidence\/(?<evidenceId>[^/]+)\/assessment$/, (a, b, p) => handlers.assessEvidence(a, b, p)],
    ['GET', /^\/evidence$/, () => Object.values(state.evidence)],
    ['POST', /^\/entities\/(?<entityId>[^/]+)\/allocations$/, (a, b, p) => handlers.createAllocation(a, b, p)],
    ['GET', /^\/allocations$/, (a, b, p, url) => {
      const entityId = url.searchParams.get('entityId');
      const year = url.searchParams.get('year');
      return Object.values(state.allocations).filter(x =>
        (!entityId || x.entityId === entityId) && (!year || x.year === String(year)));
    }],
    ['POST', /^\/allocations\/(?<allocationId>[^/]+)\/review$/, (a, b, p) => handlers.reviewAllocation(a, b, p)],
    ['POST', /^\/allocations\/(?<allocationId>[^/]+)\/adjustment$/, (a, b, p) => handlers.adjustAllocation(a, b, p)],
    ['POST', /^\/entities\/(?<entityId>[^/]+)\/years\/(?<year>[^/]+)\/proposals$/, (a, b, p) => handlers.proposeSelection(a, b, p)],
    ['GET', /^\/entities\/(?<entityId>[^/]+)\/years\/(?<year>[^/]+)$/, (a, b, p, url) => views.entityYear(a, p, url.searchParams)],
    ['POST', /^\/selections\/(?<selectionId>[^/]+)\/confirm$/, (a, b, p) => handlers.confirmSelection(a, b, p)],
    ['POST', /^\/selections\/(?<selectionId>[^/]+)\/revise$/, (a, b, p) => handlers.reviseSelection(a, b, p)],
    ['POST', /^\/selections\/(?<selectionId>[^/]+)\/reopen$/, (a, b, p) => handlers.reopenSelection(a, b, p)],
    ['POST', /^\/filings\/batches$/, (a, b) => handlers.createFilingBatch(a, b)],
    ['GET', /^\/filings\/batches$/, () => Object.values(state.batches).map(b => ({ id: b.id, filingReference: b.filingReference, status: b.status, createdAt: b.createdAt }))],
    ['GET', /^\/filings\/batches\/(?<batchId>[^/]+)$/, (a, b, p) => {
      const batch = Object.values(state.batches).find(x => x.id === p.batchId);
      if (!batch) throw new DomainError('批次不存在', 404);
      return batch;
    }],
    ['POST', /^\/filings\/batches\/(?<batchId>[^/]+)\/sync$/, (a, b, p) => handlers.syncBatch(a, b, p)],
    ['POST', /^\/entities\/(?<entityId>[^/]+)\/years\/(?<year>[^/]+)\/corrections$/, (a, b, p) => handlers.createCorrection(a, b, p)],
    ['GET', /^\/corrections$/, () => Object.values(state.corrections)],
    ['POST', /^\/corrections\/(?<correctionId>[^/]+)\/confirm$/, (a, b, p) => handlers.confirmCorrection(a, b, p)],
    ['POST', /^\/corrections\/(?<correctionId>[^/]+)\/submit$/, (a, b, p) => handlers.submitCorrection(a, b, p)],
    ['POST', /^\/corrections\/(?<correctionId>[^/]+)\/sync$/, (a, b, p) => handlers.syncCorrection(a, b, p)],
    ['POST', /^\/entities\/(?<entityId>[^/]+)\/years\/(?<year>[^/]+)\/settlements$/, (a, b, p) => handlers.addSettlement(a, b, p)],
    ['GET', /^\/settlements$/, () => Object.values(state.settlements)],
    ['GET', /^\/reconciliation$/, (a, b, p, url) => views.reconciliation(a, p, url.searchParams)],
    ['GET', /^\/notifications$/, (a, b, p, url) => {
      const entityId = url.searchParams.get('entityId');
      return Object.values(state.notifications).filter(n => !entityId || n.entityId === entityId);
    }],
    ['GET', /^\/manual-reviews$/, (a, b, p, url) => {
      const status = url.searchParams.get('status');
      return Object.values(state.manualReviews).filter(r => !status || r.status === status);
    }],
    ['POST', /^\/manual-reviews\/(?<reviewId>[^/]+)\/close$/, (a, b, p) => handlers.closeReview(a, b, p)],
    ['GET', /^\/audit$/, (a) => {
      if (a.role !== 'tax') throw new DomainError('仅集团税务可查审计轨迹', 403);
      return state.audit;
    }],
  ];

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 1024 * 1024) return send(res, 413, { error: '资料过大' });
      }
      let body = {};
      if (raw) {
        try { body = JSON.parse(raw); } catch { throw new DomainError('JSON 格式不符', 400); }
      }
      const isHealth = req.method === 'GET' && url.pathname === '/health';
      const actor = isHealth ? null : authenticate(req);
      for (const [method, pattern, handler] of routes) {
        if (method !== req.method) continue;
        const match = url.pathname.match(pattern);
        if (!match) continue;
        const result = await handler(actor, body, match.groups ?? {}, url);
        store.save();
        return send(res, 200, result);
      }
      return send(res, 404, { error: '没有对应的接口' });
    } catch (error) {
      if (error instanceof DomainError) return send(res, error.status, { error: error.message });
      console.error(now(), error);
      return send(res, 500, { error: '服务内部错误' });
    }
  });
  return server;
}
