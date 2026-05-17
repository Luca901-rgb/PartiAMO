const AFFILIATE_AIRHELP_FALLBACK = "https://airhelp.tpk.lv/BDuyfeVr";
const AFFILIATE_KIWI_FALLBACK = "https://kiwi.tpk.lv/UiOvgyTf";

function effectiveFlightUrl(flight, pkg) {
  const u = String((pkg && pkg.kiwi_link) || (flight && flight.flightLink) || "").trim();
  if (u) return u;
  return AFFILIATE_KIWI_FALLBACK;
}

function passengerCountFromPreview(preview) {
  const raw = String(preview?.passengers_count ?? preview?.persone ?? "2").replace(/\D/g, "");
  return Math.max(1, Math.min(9, Number(raw) || 1));
}

function flightPerPersonEuro(preview, totalEuro) {
  const pax = passengerCountFromPreview(preview);
  if (pax <= 1) return 0;
  const pp = Math.round(Number(preview?.flight_price_per_person_euro) || 0);
  if (pp > 0) return pp;
  return totalEuro > 0 ? Math.round(totalEuro / pax) : 0;
}

function flightPriceSubline(preview, totalEuro) {
  const pax = passengerCountFromPreview(preview);
  const per = flightPerPersonEuro(preview, totalEuro);
  if (pax > 1 && per > 0) return `€${per} × ${pax} adulti`;
  return "";
}

function flightIsIndicative(preview, flight) {
  if (preview && preview.flight_price_is_indicative === true) return true;
  if (preview && preview.flight_price_is_indicative === false) return false;
  return String(flight?.priceSource || "") === "travelpayouts";
}

function flightButtonLabel(pkg, flight, preview) {
  const src = String((pkg && pkg.flight_link_source) || (flight && flight.flightLinkSource) || "").trim();
  if (flightIsIndicative(preview, flight) || src === "travelpayouts" || /aviasales\./i.test(effectiveFlightUrl(flight, pkg))) {
    return "Verifica prezzo su Aviasales";
  }
  const price = Math.round(Number(pkg?.flight_price_euro ?? flight?.price) || 0);
  return price > 0 ? `Cerca volo da €${price}` : "Cerca volo";
}

function hotelButtonLabel(h) {
  const total = Math.round(Number(h?.price) || Number(h?.stayTotalEstimate) || 0);
  return total > 0 ? `Prenota hotel · €${total}` : "Prenota hotel";
}

function klookHotelHref(preview) {
  const href = String(
    preview?.klook_hotel_direct_url ||
      preview?.hotels?.[0]?.directBookingLink ||
      preview?.klook_hotel_url ||
      preview?.hotels?.[0]?.bookingLink ||
      preview?.aviasales_hotel_url ||
      preview?.flight?.hotelLink ||
      ""
  ).trim();
  return normalizeKlookHotelHref(href, preview);
}

function normalizeKlookHotelHref(href, preview) {
  const url = String(href || "").trim();
  if (!url || !/klook\.com\/hotels/i.test(url)) return url;
  const checkIn = String(preview?.requested_check_in || "").slice(0, 10);
  const checkOut = String(preview?.requested_check_out || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut)) return url;
  try {
    const u = new URL(url);
    u.searchParams.set("check_in", checkIn);
    u.searchParams.set("check_out", checkOut);
    return u.toString();
  } catch (_e) {
    return url;
  }
}

function sanitizeCityForDisplay(label) {
  let city = String(label || "").trim();
  try {
    city = city.replace(/\p{Extended_Pictographic}/gu, "");
  } catch (_e) {
    city = city.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "");
  }
  return city.replace(/\s+/g, " ").trim();
}

const CITY_TO_AIRPORT = {
  napoli: "NAP",
  roma: "FCO",
  "roma fiumicino": "FCO",
  milano: "MXP",
  "milano malpensa": "MXP",
  "milano bergamo": "BGY",
  bergamo: "BGY",
  bari: "BRI",
  palermo: "PMO",
  catania: "CTA",
  venezia: "VCE",
  pisa: "PSA",
  bologna: "BOL",
};

let surpriseOn = false;
let lastPreview = null;
let lastSurpriseSearch = false;
let lastInsurance = false;
/** @type {{ label: string, iata: string, aliases?: string[] }[]} */
let partiamoDestinations = [];
/** @type {Map<string, string>} IATA → label (ultima ricerca partenza) */
let lastFromAirportHits = new Map();
let lastToAirportHits = new Map();
let fromAirportFetchTimer = null;
let toAirportFetchTimer = null;

