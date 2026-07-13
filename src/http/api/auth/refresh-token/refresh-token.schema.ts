import { z } from "zod/v4";

export const RefreshTokenBody = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshTokenBody = z.infer<typeof RefreshTokenBody>;
