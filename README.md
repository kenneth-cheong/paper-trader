# Paper Trader

Practice trading Singapore (SGX) and US stocks with virtual cash at real market prices, and see whether you end up with a net profit or loss. Claude adds long/short picks based on the news, proposes strategies, and can run a fund of its own.

## What's in it

| Tab | What it does |
|---|---|
| **Home** | Your profit/loss, **AI picks** (which watchlist stocks to go long or short now, based on current news, with sources) and your holdings. |
| **Markets** | Prices, day change and a 1-month sparkline for every stock. Buy, sell or short from here. |
| **Auto-trading** | Rules that trade for you: limit buys, stop-losses, take-profits, trailing stops, moving-average crossovers and scheduled buys. Each rule can be backtested on the past year. |
| **AI strategist** | Claude reads a year of prices, current news and your own trades, then proposes strategies written as auto-trading rules. Each strategy is backtested automatically, and you can add it as paused rules. |
| **AI fund** | Give Claude an amount and it trades on its own to make as much profit as possible, without ever using more than that amount. |
| **History** | Every trade, with automatic ones marked. |

### Accounts and trading rules

- **Two virtual cash accounts:** SGD 100,000 for SGX stocks and USD 100,000 for US stocks. You can change both amounts when you reset. Profit and loss is counted per currency, so exchange-rate moves don't affect it. A combined SGD figure is shown for reference.
- **Net profit/loss** = cash + value of holdings − starting cash. It's split into realized (closed trades) and unrealized (open positions).
- **Short selling:** selling more than you hold opens a short. Like a margin account, each short sets aside 150% of its sale value from your buying power until you buy it back ("cover").
- No fees and whole shares only. Orders fill at the latest fetched price, which is the last close when the market is shut.
- **Your portfolio and rules** are saved to your account when accounts are on (see *Accounts* below); otherwise they live in your browser, and *Settings → Export* backs them up or moves them to another device.

### Auto-trading rules

Rules run whenever the page is open. When you come back after being away, they replay the last 5 trading days of 15-minute prices, so a rule still fires at the time and price it would have. If you're away longer than that, the gap is skipped. Rules only manage long positions; they never open shorts.

### The AI fund's hard limit

The fund's ledger starts with exactly the amount you give it, and nothing is ever added. The code, not the AI, rejects any order that costs more than the fund's buying power. Shorts need 150% collateral and are covered automatically at a 40% loss, so the fund can't lose more than its amount. The fund trades one market, set by the currency you choose: USD for US stocks, SGD for SGX stocks. It can hold long and short positions and set its own stop-loss and take-profit levels, which are checked every 15 minutes.

## How it runs

A GitHub Actions workflow (`.github/workflows/prices.yml`) runs every 15 minutes on weekdays while SGX or US markets are open. Each run:

1. fetches a year of daily prices and 5 days of 15-minute prices for every stock in `symbols.json` from Yahoo Finance's public chart endpoint (no key needed);
2. refreshes the **AI picks** if they're more than 10 hours old, which works out to about twice each trading day;
3. runs the **AI fund**: it checks stop-loss, take-profit and forced-cover levels, then asks Claude for a decision when one is due. Decisions are spread through the market's trading day, starting 15 minutes after the open;
4. saves the AI picks and fund to the `ai-state` branch, so `main`'s history stays clean;
5. redeploys the site to GitHub Pages.

The page reloads everything every 5 minutes. Prices can be 20–30 minutes old, because Yahoo delays SGX quotes and GitHub sometimes starts scheduled runs late. Exchange holidays aren't known, so on a holiday the market simply shows no new prices.

## Setup

