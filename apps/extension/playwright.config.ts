import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: "./test", timeout: 30_000, workers: 1, reporter: [["list"]] });
