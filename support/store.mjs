// 单文件 JSON 持久化：所有变更先改内存状态，再原子落盘（tmp + rename）。
// 与 support/peer.mjs 保持同一风格，不引入第三方依赖。
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function freshState() {
  return {
    // 主数据
    actors: {},       // 角色：bookkeeper 财务 / accountant 会计 / tax 集团税务
    entities: {},     // 法律主体
    activities: {},   // 业务线（交易）
    suppliers: {},    // 供应商（含证明变更历史，旧证明不删除）
    schemes: {},      // 合成优惠方案（阈值只来自登记，不推断法规）
    // 原始登记（不可就地修改）
    invoices: {},     // 发票及其行（费用来源），登记后不可改
    evidence: {},     // 三类证据：supplier_location / service_place / invoice_title
    creditNotes: {},  // 信用票、退款
    // 判断与选用
    allocations: {},  // 分摊（含版本历史）
    proposals: {},    // 年度选用提案（可按业务线提出）
    selections: {},   // 主体年度选用及其版本快照
    // 申报与后续
    batches: {},      // 申报批次及受理台逐行流水
    corrections: {},  // 更正申请
    settlements: {},  // 结算事实（不改变资格）
    notifications: {},// 影响通知
    manualReviews: {},// 人工复核事项
    audit: [],        // 审计轨迹
    counters: { batch: 0, version: 0, correction: 0, notification: 0, review: 0, audit: 0, settlement: 0 },
  };
}

export class Store {
  constructor(stateFile) {
    this.stateFile = stateFile;
    try {
      this.state = JSON.parse(readFileSync(stateFile, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.state = freshState();
    }
  }

  save() {
    mkdirSync(dirname(this.stateFile), { recursive: true });
    writeFileSync(this.stateFile + '.tmp', JSON.stringify(this.state));
    renameSync(this.stateFile + '.tmp', this.stateFile);
  }
}
