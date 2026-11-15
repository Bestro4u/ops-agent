/**
 * Telegram front end. One owner only: messages from anyone else are ignored,
 * and approval cards go to the owner's chat.
 */
import { Bot, InlineKeyboard } from "grammy";
import type { App } from "../app.js";
import { PROVIDER_IDS, isProviderId } from "../llm/providers.js";

const TELEGRAM_LIMIT = 4000;

export function chunks(text: string, size = TELEGRAM_LIMIT): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [""];
}

export function createTelegramBot(app: App, token: string, ownerId: number): Bot {
  const bot = new Bot(token);

  app.gate.setNotifier({
    requestApproval: async (r) => {
      const keyboard = new InlineKeyboard().text("Approve", `ap:ok:${r.id}`).text("Reject", `ap:no:${r.id}`);
      await bot.api.sendMessage(ownerId, `Approval needed: ${r.tool}\n\n${r.summary.slice(0, 3500)}`, { reply_markup: keyboard });
    },
  });

  bot.use(async (ctx, next) => {
    if (ctx.from?.id === ownerId) await next();
  });

  bot.command("start", (ctx) =>
    ctx.reply("Ask me what's due today, to log a touch, or to look up a lead. /provider shows or changes the AI model. /reset clears this chat."),
  );

  bot.command("reset", async (ctx) => {
    app.reset(ctx.chat.id);
    await ctx.reply("Chat cleared.");
  });

  bot.command("provider", async (ctx) => {
    const wanted = ctx.match.trim();
    if (!wanted) {
      const list = PROVIDER_IDS.map((id) => `${id}${app.providers.isConfigured(id) ? "" : " (no key)"}`).join(", ");
      return ctx.reply(`Now: ${app.providers.spec().label}, ${app.failover.activeModel()}. Choose with /provider <name>: ${list}.`);
    }
    if (!isProviderId(wanted)) return ctx.reply(`Unknown provider. Choose one of: ${PROVIDER_IDS.join(", ")}.`);
    const err = app.failover.switchProvider(wanted);
    if (err) return ctx.reply(err);
    // A person's choice beats the automatic switch-back.
    app.autoswitch.clear();
    return ctx.reply(`Switched to ${app.providers.spec().label}.`);
  });

  bot.callbackQuery(/^ap:(ok|no):([a-f0-9]{10})$/, async (ctx) => {
    const [, decision, id] = ctx.match as RegExpMatchArray;
    await ctx.answerCallbackQuery({ text: decision === "ok" ? "Running..." : "Rejected" });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    const result = await app.gate.resolve(id!, decision as "ok" | "no");
    await ctx.reply(result.text.slice(0, TELEGRAM_LIMIT));
  });

  bot.on("message:text", async (ctx) => {
    await ctx.replyWithChatAction("typing");
    const reply = await app.ask(ctx.chat.id, ctx.message.text);
    for (const part of chunks(reply)) await ctx.reply(part);
  });

  bot.catch((err) => console.error("[telegram]", err.message));
  return bot;
}
