const AFFILIATE_AIRHELP_FALLBACK = "https://airhelp.tpk.lv/BDuyfeVr";
const AFFILIATE_KIWI_FALLBACK = "https://kiwi.tpk.lv/UiOvgyTf";
const FLIGHT_PRICE_STORAGE_KEY = "partiamo_manual_flight_price";

function effectiveFlightUrl(flight, pkg) {
  const u = String(
    (pkg && (pkg.kiwi_flight_url || pkg.kiwi_link)) || (flight && flight.flightLink) || ""
  ).trim();
  if (u) return u;
  return AFFILIATE_KIWI_FALLBACK;
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
  return /klook\.com(?:\/[a-z]{2}(?:-[a-z]{2})?)?\/hotels\/(list|city|searchresult|destination)\b/i.test(
    String(urlString || "")
  );
}

/** Estrae l’URL Klook da link diretti o da wrapper tp.media / c111.travelpayouts.com. */
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

/** taxes|1 = excludes · taxes|2 = includes (confermato screenshot London). */
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
  if (!city || !/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut)) return "";
  const list = new URL("https://www.klook.com/it/hotels/list/");
  list.searchParams.set("city", city);
  list.searchParams.set("checkIn", checkIn);
  list.searchParams.set("checkOut", checkOut);
  list.searchParams.set("adult", String(Math.max(1, parseInt(u.searchParams.get("adult_num") || "1", 10))));
  const total = Math.max(0, Math.floor(Number(maxTotalPrice) || 0));
  if (total >= MIN_KLOOK_MAX_PRICE_EUR) list.searchParams.set("maxPrice", String(total));
  return list.toString();
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
    u.searchParams.delete("maxPrice");
    if (total >= MIN_KLOOK_MAX_PRICE_EUR) u.searchParams.set("maxPrice", String(total));
    return u.toString();
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
    const u = new URL(`https://www.klook.com/it/hotels/city/${citySlug}/`);
    u.searchParams.set("check_in", checkIn);
    u.searchParams.set("check_out", checkOut);
    u.searchParams.set("adult_num", String(adults));
    return u.toString();
  }
  const destSlug = String(preview?.klook_destination_page_slug || "").trim();
  if (destSlug) {
    const u = new URL(`https://www.klook.com/it/destination/${destSlug}/`);
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
  let base = klookBaseFromPreview(preview);
  if (!base || isKlookListHotelUrl(base)) base = buildKlookBrowseUrlFromPreview(preview);
  if (!base) return "";
  const klookUrl = applyKlookBudgetToUrl(base, total, stayNightsForPreview(preview), opts);
  return appendKlookAffiliateTracking(klookUrl);
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
  let direct = String(
    preview.klook_hotel_direct_url_template || preview.klook_hotel_direct_url || ""
  ).trim();
  const aff = String(preview.klook_hotel_url_template || "").trim();
  if (!direct && aff) direct = extractKlookHotelUrl(aff);
  if (direct && isKlookListHotelUrl(direct)) direct = buildKlookBrowseUrlFromPreview(preview) || direct;
  if (direct && isKlookHotelUrl(direct) && !isKlookListHotelUrl(direct)) {
    preview.klook_hotel_direct_url_template = stripKlookPriceParams(direct);
    preview.klook_hotel_base_url = preview.klook_hotel_direct_url_template;
    if (/tp\.media\/r/i.test(aff)) delete preview.klook_hotel_url_template;
  }
  return preview;
}

