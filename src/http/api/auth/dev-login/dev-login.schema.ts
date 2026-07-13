import { z } from "zod/v4";

export const DevLoginBody = z.object({
  email: z.email().describe("Any email — provisions/logs in a dev user (development only)"),
  name: z.string().min(1).max(255).optional(),
});
export type DevLoginBody = z.infer<typeof DevLoginBody>;
