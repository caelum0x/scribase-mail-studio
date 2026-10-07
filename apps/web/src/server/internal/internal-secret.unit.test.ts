import { describe, expect, it } from "vitest";
import { checkInternalSecret } from "./internal-secret";

const req = (secret?: string) =>
  new Request("http://x/api/internal/inbound", {
    headers: secret ? { "X-Internal-Secret": secret } : {},
  });

describe("checkInternalSecret", () => {
  it("refuses every request when no secret is configured", () => {
    expect(checkInternalSecret(req(), "")?.status).toBe(503);
    expect(checkInternalSecret(req("anything"), undefined)?.status).toBe(503);
  });

  it("rejects a missing or wrong secret", () => {
    expect(checkInternalSecret(req(), "s3cret")?.status).toBe(401);
    expect(checkInternalSecret(req("wrong!"), "s3cret")?.status).toBe(401);
    expect(checkInternalSecret(req("s3cre"), "s3cret")?.status).toBe(401);
  });

  it("accepts the right secret", () => {
    expect(checkInternalSecret(req("s3cret"), "s3cret")).toBeNull();
  });
});
