# Paper Trader

Practice trading Singapore (SGX) and US stocks with virtual cash at real market prices, and see whether you end up with a net profit or loss. Claude adds long/short picks based on the news, proposes strategies, and can run a fund of its own.

## What's in it

| Tab | What it does |
|---|---|
| **Home** | Your profit/loss, **AI picks** (which watchlist stocks to go long or short now, based on current news, with sources) and your holdings. |
| **Markets** | Prices, day change and a 1-month sparkline for every stock. Buy, sell or short from here. |
| **Auto-trading** | Rules that trade for you: limit buys, stop-losses, take-profits, trailing stops, moving-average crossovers and scheduled buys. Each rule can be backtested on the past year. |
| **AI strategist** | Claude reads a year of prices, current news and your own trades, then proposes strategies written as auto-trading rules. Each strategy is backtested automatically, and you can add it as paused rules. |
| **AI fund** | Give Claude an amount and it trades on its own to make as much profit as possible, without ever using more than that amount. Run up to 5 funds side by side, each with its own style, focus and model, and compare them. |
| **History** | Every trade, with automatic ones marked. |

### Accounts and trading rules

- **Two virtual cash accounts:** SGD 100,000 for SGX stocks and USD 100,000 for US stocks. You can change both amounts when you reset. Profit and loss is counted per currency, so exchange-rate moves don't affect it. A combined SGD figure is shown for reference.
- **Net profit/loss** = cash + value of holdings − starting cash. It's split into realized (closed trades) and unrealized (open positions).
- **Short selling:** selling more than you hold opens a short. Like a margin account, each short sets aside 150% of its sale value from your buying power until you buy it back ("cover").
- **Trading fees** are charged on every trade (see *Trading fees* below). Whole shares only. While a market is trading, orders fill at the latest fetched price. **Orders placed while it's closed wait** (listed under Holdings, where you can cancel them) and fill at the first price after it reopens, as with a real broker.
- **Market hours:** SGX 9:00am–12:00pm and 1:00pm–5:00pm Singapore time; US 9:30am–4:00pm New York time (daylight saving is handled). A market only counts as open when the clock says so *and* today's prices are arriving, so public holidays and early closes show as closed with no holiday calendar to maintain.
- **Converting currency:** the *Convert SGD ↔ USD* button on the combined card moves cash between your accounts at the latest rate, less your fee plan's conversion spread (Tiger about 0.1%, Standard Chartered about 0.5%: estimates; set your own under *My own rates*). Each account's profit and loss counts money converted in or out, so only the spread shows as a cost.
- **Dividends and splits** are applied automatically. A split changes your share count, not what you paid (10 shares at $300 become 30 at $100). Dividends are credited on the ex-date for shares held before it: US dividends lose 30% to US withholding tax (the rate for a Singapore resident), SGX dividends are paid in full, and a short pays the dividend. They show on the account cards and in History.
- **Index comparison:** each account card shows what the same starting money would have made in an index fund over the same period (SPY for USD, ES3 for SGD), after the buying fee.
- **Your portfolio and rules** are saved to your account when accounts are on (see *Accounts* below); otherwise they live in your browser, and *Settings → Export* backs them up or moves them to another device.

### Trading fees

Every trade pays fees, so all profit and loss is **after fees**:
- **Buying:** the fee is added to what the shares cost you, so it's in your average price.
- **Selling:** the fee is taken from what you receive.
- **Where you see them:** the trade window shows the fees before you confirm, each account card shows *Fees paid*, and History lists the fee for every trade.
- **Also included in:** backtests, auto-trading rules, orders placed while a market is closed, and the AI fund.

Choose the fees in *Settings → Trading fees*:

| Plan | US stocks | SGX stocks |
|---|---|---|
| **Tiger Brokers (Singapore)** (default) | US$0.005/share commission (min US$0.99, max 0.5%) + US$0.005/share platform fee (min US$1, max 0.5%); SEC and FINRA fees on sales | 0.03% commission (min S$0.99) + 0.03% platform fee (min S$1) + SGX clearing 0.0325% and trading 0.0075% |
| **Standard Chartered Online Trading** | 0.20%, US$10 minimum (check your rate) | 0.20%, S$10 minimum + SGX fees |
| **My own rates** | a percentage with a minimum | a percentage with a minimum |
| **No fees** | – | – |

