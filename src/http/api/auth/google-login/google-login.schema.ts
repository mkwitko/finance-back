import { z } from "zod/v4";

export const GoogleLoginBody = z.object({
  idToken: z
    .string()
    .min(1)
    .describe("Google ID token obtained by the mobile app via Google Sign-In"),
});
export type GoogleLoginBody = z.infer<typeof GoogleLoginBody>;