function wireManualKlookButton(btn, preview, getHotelBudget) {
  if (!btn) return;
  btn.addEventListener("click", (e) => {
    const budget = getHotelBudget();
    if (budget <= 0) {
      e.preventDefault();
      return;
    }
    const url = buildManualKlookHref(preview, budget);
    if (!url || url === "#") {
      e.preventDefault();
      return;
    }
    btn.href = url;
  });
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

function kiwiBaggageHintText(preview) {
  if (Number(preview?.destinazione_sorpresa) === 1) {
    return "Su Kiwi apriamo la ricerca con bagaglio a mano incluso (senza stiva). Puoi aggiungere stiva o «solo voli diretti» su Kiwi se ti servono.";
  }
  const bag = String(preview?.bagaglio || "Solo cabina").toLowerCase();
  if (/mano e stiva|entrambi/.test(bag)) {
    return "Su Kiwi apriamo la ricerca con prezzi che includono bagaglio a mano e in stiva (controlla i filtri Bagagli).";
  }
  if (/stiva/.test(bag)) {
    return "Su Kiwi apriamo la ricerca con prezzi che includono il bagaglio in stiva (filtro Bagagli da stiva = 1).";
  }
  return "Su Kiwi apriamo la ricerca con prezzi per bagaglio a mano incluso (senza stiva).";
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

function primaryHotelHref(preview) {
  const href = String(
    preview?.hotel_primary_url ||
      preview?.aviasales_hotel_url ||
      preview?.hotels?.[0]?.directBookingLink ||
      preview?.hotels?.[0]?.bookingLink ||
      preview?.flight?.hotelLink ||
      preview?.klook_hotel_direct_url ||
      preview?.klook_hotel_url ||
      ""
  ).trim();
  const klookDirect = extractKlookHotelUrl(href);
  if (klookDirect) return normalizeKlookHotelHref(klookDirect, preview);
  if (href && !/tp\.media\/r/i.test(href)) return normalizeKlookHotelHref(href, preview);
  return "";
}

function normalizeKlookHotelHref(href, preview) {
  const url = String(href || "").trim();
  if (!url || !/klook\.com\/hotels/i.test(url)) return url;
  const checkIn = String(preview?.requested_check_in || "").slice(0, 10);
  const checkOut = String(preview?.requested_check_out || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut)) return url;
  try {
    const u = new URL(url);
    if (/\/hotels\/list\//i.test(u.pathname)) {
      u.searchParams.set("checkIn", checkIn);
      u.searchParams.set("checkOut", checkOut);
    } else {
      u.searchParams.set("check_in", checkIn);
      u.searchParams.set("check_out", checkOut);
    }
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

async function fetchLocations(query, scope, hitsMap) {
  const q = String(query || "").trim();
  const scopeNorm = String(scope || "from").toLowerCase();
  const limit = !q ? (scopeNorm === "to" ? 160 : 120) : 24;
  const url = `/api/locations?q=${encodeURIComponent(q)}&limit=${limit}&scope=${encodeURIComponent(scopeNorm)}`;
  const r = await fetch(url);
  const j = await r.json();
  if (!j.ok || !Array.isArray(j.locations)) return [];
  const map = hitsMap || lastFromAirportHits;
  for (const loc of j.locations) {
    if (loc.iata && loc.title) map.set(String(loc.iata).toUpperCase(), loc.title);
  }
  return j.locations;
}

function locationPickerIcon(type) {
  if (type === "city") return "🏙️";
  if (type === "destination") return "✨";
  return "✈️";
}

function locationSectionLabel(type) {
  if (type === "city") return "Città";
  if (type === "destination") return "Destinazioni Partiamo";
  return "Aeroporti";
}

function initKiwiLocationPicker({ input, list, scope, hitsMap, disabled }) {
  if (!input || !list) return;
  let fetchTimer = null;
  let activeIndex = -1;
  let currentItems = [];

  function setExpanded(open) {
    input.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function pickItem(li) {
    if (!li) return;
    input.value = li.dataset.label || "";
    if (li.dataset.iata) input.dataset.iata = li.dataset.iata;
    if (li.dataset.label) input.dataset.label = li.dataset.label;
    list.hidden = true;
    setExpanded(false);
    activeIndex = -1;
    input.focus();
  }

  function setActive(index) {
    const options = list.querySelectorAll("li.kiwi-loc-option");
    options.forEach((el, i) => el.classList.toggle("is-active", i === index));
    activeIndex = index;
    if (index >= 0 && options[index]) {
      options[index].scrollIntoView({ block: "nearest" });
    }
  }

  function renderList(locations) {
    list.innerHTML = "";
    currentItems = locations;
    activeIndex = -1;
    let lastType = "";
    for (const loc of locations) {
      if (loc.type !== lastType) {
        lastType = loc.type;
        const head = document.createElement("li");
        head.className = "kiwi-loc-section";
        head.setAttribute("role", "presentation");
        head.textContent = locationSectionLabel(loc.type);
        list.appendChild(head);
      }
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.className = "kiwi-loc-option";
      li.dataset.label = loc.title;
      li.dataset.iata = loc.iata || loc.code || "";
      li.dataset.type = loc.type || "airport";

      const icon = document.createElement("span");
      icon.className = "kiwi-loc-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = locationPickerIcon(loc.type);

      const body = document.createElement("div");
      body.className = "kiwi-loc-body";
      const title = document.createElement("span");
      title.className = "kiwi-loc-title";
      title.textContent = loc.title;
      const sub = document.createElement("span");
      sub.className = "kiwi-loc-sub";
      sub.textContent = loc.subtitle || "";
      body.appendChild(title);
      if (loc.subtitle) body.appendChild(sub);

      const code = document.createElement("span");
      code.className = "kiwi-loc-code";
      code.textContent = loc.code || loc.iata || "";

      li.appendChild(icon);
      li.appendChild(body);
      li.appendChild(code);
      list.appendChild(li);
    }
    const show = locations.length > 0 && !(typeof disabled === "function" ? disabled() : disabled);
    list.hidden = !show;
    setExpanded(show);
  }

  function scheduleFetch() {
    if (typeof disabled === "function" ? disabled() : disabled) {
      list.hidden = true;
      setExpanded(false);
      return;
    }
    clearTimeout(fetchTimer);
    fetchTimer = setTimeout(async () => {
      try {
        const items = await fetchLocations(input.value, scope, hitsMap);
        renderList(items);
      } catch (_e) {
        list.hidden = true;
        setExpanded(false);
      }
    }, 160);
  }

  input.addEventListener("focus", scheduleFetch);
  input.addEventListener("input", () => {
    delete input.dataset.iata;
    delete input.dataset.label;
    scheduleFetch();
  });
  input.addEventListener("keydown", (e) => {
    const options = list.querySelectorAll("li.kiwi-loc-option");
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (list.hidden) scheduleFetch();
      else setActive(Math.min(activeIndex + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(Math.max(activeIndex - 1, 0));
    } else if (e.key === "Enter" && activeIndex >= 0 && options[activeIndex]) {
      e.preventDefault();
      pickItem(options[activeIndex]);
    } else if (e.key === "Escape") {
      list.hidden = true;
      setExpanded(false);
      activeIndex = -1;
    }
  });

  list.addEventListener("mousedown", (e) => {
    e.preventDefault();
    pickItem(e.target.closest("li.kiwi-loc-option"));
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".field--autocomplete")) {
      list.hidden = true;
      setExpanded(false);
    }
  });
}

function initFromAutocomplete() {
  initKiwiLocationPicker({
    input: document.getElementById("from"),
    list: document.getElementById("from-suggestions"),
    scope: "from",
    hitsMap: lastFromAirportHits,
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
  initKiwiLocationPicker({
    input: document.getElementById("to"),
    list: document.getElementById("to-suggestions"),
    scope: "to",
    hitsMap: lastToAirportHits,
    disabled: () => surpriseOn,
  });
}

function wirePassengerControls() {
  const adultsEl = document.getElementById("passengers-adults");
  const infantsEl = document.getElementById("passengers-infants");
  if (!adultsEl || !infantsEl) return;
  const syncInfants = () => {
    const max = Math.max(1, parseInt(adultsEl.value, 10) || 1);
    const cur = parseInt(infantsEl.value, 10) || 0;
    infantsEl.querySelectorAll("option").forEach((opt) => {
      const v = parseInt(opt.value, 10);
      opt.disabled = v > max;
    });
    if (cur > max) infantsEl.value = String(max);
  };
  adultsEl.addEventListener("change", syncInfants);
  syncInfants();
}

function bootHome() {
  initDates();
  wirePassengerControls();
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
  let adults = Math.max(1, Math.min(6, parseInt(document.getElementById("passengers-adults")?.value, 10) || 2));
  let children = Math.max(0, Math.min(4, parseInt(document.getElementById("passengers-children")?.value, 10) || 0));
  let infants = Math.max(0, Math.min(2, parseInt(document.getElementById("passengers-infants")?.value, 10) || 0));
  if (infants > adults) infants = adults;
  const persone = String(adults);

  const durata = nightsBetween(dateFrom, dateTo);

  return {
    aeroporto_partenza: mapFromToAirport(fromText),
    budget,
    persone,
    adults,
    children,
    infants,
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
    bagaglio: document.getElementById("bagaglio")?.value || "Solo cabina",
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
      const preview = repairPreviewKlookClient(result.preview);
      lastPreview = preview;
      sessionStorage.setItem("partiamo_live_preview", JSON.stringify(preview));
      renderResultsFromApi(preview, insurance, surpriseOn);
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
  if (preview.card_mode === "manual_kiwi_klook") {
    renderManualKiwiKlookResults(preview, wasSurprise);
    return;
  }
  if (
    preview.card_mode === "quoted_package" ||
    preview.card_mode === "klook_single" ||
    preview.card_mode === "hotel_search" ||
    preview.prices_verified ||
    preview.klook_hotel_url ||
    preview.hotel_stay_quota != null
  ) {
    renderKlookPackageResults(preview, insurance, wasSurprise);
    return;
  }
  renderLegacyPackageResults(preview, insurance, wasSurprise);
}

function renderManualKiwiKlookResults(preview, wasSurprise) {
  const results = document.getElementById("results");
  const f = preview.flight || {};
  const budgetNum = Math.max(0, Math.round(Number(preview.budget) || 0));
  const paxSummary = escHtml(passengerSummaryFromPreview(preview));
  const fromLabel = escHtml(preview.partenza || f.from || "");
  const destReal = f.destination || preview.destination_city || preview.surprise_destination?.label || "";
  const destLabel = escHtml(wasSurprise ? "?" : destReal);
  const dateFrom = escHtml(preview.requested_check_in || f.departDate || "");
  const dateTo = escHtml(preview.requested_check_out || f.returnDate || "");
  const kiwiHref = escHtml(preview.kiwi_flight_url || effectiveFlightUrl(f));
  const storedPrice = readStoredFlightPrice();
  const stayNights = stayNightsForPreview(preview);

  const html = `<div style="max-width:640px;margin:0 auto;padding:0 0 3rem;">
    ${wasSurprise ? `<div class="surprise-card" id="surprise-card"><div class="surprise-icon">🎲</div><h3>Destinazione a sorpresa</h3><p style="margin:0.5rem 0 0;font-size:0.9rem;opacity:0.9">Meta nel mondo scelta in base alla tua partenza e al budget — ogni ricerca può essere un continente diverso.</p><button type="button" class="reveal-btn" id="reveal-dest-btn">✨ Rivela la meta</button></div>` : ""}
    <div class="results-label">La tua ricerca</div>
    <article class="package-card package-card--single package-card--klook">
      <div class="package-card__top">
        <span class="package-card__badge">Volo + hotel guidato</span>
        <div class="package-card__total">
          <span class="package-card__total-label">✈️ ${fromLabel} → ${destLabel}</span>
          <strong class="package-card__total-eur">💰 Budget totale: €${budgetNum}</strong>
          <span class="package-card__total-sub">📅 ${dateFrom} → ${dateTo} · 👥 ${paxSummary}</span>
        </div>
      </div>

      <p class="klook-microcopy">Prima scegli il volo su Kiwi. ${escHtml(kiwiBaggageHintText(preview))} Poi inserisci qui il prezzo totale che vedi (coerente con i bagagli scelti).</p>

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
      <p class="package-card__fineprint">Su Klook apriamo prezzi con tasse incluse e il budget a notte calcolato da Partiamo. Se Klook chiede una verifica di sicurezza, completa il controllo nel browser (non usare anteprima integrata) oppure copia il link e incollalo in Chrome/Safari.</p>
    </article>
    <p style="text-align:center;margin-top:1.25rem"><a href="/offerta-live" class="prenota-btn" style="display:inline-block;text-decoration:none">Apri pagina risultati →</a></p>
  </div>`;

  results.innerHTML = html;
  results.classList.add("show");
  results.scrollIntoView({ behavior: "smooth", block: "start" });

  const input = document.getElementById("manual-flight-price");
  const output = document.getElementById("manual-hotel-budget");
  const filterDetail = document.getElementById("klook-filter-detail");
  const fallbackWrap = document.getElementById("klook-fallback-wrap");
  const fallbackLink = document.getElementById("klook-fallback-link");
  const klookBtn = document.getElementById("manual-klook-btn");
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
      fallbackLink.href = fallbackUrl;
      fallbackWrap.hidden = false;
    }
    klookBtn.href = klookUrl || "#";
    klookBtn.style.pointerEvents = klookUrl ? "auto" : "none";
    klookBtn.style.opacity = klookUrl ? "1" : "0.45";
    klookBtn.setAttribute("aria-disabled", klookUrl ? "false" : "true");
  };
  input.addEventListener("input", update);
  wireManualKlookButton(klookBtn, preview, () =>
    Math.floor(budgetNum - Math.max(0, Math.round(Number(input.value) || 0)))
  );
  const revealBtn = document.getElementById("reveal-dest-btn");
  if (revealBtn && wasSurprise) {
    revealBtn.addEventListener("click", () => {
      const card = document.getElementById("surprise-card");
      if (card) {
        card.innerHTML = `<div class="surprise-icon">🎉</div><h3>La tua destinazione è... <em style="color:var(--sun)">${escHtml(destReal)}!</em></h3><p style="margin:0.35rem 0 0;font-size:0.9rem">Kiwi e Klook sono già impostati su questa meta.</p>`;
      }
      const route = document.querySelector(".package-card__total-label");
      if (route) route.textContent = `✈️ ${fromLabel} → ${escHtml(destReal)}`;
    });
  }
  update();
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
  const hotelHref = escHtml(primaryHotelHref(preview));
  const kiwiHref = escHtml(effectiveFlightUrl(f));
  const flightBtn = flightButtonLabel(null, f, preview);
  const flightIndicative = flightIsIndicative(preview, f);
  const klookCopy =
    String(preview.stay_pricing_disclaimer || "").trim() ||
    "Apriamo Aviasales Hotels con destinazione e date già impostate.";
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
      html += `<div class="results-budget-summary"><p><strong>Budget totale €${budgetNum}</strong> per ${paxCount} adulto/i · Volo non verificato: controlla prima Aviasales. Nessun prezzo hotel viene mostrato senza verifica.</p></div>`;
    } else if (!pricesVerified) {
      html += `<div class="results-budget-summary"><p><strong>Budget €${budgetNum}</strong> · Volo verificato <strong>€${fpEuro}</strong>. Nessun prezzo hotel verificato: apri Aviasales Hotels per controllare disponibilità e totale.</p></div>`;
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
        <span class="package-card__total-label">${pricesVerified ? "Totale pacchetto" : "Volo trovato"}</span>
        <strong class="package-card__total-eur">${pricesVerified ? `€${planTotal}` : escHtml(`${fromLabel} → ${destLabel}`)}</strong>
        <span class="package-card__total-sub">${escHtml(f.departDate)} → ${escHtml(f.returnDate)} · ${nights} notti</span>
      </div>
    </div>
    <div class="klook-budget-box">
      <p class="klook-budget-box__title">${pricesVerified && hotelName ? escHtml(hotelName) : "Hotel da verificare"}</p>
      <p class="klook-budget-box__amount">${pricesVerified && hotelEuro > 0 ? `Volo <strong>€${fpEuro}</strong> + Hotel <strong>€${hotelEuro}</strong>` : `Nessun prezzo hotel verificato`}</p>
      <p class="klook-budget-box__sub">${pricesVerified ? `${cityShown} · ${nights} notti` : `Apri Aviasales Hotels per ${cityShown} · ${nights} notti`}</p>
    </div>
    <p class="klook-microcopy">${escHtml(klookCopy)}</p>
    <div class="package-card__actions package-card__actions--stacked">
      <a href="${hotelHref}" target="_blank" rel="noopener noreferrer sponsored" class="package-btn package-btn--klook">Verifica hotel su Aviasales</a>
      <a href="${kiwiHref}" target="_blank" rel="noopener noreferrer sponsored" class="package-btn package-btn--kiwi">${escHtml(flightBtn)}</a>
    </div>
    <p class="package-card__fineprint">Volo: prezzo Travelpayouts/Aviasales. Hotel: prezzo mostrato solo se verificato da Xotelo/Amadeus; altrimenti apriamo Aviasales Hotels.</p>
  </article>`;

  html += `<p class="hotel-partner-note">Due passaggi separati: hotel su Aviasales Hotels, voli su Aviasales.</p>`;

  html += `<div class="total-card">
    <div class="total-rows">
      ${budgetNum > 0 ? `<div class="total-row-item total-row-item--budget"><span>🎯 Budget</span><span>€${budgetNum}</span></div>` : ""}
      <div class="total-row-item"><span>📋 ${pricesVerified ? "Totale quotato" : "Piano"}</span><span>€${planTotal}</span></div>
      <div class="total-row-item"><span>✈️ Volo</span><span>€${fpEuro}</span></div>
      <div class="total-row-item"><span>🏨 Hotel</span><span>${pricesVerified ? `€${hotelEuro}` : "da verificare"}</span></div>
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
          booking_link: h.bookingLink || primaryHotelHref(preview),
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
      primaryHotelHref(preview);
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
