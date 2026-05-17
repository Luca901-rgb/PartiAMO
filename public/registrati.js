const budget = document.getElementById("budget");
const budgetLabel = document.getElementById("budgetLabel");
const form = document.getElementById("registerForm");
const airportInput = document.getElementById("aeroporto_partenza");
const airportList = document.getElementById("airport-suggestions");
let airportFetchTimer = null;

function initRegisterAirportAutocomplete() {
  if (!airportInput || !airportList) return;

  function render(items) {
    airportList.innerHTML = "";
    for (const a of items) {
      const li = document.createElement("li");
      li.className = "autocomplete-suggestion";
      li.dataset.label = a.label;
      li.dataset.iata = a.iata;
      const label = document.createElement("span");
      label.className = "autocomplete-label";
      label.textContent = a.label;
      const code = document.createElement("span");
      code.className = "autocomplete-iata";
      code.textContent = a.iata;
      li.appendChild(label);
      li.appendChild(code);
      airportList.appendChild(li);
    }
    airportList.hidden = items.length === 0;
  }

  function schedule() {
    clearTimeout(airportFetchTimer);
    airportFetchTimer = setTimeout(async () => {
      try {
        const q = encodeURIComponent(airportInput.value.trim());
        const r = await fetch(`/api/airports?q=${q}&limit=12`);
        const j = await r.json();
        render(j.ok && Array.isArray(j.airports) ? j.airports : []);
      } catch (_e) {
        airportList.hidden = true;
      }
    }, 180);
  }

  airportInput.addEventListener("focus", schedule);
  airportInput.addEventListener("input", () => {
    delete airportInput.dataset.iata;
    schedule();
  });
  airportList.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const li = e.target.closest("li.autocomplete-suggestion");
    if (!li) return;
    airportInput.value = li.dataset.label || li.dataset.iata || "";
    if (li.dataset.iata) airportInput.dataset.iata = li.dataset.iata;
    airportList.hidden = true;
  });
}

initRegisterAirportAutocomplete();
const formMsg = document.getElementById("formMsg");
const liveSearchBtn = document.getElementById("liveSearchBtn");
const liveResult = document.getElementById("liveResult");
const liveRoute = document.getElementById("liveRoute");
const livePrice = document.getElementById("livePrice");
const liveSaving = document.getElementById("liveSaving");
const prezzoRiferimentoInput = document.getElementById("prezzo_riferimento");
const destinazioneSorpresaInput = document.getElementById("destinazione_sorpresa");

function formToPayload() {
  const data = new FormData(form);
  const payload = Object.fromEntries(data.entries());
  payload.destinazione_sorpresa = destinazioneSorpresaInput.checked ? "1" : "0";
  return payload;
}

budget.addEventListener("input", () => {
  budgetLabel.textContent = budget.value;
});

liveSearchBtn.addEventListener("click", async () => {
  formMsg.textContent = "Ricerca live in corso...";
  liveSearchBtn.disabled = true;
  const payload = formToPayload();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch("/api/live-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const result = await response.json();

    if (!response.ok || !result.ok) {
      liveResult.style.display = "none";
      formMsg.textContent = result.error || "Nessun risultato live disponibile ora.";
      return;
    }

    const { preview } = result;
    liveRoute.textContent = `${preview.partenza} -> ${preview.flight.destination}`;
    livePrice.textContent = `€${preview.prezzo_totale} su €${preview.budget}`;
    liveSaving.textContent = `Risparmi €${preview.risparmio}`;
    prezzoRiferimentoInput.value = String(preview.prezzo_totale);
    liveResult.style.display = "block";
    formMsg.textContent = "Risultato live pronto. Apro la pagina risultati...";
    sessionStorage.setItem("partiamo_live_preview", JSON.stringify(preview));
    window.location.href = "/offerta-live";
  } catch (error) {
    liveResult.style.display = "none";
    if (error.name === "AbortError") {
      formMsg.textContent = "Ricerca live troppo lenta. Riprova tra pochi secondi.";
    } else {
      formMsg.textContent = "Server non raggiungibile: verifica che l'app sia avviata e ricarica la pagina.";
    }
  } finally {
    clearTimeout(timeoutId);
    liveSearchBtn.disabled = false;
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  formMsg.textContent = "Invio in corso...";

  const payload = formToPayload();

  const response = await fetch("/api/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json();

  if (!response.ok || !result.ok) {
    formMsg.textContent = result.error || "Errore, riprova.";
    return;
  }
  window.location.href = "/grazie";
});
