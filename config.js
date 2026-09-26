// Supabase project used for sign-in and for saving each user's portfolio.
// Both values are meant to be public (Settings → API in Supabase): the database's row-level security,
// set up by supabase/setup.sql, is what keeps each person's data private.
// Leave them empty to run the app without accounts (portfolio saved in the browser only).
export const SUPABASE_URL = 'https://xpbtecmatqfhkoedtazy.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_-HqKD6o1q8_XNxdxPKZXeg_evI9OMZs';

// Shows "Continue with Google" on the sign-in screen. Turn on only after enabling the Google
// provider in Supabase (see README → Accounts).
export const GOOGLE_SIGN_IN = false;
