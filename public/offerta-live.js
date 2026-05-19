const FLIGHT_FALLBACK_COVER =
  "https://images.unsplash.com/photo-1436491865332-7a61a109cc05?auto=format&fit=crop&w=1400&q=85";
const AFFILIATE_KIWI_FALLBACK = "https://kiwi.tpk.lv/UiOvgyTf";
const FLIGHT_PRICE_STORAGE_KEY = "partiamo_manual_flight_price";
const KLOOK_HOTEL_ORIGIN = "https://www.klook.com/en-GB";

const KLOOK_COPY_DEFAULT =
  "Cerca il volo su Kiwi, inserisci il prezzo totale trovato, poi Partiamo calcola il budget hotel residuo e apre Klook filtrato.";

function escHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

function effectiveFlightUrl(flight, preview) {
  const u = String(
    (preview && preview.kiwi_flight_url) || (flight && flight.flightLink) || ""
  ).trim();
  return u || AFFILIATE_KIWI_FALLBACK;
}

function passengerCountFromPreview(preview) {
  const p = preview?.passengers;
  if (p && Number.isFinite(Number(p.adults))) {
    return Math.max(1, (Number(p.adults) || 0) + (Number(p.children) || 0) + (Number(p.infants) || 0));
  }
  const raw = String(preview?.passengers_count ?? preview?.persone ?? "2").replace(/\D/g, "");
  return Math.max(1, Math.min(9, Number(raw) || 1));
}

function passengerSummaryFromPreview(preview) {
  if (preview?.passengers_summary) return String(preview.passengers_summary);
  const p = preview?.passengers;
  if (p && Number.isFinite(Number(p.adults))) {
    const parts = [`${p.adults} adult${p.adults === 1 ? "o" : "i"}`];
    if (p.children > 0) parts.push(`${p.children} bambin${p.children === 1 ? "o" : "i"}`);
    if (p.infants > 0) parts.push(`${p.infants} neonat${p.infants === 1 ? "o" : "i"}`);
    return parts.join(", ");
  }
  const n = passengerCountFromPreview(preview);
  return `${n} persona${n === 1 ? "" : "e"}`;
}

function readStoredFlightPrice() {
  const raw = sessionStorage.getItem(FLIGHT_PRICE_STORAGE_KEY);
  const n = Math.round(Number(raw) || 0);
  return n > 0 ? n : 0;
}

function storeFlightPrice(value) {
  const n = Math.round(Number(value) || 0);
  if (n > 0) sessionStorage.setItem(FLIGHT_PRICE_STORAGE_KEY, String(n));
  else sessionStorage.removeItem(FLIGHT_PRICE_STORAGE_KEY);
}

function applyHotelBudgetToken(template, hotelBudget) {
  const token = String(Math.max(0, Math.floor(Number(hotelBudget) || 0)));
  return String(template || "").replace(/__HOTEL_BUDGET__/g, token);
}

function isKlookHotelUrl(urlString) {
  return /klook\.com(?:\/[a-z]{2}(?:-[a-z]{2})?)?\/hotels\b/i.test(String(urlString || ""));
}

function isKlookHotelBrowseUrl(urlString) {
  return /klook\.com(?:\/[a-z]{2}(?:-[a-z]{2})?)?\/hotels\/(city|searchresult|destination)\b/i.test(
    String(urlString || "")
  );
}

let klookCityPages = null;
const klookCityPagesReady = fetch("/klook-city-pages.json")
  .then((r) => (r.ok ? r.json() : {}))
  .then((j) => {
    klookCityPages = j && typeof j === "object" ? j : {};
    return klookCityPages;
  })
  .catch(() => {
    klookCityPages = {};
    return klookCityPages;
  });

function enrichPreviewKlookSlugs(preview) {
  if (!preview || !klookCityPages) return preview;
  const iata = String(preview?.flight?.destinationCode || "").toUpperCase();
  const page = iata && klookCityPages[iata];
  if (page?.kind === "city" && page.slug) preview.klook_city_page_slug = page.slug;
  if (page?.kind === "destination" && page.slug) preview.klook_destination_page_slug = page.slug;
  return preview;
}

function extractKlookHotelUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  if (isKlookHotelUrl(raw)) return raw;
  try {
    const u = new URL(raw);
    const nested = u.searchParams.get("u") || u.searchParams.get("custom_url");
    if (nested) {
      const decoded = decodeURIComponent(nested);
      if (isKlookHotelUrl(decoded)) return decoded;
    }
  } catch (_e) {
    /* ignore */
  }
  return "";
}

const KLOOK_PRICE_QUERY_KEYS = [
  "filter_selected",
  "filter_price_high",
  "filter_price_low",
  "high_price",
  "max_price",
  "price_max",
  "maxPrice",
  "price_range",
  "max_total_price",
  "sort_selected",
];

function stayNightsForPreview(preview) {
  const checkIn = String(preview?.requested_check_in || preview?.flight?.departDate || "").slice(0, 10);
  const checkOut = String(preview?.requested_check_out || preview?.flight?.returnDate || "").slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(checkIn) && /^\d{4}-\d{2}-\d{2}$/.test(checkOut)) {
    const diffMs = new Date(checkOut).getTime() - new Date(checkIn).getTime();
    const n = Math.ceil(diffMs / (1000 * 3600 * 24));
    return Math.max(1, Math.min(21, n || 1));
  }
  return Math.max(1, Math.floor(Number(preview?.stay_nights) || 1));
}

function stripKlookPriceParams(urlString) {
  let u;
  try {
    u = new URL(String(urlString || "").trim());
  } catch (_e) {
    return String(urlString || "").trim();
  }
  if (!isKlookHotelUrl(u.href)) return u.toString();
  for (const key of KLOOK_PRICE_QUERY_KEYS) u.searchParams.delete(key);
  return u.toString();
}

/** taxes|2 = «Price includes taxes & fees» nel menu Klook. */
const KLOOK_TAXES_INCLUDED = "2";
const MIN_KLOOK_MAX_PRICE_EUR = 40;

function buildKlookFilterSelected(maxPerNightEuro, { taxesOnly = false } = {}) {
  if (taxesOnly) return `taxes|${KLOOK_TAXES_INCLUDED}`;
  const max = Math.max(1, Math.floor(Number(maxPerNightEuro) || 0));
  return `taxes|${KLOOK_TAXES_INCLUDED},price|0-${max}`;
}

function isKlookKeywordSearchUrl(urlString) {
  try {
    const u = new URL(String(urlString || "").trim());
    const path = u.pathname.replace(/^\/(en|it|fr|de|es|zh|ja|ko)(?=\/)/i, "") || u.pathname;
    if (!/\/hotels\/searchresult/i.test(path)) return false;
    if (u.searchParams.get("stype") === "keyword") return true;
    return !u.searchParams.get("city_id");
  } catch (_e) {
    return false;
  }
}

