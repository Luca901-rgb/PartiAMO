const fs = require("fs");
const path = require("path");

const homePath = path.join(__dirname, "..", "public", "home.js");
const singlePath = path.join(__dirname, "home-render-single.txt");

let s = fs.readFileSync(homePath, "utf8");
const single = fs.readFileSync(singlePath, "utf8");

const start = s.indexOf("function renderSingleStay22Results");
const end = s.indexOf("function initDates()");
if (start < 0 || end < 0) {
  console.error("markers not found");
  process.exit(1);
}

const legacyBody = s.slice(start, end);
const pkgsIdx = legacyBody.indexOf("  const pkgs =");
if (pkgsIdx < 0) {
  console.error("pkgs not found in legacy body");
  process.exit(1);
}

const legacyTail = legacyBody.slice(pkgsIdx);
const legacyFn =
  "function renderLegacyPackageResults(preview, insurance, wasSurprise) {\n" +
  "  const results = document.getElementById(\"results\");\n" +
  "  const f = preview.flight;\n" +
  "  const airHelpHref = f.airHelpLink || AFFILIATE_AIRHELP_FALLBACK;\n" +
  "  const fromLabel = preview.partenza;\n" +
  "  const destLabel = wasSurprise ? \"?\" : f.destination;\n" +
  "  const destReal = f.destination;\n" +
  "  const budgetNum = Number(preview.budget) || 0;\n" +
  "  const totaleNum = Number(preview.prezzo_totale);\n" +
  "  const risparmioNum = Number(preview.risparmio);\n" +
  "  const fpEuro = Number(preview.flight_price_euro != null ? preview.flight_price_euro : f.price);\n" +
  "  let html = `<div style=\"max-width:600px;margin:0 auto;padding:0 0 3rem;\">`;\n" +
  "  if (wasSurprise) {\n" +
  "    html += `<div class=\"surprise-card\" id=\"surprise-card\"><motion class=\"surprise-icon\">🎲</motion><h3>Destinazione nascosta!</h3><button type=\"button\" class=\"reveal-btn\" id=\"reveal-dest-btn\">✨ Rivela</button></div>`;\n" +
  "  }\n" +
  legacyTail;

const fixedLegacy = legacyFn.replace(/<motion class="surprise-icon">🎲<\/motion>/g, '<div class="surprise-icon">🎲</div>');

const newS = s.slice(0, start) + single + "\n" + fixedLegacy + "\n" + s.slice(end);
fs.writeFileSync(homePath, newS);
console.log("OK patched home.js");
