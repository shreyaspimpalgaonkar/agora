import { chromium } from "playwright";
import fs from "node:fs";
const keys = JSON.parse(fs.readFileSync(new URL("../.data/keys.json", import.meta.url), "utf8"));
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addCookies([{ name: "agora_key", value: keys.admin, url: "http://127.0.0.1:4410" }]);
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("pageerror", e.message));
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log("console", m.type(), m.text().slice(0, 300)); });
await page.goto("http://127.0.0.1:4410" + (process.argv[2] ?? "/board"), { waitUntil: "domcontentloaded" });
for (let i = 0; i < 6; i++) {
  await page.waitForTimeout(1500);
  const t0 = Date.now();
  const r = await Promise.race([page.evaluate(() => ({ h: document.body.scrollHeight, posts: document.querySelectorAll(".post").length })), new Promise((res) => setTimeout(() => res("TIMEOUT"), 5000))]);
  console.log(i, JSON.stringify(r), Date.now() - t0, "ms");
}
await browser.close();
