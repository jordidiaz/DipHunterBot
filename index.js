import TelegramBot from "node-telegram-bot-api";
import mongoose from "mongoose";
import axios from "axios";
import cron from "node-cron";

// ─── Config ───────────────────────────────────────────────────────────────────
const BOT_TOKEN   = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const CRON_TIME   = process.env.CRON_TIME || "0 7 * * 1-7"; // Lunes-domingo 7:00 UTC

// ─── MongoDB ──────────────────────────────────────────────────────────────────
await mongoose.connect(MONGODB_URI);

const userSchema = new mongoose.Schema({
  chatId: { type: Number, unique: true },
  username: String,
  tickers: [{
    _id: false,
    isin:   { type: String, required: true },
    ticker: { type: String, required: true },
  }],
});
const User = mongoose.model("User", userSchema);

// ─── Telegram ─────────────────────────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ─── Yahoo Finance ────────────────────────────────────────────────────────────
const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}\d$/;

async function resolveIsin(isin) {
  if (!ISIN_RE.test(isin)) throw new Error("INVALID_ISIN");

  const { data } = await axios.get(
    `https://query1.finance.yahoo.com/v1/finance/search?q=${isin}`,
    { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 10000 }
  );
  const symbols = (data?.quotes ?? []).map(q => q.symbol).filter(Boolean);
  if (!symbols.length) throw new Error("NOT_FOUND");
  return symbols;
}

async function getTickerData(ticker) {
  const now = Math.floor(Date.now() / 1000);
  const oneYearAgo = now - 366 * 24 * 3600;

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1wk&period1=${oneYearAgo}&period2=${now}`;
  const { data } = await axios.get(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    timeout: 10000,
  });

  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`No data for ${ticker}`);

  const closes = result.indicators.quote[0].close.filter(Boolean);
  if (closes.length < 2) throw new Error(`Not enough data for ${ticker}`);

  const currentPrice  = closes[closes.length - 1];
  const prevWeekPrice = closes[closes.length - 2];
  const athPrice      = Math.max(...closes);

  const weekChangePct = ((currentPrice - prevWeekPrice) / prevWeekPrice) * 100;
  const athDropPct    = ((currentPrice - athPrice)      / athPrice)      * 100;

  return { ticker, currentPrice, athPrice, weekChangePct, athDropPct };
}

// ─── Formato mensaje ──────────────────────────────────────────────────────────
function emoji(pct) {
  if (pct >= 0)   return "🟢";
  if (pct >= -5)  return "🟡";
  if (pct >= -15) return "🟠";
  return "🔴";
}

function formatBriefing(results) {
  const date = new Date().toLocaleDateString("es-ES", { weekday:"long", day:"numeric", month:"long" });
  let msg = `📊 *Briefing DCA — ${date}*\n\n`;

  for (const r of results) {
    if (r.error) {
      msg += `❌ *${r.isin}* — no se pudo obtener datos\n\n`;
      continue;
    }
    msg += `*${r.isin}* · ${r.currentPrice.toFixed(2)} €\n`;
    msg += `  Desde ATH:  ${emoji(r.athDropPct)} ${r.athDropPct.toFixed(2)}%\n`;
    msg += `  Semanal:    ${emoji(r.weekChangePct)} ${r.weekChangePct >= 0 ? "+" : ""}${r.weekChangePct.toFixed(2)}%\n\n`;
  }

  return msg;
}

// ─── Enviar briefing a un usuario ─────────────────────────────────────────────
async function sendBriefing(chatId, tickers) {
  if (!tickers.length) {
    return bot.sendMessage(chatId, "No tienes fondos configurados. Usa /add ISIN para añadir uno.");
  }

  const results = await Promise.all(
    tickers.map(t =>
      getTickerData(t.ticker)
        .then(r => ({ ...r, isin: t.isin }))
        .catch(() => ({ ticker: t.ticker, isin: t.isin, error: true }))
    )
  );

  await bot.sendMessage(chatId, formatBriefing(results), { parse_mode: "Markdown" });
}

// ─── Comandos ─────────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  await User.findOneAndUpdate(
    { chatId },
    { chatId, username: msg.from.username },
    { upsert: true }
  );
  bot.sendMessage(chatId,
    `👋 Hola! Soy tu bot de briefing DCA.\n\n` +
    `Comandos disponibles:\n` +
    `/add ISIN — añadir fondo (ej: /add IE00BYX5NX33)\n` +
    `/remove ISIN — eliminar fondo\n` +
    `/list — ver tus fondos\n` +
    `/briefing — recibir briefing ahora`
  );
});

bot.onText(/\/add (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const isin = match[1].trim().toUpperCase();

  let ticker;
  try {
    const candidates = await resolveIsin(isin);
    for (const sym of candidates) {
      try {
        await getTickerData(sym);
        ticker = sym;
        break;
      } catch (e) {
        console.error(`[/add] ${isin} → ${sym} no usable:`, e.message);
      }
    }
    if (!ticker) throw new Error("NO_USABLE_SYMBOL");
  } catch (e) {
    console.error("[/add] failed:", e.message);
    const text = e.message === "INVALID_ISIN"
      ? `❌ *${isin}* no parece un ISIN válido (formato: 2 letras + 9 alfanum + 1 dígito).`
      : `❌ No encontré el ISIN *${isin}* en Yahoo Finance. Revisa que sea correcto.`;
    return bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
  }

  await User.findOneAndUpdate(
    { chatId },
    { $addToSet: { tickers: { isin, ticker } }, $setOnInsert: { username: msg.from.username } },
    { upsert: true }
  );
  bot.sendMessage(chatId, `✅ *${isin}* (${ticker}) añadido a tu lista.`, { parse_mode: "Markdown" });
});

bot.onText(/\/remove (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const isin = match[1].trim().toUpperCase();
  await User.findOneAndUpdate({ chatId }, { $pull: { tickers: { isin } } });
  bot.sendMessage(chatId, `🗑 *${isin}* eliminado.`, { parse_mode: "Markdown" });
});

bot.onText(/\/list/, async (msg) => {
  const chatId = msg.chat.id;
  const user = await User.findOne({ chatId });
  if (!user?.tickers.length) {
    return bot.sendMessage(chatId, "No tienes fondos configurados. Usa /add ISIN.");
  }
  bot.sendMessage(chatId, `📋 Tus fondos:\n${user.tickers.map(t => `• ${t.isin} (${t.ticker})`).join("\n")}`);
});

bot.onText(/\/briefing/, async (msg) => {
  const chatId = msg.chat.id;
  const user = await User.findOne({ chatId });
  await sendBriefing(chatId, user?.tickers || []);
});

// ─── Cron diario ──────────────────────────────────────────────────────────────
cron.schedule(CRON_TIME, async () => {
  const users = await User.find({ tickers: { $not: { $size: 0 } } });
  for (const user of users) {
    await sendBriefing(user.chatId, user.tickers);
  }
});

console.log("🤖 Bot arrancado");
