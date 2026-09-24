import { createClient } from '@supabase/supabase-js';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const SUPABASE_URL = 'https://cvwdegezormxxhskojmf.supabase.co';
const rl = createInterface({ input, output });
const ask = async (question) => (await rl.question(question)).trim();

let client;
let user;
let before;
let changed = false;

function required(value, label) {
  if (!value) throw new Error(`${label} was left blank.`);
  return value;
}

function pass(message) {
  console.log(`PASS: ${message}`);
}

async function restoreOriginal() {
  if (!client || !user || !before || !changed) return;
  const { error } = await client
    .from('user_settings')
    .update({
      legacy_state: before.legacy_state || {},
      state_version: before.state_version || 1,
      app_state_updated_at: before.app_state_updated_at || null
    })
    .eq('user_id', user.id);
  if (error) console.log(`CLEANUP WARNING: ${error.message}`);
  else console.log('Temporary parity marker removed and original values restored.');
}

try {
  console.log('Crypto Journal full-parity column test');
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

  const loaded = await client
    .from('user_settings')
    .select('user_id,settings,legacy_state,state_version,app_state_updated_at,updated_at')
    .eq('user_id', user.id)
    .single();
  if (loaded.error) throw new Error(`Could not read user_settings: ${loaded.error.message}`);
  before = loaded.data;
  pass('Authenticated user can read the full-parity columns through RLS');

  const marker = `full-parity-test-${Date.now()}`;
  const nextLegacyState = {
    ...(before.legacy_state || {}),
    __temporary_parity_test_marker: marker
  };

  const written = await client
    .from('user_settings')
    .update({
      legacy_state: nextLegacyState,
      state_version: Number(before.state_version || 1),
      app_state_updated_at: new Date().toISOString()
    })
    .eq('user_id', user.id)
    .select('legacy_state,state_version,app_state_updated_at')
    .single();
  if (written.error) throw new Error(`Could not write legacy_state: ${written.error.message}`);
  changed = true;
  if (written.data.legacy_state?.__temporary_parity_test_marker !== marker) {
    throw new Error('The temporary parity marker was not returned after writing.');
  }
  pass('Authenticated user can write and read legacy_state through RLS');
} finally {
  await restoreOriginal();
  rl.close();
}
