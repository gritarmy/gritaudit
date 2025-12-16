import fs from "node:fs";
import path from "node:path";
import fetch from "node-fetch";
import { JSDOM } from "jsdom";
import lighthouse from "lighthouse";
import { launch } from "chrome-launcher";
import { PAGES, GOOGLE_SHEETS_WEBHOOK_URL } from "./config.js";

const OUT_DIR = "out";
fs.mkdirSync(OUT_DIR, { recursive: true });

function nowISO() {
  return new Date().toISOString();
}

async function runLighthouse(url, formFactor) {
  const chrome = await launch({
  chromeFlags: ["--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"]
});

  const flags = {
  port: chrome.port,
  output: "json",
  logLevel: "error",
  onlyCategories: ["performance", "accessibility", "best-practices", "seo"],
  emulatedFormFactor: formFactor,
  settings: {
    disableInsights: true
  }
};

  try {
    const result = await lighthouse(url, flags);
    const lhr = result.lhr;

    const scores = {
      performance: Math.round((lhr.categories.performance.score || 0) * 100),
      accessibility: Math.round((lhr.categories.accessibility.score || 0) * 100),
      bestPractices: Math.round((lhr.categories["best-practices"].score || 0) * 100),
      seo: Math.round((lhr.categories.seo.score || 0) * 100)
    };

    const metrics = {
      lcp_ms: lhr.audits["largest-contentful-paint"]?.numericValue ?? null,
      cls: lhr.audits["cumulative-layout-shift"]?.numericValue ?? null,
      tbt_ms: lhr.audits["total-blocking-time"]?.numericValue ?? null,
      speedIndex_ms: lhr.audits["speed-index"]?.numericValue ?? null
    };

    return { scores, metrics, report: lhr };
  } finally {
    await chrome.kill();
  }
}

async function scanPage(url) {
  const res = await fetch(url, { redirect: "follow" });
  const html = await res.text();
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;

  const images = [...doc.querySelectorAll("img")].map(img => {
    const src = img.getAttribute("src") || "";
    const alt = img.getAttribute("alt");
    const width = img.getAttribute("width");
    const height = img.getAttribute("height");
    const loading = img.getAttribute("loading");
    return { src, alt, width, height, loading };
  });

  const missingAltCount = images.filter(i => i.alt === null || i.alt.trim() === "").length;
  const lazyCount = images.filter(i => (i.loading || "").toLowerCase() === "lazy").length;

  const hasSearch = !!doc.querySelector('form[action*="search"], input[type="search"], input[name="q"]');
  const addToCartButtons = [...doc.querySelectorAll("form[action*='cart/add'] button, button[name='add'], button[type='submit']")]
    .map(b => (b.textContent || "").trim().toLowerCase());
  const hasAddToCart = addToCartButtons.some(t => t.includes("add") && t.includes("cart")) || addToCartButtons.length > 0;

  const hasPrice = /\$[\d,.]+/.test(doc.body?.textContent || "");
  const hasShippingText = /(shipping|returns|money[- ]back|guarantee)/i.test(doc.body?.textContent || "");

  return {
    imageCount: images.length,
    missingAltCount,
    lazyCount,
    hasSearch,
    hasAddToCart,
    hasPrice,
    hasShippingText,
    images: images.slice(0, 40)
  };
}

function prioritizeFindings({ lhMobile, scan }) {
  const findings = [];

  if (lhMobile.metrics.lcp_ms !== null && lhMobile.metrics.lcp_ms > 3500) {
    findings.push({
      severity: "HIGH",
      type: "Performance",
      recommendation: `Mobile LCP is ${Math.round(lhMobile.metrics.lcp_ms)}ms. Compress/resize above-the-fold images and reduce heavy sections. Target < 2500ms.`
    });
  }

  if (lhMobile.metrics.cls !== null && lhMobile.metrics.cls > 0.1) {
    findings.push({
      severity: "MED",
      type: "UX / Layout",
      recommendation: `Mobile CLS is ${lhMobile.metrics.cls.toFixed(3)}. Ensure images have width/height set; avoid late-loading banners/popups pushing content. Target < 0.10.`
    });
  }

  if (scan.missingAltCount > 0) {
    findings.push({
      severity: "MED",
      type: "Accessibility / SEO",
      recommendation: `${scan.missingAltCount} images are missing alt text. Add descriptive alt text (especially on product/collection images).`
    });
  }

  if (scan.imageCount > 25 && scan.lazyCount < Math.floor(scan.imageCount * 0.5)) {
    findings.push({
      severity: "MED",
      type: "Images",
      recommendation: `Many images (${scan.imageCount}) but only ${scan.lazyCount} lazy-loaded. Consider enabling lazy-loading for below-the-fold images.`
    });
  }

  if (scan.hasAddToCart && !scan.hasShippingText) {
    findings.push({
      severity: "LOW",
      type: "Trust / Conversion",
      recommendation: `Page appears to have Add-to-Cart but little visible shipping/returns/guarantee text. Consider adding a short trust row near the ATC (shipping + guarantee).`
    });
  }

  return findings;
}

