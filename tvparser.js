// Shared Tradovate stream parser. Loaded in two places:
//  1) the Tradovate page (via content script, MAIN world) for the WebSocket hook
//  2) the background service worker (importScripts) for Deep capture mode
// It has no DOM dependencies.
(function (root) {
  if (root.__awCreateTvParser) return;

  // onFill(payload)  -> called once per new execution, already classified
  // timers: { setTimeout } so the parser works in both page and worker contexts
  function createTvParser(onFill) {
    const contracts = new Map(); // contractId -> symbol (e.g. "NQZ6")
    const accounts = new Map();  // accountId  -> account name
    const orders = new Map();    // orderId    -> order entity
    const positions = new Map(); // "accountId:contractId" -> { qty, avg }
    const seenFills = new Set();
    // Tradovate can report one execution twice (a fill AND an executionReport).
    // Whichever arrives first is used; the other is matched and skipped.
    const unmatchedFromFill = new Map(); // "orderId|qty|price" -> count
    const unmatchedFromEr = new Map();
    const takeOne = (m, k) => { const n = m.get(k) || 0; if (n > 0) { m.set(k, n - 1); return true; } return false; };
    const addOne = (m, k) => m.set(k, (m.get(k) || 0) + 1);

    const stats = {
      sockets: {},          // host -> frames read
      tvFrames: 0,          // frames that looked like Tradovate's protocol
      entities: {},         // entityType -> count (props events)
      syncs: 0,             // sync/request responses harvested
      fills: 0,             // fills emitted
      lastFill: null,
      lastFrameAt: null
    };

    const posKey = (accountId, contractId) => `${accountId ?? '?'}:${contractId}`;

    function hostOf(url) {
      try { return new URL(url).hostname; } catch { return String(url).slice(0, 60); }
    }

    function envFromUrl(url) {
      const host = hostOf(url);
      if (/^live/i.test(host)) return 'LIVE';
      if (/^demo/i.test(host)) return 'DEMO';
      return 'UNKNOWN';
    }

    // ---- Cache harvesting ---------------------------------------------------
    function harvestOne(o) {
      if (!o || typeof o !== 'object' || o.id == null) return;
      if ('contractMaturityId' in o && o.name) contracts.set(o.id, o.name);
      if ('accountType' in o && o.name) accounts.set(o.id, o.name);
      if ('ordStatus' in o && 'accountId' in o) orders.set(o.id, o);
    }

    // Positions are seeded only from request/sync responses (true current state).
    function seedPosition(o) {
      if (o && typeof o === 'object' && 'netPos' in o && 'contractId' in o && 'accountId' in o) {
        const qty = Number(o.netPos) || 0;
        const avg = Number(o.netPrice);
        positions.set(posKey(o.accountId, o.contractId), {
          qty,
          avg: qty !== 0 && Number.isFinite(avg) && avg > 0 ? avg : null
        });
      }
    }

    function harvest(d) {
      stats.syncs++;
      const each = (o) => { harvestOne(o); seedPosition(o); };
      if (Array.isArray(d)) return d.forEach(each);
      if (d && typeof d === 'object') {
        each(d);
        for (const v of Object.values(d)) if (Array.isArray(v)) v.forEach(each);
      }
    }

    // ---- Entry / trim classification --------------------------------------
    function classifyFill(accountId, contractId, side, qty, price) {
      const key = posKey(accountId, contractId);
      const pos = positions.get(key) || { qty: 0, avg: null };
      const before = pos.qty;
      const delta = side === 'Buy' ? qty : -qty;
      const after = before + delta;

      if (before === 0 || Math.sign(before) === Math.sign(delta)) {
        const avg =
          before === 0 ? price
          : pos.avg == null ? null
          : (pos.avg * Math.abs(before) + price * qty) / Math.abs(after);
        positions.set(key, { qty: after, avg });
        return { alerts: [{ kind: 'entry', qty }], positionBefore: before, positionAfter: after };
      }

      const closeQty = Math.min(Math.abs(before), qty);
      const alerts = [{ kind: 'trim', qty: closeQty, avgEntry: pos.avg, closedSide: before > 0 ? 'LONG' : 'SHORT' }];
      if (qty > closeQty) alerts.push({ kind: 'entry', qty: qty - closeQty });
      positions.set(key, {
        qty: after,
        avg: after === 0 ? null : Math.sign(after) === Math.sign(before) ? pos.avg : price
      });
      return { alerts, positionBefore: before, positionAfter: after };
    }

    function resolveSymbol(contractId, cb, tries = 0) {
      if (contracts.has(contractId) || tries >= 12) {
        cb(contracts.get(contractId) || `contract#${contractId}`);
      } else {
        setTimeout(() => resolveSymbol(contractId, cb, tries + 1), 250);
      }
    }

    // f: { id, orderId, contractId, accountId?, action, qty, price, timestamp }
    function emitFill(f, socketUrl) {
      const id = String(f.id);
      if (f.id == null || seenFills.has(id)) return;
      seenFills.add(id);

      const order = orders.get(f.orderId);
      const accountId = order?.accountId ?? f.accountId ?? null;
      const qty = Number(f.qty) || 0;
      const price = Number(f.price);
      if (!(qty > 0) || !Number.isFinite(price) || (f.action !== 'Buy' && f.action !== 'Sell')) return;
      const cls = classifyFill(accountId, f.contractId, f.action, qty, price);

      stats.fills++;
      resolveSymbol(f.contractId, (symbol) => {
        const payload = {
          ...cls,
          fillId: id,
          orderId: f.orderId,
          symbol,
          contractId: f.contractId,
          side: f.action,
          price,
          qty,
          timestamp: typeof f.timestamp === 'string' ? f.timestamp : new Date().toISOString(),
          accountId,
          account: accountId != null ? accounts.get(accountId) || String(accountId) : 'Unknown',
          environment: envFromUrl(socketUrl)
        };
        stats.lastFill = `${payload.side} ${payload.qty} ${payload.symbol} @ ${payload.price}`;
        onFill(payload);
      });
    }

    // Fallback: some sessions report executions as executionReport entities.
    function handleExecutionReport(er, socketUrl) {
      const qty = Number(er.lastQty);
      const price = Number(er.lastPx);
      if (!(qty > 0) || !Number.isFinite(price)) return;
      if (er.execType && !/^(Trade|Fill|PartialFill)$/i.test(er.execType)) return;
      const key = `${er.orderId}|${qty}|${price}`;
      if (takeOne(unmatchedFromFill, key)) return; // already handled via its fill
      addOne(unmatchedFromEr, key);
      const order = orders.get(er.orderId);
      emitFill(
        {
          id: `er${er.id}`,
          orderId: er.orderId,
          contractId: er.contractId ?? order?.contractId,
          accountId: er.accountId ?? order?.accountId,
          action: er.action ?? order?.action,
          qty, price,
          timestamp: er.timestamp
        },
        socketUrl
      );
    }

    function handleProps(d, socketUrl) {
      if (Array.isArray(d)) return d.forEach((x) => handleProps(x, socketUrl));
      if (!d || !d.entity) return;
      stats.entities[d.entityType] = (stats.entities[d.entityType] || 0) + 1;
      harvestOne(d.entity);
      if (d.entityType === 'position') seedPosition(d.entity);
      if (d.eventType !== 'Created') return; // only NEW executions, never history
      if (d.entityType === 'fill') {
        const e = d.entity;
        const key = `${e.orderId}|${Number(e.qty)}|${Number(e.price)}`;
        if (takeOne(unmatchedFromEr, key)) return; // already handled via its executionReport
        addOne(unmatchedFromFill, key);
        emitFill(e, socketUrl);
      } else if (d.entityType === 'executionReport') {
        handleExecutionReport(d.entity, socketUrl);
      }
    }

    function handleText(raw, socketUrl) {
      if (typeof raw !== 'string' || !raw.length) return;
      let items;
      if (raw[0] === 'a') {
        try { items = JSON.parse(raw.slice(1)); } catch { return; }
      } else if (raw[0] === '[' || raw[0] === '{') {
        try { items = JSON.parse(raw); } catch { return; }
        if (!Array.isArray(items)) items = [items];
      } else {
        return; // "o", "h", "c[...]" control frames
      }
      if (!Array.isArray(items)) return;
      let looksTv = false;
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        if (item.e === 'props') { looksTv = true; handleProps(item.d, socketUrl); }
        else if ('s' in item && 'i' in item) { looksTv = true; if (item.d) harvest(item.d); }
      }
      if (looksTv) stats.tvFrames++;
    }

    // Accepts string, ArrayBuffer, typed array or Blob
    function handleRaw(data, socketUrl) {
      const host = hostOf(socketUrl);
      stats.sockets[host] = (stats.sockets[host] || 0) + 1;
      stats.lastFrameAt = Date.now();
      try {
        if (typeof data === 'string') return handleText(data, socketUrl);
        if (typeof Blob !== 'undefined' && data instanceof Blob) {
          return data.text().then((t) => handleText(t, socketUrl)).catch(() => {});
        }
        if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
          return handleText(new TextDecoder().decode(data), socketUrl);
        }
      } catch (_) { /* never let parsing break the page */ }
    }

    return { handleRaw, stats };
  }

  root.__awCreateTvParser = createTvParser;
})(typeof globalThis !== 'undefined' ? globalThis : self);
