import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";

// Ensure OCI env vars are NOT set so we exercise the local-disk fallback.
beforeEach(() => {
  delete process.env.OCI_STORAGE_NAMESPACE;
  delete process.env.OCI_STORAGE_BUCKET;
  delete process.env.OCI_PRIVATE_KEY;
  delete process.env.OCI_PRIVATE_KEY_PATH;
  process.env.INBOUND_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "scribase-test-"));
});

afterEach(() => {
  const dir = process.env.INBOUND_STORAGE_DIR;
  if (dir) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  delete process.env.INBOUND_STORAGE_DIR;
});

describe("storeObject (local-disk fallback)", () => {
  it("writes data to disk and returns the key", async () => {
    // Import after env is set so the module reads updated env
    const { storeObject } = await import("./storage");
    const key = "inbound/raw/test-email.eml";
    const data = Buffer.from("From: test@example.com\r\n\r\nHello");

    const returned = await storeObject(key, data, "message/rfc822");

    expect(returned).toBe(key);
    const fullPath = path.join(process.env.INBOUND_STORAGE_DIR!, key);
    expect(fs.existsSync(fullPath)).toBe(true);
    expect(fs.readFileSync(fullPath)).toEqual(data);
  });

  it("creates nested directories automatically", async () => {
    const { storeObject } = await import("./storage");
    const key = "inbound/attachments/2026/01/file.pdf";
    const data = Buffer.from("%PDF-1.4 test");

    await storeObject(key, data, "application/pdf");

    const fullPath = path.join(process.env.INBOUND_STORAGE_DIR!, key);
    expect(fs.existsSync(fullPath)).toBe(true);
  });
});
