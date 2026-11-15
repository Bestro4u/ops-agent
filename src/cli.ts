/**
 * Terminal mode: the same agent, tools and approval gate, without Telegram.
 * Approval cards become a y/N question after each reply.
 *
 *   npm run chat
 *
 * Input is read through a line queue, so it works typed by hand or piped in
 * (lines that arrive while the agent is thinking are kept, not dropped).
 */
import { createInterface } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { createApp } from "./app.js";
import type { ApprovalRecord } from "./gate/gate.js";
import { Watchdog } from "./watchdog/watchdog.js";

const app = createApp();
const waiting: ApprovalRecord[] = [];
app.gate.setNotifier({ requestApproval: async (r) => void waiting.push(r) });
const watchdog = new Watchdog(app.store, async (text) => console.log(`[watchdog] ${text}`), app.checks);

const rl = createInterface({ input, terminal: Boolean(input.isTTY) });
const queued: string[] = [];
const waiters: ((line: string | null) => void)[] = [];
let closed = false;
rl.on("line", (line) => {
  const waiter = waiters.shift();
  if (waiter) waiter(line);
  else queued.push(line);
});
rl.on("close", () => {
  closed = true;
  while (waiters.length) waiters.shift()!(null);
});

/** The next line of input, or null once input has ended. */
function prompt(text: string): Promise<string | null> {
  output.write(text);
  if (queued.length) return Promise.resolve(queued.shift()!);
  if (closed) return Promise.resolve(null);
  return new Promise((resolve) => waiters.push(resolve));
}

console.log(`ops-agent, terminal mode. Model: ${app.providers.spec().label} (${app.failover.activeModel()}).`);
console.log(`Try: "what's due today?", "log an email to L-002", "delete L-005", "mark L-001 to L-012 as lost".`);
console.log(`Commands: /check runs the watchdog once, /quit exits.\n`);

for (;;) {
  const line = await prompt("you> ");
  if (line === null || line.trim() === "/quit") break;
  const text = line.trim();
  if (!text) continue;

  if (text === "/check") {
    const r = await watchdog.sweep();
    console.log(`passing: ${r.passed.join(", ") || "none"}; failing: ${r.failing.join(", ") || "none"}${r.fixes.length ? `; fixed: ${r.fixes.join(", ")}` : ""}\n`);
    continue;
  }

  console.log(`\nagent> ${await app.ask(1, text)}\n`);

  while (waiting.length) {
    const r = waiting.shift()!;
    const answer = ((await prompt(`Approval needed: ${r.summary}\nApprove? [y/N] `)) ?? "").trim().toLowerCase();
    const result = await app.gate.resolve(r.id, answer.startsWith("y") ? "ok" : "no");
    console.log(`${result.text}\n`);
  }
}
rl.close();
