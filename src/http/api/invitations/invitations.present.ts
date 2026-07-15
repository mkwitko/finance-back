import type { Invitation } from "./invitations.repository.js";
import type { InvitationView } from "./invitations.schema.js";

export const JOIN_LINK = "financeapp://join/";

export function present(inv: Invitation, baseUrl: string): InvitationView {
  return { ...inv, url: `${baseUrl}${inv.code}` };
}
