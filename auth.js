// Accounts, invites and portfolio sync through Supabase (see supabase/setup.sql and config.js).
// When config.js is empty, accounts are off and the app keeps the portfolio in the browser only.

import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm';
export const authEnabled = Boolean(SUPABASE_URL && SUPABASE_KEY);

let sb = null;
async function client() {
  if (!sb) {
    const { createClient } = await import(SDK_URL);
    sb = createClient(SUPABASE_URL, SUPABASE_KEY);
  }
  return sb;
}

// Where Supabase sends people back to after Google sign-in, email confirmation or a password reset.
const here = () => location.origin + location.pathname;

function check({ data, error }) {
  if (error) throw new Error(error.message || String(error));
  return data;
}

// Calls back with (event, session) now and on every sign-in, sign-out and password-recovery link.
export async function onAuthChange(callback) {
  const c = await client();
  // Supabase recommends not awaiting its own calls inside this callback, so hand off to a new task.
  c.auth.onAuthStateChange((event, session) => setTimeout(() => callback(event, session), 0));
}

export const signInWithGoogle = async () => check(await (await client()).auth.signInWithOAuth({ provider: 'google', options: { redirectTo: here() } }));
export const signInWithPassword = async (email, password) => check(await (await client()).auth.signInWithPassword({ email, password }));
export const sendPasswordReset = async (email) => check(await (await client()).auth.resetPasswordForEmail(email, { redirectTo: here() }));
export const setNewPassword = async (password) => check(await (await client()).auth.updateUser({ password }));
export const signOut = async () => check(await (await client()).auth.signOut());

// Returns 'signed-in', or 'confirm-email' when Supabase first wants the address confirmed.
export async function signUp(email, password) {
  const data = check(await (await client()).auth.signUp({ email, password, options: { emailRedirectTo: here() } }));
  return data.session ? 'signed-in' : 'confirm-email';
}

// ---------- invites ----------

// This user's own invite row ({ email, is_admin }), or null if they haven't been invited.
export async function myInvite(email) {
  return check(await (await client()).from('invites').select('email, is_admin').eq('email', email.toLowerCase()).maybeSingle());
}
export async function listInvites() {
  return check(await (await client()).from('invites').select('email, is_admin, invited_at').order('invited_at', { ascending: true }));
}
export async function addInvite(email) {
  return check(await (await client()).from('invites').insert({ email: email.trim().toLowerCase() }));
}
export async function removeInvite(email) {
  return check(await (await client()).from('invites').delete().eq('email', email));
}

// ---------- portfolio ----------

// { data, updated_at } or null for a user who has never saved.
export async function loadCloudPortfolio(userId) {
  return check(await (await client()).from('portfolios').select('data, updated_at').eq('user_id', userId).maybeSingle());
}
export async function saveCloudPortfolio(userId, data) {
  const updated_at = new Date().toISOString();
  check(await (await client()).from('portfolios').upsert({ user_id: userId, data, updated_at }));
  return updated_at;
}

// ---------- AI fund control (admins; see supabase/fund-control.sql) ----------

// Asks GitHub (through Supabase) to start or stop the AI fund, or to refresh the AI picks.
export async function sendFundCommand({ action, amount = null, currency = null, decisionsPerDay = null }) {
  return check(await (await client()).from('fund_commands')
    .insert({ action, amount, currency, decisions_per_day: decisionsPerDay })
    .select('id, action, created_at').single());
}

// { state: 'pending' | 'accepted' | 'failed', status, detail }
export async function fundCommandStatus(id) {
  return check(await (await client()).rpc('fund_command_status', { command_id: id }));
}