function cityLabelFromKlookCityPath(pathname) {
  const slug = String(pathname || "")
    .split("/")
    .filter(Boolean)
    .pop();
  const m = String(slug || "").match(/^\d+-(.+)-hotels$/i);
  if (!m) return "";
  return m[1]
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function tryKlookListUrlFromSearchResult(u, maxTotalPrice) {
  const city =
    u.searchParams.get("override") ||
    u.searchParams.get("title") ||
    u.searchParams.get("svalue") ||
    cityLabelFromKlookCityPath(u.pathname) ||
    "";
  const checkIn = u.searchParams.get("check_in") || u.searchParams.get("checkIn");
  const checkOut = u.searchParams.get("check_out") || u.searchParams.get("checkOut");
  return "";
}

function applyKlookBudgetToUrl(urlString, hotelBudgetTotalEuro, stayNights, opts = {}) {
  const raw = stripKlookPriceParams(String(urlString || "").trim());
  if (!raw || !/klook\.com(?:\/[a-z]{2}(?:-[a-z]{2})?)?\/hotels\b/i.test(raw)) return raw;
  let taxesOnly = opts.taxesOnly === true;
  const perNightFilter = taxesOnly ? 0 : klookFilterPerNightCap(hotelBudgetTotalEuro, stayNights);
  const total = Math.max(0, Math.floor(Number(hotelBudgetTotalEuro) || 0));
  let u;
  try {
    u = new URL(raw);
  } catch (_e) {
    return raw;
  }
  const pathForKlook = u.pathname.replace(/^\/(en|it|fr|de|es|zh|ja|ko)(?=\/)/i, "") || u.pathname;
  if (/\/hotels\/(city|destination)\//i.test(pathForKlook)) {
    u.searchParams.delete("max_total_price");
    if (total >= MIN_KLOOK_MAX_PRICE_EUR) u.searchParams.set("max_total_price", String(total));
    return u.toString();
  }
  if (/\/hotels\/list\//i.test(pathForKlook)) {
    return "";
  }
  if (isKlookKeywordSearchUrl(u.toString()) && total < MIN_KLOOK_MAX_PRICE_EUR) {
    taxesOnly = true;
  }
  for (const key of KLOOK_PRICE_QUERY_KEYS) u.searchParams.delete(key);
  u.searchParams.set("sort_selected", "hotel_score");
  if (taxesOnly) {
    u.searchParams.set("filter_selected", buildKlookFilterSelected(0, { taxesOnly: true }));
    return u.toString();
  }
  u.searchParams.set("filter_selected", buildKlookFilterSelected(perNightFilter));
  u.searchParams.set("filter_price_high", String(perNightFilter));
  u.searchParams.set("filter_price_low", "0");
  u.searchParams.set("high_price", String(perNightFilter));
  u.searchParams.set("price_range", `0,${perNightFilter}`);
  u.searchParams.set("max_total_price", String(total));
  return u.toString();
}

function klookPerNightBudget(total, nights) {
  const n = Math.max(1, Math.floor(Number(nights) || 1));
  const t = Math.max(0, Math.floor(Number(total) || 0));
  return t > 0 ? Math.max(1, Math.round(t / n)) : 0;
}

function klookFilterPerNightCap(total, nights) {
  const strict = klookPerNightBudget(total, nights);
  if (strict <= 0) return 0;
  return Math.max(strict + 12, Math.ceil(strict * 1.25));
}

function appendKlookAffiliateTracking(urlString) {
  return String(urlString || "").trim();
}

function isKlookListHotelUrl(urlString) {
  try {
    const u = new URL(String(urlString || "").trim());
    const path = u.pathname.replace(/^\/(en|it|fr|de|es|zh|ja|ko)(?=\/)/i, "") || u.pathname;
    return /\/hotels\/list\//i.test(path);
  } catch (_e) {
    return false;
  }
}

function buildKlookBrowseUrlFromPreview(preview) {
  enrichPreviewKlookSlugs(preview);
  const f = preview?.flight || {};
  const checkIn = String(preview?.requested_check_in || f.departDate || "").slice(0, 10);
  const checkOut = String(preview?.requested_check_out || f.returnDate || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut)) return "";
  const adults = Math.max(
    1,
    Math.min(9, Number(String(preview?.passengers_count ?? preview?.persone ?? "1").replace(/\D/g, "")) || 1)
  );
  const citySlug = String(preview?.klook_city_page_slug || "").trim();
  if (citySlug) {
    const u = new URL(`${KLOOK_HOTEL_ORIGIN}/hotels/city/${citySlug}/`);
    u.searchParams.set("check_in", checkIn);
    u.searchParams.set("check_out", checkOut);
    u.searchParams.set("adult_num", String(adults));
    return u.toString();
  }
  const destSlug = String(preview?.klook_destination_page_slug || "").trim();
  if (destSlug) {
    const u = new URL(`${KLOOK_HOTEL_ORIGIN}/destination/${destSlug}/`);
    u.searchParams.set("check_in", checkIn);
    u.searchParams.set("check_out", checkOut);
    u.searchParams.set("adult_num", String(adults));
    return u.toString();
  }
  return "";
}

function klookBaseFromPreview(preview) {
  for (const raw of [
    preview?.klook_hotel_direct_url_template,
    preview?.klook_hotel_base_url,
    preview?.klook_hotel_url_template,
  ]) {
    const extracted = extractKlookHotelUrl(raw);
    if (extracted && isKlookHotelBrowseUrl(extracted)) {
      return stripKlookPriceParams(extracted);
    }
  }
  return "";
}

function buildManualKlookHref(preview, hotelBudget, opts = {}) {
  const total = Math.max(0, Math.floor(Number(hotelBudget) || 0));
  if (total <= 0) return "";
  enrichPreviewKlookSlugs(preview);
  let base = buildKlookBrowseUrlFromPreview(preview);
  if (!base) {
    const fromTemplate = klookBaseFromPreview(preview);
    if (fromTemplate && !isKlookListHotelUrl(fromTemplate)) base = fromTemplate;
  }
  if (!base || isKlookListHotelUrl(base)) return "";
  return appendKlookAffiliateTracking(
    applyKlookBudgetToUrl(base, total, stayNightsForPreview(preview), opts)
  );
}

