# Paper Trader

Practice trading Singapore (SGX) and US stocks with virtual cash at real market prices, and see whether you end up with a net profit or loss. Claude adds long/short picks based on the news, proposes strategies, and can run a fund of its own.

## What's in it

| Tab | What it does |
|---|---|
| **Home** | Your profit/loss, a chart of each account's value over time against the index, **AI picks** (which watchlist stocks to go long or short now, based on current news, with sources) with their track record, and your holdings with where your money is and each holding's profit or loss. |
| **Markets** | Prices, day change and a 1-month sparkline for every stock, and a *results in N days* tag when a company reports soon. Buy, sell or short from here. |
| **Auto-trading** | Rules that trade for you: limit buys, stop-losses, take-profits, trailing stops, moving-average crossovers and scheduled buys. Each rule can be backtested on the past year. |
| **AI strategist** | Claude reads a year of prices, current news and your own trades, then proposes strategies written as auto-trading rules. Each strategy is backtested automatically, and you can add it as paused rules. |
| **AI fund** | Give Claude an amount and it trades on its own to make as much profit as possible, without ever using more than that amount. Run up to 5 funds side by side, each with its own style, focus and model, and compare them on a chart. Charts show its value, positions, what it has learned and the AI's monthly cost. |
| **History** | Realized profit over time, and every trade, with automatic ones marked. |

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

### Charts

Each account's **value over time** is rebuilt from your trades at each day's closing prices, with the money you put in (dashed; it steps when you convert currency) and what the same money would be worth in the index (grey; it gets the same money in and out). Other charts show where your money is, each holding's profit or loss, the AI picks' track record against a coin flip, realized profit over time, and on the AI fund page the funds side by side, what its ideas did a week later, the market memory and the AI's monthly spend against the cap.

Hover, tap or drag a chart for exact numbers; line charts also take keyboard focus (the arrow keys step through the days, Escape closes the tooltip). Every chart has a **Table** switch with the same numbers.

For anyone changing them: the charts are hand-drawn SVG in `charts.js` with no library. Colours come from CSS variables in `styles.css` (`--series-1` to `--series-8` for identity, in a fixed order checked for colour-blind separation in light and dark mode; green and red only where a value is good or bad). Marks are thin (bars at most 14px, 2px lines), axis ticks are round numbers, labels are measured so nothing is cut off (on phones, bar labels move above their bars), there's never a second y-axis, and every chart needs a table twin.

### AI picks' track record

Every scheduled set of picks is kept with each stock's price when it was picked. Under the picks, the **track record** scores each one after a week and a month of trading: whether it made money in its direction (a short gains when the price falls), and whether it beat the index over the same days (the S&P 500 for US stocks, the STI for SGX). Dividends count, for the stock and the index (a long receives them, after US withholding tax for US stocks; a short pays them). Before fees. Picks older than the year of daily prices drop out of the record. If the picks can't beat the index, don't follow them.

### Auto-trading rules

Rules run whenever the page is open. When you come back after being away, they replay the last 5 trading days of 15-minute prices, so a rule still fires at the time and price it would have. If you're away longer than that, the gap is skipped. Rules only manage long positions; they never open shorts.

### The AI fund's hard limit

The fund's ledger starts with exactly the amount you give it, and nothing is ever added. The code, not the AI, rejects any order that costs more than the fund's buying power. Shorts need 150% collateral and are covered automatically at a 40% loss, so the fund can't lose more than its amount. The fund trades one market, set by the currency you choose: USD for US stocks, SGD for SGX stocks. It can hold long and short positions and set its own stop-loss and take-profit levels, which are checked every 15 minutes. It only makes decisions while its market is actually trading, never on a holiday or after an early close.

The fund page compares the fund with **the same money in the index** (SPY or ES3, bought when the fund started, after fees), draws the index as a grey line on the value chart, and shows **what the AI has cost** next to the profit after that cost. Dividends and splits on its holdings are applied as for your portfolio.

## How it runs

A GitHub Actions workflow (`.github/workflows/prices.yml`) runs every 15 minutes on weekdays while SGX or US markets are open. Each run:

