// The sign-in screen and the Invites panel. Signing in itself is handled by Supabase (auth.js);
// app.js reacts to the resulting sign-in events.

import { GOOGLE_SIGN_IN } from './config.js';
import { signInWithGoogle, signInWithPassword, signUp, sendPasswordReset, setNewPassword, signOut, listInvites, addInvite, removeInvite } from './auth.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const GOOGLE_ICON = '<svg viewBox="0 0 18 18" aria-hidden="true" width="18" height="18"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.97 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/></svg>';

const googleButton = () => (GOOGLE_SIGN_IN
  ? `<button type="button" class="google" data-auth="google">${GOOGLE_ICON}<span>Continue with Google</span></button><div class="or"><span>or</span></div>`
  : '');

const VIEWS = {
  loading: () => '<p class="muted">Checking your sign-in…</p>',
  signin: () => `
    <h2>Sign in</h2>
    <p class="muted small">Paper Trader is invite-only.</p>
    ${googleButton()}
    <form data-auth-form="signin">
      <label>Email <input name="email" type="email" autocomplete="email" required></label>
      <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
      <button type="submit" class="primary wide-btn">Sign in</button>
    </form>
    <p class="small links"><a href="#" data-auth-view="signup">Create an account</a> · <a href="#" data-auth-view="reset">Forgot password?</a></p>`,
  signup: () => `
    <h2>Create an account</h2>
    <p class="muted small">Use the email address you were invited with.</p>
    ${googleButton()}
    <form data-auth-form="signup">
      <label>Email <input name="email" type="email" autocomplete="email" required></label>
      <label>Password <input name="password" type="password" autocomplete="new-password" minlength="8" required></label>
      <button type="submit" class="primary wide-btn">Create account</button>
    </form>
    <p class="small links"><a href="#" data-auth-view="signin">I already have an account</a></p>`,
  reset: () => `
    <h2>Reset your password</h2>
    <form data-auth-form="reset">
      <label>Email <input name="email" type="email" autocomplete="email" required></label>
      <button type="submit" class="primary wide-btn">Email me a reset link</button>
    </form>
    <p class="small links"><a href="#" data-auth-view="signin">Back to sign in</a></p>`,
  newpass: () => `
    <h2>Choose a new password</h2>
    <form data-auth-form="newpass">
      <label>New password <input name="password" type="password" autocomplete="new-password" minlength="8" required></label>
      <button type="submit" class="primary wide-btn">Save password</button>
    </form>`,
  sent: (text) => `<h2>Check your email</h2><p>${esc(text)}</p><p class="small links"><a href="#" data-auth-view="signin">Back to sign in</a></p>`,
  notinvited: (email) => `
    <h2>Not invited yet</h2>
    <p><strong>${esc(email)}</strong> isn't on the invite list. Ask the owner to invite this address, then sign in again.</p>
    <button type="button" class="ghost" data-auth="signout">Sign out</button>`,
  error: (text) => `<h2>Something went wrong</h2><p class="error">${esc(text)}</p><button type="button" class="ghost" data-auth-view="signin">Try again</button>`,
};

// While the sign-in screen is up, the app behind it can't be reached by mouse, keyboard or screen reader.
const lockApp = (locked) => {
  for (const el of document.querySelectorAll('.top, .tabs, main, #banner, #notices')) el.inert = locked;
  document.body.classList.toggle('locked', locked);
};

export function showAuth(view, info) {
  $('auth').hidden = false;
  lockApp(true);
  $('auth-body').innerHTML = `${VIEWS[view](info)}<p class="error" id="auth-error" role="alert"></p>`;
  $('auth-body').querySelector('input')?.focus();
}

export function hideAuth() {
  $('auth').hidden = true;
  lockApp(false);
}

async function busy(button, fn) {
  const old = button?.textContent;
  if (button) { button.disabled = true; button.textContent = 'One moment…'; }
  $('auth-error').textContent = '';
  try {
    await fn();
  } catch (err) {
    const el = $('auth-error');
    if (el) el.textContent = err.message;
  } finally {
    if (button?.isConnected) { button.disabled = false; button.textContent = old; }
  }
}

export function wireAuthScreen() {
  $('auth').addEventListener('click', (e) => {
    const view = e.target.closest('[data-auth-view]');
    if (view) { e.preventDefault(); showAuth(view.dataset.authView); return; }
    const btn = e.target.closest('[data-auth]');
    if (btn?.dataset.auth === 'google') busy(btn, signInWithGoogle);
    if (btn?.dataset.auth === 'signout') busy(btn, signOut);
  });
  $('auth').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.target;
    const email = form.email?.value.trim();
    const password = form.password?.value;
    const btn = form.querySelector('button[type="submit"]');
    const kind = form.dataset.authForm;
    if (kind === 'signin') busy(btn, () => signInWithPassword(email, password));
    if (kind === 'signup') {
      busy(btn, async () => {
        if (await signUp(email, password) === 'confirm-email') showAuth('sent', `We sent a confirmation link to ${email}. Open it to finish creating your account.`);
      });
    }
    if (kind === 'reset') busy(btn, async () => { await sendPasswordReset(email); showAuth('sent', `If ${email} has an account, a reset link is on its way.`); });
    if (kind === 'newpass') busy(btn, async () => { await setNewPassword(password); hideAuth(); });
  });
}

// ---------- invites (admins only) ----------

export async function openInvites(me) {
  const dlg = $('invites-dialog');
  if (!dlg.open) dlg.showModal();
  $('invites-error').textContent = '';
  $('invites-list').innerHTML = '<li class="muted">Loading…</li>';
  try {
    const rows = await listInvites();
    $('invites-list').innerHTML = rows.map((r) => `<li>
      <span>${esc(r.email)}${r.is_admin ? ' <span class="chip">admin</span>' : ''}</span>
      ${r.email === me ? '<span class="muted small">you</span>' : `<button type="button" class="small-btn ghost" data-uninvite="${esc(r.email)}">Remove</button>`}
    </li>`).join('');
  } catch (err) {
    $('invites-error').textContent = err.message;
  }
}

export function wireInvites(getMe) {
  $('invites-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('invite-email');
    try {
      await addInvite(input.value);
      input.value = '';
      await openInvites(getMe());
    } catch (err) {
      $('invites-error').textContent = /duplicate|already exists/i.test(err.message) ? 'That email is already invited.' : err.message;
    }
  });
  $('invites-list').addEventListener('click', async (e) => {
    const email = e.target.closest('[data-uninvite]')?.dataset.uninvite;
    if (!email || !confirm(`Remove ${email}? They'll lose access, though their saved portfolio is kept.`)) return;
    try {
      await removeInvite(email);
      await openInvites(getMe());
    } catch (err) {
      $('invites-error').textContent = err.message;
    }
  });
  $('invites-close').addEventListener('click', () => $('invites-dialog').close());
}
