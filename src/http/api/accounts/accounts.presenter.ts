import type { Account } from "./accounts.repository.js";
import type { AccountView } from "./accounts.schema.js";

export function present(a: Account): AccountView {
  return {
    id: a.uuid,
    name: a.name,
    kind: a.kind,
    institution: a.institution,
    currency: a.currency,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}
