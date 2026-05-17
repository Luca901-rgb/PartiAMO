const fs = require("fs");
const p = "c:/Users/Lucac/Documents/partiamo/public/home.js";
let s = fs.readFileSync(p, "utf8");
const actual =
  '    html += `<div class="results-budget-summary"><p><strong>Budget €${budgetNum}</strong> · ${voloLabel} · Alloggio fino a <strong>€${hotelQuota}</strong> (${nights} notti).</p><p class="results-budget-summary__sub">${escHtml(stayDisclaimer)}</p></motion>`;';
const repl = `    const hotelRange =
      hotelMin > 0 && hotelMin < hotelQuota
        ? \`Alloggio <strong>€\${hotelMin}–€\${hotelQuota}</strong>\`
        : \`Alloggio fino a <strong>€\${hotelQuota}</strong>\`;
    const fitsNote = fitsBudget ? " · <strong>rientra (stima prudente)</strong>" : "";
    html += \`<motion class="results-budget-summary"><p><strong>Budget €\${budgetNum}</strong> · \${voloLabel} · \${hotelRange} (\${nights} notti)\${fitsNote}.</p><p class="results-budget-summary__sub">\${escHtml(stayDisclaimer)}</p></div>\`;`;
const actualFixed = actual.replace("</motion>`;", "</div>`;");
const replFixed = repl.replace('<motion class="results-budget-summary">', '<motion class="results-budget-summary">').replace(/motion/g, "motion");
const replOk = repl.replace(/motion/g, "motion").replace(/motion/g, "div");
if (!s.includes(actualFixed)) {
  console.error("not found");
  process.exit(1);
}
s = s.replace(actualFixed, replOk);
fs.writeFileSync(p, s);
console.log("ok");
