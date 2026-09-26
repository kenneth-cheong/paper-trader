# Paper Trader

Practice trading Singapore (SGX) and US stocks with virtual cash, at real market prices, and see whether you end up with a net profit or a net loss.

- **Two cash accounts.** You start with SGD 100,000 for SGX stocks and USD 100,000 for US stocks. You can change both amounts when you reset. Each account's profit or loss is in its own currency, so exchange-rate moves don't count. A third card shows the combined total in SGD at today's rate, for reference only.
- **Net P&L = cash + value of holdings − starting cash.** This is split into *realized* P&L (from shares you've sold, using average cost) and *unrealized* P&L (from shares you still hold).
- **No fees, no shorting, whole shares only.** Orders fill at the latest fetched price. Outside market hours, that's the last close.
- **Your portfolio lives in your browser** (localStorage). Use *Portfolio settings → Export* to back it up or move it to another device, and *Import* to load it.

## How prices work

A GitHub Actions workflow (`.github/workflows/prices.yml`) runs every 15 minutes on weekdays while SGX or US markets are open. Each run:

1. fetches prices for every stock in `symbols.json` from Yahoo Finance's public chart endpoint (no API key),
2. writes `data/prices.json`, and
3. redeploys the site to GitHub Pages.

The page reloads `prices.json` every 5 minutes. Prices can be up to about 20–30 minutes old: Yahoo delays SGX quotes, and GitHub sometimes starts scheduled runs late. If a symbol fails to fetch, its last price is kept and marked "stale".

Until the workflow has run once, the page shows made-up sample prices with a warning banner.

## Setup

1. Create a **public** GitHub repository, e.g. `paper-trader`, and push this folder to its `main` branch. GitHub Pages is free only for public repos. The repo holds no personal data, since trades stay in your browser.
2. In the repo, go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
3. Go to **Actions → Fetch prices and deploy → Run workflow**. When it finishes, the site is at `https://<your-username>.github.io/paper-trader/`.

GitHub turns off scheduled workflows in a public repo after 60 days with no commits. If prices stop updating, re-enable the workflow on the Actions tab or push any commit.

## Adding or removing stocks

Edit `symbols.json` and push. Use Yahoo Finance tickers: SGX stocks end in `.SI` (DBS is `D05.SI`), and US stocks are plain (`AAPL`, `BRK-B`). The push triggers a fresh fetch and deploy.

## Running locally

```sh
npm test                               # portfolio maths + quote parsing
node scripts/fetch-prices.mjs          # optional: fetch real prices into data/prices.json
python3 -m http.server 8000            # then open http://localhost:8000
```

Without `data/prices.json`, the page uses `data/sample-prices.json`. You can regenerate that file with `node scripts/make-sample-prices.mjs`.
