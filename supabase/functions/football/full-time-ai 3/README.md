# Full Time AI: launch guide

## What is in this folder

| File | What it is |
|---|---|
| `index.html` | The app (the fixed version: sign-in, menu, crests, Google). |
| `config.js` | **Your settings** (Google Client ID, Supabase URL and key). Edit this one. |
| `manifest.webmanifest`, `sw.js`, `icon*.png`, `icon.svg`, `apple-touch-icon.png` | Make the app installable on a phone and give it a logo. Leave as they are. |
| `supabase/schema.sql` | The SQL to run once in Supabase. |
| `supabase/functions/football/index.ts` | Server function that talks to API-Football for you (keeps your key secret). |
| `supabase/functions/send-code/index.ts` | Optional: emails reset and new-device codes. |

Keep all files in the **same folder**. To use the fixed app in your main project, replace your old `index.html` with this one and copy the other files next to it.

---

## 1. Run it on your computer (2 minutes)

Do **not** double-click `index.html`. Google sign-in cannot work from a `file://` address.

1. Open a terminal in this folder.
2. Run `python -m http.server 8000` (or `npx serve`).
3. Open **http://localhost:8000** in Chrome.

The app, accounts, crest shields and admin all work now. Steps 2 to 5 switch on the football provider, Google and emails.

First admin: open `http://localhost:8000/#admin-setup` and create the admin (email + password, or Google once step 4 is done). After that, log in from the normal Login box with the admin email.

---

## 2. Create the Supabase project and run the SQL

1. Go to supabase.com, create a project, and wait until it finishes starting.
2. Open **SQL Editor > New query**, paste everything from `supabase/schema.sql`, press **Run**. You should see "Success". This creates `api_cache` and `mail_log`.
3. Open **Project Settings > API** and copy:
   - the **Project URL** (like `https://abcdefghijkl.supabase.co`)
   - the **anon / publishable key** (it is designed to be public)
4. Paste both into `config.js` as `supabaseUrl` and `supabaseAnonKey`. Your **project reference** is the `abcdefghijkl` part of the URL; you need it below.

---

## 3. Make the football provider (API-Football) work

**What it does in this app today:** it checks that a team is real, loads teams and next fixtures in *AI analysis > Other teams or leagues*, and fetches club crests (`team.logo`). **The matches on Home and Match days are still simulated demo data**; connecting the provider does not replace those yet. The app is built to show this demo note until a real fixtures feed is wired in.

### 3a. Get the key
1. On dashboard.api-football.com, copy your API key (the account you already have is fine).
2. Check your plan's limits on the same page. The free plan is limited to about 100 requests a day, and free plans have been restricted to older seasons, so current-season data may need a paid plan. The cache table helps a lot with the daily limit.

### 3b. Deploy the function
Install the Supabase CLI (`npm i -g supabase`, or use `npx supabase` before each command below), then in this folder:

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase secrets set APIFOOTBALL_KEY=PASTE_YOUR_API_FOOTBALL_KEY
supabase functions deploy football --no-verify-jwt
```
`--no-verify-jwt` is used because the function only allows a short list of read-only football calls and hides your key. Newer Supabase projects use publishable keys that are not JWTs, and this flag stops those being rejected.

### 3c. Test it before opening the app
Replace the two values and run:
```bash
curl "https://YOUR_PROJECT_REF.supabase.co/functions/v1/football?path=teams&search=Everton" \
  -H "apikey: YOUR_ANON_KEY"
