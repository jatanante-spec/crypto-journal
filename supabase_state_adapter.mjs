/*
 * Crypto Journal · Supabase state adapter
 *
 * Development-only application layer. This file does not replace the existing
 * Apps Script backend and is not included by the production application yet.
 *
 * The adapter preserves the current client state shape:
 *   - user_settings.settings       -> state.settings
 *   - user_settings.legacy_state   -> sizer, market, books, candles, deleted
 *   - journal_trades.raw_data      -> complete current Journal object
 *   - saved_plans.raw_data         -> complete current Saved Plan object
 *   - coin_library                  -> independent coin-library sync
 *
 * Pass a Supabase JS client that is authenticated as the current user. The
 * client must use the publishable/anon key and the user's Auth session; never
 * use a service-role key in browser code.
 */

export const CRYPTO_JOURNAL_STATE_VERSION = 1;

function clone(value) {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value));
}

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function nullableNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function nullableText(value) {
  if (value === undefined || value === null || value === '') return null;
  return String(value);
}

function currentDate() {
  return new Date().toISOString().slice(0, 10);
}

function requireSourceId(value, label) {
  const id = value === undefined || value === null ? '' : String(value);
  if (!id) throw new Error(`${label} is missing its current application id.`);
  return id;
}

function tradeToRow(trade, userId) {
  const sourceId = requireSourceId(trade && trade.id, 'Journal trade');
  return {
    user_id: userId,
    source_id: sourceId,
    trade_date: trade.date || currentDate(),
    opened_at: nullableText(trade.openedAt),
    coin: String(trade.coin || '').toUpperCase() || 'UNKNOWN',
    side: String(trade.side || 'Buy'),
    entry: nullableNumber(trade.entry),
    stop: nullableNumber(trade.stop),
    target: nullableNumber(trade.target),
    size_gbp: nullableNumber(trade.sizeGbp),
    units: nullableNumber(trade.units),
    exit_price: nullableNumber(trade.exit),
    fee_kind: nullableText(trade.feeKind),
    followed_stop: nullableText(trade.followedStop),
    notes: nullableText(trade.notes),
    setup: nullableText(trade.setup),
    limit_kind: nullableText(trade.limitKind),
    stage: nullableText(trade.stage),
    gate_stamp: trade.gateStamp == null ? null : clone(trade.gateStamp),
    decision1: trade.decision1 == null ? null : clone(trade.decision1),
    raw_data: clone(trade)
  };
}

function planToRow(plan, userId) {
  const sourceId = requireSourceId(plan && plan.id, 'Saved Plan');
  return {
    user_id: userId,
    source_id: sourceId,
    coin: String(plan.coin || '').toUpperCase() || 'UNKNOWN',
    coin_id: nullableText(plan.coinId),
    vs_currency: String(plan.vsCurrency || 'gbp').toLowerCase(),
    setup: nullableText(plan.setup),
    status: String(plan.status || 'WATCHING').toUpperCase(),
    entry: nullableNumber(plan.entry),
    stop: nullableNumber(plan.stop),
    target: nullableNumber(plan.target),
    risk_gbp: nullableNumber(plan.riskGbp),
    reward_risk: nullableNumber(plan.rewardRisk),
    position_gbp: nullableNumber(plan.positionGbp),
    note: nullableText(plan.note),
    snapshot: plan.snapshot == null ? null : clone(plan.snapshot),
    // linkedTradeId is an application string id, not the database UUID. The
    // complete relationship remains losslessly available inside raw_data.
    linked_trade_id: null,
    converted_at: nullableText(plan.convertedAt),
    raw_data: clone(plan)
  };
}

