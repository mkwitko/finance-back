import { z } from "zod/v4";
import { ACCOUNT_KINDS } from "../../../domain/enums.js";

export const CreateAccountBody = z.object({
  name: z.string().min(1).max(255),
  kind: z.enum(ACCOUNT_KINDS),
  institution: z.string().max(255).nullish(),
  currency: z.string().length(3).default("BRL"),
});
export type CreateAccountBody = z.infer<typeof CreateAccountBody>;

export const AccountView = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: z.enum(ACCOUNT_KINDS),
  institution: z.string().nullable(),
  currency: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AccountView = z.infer<typeof AccountView>;

export const ListAccountsResponse = z.object({
  accounts: z.array(AccountView),
});