function foldAscii(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

async function loadDestinations() {
  try {
    const r = await fetch("/api/destinations");
    const j = await r.json();
    if (j.ok && Array.isArray(j.destinations)) partiamoDestinations = j.destinations;
  } catch (_e) {
    partiamoDestinations = [];
  }
}

function toTitleCaseWords(s) {
  return String(s || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

async function fetchAirports(query, hitsMap) {
  const q = String(query || "").trim();
  const url = `/api/airports?q=${encodeURIComponent(q)}&limit=12`;
  const r = await fetch(url);
  const j = await r.json();
  if (!j.ok || !Array.isArray(j.airports)) return [];
  const map = hitsMap || lastFromAirportHits;
  for (const a of j.airports) {
    if (a.iata && a.label) map.set(String(a.iata).toUpperCase(), a.label);
  }
  return j.airports;
}

async function fetchFromAirports(query) {
  return fetchAirports(query, lastFromAirportHits);
}

async function fetchToAirports(query) {
  return fetchAirports(query, lastToAirportHits);
}

function initFromAutocomplete() {
  const input = document.getElementById("from");
  const list = document.getElementById("from-suggestions");
  if (!input || !list) return;

  function setExpanded(open) {
    input.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function renderList(items) {
    list.innerHTML = "";
    for (const d of items) {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.className = "autocomplete-suggestion";
      li.dataset.label = d.label;
      li.dataset.iata = d.iata;
      const spanL = document.createElement("span");
      spanL.className = "autocomplete-label";
      spanL.textContent = d.label;
      const spanI = document.createElement("span");
      spanI.className = "autocomplete-iata";
      spanI.textContent = d.iata;
      if (d.country) {
        const spanC = document.createElement("span");
        spanC.className = "autocomplete-country";
        spanC.textContent = d.country;
        li.appendChild(spanL);
        li.appendChild(spanC);
      } else {
        li.appendChild(spanL);
      }
      li.appendChild(spanI);
      list.appendChild(li);
    }
    const show = items.length > 0;
    list.hidden = !show;
    setExpanded(show);
  }

  function scheduleFetch() {
    clearTimeout(fromAirportFetchTimer);
    fromAirportFetchTimer = setTimeout(async () => {
      try {
        const items = await fetchFromAirports(input.value);
        renderList(items);
      } catch (_e) {
        list.hidden = true;
        setExpanded(false);
      }
    }, 180);
  }

  function openList() {
    scheduleFetch();
  }

  input.addEventListener("focus", openList);
  input.addEventListener("input", () => {
    delete input.dataset.iata;
    delete input.dataset.label;
    openList();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      list.hidden = true;
      setExpanded(false);
    }
  });

  list.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const li = e.target.closest("li.autocomplete-suggestion");
    if (!li) return;
    input.value = li.dataset.label || "";
    if (li.dataset.iata) input.dataset.iata = li.dataset.iata;
    if (li.dataset.label) input.dataset.label = li.dataset.label;
    list.hidden = true;
    setExpanded(false);
    input.focus();
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".field--autocomplete")) {
      list.hidden = true;
      setExpanded(false);
    }
  });
}

function destinationMatchesInput(toText) {
  const raw = String(toText || "").trim();
  if (raw.length >= 2) return true;
  const input = document.getElementById("to");
  const stored = input?.dataset?.iata;
  if (stored && /^[A-Z]{3}$/.test(stored)) return true;
  if (!raw) return false;
  if (/^[A-Za-z]{3}$/.test(raw)) {
    const up = raw.toUpperCase();
    if (lastToAirportHits.has(up)) return true;
    if (partiamoDestinations.some((d) => d.iata === up)) return true;
    return true;
  }
  const f = foldAscii(raw);
  if (partiamoDestinations.some((d) => foldAscii(d.label) === f)) return true;
  if (partiamoDestinations.some((d) => (d.aliases || []).some((a) => foldAscii(a) === f))) return true;
  const key = normalizeCity(raw);
  return Boolean(CITY_TO_AIRPORT[key]) || lastToAirportHits.size > 0;
}

/** Partenza riconosciuta (aeroporto scelto dall’elenco mondiale o codice IATA). */
function departureMatchesInput(fromText) {
  const raw = String(fromText || "").trim();
  if (raw.length >= 2) return true;
  const input = document.getElementById("from");
  const stored = input?.dataset?.iata;
  if (stored && /^[A-Z]{3}$/.test(stored)) return true;
  if (!raw) return false;
  if (/^[A-Za-z]{3}$/.test(raw)) {
    const up = raw.toUpperCase();
    return lastFromAirportHits.has(up) || true;
  }
  const key = normalizeCity(raw);
  if (CITY_TO_AIRPORT[key]) return true;
  const hit = Object.keys(CITY_TO_AIRPORT).find((k) => key.includes(k) || k.includes(key));
  if (hit) return true;
  return false;
}

function filterDestinations(query) {
  const q = foldAscii(query);
  if (!partiamoDestinations.length) return [];
  if (!q) {
    return [...partiamoDestinations].sort((a, b) => a.label.localeCompare(b.label, "it"));
  }
  const scored = partiamoDestinations
    .map((d) => {
      let s = 100;
      const labelF = foldAscii(d.label);
      const iataL = (d.iata || "").toLowerCase();
      if (iataL === q) s = 0;
      else if (labelF.startsWith(q)) s = 1;
      else if (labelF.includes(q)) s = 2;
      else if (
        (d.aliases || []).some((a) => {
          const af = foldAscii(a);
          return af.includes(q) || af.startsWith(q);
        })
      )
        s = 3;
      return { d, s };
    })
    .filter((x) => x.s < 100)
    .sort((a, b) => a.s - b.s || a.d.label.localeCompare(b.d.label, "it"));
  return scored.map((x) => x.d);
}

