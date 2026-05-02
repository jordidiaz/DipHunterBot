# DipHunterBot

A Telegram bot that sends a daily DCA (Dollar-Cost Averaging) briefing for a personal watchlist of funds and ETFs. For each fund it reports the current price, the drop from its 52-week ATH, and the weekly change — using ISIN as the user-facing identifier and Yahoo Finance as the data source.

## Features

- **ISIN-first input.** Add funds by their ISIN (e.g. `IE00BYX5NX33`); the bot resolves them to a tradable Yahoo symbol automatically.
- **Daily briefing via cron.** A scheduled message is sent every morning to every user with at least one fund configured.
- **On-demand briefing.** `/briefing` returns the same report immediately.
- **Per-user watchlists** stored in MongoDB.
- **Color-coded deltas** (🟢 / 🟡 / 🟠 / 🔴) based on how far each fund is from its 52-week high.

## Commands

| Command | Description |
|---|---|
| `/start` | Register and show the help message. |
| `/add <ISIN>` | Add a fund to your watchlist (e.g. `/add IE00BYX5NX33`). |
| `/remove <ISIN>` | Remove a fund. |
| `/list` | Show your current watchlist as `ISIN (TICKER)`. |
| `/briefing` | Send the briefing right now. |

## How ISIN resolution works

Yahoo Finance's chart endpoint requires a ticker symbol (e.g. `0P0001CLDK.F`), not an ISIN. On `/add` the bot:

1. Validates the input against the ISIN format `^[A-Z]{2}[A-Z0-9]{9}\d$`.
2. Calls Yahoo's search endpoint (`query1.finance.yahoo.com/v1/finance/search?q=<ISIN>`) to get all listings for that ISIN.
3. Walks the candidate symbols in Yahoo's ranked order and picks the first one whose chart endpoint actually returns historical closes (some listings — typically Stuttgart mutual fund codes — exist but carry no timeseries).
4. Stores both the ISIN and the resolved ticker in MongoDB. Briefings use the ticker; `/list` and `/remove` use the ISIN.

## Requirements

- Node.js 18+ (uses top-level `await` and native `fetch`-era axios).
- A Telegram bot token from [@BotFather](https://t.me/BotFather).
- A MongoDB instance (Atlas free tier is enough).

## Setup

```bash
git clone <this-repo>
cd DipHunterBot
npm install
```

Create a `.env` file or export the variables in your shell:

```bash
export BOT_TOKEN="123456:ABC..."           # Telegram bot token
export MONGODB_URI="mongodb+srv://..."     # MongoDB connection string
export CRON_TIME="0 7 * * 1-7"             # Optional, default: 07:00 UTC daily
```

Then run:

```bash
npm start
```

You should see `🤖 Bot arrancado` once Mongo is connected and Telegram polling starts.

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `BOT_TOKEN` | yes | — | Telegram bot token. |
| `MONGODB_URI` | yes | — | MongoDB connection string. |
| `CRON_TIME` | no | `0 7 * * 1-7` | Standard cron expression for the daily briefing (UTC). |

## Data model

A single Mongo collection `users`:

```js
{
  chatId: Number,        // unique
  username: String,
  tickers: [{
    isin:   String,      // e.g. "IE00BYX5NX33"
    ticker: String,      // e.g. "0P0001CLDK.F"
  }],
}
```

## Sample briefing

```
📊 Briefing DCA — viernes, 2 de mayo

IE00BYX5NX33 · 13.12 €
  Desde ATH:  🟢 0.00%
  Semanal:    🟢 +1.24%

IE00B4L5Y983 · 95.40 €
  Desde ATH:  🟡 -3.10%
  Semanal:    🔴 -2.05%
```

## Project layout

Single-file bot:

```
.
├── index.js       # Telegram handlers, Yahoo Finance client, cron, Mongo schema
├── package.json
├── LICENSE
└── README.md
```

## Deployment notes

- The bot uses long polling, so no inbound webhook or public URL is needed.
- Any always-on host works (Fly.io, Railway, a small VPS, a Raspberry Pi).
- The cron schedule runs in the host's UTC clock — adjust `CRON_TIME` if you want local-time delivery.

## License

See [LICENSE](./LICENSE).
