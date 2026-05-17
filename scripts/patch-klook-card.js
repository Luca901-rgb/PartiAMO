const fs = require("fs");
const path = require("path");
const file = path.join(__dirname, "..", "public", "home.js");
let s = fs.readFileSync(file, "utf8");
const old = `      \${fitsBudget ? \`<span class="package-card__budget-ok">✓ Nel budget (stima prudente)</span>\` : ""}
      <motion.div class="package-card__total">
        <span class="package-card__total-label">Volo indicativo\${paxCount > 1 ? \` · \${paxCount} adulti\` : ""}</span>
        <strong class="package-card__total-eur">da €\${fpEuro}</strong>
        \${flightSub ? \`<span class="package-card__total-sub">\${escHtml(flightSub)} · cache Aviasales</span>\` : ""}
      </motion.div>
    </motion.div>
    \${flightIndicative ? \`<p class="stay22-price-warning stay22-price-warning--flight">⚠️ Questo importo viene da una cache Aviasales: sul sito il volo può costare il doppio o il triplo (posti, bagagli, aggiornamento). Non è un prezzo garantito.</p>\` : ""}
    <p class="package-card__quota-hint">Hotel a <strong>\${cityShown}</strong> · max <strong>€\${maxPerNight || Math.floor(hotelQuota / nights)}/notte</strong> (≈ €\${hotelQuota} per \${nights} notti)</p>
    <motion.div class="package-card__actions package-card__actions--flight">
      <a href="\${kiwiHref}" target="_blank" rel="noopener noreferrer sponsored" class="package-btn package-btn--kiwi">\${escHtml(flightBtn)}</a>
      <a href="\${escHtml(airHelpHref)}" target="_blank" rel="noopener noreferrer sponsored" class="package-btn package-btn--outline">AirHelp</a>
    </motion.div>
        <motion.div class="stay22-embed-wrap">
      <p class="stay22-embed-label">Cerca alloggio entro ~€\${maxPerNight || Math.floor(hotelQuota / nights)}/notte (≈ €\${hotelQuota} totali) — Stay22</p>
      <iframe class="stay22-embed-frame" title="Hotel \${cityShown}" src="\${embedSrc}" width="100%" height="480" frameborder="0" loading="lazy"></iframe>
    </motion.div>
    <p class="package-card__fineprint">Volo e hotel: prezzi indicativi — conferma sempre su Aviasales e sul sito alloggio prima di prenotare.</p>`;

const neu = `      <motion.div class="package-card__total">
        <span class="package-card__total-label">Il tuo viaggio</span>
        <strong class="package-card__total-eur">\${escHtml(\`\${fromLabel} → \${destLabel}\`)}</strong>
        <span class="package-card__total-sub">\${escHtml(f.departDate)} → \${escHtml(f.returnDate)} · \${nights} notti</span>
      </motion.div>
    </motion.div>
    <motion.div class="klook-budget-box">
      <p class="klook-budget-box__title">Alloggi selezionati nel tuo budget</p>
      <p class="klook-budget-box__amount">Max <strong>€\${maxNightDisplay}</strong> a notte</p>
      <p class="klook-budget-box__sub">≈ €\${hotelQuota} per \${nights} notti a \${cityShown} (dopo volo indicativo ~€\${fpEuro})</p>
    </motion.div>
    <p class="klook-microcopy">\${escHtml(klookCopy)}</p>
    <motion.div class="package-card__actions package-card__actions--stacked">
      <a href="\${klookHref}" target="_blank" rel="noopener noreferrer sponsored" class="package-btn package-btn--klook">Verifica alloggi e prenota su Klook.com</a>
      <a href="\${kiwiHref}" target="_blank" rel="noopener noreferrer sponsored" class="package-btn package-btn--kiwi">\${escHtml(flightBtn)}</a>
    </motion.div>
    <p class="package-card__fineprint">Volo: verifica su Aviasales. Hotel: ricerca Klook ordinata dal prezzo più basso (sort_type=1).</p>`;

if (!s.includes("stay22-embed-wrap")) {
  console.log("embed already removed or not found");
  process.exit(0);
}
s = s.replace(
  /      \$\{fitsBudget[\s\S]*?Volo e hotel: prezzi indicativi — conferma sempre su Aviasales e sul sito alloggio prima di prenotare\.<\/p>/,
  neu
);
fs.writeFileSync(file, s);
console.log("patched home.js card");
