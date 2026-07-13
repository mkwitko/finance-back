import { z } from "zod/v4";

// Shared response contract for /auth/google and /auth/refresh. Registered as a
// reusable component so the OpenAPI document emits it as a `$ref` (stable Kubb output).
export const AuthTokensResponse = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.number().int().describe("Access token TTL in seconds"),
});
export type AuthTokensResponse = z.infer<typeof AuthTokensResponse>;

z.globalRegistry.add(AuthTokensResponse, { id: "AuthTokens" });