function klookBudgetHintText(hotelBudget, nights) {
  const n = Math.max(1, Math.floor(Number(nights) || 1));
  const total = Math.max(0, Math.floor(Number(hotelBudget) || 0));
  const perNight = klookPerNightBudget(total, n);
  if (total <= 0) return "Inserisci il prezzo volo per calcolare il budget hotel.";
  return `Ti restano €${total} per l'hotel (≈ €${perNight}/notte × ${n} notti).`;
}

function klookFilterDetailText(strictPerNight, filterCapPerNight) {
  const strict = Math.max(1, Math.floor(Number(strictPerNight) || 0));
  const cap = Math.max(strict, Math.floor(Number(filterCapPerNight) || 0));
  if (cap > strict) {
    return `Su Klook: prezzi con tasse incluse, filtro fino a ~€${cap}/notte (budget tuo ≈ €${strict}/notte). Se ancora non vedi hotel, usa il link sotto.`;
  }
  return `Su Klook: prezzi con tasse incluse, filtro fino a €${cap}/notte.`;
}

function repairPreviewKlookClient(preview) {
  if (!preview) return preview;
  enrichPreviewKlookSlugs(preview);
  let direct = buildKlookBrowseUrlFromPreview(preview);
  if (!direct) {
    direct = String(
      preview.klook_hotel_direct_url_template || preview.klook_hotel_direct_url || ""
    ).trim();
    const aff = String(preview.klook_hotel_url_template || "").trim();
    if (!direct && aff) direct = extractKlookHotelUrl(aff);
    if (direct && isKlookListHotelUrl(direct)) direct = "";
  }
  const aff = String(preview.klook_hotel_url_template || "").trim();
  if (direct && isKlookHotelUrl(direct) && !isKlookListHotelUrl(direct)) {
    preview.klook_hotel_direct_url_template = stripKlookPriceParams(direct);
    preview.klook_hotel_base_url = preview.klook_hotel_direct_url_template;
    if (/tp\.media\/r/i.test(aff)) delete preview.klook_hotel_url_template;
  }
  return preview;
}

function setKlookOutboundLink(el, url) {
  if (!el) return;
  const u = String(url || "").trim();
  if (!u || isKlookListHotelUrl(u) || /\/it\/hotels\/list\//i.test(u)) {
    el.removeAttribute("data-klook-href");
    el.removeAttribute("data-klook-direct");
    el.href = "#";
    return;
  }
  el.setAttribute("data-klook-direct", "1");
  el.setAttribute("data-klook-href", u);
  el.href = u;
}