```
You should get JSON with a `"response"` list containing Everton and a `logo` link.
- `"errors": {"token": ...}` or an `APIFOOTBALL_KEY ... not set` message: the secret is wrong or missing (re-run `secrets set`, then deploy again).
- `"errors": {"requests": ...}` : you have hit your daily quota.
- `"errors": {"plan": ...}` : your plan does not include that season.
Run the same curl again; the header `x-cache: HIT` (use `curl -i`) proves the cache table works.

### 3d. Turn it on in the app
`config.js` already has the two Supabase values from step 2. Reload the app (hold Shift + reload). With them present, the app uses API-Football automatically; without them it falls back to the free TheSportsDB for crests and checks.

**How to confirm it is working:** open Chrome DevTools (F12) > Network, reload, and filter for `football`. You should see requests to `/functions/v1/football?path=teams...` with status 200. Crest shields then turn into real badges.

---

## 4. Make "Continue with Google" work

The button already exists on Log in, Sign up and the admin pages. It needs a Google **Client ID** and a real web address.

1. Go to console.cloud.google.com and create a project (or pick one).
2. Open **APIs & Services > OAuth consent screen** (now also called **Google Auth Platform**). Choose **External**, fill in the app name and your email, and save. While the app is in "Testing" only the **test users** you add can sign in. Press **Publish app** when you want everyone to be able to.
3. Open **Credentials > Create credentials > OAuth client ID**, type **Web application**.
4. Under **Authorized JavaScript origins** add every address the app runs on. Only the address, no path and no trailing slash:
   - `http://localhost:8000` (for testing; the port must match)
   - `https://your-real-site.com` (after you host it)
   You do **not** need a redirect URI for this button.
5. Press Create and copy the **Client ID** (ends in `.apps.googleusercontent.com`).
6. Paste it into `config.js` as `googleClientId`. (Alternative: log in as admin > Admin controls > Sign-in > paste > Save.)
7. Reload from `http://localhost:8000`. The Google button should now show the real Google button.

**How the app treats it:** the first Google login with an email creates the user account; the next ones sign in. If that email is the admin email, it opens the admin panel instead. The app checks the token with Google and rejects tokens made for another Client ID or unverified emails.

**If it does not work**
- Button says it "cannot run from a file": you opened `index.html` directly. Use the localhost address.
- "Could not load Google sign-in" or Google shows *origin_mismatch / invalid origin*: the address in the browser bar is not in **Authorized JavaScript origins** exactly (check `http` vs `https`, the port, and `www`). Changes can take a few minutes.
- "Access blocked: app not verified" or only some people can log in: add them as **test users** or publish the consent screen.
- Pop-up closes at once: your host may send a `Cross-Origin-Opener-Policy: same-origin` header; remove it or use `same-origin-allow-popups`.

---

## 5. Optional: email the reset and new-device codes

Without this, codes only appear on screen in demo mode on localhost, and on a live website "Forgot password" will say it cannot send email.

1. Create an account at resend.com and an API key. To send to anyone you must verify your own domain there; the free test sender `onboarding@resend.dev` only delivers to your own address.
2. Deploy:
```bash
supabase secrets set RESEND_API_KEY=re_xxx MAIL_FROM="Full Time <no-reply@your-domain.com>"
supabase functions deploy send-code --no-verify-jwt
```
3. Put `https://YOUR_PROJECT_REF.supabase.co/functions/v1/send-code` in `config.js` as `mailUrl` (or in Admin controls > Contact and email).
4. Test: Login > Forgot password > enter your own account. The code should arrive by email. The function allows 5 emails per address per hour.

---

## 6. Put it online

Any static host works: Netlify (drag the folder onto app.netlify.com/drop), Vercel, Cloudflare Pages or GitHub Pages. The site must use **https**. After it has an address:
1. Add it to Google's **Authorized JavaScript origins** (step 4).
2. Optionally replace `"*"` with your address in the two functions' `CORS` block and redeploy them.
3. Create the admin first by opening `https://your-site/#admin-setup` yourself. Whoever opens it first becomes admin.

---

## Final check list

- [ ] Opens at http://localhost:8000 with no broken logo
- [ ] Sign up, log out, log in works; wrong password says "Wrong password"
- [ ] Admin: `#admin-setup` once, then admin email in the normal Login box
- [ ] `curl` test in 3c returns teams JSON
- [ ] Network tab shows `football` calls with status 200, and crests become real badges
- [ ] Google button is the real Google button and signs in
- [ ] (Optional) Forgot password email arrives

## Honest limits to know about

- Users, passwords (hashed), predictions and admin settings live in each visitor's **browser storage**, not in a database, so they are per device and the admin cannot see accounts made on other devices. Moving accounts into Supabase is a bigger change that was not part of this fix.
- Home and Match days still show simulated demo data, as the app's own banner says.