function renderHtmlReport(report) {
  const rows = report.pages.map(p => `
    <tr>
      <td>${p.url}</td>
      <td>${p.mobile.scores.performance}</td>
      <td>${p.mobile.scores.accessibility}</td>
      <td>${p.mobile.scores.bestPractices}</td>
      <td>${p.mobile.scores.seo}</td>
      <td>${Math.round(p.mobile.metrics.lcp_ms ?? 0)}</td>
      <td>${(p.mobile.metrics.cls ?? 0).toFixed(3)}</td>
    </tr>
  `).join("");

  const findings = report.pages.flatMap(p =>
    p.findings.map(f => `<li><b>[${f.severity}]</b> ${p.url} — ${f.type}: ${f.recommendation}</li>`).join("")
  ).join("");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>GritAudit Weekly Report</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; }
    table { border-collapse: collapse; width: 100%; margin-top: 12px; }
    th, td { border: 1px solid #ddd; padding: 8px; font-size: 14px; }
    th { background: #f6f6f6; text-align: left; }
    .small { color:#555; font-size: 13px; }
  </style>
</head>
<body>
  <h1>GritAudit Weekly Report</h1>
  <div class="small">Generated: ${report.generatedAt}</div>

  <h2>Summary Table (Mobile)</h2>
  <table>
    <thead>
      <tr>
        <th>URL</th>
        <th>Perf</th>
        <th>A11y</th>
        <th>BP</th>
        <th>SEO</th>
        <th>LCP (ms)</th>
        <th>CLS</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>

  <h2>Prioritized Recommendations</h2>
  <ul>${findings || "<li>No major issues flagged by rules this run.</li>"}</ul>

</body>
</html>`;
}

async function postToGoogleSheets(payload) {
  if (!GOOGLE_SHEETS_WEBHOOK_URL) return;
  try {
    await fetch(GOOGLE_SHEETS_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.error("Google Sheets webhook error:", e);
  }
}

async function main() {
  const report = { generatedAt: nowISO(), pages: [] };

  for (const url of PAGES) {
    console.log("Auditing:", url);

    const [lhMobile, lhDesktop, scan] = await Promise.all([
      runLighthouse(url, "mobile"),
      runLighthouse(url, "desktop"),
      scanPage(url)
    ]);

    const findings = prioritizeFindings({ lhMobile, scan });

    report.pages.push({
      url,
      mobile: { scores: lhMobile.scores, metrics: lhMobile.metrics },
      desktop: { scores: lhDesktop.scores, metrics: lhDesktop.metrics },
      scan,
      findings
    });
  }

  fs.mkdirSync("out", { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "gritaudit-report.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, "gritaudit-report.html"), renderHtmlReport(report));

  const sheetRows = report.pages.map(p => ({
    date: report.generatedAt,
    url: p.url,
    perf_mobile: p.mobile.scores.performance,
    a11y_mobile: p.mobile.scores.accessibility,
    bp_mobile: p.mobile.scores.bestPractices,
    seo_mobile: p.mobile.scores.seo,
    lcp_ms: p.mobile.metrics.lcp_ms,
    cls: p.mobile.metrics.cls,
    key_findings: p.findings.slice(0, 2).map(f => `[${f.severity}] ${f.type}`).join(" | ")
  }));

  await postToGoogleSheets({ rows: sheetRows });

  console.log("Done. Reports in /out");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
