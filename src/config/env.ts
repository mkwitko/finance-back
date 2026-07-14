import { z } from "zod/v4";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "staging", "production", "test"]),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(1),

  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),

  // App JWT. HS256 secret to start; RS256 (key pair) is the documented future option.
  JWT_SECRET: z.string().min(16),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().min(3600).default(2_592_000),

  // Comma-separated list of accepted Google OAuth client IDs (token audience).
  GOOGLE_CLIENT_IDS: z.string().min(1),

  // Deepseek (AI categorization / planning / chat). Optional: when the key is absent
  // the gateway degrades to a no-op (imports still persist, just uncategorized), so
  // local dev and tests run without an external dependency.
  DEEPSEEK_API_KEY: z.string().optional(),
  DEEPSEEK_BASE_URL: z.string().default("https://api.deepseek.com"),
  DEEPSEEK_MODEL: z.string().default("deepseek-chat"),

  // Stripe billing. Empty by default so local dev / tests boot without real keys;
  // the Stripe gateway degrades (throws a typed error) when the secret is empty.
  STRIPE_SECRET_KEY: z.string().default(""),
  STRIPE_PUBLISHABLE_KEY: z.string().default(""),
  STRIPE_PRICE_PREMIUM_MONTHLY: z.string().default(""),
  STRIPE_PRICE_PREMIUM_ANNUAL: z.string().default(""),

  CORS_ALLOWED_ORIGINS: z.string().optional(),

  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).default(60_000),
});

export type EnvConfig = z.infer<typeof EnvSchema>;

// Zod is the source of truth. env always arrives as string: `z.coerce.*` converts
// to number, `.default()` fills the missing ones. `safeParse` aggregates the errors
// into a single report so a boot fails fast with everything wrong listed at once.
export function parseEnv(raw: Record<string, string | undefined>): EnvConfig {
  const result = EnvSchema.safeParse(raw);
  if (!result.success) {
    const msg = result.error.issues.map((e) => `${e.path.join(".")} ${e.message}`).join("; ");
    throw new Error(`Invalid env: ${msg}`);
  }
  return result.data;
}

// Lazy singleton: validated on the FIRST access to `env`, not at import — so tests
// that set process.env before importing (or that only call `parseEnv`) don't break
// at import-time.
let cached: EnvConfig | undefined;
export const env: EnvConfig = new Proxy({} as EnvConfig, {
  get(_target, prop) {
    if (!cached) cached = parseEnv(process.env as Record<string, string | undefined>);
    return (cached as Record<string | symbol, unknown>)[prop];
  },
});

/** Parsed list of accepted Google OAuth client IDs. */
export function googleClientIds(): string[] {
  return env.GOOGLE_CLIENT_IDS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