function initDestinationAutocomplete() {
  const input = document.getElementById("to");
  const list = document.getElementById("to-suggestions");
  if (!input || !list) return;

  function setExpanded(open) {
    input.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function renderList(items) {
    list.innerHTML = "";
    for (const d of items) {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.className = "autocomplete-suggestion";
      li.dataset.label = d.label;
      li.dataset.iata = d.iata;
      const spanL = document.createElement("span");
      spanL.className = "autocomplete-label";
      spanL.textContent = d.label;
      const spanI = document.createElement("span");
      spanI.className = "autocomplete-iata";
      spanI.textContent = d.iata;
      if (d.country) {
        const spanC = document.createElement("span");
        spanC.className = "autocomplete-country";
        spanC.textContent = d.country;
        li.appendChild(spanL);
        li.appendChild(spanC);
      } else {
        li.appendChild(spanL);
      }
      li.appendChild(spanI);
      list.appendChild(li);
    }
    const show = items.length > 0 && !surpriseOn;
    list.hidden = !show;
    setExpanded(show);
  }

  function scheduleFetch() {
    clearTimeout(toAirportFetchTimer);
    toAirportFetchTimer = setTimeout(async () => {
      try {
        const q = input.value.trim();
        const airports = await fetchToAirports(q);
        const local = filterDestinations(q).map((d) => ({
          iata: d.iata,
          label: d.label,
          country: "",
        }));
        const seen = new Set();
        const merged = [];
        for (const item of [...airports, ...local]) {
          const code = String(item.iata || "").toUpperCase();
          if (!code || seen.has(code)) continue;
          seen.add(code);
          merged.push(item);
        }
        renderList(merged.slice(0, 12));
      } catch (_e) {
        list.hidden = true;
        setExpanded(false);
      }
    }, 180);
  }

  function openList() {
    if (surpriseOn) {
      list.hidden = true;
      setExpanded(false);
      return;
    }
    scheduleFetch();
  }

  input.addEventListener("focus", openList);
  input.addEventListener("input", () => {
    delete input.dataset.iata;
    delete input.dataset.label;
    openList();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      list.hidden = true;
      setExpanded(false);
    }
  });

  list.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const li = e.target.closest("li.autocomplete-suggestion");
    if (!li) return;
    input.value = li.dataset.label || "";
    if (li.dataset.iata) input.dataset.iata = li.dataset.iata;
    if (li.dataset.label) input.dataset.label = li.dataset.label;
    list.hidden = true;
    setExpanded(false);
    input.focus();
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".field--autocomplete")) {
      list.hidden = true;
      setExpanded(false);
    }
  });
}

function bootHome() {
  initDates();
  const dh = document.getElementById("dest-type-hint");
  if (dh) dh.style.display = "none";
  initFromAutocomplete();
  loadDestinations().then(() => {
    initDestinationAutocomplete();
  });
}

function normalizeCity(s) {
  return String(s || "")
    .trim()
    .toLowerCase();
}

function mapFromToAirport(fromText) {
  const input = document.getElementById("from");
  const stored = input?.dataset?.iata;
  if (stored && /^[A-Z]{3}$/.test(stored)) return stored;
  const key = normalizeCity(fromText);
  if (!key) return "NAP";
  if (CITY_TO_AIRPORT[key]) return CITY_TO_AIRPORT[key];
  const hit = Object.keys(CITY_TO_AIRPORT).find((k) => key.includes(k) || k.includes(key));
  if (hit) return CITY_TO_AIRPORT[hit];
  const up = String(fromText || "")
    .trim()
    .toUpperCase();
  if (/^[A-Z]{3}$/.test(up)) return up;
  return "NAP";
}

