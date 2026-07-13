import { describe, expect, it, vi } from "vitest";
import { createMembersRepository } from "./members.repository.js";

describe("createMembersRepository", () => {
  it("exposes the member-management interface", () => {
    const repo = createMembersRepository({} as never);
    expect(typeof repo.listMembers).toBe("function");
    expect(typeof repo.countOwners).toBe("function");
    expect(typeof repo.findMember).toBe("function");
    expect(typeof repo.updateRole).toBe("function");
    expect(typeof repo.removeMember).toBe("function");
  });
});
