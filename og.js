// Regenerates og.png from the page's own recap card: node og.js  (needs playwright + chromium)
const { chromium } = require("playwright"); const fs = require("fs"); const path = require("path");
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1400, height: 1000 } }); await p.addInitScript(() => { try { sessionStorage.setItem("twenty-intro", "1"); } catch (e) {} });
  await p.setContent(fs.readFileSync(path.join(__dirname, "index.html"), "utf8"), { waitUntil: "load" }); await p.waitForTimeout(1500);
  await p.evaluate(() => { location.hash = "#standings"; }); await p.waitForTimeout(900); await p.click('[data-recap="1"]'); await p.waitForTimeout(600);
  const data = await p.evaluate(() => document.getElementById("recap-cv").toDataURL("image/png"));
  fs.writeFileSync(path.join(__dirname, "og.png"), Buffer.from(data.split(",")[1], "base64")); await b.close(); console.log("og.png written");
})();
