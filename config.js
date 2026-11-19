/* Full Time AI settings. This file is public (anyone can read it), so only put PUBLIC values here.
   Never put your API-Football key, Resend key or service-role key in this file. */
window.FT_CONFIG = {
  // From Google Cloud Console > Credentials > OAuth client ID (type: Web application). Looks like 1234-abc.apps.googleusercontent.com
  googleClientId: "97291063216-6aa5f6rkhlq57b40svh5pi479tjvraim.apps.googleusercontent.com",

  // From Supabase > Project Settings > API. The "anon / publishable" key is meant to be public.
  supabaseUrl: "",        // e.g. https://abcdefghijkl.supabase.co
  supabaseAnonKey: "",

  // Optional: URL of the send-code function, so reset codes are emailed (see README step 6)
  // e.g. https://abcdefghijkl.supabase.co/functions/v1/send-code
  mailUrl: "",

  // Optional: force a crest for a club: { "Everton": "https://.../everton.png" }
  crests: {}
};
