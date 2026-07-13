import { z } from "zod/v4";

export const ListUsersQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListUsersQuery = z.infer<typeof ListUsersQuery>;

export const UserSummary = z.object({
  id: z.uuid(),
  email: z.string(),
  name: z.string(),
  emailVerified: z.boolean(),
  createdAt: z.string(),
});

export const ListUsersResponse = z.object({
  users: z.array(UserSummary),
});
export type ListUsersResponse = z.infer<typeof ListUsersResponse>;
