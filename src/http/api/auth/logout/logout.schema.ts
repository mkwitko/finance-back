import { z } from "zod/v4";

export const LogoutBody = z.object({
  refreshToken: z.string().min(1),
});
export type LogoutBody = z.infer<typeof LogoutBody>;
