/**

 * Klook hotel — deeplink affiliato Travelpayouts (nessuna API hotel).

 */



const DESTINATIONS = require("./destinations-data.json");

const KLOOK_CITY_PAGES = require("./klook-city-pages.json");



const KLOOK_HOTELS_SEARCH_BASE = "https://www.klook.com/hotels/searchresult/";

const KLOOK_HOTELS_CITY_BASE = "https://www.klook.com/hotels/city/";

const KLOOK_DESTINATION_BASE = "https://www.klook.com/destination/";

const TP_MEDIA_REDIRECT_BASE = "https://tp.media/r";



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
      if (hit?.aliases?.length) return String(hit.aliases[0]).trim();
      if (hit?.label) return String(hit.label).trim();
    }
    return label;
  }
  const code = sanitizeIata3(iata3);

  const dest = DESTINATIONS.find((d) => d.iata === code);

  if (dest?.aliases?.length) return String(dest.aliases[0]).trim();

  return sanitizeCityLabel(cityLabel);

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

function buildKlookSearchParams({ checkIn, checkOut, adults, rooms, currency, maxPricePerNight, maxTotalPrice }) {

  const params = new URLSearchParams();

  if (isIsoDate(checkIn)) params.set("check_in", String(checkIn).slice(0, 10));

  if (isIsoDate(checkOut)) params.set("check_out", String(checkOut).slice(0, 10));

  params.set("adult_num", String(Math.max(1, Math.min(9, Number(adults) || 2))));

  params.set("room_num", String(Math.max(1, Math.min(8, Number(rooms) || 1))));

  params.set("child_num", "0");
  params.set("age", "");

  const cur = String(currency || "EUR").toUpperCase().slice(0, 3) || "EUR";

  params.set("currency", cur);

  params.set("sort_type", "1");
  params.set("sort_selected", "");
  const maxNight = Math.floor(Number(maxPricePerNight) || 0);
  const maxTotal = Math.floor(Number(maxTotalPrice) || 0);
  if (maxNight > 0) {
    // Klook non documenta pubblicamente il filtro prezzo URL: inviamo i nomi più comuni.
    params.set("max_price", String(maxNight));
    params.set("price_max", String(maxNight));
    params.set("maxPrice", String(maxNight));
  }
  if (maxTotal > 0) {
    params.set("max_total_price", String(maxTotal));
  }

  return params;

}

function klookCityIdFromPage(page) {
  const m = String(page?.slug || "").match(/^(\d+)-/);
  return m ? m[1] : "";
}



/**

 * URL ricerca hotel Klook con città + date + ospiti.
 * Usa searchresult: evita che la homepage Klook erediti l'ultima città dalla sessione.

 */

function buildKlookHotelSearchUrl({

  city,

  keyword,

  checkIn,

  checkOut,

  adults,

  rooms,

  currency = "EUR",

  maxPricePerNight,

  maxTotalPrice,

  destIata,

  iata,

} = {}) {

  const iata3 = sanitizeIata3(destIata || iata);

  const cityLabel = sanitizeCityLabel(keyword || city || "");

  const params = buildKlookSearchParams({
    checkIn,
    checkOut,
    adults,
    rooms,
    currency,
    maxPricePerNight,
    maxTotalPrice,
  });

  const kw = englishKeywordForKlook(iata3, cityLabel);

  const page = resolveKlookCityPage(iata3, cityLabel);
  const cityId = klookCityIdFromPage(page);
  const title = String(page?.en || kw || cityLabel || "").trim();
  if (cityId) {
    params.set("stype", "city");
    params.set("svalue", cityId);
    params.set("city_id", cityId);
  } else {
    params.set("stype", "keyword");
    params.set("svalue", title);
  }
  if (title) {
    params.set("title", title);
    params.set("override", String(page?.override || title));
    params.set("keyword", title);
  }

  return `${KLOOK_HOTELS_SEARCH_BASE}?${params.toString()}`;

}



/**

 * Deeplink Travelpayouts → Klook (programma hotel: campaign_id=137, p=4110).

 */

function wrapTravelpayoutsAffiliateUrl(targetUrl) {

  const u = String(targetUrl || "").trim();

  if (!u) return "";

  const marker = getTravelpayoutsMarker();

  const p = getTravelpayoutsKlookProgramId();

  const campaignId = getTravelpayoutsKlookCampaignId();

  if (!marker || !p) return "";

  const params = new URLSearchParams();

  if (campaignId) params.set("campaign_id", campaignId);

  params.set("marker", marker);

  params.set("p", p);

  params.set("trs", "1");

  params.set("u", u);

  return `${TP_MEDIA_REDIRECT_BASE}?${params.toString()}`;

}



function buildKlookAffiliateHotelUrl(opts) {

  return wrapTravelpayoutsAffiliateUrl(buildKlookHotelSearchUrl(opts));

}



module.exports = {

  computeHotelBudgetFromTrip,

  buildKlookHotelSearchUrl,

  buildKlookAffiliateHotelUrl,

  wrapTravelpayoutsAffiliateUrl,

  stayNightsBetweenIsoDates,

  sanitizeCityLabel,

  getTravelpayoutsMarker,

  resolveKlookCityPage,

};


