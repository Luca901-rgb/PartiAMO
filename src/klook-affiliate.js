/**

 * Klook hotel — deeplink affiliato Travelpayouts (nessuna API hotel).

 */



const DESTINATIONS = require("./destinations-data.json");

const KLOOK_CITY_PAGES = require("./klook-city-pages.json");



/** Hotel Klook: le pagine /hotels/city/ non esistono su /it/ (404). en-GB ha inventario EU in EUR. */
const KLOOK_SITE = String(process.env.KLOOK_SITE_ORIGIN || "https://www.klook.com/en-GB").replace(/\/$/, "");

const KLOOK_HOTELS_SEARCH_BASE = `${KLOOK_SITE}/hotels/searchresult/`;

const KLOOK_HOTELS_LIST_BASE = `${KLOOK_SITE}/hotels/list/`;

const KLOOK_HOTELS_CITY_BASE = `${KLOOK_SITE}/hotels/city/`;

const KLOOK_DESTINATION_BASE = `${KLOOK_SITE}/destination/`;

const TP_CLICK_REDIRECT_BASE = "https://c111.travelpayouts.com/click";

/** Sotto questa soglia Klook /hotels/list/ con maxPrice va in homepage (es. maxPrice=1). */
const MIN_KLOOK_MAX_PRICE_EUR = 40;

/** Accetta klook.com/hotels e klook.com/it/hotels (e altre lingue). */
function isKlookHotelUrl(urlString) {
  return /klook\.com(?:\/[a-z]{2}(?:-[a-z]{2})?)?\/hotels\b/i.test(String(urlString || ""));
}



function isIsoDate(value) {

  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));

}



function stayNightsBetweenIsoDates(checkIn, checkOut) {

  const chkIn = isIsoDate(checkIn) ? String(checkIn).slice(0, 10) : "";

  const chkOut = isIsoDate(checkOut) ? String(checkOut).slice(0, 10) : "";

  if (!chkIn || !chkOut) return 0;

  const diffMs = new Date(chkOut).getTime() - new Date(chkIn).getTime();

  const n = Math.ceil(diffMs / (1000 * 3600 * 24));

  return Math.max(1, Math.min(21, n || 1));

}



function sanitizeCityLabel(label) {

  let city = String(label || "").trim();

  try {

    city = city.replace(/\p{Extended_Pictographic}/gu, "");

  } catch (_e) {

    city = city.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "");

  }

  return city.replace(/\s+/g, " ").trim();

}



function sanitizeIata3(raw) {

  return String(raw || "")

    .toUpperCase()

    .replace(/[^A-Z]/g, "")

    .slice(0, 3);

}



function getTravelpayoutsMarker() {

  return String(process.env.TRAVELPAYOUTS_MARKER || "725780").trim();

}



function getTravelpayoutsKlookProgramId() {

  return String(process.env.TRAVELPAYOUTS_KLOOK_P || "4110").trim();

}



function getTravelpayoutsKlookCampaignId() {

  return String(process.env.TRAVELPAYOUTS_KLOOK_CAMPAIGN_ID || "137").trim();

}



/** Metro IATA → aeroporti (stesso mapping di search.js per PAR→CDG ecc.). */

const METRO_TO_PRIMARY_IATA = {

  PAR: "PAR",

  LON: "LON",

  ROM: "ROM",

  MIL: "MIL",

  NYC: "NYC",

};



function resolveKlookCityPage(iata3, cityLabel) {

  const direct = sanitizeIata3(iata3);

  if (direct && KLOOK_CITY_PAGES[direct]) return KLOOK_CITY_PAGES[direct];



  const metro = METRO_TO_PRIMARY_IATA[direct];

  if (metro && KLOOK_CITY_PAGES[metro]) return KLOOK_CITY_PAGES[metro];



  const label = sanitizeCityLabel(cityLabel);

  if (label) {

    const hit = DESTINATIONS.find((d) => {

      const lab = String(d.label || "").toLowerCase();

      return lab === label.toLowerCase() || (d.aliases || []).some((a) => String(a).toLowerCase() === label.toLowerCase());

    });

    if (hit?.iata && KLOOK_CITY_PAGES[hit.iata]) return KLOOK_CITY_PAGES[hit.iata];

  }

  return null;

}



