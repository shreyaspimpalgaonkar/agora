// Open the public URL like a first-time visitor with the share link and check that live updates work.
import { chromium } from "playwright";
import fs from "node:fs";
const [url, keyKind = "viewer", out] = process.argv.slice(2);
const keys = JSON.parse(fs.readFileSync(new URL("../.data/keys.json", import.meta.url), "utf8"));
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
await page.goto(`${url}/?key=${keys[keyKind]}`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(9000);
const conn = await page.textContent(".conn").catch(() => null);
const title = await page.textContent("h1").catch(() => null);
const posts1 = await page.locator(".post").count();
await page.waitForTimeout(20000);
const lastEvent = await page.evaluate(() => document.querySelector(".ticker-track")?.textContent?.slice(0, 120));
console.log(JSON.stringify({ url: page.url(), conn, title, posts1, lastEvent, errs }, null, 1));
if (out) await page.screenshot({ path: out });
await browser.close();
