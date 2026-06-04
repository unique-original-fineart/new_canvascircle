// =============================================================================
// CanvasCircle — Public Config
// =============================================================================
// These are PUBLIC values, safe to commit to a public repo and ship to the
// browser. The Supabase anon key is designed to be exposed in client code; the
// service_role key is never used here and never goes anywhere near the front
// end (it lives only in edge function secrets / your password manager).
//
// All access control happens server-side via Postgres Row-Level Security
// policies (see db/schema.sql).
// =============================================================================

export const SUPABASE_URL      = "https://xwieomjsqwcswoadrvkv.supabase.co";

// TODO: paste the full anon key from Supabase > Project Settings > API.
// It starts with "eyJhbGc..." — same one you shared with me. Safe to commit.
export const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh3aWVvbWpzcXdjc3dvYWRydmt2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5MzMzOTAsImV4cCI6MjA5MzUwOTM5MH0.G2jYVS788F6zI7vHNPOPVRM0sYdD_iVb6k6gdw6BcfA";

// Storage bucket where listing photos live (created by db/schema.sql).
export const STORAGE_BUCKET = "listing-images";

// Public site origin (canonical URL, used for OG tags / sharing).
export const SITE_ORIGIN = "https://canvascircle.art";

// Cloudflare Turnstile site key (PUBLIC, safe to commit). Pair with the
// secret key set in Supabase Auth → Settings → CAPTCHA Provider (which
// validates submitted tokens server-side before letting signups through).
//
// When this constant is empty, the signup-form Turnstile widget no-ops
// silently and signups go through as before — so the site keeps working
// during the time between deploying this code and finishing the Cloudflare
// + Supabase dashboard setup. Once you paste a real site key here, the
// widget activates and signups require a passing token.
//
// Setup instructions:
//   1. Cloudflare dashboard → Turnstile → Add Site → "canvascircle.art".
//      Recommended widget type: "Managed" (auto-decides between invisible
//      vs interactive challenge based on signal). Save → copy SITE KEY here.
//   2. Same Cloudflare page: copy the SECRET KEY. In Supabase Dashboard →
//      Authentication → Settings → "Enable CAPTCHA Protection" → choose
//      Turnstile from the provider dropdown → paste secret key → Save.
//   3. Paste the site key into the constant below, commit, push.
export const TURNSTILE_SITE_KEY = "0x4AAAAAADe48ecVYSHBpGky";