function nightsBetween(d1, d2) {
  const a = new Date(d1);
  const b = new Date(d2);
  const ms = b - a;
  const n = Math.ceil(ms / (1000 * 60 * 60 * 24));
  return Math.max(1, Math.min(21, n || 1));
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

function toggleSurprise() {
  surpriseOn = !surpriseOn;
  document.getElementById("toggle").classList.toggle("on", surpriseOn);
  const dest = document.getElementById("to");
  const list = document.getElementById("to-suggestions");
  const hint = document.getElementById("dest-type-hint");
  dest.disabled = surpriseOn;
  dest.placeholder = surpriseOn
    ? "🎲 Lo scegliamo noi!"
    : "Cerca aeroporto o città nel mondo (es. Tokyo, JFK)";
  dest.style.opacity = surpriseOn ? "0.4" : "1";
  if (hint) {
    hint.style.display = surpriseOn ? "block" : "none";
    hint.style.opacity = surpriseOn ? "0.9" : "0";
  }
  if (list) {
    list.hidden = true;
    dest.setAttribute("aria-expanded", "false");
  }
}

function buildLivePayload() {
  const fromText = document.getElementById("from").value;
  const toText = document.getElementById("to").value;
  const toInput = document.getElementById("to");
  const selectedToLabel = String(toInput?.dataset?.label || "").trim();
  const selectedToIata =
    selectedToLabel && foldAscii(selectedToLabel) === foldAscii(toText)
      ? String(toInput?.dataset?.iata || "").trim().toUpperCase()
      : "";
  const budget = parseInt(document.getElementById("budget").value, 10) || 500;
  const dateFrom = document.getElementById("date-from").value;
  const dateTo = document.getElementById("date-to").value;
  const paxIdx = document.getElementById("passengers").selectedIndex + 1;
  const persone = paxIdx >= 4 ? "4+" : String(paxIdx);

  const durata = nightsBetween(dateFrom, dateTo);

  return {
    aeroporto_partenza: mapFromToAirport(fromText),
    budget,
    persone,
    durata,
    date_from: dateFrom,
    date_to: dateTo,
    destinazione_tipo: (document.getElementById("dest-type") && document.getElementById("dest-type").value) || "Ovunque",
    destinazione_preferita: surpriseOn ? "" : toText.trim(),
    destinazione_iata: surpriseOn ? "" : selectedToIata,
    destinazione_sorpresa: surpriseOn ? "1" : "0",
    fascia_oraria: "Indifferente",
    tipo_volo: "Indifferente",
    distanza_mare: "Indifferente",
    distanza_centro: "Indifferente",
    rating_minimo: 6.0,
    tipo_pasto: "Solo pernotto",
    tipo_camera: "Doppia",
    tipo_struttura: "Entrambe",
    bagaglio: "Solo cabina",
    solo_voli_diretti: document.getElementById("solo-voli-diretti")?.checked ? "1" : "0",
  };
}

async function doSearch() {
  const insurance = document.getElementById("insurance").checked;
  const btn = document.querySelector(".search-btn");
  document.getElementById("loading").style.display = "block";
  document.getElementById("results").classList.remove("show");
  document.getElementById("results").innerHTML = "";
  window.scrollTo({ top: document.getElementById("loading").offsetTop - 20, behavior: "smooth" });
  btn.disabled = true;

  lastSurpriseSearch = surpriseOn;
  lastInsurance = insurance;

  try {
    const fromVal = document.getElementById("from").value.trim();
    if (!fromVal) {
      document.getElementById("loading").style.display = "none";
      btn.disabled = false;
      renderError("Indica la partenza: città o aeroporto (es. Napoli, NAP) scegliendolo dai suggerimenti.");
      return;
    }
    if (!departureMatchesInput(fromVal)) {
      document.getElementById("loading").style.display = "none";
      btn.disabled = false;
      renderError(
        "Partenza non riconosciuta. Scegli un aeroporto dai suggerimenti mentre digiti, oppure un codice IATA a 3 lettere dall’elenco."
      );
      return;
    }

    const dateFrom = document.getElementById("date-from").value;
    const dateTo = document.getElementById("date-to").value;
    if (!dateFrom || !dateTo) {
      document.getElementById("loading").style.display = "none";
      btn.disabled = false;
      renderError("Seleziona le date di andata e di ritorno.");
      return;
    }
    if (new Date(dateTo) < new Date(dateFrom)) {
      document.getElementById("loading").style.display = "none";
      btn.disabled = false;
      renderError("La data di ritorno deve essere uguale o successiva all’andata.");
      return;
    }

    if (!surpriseOn) {
      const toVal = document.getElementById("to").value.trim();
      if (!destinationMatchesInput(toVal)) {
        document.getElementById("loading").style.display = "none";
        btn.disabled = false;
        renderError(
          "Destinazione non riconosciuta. Scegli aeroporto o città nel mondo dai suggerimenti, oppure un codice IATA a 3 lettere."
        );
        return;
      }
    }
    const payload = buildLivePayload();
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 55000);
    const response = await fetch("/api/live-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(t);
    let result;
    try {
      result = await response.json();
    } catch (_parse) {
      document.getElementById("loading").style.display = "none";
      btn.disabled = false;
      renderError(
        response.status >= 500
          ? `Errore server (${response.status}). Riprova tra poco.`
          : "Risposta dal server non valida. Riprova o controlla la connessione."
      );
      return;
    }
    document.getElementById("loading").style.display = "none";
    btn.disabled = false;

    if (result.preview) {
      lastPreview = result.preview;
      sessionStorage.setItem("partiamo_live_preview", JSON.stringify(result.preview));
      renderResultsFromApi(result.preview, insurance, surpriseOn);
      return;
    }
    if (!response.ok || !result.ok) {
      let msg =
        result.error ||
        "Ricerca non disponibile in questo momento. Riprova tra poco o cambia date.";
      if (result.code === "BUDGET_TOO_TIGHT" && result.suggested_budget_min) {
        msg += ` Suggerimento: prova con budget da circa €${Math.round(Number(result.suggested_budget_min))}.`;
      }
      renderError(msg);
      return;
    }

  } catch (e) {
    document.getElementById("loading").style.display = "none";
    btn.disabled = false;
    const aborted = e && (e.name === "AbortError" || /abort/i.test(String(e.message || "")));
    renderError(
      aborted
        ? "La ricerca ha impiegato troppo tempo ed è stata interrotta. Prova di nuovo tra un attimo, o date più vicine / budget diverso."
        : "Connessione lenta o server non raggiungibile. Riprova tra poco."
    );
  }
}

function renderError(message) {
  const results = document.getElementById("results");
  results.innerHTML = `<div class="results-error">${escHtml(message)}</div>
    <p style="text-align:center;margin-top:1rem"><a href="/registrati" class="nav-link" style="color:var(--blue)">Apri modulo alert completo →</a></p>`;
  results.classList.add("show");
  results.scrollIntoView({ behavior: "smooth", block: "start" });
}

function hotelReviewBlock(h) {
  const amadeusHotel = h && h.priceSource === "amadeus";
  if (amadeusHotel) {
    const quoted =
      h.pricePerNightXotelo != null ? ` · €${Math.round(Number(h.pricePerNightXotelo))}/notte Amadeus` : "";
    const rev = h.rating ? ` · ${escHtml(String(h.rating))}/10` : "";
    return `<p class="hotel-review-line hotel-review-line--muted" style="margin:4px 0;font-size:0.85rem;color:#666">Prezzo verificato Amadeus per le tue date${quoted}${rev}. Verifica su Aviasales Hotel.</p>`;
  }
  const googleHotel = h && h.priceSource === "google";
  if (googleHotel) {
    const rev = h.rating ? ` · Google ${escHtml(String(h.rating))}/10` : "";
    return `<p class="hotel-review-line hotel-review-line--muted" style="margin:4px 0;font-size:0.85rem;color:#666">Struttura reale (Google Maps)${rev}. Quota alloggio nel budget — verifica prezzo su Aviasales Hotel.</p>`;
  }
  const xotel = h && h.priceSource === "xotelo";
  if (xotel) {
    const quoted = h.pricePerNightXotelo != null ? ` · €${Math.round(Number(h.pricePerNightXotelo))}/notte` : "";
    const rev = h.rating ? ` · TripAdvisor ${escHtml(String(h.rating))}/10` : "";
    return `<div class="hotel-review-line hotel-review-line--muted">Prezzo live Xotelo/OTA per le tue date${quoted}${rev}. Conferma sul link prima di prenotare.</div>`;
  }
  if (h.rating) {
    return `<div class="hotel-review-line">Recensioni · <strong>${escHtml(String(h.rating))}/10</strong></div>`;
  }
  return "";
}

function renderResultsFromApi(preview, insurance, wasSurprise) {
  if (
    preview.card_mode === "quoted_package" ||
    preview.card_mode === "klook_single" ||
    preview.prices_verified ||
    preview.klook_hotel_url ||
    preview.hotel_stay_quota != null
  ) {
    renderKlookPackageResults(preview, insurance, wasSurprise);
    return;
  }
  renderLegacyPackageResults(preview, insurance, wasSurprise);
}

function renderKlookPackageResults(preview, insurance, wasSurprise) {
  const results = document.getElementById("results");
  const f = preview.flight;
  const airHelpHref = f.airHelpLink || AFFILIATE_AIRHELP_FALLBACK;
  const fromLabel = preview.partenza;
  const destLabel = wasSurprise ? "?" : f.destination;
  const destReal = f.destination;
  const budgetNum = Number(preview.budget) || 0;
  const fpEuro = Math.round(Number(preview.flight_price_euro != null ? preview.flight_price_euro : f.price) || 0);
  const flightSub = flightPriceSubline(preview, fpEuro);
  const paxCount = passengerCountFromPreview(preview);
  const pricesVerified = preview.prices_verified === true;
  const hotelEuro = Math.round(
    Number(preview.hotel_price_euro) ||
      (pricesVerified ? preview.hotel_stay_quota : 0) ||
      Number(preview.hotels?.[0]?.price) ||
      0
  );
  const hotelQuota = pricesVerified
    ? hotelEuro
    : Math.floor(Number(preview.hotel_stay_quota) || 0);
  const hotelMin = Math.floor(Number(preview.stay_budget_min) || 0);
  const nights = Math.max(1, Number(preview.stay_nights) || 1);
  const fitsBudget = preview.fits_budget_pessimistic === true;
  const planTotal = pricesVerified
    ? Math.round(Number(preview.package_total_euro || preview.prezzo_totale) || fpEuro + hotelEuro)
    : Math.min(budgetNum, Math.round(Number(preview.package_plan_total_euro) || fpEuro + hotelQuota));
  const maxPerNight = Math.floor(Number(preview.hotel_max_per_night_euro) || 0);
  const refHotel = (preview.hotels && preview.hotels[0]) || {};
  const hotelName = String(refHotel.name || "").trim();
  const overrunLikely = preview.budget_overrun_likely === true;
  const risparmioNum = Number(preview.risparmio);
  const klookHref = escHtml(klookHotelHref(preview));
  const kiwiHref = escHtml(effectiveFlightUrl(f));
  const flightBtn = flightButtonLabel(null, f, preview);
  const flightIndicative = flightIsIndicative(preview, f);
  const klookCopy =
    String(preview.stay_pricing_disclaimer || "").trim() ||
    "Apriamo Klook con destinazione, date, ospiti e filtro prezzo entro il budget residuo dopo il volo.";
  const cityShown = escHtml(sanitizeCityForDisplay(preview.destination_city || f.destination || ""));
  const maxNightDisplay = maxPerNight || (nights > 0 ? Math.floor(hotelQuota / nights) : hotelQuota);

  let html = `<div style="max-width:640px;margin:0 auto;padding:0 0 3rem;">`;

  if (wasSurprise) {
    html += `<div class="surprise-card" id="surprise-card">
      <div class="surprise-icon">🎲</div>
      <h3>Destinazione nascosta!</h3>
      <p>Volo nel budget — rivela la meta per vedere gli hotel.</p>
      <button type="button" class="reveal-btn" id="reveal-dest-btn">✨ Rivela la destinazione</button>
    </div>`;
  }

  html += `<div class="results-label">La tua offerta</div>
  <p class="packages-route-line" id="packages-route-line">${escHtml(`${fromLabel} → ${destLabel}`)} · ${escHtml(f.departDate)} → ${escHtml(f.returnDate)}</p>`;

  if (budgetNum > 0) {
    const voloPrefix = flightIndicative ? "Volo indicativo da" : "Volo";
    const voloLabel =
      paxCount > 1
        ? `${voloPrefix} <strong>€${fpEuro}</strong> (${paxCount} adulti, cache)`
        : `${voloPrefix} <strong>€${fpEuro}</strong>`;
    const hotelRange =
      hotelMin > 0 && hotelMin < hotelQuota
        ? `Alloggio <strong>€${hotelMin}–€${hotelQuota}</strong>`
        : `Alloggio fino a <strong>€${hotelQuota}</strong>`;
    const fitsNote = fitsBudget ? " · <strong>rientra (stima prudente)</strong>" : "";
    const overBudgetNote = fitsBudget
      ? ""
      : " · budget stretto: volo + hotel da verificare al click";
    if (pricesVerified && hotelEuro > 0) {
      html += `<div class="results-budget-summary"><p><strong>Budget €${budgetNum}</strong> · Pacchetto <strong>€${planTotal}</strong> = Volo <strong>€${fpEuro}</strong> + Hotel <strong>€${hotelEuro}</strong>.</p></div>`;
    } else if (flightIndicative) {
      html += `<div class="results-budget-summary"><p><strong>Budget totale €${budgetNum}</strong> per ${paxCount} adulto/i · Volo non verificato: controlla prima Aviasales. Hotel Klook filtrato solo in modo indicativo fino a <strong>€${hotelQuota}</strong>.</p></div>`;
    } else {
      html += `<div class="results-budget-summary"><p><strong>Budget €${budgetNum}</strong> · Piano <strong>€${planTotal}</strong> (volo €${fpEuro} + hotel max €${hotelQuota}).</p></div>`;
    }
  }

  if (!pricesVerified && (overrunLikely || flightIndicative)) {
    html += `<p class="stay22-price-warning stay22-price-warning--flight">⚠️ Prezzo volo da verificare: apri Aviasales per il totale aggiornato.</p>`;
  }
  if (pricesVerified) {
    html += `<p class="stay22-price-warning stay22-price-warning--flight">⚠️ Conferma il volo su Aviasales. Hotel quotato ora — verifica su Klook.</p>`;
  }

  html += `<article class="package-card package-card--single package-card--klook">
    <div class="package-card__top">
      <span class="package-card__badge">Volo + hotel</span>
      <div class="package-card__total">
        <span class="package-card__total-label">${pricesVerified ? "Totale pacchetto" : "Il tuo viaggio"}</span>
        <strong class="package-card__total-eur">${pricesVerified ? `€${planTotal}` : escHtml(`${fromLabel} → ${destLabel}`)}</strong>
        <span class="package-card__total-sub">${escHtml(f.departDate)} → ${escHtml(f.returnDate)} · ${nights} notti</span>
      </div>
    </div>
    <div class="klook-budget-box">
      <p class="klook-budget-box__title">${pricesVerified && hotelName ? escHtml(hotelName) : "Alloggio nel budget"}</p>
      <p class="klook-budget-box__amount">${pricesVerified && hotelEuro > 0 ? `Volo <strong>€${fpEuro}</strong> + Hotel <strong>€${hotelEuro}</strong>` : `Max <strong>€${maxNightDisplay}</strong>/notte`}</p>
      <p class="klook-budget-box__sub">${pricesVerified ? `${cityShown} · ${nights} notti` : `≈ €${hotelQuota} per ${nights} notti a ${cityShown}`}</p>
    </div>
    <p class="klook-microcopy">${escHtml(klookCopy)}</p>
    <div class="package-card__actions package-card__actions--stacked">
      <a href="${klookHref}" target="_blank" rel="noopener noreferrer sponsored" class="package-btn package-btn--klook">Verifica hotel su Klook</a>
      <a href="${kiwiHref}" target="_blank" rel="noopener noreferrer sponsored" class="package-btn package-btn--kiwi">${escHtml(flightBtn)}</a>
    </div>
    <p class="package-card__fineprint">Volo: verifica su Aviasales. Hotel: ricerca Klook con date e ospiti già inseriti.</p>
  </article>`;

  html += `<p class="hotel-partner-note">Due passaggi separati: hotel su Klook, voli su Aviasales.</p>`;

  html += `<div class="total-card">
    <div class="total-rows">
      ${budgetNum > 0 ? `<div class="total-row-item total-row-item--budget"><span>🎯 Budget</span><span>€${budgetNum}</span></div>` : ""}
      <div class="total-row-item"><span>📋 ${pricesVerified ? "Totale quotato" : "Piano"}</span><span>€${planTotal}</span></div>
      <div class="total-row-item"><span>✈️ Volo</span><span>€${fpEuro}</span></div>
      <div class="total-row-item"><span>🏨 Hotel</span><span>€${pricesVerified ? hotelEuro : hotelQuota}</span></div>
      ${Number.isFinite(risparmioNum) && risparmioNum >= 0 && budgetNum > 0 ? `<div class="total-row-item"><span>💚 Dopo il volo (per hotel)</span><span>~€${risparmioNum}</span></div>` : ""}
    </div>
    <a href="/offerta-live" class="prenota-btn" style="text-align:center;text-decoration:none;display:block">Apri pagina risultati →</a>
    <p style="text-align:center;margin-top:0.75rem;font-size:0.85rem;opacity:0.9"><a href="/registrati" style="color:white;text-decoration:underline">Attiva alert email</a></p>
  </div>`;

  results.innerHTML = html;
  results.classList.add("show");
  results.scrollIntoView({ behavior: "smooth", block: "start" });

  if (wasSurprise) {
    document.getElementById("reveal-dest-btn").addEventListener("click", () => {
      const card = document.getElementById("surprise-card");
      card.innerHTML = `<div class="surprise-icon">🎉</div><h3>La tua destinazione è... <em style="color:var(--sun)">${escHtml(destReal)}!</em></h3><p>L'hotel migliore nel budget è sotto.</p>`;
      card.style.borderColor = "#86efac";
      card.style.background = "#f0fdf4";
      const routeLine = document.getElementById("packages-route-line");
      if (routeLine) routeLine.textContent = `${fromLabel} → ${destReal} · ${f.departDate} → ${f.returnDate}`;
    });
  }
}


function renderLegacyPackageResults(preview, insurance, wasSurprise) {
  const results = document.getElementById("results");
  const f = preview.flight;
  const airHelpHref = f.airHelpLink || AFFILIATE_AIRHELP_FALLBACK;
  const fromLabel = preview.partenza;
  const destLabel = wasSurprise ? "?" : f.destination;
  const destReal = f.destination;
  const budgetNum = Number(preview.budget) || 0;
  const totaleNum = Number(preview.prezzo_totale);
  const risparmioNum = Number(preview.risparmio);
  const fpEuro = Number(preview.flight_price_euro != null ? preview.flight_price_euro : f.price);
  let html = `<div style="max-width:600px;margin:0 auto;padding:0 0 3rem;">`;
  if (wasSurprise) {
    html += `<div class="surprise-card" id="surprise-card"><div class="surprise-icon">🎲</div><h3>Destinazione nascosta!</h3><button type="button" class="reveal-btn" id="reveal-dest-btn">✨ Rivela</button></div>`;
  }
  const pkgs =
    Array.isArray(preview.packages) && preview.packages.length >= 3
      ? preview.packages
      : preview.hotels.slice(0, 3).map((h, i) => ({
          index: i + 1,
          flight_price_euro: fpEuro,
          hotel_price_euro: Math.round(Number(h.price) || 0),
          package_total_euro: fpEuro + Math.round(Number(h.price) || 0),
          budget_euro: budgetNum,
          within_budget: true,
          kiwi_link: effectiveFlightUrl(f),
          flight_link_source: f.flightLinkSource || "kiwi_search",
          booking_link: h.bookingLink || klookHotelHref(preview),
          air_help_link: airHelpHref,
          hotel: {
            name: h.name,
            googlePlaceMatched: !!h.googlePlaceMatched,
            rating: h.rating,
            photo: h.photos && h.photos[0] ? h.photos[0] : "",
            formattedAddress: h.formattedAddress || h.formatted_address || "",
            structureType: h.structureType,
            roomType: h.roomType,
            mealType: h.mealType,
            walkToCenterMin: h.walkToCenterMin,
            walkToSeaMin: h.walkToSeaMin,
            bestPriceLabel: h.bestPriceLabel || "",
            bestPriceProviderName: h.bestPriceProviderName || "",
            xoteloDisplayName: h.xoteloDisplayName || h.name || "",
            pricePerNightXotelo: h.pricePerNightXotelo != null ? h.pricePerNightXotelo : null,
            stayNights: h.stayNights != null ? h.stayNights : null,
            priceSource: h.priceSource || "",
          },
        }));

  const stayDisclaimer =
    String(preview.stay_pricing_disclaimer || "").trim() ||
    "Volo con prezzo reale (Aviasales). Hotel: strutture reali da Google; l'importo alloggio è la quota nel budget. Tariffa camera su Klook al click.";
  const budgetVerifyNote = String(preview.budget_verification_note || "").trim();
  const worstRef = Math.round(Number(preview.package_worst_case_euro) || 0);
  const headroomRef = Math.round(Number(preview.budget_headroom_euro) || 0);

  const refHotel = (preview.hotels && preview.hotels[0]) || {};
  const summaryUsesQuotedHotel =
    refHotel.priceSource === "amadeus" ||
    refHotel.priceSource === "google" ||
    refHotel.priceSource === "xotelo" ||
    refHotel.priceSource === "booking";

  const flightMain = Number.isFinite(Number(preview.flight_price_euro))
    ? Math.round(Number(preview.flight_price_euro))
    : Math.round(Number(f.price) || 0);
  const stayMain = Math.round(Number(preview.stay_allocation_euro) || 0);
  const planRef =
    Number.isFinite(totaleNum) && totaleNum > 0 ? totaleNum : flightMain + stayMain;

  html += `<div class="results-label">Tre idee: volo + dove dormire</div>
  <p class="packages-route-line" id="packages-route-line">${escHtml(`${fromLabel} → ${destLabel}`)} · ${escHtml(f.timeBand)} · ${escHtml(
    f.departDate
  )} → ${escHtml(f.returnDate)}</p>
  ${
    budgetNum > 0
      ? summaryUsesQuotedHotel
        ? `<div class="results-budget-summary"><p><strong>Budget €${budgetNum}</strong> · Quotato <strong>€${planRef}</strong>${worstRef > 0 ? ` · verificato fino a <strong>€${worstRef}</strong>` : ""}${headroomRef > 0 ? ` (margine <strong>€${headroomRef}</strong>)` : ""}.</p>${budgetVerifyNote ? `<p class="results-budget-summary__sub">${escHtml(budgetVerifyNote)}</p>` : ""}<p class="results-budget-summary__sub">${escHtml(stayDisclaimer)}</p></div>`
        : `<div class="results-budget-summary"><p><strong>Budget €${budgetNum}</strong> · Volo indicativo <strong>€${flightMain}</strong> · Quota alloggio su Klook <strong>fino a €${stayMain}</strong> · Piano di riferimento <strong>€${planRef}</strong> entro il budget.</p><p class="results-budget-summary__sub">${escHtml(stayDisclaimer)}</p></div>`
      : `<p class="flight-budget-line flight-budget-line--neutral">${escHtml(stayDisclaimer)}</p>`
  }`;

  pkgs.forEach((pkg) => {
    const h = pkg.hotel || {};
    const img = h.photo || "";
    const tags = [h.structureType, h.roomType, h.mealType].filter(Boolean);
    const walkLine =
      h.walkToCenterMin != null
        ? h.walkToSeaMin != null
          ? `🚶 ${h.walkToSeaMin} min mare · ${h.walkToCenterMin} min centro`
          : `🚶 ca. ${h.walkToCenterMin} min dal centro`
        : "Dettagli e prezzo finale su Klook.";
    const kiwiHref = String(pkg.kiwi_link || "").trim() || effectiveFlightUrl(f, pkg);
    const bookHref =
      String(pkg.booking_link || "").trim() ||
      String((preview.hotels && preview.hotels[0] && preview.hotels[0].bookingLink) || "").trim() ||
      klookHotelHref(preview);
    const pkgAirHelp = String(pkg.air_help_link || "").trim() || airHelpHref;
    const flightPkg = Math.round(Number(pkg.flight_price_euro) || 0);
    const hotelQuota = Math.round(Number(pkg.hotel_price_euro) || 0);
    const pkgTotal = Math.round(Number(pkg.package_total_euro) || flightPkg + hotelQuota);
    const amadeusHotel = h.priceSource === "amadeus";
    const googleHotel = h.priceSource === "google";
    const xotel = h.priceSource === "xotelo";
    const nightsLbl = h.stayNights != null ? `${h.stayNights} notti` : "soggiorno";
    const pkgWorst = Math.round(Number(pkg.package_total_worst_case_euro) || 0);
    const pkgHeadroom = Math.round(Number(pkg.budget_headroom_euro) || 0);
    const hotelHint =
      amadeusHotel || googleHotel || xotel
        ? `<p class="package-card__quota-hint">Piano <strong>€${pkgTotal}</strong> (volo <strong>€${flightPkg}</strong> + hotel <strong>€${hotelQuota}</strong>, ${nightsLbl})${pkgHeadroom > 0 ? ` · margine ~€${pkgHeadroom}` : ""}${h.bestPriceLabel ? ` · ${escHtml(h.bestPriceLabel)}` : ""}</p>`
        : `<p class="package-card__quota-hint">Quota alloggio <strong>€${hotelQuota}</strong> nel budget — tariffa camera su Klook.</p>`;
    const bookBtn = hotelButtonLabel(h);
    const fineHotel = hotelFineprint(h);
    const flightBtn = flightButtonLabel(pkg, f);
    html += `<article class="package-card">
      <div class="package-card__top">
        <span class="package-card__badge">Idea ${pkg.index}</span>
        <div class="package-card__total">
          <span class="package-card__total-label">${amadeusHotel || googleHotel || xotel ? "Totale quotato" : "Volo"}</span>
          <strong class="package-card__total-eur">€${amadeusHotel || googleHotel || xotel ? pkgTotal : flightPkg}</strong>
        </div>
      </div>
      ${hotelHint}
      <img class="package-card__img" src="${escHtml(img)}" alt="" loading="lazy" width="600" height="160" />
      <div class="package-card__body">
        <div class="package-card__hotel-name">${escHtml(h.name || "")}</div>
        ${hotelReviewBlock(h)}
        <div class="hotel-location">📍 ${escHtml(walkLine)}</div>
        <div class="hotel-tags">${tags.map((t) => `<span class="hotel-tag">${escHtml(t)}</span>`).join("")}</div>
        <div class="package-card__actions">
          <a href="${escHtml(kiwiHref)}" target="_blank" rel="noopener noreferrer sponsored" class="package-btn package-btn--kiwi">${escHtml(flightBtn)}</a>
          <a href="${escHtml(bookHref)}" target="_blank" rel="noopener noreferrer sponsored nofollow" class="package-btn package-btn--booking">${escHtml(bookBtn)}</a>
        </div>
        <p class="package-card__fineprint">${escHtml(fineHotel)}</p>
        <p class="package-card__airhelp"><a href="${escHtml(pkgAirHelp)}" target="_blank" rel="noopener noreferrer sponsored">AirHelp — diritti passeggeri</a></p>
      </div>
    </article>`;
  });

  html += `<p class="hotel-partner-note">${
    summaryUsesQuotedHotel
      ? "Tre hotel reali (Google Maps), scelti a caso tra quelli in città: ogni card ha volo + quota alloggio nel budget. Prezzo camera su Klook."
      : "Tre idee volo + alloggio nel budget. Tariffa hotel su Klook al click."
  }</p>`;

  html += `<div class="total-card">
    <div class="total-rows">
      ${
        budgetNum > 0
          ? `<div class="total-row-item total-row-item--budget"><span>🎯 Budget che hai indicato</span><span>€${budgetNum}</span></div>`
          : ""
      }
      <div class="total-row-item"><span>✈️ Volo (prezzo quotato)</span><span>€${Number.isFinite(flightMain) ? flightMain : "—"}</span></div>
      ${
        Number.isFinite(totaleNum) && totaleNum > 0 && budgetNum > 0
          ? `<div class="total-row-item"><span>✅ Piano di riferimento (volo + hotel)</span><span>€${totaleNum} entro €${budgetNum}</span></div>`
          : ""
      }
      ${
        Number.isFinite(risparmioNum) && risparmioNum >= 0 && budgetNum > 0
          ? `<div class="total-row-item"><span>💚 Dopo il volo (per hotel, es.)</span><span>~€${risparmioNum}</span></div>`
          : ""
      }
      ${
        insurance
          ? `<div class="total-row-item"><span>🛡️ Assicurazione</span><span>Opzione in fase di ricerca</span></div>`
          : ""
      }
    </div>
    <a href="/offerta-live" class="prenota-btn" style="text-align:center;text-decoration:none;display:block">Apri pagina risultati Partiamo →</a>
    <p style="text-align:center;margin-top:0.75rem;font-size:0.85rem;opacity:0.9">
      <a href="/registrati" style="color:white;text-decoration:underline">Attiva alert email</a>
    </p>
  </div></div>`;

  results.innerHTML = html;
  results.classList.add("show");
  results.scrollIntoView({ behavior: "smooth", block: "start" });

  if (wasSurprise) {
    document.getElementById("reveal-dest-btn").addEventListener("click", () => {
      const card = document.getElementById("surprise-card");
      card.innerHTML = `<div class="surprise-icon">🎉</div><h3>La tua destinazione è... <em style="color:var(--sun)">${escHtml(
        destReal
      )}!</em></h3><p>Le tre idee volo + dove dormire sono sotto.</p>`;
      card.style.borderColor = "#86efac";
      card.style.background = "#f0fdf4";
      const routeLine = document.getElementById("packages-route-line");
      if (routeLine)
        routeLine.textContent = `${fromLabel} → ${destReal} · ${f.timeBand} · ${f.departDate} → ${f.returnDate}`;
    });
  }
}


function initDates() {
  const today = new Date();
  const d1 = new Date(today);
  d1.setMonth(today.getMonth() + 1);
  const d2 = new Date(d1);
  d2.setDate(d1.getDate() + 4);
  document.getElementById("date-from").value = d1.toISOString().split("T")[0];
  document.getElementById("date-to").value = d2.toISOString().split("T")[0];
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootHome);
} else {
  bootHome();
}
