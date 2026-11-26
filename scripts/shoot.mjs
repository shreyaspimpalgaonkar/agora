// Screenshot Agora pages for QA. Usage:
//   node scripts/shoot.mjs <outDir> [width] [height] [theme] [path ...]
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const [outDir = "/tmp/agora-shots", w = "1440", h = "900", theme = "light", ...paths] = process.argv.slice(2);
const keys = JSON.parse(fs.readFileSync(new URL("../.data/keys.json", import.meta.url), "utf8"));
const base = process.env.AGORA_URL ?? "http://127.0.0.1:4410";
const pages = paths.length ? paths : ["/", "/board", "/agents", "/coordination", "/problems", "/subscriptions", "/system"];
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: Number(w), height: Number(h) }, deviceScaleFactor: 1, colorScheme: theme === "dark" ? "dark" : "light" });
await ctx.addCookies([{ name: "agora_key", value: keys.admin, url: base }]);
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
for (const p of pages) {
  await page.goto(base + p, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(Number(process.env.WAIT ?? 3500));
  const name = (p === "/" ? "overview" : p.replace(/^\//, "").replace(/[/?=&]/g, "_")) + `-${w}-${theme}.png`;
  if (process.env.FULL !== "0") {
    // Grow the viewport instead of using fullPage capture (vh-sized sticky columns make that unstable).
    const hgt = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width: Number(w), height: Math.min(Number(process.env.MAXH ?? 3200), hgt) });
    await page.waitForTimeout(600);
  }
  await page.screenshot({ path: path.join(outDir, name), timeout: 60_000 });
  await page.setViewportSize({ width: Number(w), height: Number(h) });
  console.log("shot", name);
}
if (errors.length) console.log("ERRORS:\n" + [...new Set(errors)].join("\n"));
await browser.close();
