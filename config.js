// Supabase project used for sign-in and for saving each user's portfolio.
// Both values are meant to be public (Settings → API in Supabase): the database's row-level security,
// set up by supabase/setup.sql, is what keeps each person's data private.
// Leave them empty to run the app without accounts (portfolio saved in the browser only).
export const SUPABASE_URL = '';
export const SUPABASE_KEY = '';