1. fetches a year of daily prices (with each day's trading volume) and 5 days of 15-minute prices for every stock in `symbols.json` from Yahoo Finance's public chart endpoint (no key needed);
2. checks the **results calendar**: US results releases from SEC filings (at most every 2 hours, if set up), and once a day, after the US close, each company's next results date and analysts' views from Yahoo Finance (see *Results calendar and analysts* below);
3. refreshes the **AI picks** if they're more than 10 hours old, which works out to about twice each trading day;
4. runs the **AI fund**: it checks stop-loss, take-profit and forced-cover levels, then asks Claude for a decision when one is due. Decisions are spread through the market's trading day, starting 15 minutes after the open;
5. saves the AI picks, the fund and the calendar to the `ai-state` branch, so `main`'s history stays clean;
6. redeploys the site to GitHub Pages.

The page reloads everything every 5 minutes. Prices can be 20–30 minutes old, because Yahoo delays SGX quotes and GitHub sometimes starts scheduled runs late. Exchange holidays aren't known, so on a holiday the market simply shows no new prices.

## Setup

1. Create a **public** GitHub repository, e.g. `paper-trader`, and push this folder to its `main` branch. GitHub Pages is free only for public repos. Your own trades stay in your browser, but AI picks and the AI fund are published on the site.
2. **Settings → Pages → Build and deployment → Source:** choose **GitHub Actions**.
3. **Settings → Secrets and variables → Actions → New repository secret:** add `ANTHROPIC_API_KEY` with your key from [console.anthropic.com](https://console.anthropic.com). This powers the scheduled AI picks and the AI fund. Set a spending limit on the key.
4. Optional: choose the models on the same page's **Variables** tab (see *Which model does what* below), and add `SEC_USER_AGENT` there for exact US results dates (see *Results calendar and analysts*).
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

### How the AI funds learn

Each fund keeps a **playbook** of lessons from its own results, shown on its page under *What it has learned* and given to the AI at every decision.

- **Every idea is graded, not just trades:** trades it made, trades you declined, proposals that expired, orders its limits blocked, stocks it considered but passed on (it lists up to 3 each decision), and its exits, stop-losses and take-profits. A week, a month and a quarter (63 trading days) later, the code measures what the price did, in the idea's direction and against the index. For an exit, it checks whether the stock kept going the position's way (sold too early?), and for stop-losses whether the price recovered (stop too tight?).
- **Graded fairly:** moves include dividends, for the stock and the index, as the fund's cash does (US dividends after the 30% withholding tax on a long; a short pays them), so a buy isn't marked down just because the stock went ex-dividend. The same idea repeated within 5 trading days (say, passing on NVDA at every decision for a week) counts as one idea, keeping its first time and price, so one bet can't make a lesson on its own. The same applies when several funds' ideas are pooled. An idea from before the year of daily prices is left out rather than graded on the wrong days.
- **Nothing learned is lost:** once an idea's month grade is final, it's kept in a compact log with the fund (the latest 2,000 ideas, about 100–140 bytes each, with its thesis; its quarter grade is added when that's in), so lessons survive old decisions being trimmed (the fund keeps its last 500 real decisions; skipped ones don't count towards that) and the year of prices moving on. The public copy of the fund keeps only the latest 200 of these, without each idea's thesis and quarter grade.
- **Beta, fees and peers taken out:** a fund that owns stocks which swing more than the index beats it in a rising week without any skill. So each result is split into three parts: the market's part (the stock's *beta*, how much it has moved with its index over the year before the idea, times the index's move), fees, and what's left, the **stock-specific edge**. Every entry idea is charged a round trip of fees: what a simulator fill actually paid, or for Tiger orders, declined, expired, blocked and passed-on ideas, the fund's fee plan at the order's size (a typical order for ideas passed on). Exits aren't charged again. Each idea is also compared with its peers: the other stocks in its market, and for DBS, OCBC and UOB the other two banks.
- **Separate bets, not cases:** ideas on the same stock and side whose weeks overlap count as one bet, and the uncertainty is worked out week by week, so one market-wide selloff counts once. The fund's universe is small and correlated, so there are far fewer separate bets than ideas.
- **Lessons by rule, only when the evidence is strong:** for example, *ideas you passed on did better than the market explains (119 separate bets, edge +0.8% a week, likely +0.4% to +1.2%)*, *your momentum trades beat the index only because of beta*, *your DBS buys beat the index but lagged OCBC and UOB: right on banks, wrong bank*. Each lesson's edge is an estimate pulled towards zero (a stock-specific edge is rarely beyond ±0.5% a week), with a likely range (an 8-in-10 chance it's inside) and a confidence. A lesson needs at least 8 separate bets, an edge of 0.3% a week or more and a 97% chance that its sign is right; once shown, it stays until that chance falls below 75%, so lessons don't flicker (only a lesson that passed that full test once; see below for older ones). That 97% was set by a check on pure noise (`noiseCheck` in `learning.js`, run by the tests): on 200 made-up funds with no skill, re-checked weekly for half a year, 2% ended up with more than one false lesson and 18% with one (at 90%, a quarter had two or more). The fund's page prints this rate. Expect mostly *Watching* for the first months: patterns on their way (a 70% chance or more) are listed for you only, with about how many more bets they need, and the AI doesn't see them. The AI and the page see each lesson's confidence (*High* from 99%, *Moderate*, or *Fading* while a lesson loses its evidence), its number per week with its likely range, and separate bets; the number says what it measures: the stock-specific edge for most lessons, the result against the index for a *beta-driven* one (whose edge is near zero), against its peers for *right on banks, wrong bank*, or high minus low conviction. Lessons shown before this change keep the old measure (against the index only) for 4 weeks; after that they have to pass the full test like any new lesson. This costs nothing: no AI is involved.
- **A short thesis on every idea, graded for calibration:** with every order and every idea it passes on, the AI says what move it expects in its direction before fees (0 for a sell), over a week, a month or a quarter; the catalyst (results, guidance, a dividend, a rate decision, economic data, a deal, a product, valuation, a chart signal, or none) and its date; what would prove it wrong; and which of its lessons it applied (up to 3, by id). The stop-loss and take-profit it sets are the thesis's exit levels. The code checks two things when the order is made and only notes them: whether the catalyst is more than 10 trading days old (for results, against the results calendar, so last quarter's results count as old), and whether the expected move covers the round-trip fee at that size. Later, each thesis is graded at its own horizon, and the **Calibration** table on the fund's page shows expected against realised by conviction, horizon and catalyst, with the result against the index at 5, 21 and 63 trading days (horizon fit). Whether the catalyst came within the horizon is checked only where code can tell: ex-dividend dates, and results dates where the calendar covers the idea's window (the results before it and the next ones after it are both known), else it's left unknown. Fixed rules turn this into lessons, for example *your buys expected +6.2% over about a month and realised +0.9% (22 separate bets, pooled across the SGD funds): expect less, and size smaller*, *ideas you gave a week paid at a month*, *ideas whose catalyst was 10+ trading days old lagged the index by 2.2%*, *in 7 of 30 orders the expected move didn't cover the round-trip fee*, or *your high-conviction ideas have done worse than your low-conviction ones*. For shorts the words follow the price: *your shorts expected a 4.2% fall and got a 1.6% rise*. Ideas on the same stock and side count as one bet while their windows overlap (a week, a month or a quarter: an idea's own horizon). Judging expected against realised needs 10 separate bets and a gap of 2 points; comparing kinds of ideas needs 8 bets each. Every rule that judges results also needs the gap to be clearly beyond noise (a 99% chance on a t-distribution), measured after the market's part (beta times the index's move) and judged by the calendar weeks the bets started in, so one market-wide selloff that hit ten stocks bought the same week counts once. The same check on pure noise (`calibrationNoiseCheck`, run by the tests) makes up 200 funds whose expected moves were honest, re-checks the rules weekly for half a year and prints the rate on the page: about 11% showed one false calibration lesson and none more than one. The same AI runs every fund, so these are also pooled across the funds in a market (the fund's own lesson comes first). If the expected moves hardly vary (by less than 1 point, e.g. always +5%), the lesson says they're formulaic instead of judging them. At most 3 calibration lessons reach the AI, and you can remove them like any other. Each position on the fund's page shows its thesis, e.g. *expects +6% in a month · results 23 Oct · so far +1.2% · wrong if NIM guidance is cut*, and each decision shows the lessons it applied (a lesson that has since gone is shown with the wording the AI saw). The thesis fields add roughly US$0.40 a month to the AI decisions; grading them costs nothing.
- **Weekly review:** about once a week, after the market closes and only when there are at least 5 newly graded ideas, Claude Haiku reads the numbers and the most telling examples and writes up to 6 sharper lessons. Each review costs well under 1 US cent, and Telegram tells you what it learned.
- **You're in charge:** remove any lesson (and restore it later), or add your own, from the fund's page. A weekly-review lesson you removed stays removed when a later review writes it again in the same words. Lessons never override the hard limits.
- **Market memory**, shared by every fund in a market: how its stocks moved after good or bad company news, and after one-day moves of 4% or more, over the past year, measured from prices. Every daily news summary adds to it at no extra cost. To fill in the past year straight away, run **Actions → Update prices, AI picks and AI fund → Run workflow** with *Learning: look up the past year of news* ticked. That is a one-off costing about US$1–2 (Claude Haiku searches for each stock's main news of the year); running it again only fills gaps. The AI only supplies what happened; the price moves are measured in code, dividends included. News with an exact release time counts from the first session that could react to it: US results out after the 4pm close count from the next day. Where a primary source exists, it replaces what the AI recalled: US results come from the companies' SEC filings (with their exact release time; good or bad by the earnings surprise, and an in-line result within ±2% is left out), and rating changes from Yahoo Finance's dated list. An SGX news date from the AI only counts if that day traded at least 1.8 times the usual volume (the median of the previous 20 sessions); if only the next day did, the news came after the close and counts from that day; otherwise it moves to such a day within 3 sessions, or is dropped. A results date at a quarter's end (the last week of March, June, September or December) is the period's end, not the news, so it's left out even if a nearby volume spike (a rebalance, an ex-date) could have moved it; only an exactly timed release is trusted as it is. An idea made during an ex-dividend session and priced at the day before's close counts that dividend, for the stock and the index. Its lessons go through the same evidence engine as the fund's own: the drift after allowing for each stock's beta, in separate bets (the same stock moving the same way within a week is one), with the uncertainty worked out by date, so one market-wide selloff that hit every stock counts once. It may still favour memorable events, so treat these as tendencies, not rules.
- **Is it working?** Untick *Learns from its results* on one fund to keep it as a control. The leaderboard then shows whether learning helps. It also shows each fund's **beta** (how much its value has moved with its index day to day, from its value after each session) once it has 40 trading days: a fund with a beta above 1 should beat a rising index without any skill, and one below 0 (net short) moves against it.

**Saving AI cost:**
- A fund **skips a decision** when nothing has changed since its last one: no new news or picks, no fills, its stocks within 2.5% and the index within 1%. It skips at most twice in a row. You can turn this off per fund.
- Funds in the same market deciding in the same run on the same model **share a cached copy** of the market data (news, picks and price statistics, most of the prompt). The extra funds pay a tenth of the normal price for it.
- Costs shown count cached input at its real, cheaper rate.

### Results calendar and analysts

Results days are when a stock is most likely to jump or fall overnight, so the app tracks them, and the news the AI reads says how old each story is.

- **What the AI sees:** the stocks reporting in the next 10 trading days, with how much each one's results days have moved it against the index on average (for example *NVDA reports in 2 trading days; its results days moved ±7.8% against SPY*), and any position the fund holds that reports within 3 trading days, with its share of the fund. It's told to size positions for that move. Where Yahoo has them, each stock also shows how many analysts rate it buy, hold or sell, their average price target and how far that is from the price, and the rating changes of the last 10 trading days with the move since.
- **Old news is marked as old:** every news item carries its age, and items more than 10 trading days old are passed as background, not as a fresh reason to trade (the news search sometimes brings back months-old results).
- **On the page:** a *results in N days* tag on the Markets list, your holdings and each fund's positions ("estimate" when the company hasn't confirmed the date; hover for the source), and a *Broker rating changes* list under the market memory, with how each stock has moved since. Only real upgrades and downgrades are listed, not ratings kept or new price targets.
- **Telegram:** the evening before a stock a fund holds reports, a heads-up with the fund's position and the stock's typical results-day move. Only for confirmed dates, never Yahoo's estimates (for SGX stocks these are often a guess from last year).
- **Where the dates come from, best first:** US companies' SEC filings (the results release, with the minute it was filed: out after the 4pm close means the next day trades on it), then the date the company confirmed on Yahoo Finance, then Yahoo's estimate. SGX has no free equivalent of the SEC's filings, so SGX dates come from Yahoo, and the market memory checks past SGX news dates against trading volume.
- **Cost:** nothing extra for the data (Yahoo is asked once a day, one request per stock, and the SEC at most every 2 hours); the extra context adds roughly US$0.20 a month to the AI decisions. If a source fails, the last copy is kept, and without any the dates are simply unknown.

**Optional: US results dates from the SEC.** The SEC's EDGAR system is free and official, but it asks every automated client to say who is calling, with a contact email, and blocks those that don't. Add a repository **variable** (Settings → Secrets and variables → Actions → **Variables** tab, not a secret) named **`SEC_USER_AGENT`**, in the form `Your Name your@email.com`, e.g. `Jane Tan jane.tan@example.com`. It's only sent to the SEC, never stored in the code. Actions logs of a public repository are public and show a variable's value in that step's log; if you'd rather the address stayed out of it, add it as a repository **secret** with the same name instead (secrets are hidden in logs). Without it, the SEC step is skipped and Yahoo's dates are used for US stocks too; with it, the first run also reads the past year's filings. Berkshire Hathaway (BRK-B) publishes its results in its quarterly report, so that is the date used for it.

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

Get a Telegram message when trades are waiting for your approval (with the deadline), orders fill, stop-losses or take-profits trigger, Tiger refuses an order, the fund pauses, an AI decision fails, the monthly AI cap is reached, the fund and your Tiger account disagree, a request you sent from the app doesn't work, or a dividend or split lands, plus a short summary after each trading day's close (value, the day's change, the index and the AI cost), a heads-up the evening before a stock a fund holds reports its results (confirmed dates only), and a line when the catalyst a held position was opened for has passed, with what the AI expected, how it's doing so far and what would prove it wrong.

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

Edit `symbols.json` and push. Use Yahoo Finance tickers: SGX stocks end in `.SI` (DBS is `D05.SI`), and US stocks are plain (`AAPL`, `BRK-B`). Mark index funds with `"etf": true` (they have no results or analysts), and give a US company its SEC number as `"cik"` (10 digits, from [sec.gov/search-filings](https://www.sec.gov/search-filings)) for its results dates from filings.

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
| `actions.js` | Dividends and stock splits, and the dividends counted in graded returns. |
| `benchmark.js` | Comparisons with an index fund bought at the same time. |
| `charts.js`, `history.js` | The charts, and each account's value over time rebuilt from its trades. |
| `scorecard.js` | The AI picks' track record. |
| `spend.js` | The AI's monthly spend and cap. |
| `alerts.js`, `scripts/notify.mjs` | Telegram alerts. |
| `scripts/fund-store.mjs`, `supabase/private-fund.sql` | Keeping the AI fund private in Supabase. |
| `funds.js` | Several AI funds: styles, starting, removing, and sharing one Tiger account. |
| `learning.js` | Grading every idea (repeats merged, fees, the frozen idea log), the rule-made lessons, the check on pure noise, calibration (each thesis against what happened, per fund and pooled per market), the playbook and skipping quiet decisions. |
| `thesis.js` | The AI's thesis on each idea: cleaning it up, stale catalysts, whether the catalyst came in time, and each position's thesis. |
| `stats.js` | The evidence engine behind every lesson: beta, peers, round-trip fees, separate bets, the estimate with its likely range, and the gate. |
| `memory.js`, `scripts/backfill-news.mjs` | The market memory: price moves after news and big moves (SEC filings and Yahoo's rating changes replacing the AI's recollection, SGX dates checked against volume), and the one-off news backfill. |
| `calendar.js`, `scripts/fetch-filings.mjs` | The results calendar: US results releases from SEC filings (`state/results-dates.json`), merged with Yahoo's dates, and each stock's typical results-day move. |
| `analysts.js`, `scripts/company-data.mjs` | Yahoo Finance's company data, once a day (`state/company-data.json`): next results date, earnings surprises, analysts' ratings and targets, and real rating changes. |
| `rules.js` | Auto-trading rules engine and backtester. |
| `fund.js` | The AI fund: budget limit, order execution, protections, decision schedule. |
| `ai.js` | Every Claude call: the Haiku news digest, then picks, strategies and fund decisions, each answered through a validated "submit" tool. |
| `markets.js` | Exchange trading hours, trading days between dates, and which session news released at a given time falls in. |
| `fees.js` | Broker fee plans (Tiger, Standard Chartered, custom) and the fee for each trade. |
| `auth.js`, `login.js`, `config.js` | Sign-in, invites and saving portfolios to Supabase. |
| `supabase/setup.sql` | Database tables, access rules and the invite-only sign-up check. |
| `supabase/fund-control.sql` | Lets admins start, pause, approve and stop the AI fund from the app. |
| `scripts/tiger_broker.py` | Sends the AI fund's orders to Tiger and brings back fills (with `test/test_tiger_broker.py`). |
| `scripts/public-fund.mjs` | Writes the public copy of the AI fund, without your Tiger account details or the idea log's theses. |
| `app.js`, `index.html`, `styles.css` | The web app. |
| `scripts/` | The scheduled jobs: prices (`yahoo_fetch.py` downloads Yahoo's data, including the daily company data with `summary`), AI picks, AI fund. |

Everything here uses virtual money. AI output can be wrong or out of date, and nothing in this app is financial advice.
