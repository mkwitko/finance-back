// Dummy env for e2e boot. Override DATABASE_URL with a real Testcontainers URI for
// DB-backed tests. Call BEFORE importing src/app.ts so the lazy env cache picks it up.
export function setTestEnv(overrides: Record<string, string> = {}): void {
  Object.assign(process.env, {
    NODE_ENV: "test",
    PORT: "3000",
    LOG_LEVEL: "silent",
    TRUST_PROXY_HOPS: "1",
    DATABASE_URL: "postgres://finance:finance@localhost:5432/finance",
    DATABASE_POOL_MAX: "5",
    JWT_SECRET: "test-secret-at-least-16-chars-long",
    ACCESS_TOKEN_TTL_SECONDS: "900",
    REFRESH_TOKEN_TTL_SECONDS: "2592000",
    GOOGLE_CLIENT_IDS: "test-client-id.apps.googleusercontent.com",
    ...overrides,
  });
}
