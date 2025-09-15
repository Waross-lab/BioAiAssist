// scripts/export_pdf.mjs
// Convert an HTML report to PDF using Puppeteer.
// Usage: node scripts/export_pdf.mjs <report.html> [out.pdf]

import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";

const htmlPath = process.argv[2];
if (!htmlPath) {
  console.error("Usage: node scripts/export_pdf.mjs <report.html> [out.pdf]");
  process.exit(1);
}
const outPdf =
  process.argv[3] ||
  path.join(path.dirname(htmlPath), path.basename(htmlPath).replace(/\.html?$/i, "") + ".pdf");

if (!fs.existsSync(htmlPath)) {
  console.error("HTML not found:", htmlPath);
  process.exit(1);
}

const html = fs.readFileSync(htmlPath, "utf8");

try {
  const browser = await puppeteer.launch({ headless: "new" });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "networkidle0" });
  await page.pdf({
    path: outPdf,
    format: "Letter",
    printBackground: true,
    margin: { top: "12mm", bottom: "12mm", left: "12mm", right: "12mm" },
  });
  await browser.close();
  console.log("Wrote", outPdf);
} catch (err) {
  console.error("PDF export failed:", err?.message || err);
  process.exit(1);
}