function preferredEnglishAlias(aliases) {
  const list = Array.isArray(aliases) ? aliases : [];
  const latin = list.find((a) => /^[A-Za-z][A-Za-z\s\-'.]*$/.test(String(a || "").trim()));
  if (latin) return String(latin).trim();
  return list.length ? String(list[0]).trim() : "";
}

function englishKeywordForKlook(iata3, cityLabel) {
  const page = resolveKlookCityPage(iata3, cityLabel);
  if (page?.en) return page.en;

  const label = sanitizeCityLabel(cityLabel);
  if (label) {
    const parts = label
      .split(/[,\-–—|/]+/)
      .map((p) => sanitizeCityLabel(p))
      .filter(Boolean);
    const candidates = [...parts].reverse().concat(label);
    for (const c of candidates) {
      const folded = c.toLowerCase();
      const hit = DESTINATIONS.find((d) => {
        const destLabels = [d.label, ...(d.aliases || [])].map((v) => String(v || "").toLowerCase());
        return destLabels.includes(folded);
      });
      if (hit?.aliases?.length) {
        const en = preferredEnglishAlias(hit.aliases);
        if (en) return en;
      }
      if (hit?.label) return String(hit.label).trim();
    }
    return label;
  }
  const code = sanitizeIata3(iata3);

  const dest = DESTINATIONS.find((d) => d.iata === code);

  if (dest?.aliases?.length) {
    const en = preferredEnglishAlias(dest.aliases);
    if (en) return en;
  }

  return sanitizeCityLabel(cityLabel);

}

/** Nome città per URL Klook (inglese / override pagina città). */
function klookSearchCityLabel(iata3, cityLabel) {
  const page = resolveKlookCityPage(iata3, cityLabel);
  if (page?.override) return String(page.override).trim();
  if (page?.en) return String(page.en).trim();
  return sanitizeCityLabel(englishKeywordForKlook(iata3, cityLabel) || cityLabel || "");
}

function destinationKlookResolvable(iata3, cityLabel) {
  const page = resolveKlookCityPage(iata3, cityLabel);
  if (page?.en || page?.override) return true;
  const kw = englishKeywordForKlook(iata3, cityLabel);
  const it = String(cityLabel || "")
    .trim()
    .toLowerCase();
  return Boolean(kw) && kw.toLowerCase() !== it;
}



/**

 * Budget hotel da budget totale − volo; max €/notte per il soggiorno.

 */

function computeHotelBudgetFromTrip(budgetTotal, flightPriceEuro, checkIn, checkOut) {

  const B = Math.max(0, Number(budgetTotal) || 0);

  const fp = Math.max(0, Math.floor(Number(flightPriceEuro) || 0));

  const nights = stayNightsBetweenIsoDates(checkIn, checkOut);

  const hotelTotalBudget = Math.max(0, Math.floor(B - fp));

  const hotelMaxPerNight =

    nights > 0 ? Math.max(1, Math.floor(hotelTotalBudget / nights)) : hotelTotalBudget;

  return {

    nights,

    hotelTotalBudget,

    hotelMaxPerNight,

    packagePlanTotal: Math.min(B, fp + hotelTotalBudget),

  };

}



/** Parametri data/ospiti nel formato usato da Klook (pagine città e dettaglio). */

function buildKlookSearchParams({ checkIn, checkOut, adults, child_num, age, rooms, currency, maxPricePerNight, maxTotalPrice }) {

  const params = new URLSearchParams();

  if (isIsoDate(checkIn)) params.set("check_in", String(checkIn).slice(0, 10));

  if (isIsoDate(checkOut)) params.set("check_out", String(checkOut).slice(0, 10));

  params.set("adult_num", String(Math.max(1, Math.min(9, Number(adults) || 2))));

  params.set("room_num", String(Math.max(1, Math.min(8, Number(rooms) || 1))));

  const children = Math.max(0, Math.min(8, Number(child_num) || 0));
  params.set("child_num", String(children));
  params.set("age", children > 0 ? String(age || "").trim() : "");

  const cur = String(currency || "EUR").toUpperCase().slice(0, 3) || "EUR";

  params.set("currency", cur);

  params.set("sort_type", "1");
  const maxNight = Math.floor(Number(maxPricePerNight) || 0);
  const maxTotal = Math.floor(Number(maxTotalPrice) || 0);
  if (maxNight > 0) {
    params.set("filter_selected", buildKlookFilterSelected(maxNight));
    params.set("sort_selected", "hotel_score");
    params.set("filter_price_high", String(maxNight));
    params.set("filter_price_low", "0");
  }
  if (maxTotal > 0) {
    params.set("max_total_price", String(maxTotal));
  }

  return params;

}

function klookPerNightBudget(hotelBudgetTotalEuro, stayNights) {
  const nights = Math.max(1, Math.floor(Number(stayNights) || 1));
  const total = Math.max(0, Math.floor(Number(hotelBudgetTotalEuro) || 0));
  return total > 0 ? Math.max(1, Math.round(total / nights)) : 0;
}

/** Tetto €/notte inviato a Klook: leggermente sopra il budget strict per mostrare hotel vicini (come sul sito Klook). */
function klookFilterPerNightCap(hotelBudgetTotalEuro, stayNights) {
  const strict = klookPerNightBudget(hotelBudgetTotalEuro, stayNights);
  if (strict <= 0) return 0;
  const buffered = Math.ceil(strict * 1.25);
  return Math.max(strict + 12, buffered);
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

function stripKlookPriceParams(urlString) {
  let u;
  try {
    u = new URL(String(urlString || "").trim());
  } catch (_e) {
    return String(urlString || "").trim();
  }
  if (!isKlookHotelUrl(u.href)) return u.toString();
  for (const key of KLOOK_PRICE_QUERY_KEYS) u.searchParams.delete(key);
  const fs = u.searchParams.get("filter_selected");
  if (fs) u.searchParams.set("filter_selected", normalizeKlookTaxesInFilterSelected(fs));
  return u.toString();
}

function stayNightsForPreview(preview) {
  const checkIn = String(preview?.requested_check_in || preview?.flight?.departDate || "").slice(0, 10);
  const checkOut = String(preview?.requested_check_out || preview?.flight?.returnDate || "").slice(0, 10);
  const fromDates = stayNightsBetweenIsoDates(checkIn, checkOut);
  if (fromDates > 0) return fromDates;
  return Math.max(1, Math.floor(Number(preview?.stay_nights) || 1));
}

/** Wrap affiliato controllato (c111/click) — mai tp-em che riscrive in /it/hotels/list/. */
function buildKlookAffiliateUrl(klookCityUrl) {
  return wrapTravelpayoutsAffiliateUrl(klookCityUrl);
}

function appendKlookAffiliateTracking(urlString) {
  const direct = String(urlString || "").trim();
  if (!direct || isKlookListHotelUrl(direct)) return "";
  if (shouldWrapKlookAffiliate()) {
    return buildKlookAffiliateUrl(direct) || direct;
  }
  return direct;
}

function isKlookHotelBrowseUrl(urlString) {
  return /klook\.com(?:\/[a-z]{2}(?:-[a-z]{2})?)?\/hotels\/(city|searchresult|destination)\b/i.test(
    String(urlString || "")
  );
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

function klookPageSlugsForPreview(preview) {
  const f = preview?.flight || {};
  const destIata = sanitizeIata3(f.destinationCode || preview.destinazione_iata);
  const cityLabel = String(
    preview?.klook_city_label || preview?.destination_city || f.destination || ""
  ).trim();
  const page = resolveKlookCityPage(destIata, cityLabel);
  return {
    klook_city_page_slug: page?.kind === "city" ? String(page.slug || "") : "",
    klook_destination_page_slug: page?.kind === "destination" ? String(page.slug || "") : "",
  };
}

/** Ricostruisce pagina città/destination (mai /hotels/list/). */
function rebuildKlookBrowseUrlFromPreview(preview) {
  const f = preview?.flight || {};
  const destIata = sanitizeIata3(f.destinationCode || preview.destinazione_iata);
  const checkIn = String(preview?.requested_check_in || f.departDate || "").slice(0, 10);
  const checkOut = String(preview?.requested_check_out || f.returnDate || "").slice(0, 10);
  const cityLabel = String(
    preview?.klook_city_label || preview?.destination_city || f.destination || ""
  ).trim();
  const pax = preview?.passengers;
  const adults = Math.max(
    1,
    Math.min(
      9,
      Number(pax?.adults) ||
        Number(String(preview?.passengers_count ?? preview?.persone ?? "2").replace(/\D/g, "")) ||
        2
    )
  );
  const child_num = Math.max(0, Math.min(8, Number(pax?.children) || 0));
  return (
    buildKlookHotelSearchUrl({
      destIata,
      city: cityLabel,
      checkIn,
      checkOut,
      adults,
      child_num,
      currency: "EUR",
    }) || ""
  );
}

function klookBaseSearchUrlFromPreview(preview) {
  const candidates = [
    preview?.klook_hotel_direct_url_template,
    preview?.klook_hotel_base_url,
    extractNestedKlookHotelUrl(preview?.klook_hotel_url_template),
  ];
  for (const raw of candidates) {
    const extracted = extractNestedKlookHotelUrl(raw) || String(raw || "").trim();
    if (extracted && isKlookHotelBrowseUrl(extracted)) {
      return stripKlookPriceParams(extracted);
    }
  }
  return "";
}

function buildManualKlookHotelUrl(preview, hotelBudgetTotalEuro, opts = {}) {
  const total = Math.max(0, Math.floor(Number(hotelBudgetTotalEuro) || 0));
  if (total <= 0) return "";
  const nights = stayNightsForPreview(preview);
  const base = klookBaseSearchUrlFromPreview(preview);
  if (!base) return "";
  const klookUrl = applyKlookBudgetToUrl(base, total, nights, opts);
  return appendKlookAffiliateTracking(klookUrl);
}

/**
 * Dropdown Klook «Budget (per night)»:
 * - taxes|1 → Price excludes taxes & fees (screenshot London)
 * - taxes|2 → Price includes taxes & fees
 */
const KLOOK_FILTER_TAXES_INCLUDED = "2";
const KLOOK_FILTER_TAXES_EXCLUDED = "1";

function normalizeKlookTaxesInFilterSelected(filterSelected) {
  const raw = String(filterSelected || "").trim();
  if (!raw) return raw;
  return raw.replace(/taxes\|1\b/g, `taxes|${KLOOK_FILTER_TAXES_INCLUDED}`);
}

function buildKlookFilterSelected(maxPerNightEuro, { taxesOnly = false } = {}) {
  if (taxesOnly) return `taxes|${KLOOK_FILTER_TAXES_INCLUDED}`;
  const max = Math.max(1, Math.floor(Number(maxPerNightEuro) || 0));
  return `taxes|${KLOOK_FILTER_TAXES_INCLUDED},price|0-${max}`;
}

/**
 * Formato list/ (quello della tua specifica): city + checkIn/out + maxPrice (totale soggiorno).
 */
/** Solo parametri essenziali: Klook flagga URL con age= vuoto e troppi query param. */
function appendKlookStayParams(url, { checkIn, checkOut, adults, child_num, age, rooms }) {
  if (isIsoDate(checkIn)) url.searchParams.set("check_in", String(checkIn).slice(0, 10));
  if (isIsoDate(checkOut)) url.searchParams.set("check_out", String(checkOut).slice(0, 10));
  url.searchParams.set("adult_num", String(Math.max(1, Math.min(9, Number(adults) || 2))));
  const roomN = Math.max(1, Math.min(8, Number(rooms) || 1));
  if (roomN > 1) url.searchParams.set("room_num", String(roomN));
  const children = Math.max(0, Math.min(8, Number(child_num) || 0));
  if (children > 0) {
    url.searchParams.set("child_num", String(children));
    const ageStr = String(age || "").trim();
    if (ageStr) url.searchParams.set("age", ageStr);
  }
}

/** Pagina città Klook (/hotels/city/348-bucharest-hotels/) — più affidabile del searchresult. */
function buildKlookHotelCityPageUrl({
  page,
  checkIn,
  checkOut,
  adults,
  child_num,
  age,
  rooms,
  currency,
  maxTotalPrice,
} = {}) {
  if (!page || page.kind !== "city" || !/^\d+-/.test(String(page.slug || ""))) return "";
  if (!isIsoDate(checkIn) || !isIsoDate(checkOut)) return "";
  const u = new URL(`${KLOOK_HOTELS_CITY_BASE}${page.slug}/`);
  appendKlookStayParams(u, { checkIn, checkOut, adults, child_num, age, rooms, currency });
  const max = Math.floor(Number(maxTotalPrice) || 0);
  if (max >= MIN_KLOOK_MAX_PRICE_EUR) u.searchParams.set("max_total_price", String(max));
  return u.toString();
}

/** Pagina destination Klook (Milano, Lisbona, Dubai: slug c…/3-hotel). */
function buildKlookHotelDestinationPageUrl({
  page,
  checkIn,
  checkOut,
  adults,
  child_num,
  age,
  rooms,
  currency,
} = {}) {
  if (!page || page.kind !== "destination" || !/^c[\w-]+\/3-hotel$/i.test(String(page.slug || ""))) return "";
  if (!isIsoDate(checkIn) || !isIsoDate(checkOut)) return "";
  const u = new URL(`${KLOOK_DESTINATION_BASE}${page.slug}/`);
  appendKlookStayParams(u, { checkIn, checkOut, adults, child_num, age, rooms, currency });
  return u.toString();
}

/** Deprecato: /hotels/list/ → homepage. Non usare. */
function buildKlookHotelsListUrl() {
  return "";
}

/** Fallback: ricerca generica en-GB (mai /hotels/list/). */
function buildKlookHotelsGenericFallbackUrl({
  query,
  checkIn,
  checkOut,
  adults,
  child_num,
  age,
  rooms,
  maxTotalPrice,
} = {}) {
  const q = sanitizeCityLabel(query || "");
  if (!q || !isIsoDate(checkIn) || !isIsoDate(checkOut)) return "";
  const u = new URL(`${KLOOK_SITE}/hotels/`);
  u.searchParams.set("city_id", "0");
  u.searchParams.set("query", q);
  appendKlookStayParams(u, { checkIn, checkOut, adults, child_num, age, rooms });
  const max = Math.floor(Number(maxTotalPrice) || 0);
  if (max >= MIN_KLOOK_MAX_PRICE_EUR) u.searchParams.set("max_total_price", String(max));
  return u.toString();
}

/**
 * URL hotel con budget su searchresult (filter_selected applica il filtro prezzo su Klook).
 */
function buildKlookHotelUrlWithBudget({
  city,
  checkIn,
  checkOut,
  adults,
  destIata,
  hotelBudgetTotalEuro,
  stayNights,
} = {}) {
  const nights = Math.max(1, Math.floor(Number(stayNights) || 1));
  const total = Math.max(1, Math.floor(Number(hotelBudgetTotalEuro) || 0));
  const perNight = klookPerNightBudget(total, nights);
  const sr = buildKlookHotelSearchUrl({
    city,
    destIata,
    checkIn,
    checkOut,
    adults,
    maxPricePerNight: perNight,
    maxTotalPrice: total,
  });
  if (!sr) return { url: "", perNight, total, format: "" };
  return {
    url: applyKlookBudgetToUrl(sr, total, nights),
    perNight,
    total,
    format: "searchresult",
  };
}

function applyKlookBudgetToUrl(urlString, hotelBudgetTotalEuro, stayNights, opts = {}) {
  const raw = stripKlookPriceParams(String(urlString || "").trim());
  if (!raw || !isKlookHotelUrl(raw)) return raw;
  let taxesOnly = opts.taxesOnly === true;
  const perNightStrict = klookPerNightBudget(hotelBudgetTotalEuro, stayNights);
  const perNightFilter = taxesOnly ? 0 : klookFilterPerNightCap(hotelBudgetTotalEuro, stayNights);
  const total = Math.max(0, Math.floor(Number(hotelBudgetTotalEuro) || 0));
  let u;
  try {
    u = new URL(raw);
  } catch (_e) {
    return raw;
  }
  const pathForKlook = u.pathname.replace(/^\/(en|it|fr|de|es|zh|ja|ko)(?=\/)/i, "") || u.pathname;
  const isCityPage =
    /\/hotels\/(city|destination)\//i.test(pathForKlook) ||
    /\/hotels\/(city|destination)\//i.test(u.pathname);
  const isGenericSearch =
    /\/hotels\/?$/i.test(pathForKlook) && (u.searchParams.has("query") || u.searchParams.get("city_id") === "0");
  if (isCityPage || isGenericSearch) {
    u.searchParams.delete("max_total_price");
    const minHotel = Number(MIN_KLOOK_MAX_PRICE_EUR) || 40;
    if (total >= minHotel) {
      u.searchParams.set("max_total_price", String(total));
    }
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
  const filterSel = buildKlookFilterSelected(perNightFilter);
  u.searchParams.set("filter_selected", filterSel);
  u.searchParams.set("filter_price_high", String(perNightFilter));
  u.searchParams.set("filter_price_low", "0");
  u.searchParams.set("high_price", String(perNightFilter));
  u.searchParams.set("price_range", `0,${perNightFilter}`);
  u.searchParams.set("max_total_price", String(total));
  return u.toString();
}

function klookCityIdFromPage(page) {
  const m = String(page?.slug || "").match(/^(\d+)-/);
  return m ? m[1] : "";
}

/** Ricerca per parola chiave (senza city_id): i filtri prezzo in URL spesso mandano in errore Klook. */
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

function tryKlookListUrlFromSearchResult() {
  return "";
}

function tryKlookListUrlFromAnyHotelUrl() {
  return "";
}



/**
 * URL ricerca hotel Klook — non usa più /searchresult/ (instabile su molte città).
 * Ordine: pagina città numerica → pagina destination → /hotels/list/.
 */
function buildKlookHotelSearchUrl({
  city,
  keyword,
  checkIn,
  checkOut,
  adults,
  child_num,
  age,
  rooms,
  currency = "EUR",
  maxPricePerNight,
  maxTotalPrice,
  destIata,
  iata,
} = {}) {
  const iata3 = sanitizeIata3(destIata || iata);
  const cityLabel = sanitizeCityLabel(keyword || city || "");
  const page = resolveKlookCityPage(iata3, cityLabel);
  const searchLabel = klookSearchCityLabel(iata3, cityLabel);
  const nights = stayNightsBetweenIsoDates(checkIn, checkOut);
  const total =
    Math.floor(Number(maxTotalPrice) || 0) ||
    (maxPricePerNight && nights ? Math.floor(Number(maxPricePerNight) || 0) * nights : 0);

  const cityUrl = buildKlookHotelCityPageUrl({
    page,
    checkIn,
    checkOut,
    adults,
    child_num,
    age,
    rooms,
    currency,
    maxTotalPrice: total,
  });
  if (cityUrl) return cityUrl;

  const destUrl = buildKlookHotelDestinationPageUrl({
    page,
    checkIn,
    checkOut,
    adults,
    child_num,
    age,
    rooms,
    currency,
  });
  if (destUrl) return destUrl;

  return buildKlookHotelsGenericFallbackUrl({
    query: searchLabel || cityLabel || englishKeywordForKlook(iata3, cityLabel),
    checkIn,
    checkOut,
    adults,
    child_num,
    age,
    rooms,
    maxTotalPrice: total,
  });
}



/**

 * Deeplink Travelpayouts → Klook (promo_id=4110, marker 725780).

 * tp.media/r restituisce "traffic_source is not valid" — usiamo c111/click + custom_url.

 */

function shouldWrapKlookAffiliate() {
  return String(process.env.KLOOK_AFFILIATE_WRAP || "0").trim() === "1";
}

function wrapTravelpayoutsAffiliateUrl(targetUrl) {

  const u = String(targetUrl || "").trim();

  if (!u) return "";

  if (isKlookHotelUrl(u) && !shouldWrapKlookAffiliate()) {
    return u;
  }

  const marker = getTravelpayoutsMarker();

  const promoId = String(

    process.env.TRAVELPAYOUTS_KLOOK_PROMO_ID || process.env.TRAVELPAYOUTS_KLOOK_P || "4110"

  ).trim();

  if (!marker || !promoId) return u;

  const link = new URL(TP_CLICK_REDIRECT_BASE);

  link.searchParams.set("shmarker", marker);

  link.searchParams.set("promo_id", promoId);

  link.searchParams.set("source_type", "customlink");

  link.searchParams.set("type", "click");

  link.searchParams.set("custom_url", u);

  return link.toString();

}



function buildKlookAffiliateHotelUrl(opts) {
  return buildKlookHotelSearchUrl(opts);
}

/** Estrae URL Klook da link diretto o da wrapper tp.media / c111.travelpayouts.com. */
function extractNestedKlookHotelUrl(wrapped) {
  const raw = String(wrapped || "").trim();
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

/** Ripara preview con link tp.media obsoleti (traffic_source is not valid). */
function repairKlookPreviewTemplates(preview) {
  if (!preview) return preview;
  Object.assign(preview, klookPageSlugsForPreview(preview));
  let direct = String(preview.klook_hotel_direct_url_template || preview.klook_hotel_direct_url || "").trim();
  const aff = String(preview.klook_hotel_url_template || "").trim();
  if (!direct && aff) direct = extractNestedKlookHotelUrl(aff);
  if (direct && isKlookListHotelUrl(direct)) {
    const rebuilt = rebuildKlookBrowseUrlFromPreview(preview);
    if (rebuilt) direct = rebuilt;
  }
  if (!direct || !isKlookHotelBrowseUrl(direct)) {
    const rebuilt = rebuildKlookBrowseUrlFromPreview(preview);
    if (rebuilt) direct = rebuilt;
  }
  if (direct && isKlookHotelUrl(direct)) {
    const clean = stripKlookPriceParams(direct);
    preview.klook_hotel_direct_url_template = clean;
    preview.klook_hotel_base_url = clean;
    preview.klook_hotel_url_template = appendKlookAffiliateTracking(clean) || clean;
  }
  const klookUrl = String(preview.klook_hotel_url || "").trim();
  if (klookUrl && /tp\.media\/r/i.test(klookUrl)) {
    preview.klook_hotel_url =
      preview.klook_hotel_direct_url ||
      extractNestedKlookHotelUrl(klookUrl) ||
      wrapTravelpayoutsAffiliateUrl(preview.klook_hotel_direct_url_template || "") ||
      "";
  }
  const booking = preview.hotels?.[0]?.bookingLink;
  if (booking && /tp\.media\/r/i.test(String(booking))) {
    const fixed =
      preview.hotels[0].directBookingLink ||
      extractNestedKlookHotelUrl(booking) ||
      preview.klook_hotel_direct_url_template ||
      "";
    if (fixed) preview.hotels[0].bookingLink = fixed;
  }
  return preview;
}

module.exports = {

  computeHotelBudgetFromTrip,

  buildKlookHotelSearchUrl,

  buildKlookHotelsListUrl,

  buildKlookHotelUrlWithBudget,

  klookPerNightBudget,

  klookFilterPerNightCap,

  klookBaseSearchUrlFromPreview,

  buildKlookAffiliateHotelUrl,

  wrapTravelpayoutsAffiliateUrl,

  extractNestedKlookHotelUrl,

  applyKlookBudgetToUrl,

  buildKlookFilterSelected,

  buildManualKlookHotelUrl,

  stayNightsForPreview,

  stripKlookPriceParams,

  appendKlookAffiliateTracking,

  buildKlookAffiliateUrl,

  buildKlookHotelsGenericFallbackUrl,

  repairKlookPreviewTemplates,

  rebuildKlookBrowseUrlFromPreview,

  isKlookListHotelUrl,

  stayNightsBetweenIsoDates,

  sanitizeCityLabel,

  getTravelpayoutsMarker,

  resolveKlookCityPage,

  englishKeywordForKlook,

  klookSearchCityLabel,

  destinationKlookResolvable,

};


