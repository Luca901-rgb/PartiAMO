const fs = require("fs");
const p = "c:/Users/Lucac/Documents/partiamo/public/home.js";
let s = fs.readFileSync(p, "utf8");
const actual = `  if (budgetNum > 0) {
    html += \`<div class="results-budget-summary"><p><strong>Budget €\${budgetNum}</strong> · Volo <strong>€\${fpEuro}</strong> · Alloggio fino a <strong>€\${hotelQuota}</strong> (\${nights} notti).</p><p class="results-budget-summary__sub">\${escHtml(stayDisclaimer)}</p></div>\`;
  }`;
const repl = `  if (budgetNum > 0) {
    const voloLabel =
      paxCount > 1
        ? \`Volo <strong>€\${fpEuro}</strong> (\${paxCount} adulti)\`
        : \`Volo <strong>€\${fpEuro}</strong>\`;
    html += \`<div class="results-budget-summary"><p><strong>Budget €\${budgetNum}</strong> · \${voloLabel} · Alloggio fino a <strong>€\${hotelQuota}</strong> (\${nights} notti).</p><p class="results-budget-summary__sub">\${escHtml(stayDisclaimer)}</p></div>\`;
  }`;
if (!s.includes(actual)) {
  if (s.includes("const voloLabel =\n      paxCount > 1")) {
    console.log("already patched");
    process.exit(0);
  }
  console.error("needle not found");
  process.exit(1);
}
s = s.replace(actual, repl);
fs.writeFileSync(p, s);
console.log("ok");