function tradeFromRow(row) {
  const out = objectOrEmpty(clone(row.raw_data));
  if (!out.id) out.id = row.source_id || row.id;
  if (!out.date) out.date = row.trade_date;
  if (out.openedAt == null && row.opened_at != null) out.openedAt = row.opened_at;
  if (!out.coin) out.coin = row.coin;
  if (!out.side) out.side = row.side;
  if (out.entry == null) out.entry = row.entry;
  if (out.stop == null) out.stop = row.stop;
  if (out.target == null) out.target = row.target;
  if (out.sizeGbp == null) out.sizeGbp = row.size_gbp;
  if (out.units == null) out.units = row.units;
  if (out.exit == null) out.exit = row.exit_price;
  if (out.feeKind == null) out.feeKind = row.fee_kind;
  if (out.followedStop == null) out.followedStop = row.followed_stop;
  if (out.notes == null) out.notes = row.notes;
  if (out.setup == null) out.setup = row.setup;
  if (out.limitKind == null) out.limitKind = row.limit_kind;
  if (out.stage == null) out.stage = row.stage;
  if (out.gateStamp == null && row.gate_stamp != null) out.gateStamp = clone(row.gate_stamp);
  if (out.decision1 == null && row.decision1 != null) out.decision1 = clone(row.decision1);
  return out;
}

function planFromRow(row) {
  const out = objectOrEmpty(clone(row.raw_data));
  if (!out.id) out.id = row.source_id || row.id;
  if (!out.coin) out.coin = row.coin;
  if (!out.coinId) out.coinId = row.coin_id || '';
  if (!out.vsCurrency) out.vsCurrency = row.vs_currency || 'gbp';
  if (!out.setup && row.setup != null) out.setup = row.setup;
  if (!out.status) out.status = row.status || 'WATCHING';
  if (out.entry == null) out.entry = row.entry;
  if (out.stop == null) out.stop = row.stop;
  if (out.target == null) out.target = row.target;
  if (out.riskGbp == null) out.riskGbp = row.risk_gbp;
  if (out.rewardRisk == null) out.rewardRisk = row.reward_risk;
  if (out.positionGbp == null) out.positionGbp = row.position_gbp;
  if (out.note == null) out.note = row.note;
  if (out.snapshot == null && row.snapshot != null) out.snapshot = clone(row.snapshot);
  if (out.convertedAt == null && row.converted_at != null) out.convertedAt = row.converted_at;
  return out;
}

function coinToRow(coin, userId) {
  const ticker = String(coin.ticker || '').toUpperCase();
  if (!ticker) throw new Error('A coin-library row is missing ticker.');
  return {
    user_id: userId,
    ticker,
    coin_id: nullableText(coin.id || coin.coinId),
    vs_currency: String(coin.vs || coin.vsCurrency || 'gbp').toLowerCase(),
    name: nullableText(coin.name || ticker),
    sample_price: nullableNumber(coin.sample),
    is_favourite: Boolean(coin.favourite),
    is_archived: Boolean(coin.archived),
    raw_data: clone(coin)
  };
}

function coinFromRow(row) {
  const raw = objectOrEmpty(clone(row.raw_data));
  return Object.assign(raw, {
    ticker: String(raw.ticker || row.ticker).toUpperCase(),
    id: raw.id || row.coin_id || '',
    name: raw.name || row.name || row.ticker,
    sample: raw.sample == null ? row.sample_price : raw.sample,
    vs: raw.vs || row.vs_currency || 'gbp',
    favourite: raw.favourite == null ? Boolean(row.is_favourite) : Boolean(raw.favourite)
  });
}

function legacyStateFromPayload(payload) {
  // Preserve any future/unknown envelope fields supplied by a caller, then
  // replace the known fields with the current payload values.
  return Object.assign({}, clone(objectOrEmpty(payload.legacyState)), {
    stateVersion: CRYPTO_JOURNAL_STATE_VERSION,
    sizer: clone(payload.sizer || {}),
    market: clone(payload.market || {}),
    closes: clone(arrayOrEmpty(payload.closes)),
    hourly: clone(arrayOrEmpty(payload.hourly)),
    hourlyVolumes: clone(arrayOrEmpty(payload.hourlyVolumes)),
    hourlyAts: clone(arrayOrEmpty(payload.hourlyAts)),
    books: clone(objectOrEmpty(payload.books)),
    deleted: clone(objectOrEmpty(payload.deleted))
  });
}