1. Create a **public** GitHub repository, e.g. `paper-trader`, and push this folder to its `main` branch. GitHub Pages is free only for public repos. Your own trades stay in your browser, but AI picks and the AI fund are published on the site.
2. **Settings → Pages → Build and deployment → Source:** choose **GitHub Actions**.
3. **Settings → Secrets and variables → Actions → New repository secret:** add `ANTHROPIC_API_KEY` with your key from [console.anthropic.com](https://console.anthropic.com). This powers the scheduled AI picks and the AI fund. Set a spending limit on the key.
4. Optional: choose the models on the same page's **Variables** tab (see *Which model does what* below).
5. **Actions → Update prices, AI picks and AI fund → Run workflow.** When it finishes, the site is at `https://<your-username>.github.io/paper-trader/`.

For the **AI strategist** and the **Refresh now** button on AI picks, add your API key in the app under *Settings*. It is stored only in that browser and sent straight to Anthropic.

### Accounts (invite-only sign-in)

With accounts on, people must sign in with Google or with an email and password, and only emails you've invited can get in. Each person's portfolio, rules and trades are saved to their account, so they follow them across devices. Until `config.js` is filled in, the app runs without accounts and keeps the portfolio in the browser.

1. Create a free project at [supabase.com](https://supabase.com). A Singapore region is closest.
2. **SQL Editor → New query:** paste `supabase/setup.sql`, change `you@example.com` on the last line to the address you'll sign in with, and press **Run**. This creates the invite list, with you as admin, plus the portfolio table, locked so each person can reach only their own row.
3. **Authentication → Hooks → Before User Created:** turn it on and choose the Postgres function `public.hook_before_user_created`. Uninvited emails then can't create an account at all. Even without this step, uninvited users get no access to data; they just see a "Not invited yet" screen.
4. **Authentication → URL Configuration:** set *Site URL* to `https://<your-username>.github.io/paper-trader/` and add the same address under *Redirect URLs*.
5. **Google sign-in:** in [Google Cloud Console](https://console.cloud.google.com/apis/credentials), go to *Create credentials → OAuth client ID → Web application*. Under *Authorized redirect URIs*, add `https://<your-project>.supabase.co/auth/v1/callback`. Then, in Supabase, open **Authentication → Sign In / Providers → Google**, turn it on, and paste the client ID and secret.
6. **Project Settings → API Keys:** copy the project URL and the *publishable* (anon) key into `config.js` and push. Both are meant to be public; the database's row-level security is what protects the data.

To invite someone, sign in and press **Invites** at the top. No email is sent, so tell them to sign up with that address. Password sign-ups get a confirmation email from Supabase; its built-in email service only sends a few per hour, which is fine for a small group.

Note that the site's static files are public, including the shared prices, AI picks and AI fund. Signing in protects each person's own portfolio and the app screens.

### Starting, stopping or replacing the AI fund

Go to **Actions → Update prices, AI picks and AI fund → Run workflow** and fill in:

- *Start a NEW AI fund with this amount*: e.g. `10000`. This replaces any current fund.
- *New fund's currency*: `USD` (US stocks) or `SGD` (SGX stocks).
- *How many times a trading day the AI decides*: 1, 2 or 4.
- *Stop the AI fund*: closes all its positions and stops it.

### Which model does what

The work is split by difficulty to keep costs down:

| Task | Model | Why |
|---|---|---|
| Searching the web and summarising the news | **Claude Haiku 4.5** (cheapest) | Simple but reads a lot: search results are most of the tokens. |
| AI picks, AI strategist, AI fund trades | **Claude Sonnet 5** | Real judgement, but it only reads Haiku's short news summary and the price statistics. |

One news summary per run is shared by the picks and the AI fund. To change the models, add repository variables (**Settings → Secrets and variables → Actions → Variables**): `AI_NEWS_MODEL` for the news step and `AI_MODEL` for the decisions (`claude-haiku-4-5`, `claude-sonnet-5` or `claude-opus-5`). In the app, *Settings → Model for picks and strategies* does the same for what you run in the browser.

### Costs

A picks refresh (news plus picks) typically costs about US$0.10–0.30, and an AI fund decision about US$0.05–0.15 when it reuses that news. Web searches are US$0.01 each. The picks refresh about twice a day, and a new fund makes 1 decision a day unless you choose more, so expect well under US$1 per trading day. For comparison, a picks refresh done entirely on Opus 5 cost US$1.50. Every AI result in the app shows its approximate cost.

GitHub turns off scheduled workflows in a public repo after 60 days with no commits. The `ai-state` commits count toward that, but if everything stops, re-enable the workflow on the Actions tab.

## Adding or removing stocks

Edit `symbols.json` and push. Use Yahoo Finance tickers: SGX stocks end in `.SI` (DBS is `D05.SI`), and US stocks are plain (`AAPL`, `BRK-B`).

## Running locally

```sh
npm test                                   # ledger, rules, AI fund and AI call handling
node scripts/fetch-prices.mjs              # optional: real prices into data/prices.json
python3 -m http.server 8000                # then open http://localhost:8000
```

Without `data/prices.json`, the page uses the made-up `data/sample-prices.json` (regenerate it with `node scripts/make-sample-prices.mjs`) and shows a banner saying so.

## Files

| File | Purpose |
|---|---|
| `portfolio.js` | The ledger: cash accounts, long and short positions, buying power, profit/loss. |
| `rules.js` | Auto-trading rules engine and backtester. |
| `fund.js` | The AI fund: budget limit, order execution, protections, decision schedule. |
| `ai.js` | Every Claude call: the Haiku news digest, then picks, strategies and fund decisions, each answered through a validated "submit" tool. |
| `markets.js` | Exchange trading hours. |
| `auth.js`, `login.js`, `config.js` | Sign-in, invites and saving portfolios to Supabase. |
| `supabase/setup.sql` | Database tables, access rules and the invite-only sign-up check. |
| `app.js`, `index.html`, `styles.css` | The web app. |
| `scripts/` | The scheduled jobs: prices, AI picks, AI fund. |

Everything here uses virtual money. AI output can be wrong or out of date, and nothing in this app is financial advice.
