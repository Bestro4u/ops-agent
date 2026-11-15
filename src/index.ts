/**
 * Telegram mode: the bot, plus the watchdog on a timer.
 *
 *   npm start
 */
import { createApp } from "./app.js";
import { createTelegramBot } from "./bot/telegram.js";
import { loadEnv } from "./config.js";
import { Watchdog, type Check } from "./watchdog/watchdog.js";

const env = loadEnv();
if (!env.TELEGRAM_BOT_TOKEN || !env.OWNER_CHAT_ID) {
  console.error("Telegram mode needs TELEGRAM_BOT_TOKEN and OWNER_CHAT_ID in .env. To try it without Telegram: npm run chat");
  process.exit(1);
}

const app = createApp(env);
const ownerId = env.OWNER_CHAT_ID;
const bot = createTelegramBot(app, env.TELEGRAM_BOT_TOKEN, ownerId);

const telegramCheck: Check = async () => {
  try {
    const me = await bot.api.getMe();
    return { name: "Telegram", ok: true, detail: `connected as @${me.username}` };
  } catch (err) {
    return { name: "Telegram", ok: false, detail: (err as Error).message };
  }
};

const watchdog = new Watchdog(
  app.store,
  async (text) => {
    await bot.api.sendMessage(ownerId, text);
  },
  [...app.checks, telegramCheck],
);

setInterval(() => {
  void watchdog.sweep().then((r) => {
    console.log(`[watchdog] ${r.passed.length} ok${r.failing.length ? `, failing: ${r.failing.join(", ")}` : ""}`);
  });
}, env.WATCHDOG_MINUTES * 60_000);

await bot.start({
  onStart: (me) => console.log(`Running as @${me.username}. Model: ${app.providers.spec().label} (${app.failover.activeModel()}).`),
});