function stateFromRows(settingsRow, tradeRows, planRows) {
  const settings = settingsRow || {};
  const legacy = objectOrEmpty(settings.legacy_state);
  return {
    updatedAt: settings.app_state_updated_at || null,
    settings: clone(objectOrEmpty(settings.settings)),
    sizer: clone(objectOrEmpty(legacy.sizer)),
    market: clone(objectOrEmpty(legacy.market)),
    trades: tradeRows.map(tradeFromRow),
    plans: planRows.map(planFromRow),
    closes: clone(arrayOrEmpty(legacy.closes)),
    hourly: clone(arrayOrEmpty(legacy.hourly)),
    hourlyVolumes: clone(arrayOrEmpty(legacy.hourlyVolumes)),
    hourlyAts: clone(arrayOrEmpty(legacy.hourlyAts)),
    books: clone(objectOrEmpty(legacy.books)),
    deleted: clone(objectOrEmpty(legacy.deleted))
  };
}

function throwIfError(result, label) {
  if (result && result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

/**
 * Create the persistence adapter for one authenticated user.
 *
 * @param {object} supabase An authenticated @supabase/supabase-js client.
 * @param {string} userId The id from the current Auth session.
 */
export function createCryptoJournalStore(supabase, userId) {
  if (!supabase || typeof supabase.from !== 'function') {
    throw new Error('A Supabase JS client is required.');
  }
  if (!userId) throw new Error('The authenticated user id is required.');

  async function loadJournalState() {
    const [settingsResult, tradesResult, plansResult] = await Promise.all([
      supabase
        .from('user_settings')
        .select('user_id,settings,legacy_state,state_version,app_state_updated_at,updated_at')
        .eq('user_id', userId)
        .maybeSingle(),
      supabase
        .from('journal_trades')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: true }),
      supabase
        .from('saved_plans')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: true })
    ]);

    const settings = throwIfError(settingsResult, 'Loading user settings');
    const trades = throwIfError(tradesResult, 'Loading Journal trades') || [];
    const plans = throwIfError(plansResult, 'Loading Saved Plans') || [];
    return stateFromRows(settings, trades, plans);
  }

  async function saveJournalState(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('A state payload is required.');

    const settingsResult = await supabase
      .from('user_settings')
      .upsert({
        user_id: userId,
        settings: clone(objectOrEmpty(payload.settings)),
        legacy_state: legacyStateFromPayload(payload),
        state_version: CRYPTO_JOURNAL_STATE_VERSION,
        app_state_updated_at: payload.updatedAt || new Date().toISOString()
      }, { onConflict: 'user_id' });
    throwIfError(settingsResult, 'Saving user settings');

    const trades = arrayOrEmpty(payload.trades).filter(Boolean).map((trade) => tradeToRow(trade, userId));
    if (trades.length) {
      const result = await supabase
        .from('journal_trades')
        .upsert(trades, { onConflict: 'user_id,source_id' });
      throwIfError(result, 'Saving Journal trades');
    }

    const plans = arrayOrEmpty(payload.plans).filter(Boolean).map((plan) => planToRow(plan, userId));
    if (plans.length) {
      const result = await supabase
        .from('saved_plans')
        .upsert(plans, { onConflict: 'user_id,source_id' });
      throwIfError(result, 'Saving Saved Plans');
    }

    return { ok: true, updatedAt: payload.updatedAt || new Date().toISOString() };
  }

  async function syncCoinLibrary(request = {}) {
    const operations = arrayOrEmpty(request.operations);
    const seed = arrayOrEmpty(request.seed);
    const rowsByTicker = new Map();

    for (const coin of seed) rowsByTicker.set(String(coin.ticker || '').toUpperCase(), coin);
    for (const operation of operations) rowsByTicker.set(String(operation.ticker || '').toUpperCase(), operation);

    const pending = Array.from(rowsByTicker.values()).filter((coin) => coin && coin.ticker);
    if (pending.length) {
      const result = await supabase
        .from('coin_library')
        .upsert(pending.map((coin) => coinToRow(coin, userId)), { onConflict: 'user_id,ticker' });
      throwIfError(result, 'Saving coin library');
    }

    const selected = await supabase
      .from('coin_library')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: true });
    const rows = throwIfError(selected, 'Loading coin library') || [];

    return {
      version: 1,
      coins: rows.map(coinFromRow),
      ack: operations.map((operation) => operation.token).filter(Boolean)
    };
  }

  return { loadJournalState, saveJournalState, syncCoinLibrary };
}
