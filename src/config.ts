import "dotenv/config";
import { z } from "zod";

const csv = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined));

const EnvSchema = z.object({
  GEMINI_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  LLM_PROVIDER: z.enum(["gemini", "openrouter", "openai"]).optional(),
  GEMINI_MODELS: csv,
  OPENROUTER_MODELS: csv,
  OPENAI_MODELS: csv,
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  OWNER_CHAT_ID: z.coerce.number().int().optional(),
  STATE_FILE: z.string().default("data/state.json"),
  WATCHDOG_MINUTES: z.coerce.number().positive().default(15),
  MAX_ITERATIONS: z.coerce.number().int().positive().default(12),
});

export type Env = z.infer<typeof EnvSchema>;

/** Empty strings in .env mean "not set". */
function clean(raw: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined && v !== "")) as Record<string, string>;
}

export function loadEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(clean(raw));
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid environment variables: ${fields}. See .env.example.`);
  }
  return parsed.data;
}
