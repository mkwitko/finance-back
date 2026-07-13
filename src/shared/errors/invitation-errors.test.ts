import { describe, expect, it } from "vitest";
import { ERRORS } from "./catalog.js";

describe("invitation/member errors", () => {
  it("expose the new codes with correct status", () => {
    expect(ERRORS.HOUSEHOLD.LAST_OWNER().statusCode).toBe(409);
    expect(ERRORS.INVITATION.NOT_FOUND().statusCode).toBe(404);
    expect(ERRORS.INVITATION.EXPIRED().statusCode).toBe(410);
    expect(ERRORS.INVITATION.ALREADY_MEMBER().statusCode).toBe(409);
    expect(ERRORS.INVITATION.ROLE_TOO_HIGH().statusCode).toBe(403);
  });
});
