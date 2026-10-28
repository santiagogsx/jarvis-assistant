// Brokerage connections: Alpaca (US stocks + crypto) and OANDA (forex).
// Practice/paper accounts by default. Orders are never sent by the AI:
// prepare() makes a ticket, and only the person tapping "Confirm order" in the
// app on the main computer calls confirm().
const crypto = require('crypto');

const ALPACA = { paper: 'https://paper-api.alpaca.markets', live: 'https://api.alpaca.markets', data: 'https://data.alpaca.markets' };
const OANDA = { practice: 'https://api-fxpractice.oanda.com', live: 'https://api-fxtrade.oanda.com' };
const CRYPTO = /^(BTC|ETH|SOL|DOGE|LTC|AVAX|LINK|DOT|SHIB|UNI|AAVE|BCH|XRP|USDC|USDT|XTZ|BAT|CRV|GRT|MKR|SUSHI|YFI)(\/?USD[CT]?)?$/i;

function createTrading(getSettings) {
  const tickets = new Map(); // id -> { ticket, created }

  function cfg(broker) {
    const s = getSettings();
    const t = s.trading || {};
    if (broker === 'alpaca') {
      if (!s.keys.alpacaKey || !s.keys.alpacaSecret) throw new Error('Alpaca is not connected. Add your Alpaca API key and secret in Settings → Trading.');
      const live = t.alpacaMode === 'live' && t.liveConfirmed;
      return { live, base: live ? ALPACA.live : ALPACA.paper, headers: { 'APCA-API-KEY-ID': s.keys.alpacaKey, 'APCA-API-SECRET-KEY': s.keys.alpacaSecret } };
    }
    if (broker === 'oanda') {
      if (!s.keys.oandaToken || !t.oandaAccount) throw new Error('OANDA is not connected. Add your OANDA token and account ID in Settings → Trading.');
      const live = t.oandaMode === 'live' && t.liveConfirmed;
      return { live, base: live ? OANDA.live : OANDA.practice, account: t.oandaAccount.trim(), headers: { authorization: `Bearer ${s.keys.oandaToken}` } };
    }
    throw new Error('Unknown broker. Use "alpaca" (stocks/crypto) or "oanda" (forex).');
  }

  async function call(url, headers, method = 'GET', body) {
    const r = await fetch(url, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
    const text = await r.text();
    let d = null;
    try { d = JSON.parse(text); } catch {}
    if (!r.ok) throw new Error(d?.message || d?.errorMessage || d?.rejectReason || `Broker error (HTTP ${r.status})`);
    return d;
  }

  const isCrypto = sym => CRYPTO.test(String(sym).replace('-', '/'));
  const alpacaSym = sym => {
    const s = String(sym).toUpperCase().replace('-', '/').trim();
    if (!isCrypto(s)) return s;
    return s.includes('/') ? s : s.replace(/USD[CT]?$/, '') + '/USD';
  };
  const oandaSym = sym => String(sym).toUpperCase().replace(/[/\- ]/g, '').replace(/^([A-Z]{3})([A-Z]{3})$/, '$1_$2');

  async function account(broker) {
    const c = cfg(broker);
    if (broker === 'alpaca') {
      const [a, pos, orders] = await Promise.all([
        call(c.base + '/v2/account', c.headers), call(c.base + '/v2/positions', c.headers), call(c.base + '/v2/orders?status=open&limit=20', c.headers),
      ]);
      return {
        broker: 'Alpaca', mode: c.live ? 'LIVE (real money)' : 'paper (practice)', equity: a.equity, cash: a.cash, buying_power: a.buying_power,
        positions: pos.map(p => ({ symbol: p.symbol, qty: p.qty, avg_price: p.avg_entry_price, price: p.current_price, unrealized_pl: p.unrealized_pl })),
        open_orders: orders.map(o => ({ symbol: o.symbol, side: o.side, qty: o.qty || o.notional, type: o.type, limit: o.limit_price, status: o.status })),
      };
    }
    const [sum, pos] = await Promise.all([
      call(`${c.base}/v3/accounts/${c.account}/summary`, c.headers), call(`${c.base}/v3/accounts/${c.account}/openPositions`, c.headers),
    ]);
    const a = sum.account;
    return {
      broker: 'OANDA', mode: c.live ? 'LIVE (real money)' : 'practice', currency: a.currency, balance: a.balance, nav: a.NAV, margin_available: a.marginAvailable, unrealized_pl: a.unrealizedPL,
      positions: pos.positions.map(p => ({ instrument: p.instrument, long_units: p.long.units, short_units: p.short.units, unrealized_pl: p.unrealizedPL })),
    };
  }

  async function quote(broker, symbol) {
    const c = cfg(broker);
    if (broker === 'alpaca') {
      const sym = alpacaSym(symbol);
      if (isCrypto(sym)) {
        const d = await call(`${ALPACA.data}/v1beta3/crypto/us/latest/quotes?symbols=${encodeURIComponent(sym)}`, c.headers);
        const q = d.quotes?.[sym];
        return { symbol: sym, bid: q?.bp, ask: q?.ap, time: q?.t };
      }
      const d = await call(`${ALPACA.data}/v2/stocks/${encodeURIComponent(sym)}/quotes/latest`, c.headers);
      return { symbol: sym, bid: d.quote?.bp, ask: d.quote?.ap, time: d.quote?.t };
    }
    const inst = oandaSym(symbol);
    const d = await call(`${c.base}/v3/accounts/${c.account}/pricing?instruments=${inst}`, c.headers);
    const p = d.prices?.[0];
    return { instrument: inst, bid: p?.bids?.[0]?.price, ask: p?.asks?.[0]?.price, time: p?.time };
  }

  // Build a ticket for the person to review. Nothing is sent to the broker here.
  async function prepare(a) {
    const broker = String(a.broker || '').toLowerCase();
    const c = cfg(broker);
    const side = String(a.side || '').toLowerCase();
    if (!['buy', 'sell'].includes(side)) throw new Error('Side must be buy or sell.');
    const type = String(a.order_type || 'market').toLowerCase();
    if (!['market', 'limit'].includes(type)) throw new Error('Order type must be market or limit.');
    if (type === 'limit' && !(Number(a.limit_price) > 0)) throw new Error('A limit order needs a limit price.');
    const qty = Number(a.quantity), usd = Number(a.amount_usd);
    if (!(qty > 0) && !(usd > 0)) throw new Error('Say how many (quantity) or how many dollars (amount_usd).');
    if (broker === 'oanda' && !(qty > 0)) throw new Error('For forex, give the number of units, e.g. 1000.');
    const symbol = broker === 'alpaca' ? alpacaSym(a.symbol) : oandaSym(a.symbol);
    let price = null;
    try { const q = await quote(broker, symbol); price = Number(side === 'buy' ? q.ask : q.bid) || null; } catch {}
    const ticket = {
      id: crypto.randomBytes(8).toString('hex'),
      broker, broker_name: broker === 'alpaca' ? 'Alpaca' : 'OANDA', live: c.live,
      symbol, side, type, quantity: qty > 0 ? qty : null, amount_usd: !(qty > 0) && usd > 0 ? usd : null,
      limit_price: type === 'limit' ? Number(a.limit_price) : null,
      stop_loss: Number(a.stop_loss) > 0 ? Number(a.stop_loss) : null,
      take_profit: Number(a.take_profit) > 0 ? Number(a.take_profit) : null,
      est_price: price,
      est_total: price && qty > 0 ? +(price * qty).toFixed(2) : usd > 0 ? usd : null,
    };
    tickets.set(ticket.id, { ticket, created: Date.now() });
    for (const [id, t] of tickets) if (Date.now() - t.created > 10 * 60000) tickets.delete(id);
    return ticket;
  }

  // Called only by the "Confirm order" button on the main computer.
  async function confirm(id) {
    const entry = tickets.get(id);
    if (!entry) throw new Error('This order ticket expired. Ask again to make a new one.');
    if (Date.now() - entry.created > 10 * 60000) { tickets.delete(id); throw new Error('This order ticket expired (10 minutes). Ask again.'); }
    tickets.delete(id); // a ticket can only ever be sent once
    const t = entry.ticket;
    const c = cfg(t.broker);
    if (c.live !== t.live) throw new Error('Paper/live mode changed since this ticket was made. Ask again.');
    if (t.broker === 'alpaca') {
      const crypto_ = isCrypto(t.symbol);
      const body = { symbol: t.symbol, side: t.side, type: t.type, time_in_force: crypto_ ? 'gtc' : 'day' };
      if (t.quantity) body.qty = String(t.quantity); else body.notional = String(t.amount_usd);
      if (t.limit_price) body.limit_price = String(t.limit_price);
      if ((t.stop_loss || t.take_profit) && !crypto_) {
        body.order_class = t.stop_loss && t.take_profit ? 'bracket' : 'oto';
        if (t.take_profit) body.take_profit = { limit_price: String(t.take_profit) };
        if (t.stop_loss) body.stop_loss = { stop_price: String(t.stop_loss) };
      }
      const o = await call(c.base + '/v2/orders', c.headers, 'POST', body);
      return { ok: true, broker: 'Alpaca', order_id: o.id, status: o.status, symbol: o.symbol, side: o.side };
    }
    const units = (t.side === 'sell' ? -1 : 1) * Math.round(t.quantity);
    const order = { type: t.type === 'limit' ? 'LIMIT' : 'MARKET', instrument: t.symbol, units: String(units), timeInForce: t.type === 'limit' ? 'GTC' : 'FOK', positionFill: 'DEFAULT' };
    if (t.limit_price) order.price = String(t.limit_price);
    if (t.stop_loss) order.stopLossOnFill = { price: String(t.stop_loss) };
    if (t.take_profit) order.takeProfitOnFill = { price: String(t.take_profit) };
    const r = await call(`${c.base}/v3/accounts/${c.account}/orders`, c.headers, 'POST', { order });
    if (r.orderCancelTransaction) throw new Error('OANDA cancelled the order: ' + r.orderCancelTransaction.reason);
    return { ok: true, broker: 'OANDA', order_id: r.orderCreateTransaction?.id, filled: !!r.orderFillTransaction };
  }

  return { account, quote, prepare, confirm };
}

module.exports = { createTrading };
