import { describe, expect, it } from "vitest";
import { fetchAttachmentFromPath, isPrivateIp } from "./email-schema";

describe("attachment path SSRF guard", () => {
  it("refuses hostnames that resolve to a private address at connect time", async () => {
    await expect(
      fetchAttachmentFromPath("https://localhost/secret", 0),
    ).rejects.toMatchObject({
      message: expect.stringContaining("private or reserved IP"),
    });
  });

  it("refuses non-https URLs", async () => {
    await expect(
      fetchAttachmentFromPath("http://example.com/a.pdf", 0),
    ).rejects.toMatchObject({ message: expect.stringContaining("https://") });
  });

  it("treats metadata, multicast and benchmark ranges as private", () => {
    expect(isPrivateIp("169.254.169.254")).toBe(true);
    expect(isPrivateIp("198.18.0.1")).toBe(true);
    expect(isPrivateIp("239.1.1.1")).toBe(true);
    expect(isPrivateIp("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateIp("93.184.216.34")).toBe(false);
  });
});
