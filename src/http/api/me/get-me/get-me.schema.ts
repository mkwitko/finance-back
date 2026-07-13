import { z } from "zod/v4";

export const MeResponse = z.object({
  id: z.uuid().describe("Public user id"),
  email: z.string(),
  name: z.string(),
  picture: z.string().nullable(),
  emailVerified: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MeResponse = z.infer<typeof MeResponse>;