9% GST is added to the broker's and SGX's fees. Priority and accredited Standard Chartered customers pay less, so use *My own rates* if that's you. These are published retail rates as of September 2026 and can change.

**Examples:** US$1,000 of a US stock costs about US$2.17 in fees with Tiger. S$38,000 of an SGX stock costs about S$41 with Tiger and S$99 with Standard Chartered.

The **AI fund** uses the Tiger, Standard Chartered or no-fee plan you choose when starting it. When trading through Tiger, it records the fees Tiger actually charged, using the Tiger plan only as an estimate until Tiger reports them. The AI is told what a round trip costs, so it avoids trades too small to cover their fees.

### AI picks' track record

Every scheduled set of picks is kept with each stock's price when it was picked. Under the picks, the **track record** scores each one after a week and a month of trading: whether it made money in its direction (a short gains when the price falls), and whether it beat the index over the same days (the S&P 500 for US stocks, the STI for SGX). Before fees. If the picks can't beat the index, don't follow them.

### Auto-trading rules

Rules run whenever the page is open. When you come back after being away, they replay the last 5 trading days of 15-minute prices, so a rule still fires at the time and price it would have. If you're away longer than that, the gap is skipped. Rules only manage long positions; they never open shorts.

### The AI fund's hard limit

The fund's ledger starts with exactly the amount you give it, and nothing is ever added. The code, not the AI, rejects any order that costs more than the fund's buying power. Shorts need 150% collateral and are covered automatically at a 40% loss, so the fund can't lose more than its amount. The fund trades one market, set by the currency you choose: USD for US stocks, SGD for SGX stocks. It can hold long and short positions and set its own stop-loss and take-profit levels, which are checked every 15 minutes. It only makes decisions while its market is actually trading, never on a holiday or after an early close.

The fund page compares the fund with **the same money in the index** (SPY or ES3, bought when the fund started, after fees), draws the index as a dashed line on the value chart, and shows **what the AI has cost** next to the profit after that cost. Dividends and splits on its holdings are applied as for your portfolio.

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

For the **AI strategist** and the **Refresh now** button on AI picks, add your API key in the app with the **Settings & API keys** button (top right) → *Anthropic API key*. It is stored only in that browser and sent straight to Anthropic. The same dialog's *Connections* list shows whether each connection (your browser key, the scheduled AI jobs' key, Tiger, your account) is working. Tiger's keys are never typed into the app: the site is public, so they live only in GitHub secrets (below).

### Accounts (invite-only sign-in)

With accounts on, people must sign in with Google or with an email and password, and only emails you've invited can get in. Each person's portfolio, rules and trades are saved to their account, so they follow them across devices. Until `config.js` is filled in, the app runs without accounts and keeps the portfolio in the browser.

