/* Crypto Journal · Supabase development runtime
 *
 * This file is injected only into the local development build. It supplies:
 *   - a small email/password Auth panel;
 *   - an authenticated REST client using the publishable/anon key;
 *   - a google.script.run-compatible persistence shim for the existing UI;
 *   - a development-only Supabase Edge Function bridge for the existing
 *     market-data methods; the function preserves the Apps Script provider
 *     fallbacks and validation semantics.
 *
 * It is not loaded by the production Apps Script application.
 */
(function () {
  'use strict';

  var PROJECT_URL = 'https://cvwdegezormxxhskojmf.supabase.co';
  var MARKET_FUNCTION_PATH = '/functions/v1/market-data';
  var KEY_STORAGE = 'crypto-journal-dev-supabase-anon-key-v1';
  var SESSION_STORAGE = 'crypto-journal-dev-supabase-session-v1';
  var ACTIVE_USER_STORAGE = 'crypto-journal-dev-active-user-v1';

  /*
   * This is the public browser key, not a secret. Configure it once here from
   * Supabase Project Settings → API. Never put a service_role key here.
   * Keeping it in the static frontend is normal for Supabase browser clients;
   * RLS and Auth protect the data. The local-storage fallback keeps older
   * development builds working until this file is updated.
   */
  var CONFIGURED_PUBLIC_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN2d2RlZ2V6b3JteHhoc2tvam1mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAxOTYzODIsImV4cCI6MjEwNTc3MjM4Mn0.5XKLt5zbmBs8_TZvToO0mO3qx4pk_uMgjVCnuu_109s';
  var session = loadJson(SESSION_STORAGE);
  var anonKey = CONFIGURED_PUBLIC_KEY || localStorage.getItem(KEY_STORAGE) || '';
  if (CONFIGURED_PUBLIC_KEY && localStorage.getItem(KEY_STORAGE) !== CONFIGURED_PUBLIC_KEY) {
    try { localStorage.setItem(KEY_STORAGE, CONFIGURED_PUBLIC_KEY); } catch (_) {}
  }

  // The original Apps Script UI uses device-local keys that are not user-scoped.
  // Clear account-owned local state when changing development accounts, but
  // deliberately preserve the device-only colour palette preference.
  var USER_LOCAL_KEYS = [
    'crypto-scalping-journal-v1',
    'crypto-scalping-journal-v1-coin-library-sync-v1',
    'crypto-scalping-journal-v1-trend-observations-t1',
    'crypto-scalping-journal-v1-continuation-c1',
    'pattern-compass-pc1',
    'candle-reader-cr1'
  ];

  function clearUserLocalData() {
    USER_LOCAL_KEYS.forEach(function (key) {
      try { localStorage.removeItem(key); } catch (_) {}
    });
  }

  function prepareUserLocalData(userId) {
    var previous = localStorage.getItem(ACTIVE_USER_STORAGE) || '';
    if (previous && previous !== userId) clearUserLocalData();
    if (userId) localStorage.setItem(ACTIVE_USER_STORAGE, userId);
  }

  function loadJson(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { return null; }
  }

  function saveJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

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
    var n = Number(value);
    return isFinite(n) ? n : null;
  }

  function nullableText(value) {
    return value === undefined || value === null || value === '' ? null : String(value);
  }

  function currentDate() {
    return new Date().toISOString().slice(0, 10);
  }

  function requireId(value, label) {
    var id = value === undefined || value === null ? '' : String(value);
    if (!id) throw new Error(label + ' is missing its current application id.');
    return id;
  }

  function apiError(body, fallback) {
    if (body && body.message) return body.message;
    if (body && body.msg) return body.msg;
    if (body && body.error_description) return body.error_description;
    if (body && body.error) return body.error;
    if (body && body.error_code) return body.error_code;
    if (typeof body === 'string' && body.trim()) return body.trim();
    return fallback || 'Supabase request failed.';
  }

  async function refreshSession() {
    if (!session || !session.refresh_token || !anonKey) return false;
    var response = await fetch(PROJECT_URL + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      headers: { apikey: anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: session.refresh_token })
    });
    var text = await response.text();
    var body = text ? JSON.parse(text) : null;
    if (!response.ok || !body || !body.access_token) return false;
    session = body;
    saveJson(SESSION_STORAGE, session);
    return true;
  }

  async function request(path, options, retried) {
    if (!anonKey) throw new Error('The development site has not been configured with its public Supabase key yet.');
    options = options || {};
    var headers = new Headers(options.headers || {});
    headers.set('apikey', anonKey);
    if (session && session.access_token) headers.set('Authorization', 'Bearer ' + session.access_token);
    if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

    var response = await fetch(PROJECT_URL + path, Object.assign({}, options, { headers: headers }));
    var text = await response.text();
    var body = null;
    try { body = text ? JSON.parse(text) : null; } catch (_) { body = text; }

    if (response.status === 401 && !retried && await refreshSession()) {
      return request(path, options, true);
    }
    if (!response.ok) throw new Error(response.status + ': ' + apiError(body, response.statusText));
    return body;
  }

  async function signIn(email, password) {
    if (!anonKey) throw new Error('The development site has not been configured with its public Supabase key yet.');
    var response = await fetch(PROJECT_URL + '/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: { apikey: anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, password: password })
    });
    var text = await response.text();
    var body = null;
    try { body = text ? JSON.parse(text) : null; } catch (_) { body = text; }
    if (!response.ok || !body || !body.access_token) {
      throw new Error(apiError(body, 'Supabase sign-in failed (HTTP ' + response.status + ').'));
    }
    prepareUserLocalData(body.user && body.user.id);
    session = body;
    saveJson(SESSION_STORAGE, session);
    localStorage.setItem(KEY_STORAGE, anonKey);
  }

  async function signUp(email, password) {
    if (!anonKey) throw new Error('The development site has not been configured with its public Supabase key yet.');
    var response = await fetch(PROJECT_URL + '/auth/v1/signup', {
      method: 'POST',
      headers: { apikey: anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, password: password })
    });
    var text = await response.text();
    var body = null;
    try { body = text ? JSON.parse(text) : null; } catch (_) { body = text; }
    if (!response.ok || !body || !body.user) {
      throw new Error(apiError(body, 'Supabase account creation failed (HTTP ' + response.status + ').'));
    }

    // If email confirmation is disabled, Supabase returns a session and the
    // new user can enter the app immediately. Otherwise ask them to confirm
    // the email and then use the normal Sign in button.
    if (body.access_token) {
      prepareUserLocalData(body.user.id);
      session = body;
      saveJson(SESSION_STORAGE, session);
      localStorage.setItem(KEY_STORAGE, anonKey);
      return { signedIn: true };
    }
    return { signedIn: false, confirmationRequired: true };
  }

  async function signOut() {
    try {
      if (session && session.access_token) {
        await request('/auth/v1/logout', { method: 'POST' });
      }
    } catch (_) {}
    clearUserLocalData();
    localStorage.removeItem(ACTIVE_USER_STORAGE);
    session = null;
    localStorage.removeItem(SESSION_STORAGE);
    window.location.reload();
  }

  function currentUserId() {
    if (!session || !session.user || !session.user.id) {
      throw new Error('Sign in before loading or saving Supabase data.');
    }
    return session.user.id;
  }

  function eq(value) {
    return encodeURIComponent('eq.' + String(value));
  }

  function inOrder(value) {
    return encodeURIComponent(value);
  }

  function tradeToRow(trade, userId) {
    return {
      user_id: userId,
      source_id: requireId(trade && trade.id, 'Journal trade'),
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
    return {
      user_id: userId,
      source_id: requireId(plan && plan.id, 'Saved Plan'),
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
      linked_trade_id: null,
      converted_at: nullableText(plan.convertedAt),
      raw_data: clone(plan)
    };
  }

  function tradeFromRow(row) {
    var out = objectOrEmpty(clone(row.raw_data));
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
    var out = objectOrEmpty(clone(row.raw_data));
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

  var TRADE_DELETED_KEEP = 500;

  function tradeDeletedMap(raw) {
    var out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    Object.keys(raw).slice(-TRADE_DELETED_KEEP).forEach(function (id) {
      var key = String(id).slice(0, 120);
      if (!key || key === '__n') return;
      var value = raw[id];
      out[key] = { at: value && value.at ? String(value.at).slice(0, 40) : '' };
    });
    return out;
  }

  function mergeDeletedTrades(a, b) {
    var out = tradeDeletedMap(a), right = tradeDeletedMap(b);
    Object.keys(right).forEach(function (id) { out[id] = right[id]; });
    var ids = Object.keys(out);
    if (ids.length > TRADE_DELETED_KEEP) {
      ids.sort(function (x, y) { return String(out[y].at || '').localeCompare(String(out[x].at || '')); });
      var keep = {};
      ids.slice(0, TRADE_DELETED_KEEP).forEach(function (id) { keep[id] = out[id]; });
      out = keep;
    }
    return out;
  }

  var PLAN_DELETED_KEEP = 500;

  function planDeletedMap(raw) {
    var out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    Object.keys(raw).slice(-PLAN_DELETED_KEEP).forEach(function (id) {
      var key = String(id).slice(0, 120);
      if (!key || key === '__n') return;
      var value = raw[id];
      out[key] = { at: value && value.at ? String(value.at).slice(0, 40) : '' };
    });
    return out;
  }

  function mergeDeletedPlans(a, b) {
    var out = planDeletedMap(a), right = planDeletedMap(b);
    Object.keys(right).forEach(function (id) { out[id] = right[id]; });
    var ids = Object.keys(out);
    if (ids.length > PLAN_DELETED_KEEP) {
      ids.sort(function (x, y) { return String(out[y].at || '').localeCompare(String(out[x].at || '')); });
      var keep = {};
      ids.slice(0, PLAN_DELETED_KEEP).forEach(function (id) { keep[id] = out[id]; });
      out = keep;
    }
    return out;
  }

  function dropDeletedPlanRows(plans, deletedPlans) {
    var map = planDeletedMap(deletedPlans);
    return arrayOrEmpty(plans).filter(function (plan) {
      return plan && !Object.prototype.hasOwnProperty.call(map, String(plan.id));
    });
  }

  function coinToRow(coin, userId) {
    var ticker = String(coin.ticker || '').toUpperCase();
    if (!ticker) throw new Error('A coin-library row is missing ticker.');
    return {
      user_id: userId,
      ticker: ticker,
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
    var raw = objectOrEmpty(clone(row.raw_data));
    return Object.assign(raw, {
      ticker: String(raw.ticker || row.ticker).toUpperCase(),
      id: raw.id || row.coin_id || '',
      name: raw.name || row.name || row.ticker,
      sample: raw.sample == null ? row.sample_price : raw.sample,
      vs: raw.vs || row.vs_currency || 'gbp',
      favourite: raw.favourite == null ? Boolean(row.is_favourite) : Boolean(raw.favourite)
    });
  }

  function legacyFromPayload(payload) {
    return Object.assign({}, clone(objectOrEmpty(payload.legacyState)), {
      stateVersion: 1,
      sizer: clone(payload.sizer || {}),
      market: clone(payload.market || {}),
      closes: clone(arrayOrEmpty(payload.closes)),
      hourly: clone(arrayOrEmpty(payload.hourly)),
      hourlyVolumes: clone(arrayOrEmpty(payload.hourlyVolumes)),
      hourlyAts: clone(arrayOrEmpty(payload.hourlyAts)),
      books: clone(objectOrEmpty(payload.books)),
      deleted: clone(objectOrEmpty(payload.deleted)),
      deletedPlans: clone(objectOrEmpty(payload.deletedPlans))
    });
  }

  async function loadJournalState() {
    var userId = currentUserId();
    var results = await Promise.all([
      request('/rest/v1/user_settings?select=user_id,settings,legacy_state,state_version,app_state_updated_at,updated_at&user_id=' + eq(userId)),
      request('/rest/v1/journal_trades?select=*&user_id=' + eq(userId) + '&order=' + inOrder('created_at.asc')),
      request('/rest/v1/saved_plans?select=*&user_id=' + eq(userId) + '&order=' + inOrder('created_at.asc'))
    ]);
    var settings = results[0] && results[0][0] ? results[0][0] : {};
    var legacy = objectOrEmpty(settings.legacy_state),deletedPlans=planDeletedMap(legacy.deletedPlans),deletedTrades=tradeDeletedMap(legacy.deleted);
    return {
      updatedAt: settings.app_state_updated_at || null,
      settings: clone(objectOrEmpty(settings.settings)),
      sizer: clone(objectOrEmpty(legacy.sizer)),
      market: clone(objectOrEmpty(legacy.market)),
      trades: arrayOrEmpty(results[1]).map(tradeFromRow).filter(function (trade) { return !deletedTrades[String(trade.id)]; }),
      plans: dropDeletedPlanRows(arrayOrEmpty(results[2]).map(planFromRow),deletedPlans),
      deletedPlans: deletedPlans,
      closes: clone(arrayOrEmpty(legacy.closes)),
      hourly: clone(arrayOrEmpty(legacy.hourly)),
      hourlyVolumes: clone(arrayOrEmpty(legacy.hourlyVolumes)),
      hourlyAts: clone(arrayOrEmpty(legacy.hourlyAts)),
      books: clone(objectOrEmpty(legacy.books)),
      deleted: clone(objectOrEmpty(legacy.deleted))
    };
  }

  async function saveJournalState(payload) {
    var userId = currentUserId();
    payload = payload || {};
    var existingSettings = await request('/rest/v1/user_settings?select=legacy_state&user_id=' + eq(userId));
    var existingLegacy = existingSettings && existingSettings[0] ? objectOrEmpty(existingSettings[0].legacy_state) : {};
    // Trade tombstones must be merged server-side. A stale tab/device must
    // never be able to write an empty deleted map and resurrect a Journal row.
    var deletedTrades = mergeDeletedTrades(existingLegacy.deleted, payload.deleted);
    var deletedPlans = mergeDeletedPlans(existingLegacy.deletedPlans, payload.deletedPlans);
    var safePayload = Object.assign({}, payload, { deleted: deletedTrades, deletedPlans: deletedPlans });

    await request('/rest/v1/user_settings?on_conflict=user_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({
        user_id: userId,
        settings: clone(objectOrEmpty(safePayload.settings)),
        legacy_state: legacyFromPayload(safePayload),
        state_version: 1,
        app_state_updated_at: safePayload.updatedAt || new Date().toISOString()
      })
    });

    var trades = arrayOrEmpty(safePayload.trades).filter(Boolean).map(function (trade) { return tradeToRow(trade, userId); });
    if (trades.length) {
      await request('/rest/v1/journal_trades?on_conflict=user_id,source_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(trades)
      });
    }

    var plans = dropDeletedPlanRows(safePayload.plans, deletedPlans).filter(Boolean).map(function (plan) { return planToRow(plan, userId); });
    if (plans.length) {
      await request('/rest/v1/saved_plans?on_conflict=user_id,source_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(plans)
      });
    }

    var deletedIds = Object.keys(planDeletedMap(deletedPlans));
    if (deletedIds.length) {
      await Promise.all(deletedIds.map(function (id) {
        return request('/rest/v1/saved_plans?user_id=' + eq(userId) + '&source_id=' + eq(id), {
          method: 'DELETE',
          headers: { Prefer: 'return=minimal' }
        });
      }));
    }

    // Journal deletion is separate from Saved Plan deletion. Only explicit
    // Journal tombstones reach this loop; linked trades are never touched by
    // deleting a Saved Plan.
    var deletedTradeIds = Object.keys(tradeDeletedMap(deletedTrades));
    if (deletedTradeIds.length) {
      await Promise.all(deletedTradeIds.map(function (id) {
        return request('/rest/v1/journal_trades?user_id=' + eq(userId) + '&source_id=' + eq(id), {
          method: 'DELETE',
          headers: { Prefer: 'return=minimal' }
        });
      }));
    }
    return { ok: true, updatedAt: safePayload.updatedAt || new Date().toISOString() };
  }

  async function deleteSavedPlan(sourceId) {
    var userId = currentUserId();
    var id = requireId(sourceId, 'Saved Plan');
    await request('/rest/v1/saved_plans?user_id=' + eq(userId) + '&source_id=' + eq(id), {
      method: 'DELETE',
      headers: { Prefer: 'return=minimal' }
    });
    return { ok: true, sourceId: id };
  }

  async function callMarketFunction(operation, args) {
    var body = await request(MARKET_FUNCTION_PATH, {
      method: 'POST',
      body: JSON.stringify({ operation: operation, args: args || [] })
    });
    if (!body || !body.ok) throw new Error(apiError(body, 'Market-data function failed.'));
    return body.result;
  }

  async function syncCoinLibrary(requestPayload) {
    var userId = currentUserId();
    requestPayload = requestPayload || {};
    var byTicker = {};
    arrayOrEmpty(requestPayload.seed).forEach(function (coin) { byTicker[String(coin.ticker || '').toUpperCase()] = coin; });
    arrayOrEmpty(requestPayload.operations).forEach(function (coin) { byTicker[String(coin.ticker || '').toUpperCase()] = coin; });
    var pending = Object.keys(byTicker).map(function (ticker) { return byTicker[ticker]; }).filter(function (coin) { return coin && coin.ticker; });

    if (pending.length) {
      await request('/rest/v1/coin_library?on_conflict=user_id,ticker', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(pending.map(function (coin) { return coinToRow(coin, userId); }))
      });
    }

    var rows = await request('/rest/v1/coin_library?select=*&user_id=' + eq(userId) + '&order=' + inOrder('created_at.asc'));
    return {
      version: 1,
      coins: arrayOrEmpty(rows).map(coinFromRow),
      ack: arrayOrEmpty(requestPayload.operations).map(function (operation) { return operation.token; }).filter(Boolean)
    };
  }

  async function dispatch(method, args) {
    if (method === 'loadJournalState') return loadJournalState();
    if (method === 'saveJournalState') return saveJournalState(args[0] || {});
    if (method === 'deleteSavedPlan') return deleteSavedPlan(args[0]);
    if (method === 'syncCoinLibrary') return syncCoinLibrary(args[0] || {});
    if (method === 'searchCoins' || method === 'peekLive' || method === 'fetchLive') {
      return callMarketFunction(method, args);
    }
    throw new Error('Unsupported development backend method: ' + method);
  }

  function makeRunner(config) {
    config = config || {};
    var target = {
      withSuccessHandler: function (handler) {
        return makeRunner(Object.assign({}, config, { success: handler }));
      },
      withFailureHandler: function (handler) {
        return makeRunner(Object.assign({}, config, { failure: handler }));
      }
    };
    return new Proxy(target, {
      get: function (object, property) {
        if (property in object) return object[property];
        return function () {
          var args = Array.prototype.slice.call(arguments);
          Promise.resolve().then(function () { return dispatch(property, args); }).then(function (value) {
            if (typeof config.success === 'function') config.success(value);
          }).catch(function (error) {
            if (typeof config.failure === 'function') config.failure({ message: error.message || String(error) });
            else console.error(error);
          });
        };
      }
    });
  }

  window.google = window.google || {};
  window.google.script = window.google.script || {};
  try {
    Object.defineProperty(window.google.script, 'run', {
      configurable: true,
      get: function () { return makeRunner({}); }
    });
  } catch (_) {
    window.google.script.run = makeRunner({});
  }

  function authUi() {
    var root = document.createElement('div');
    root.id = 'cj-supabase-dev-auth';
    root.innerHTML = '<style>' +
      '#cj-supabase-dev-auth{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(5,8,12,.88);font:15px/1.45 system-ui,sans-serif;color:#eef3f3}' +
      '#cj-supabase-dev-auth .cj-card{width:min(440px,100%);padding:24px;border:1px solid #3b4b50;border-radius:16px;background:#172024;box-shadow:0 20px 70px #0008}' +
      '#cj-supabase-dev-auth h2{margin:0 0 8px;font-size:22px}' +
      '#cj-supabase-dev-auth p{color:#abb9bc;margin:6px 0 14px}' +
      '#cj-supabase-dev-auth label{display:block;margin:12px 0 5px;color:#abb9bc;font-size:13px}' +
      '#cj-supabase-dev-auth input{display:block;width:100%;box-sizing:border-box;padding:10px;border:1px solid #405056;border-radius:8px;background:#0d1214;color:#eef3f3}' +
      '#cj-supabase-dev-auth .cj-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}' +
      '#cj-supabase-dev-auth button{padding:10px 14px;border:1px solid #32aa78;border-radius:8px;background:#4dd797;color:#06271a;font-weight:700;cursor:pointer}' +
      '#cj-supabase-dev-auth button.cj-secondary{border-color:#52706d;background:#203034;color:#d7eeea}' +
      '#cj-supabase-dev-auth .cj-status{min-height:23px;margin-top:12px;color:#f2c86d;white-space:pre-wrap}' +
      '#cj-supabase-dev-auth .cj-small{font-size:12px;color:#849497;margin-top:14px}' +
      '</style>' +
      '<div class="cj-card"><h2>Crypto Journal</h2>' +
      '<p>Sign in with your own Supabase account, or create one for this development Journal.</p>' +
      '<label>Email</label><input id="cj-sb-email" type="email" autocomplete="username" placeholder="you@example.com">' +
      '<label>Password</label><input id="cj-sb-password" type="password" autocomplete="current-password">' +
      '<div class="cj-actions"><button id="cj-sb-signin">Sign in</button><button id="cj-sb-signup" class="cj-secondary">Create account</button></div>' +
      '<div id="cj-sb-status" class="cj-status"></div>' +
      '<div class="cj-small">This development site uses the configured public Supabase key behind the scenes. It is safe for a browser client; never use a service-role key. Your Journal, Saved Plans and coin preferences remain separated by your Supabase account.</div></div>';
    document.body.appendChild(root);
    var emailInput = document.getElementById('cj-sb-email');
    var passwordInput = document.getElementById('cj-sb-password');
    var status = document.getElementById('cj-sb-status');

    async function authenticate(mode) {
      var email = emailInput.value.trim();
      var password = passwordInput.value;
      if (!anonKey) {
        status.textContent = 'The development site still needs its public Supabase key configured once in dev/supabase_runtime.js.';
        return;
      }
      if (!email || !password) {
        status.textContent = 'Enter your email and password.';
        return;
      }
      if (mode === 'signup' && password.length < 6) {
        status.textContent = 'Use a password of at least 6 characters.';
        return;
      }
      status.textContent = mode === 'signup' ? 'Creating account…' : 'Signing in…';
      try {
        if (mode === 'signup') {
          var result = await signUp(email, password);
          if (result.signedIn) {
            window.location.reload();
          } else {
            status.textContent = 'Account created. Check your email to confirm it, then use Sign in.';
          }
        } else {
          await signIn(email, password);
          window.location.reload();
        }
      } catch (error) {
        status.textContent = error.message || String(error);
      }
    }

    document.getElementById('cj-sb-signin').addEventListener('click', function () { authenticate('signin'); });
    document.getElementById('cj-sb-signup').addEventListener('click', function () { authenticate('signup'); });
    passwordInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') authenticate('signin');
    });
  }

  function showSignedInBadge() {
    var badge = document.createElement('button');
    badge.id = 'cj-supabase-dev-badge';
    badge.type = 'button';
    badge.setAttribute('aria-label', 'Open signed-in development account');
    badge.setAttribute('aria-expanded', 'false');
    badge.innerHTML = '<span class="cj-account-avatar">CT<i></i></span><span class="cj-account-label">Account</span>';
    badge.title = 'Signed in as ' + ((session && session.user && session.user.email) || 'development account');

    var detail = document.createElement('div');
    detail.id = 'cj-supabase-dev-account-detail';
    detail.hidden = true;
    detail.innerHTML = '<span class="cj-account-live-dot"></span><span class="cj-account-identity"><b>Signed in</b><small>' +
      escapeHtml((session && session.user && session.user.email) || 'development account') +
      ' · Supabase development</small></span><button type="button" class="cj-account-signout">Sign out</button>';

    var style = document.createElement('style');
    style.textContent =
      '#cj-supabase-dev-badge{display:inline-flex;align-items:center;justify-content:center;gap:5px;flex:0 0 auto;min-width:29px;height:27px;padding:3px 7px;border:1px solid #397a62;border-radius:999px;background:#143a30;color:#c5f5df;font:700 10px/1 system-ui,sans-serif;cursor:pointer;white-space:nowrap}' +
      '#cj-supabase-dev-badge:hover,#cj-supabase-dev-badge:focus-visible{border-color:#68d5a8;outline:2px solid #3d7dff;outline-offset:2px}' +
      '#cj-supabase-dev-badge .cj-account-avatar{position:relative;display:inline-grid;place-items:center;width:19px;height:19px;flex:0 0 19px!important;min-width:19px!important;border-radius:50%;background:#225e4c;color:#e1fff1;font-size:8px;letter-spacing:.02em;opacity:1!important;overflow:visible!important;white-space:normal!important}' +
      '#cj-supabase-dev-badge .cj-account-avatar i{position:absolute;right:-1px;bottom:0;width:6px;height:6px;border:1px solid #143a30;border-radius:50%;background:#54dfa1}' +
      '#cj-supabase-dev-badge .cj-account-label{flex:0 0 auto!important;min-width:auto!important;font-size:10px;opacity:1!important;overflow:visible!important;white-space:nowrap!important}' +
      '#cj-supabase-dev-account-detail{display:flex;align-items:center;gap:8px;flex:1 0 100%;order:99;min-width:0;margin:3px 0 0;padding:7px 9px;border:1px solid #2f6f5a;border-radius:9px;background:#102c27;color:#d1f8e5;font:11px/1.25 system-ui,sans-serif}' +
      '#cj-supabase-dev-account-detail .cj-account-live-dot{width:7px;height:7px;flex:0 0 7px!important;min-width:7px!important;border-radius:50%;background:#54dfa1;box-shadow:0 0 0 3px #1e4d3d;opacity:1!important}' +
      '#cj-supabase-dev-account-detail .cj-account-identity{flex:1 1 auto!important;min-width:0;display:block;overflow:hidden;opacity:1!important}' +
      '#cj-supabase-dev-account-detail .cj-account-identity b{display:block;font-size:11px}' +
      '#cj-supabase-dev-account-detail .cj-account-identity small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#9fd1bb;font-size:10px}' +
      '#cj-supabase-dev-account-detail .cj-account-signout{margin-left:auto;flex:0 0 auto;padding:5px 8px;border:1px solid #8d4858;border-radius:7px;background:#391b2a;color:#ffb5bf;font:600 10px system-ui,sans-serif;cursor:pointer}' +
      '@media(max-width:650px){#cj-supabase-dev-badge .cj-account-label{display:none}#cj-supabase-dev-account-detail{flex-basis:100%;padding:7px 8px}}';
    document.head.appendChild(style);

    var budget = document.getElementById('budget');
    var observer = budget && typeof MutationObserver !== 'undefined' ? new MutationObserver(mount) : null;
    var accountOpen = false;

    function escapeHtml(value) {
      return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
      });
    }
    function mount() {
      var bar = document.querySelector('#budget .budget-bar');
      if (!bar) return;
      bar.style.flexWrap = 'wrap';
      if (!bar.contains(badge)) bar.appendChild(badge);
      if (accountOpen) {
        detail.hidden = false;
        if (!bar.contains(detail)) bar.appendChild(detail);
      } else if (detail.parentNode) {
        detail.remove();
      }
    }
    function closeAccount() {
      accountOpen = false;
      badge.setAttribute('aria-expanded', 'false');
      detail.hidden = true;
      if (detail.parentNode) detail.remove();
    }
    badge.addEventListener('click', function () {
      accountOpen = !accountOpen;
      badge.setAttribute('aria-expanded', accountOpen ? 'true' : 'false');
      mount();
    });
    detail.querySelector('.cj-account-signout').addEventListener('click', function () {
      if (window.confirm('Sign out of the Supabase development account?')) signOut();
    });
    if (observer) observer.observe(budget, { childList: true });
    mount();
  }

  if (session && session.access_token && session.user) {
    prepareUserLocalData(session.user.id);
    showSignedInBadge();
  } else {
    authUi();
  }
})();
