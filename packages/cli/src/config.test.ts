/**
 * CLI config tests.
 * Uses vitest; run with: pnpm --filter @scribase-mail/cli test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { writeConfig, readConfig, getApiKey, requireApiKey, CONFIG_FILE } from "./config.js";

vi.mock("node:fs");

const mockedFs = vi.mocked(fs);

describe("config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env["SCRIBASE_MAIL_API_KEY"];
    delete process.env["RESEND_API_KEY"];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writeConfig writes JSON and sets mode 600", () => {
    mockedFs.mkdirSync.mockImplementation(() => undefined);
    mockedFs.writeFileSync.mockImplementation(() => undefined);
    mockedFs.chmodSync.mockImplementation(() => undefined);

    writeConfig({ apiKey: "test_key_123" });

    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      CONFIG_FILE,
      expect.stringContaining('"test_key_123"'),
    );
    expect(mockedFs.chmodSync).toHaveBeenCalledWith(CONFIG_FILE, 0o600);
  });

  it("readConfig returns empty object when file does not exist", () => {
    mockedFs.existsSync.mockReturnValue(false);
    const config = readConfig();
    expect(config).toEqual({});
  });

  it("readConfig parses the JSON file", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({ apiKey: "stored_key" }),
    );
    const config = readConfig();
    expect(config.apiKey).toBe("stored_key");
  });

  it("readConfig returns empty object on malformed JSON", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue("not-json");
    const config = readConfig();
    expect(config).toEqual({});
  });

  it("getApiKey returns env var first", () => {
    process.env["SCRIBASE_MAIL_API_KEY"] = "env_key";
    mockedFs.existsSync.mockReturnValue(false);
    expect(getApiKey()).toBe("env_key");
  });

  it("getApiKey falls back to RESEND_API_KEY", () => {
    process.env["RESEND_API_KEY"] = "resend_key";
    mockedFs.existsSync.mockReturnValue(false);
    expect(getApiKey()).toBe("resend_key");
  });

  it("getApiKey returns undefined when nothing is set", () => {
    mockedFs.existsSync.mockReturnValue(false);
    expect(getApiKey()).toBeUndefined();
  });

  it("requireApiKey throws when no key is available", () => {
    mockedFs.existsSync.mockReturnValue(false);
    expect(() => requireApiKey()).toThrow(/API key/);
  });

  it("requireApiKey returns the key when available", () => {
    process.env["SCRIBASE_MAIL_API_KEY"] = "present_key";
    mockedFs.existsSync.mockReturnValue(false);
    expect(requireApiKey()).toBe("present_key");
  });
});
