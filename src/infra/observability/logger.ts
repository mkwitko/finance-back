import { pino } from "pino";
import { env } from "../../config/env.js";

// Structured logs (Pino). Never `console.log`. Handlers use `req.log` (carries the
// request id); services/gateways import this singleton.
export const logger = pino({
  level: env.LOG_LEVEL,
  // Secrets never reach the logs.
  redact: {
    paths: [
      "req.headers.authorization",
      "*.idToken",
      "*.accessToken",
      "*.refreshToken",
      "*.password",
      "*.token",
    ],
    remove: true,
  },
  ...(env.NODE_ENV === "development"
    ? { transport: { target: "pino-pretty", options: { translateTime: "SYS:standard" } } }
    : {}),
});
