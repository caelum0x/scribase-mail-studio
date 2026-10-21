import { describe, expect, it } from "vitest";
import { EmailRenderer } from "@usesend/email-editor/src/renderer";

/**
 * button/logo nodes historically stored alignment under `alignment`, unlike
 * paragraph/heading which use `textAlign`. The renderer now prefers
 * `textAlign` (so new/imported content matches the rest of the editor) but
 * still reads `alignment` for templates saved before this change. Closes
 * https://github.com/caelum0x/scribase-mail-studio/issues/2.
 */
describe("button/logo node alignment", () => {
  it("renders a button's canonical textAlign attribute", async () => {
    const renderer = new EmailRenderer({
      type: "doc",
      content: [
        {
          type: "button",
          attrs: { text: "Click", url: "https://example.com", textAlign: "right" },
        },
      ],
    });

    const html = await renderer.render();

    expect(html).toContain("text-align:right");
  });

  it("still renders a button saved with the legacy alignment attribute", async () => {
    const renderer = new EmailRenderer({
      type: "doc",
      content: [
        {
          type: "button",
          attrs: { text: "Click", url: "https://example.com", alignment: "center" },
        },
      ],
    });

    const html = await renderer.render();

    expect(html).toContain("text-align:center");
  });

  it("defaults a button with neither attribute to left", async () => {
    const renderer = new EmailRenderer({
      type: "doc",
      content: [
        { type: "button", attrs: { text: "Click", url: "https://example.com" } },
      ],
    });

    const html = await renderer.render();

    expect(html).toContain("text-align:left");
  });

  it("renders a logo's canonical textAlign attribute", async () => {
    const renderer = new EmailRenderer({
      type: "doc",
      content: [
        {
          type: "logo",
          attrs: { src: "https://example.com/logo.png", textAlign: "right" },
        },
      ],
    });

    const html = await renderer.render();

    expect(html).toContain('align="right"');
  });

  it("still renders a logo saved with the legacy alignment attribute", async () => {
    const renderer = new EmailRenderer({
      type: "doc",
      content: [
        {
          type: "logo",
          attrs: { src: "https://example.com/logo.png", alignment: "center" },
        },
      ],
    });

    const html = await renderer.render();

    expect(html).toContain('align="center"');
  });
});
