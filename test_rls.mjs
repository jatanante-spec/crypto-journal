import { createClient } from '@supabase/supabase-js';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const SUPABASE_URL = 'https://cvwdegezormxxhskojmf.supabase.co';

const rl = createInterface({ input, output });
const ask = async (question) => (await rl.question(question)).trim();

let clientA;
let clientB;
let userATradeId;
let userBTradeId;
let userAPlanId;

function requireValue(value, label) {
  if (!value) throw new Error(`${label} was left blank.`);
  return value;
}

async function signIn(client, label, email, password) {
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`${label} sign-in failed: ${error.message}`);
  if (!data.user) throw new Error(`${label} sign-in returned no user.`);
  console.log(`${label} signed in successfully.`);
  return data.user;
}

async function readById(client, table, id) {
  const { data, error } = await client
    .from(table)
    .select('id')
    .eq('id', id)
    .maybeSingle();

  if (error) throw new Error(`Reading ${table} failed: ${error.message}`);
  return data;
}

function pass(message) {
  console.log(`PASS: ${message}`);
}

function check(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
  pass(message);
}

try {
  console.log('Crypto Journal Row Level Security test');
  console.log(`Project: ${SUPABASE_URL}`);
  console.log('Use the project publishable/anon key only. Never use a secret or service-role key.');

  const anonKey = requireValue(
    await ask('Paste the project publishable/anon key: '),
    'The publishable/anon key'
  );
  const emailA = requireValue(await ask('Test user A email: '), 'Test user A email');
  const passwordA = requireValue(await ask('Test user A password: '), 'Test user A password');
  const emailB = requireValue(await ask('Test user B email: '), 'Test user B email');
  const passwordB = requireValue(await ask('Test user B password: '), 'Test user B password');

  clientA = createClient(SUPABASE_URL, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  clientB = createClient(SUPABASE_URL, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const userA = await signIn(clientA, 'User A', emailA, passwordA);
  const userB = await signIn(clientB, 'User B', emailB, passwordB);
  const stamp = Date.now();

  const { data: tradeA, error: tradeAError } = await clientA
    .from('journal_trades')
    .insert({
      user_id: userA.id,
      source_id: `rls-test-a-${stamp}`,
      coin: 'RLS-TEST-A',
      side: 'Buy',
      entry: 1,
      notes: 'Temporary RLS test row'
    })
    .select('id')
    .single();

  if (tradeAError) throw new Error(`User A Journal insert failed: ${tradeAError.message}`);
  userATradeId = tradeA.id;

  const { data: planA, error: planAError } = await clientA
    .from('saved_plans')
    .insert({
      user_id: userA.id,
      source_id: `rls-test-plan-a-${stamp}`,
      coin: 'RLS-TEST-A',
      status: 'TEST_ONLY',
      entry: 1,
      note: 'Temporary RLS test row'
    })
    .select('id')
    .single();

  if (planAError) throw new Error(`User A Saved Plan insert failed: ${planAError.message}`);
  userAPlanId = planA.id;

  check(
    (await readById(clientA, 'journal_trades', userATradeId))?.id === userATradeId,
    'User A can read User A Journal row'
  );

  check(
    (await readById(clientA, 'saved_plans', userAPlanId))?.id === userAPlanId,
    'User A can read User A Saved Plan'
  );

  check(
    (await readById(clientB, 'journal_trades', userATradeId)) === null,
    'User B cannot read User A Journal row'
  );

  check(
    (await readById(clientB, 'saved_plans', userAPlanId)) === null,
    'User B cannot read User A Saved Plan'
  );

  const { data: tradeB, error: tradeBError } = await clientB
    .from('journal_trades')
    .insert({
      user_id: userB.id,
      source_id: `rls-test-b-${stamp}`,
      coin: 'RLS-TEST-B',
      side: 'Buy',
      entry: 2,
      notes: 'Temporary RLS test row'
    })
    .select('id')
    .single();

  if (tradeBError) throw new Error(`User B Journal insert failed: ${tradeBError.message}`);
  userBTradeId = tradeB.id;

  check(
    (await readById(clientB, 'journal_trades', userBTradeId))?.id === userBTradeId,
    'User B can create and read User B Journal row'
  );

  check(
    (await readById(clientA, 'journal_trades', userBTradeId)) === null,
    'User A cannot read User B Journal row'
  );

  console.log('');
  console.log('RLS TEST PASSED. Temporary test rows will now be deleted.');
} finally {
  if (clientA && userAPlanId) {
    const { error } = await clientA.from('saved_plans').delete().eq('id', userAPlanId);
    if (error) console.log(`Cleanup warning for Saved Plan: ${error.message}`);
  }
  if (clientA && userATradeId) {
    const { error } = await clientA.from('journal_trades').delete().eq('id', userATradeId);
    if (error) console.log(`Cleanup warning for User A Journal row: ${error.message}`);
  }
  if (clientB && userBTradeId) {
    const { error } = await clientB.from('journal_trades').delete().eq('id', userBTradeId);
    if (error) console.log(`Cleanup warning for User B Journal row: ${error.message}`);
  }
  if (rl) rl.close();
}