document.addEventListener(
  "click",
  (e) => {
    const el = e.target.closest("a[data-klook-direct][data-klook-href]");
    if (!el) return;
    const url = String(el.getAttribute("data-klook-href") || "").trim();
    if (!url || isKlookListHotelUrl(url)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    const tab = window.open(url, "_blank", "noopener,noreferrer");
    if (tab) tab.opener = null;
  },
  true
);

function wireManualKlookButton(btn, preview, getHotelBudget) {
  if (!btn) return;
  btn.setAttribute("data-klook-direct", "1");
  btn.addEventListener("click", (e) => {
    const budget = getHotelBudget();
    if (budget <= 0) {
      e.preventDefault();
      return;
    }
    const url = buildManualKlookHref(preview, budget);
    if (!url) {
      e.preventDefault();
      return;
    }
    setKlookOutboundLink(btn, url);
  });
}

function renderManualKiwiKlookCard(preview) {
  const f = preview.flight || {};
  const budgetNum = Math.max(0, Math.round(Number(preview.budget) || 0));
  const paxSummary = escHtml(passengerSummaryFromPreview(preview));
  const fromLabel = escHtml(preview.partenza || f.from || "");
  const destLabel = escHtml(f.destination || preview.destination_city || "");
  const dateFrom = escHtml(preview.requested_check_in || f.departDate || "");
  const dateTo = escHtml(preview.requested_check_out || f.returnDate || "");
  const kiwiHref = escHtml(effectiveFlightUrl(f, preview));
  const storedPrice = readStoredFlightPrice();
  const stayNights = stayNightsForPreview(preview);

  const article = document.createElement("article");
  article.className = "package-card package-card--single package-card--klook fade-up";
  article.innerHTML = `
    <div class="package-card__top">
      <span class="package-card__badge">Volo + hotel guidato</span>
      <div class="package-card__total">
        <span class="package-card__total-label">✈️ ${fromLabel} → ${destLabel}</span>
        <strong class="package-card__total-eur">💰 Budget totale: €${budgetNum}</strong>
        <span class="package-card__total-sub">📅 ${dateFrom} → ${dateTo} · 👥 ${paxSummary}</span>
      </div>
    </div>
    <p class="klook-microcopy">${escHtml(String(preview.stay_pricing_disclaimer || "").trim() || KLOOK_COPY_DEFAULT)}</p>
    <div class="package-card__actions package-card__actions--stacked">
      <a href="${kiwiHref}" target="_blank" rel="noopener noreferrer sponsored" class="package-btn package-btn--kiwi">Cerca volo su Kiwi</a>
    </div>
    <div class="klook-budget-box" style="margin-top:1rem">
      <label for="manual-flight-price" class="klook-budget-box__title">Hai trovato il volo? Inserisci il prezzo totale</label>
      <div style="display:flex;align-items:center;gap:0.5rem;margin-top:0.5rem">
        <span style="font-weight:800">€</span>
        <input id="manual-flight-price" type="number" min="0" step="1" inputmode="decimal" placeholder="es. 120" value="${storedPrice > 0 ? storedPrice : ""}" style="width:100%;padding:0.85rem 1rem;border:1px solid #dbe3ef;border-radius:14px;font-size:1rem" />
      </div>
      <p id="manual-hotel-budget" class="klook-budget-box__sub" style="margin-top:0.75rem">Inserisci il prezzo volo per calcolare il budget hotel.</p>
      <p id="klook-filter-detail" class="klook-budget-box__sub" hidden style="margin-top:0.5rem;font-size:0.88rem;line-height:1.45;color:#4a5568"></p>
      <p id="klook-fallback-wrap" hidden style="margin-top:0.5rem;font-size:0.88rem"><a id="klook-fallback-link" href="#" target="_blank" rel="noopener noreferrer sponsored">Nessun hotel nel budget? Apri Klook con tasse incluse, senza limite di prezzo</a></p>
    </div>
    <div class="package-card__actions package-card__actions--stacked">
      <a id="manual-klook-btn" href="#" target="_blank" rel="noopener noreferrer sponsored" class="package-btn package-btn--klook" aria-disabled="true" style="pointer-events:none;opacity:0.45">Cerca hotel su Klook</a>
    </div>
    <p class="package-card__fineprint">Su Klook apriamo prezzi con tasse incluse e il budget a notte calcolato da Partiamo. Se non ci sono hotel in quella fascia, puoi alzare il massimo €/notte sul filtro Klook.</p>
  `;

  const input = article.querySelector("#manual-flight-price");
  const output = article.querySelector("#manual-hotel-budget");
  const filterDetail = article.querySelector("#klook-filter-detail");
  const fallbackWrap = article.querySelector("#klook-fallback-wrap");
  const fallbackLink = article.querySelector("#klook-fallback-link");
  const klookBtn = article.querySelector("#manual-klook-btn");
  const update = () => {
    const flightPrice = Math.max(0, Math.round(Number(input.value) || 0));
    storeFlightPrice(flightPrice);
    const hotelBudget = Math.floor(budgetNum - flightPrice);
    const perNight = klookPerNightBudget(hotelBudget, stayNights);
    const filterCap = klookFilterPerNightCap(hotelBudget, stayNights);
    if (filterDetail) filterDetail.hidden = true;
    if (fallbackWrap) fallbackWrap.hidden = true;
    if (flightPrice <= 0) {
      output.textContent = klookBudgetHintText(0, stayNights);
      klookBtn.href = "#";
      klookBtn.style.pointerEvents = "none";
      klookBtn.style.opacity = "0.45";
      klookBtn.setAttribute("aria-disabled", "true");
      return;
    }
    if (hotelBudget <= 0) {
      output.textContent = `Il volo costa €${flightPrice}: non resta budget per l'hotel.`;
      klookBtn.href = "#";
      klookBtn.style.pointerEvents = "none";
      klookBtn.style.opacity = "0.45";
      klookBtn.setAttribute("aria-disabled", "true");
      return;
    }
    output.textContent = klookBudgetHintText(hotelBudget, stayNights);
    if (filterDetail && perNight > 0) {
      filterDetail.textContent = klookFilterDetailText(perNight, filterCap);
      filterDetail.hidden = false;
    }
    const klookUrl = buildManualKlookHref(preview, hotelBudget);
    const fallbackUrl = buildManualKlookHref(preview, hotelBudget, { taxesOnly: true });
    if (fallbackWrap && fallbackLink && fallbackUrl) {
      setKlookOutboundLink(fallbackLink, fallbackUrl);
      fallbackWrap.hidden = false;
    }
    setKlookOutboundLink(klookBtn, klookUrl);
    klookBtn.style.pointerEvents = klookUrl ? "auto" : "none";
    klookBtn.style.opacity = klookUrl ? "1" : "0.45";
    klookBtn.setAttribute("aria-disabled", klookUrl ? "false" : "true");
  };
  input.addEventListener("input", update);
  wireManualKlookButton(klookBtn, preview, () =>
    Math.floor(budgetNum - Math.max(0, Math.round(Number(input.value) || 0)))
  );
  update();
  return article;
}

async function initLivePage() {
  await klookCityPagesReady;
  const raw = sessionStorage.getItem("partiamo_live_preview");
  if (!raw) {
    document.getElementById("error").textContent =
      "Nessun risultato disponibile. Torna alla home e avvia una ricerca.";
    return;
  }

  let preview;
  try {
    preview = repairPreviewKlookClient(JSON.parse(raw));
    sessionStorage.setItem("partiamo_live_preview", JSON.stringify(preview));
  } catch (_e) {
    document.getElementById("error").textContent = "Risultato non valido. Riprova la ricerca.";
    return;
  }

  if (!preview.flight) {
    document.getElementById("error").textContent = "Risultato incompleto. Riprova la ricerca.";
    return;
  }

  const f = preview.flight;
  const heroImg = document.getElementById("flightHeroImg");
  if (heroImg) heroImg.src = f.coverPhoto || FLIGHT_FALLBACK_COVER;

  const routeEl = document.getElementById("flightRoute");
  if (routeEl) routeEl.textContent = `${preview.partenza} → ${f.destination}`;

  const datesEl = document.getElementById("dateVolo");
  if (datesEl) datesEl.textContent = `${f.departDate} → ${f.returnDate}`;

  const voloLink = document.getElementById("voloLink");
  if (voloLink) {
    voloLink.href = effectiveFlightUrl(f, preview);
    const btn = voloLink.querySelector("button");
    if (btn) btn.textContent = "Cerca volo su Kiwi";
  }

  const airHelpLink = document.getElementById("airHelpLink");
  if (airHelpLink && f.airHelpLink) airHelpLink.href = f.airHelpLink;

  const budgetHint = document.getElementById("budgetHint");
  if (budgetHint) {
    const budgetNum = Math.max(0, Math.round(Number(preview.budget) || 0));
    budgetHint.textContent = budgetNum > 0 ? `Budget totale: €${budgetNum}` : "";
  }

  const routeLine = document.getElementById("packagesRouteLine");
  if (routeLine) {
    routeLine.textContent = `${preview.partenza} → ${f.destination} · ${f.departDate} → ${f.returnDate}`;
  }

  const note = document.getElementById("hotelPartnerNote");
  if (note) {
    note.textContent =
      preview.card_mode === "manual_kiwi_klook"
        ? "Due passaggi: volo su Kiwi, hotel su Klook con filtro sul budget residuo."
        : String(preview.stay_pricing_disclaimer || "").trim() || KLOOK_COPY_DEFAULT;
  }

  const container = document.getElementById("packageGrid");
  if (!container) {
    document.getElementById("error").textContent = "Pagina risultati non configurata correttamente.";
    return;
  }

  container.innerHTML = "";
  if (preview.card_mode === "manual_kiwi_klook") {
    container.appendChild(renderManualKiwiKlookCard(preview));
    return;
  }

  document.getElementById("error").textContent =
    "Formato risultato non aggiornato. Torna alla home e ripeti la ricerca.";
}

initLivePage();
