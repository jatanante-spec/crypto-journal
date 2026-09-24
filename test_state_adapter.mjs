import { createClient } from '@supabase/supabase-js';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { createCryptoJournalStore } from './supabase_state_adapter.mjs';

const SUPABASE_URL = 'https://cvwdegezormxxhskojmf.supabase.co';
const rl = createInterface({ input, output });
const ask = async (question) => (await rl.question(question)).trim();

let client;
let user;
let beforeSettings;
let tradeSourceId;
let planSourceId;

function required(value, label) {
  if (!value) throw new Error(`${label} was left blank.`);
  return value;
}

function pass(message) {
  console.log(`PASS: ${message}`);
}

function check(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
  pass(message);
}

async function restore() {
  if (!client || !user) return;

  if (tradeSourceId) {
    const result = await client
      .from('journal_trades')
      .delete()
      .eq('user_id', user.id)
      .eq('source_id', tradeSourceId);
    if (result.error) console.log(`CLEANUP WARNING (Journal): ${result.error.message}`);
  }

  if (planSourceId) {
    const result = await client
      .from('saved_plans')
      .delete()
      .eq('user_id', user.id)
      .eq('source_id', planSourceId);
    if (result.error) console.log(`CLEANUP WARNING (Saved Plan): ${result.error.message}`);
  }

  if (beforeSettings) {
    const result = await client
      .from('user_settings')
      .update({
        settings: beforeSettings.settings,
        legacy_state: beforeSettings.legacy_state,
        state_version: beforeSettings.state_version,
        app_state_updated_at: beforeSettings.app_state_updated_at
      })
      .eq('user_id', user.id);
    if (result.error) console.log(`CLEANUP WARNING (settings): ${result.error.message}`);
  }

  console.log('Temporary adapter rows removed and original user settings restored.');
}

try {
  console.log('Crypto Journal Supabase state-adapter round-trip test');
  console.log(`Project: ${SUPABASE_URL}`);
  console.log('Use the project publishable/anon key only. Never use a secret or service-role key.');

  const anonKey = required(await ask('Paste the project publishable/anon key: '), 'The publishable/anon key');
  const email = required(await ask('Development test user email: '), 'The test user email');
  const password = required(await ask('Development test user password: '), 'The test user password');

  client = createClient(SUPABASE_URL, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const signedIn = await client.auth.signInWithPassword({ email, password });
  if (signedIn.error) throw new Error(`Sign-in failed: ${signedIn.error.message}`);
  user = signedIn.data.user;
  if (!user) throw new Error('Sign-in returned no user.');

  const existing = await client
    .from('user_settings')
    .select('user_id,settings,legacy_state,state_version,app_state_updated_at')
    .eq('user_id', user.id)
    .single();
  if (existing.error) throw new Error(`Could not snapshot user_settings: ${existing.error.message}`);
  beforeSettings = existing.data;

  const store = createCryptoJournalStore(client, user.id);
  const before = await store.loadJournalState();
  pass('Adapter can load the current user state through RLS');

  const stamp = Date.now();
  tradeSourceId = `adapter-test-trade-${stamp}`;
  planSourceId = `adapter-test-plan-${stamp}`;

  const payload = {
    updatedAt: new Date().toISOString(),
    settings: before.settings,
    legacyState: beforeSettings.legacy_state,
    sizer: before.sizer,
    market: before.market,
    closes: before.closes,
    hourly: before.hourly,
    hourlyVolumes: before.hourlyVolumes,
    hourlyAts: before.hourlyAts,
    books: before.books,
    deleted: before.deleted,
    trades: [{
      id: tradeSourceId,
      date: '2026-09-24',
      coin: 'ADAPTER-TEST',
      side: 'Buy',
      entry: 1.234,
      stop: 1.111,
      target: 1.456,
      sizeGbp: 10,
      units: 8.1,
      exit: null,
      feeKind: 'Taker',
      followedStop: 'Yes',
      notes: 'Temporary adapter test',
      setup: 'Adapter test',
      gateStamp: { source: 'temporary-test' },
      volEvidenceLabel: 'Unknown · temporary test',
      volumeEvidence: { ratio: null, advisoryOnly: true },
      decision1: { preserved: true }
    }],
    plans: [{
      id: planSourceId,
      coin: 'ADAPTER-TEST',
      coinId: 'adapter-test',
      vsCurrency: 'gbp',
      setup: 'Adapter test',
      status: 'WATCHING',
      entry: 1.234,
      stop: 1.111,
      target: 1.456,
      note: 'Temporary adapter test',
      snapshot: { evidence: 'preserved' },
      customFutureField: { mustSurvive: true }
    }]
  };

  await store.saveJournalState(payload);
  pass('Adapter can save normalized rows and complete raw payloads');

  const after = await store.loadJournalState();
  const savedTrade = after.trades.find((trade) => trade.id === tradeSourceId);
  const savedPlan = after.plans.find((plan) => plan.id === planSourceId);

  check(savedTrade?.volumeEvidence?.advisoryOnly === true, 'Journal raw payload fields survive the round trip');
  check(savedTrade?.decision1?.preserved === true, 'Journal decision evidence survives the round trip');
  check(savedPlan?.customFutureField?.mustSurvive === true, 'Saved Plan unknown fields survive the round trip');
} finally {
  await restore();
  rl.close();
}