1. Create a free project at [supabase.com](https://supabase.com). A Singapore region is closest.
2. **SQL Editor → New query:** paste `supabase/setup.sql`, change `you@example.com` on the last line to the address you'll sign in with, and press **Run**. This creates the invite list, with you as admin, plus the portfolio table, locked so each person can reach only their own row.
3. **Authentication → Hooks → Before User Created:** turn it on and choose the Postgres function `public.hook_before_user_created`. Uninvited emails then can't create an account at all. Even without this step, uninvited users get no access to data; they just see a "Not invited yet" screen.
4. **Authentication → URL Configuration:** set *Site URL* to `https://<your-username>.github.io/paper-trader/` and add the same address under *Redirect URLs*.
5. **Google sign-in:** in [Google Cloud Console](https://console.cloud.google.com/apis/credentials), go to *Create credentials → OAuth client ID → Web application*. Under *Authorized redirect URIs*, add `https://<your-project>.supabase.co/auth/v1/callback`. Then, in Supabase, open **Authentication → Sign In / Providers → Google**, turn it on, and paste the client ID and secret. Finally, set `GOOGLE_SIGN_IN = true` in `config.js` to show the Google button.
6. **Project Settings → API Keys:** copy the project URL and the *publishable* (anon) key into `config.js` and push. Both are meant to be public; the database's row-level security is what protects the data.

To invite someone, sign in and press **Invites** at the top. No email is sent, so tell them to sign up with that address. Password sign-ups get a confirmation email from Supabase; its built-in email service only sends a few per hour, which is fine for a small group.

Note that the site's static files are public, including the shared prices, AI picks and AI fund. Signing in protects each person's own portfolio and the app screens.

### Several AI funds

Up to **5 funds** can run at once. Each has its own amount, currency (market), broker (simulator or Tiger), approval setting, decisions per day, limits and:

- **Style**, which is the AI's brief and sets the default limits (you can still change them):
  - **Cautious:** large, established companies, gradual positions, a stop-loss on everything, no shorts. 10% max per order, pauses after a 3% daily loss.
  - **Balanced:** a spread of positions and sensible risk. 25% per order, 5% daily loss, shorts allowed.
  - **Aggressive:** concentrated bets on the strongest ideas, momentum and shorts. 40% per order, 8% daily loss.
- **Focus** (optional), your own instruction, for example *Only Singapore banks and REITs* or *Big US tech*.
- **AI model**: the default (Sonnet), or Haiku (cheapest) or Opus (strongest, most expensive).

The AI fund page ranks the funds by return after the AI's cost, and shows each one's return against the index. Tap a fund to see its positions, orders and decisions, and to pause, stop or change it. *Pause all funds* is the kill switch for all of them. A stopped fund stays listed until you remove it; a one-line summary of its result is kept.

Funds trading through Tiger share your one Tiger account. Each fund keeps its own record, and the check that Tiger holds what the funds think covers all of them together. One account can't be long and short the same stock, so a fund can't open a position on the other side of another Tiger fund's position in that stock. Each fund's decisions cost separately, and the monthly AI cap is shared.

### Starting, stopping or replacing the AI fund

**From the app (accounts on, admins only):** the AI fund tab has *Start AI fund* and *Stop fund* buttons. They need a one-time setup, because Supabase starts the GitHub workflow for you:

1. In GitHub, go to **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**. Choose *Only select repositories → paper-trader*, and under *Repository permissions* set **Actions** to **Read and write**.
2. In Supabase's **SQL Editor**, run `supabase/fund-control.sql`.
3. Still in the SQL Editor, store the token in Supabase's encrypted Vault:
   `select vault.create_secret('github_pat_…your token…', 'github_actions_token');`

The token never reaches the browser. Only admins can send start or stop requests, and the fund appears or changes within about 3–5 minutes.

**From GitHub:** go to **Actions → Update prices, AI picks and AI fund → Run workflow** and fill in:

- *Start a NEW AI fund with this amount*: e.g. `10000`. It runs alongside any others (balanced style; use the app to choose a style, focus and model).
- *New fund's currency*: `USD` (US stocks) or `SGD` (SGX stocks).
- *How many times a trading day the AI decides*: 1, 2 or 4.
- *Stop the AI fund*: closes all its positions and stops it (only when one fund is running; with several, use the app).

### Trading through Tiger Brokers

The AI fund can trade through your Tiger Brokers account instead of the simulator. Start with Tiger's **paper account** (simulated money) and approval on.

**How it works:** each run, a Python step (`scripts/tiger_broker.py`, using Tiger's official `tigeropen` library) checks your open orders and fills with Tiger. The fund then decides what to do, and a second step sends any new orders.
- **Orders:** always DAY limit orders, at most 1% worse than the latest price, and only while the market is actually trading.
- **Fills:** the fund records Tiger's actual fill prices.
- **Approval (the default):** the AI's trades wait under *Waiting for your approval* until you tap **Approve**. A proposal expires after an hour, or if the price moves more than 2% first. Stop-losses and take-profits don't wait, because they reduce risk.
- **Stop-losses held by Tiger:** each stop-loss is also placed at Tiger as a standing (good-till-cancelled) stop order, so it triggers straight away even if GitHub runs the job late or not at all. Shorts always get one at the 40% forced-cover level. When the position changes size, the stop order is replaced; before any other order sells the same shares, the stop order is cancelled first, so shares are never sold twice. If Tiger refuses a stop order, the app's own 15-minute check covers that stock instead.
- **Limits, enforced in code:** the fund's budget (open orders count as spent), a maximum size per order, and a daily-loss limit that pauses the fund.
- **Kill switch:** **Pause all trading** stops new trades and cancels open orders.
- **Mismatch check:** if the fund's positions and your Tiger account disagree, the page warns you.

**Setup:**
1. **Get Open API access from Tiger.** On a computer, log in at [developer.tigerbrokers.com.sg](https://developer.tigerbrokers.com.sg/) (it isn't in the phone app) and register as a developer. The *Developer Information* page then shows your **Tiger ID**, **License** and **Demo Account** (the 17-digit paper account). Under *Your RSA KEY*, click **Regenerate** and copy the **PKCS#1 private key** (for Python) straight away: Tiger shows it only once.
2. **Add GitHub repository secrets** (Settings → Secrets and variables → Actions → Secrets):
   - `TIGEROPEN_TIGER_ID`: your Tiger ID;
   - `TIGEROPEN_ACCOUNT`: your **paper** account number to start with;
   - `TIGEROPEN_PRIVATE_KEY`: the private key text;
   - `TIGEROPEN_LICENSE`: `TBSG` for Tiger Brokers Singapore.
3. **Check the connection:** Actions → *Check Tiger connection* → **Run workflow**. It only reads (no orders) and should print `Connected to Tiger: paper account ending ...` with the demo balance. Balances are printed for paper accounts only, since Actions logs of a public repo are public.
4. **Re-run `supabase/fund-control.sql`** in Supabase's SQL Editor, so the app can send approvals, pause and settings.
5. **Start the fund:** in the app, go to *AI fund → Start AI fund → Trades go to: Tiger Brokers account*, keeping *I approve each trade*. Tiger's paper account may not cover SGX, so start with a USD fund.

**Going live with real money** takes two deliberate changes. Change `TIGEROPEN_ACCOUNT` to your live account number, **and** add the repository variable `TIGER_LIVE_TRADING` = `yes` (Variables tab). Without the variable, orders for a live account are refused. The page shows *Tiger LIVE account (real money)* in red when it's live.

**Privacy:** the website is public. Its copy of the fund leaves out your Tiger account's full positions and Tiger's order numbers, but the fund's own trades and value are visible to anyone with the link.

### Keeping the AI fund private

By default the AI fund's trades, value and positions are on the public website and the public `ai-state` branch, and its trades appear in the public Actions logs. To keep them private (only admins see the fund, in the app, after signing in):

1. In Supabase → **SQL Editor**, run `supabase/private-fund.sql`. Its last line shows a long random token.
2. Add that token as a GitHub repository secret named **`FUND_STATE_TOKEN`**.

From the next run, the fund is stored in Supabase instead (readable only by admins), the website stops publishing it, the `ai-state` branch is restarted without it (its old history is gone), and the Actions logs stop printing its trades. If Supabase can't be reached, the fund skips that run rather than working from an old copy; if a save fails, that run's copy goes on the branch so no Tiger order is ever forgotten, and moves back to Supabase next run. Invited members who aren't admins no longer see the fund.

### Telegram alerts

Get a Telegram message when trades are waiting for your approval (with the deadline), orders fill, stop-losses or take-profits trigger, Tiger refuses an order, the fund pauses, an AI decision fails, the monthly AI cap is reached, the fund and your Tiger account disagree, or a dividend or split lands, plus a short summary after each trading day's close (value, the day's change, the index and the AI cost).

1. In Telegram, message **@BotFather**, send `/newbot`, and pick a name. It replies with a **token**.
2. Add it as a GitHub repository secret named **`TELEGRAM_BOT_TOKEN`**.
3. In Telegram, open your new bot and press **Start**.
4. In GitHub, go to **Actions → Set up Telegram alerts → Run workflow**. Your bot messages you your **chat id**.
5. Add it as a secret named **`TELEGRAM_CHAT_ID`**, then run *Set up Telegram alerts* again for a test message.

Alerts are checked on every scheduled run (every 15 minutes while markets trade). Their content never appears in the Actions log. The message links to the app, where you approve trades.

### Which model does what

The work is split by difficulty to keep costs down:

| Task | Model | Why |
|---|---|---|
| Searching the web and summarising the news | **Claude Haiku 4.5** (cheapest) | Simple but reads a lot: search results are most of the tokens. |
| AI picks, AI strategist, AI fund trades | **Claude Sonnet 5** | Real judgement, but it only reads Haiku's short news summary and the price statistics. |

One news summary per run is shared by the picks and the AI fund. To change the models, add repository variables (**Settings → Secrets and variables → Actions → Variables**): `AI_NEWS_MODEL` for the news step and `AI_MODEL` for the decisions (`claude-haiku-4-5`, `claude-sonnet-5` or `claude-opus-5`). In the app, *Settings → Model for picks and strategies* does the same for what you run in the browser.

### Costs

A picks refresh (news plus picks) typically costs about US$0.10–0.30, and an AI fund decision about US$0.05–0.15 when it reuses that news. Web searches are US$0.01 each. The picks refresh about twice a day, and a new fund makes 1 decision a day unless you choose more, so expect well under US$1 per trading day. For comparison, a picks refresh done entirely on Opus 5 cost US$1.50. Every AI result in the app shows its approximate cost.

**Monthly cap:** the scheduled AI (picks and the AI fund) stops for the rest of the month once its estimated spend reaches **US$30**. Stop-losses keep working, and the fund page and your Telegram say so. Change the cap with the repository variable `AI_MONTHLY_CAP_USD` (`0` means no cap). *Settings → Connections* shows this month's spend, and what this browser has spent with your own key.

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
| `portfolio.js` | The ledger: cash accounts, long and short positions, buying power, profit/loss, currency conversion. |
| `actions.js` | Dividends and stock splits. |
| `benchmark.js` | Comparisons with an index fund bought at the same time. |
| `scorecard.js` | The AI picks' track record. |
| `spend.js` | The AI's monthly spend and cap. |
| `alerts.js`, `scripts/notify.mjs` | Telegram alerts. |
| `scripts/fund-store.mjs`, `supabase/private-fund.sql` | Keeping the AI fund private in Supabase. |
| `funds.js` | Several AI funds: styles, starting, removing, and sharing one Tiger account. |
| `rules.js` | Auto-trading rules engine and backtester. |
| `fund.js` | The AI fund: budget limit, order execution, protections, decision schedule. |
| `ai.js` | Every Claude call: the Haiku news digest, then picks, strategies and fund decisions, each answered through a validated "submit" tool. |
| `markets.js` | Exchange trading hours. |
| `fees.js` | Broker fee plans (Tiger, Standard Chartered, custom) and the fee for each trade. |
| `auth.js`, `login.js`, `config.js` | Sign-in, invites and saving portfolios to Supabase. |
| `supabase/setup.sql` | Database tables, access rules and the invite-only sign-up check. |
| `supabase/fund-control.sql` | Lets admins start, pause, approve and stop the AI fund from the app. |
| `scripts/tiger_broker.py` | Sends the AI fund's orders to Tiger and brings back fills (with `test/test_tiger_broker.py`). |
| `scripts/public-fund.mjs` | Writes the public copy of the AI fund, without your Tiger account details. |
| `app.js`, `index.html`, `styles.css` | The web app. |
| `scripts/` | The scheduled jobs: prices, AI picks, AI fund. |

Everything here uses virtual money. AI output can be wrong or out of date, and nothing in this app is financial advice.
