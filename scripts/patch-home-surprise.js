const fs = require("fs");
const p = "public/home.js";
let s = fs.readFileSync(p, "utf8");

const d = "motion".replace("motion", "div");
const OLD = `    <${d} class="results-label">La tua ricerca</${d}>`;
const NEW = `    \${wasSurprise ? \`<${d} class="surprise-card" id="surprise-card"><${d} class="surprise-icon">🎲</${d}><h3>Destinazione a sorpresa</h3><p style="margin:0.5rem 0 0;font-size:0.9rem;opacity:0.9">Meta scelta nel mondo in base al tuo budget — ogni ricerca può proporti una destinazione diversa.</p><button type="button" class="reveal-btn" id="reveal-dest-btn">✨ Rivela la meta</button></${d}>\` : ""}
    <${d} class="results-label">La tua ricerca</${d}>`;

if (!s.includes(OLD)) {
  console.error("pattern missing", OLD);
  process.exit(1);
}
s = s.replace(OLD, NEW);

const revealHook =
  '  input.addEventListener("input", update);\n  wireManualKlookButton(klookBtn, preview, () =>\n    Math.floor(budgetNum - Math.max(0, Math.round(Number(input.value) || 0)))\n  );\n  update();';
const revealNew = `  input.addEventListener("input", update);
  wireManualKlookButton(klookBtn, preview, () =>
    Math.floor(budgetNum - Math.max(0, Math.round(Number(input.value) || 0)))
  );
  const revealBtn = document.getElementById("reveal-dest-btn");
  if (revealBtn && wasSurprise) {
    revealBtn.addEventListener("click", () => {
      const card = document.getElementById("surprise-card");
      if (card) {
        card.innerHTML = \`<div class="surprise-icon">🎉</div><h3>La tua destinazione è... <em style="color:var(--sun)">\${escHtml(destReal)}!</em></h3><p style="margin:0.35rem 0 0;font-size:0.9rem">Kiwi e Klook sono già impostati su questa meta.</p>\`;
      }
      const route = document.querySelector(".package-card__total-label");
      if (route) route.textContent = \`✈️ \${fromLabel} → \${escHtml(destReal)}\`;
    });
  }
  update();`;

if (s.includes(revealHook)) s = s.replace(revealHook, revealNew);
else console.warn("reveal hook not found");

fs.writeFileSync(p, s);
console.log("ok");
