import { describe, expect, it } from "vitest";
import { createInvitationsRepository } from "./invitations.repository.js";

describe("createInvitationsRepository", () => {
  it("exposes the invitations interface", () => {
    const repo = createInvitationsRepository({} as never);
    expect(typeof repo.create).toBe("function");
    expect(typeof repo.listActive).toBe("function");
    expect(typeof repo.findActiveByCode).toBe("function");
    expect(typeof repo.revoke).toBe("function");
  });
});
