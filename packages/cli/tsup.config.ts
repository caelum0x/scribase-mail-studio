import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  target: "node22",
  banner: { js: "#!/usr/bin/env node" },
  clean: true,
  dts: false,
});
