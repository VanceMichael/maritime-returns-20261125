// 受理台客户端：封装 support/peer.mjs 的协议。
// - 提交使用稳定键 Filing-Reference；网络断开不代表未受理，必须回查原流水。
// - 相同键重放返回 200，冲突返回 409，本客户端只做透传与状态归并。
const TERMINAL = new Set(['confirmed', 'rejected', 'returned']);

export class PeerClient {
  constructor(baseUrl, keyHeader, group, lineIdField) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.keyHeader = keyHeader;       // Filing-Reference
    this.group = group;               // returns
    this.lineIdField = lineIdField;   // submissionLine
  }

  async request(path, options = {}) {
    let response;
    try {
      response = await fetch(this.baseUrl + path, {
        ...options,
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      // 断线、超时：调用方需按原编号回查，不能当成未受理重发新方案。
      return { transportError: true, error: error.message };
    }
    let value = null;
    const text = await response.text();
    try { value = text ? JSON.parse(text) : null; } catch { value = { raw: text }; }
    return { transportError: false, httpStatus: response.status, value };
  }

  // 提交一批；返回 { ok, duplicate, conflict, transportError, results }
  async submit(filingReference, items) {
    const result = await this.request('/returns/submissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [this.keyHeader]: filingReference },
      body: JSON.stringify({ [this.group]: items }),
    });
    if (result.transportError) return { transportError: true };
    if (result.httpStatus === 202 || result.httpStatus === 200) {
      return { ok: true, duplicate: result.httpStatus === 200, results: result.value.results };
    }
    if (result.httpStatus === 409) return { conflict: true, value: result.value };
    return { error: true, httpStatus: result.httpStatus, value: result.value };
  }

  async lookup(lineId) {
    return this.request('/returns/submissions/' + encodeURIComponent(lineId));
  }

  // 按原流水编号查明当前状态；查不到（404）与传输失败要区分开。
  async resolve(lineId) {
    const result = await this.lookup(lineId);
    if (result.transportError) return { unknown: true, transportError: true };
    if (result.httpStatus === 404) return { unknown: true };
    if (result.httpStatus !== 200) return { unknown: true, httpStatus: result.httpStatus };
    const op = result.value;
    return {
      unknown: false,
      peerStatus: op.status,
      terminal: TERMINAL.has(op.status),
      details: op.details ?? null,
      revision: op.revision,
      raw: op,
    };
  }
}
