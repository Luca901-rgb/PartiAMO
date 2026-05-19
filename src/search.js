const crypto = require("crypto");
const { run } = require("./db");
const { sendOfferEmail } = require("./email");
const DESTINATIONS = require("./destinations-data.json");
const xoteloLocationKeys = require("./xotelo-location-keys.json");
const xoteloHotelSeeds = require("./xotelo-hotel-seeds.json");
const amadeusCityCoords = require("./amadeus-city-coords.json");

const {
  computeHotelBudgetFromTrip,
  buildKlookAffiliateHotelUrl,
  buildKlookHotelSearchUrl,
  wrapTravelpayoutsAffiliateUrl,
  repairKlookPreviewTemplates,
  applyKlookBudgetToUrl,
  buildKlookHotelsListUrl,
  klookPerNightBudget,
  sanitizeCityLabel: sanitizeCityLabelForKlook,
  klookSearchCityLabel,
  destinationKlookResolvable,
  resolveKlookCityPage,
} = require("./klook-affiliate");
const {
  parseTripPassengers,
  totalTripGuests,
  hotelGuestCount,
  klookGuestParams,
  passengerSummaryIt,
} = require("./passengers");

/** Notti tra due date ISO (YYYY-MM-DD). */
function stayNightsBetweenIsoDates(checkIn, checkOut) {
  const chkIn = isIsoDate(checkIn) ? String(checkIn).slice(0, 10) : "";
  const chkOut = isIsoDate(checkOut) ? String(checkOut).slice(0, 10) : "";
  if (!chkIn || !chkOut) return 0;
  const dataIn = new Date(chkIn);
  const dataOut = new Date(chkOut);
  const diffMs = dataOut.getTime() - dataIn.getTime();
  const numeroNotti = Math.ceil(diffMs / (1000 * 3600 * 24));
  return Math.max(1, Math.min(21, numeroNotti || 1));
}

/**
 * Un hotel con prezzo Xotelo live (API pubblica, senza chiavi).
 * Usa totale reale volo+hotel ≤ budget (non il margine pessimistico a 3× sul volo).
 */
async function fetchQuotedHotelXoteloSingle(flight, user, destCity, destIata) {
  const budget = Math.max(0, Number(user.budget) || 0);
  const fp = Math.round(Number(flight.price) || 0);
  const chkIn = String(flight.departDate || "").slice(0, 10);
  const chkOut = String(flight.returnDate || "").slice(0, 10);
  if (!isIsoDate(chkIn) || !isIsoDate(chkOut)) return null;
  const nights = stayNightsFromFlight(flight, user.durata);
  const maxBudget = hotelStayQuotaQuoted(budget, fp);
  if (!Number.isFinite(fp) || fp >= budget || maxBudget < 35) return null;

  const iata = sanitizeIata3(destIata || flight.destinationCode);
  const locKey = resolveXoteloLocationKeyFromIata(iata);
  if (!locKey) return null;

  const city =
    plainDestinationName(destCity) ||
    englishCityForOta(destCity, iata) ||
    destinationLabelFromCode(destIata) ||
    String(destCity || "").trim();
  const cityEn = englishCityForOta(city, iata);
  const currency = (process.env.TRAVELPAYOUTS_CURRENCY || "EUR").trim().toUpperCase().slice(0, 3) || "EUR";
  const guests = hotelGuestCount(user);
  const seedAliases = buildXoteloAliasEntriesFromSeeds(iata);

  let listRows = await fetchXoteloHotelListRows(cityEn, chkIn, chkOut, locKey);
  const aliasEntries = mergeXoteloAliasEntries(listRows, seedAliases);
  if (!aliasEntries.length) return null;
  const orderedEntries = buildXoteloRateKeyOrder(listRows, aliasEntries);
  const keysToTry = orderedEntries.filter((e) => e.hotel_key).slice(0, XOTELO_MAX_KEYS_TO_RATE);

  const affordable = [];
  for (let ci = 0; ci < keysToTry.length; ci += XOTELO_RATES_PARALLEL) {
    const chunk = keysToTry.slice(ci, ci + XOTELO_RATES_PARALLEL);
    const part = await Promise.all(
      chunk.map(async (entry) => {
        const result = await fetchXoteloRatesCached(entry.hotel_key, chkIn, chkOut, guests, currency);
        if (!result) return null;
        const pick = pickXoteloNightlyForQuote(result.rates);
        if (!pick) return null;
        const totalStay = Math.ceil(pick.nightly * nights);
        if (totalStay > maxBudget || fp + totalStay > budget) return null;
        const officialName = pickOfficialXoteloName(entry);
        const listRating =
          entry.listReviewRating != null && Number.isFinite(Number(entry.listReviewRating))
            ? (Number(entry.listReviewRating) * 2).toFixed(1)
            : "";
        return {
          entry,
          officialName,
          hotelKey: entry.hotel_key,
          nightly: pick.nightly,
          totalStay,
          nights,
          providerName: pick.row.name || "OTA",
          listImage: entry.listImage || "",
          listRating,
          priceFetchedAt: Number(result.fetchedAt) || Date.now(),
        };
      })
    );
    affordable.push(...part.filter(Boolean));
    if (affordable.length) break;
  }

  if (!affordable.length) return null;
  affordable.sort((a, b) => a.totalStay - b.totalStay);
  const bestPick = affordable[0];
  const kind = destinationKind(iata);
  const w = mockWalkForKind(kind);
  const providerLabel = String(bestPick.providerName || "").replace(/\.com/gi, "").trim() || "OTA";
  const bestPriceLine = `€${Math.round(bestPick.nightly)}/notte · €${Math.round(bestPick.totalStay)} totale · ${nights} notti (Xotelo)`;

  return {
    slug: bestPick.hotelKey || "xotelo-live",
    countryCode: "eu",
    roomType: user.tipo_camera || "Doppia",
    mealType: user.tipo_pasto || "Solo pernotto",
    structureType: "Hotel",
    name: bestPick.officialName,
    googlePlaceMatched: false,
    googleDisplayName: bestPick.officialName,
    rating: bestPick.listRating || "",
    walkToSeaMin: w.sea,
    walkToCenterMin: w.center,
    price: Math.round(bestPick.totalStay),
    stayNights: nights,
    pricePerNightEstimate: Math.round(bestPick.nightly),
    pricePerNightXotelo: Math.round(bestPick.nightly),
    stayTotalEstimate: Math.round(bestPick.totalStay),
    stayIsEstimate: false,
    priceSource: "xotelo",
    priceVerified: true,
    priceFetchedAt: bestPick.priceFetchedAt,
    bestPriceProviderName: providerLabel,
    bestPriceLabel: bestPriceLine,
    photos: bestPick.listImage ? [bestPick.listImage] : [],
    bookingLink: buildKlookHotelLink(
      {
        name: bestPick.officialName,
        xoteloDisplayName: bestPick.officialName,
        googleDisplayName: "",
        googlePlaceMatched: false,
      },
      flight,
      user.persone,
      cityEn
    ),
    formattedAddress: city,
  };
}

/**
 * Hotel con prezzo verificato (Xotelo prima, poi Amadeus) entro il budget residuo.
 */
async function fetchQuotedHotelForLive(flight, user, destCity, destIata) {
  const budget = Math.max(0, Number(user.budget) || 0);
  const fp = Math.round(Number(flight.price) || 0);
  const chkIn = String(flight.departDate || "").slice(0, 10);
  const chkOut = String(flight.returnDate || "").slice(0, 10);
  if (!isIsoDate(chkIn) || !isIsoDate(chkOut)) return null;
  const nights = stayNightsFromFlight(flight, user.durata);
  const maxBudget = hotelStayQuotaQuoted(budget, fp);
  if (!Number.isFinite(fp) || fp >= budget || maxBudget < 35) return null;

  const guests = hotelGuestCount(user);
  const city =
    plainDestinationName(destCity) ||
    englishCityForOta(destCity, destIata) ||
    destinationLabelFromCode(destIata) ||
    String(destCity || "").trim();
  const iata = sanitizeIata3(destIata || flight.destinationCode);
  const kind = destinationKind(iata);
  const w = mockWalkForKind(kind);

  const xoteloHotel = await fetchQuotedHotelXoteloSingle(flight, user, destCity, iata);
  if (xoteloHotel) return xoteloHotel;

  if (isAmadeusConfigured()) {
    try {
      const rows = await searchHotelsAmadeus(city, chkIn, chkOut, guests, maxBudget, iata);
      if (rows.length) {
        const pick = rows[0];
        const bestPriceLine = `€${Math.round(pick.nightly)}/notte · €${Math.round(pick.totalStay)} totale · ${nights} notti (Amadeus)`;
        return {
          slug: `amadeus-${pick.hotelId}`,
          countryCode: "eu",
          roomType: user.tipo_camera || "Doppia",
          mealType: user.tipo_pasto || "Solo pernotto",
          structureType: "Hotel",
          name: pick.name,
          googlePlaceMatched: true,
          googleDisplayName: pick.name,
          rating: pick.rating || "",
          walkToSeaMin: w.sea,
          walkToCenterMin: w.center,
          price: Math.round(pick.totalStay),
          stayNights: nights,
          pricePerNightEstimate: Math.round(pick.nightly),
          pricePerNightXotelo: Math.round(pick.nightly),
          stayTotalEstimate: Math.round(pick.totalStay),
          stayIsEstimate: false,
          priceSource: "amadeus",
          priceVerified: true,
          priceFetchedAt: Date.now(),
          bestPriceProviderName: "Amadeus",
          bestPriceLabel: bestPriceLine,
          photos: [],
          bookingLink: buildAviasalesHotelUrlFromFlight(flight, user),
          formattedAddress: city,
        };
      }
    } catch (e) {
      if (
        e?.code !== "AMADEUS_NO_HOTELS" &&
        e?.code !== "AMADEUS_NO_HOTELS_IN_BUDGET" &&
        e?.code !== "AMADEUS_CITY_UNKNOWN"
      ) {
        console.error("[live-hotel-amadeus]", e?.code || e?.message || e);
      }
    }
  }

  return null;
}

/** Slot hotel Klook — solo deeplink affiliato (nessuna API). */
function buildKlookSlotHotel(flight, cityLabel, user) {
  const city = sanitizeCityLabelForKlook(cityLabel);
  const nights = stayNightsForOffer(flight, user);
  const dates = stayDatesForOffer(flight, user);
  const fp = Math.round(Number(flight.price) || 0);
  const budget = computeHotelBudgetFromTrip(
    user.budget,
    fp,
    dates.checkIn,
    dates.checkOut
  );
  const affiliateUrl = buildKlookAffiliateHotelUrl({
    city,
    destIata: flight.destinationCode,
    checkIn: dates.checkIn,
    checkOut: dates.checkOut,
    adults: hotelGuestCount(user),
    currency: "EUR",
  });
  return {
    slug: `klook-${sanitizeIata3(flight.destinationCode) || "city"}`,
    name: city ? `Alloggio a ${city}` : "Alloggio in destinazione",
    price: budget.hotelTotalBudget,
    stayNights: nights,
    priceSource: "klook",
    priceVerified: false,
    bookingLink: affiliateUrl,
    photos: [],
    structureType: "Hotel",
    roomType: user.tipo_camera || "Doppia",
    mealType: user.tipo_pasto || "Solo pernotto",
  };
}

/** Mete mare / isole / coste (pool ampio vs. le 3 città fisse precedenti). */
const MARE_IATA = new Set([
  "BCN",
  "PMI",
  "IBZ",
  "AGP",
  "VLC",
  "SVQ",
  "HER",
  "RHO",
  "JTR",
  "JMK",
  "CFU",
  "CTA",
  "PMO",
  "OLB",
  "CAG",
  "NCE",
  "MRS",
  "DBV",
  "SPU",
  "LCA",
  "MLA",
  "FUE",
  "TFS",
  "LPA",
  "ACE",
  "FNC",
  "PDL",
  "HKT",
  "DPS",
  "MIA",
  "CUN",
  "RMF",
  "AYT",
  "LIS",
  "OPO",
  "DXB",
  "CAI",
  "RAK",
  "CMN",
  "TLV",
  "SYD",
  "MEL",
  "BKK",
  "GOA",
  "NAP",
  "VCE",
]);
/** Montagna / Alpi / natura (non città generiche). */
const MONT_IATA = new Set(["INN", "SZG", "ZRH", "GVA", "BRN", "REK", "MUC", "STR"]);

function destinationKind(iata) {
  const c = sanitizeIata3(iata);
  if (!c) return "citta";
  if (MARE_IATA.has(c)) return "mare";
  if (MONT_IATA.has(c)) return "montagna";
  return "citta";
}

function filterDestinationsByTipo(tipo) {
  const t = String(tipo || "Ovunque").trim();
  if (!t || t === "Ovunque") return DESTINATIONS.slice();
  const want = t === "Mare" ? "mare" : t === "Montagna" ? "montagna" : "citta";
  const filtered = DESTINATIONS.filter((d) => destinationKind(d.iata) === want);
  return filtered.length ? filtered : DESTINATIONS.slice();
}

function chooseDestination(user) {
  const pref = user.destinazione_preferita && String(user.destinazione_preferita).trim();
  if (pref) return pref;

  const pool = filterDestinationsByTipo(user.destinazione_tipo);
  if (pool.length > 0) {
    const i = crypto.randomInt(0, pool.length);
    return pool[i].label;
  }
  return DESTINATIONS[crypto.randomInt(0, DESTINATIONS.length)].label;
}

function shuffleDestinationPool(pool) {
  const copy = pool.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function isSurpriseSearch(user) {
  const pref = String(user?.destinazione_preferita || "").trim();
  return Number(user?.destinazione_sorpresa) === 1 && !pref;
}

function resolveSurpriseOrigin(user) {
  return (
    sanitizeIata3(resolveFlightOriginCodes(user.aeroporto_partenza)[0]) ||
    sanitizeIata3(user.aeroporto_partenza) ||
    "FCO"
  );
}

/** Hub italiani con più collegamenti intercontinentali (stima volo più bassa). */
const ITALIAN_LONG_HAUL_HUBS = new Set(["FCO", "CIA", "ROM", "MXP", "LIN", "BGY", "BLQ"]);

const SURPRISE_REGION_OVERRIDES = {
  NYC: "americas",
  JFK: "americas",
  EWR: "americas",
  LGA: "americas",
  MIA: "americas",
  LAX: "americas",
  SFO: "americas",
  BOS: "americas",
  ORD: "americas",
  YTO: "americas",
  CUN: "americas",
  TYO: "asia",
  OSA: "asia",
  BKK: "asia",
  HKT: "asia",
  SIN: "asia",
  DPS: "asia",
  PEK: "asia",
  PKX: "asia",
  BJS: "asia",
  SYD: "oceania",
  MEL: "oceania",
  DXB: "middle_east",
  TLV: "middle_east",
  RAK: "africa",
  CMN: "africa",
  TUN: "africa",
  CAI: "africa",
  RMF: "africa",
  FUE: "atlantic",
  TFS: "atlantic",
  LPA: "atlantic",
  ACE: "atlantic",
  FNC: "atlantic",
  PDL: "atlantic",
  ATH: "med",
  HER: "med",
  RHO: "med",
  JTR: "med",
  JMK: "med",
  CFU: "med",
  SKG: "med",
  IST: "med",
  AYT: "med",
  DBV: "med",
  SPU: "med",
  MLA: "med",
  LCA: "med",
};

function countryToSurpriseRegion(country) {
  const c = String(country || "")
    .trim()
    .toLowerCase();
  if (!c) return "europe";
  if (/(united states|canada|mexico|\busa\b)/.test(c)) return "americas";
  if (/(australia|new zealand)/.test(c)) return "oceania";
  if (/(japan|thailand|singapore|indonesia|china|vietnam|malaysia|india|korea)/.test(c)) return "asia";
  if (/(emirates|israel|qatar|bahrain|oman|saudi|turkey|türkiye)/.test(c)) return "middle_east";
  if (/(morocco|tunisia|egypt|algeria|senegal|south africa|kenya)/.test(c)) return "africa";
  if (/(greece|cyprus|malta)/.test(c)) return "med";
  if (/(portugal|spain|canary)/.test(c)) return "atlantic";
  return "europe";
}

function surpriseWorldRegion(iata) {
  const code = sanitizeIata3(iata);
  if (SURPRISE_REGION_OVERRIDES[code]) return SURPRISE_REGION_OVERRIDES[code];
  try {
    const { getAirportByIata } = require("./airports");
    return countryToSurpriseRegion(getAirportByIata(code)?.country);
  } catch (_e) {
    return "europe";
  }
}

/** Pool mondiale mescolato; esclude solo l'aeroporto/città di partenza. */
function buildSurpriseDestinationPool(user) {
  const origin = resolveSurpriseOrigin(user);
  const filtered = filterDestinationsByTipo(user.destinazione_tipo).filter((d) => {
    const code = sanitizeIata3(d.iata);
    return code && code !== origin;
  });
  const base = filtered.length ? filtered : DESTINATIONS.slice();
  return shuffleDestinationPool(base);
}

/** Stima volo A/R per adulto da Italia (euristica se non c’è API). */
const SURPRISE_FLIGHT_HINT_EUR_ADULT = {
  NYC: 420,
  LAX: 480,
  MIA: 380,
  ORD: 400,
  BOS: 390,
  YTO: 350,
  CUN: 320,
  TYO: 520,
  OSA: 500,
  BKK: 380,
  HKT: 420,
  SIN: 480,
  DPS: 520,
  SYD: 620,
  MEL: 580,
  DXB: 260,
  CAI: 180,
  TLV: 200,
  RAK: 140,
  CMN: 160,
  TUN: 130,
  IST: 190,
  AYT: 160,
  REK: 280,
  JMK: 240,
  JTR: 210,
  RHO: 150,
  HER: 130,
  CFU: 125,
  SKG: 115,
  IBZ: 175,
  PMI: 140,
  NCE: 160,
  MRS: 130,
  MLA: 120,
  LCA: 115,
};

function surpriseFlightHintDestBase(destIata) {
  const c = sanitizeIata3(destIata);
  if (!c) return 140;
  if (SURPRISE_FLIGHT_HINT_EUR_ADULT[c]) return SURPRISE_FLIGHT_HINT_EUR_ADULT[c];
  const metroList = KIWI_METRO_TO_AIRPORTS[c];
  if (metroList && metroList.length) {
    const hints = metroList.map((ap) => SURPRISE_FLIGHT_HINT_EUR_ADULT[ap]).filter(Boolean);
    if (hints.length) return Math.min(...hints);
  }
  const longHaul = new Set([
    "NYC",
    "LAX",
    "MIA",
    "TYO",
    "OSA",
    "BKK",
    "SIN",
    "DPS",
    "SYD",
    "MEL",
    "YTO",
    "ORD",
    "BOS",
    "CUN",
    "SFO",
  ]);
  const mid = new Set(["DXB", "CAI", "TLV", "IST", "RAK", "CMN", "TUN", "AYT", "REK", "JFK", "EWR"]);
  const premiumEu = new Set(["JMK", "JTR", "IBZ", "PMI", "NCE", "MLA", "LCA", "VCE", "FLR"]);
  const gr = new Set(["ATH", "HER", "RHO", "JTR", "JMK", "CFU", "SKG"]);
  if (longHaul.has(c)) return 450;
  if (mid.has(c)) return 220;
  if (premiumEu.has(c)) return 165;
  if (gr.has(c)) return 135;
  return 110;
}

/** Stima volo A/R per adulto in base a partenza e destinazione. */
function surpriseFlightHintPerAdult(originIata, destIata) {
  const origin = sanitizeIata3(originIata);
  const dest = sanitizeIata3(destIata);
  let base = surpriseFlightHintDestBase(dest);
  if (!origin || !dest) return base;

  const oReg = surpriseWorldRegion(origin);
  const dReg = surpriseWorldRegion(dest);
  if (oReg === dReg) base = Math.round(base * 0.9);
  else if (oReg === "europe" && dReg === "med") base = Math.round(base * 1.04);
  else if (oReg === "europe" && dReg === "atlantic") base = Math.round(base * 1.08);

  if (["americas", "asia", "oceania"].includes(dReg)) {
    base = Math.round(base * (ITALIAN_LONG_HAUL_HUBS.has(origin) ? 1.03 : 1.16));
  } else if (dReg === "africa" || dReg === "middle_east") {
    base = Math.round(base * (ITALIAN_LONG_HAUL_HUBS.has(origin) ? 1.02 : 1.1));
  }

  const oCoords = amadeusCityCoords[origin];
  const dCoords = amadeusCityCoords[dest];
  if (oCoords && dCoords) {
    const distKm = haversineKm(oCoords.lat, oCoords.lng, dCoords.lat, dCoords.lng);
    const distHint = Math.round(48 + distKm * 0.055);
    base = Math.round((base + Math.min(distHint, 720)) / 2);
  }

  return Math.max(55, base);
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const r = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return r * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function surpriseBudgetLimits(user) {
  const budget = Math.max(100, Number(user.budget) || 500);
  const dates = resolveTravelDates(user);
  const nights = Math.max(
    1,
    Number(user.durata) ||
      stayNightsBetweenIsoDates(dates.departDate, dates.returnDate)
  );
  const minHotel = minHotelStayBudget(nights);
  const maxFlight = Math.max(50, budget - minHotel);
  return { budget, nights, minHotel, maxFlight };
}

/** Margine sotto il budget totale (volo + hotel al click Kiwi/Klook). */
function surpriseBudgetSlack(user) {
  const budget = Math.max(100, Number(user.budget) || 500);
  const adults = Math.max(1, hotelGuestCount(user));
  const pct = adults <= 1 ? 0.08 : 0.05;
  const floor = adults <= 1 ? 45 : 30;
  return Math.min(Math.round(budget * 0.14), Math.max(floor, Math.round(budget * pct)));
}

/** Stima prudente pacchetto sorpresa (volo + minimo hotel) per restare nel budget reale. */
function estimateSurprisePackageTotal(user, dest, flightPriceEuro) {
  const { budget, nights, minHotel } = surpriseBudgetLimits(user);
  const code = sanitizeIata3(dest.iata);
  const origin = resolveSurpriseOrigin(user);
  const adults = Math.max(1, hotelGuestCount(user));
  const flightRaw =
    flightPriceEuro != null && Number.isFinite(Number(flightPriceEuro))
      ? Number(flightPriceEuro)
      : surpriseFlightHintPerAdult(origin, code) * adults;
  const flightReserved =
    flightPriceEuro != null
      ? Math.ceil(flightRaw * 1.28) + 15
      : Math.ceil(flightRaw * 1.2) + 14;
  const minHotelDest = minHotelStayBudgetForDestination(nights, code, dest.label);
  const soloRoomFactor = adults <= 1 ? 1.1 : 1;
  const hotelReserved =
    Math.ceil(Math.max(minHotel, minHotelDest) * soloRoomFactor * 1.06) + 10;
  const slack = surpriseBudgetSlack(user);
  return {
    budget,
    nights,
    adults,
    flightReserved,
    hotelReserved,
    slack,
    maxTotal: Math.max(0, budget - slack),
    total: flightReserved + hotelReserved,
  };
}

function surprisePackageFitsBudget(user, dest, flightPriceEuro) {
  const est = estimateSurprisePackageTotal(user, dest, flightPriceEuro);
  return est.total <= est.maxTotal;
}

function destinationFitsSurpriseBudget(user, dest) {
  return surprisePackageFitsBudget(user, dest, null);
}

function pickWeightedSurpriseFromList(user, fits) {
  if (!fits.length) return null;
  const scored = fits.map((dest) => {
    const est = estimateSurprisePackageTotal(user, dest, null);
    return { dest, estTotal: est.total, maxTotal: est.maxTotal };
  });
  const maxTotal = Math.max(1, scored[0].maxTotal);
  const weights = scored.map((s) => {
    const u = s.estTotal / maxTotal;
    if (u < 0.52) return 1;
    if (u < 0.72) return 3;
    if (u <= 0.94) return 6;
    return 2;
  });
  let roll = crypto.randomInt(0, weights.reduce((a, b) => a + b, 0));
  for (let i = 0; i < scored.length; i += 1) {
    roll -= weights[i];
    if (roll < 0) return scored[i].dest;
  }
  return scored[scored.length - 1].dest;
}

/** Sceglie una meta in budget: prima un'area del mondo, poi varietà dentro l'area. */
function pickVariedSurpriseDestination(user, fits) {
  if (!fits.length) return null;
  const byRegion = new Map();
  for (const dest of fits) {
    const region = surpriseWorldRegion(dest.iata);
    if (!byRegion.has(region)) byRegion.set(region, []);
    byRegion.get(region).push(dest);
  }
  const regions = shuffleDestinationPool([...byRegion.keys()]);
  return pickWeightedSurpriseFromList(user, byRegion.get(regions[0]));
}

async function pickSurpriseDestination(user) {
  user = { ...user, aeroporto_partenza: user.aeroporto_partenza || resolveSurpriseOrigin(user) };
  const pool = buildSurpriseDestinationPool(user);
  if (!pool.length) {
    const err = new Error("Nessuna meta sorpresa disponibile per questo tipo di viaggio.");
    err.code = "DESTINATION_UNSUPPORTED";
    throw err;
  }

  const { maxFlight } = surpriseBudgetLimits(user);
  const heuristicFits = pool.filter((d) => destinationFitsSurpriseBudget(user, d));
  const shortlist = shuffleDestinationPool(heuristicFits);

  const token = (process.env.TRAVELPAYOUTS_API_TOKEN || "").trim();
  if (token && maxFlight >= 50 && shortlist.length) {
    const liveFits = [];
    const scanCap = Math.min(22, shortlist.length);
    for (let i = 0; i < scanCap; i += 1) {
      const dest = shortlist[i];
      const sub = {
        ...user,
        destinazione_preferita: dest.label,
        destinazione_iata: dest.iata,
        destinazione_sorpresa: 0,
      };
      try {
        const flights = await searchFlightsAzair(sub, { exactDates: true });
        if (!flights.length) continue;
        const total = flightPriceTotalForUser(flights[0], user);
        if (total <= maxFlight && surprisePackageFitsBudget(user, dest, total)) {
          const est = estimateSurprisePackageTotal(user, dest, total);
          liveFits.push({ dest, total, estTotal: est.total });
        }
      } catch (_e) {
        // prova la meta successiva
      }
    }
    if (liveFits.length) {
      const picked = pickVariedSurpriseDestination(
        user,
        liveFits.map((x) => x.dest)
      );
      return {
        code: sanitizeIata3(picked.iata),
        label: picked.label,
        pick_source: "live_price",
      };
    }
  }

  if (!heuristicFits.length) {
    const err = new Error(
      "Nessuna meta sorpresa compatibile con il budget indicato. Prova ad alzare il budget o accorciare il soggiorno."
    );
    err.code = "DESTINATION_UNSUPPORTED";
    throw err;
  }

  const picked = pickVariedSurpriseDestination(user, heuristicFits);
  return {
    code: sanitizeIata3(picked.iata),
    label: picked.label,
    pick_source: "budget_heuristic",
  };
}

function stayNightsFromFlight(flight, fallbackDurata) {
  const a = String(flight.departDate || "").slice(0, 10);
  const b = String(flight.returnDate || "").slice(0, 10);
  if (isIsoDate(a) && isIsoDate(b)) {
    const da = new Date(a);
    const db = new Date(b);
    const n = Math.ceil((db - da) / 86400000);
    return Math.max(1, Math.min(21, n || 1));
  }
  const d = Number(fallbackDurata);
  return Math.max(1, Math.min(21, Number.isFinite(d) ? d : 3));
}

/** Notti soggiorno: date utente / durata prima del volo API (evita 6 notti da returnDate errato). */
function stayNightsForOffer(flight, user) {
  const fromDurata = Number(user?.durata);
  if (Number.isFinite(fromDurata) && fromDurata >= 1) {
    return Math.max(1, Math.min(21, Math.round(fromDurata)));
  }
  const fromUserDates = stayNightsBetweenIsoDates(user?.date_from, user?.date_to);
  if (fromUserDates >= 1) return fromUserDates;
  return stayNightsFromFlight(flight, user?.durata);
}

function stayDatesForOffer(flight, user) {
  const uIn = isIsoDate(user?.date_from) ? String(user.date_from).slice(0, 10) : "";
  const uOut = isIsoDate(user?.date_to) ? String(user.date_to).slice(0, 10) : "";
  if (uIn && uOut) return { checkIn: uIn, checkOut: uOut };
  return {
    checkIn: String(flight?.departDate || "").slice(0, 10),
    checkOut: String(flight?.returnDate || "").slice(0, 10),
  };
}

/** Quota hotel mostrata in card (budget − volo quotato, senza moltiplicatore cache). */
function displayHotelStayQuota(budget, flightPrice) {
  const B = Math.max(0, Number(budget) || 0);
  const fp = Math.max(0, Math.floor(Number(flightPrice) || 0));
  return Math.max(0, Math.floor(B - fp));
}

/** Tetto volo (prezzo mostrato) così volo + minimo hotel non superano il budget. */
function maxQuotedFlightTotalForUser(user) {
  const B = Math.max(0, Number(user?.budget) || 0);
  if (B <= 0) return Infinity;
  const nights =
    stayNightsForOffer({}, user) ||
    Math.max(1, Number(user?.durata) || stayNightsBetweenIsoDates(user?.date_from, user?.date_to) || 3);
  const minH = minHotelStayBudget(nights);
  return Math.max(35, Math.floor(B - minH));
}

function flightOfferWithinQuotedBudget(flight, user) {
  const cap = maxQuotedFlightTotalForUser(user);
  const total = Number(flight?.price);
  return Number.isFinite(total) && total > 0 && total <= cap;
}

function mockWalkForKind(kind) {
  const pick = (lo, hi) => lo + crypto.randomInt(0, Math.max(1, hi - lo + 1));
  if (kind === "mare") return { sea: pick(5, 22), center: pick(8, 34) };
  if (kind === "montagna") return { sea: null, center: pick(4, 24) };
  return { sea: null, center: pick(7, 32) };
}

function hotelDisplayName(destShort, structureType, variantIdx) {
  const v = variantIdx % 3;
  if (structureType === "Appartamento") {
    const apt = [
      `Appartamento con cucina · ${destShort}`,
      `Residenza short stay · ${destShort}`,
      `Monolocale / bilocale · ${destShort}`,
    ];
    return apt[v];
  }
  const hot = [
    `Hotel 3★ zona centro · ${destShort}`,
    `Hotel design / boutique · ${destShort}`,
    `B&B o piccolo hotel · ${destShort}`,
  ];
  return hot[v];
}

function addDays(baseDate, days) {
  const d = new Date(baseDate);
  d.setDate(d.getDate() + days);
  return d;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function normalizeDestinationLabel(label) {
  return String(label || "")
    .replace(/[^\p{L}\s-]/gu, "")
    .trim()
    .toLowerCase();
}

let destinationCodeMapCache = null;
let destinationCodeMapFoldedCache = null;
function getDestinationCodeMap() {
  if (!destinationCodeMapCache) {
    const map = {};
    const folded = {};
    const { foldAscii } = require("./airports");
    for (const d of DESTINATIONS) {
      for (const raw of [d.label, ...(d.aliases || [])]) {
        const k = normalizeDestinationLabel(raw);
        if (k) map[k] = d.iata;
        const f = foldAscii(raw);
        if (f) folded[f] = d.iata;
      }
    }
    destinationCodeMapCache = map;
    destinationCodeMapFoldedCache = folded;
  }
  return destinationCodeMapCache;
}

function getDestinationCodeMapFolded() {
  getDestinationCodeMap();
  return destinationCodeMapFoldedCache || {};
}

function inferDestinationCode(destinationLabel) {
  const raw = String(destinationLabel || "").trim();
  if (!raw) return "";
  const normalized = normalizeDestinationLabel(raw);
  const codesByCity = getDestinationCodeMap();
  if (codesByCity[normalized]) return codesByCity[normalized];
  const { foldAscii, resolveAirportIata } = require("./airports");
  const folded = foldAscii(raw);
  const codesFolded = getDestinationCodeMapFolded();
  if (folded && codesFolded[folded]) return codesFolded[folded];
  const upper = raw.toUpperCase();
  if (/^[A-Z]{3}$/.test(upper)) return upper;
  const fromAirports = resolveAirportIata(raw);
  if (fromAirports) return fromAirports;
  return "";
}

/** Destinazione per ricerca live: testo utente prima dell'IATA, per evitare codici stale dal browser. */
function resolveLiveDestination(user) {
  const label = String(user.destinazione_preferita || "").trim();
  const fromPayload = sanitizeIata3(user.destinazione_iata);
  const { resolveAirportIata } = require("./airports");
  const labelLastPart =
    label
      .split(/[,\-–—|/]+/)
      .map((p) => p.trim())
      .filter(Boolean)
      .pop() || "";
  const code =
    resolveAirportIata(label) ||
    (labelLastPart && resolveAirportIata(labelLastPart)) ||
    inferDestinationCode(label) ||
    (labelLastPart && inferDestinationCode(labelLastPart)) ||
    fromPayload ||
    "";
  const display =
    label ||
    destinationLabelFromCode(code) ||
    (code ? code : "Destinazione");
  return { code, label: display };
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

/** Il pacchetto (volo+soggiorno) deve stare tra ~80% e 100% del budget indicato. */
const PACKAGE_MIN_RATIO = 0.8;
const PACKAGE_GOAL_RATIO = 0.95;
/** Margine generico (mock / altre fonti). */
const FLIGHT_BUDGET_BUFFER_RATIO = 1.1;
const FLIGHT_BUDGET_BUFFER_MIN_EUR = 15;
/** Cache Travelpayouts/Aviasales: al click il prezzo spesso è 2–3× (posti, bagagli, aggiornamento). */
const FLIGHT_CACHE_BUDGET_MULTIPLIER = 3;
const FLIGHT_CACHE_BUDGET_MIN_EUR = 35;
/** Minimo realistico per alloggio (ricerca Klook), per notte. */
const MIN_HOTEL_EUR_PER_NIGHT = 48;
/** Margine sul soggiorno Xotelo (OTA al click può salire leggermente). */
const HOTEL_BUDGET_BUFFER_RATIO = 1.08;
const HOTEL_BUDGET_BUFFER_MIN_EUR = 12;

function flightPriceReservedForBudget(flightPrice, priceSource) {
  const p = Number(flightPrice);
  if (!Number.isFinite(p) || p < 0) return 0;
  if (isTravelpayoutsFlightSource(priceSource)) {
    return Math.ceil(p * FLIGHT_CACHE_BUDGET_MULTIPLIER) + FLIGHT_CACHE_BUDGET_MIN_EUR;
  }
  return Math.ceil(p * FLIGHT_BUDGET_BUFFER_RATIO) + FLIGHT_BUDGET_BUFFER_MIN_EUR;
}

function isTravelpayoutsFlightSource(priceSource) {
  return ["travelpayouts", "travelpayouts_matrix", "travelpayouts_cheap"].includes(
    String(priceSource || "").trim()
  );
}

function flightPriceIsIndicative(priceSource) {
  return isTravelpayoutsFlightSource(priceSource);
}

function hotelPriceReservedForBudget(hotelTotalStay) {
  const ht = Number(hotelTotalStay);
  if (!Number.isFinite(ht) || ht <= 0) return 0;
  return Math.ceil(ht * HOTEL_BUDGET_BUFFER_RATIO) + HOTEL_BUDGET_BUFFER_MIN_EUR;
}

function packageQuotedTotal(flightPrice, hotelTotalStay) {
  const fp = Number(flightPrice);
  const ht = Math.round(Number(hotelTotalStay));
  if (!Number.isFinite(fp) || !Number.isFinite(ht)) return 0;
  return Math.round(fp + ht);
}

/** Totale massimo stimato se volo e hotel salgono del margine previsto. */
function packageWorstCaseTotal(flightPrice, hotelTotalStay, flightPriceSource) {
  return (
    flightPriceReservedForBudget(flightPrice, flightPriceSource) +
    hotelPriceReservedForBudget(hotelTotalStay)
  );
}

function packageBudgetHeadroom(flightPrice, hotelTotalStay, budget, flightPriceSource) {
  const B = Number(budget);
  if (!Number.isFinite(B) || B <= 0) return 0;
  return Math.max(0, Math.floor(B - packageWorstCaseTotal(flightPrice, hotelTotalStay, flightPriceSource)));
}

function describePackageBudgetCheck(flightPrice, hotelTotalStay, budget, flightPriceSource) {
  const quoted = packageQuotedTotal(flightPrice, hotelTotalStay);
  const worst = packageWorstCaseTotal(flightPrice, hotelTotalStay, flightPriceSource);
  const B = Number(budget);
  const headroom = packageBudgetHeadroom(flightPrice, hotelTotalStay, budget, flightPriceSource);
  return {
    package_total_quoted_euro: quoted,
    package_total_worst_case_euro: worst,
    budget_headroom_euro: headroom,
    price_variance_allowance_euro: Math.max(0, worst - quoted),
    within_budget: Number.isFinite(B) && B > 0 && worst <= B,
  };
}

function hotelStayQuota(budget, flightPrice, priceSource) {
  const B = Math.max(0, Number(budget) || 0);
  return Math.max(0, Math.floor(B - flightPriceReservedForBudget(flightPrice, priceSource)));
}

/** Quota hotel per pacchetti con prezzi quotati: residuo reale budget − volo (no margine 3× cache). */
function hotelStayQuotaQuoted(budget, flightPriceActual) {
  const B = Math.max(0, Number(budget) || 0);
  const fp = Number(flightPriceActual);
  if (!Number.isFinite(fp) || fp < 0) return 0;
  return Math.max(0, Math.floor(B - fp));
}

function minHotelStayBudget(nights) {
  const n = Math.max(1, Number(nights) || 1);
  return Math.max(55, Math.ceil(MIN_HOTEL_EUR_PER_NIGHT * n));
}

const DESTINATION_HOTEL_FLOOR_PER_NIGHT_EUR = {
  CVG: 225,
  LUK: 225,
  NYC: 220,
  JFK: 220,
  EWR: 220,
  LGA: 220,
  SFO: 210,
  LAX: 190,
  MIA: 180,
  BOS: 190,
  WAS: 185,
  IAD: 185,
  DCA: 185,
  ORD: 175,
  ROM: 170,
  FCO: 170,
  CIA: 170,
  MIL: 160,
  MXP: 160,
  LIN: 160,
  BGY: 160,
  VCE: 170,
  FLR: 165,
  JMK: 165,
  JTR: 145,
  RHO: 95,
  HER: 85,
  CFU: 85,
  SKG: 75,
  IBZ: 125,
  PMI: 95,
  NCE: 130,
  MLA: 110,
  LCA: 90,
  PEK: 110,
  PKX: 110,
  BKK: 70,
  DXB: 120,
};

const COUNTRY_HOTEL_FLOOR_PER_NIGHT_EUR = {
  "United States": 170,
  Canada: 155,
  Switzerland: 180,
  Denmark: 150,
  Norway: 155,
  Sweden: 140,
  Iceland: 180,
  "United Kingdom": 150,
  Ireland: 145,
  Netherlands: 145,
  France: 135,
  Germany: 120,
  Italy: 95,
  Spain: 90,
  Greece: 88,
  Portugal: 82,
  China: 95,
};

function minHotelStayBudgetForDestination(nights, destIata, destLabel) {
  const n = Math.max(1, Number(nights) || 1);
  const code = sanitizeIata3(destIata);
  if (code && DESTINATION_HOTEL_FLOOR_PER_NIGHT_EUR[code]) {
    return Math.ceil(DESTINATION_HOTEL_FLOOR_PER_NIGHT_EUR[code] * n);
  }
  try {
    const { getAirportByIata } = require("./airports");
    const airport = getAirportByIata(code);
    const countryFloor = COUNTRY_HOTEL_FLOOR_PER_NIGHT_EUR[String(airport?.country || "").trim()];
    if (countryFloor) return Math.ceil(countryFloor * n);
  } catch (_e) {
    // Keep the generic fallback if airport metadata is unavailable.
  }
  const label = String(destLabel || "").toLowerCase();
  if (/\bcincinnati\b/.test(label)) return Math.ceil(225 * n);
  if (/\bnew york\b/.test(label)) return Math.ceil(220 * n);
  return minHotelStayBudget(n);
}

/**
 * La quota hotel è il residuo del budget dopo il volo (stima prudente).
 * Non aggiungiamo un secondo margine OTA sulla quota.
 */
function packageTripFitsBudget(budget, flightPrice, nights, priceSource) {
  const B = Number(budget);
  const fp = Number(flightPrice);
  if (!Number.isFinite(B) || B <= 0 || !Number.isFinite(fp) || fp <= 0) {
    return { ok: false, reason: "invalid" };
  }
  const fpRes = flightPriceReservedForBudget(fp, priceSource);
  const minHotel = minHotelStayBudget(nights);
  const quota = hotelStayQuota(B, fp, priceSource);
  if (fpRes + minHotel > B) {
    return { ok: false, reason: "flight_too_high", fpRes, minHotel, quota, B };
  }
  if (quota < minHotel) {
    return { ok: false, reason: "hotel_quota_low", fpRes, minHotel, quota, B };
  }
  return { ok: true, fpRes, minHotel, quota, B, worstCaseEuro: fpRes + quota };
}

/**
 * Pacchetto ammesso solo se, anche con il margine su volo+hotel, il totale resta nel budget.
 */
function verifiedTripWithinBudget(flightPrice, hotelTotalStay, budget, flightPriceSource) {
  const B = Number(budget);
  const fp = Number(flightPrice);
  const ht = Math.round(Number(hotelTotalStay));
  if (!Number.isFinite(B) || B <= 0 || !Number.isFinite(fp) || !Number.isFinite(ht) || ht <= 0) return false;
  return packageWorstCaseTotal(fp, ht, flightPriceSource) <= B;
}

function isBookableFlightLink(url) {
  const u = String(url || "").trim();
  return /aviasales\./i.test(u) || /kiwi\.com/i.test(u) || /tp-em\.com/i.test(u) || /tpk\.lv/i.test(u);
}

function isBookableHotelLink(url) {
  const u = String(url || "").trim();
  return /klook\.com/i.test(u) || /tp\.media\/r\?/i.test(u) || /tpk\.lv/i.test(u);
}

/** Nome ufficiale Xotelo + eventuale arricchimento Google solo se match forte. */
function resolveXoteloHotelPresentation(entry, place) {
  const xoteloName = String(entry.names[0] || entry.names.find(Boolean) || "").trim() || "Hotel";
  if (!place?.name) {
    return { xoteloName, displayName: xoteloName, place: null, matchScore: 0 };
  }
  let matchScore = 0;
  for (const n of entry.names) {
    matchScore = Math.max(matchScore, scoreHotelNameMatch(n, place.name));
  }
  const displayName = matchScore >= 0.88 ? place.name : xoteloName;
  const photoPlace = matchScore >= 0.8 ? place : null;
  return { xoteloName, displayName, place: photoPlace, matchScore };
}

function packageHasBookableLinks(flight, hotel) {
  return isBookableFlightLink(flight?.flightLink) && isBookableHotelLink(hotel?.bookingLink);
}

function noFlightsFoundError(user, originCode, destinationLabel) {
  const from = String(originCode || user.aeroporto_partenza || "").trim() || "partenza";
  const dest = String(destinationLabel || user.destinazione_preferita || "").trim() || "destinazione";
  const err = new Error(
    `Nessun volo trovato per ${from} → ${dest} nelle date scelte (feed Aviasales, ricerche recenti). Prova date ±2–3 giorni, disattiva «solo diretti» se attivo, o un aeroporto vicino.`
  );
  err.code = "NO_FLIGHTS_FOUND";
  return err;
}

function budgetTooTightError(user, nights, cheapestFlightPrice, priceSource, minHotelOverride) {
  const B = Math.round(Number(user.budget) || 0);
  const fp = Math.round(Number(cheapestFlightPrice) || 0);
  const pax = hotelGuestCount(user);
  const minHotel = Math.max(
    minHotelStayBudget(nights),
    Math.round(Number(minHotelOverride) || 0)
  );
  const fpRes =
    priceSource === "estimate"
      ? flightPriceReservedForBudget(fp, priceSource)
      : fp;
  const hintBudget = Math.max(B + 60, fpRes + minHotel + 30);
  const perPerson = pax > 1 && fp > 0 ? Math.round(fp / pax) : fp;
  const err = new Error(
    `Con budget totale €${B} per ${pax} adulto/i non c'è combinazione: il volo costa circa €${fp}${pax > 1 ? ` in totale (~€${perPerson} a persona)` : ""} e per ${nights} notti serve almeno ~€${minHotel} di alloggio. Prova budget da circa €${hintBudget}, meno notti, date diverse o un'altra destinazione.`
  );
  err.code = "BUDGET_TOO_TIGHT";
  err.suggested_budget_min = hintBudget;
  return err;
}

function quotedPackageUnavailableError(user) {
  const dest = String(user.destinazione_preferita || "").trim() || "destinazione";
  const err = new Error(
    `Non abbiamo trovato un pacchetto con prezzi verificati (volo Aviasales + hotel) per ${dest} nelle date scelte. Prova altre date, aumenta il budget, o un'altra meta.`
  );
  err.code = "NO_QUOTED_PACKAGE";
  return err;
}

/**
 * Fascia di spesa per il soggiorno così che volo+soggiorno possa rispettare il budget pacchetto.
 * @returns {{ min: number, max: number } | null}
 */
function computeStayBudgetInterval(budget, flightPrice) {
  const B = Math.max(0, Number(budget) || 0);
  const fp = Number(flightPrice);
  if (!Number.isFinite(B) || B <= 0 || !Number.isFinite(fp) || fp < 0) return null;
  const floorTotal = Math.ceil(B * PACKAGE_MIN_RATIO);
  const stayMin = Math.max(45, Math.ceil(floorTotal - fp));
  const stayMax = Math.floor(B - fp);
  if (stayMin > stayMax) return null;
  return { min: stayMin, max: stayMax };
}

/** Testo destinazione senza emoji (per query hotel). */
function plainDestinationName(label) {
  let s = String(label || "");
  try {
    s = s.replace(/\p{Extended_Pictographic}/gu, "");
  } catch (_e) {
    s = s.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "");
  }
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Obiettivo: totale pacchetto vicino a goalRatio·B (es. 95% di 500 € → 475 €), rispettando la fascia soggiorno.
 */
function computeStayAllocation(budget, flightPrice) {
  const B = Number(budget);
  const fp = Number(flightPrice);
  const interval = computeStayBudgetInterval(B, fp);
  if (!interval) return null;
  const goalTotal = Math.min(B, Math.max(Math.ceil(B * PACKAGE_MIN_RATIO), Math.floor(B * PACKAGE_GOAL_RATIO)));
  let stayTarget = Math.round(goalTotal - fp);
  stayTarget = Math.min(interval.max, Math.max(interval.min, stayTarget));
  let prezzoTotale = fp + stayTarget;
  if (prezzoTotale < Math.ceil(B * PACKAGE_MIN_RATIO)) {
    stayTarget = interval.max;
    prezzoTotale = fp + stayTarget;
  }
  if (prezzoTotale > B) return null;
  if (prezzoTotale < Math.ceil(B * PACKAGE_MIN_RATIO)) return null;
  return { interval, stayTarget, prezzoTotale };
}

function addDaysIso(isoDate, days) {
  const d = new Date(isoDate);
  d.setDate(d.getDate() + days);
  return formatDate(d);
}

function resolveTravelDates(user) {
  const requestedFrom = String(user.date_from || "").trim();
  const requestedTo = String(user.date_to || "").trim();
  if (isIsoDate(requestedFrom) && isIsoDate(requestedTo)) {
    let departDate = requestedFrom;
    let returnDate = requestedTo;
    if (new Date(returnDate) < new Date(departDate)) {
      const swap = departDate;
      departDate = returnDate;
      returnDate = swap;
    }
    return { departDate, returnDate };
  }
  const startOffset = Math.floor(Math.random() * 90);
  const departDate = formatDate(addDays(new Date(), startOffset));
  const returnDate = addDaysIso(departDate, Number(user.durata || 3));
  return { departDate, returnDate };
}

function buildDateQueries(departDate, returnDate, options = {}) {
  if (options.exactOnly === true) {
    return [{ departure_at: departDate, return_at: returnDate }];
  }
  const shifts = [0, -1, 1, -2, 2, -3, 3];
  const seen = new Set();
  const queries = [];
  for (const shift of shifts) {
    const d0 = addDaysIso(departDate, shift);
    const d1 = addDaysIso(returnDate, shift);
    const k = `${d0}|${d1}`;
    if (seen.has(k)) continue;
    seen.add(k);
    queries.push({ departure_at: d0, return_at: d1 });
  }
  const dm = String(departDate || "").slice(0, 7);
  const rm = String(returnDate || "").slice(0, 7);
  if (/^\d{4}-\d{2}$/.test(dm) && /^\d{4}-\d{2}$/.test(rm)) {
    const mk = `m|${dm}|${rm}`;
    if (!seen.has(mk)) {
      seen.add(mk);
      queries.push({ departure_at: dm, return_at: rm });
    }
  }
  return queries;
}

function travelpayoutsRequestHeaders(token) {
  return {
    Accept: "application/json",
    "X-Access-Token": token,
  };
}

function mapTravelpayoutsV3RowToFlight(row, ctx) {
  const {
    originCode,
    destinationCode,
    destinationLabel,
    departDate,
    user,
    adults,
  } = ctx;
  const unitPrice = Number(row.price);
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) return null;
  const transfers = Number(row.transfers ?? row.number_of_changes ?? 0);
  return {
    from: String(row.origin || originCode || "").toUpperCase(),
    fromName: String(row.origin || originCode || "").toUpperCase(),
    destination: destinationLabelFromCode(row.destination || destinationCode) || destinationLabel,
    destinationCode: String(row.destination || destinationCode).toUpperCase(),
    departDate: String(row.departure_at || "").slice(0, 10) || departDate,
    returnDate:
      String(row.return_at || "").slice(0, 10) ||
      addDaysIso(String(row.departure_at || "").slice(0, 10) || departDate, Number(user.durata || 3)),
    timeBand: user.fascia_oraria === "Indifferente" ? "Mattina" : user.fascia_oraria,
    flightType: transfers === 0 ? "Diretto" : "Con scalo",
    airlineName: row.airline || "Compagnia partner",
    pricePerPerson: unitPrice,
    price: Math.round(unitPrice * adults),
    passengersAdults: adults,
    priceSource: ctx.priceSource || "travelpayouts",
    coverPhoto: FLIGHT_COVER_PHOTOS[Math.floor(Math.random() * FLIGHT_COVER_PHOTOS.length)],
    providerLinkPath: typeof row.link === "string" ? row.link : "",
  };
}

function mapTravelpayoutsV1CheapEntries(data, ctx) {
  const destKey = sanitizeIata3(ctx.tpDestination);
  const bucket =
    (destKey && data?.[destKey]) ||
    data?.[Object.keys(data || {}).find((k) => k && k.length === 3) || ""] ||
  null;
  if (!bucket || typeof bucket !== "object") return [];
  const out = [];
  for (const entry of Object.values(bucket)) {
    if (!entry || typeof entry !== "object") continue;
    const unitPrice = Number(entry.price);
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) continue;
    const transfers = Number(entry.number_of_changes ?? entry.transfers ?? 0);
    const row = {
      origin: ctx.originCode,
      destination: destKey,
      departure_at: entry.departure_at,
      return_at: entry.return_at,
      transfers,
      airline: entry.airline,
      link: "",
    };
    const f = mapTravelpayoutsV3RowToFlight(row, ctx);
    if (f) out.push(f);
  }
  return out;
}

async function fetchTravelpayoutsV3RouteFlights(ctx) {
  const { token, currency, market, directOnly, pass, originCode, tpDestination, queries } = ctx;
  const out = [];
  for (const q of queries) {
    const params = new URLSearchParams({
      origin: originCode,
      destination: tpDestination,
      departure_at: q.departure_at,
      unique: "false",
      sorting: "price",
      direct: directOnly ? "true" : "false",
      currency,
      limit: pass.oneWay ? "45" : "30",
      page: "1",
      one_way: pass.oneWay ? "true" : "false",
      token,
    });
    if (!pass.oneWay && q.return_at) params.set("return_at", q.return_at);
    if (market) params.set("market", market);

    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(
        `https://api.travelpayouts.com/aviasales/v3/prices_for_dates?${params.toString()}`,
        { signal: controller.signal, headers: travelpayoutsRequestHeaders(token) }
      );
      console.log("[tp-DEBUG] fetch status:", response.status, response.url);
      if (!response.ok) continue;
      const payload = await response.json();
      console.log("[tp-flights] risposta API:", JSON.stringify(payload).slice(0, 500));
      if (!(payload?.success && Array.isArray(payload.data))) continue;
      for (const row of payload.data) {
        const f = mapTravelpayoutsV3RowToFlight(row, ctx);
        if (!f) continue;
        if (directOnly && f.flightType !== "Diretto") continue;
        out.push(f);
      }
    } catch (_e) {
      /* prova query successiva */
    } finally {
      clearTimeout(tid);
    }
  }
  return out;
}

async function fetchTravelpayoutsV1CheapFlights(ctx) {
  const { token, currency, originCode, tpDestination, departDate, returnDate, directOnly, exactDates } = ctx;
  const dateAttempts = exactDates
    ? [{ depart: departDate, ret: returnDate }]
    : [
        { depart: departDate, ret: returnDate },
        { depart: departDate.slice(0, 7), ret: returnDate.slice(0, 7) },
      ];
  const out = [];
  for (const da of dateAttempts) {
    if (!da.depart || !da.ret) continue;
    const params = new URLSearchParams({
      origin: originCode,
      destination: tpDestination,
      depart_date: da.depart,
      return_date: da.ret,
      currency,
      token,
    });
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(
        `https://api.travelpayouts.com/v1/prices/cheap?${params.toString()}`,
        { signal: controller.signal, headers: travelpayoutsRequestHeaders(token) }
      );
      console.log("[tp-DEBUG] fetch status:", response.status, response.url);
      if (!response.ok) continue;
      const payload = await response.json();
      console.log("[tp-flights] risposta API:", JSON.stringify(payload).slice(0, 500));
      if (!payload?.success || !payload.data) continue;
      for (const f of mapTravelpayoutsV1CheapEntries(payload.data, ctx)) {
        if (directOnly && f.flightType !== "Diretto") continue;
        out.push(f);
      }
    } catch (_e) {
      /* prova formato data successivo */
    } finally {
      clearTimeout(tid);
    }
  }
  return out;
}

function flattenTravelpayoutsRows(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  const rows = [];
  for (const value of Object.values(data)) {
    if (Array.isArray(value)) rows.push(...value);
    else if (value && typeof value === "object") rows.push(...Object.values(value));
  }
  return rows.filter((row) => row && typeof row === "object");
}

async function fetchTravelpayoutsV2MonthMatrixFlights(ctx) {
  const { token, currency, originCode, tpDestination, departDate, returnDate, directOnly } = ctx;
  const params = new URLSearchParams({
    origin: originCode,
    destination: tpDestination,
    currency,
    show_to_affiliates: "true",
    token,
  });
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(
      `https://api.travelpayouts.com/v2/prices/month-matrix?${params.toString()}`,
      { signal: controller.signal, headers: travelpayoutsRequestHeaders(token) }
    );
    console.log("[tp-DEBUG] fetch status:", response.status, response.url);
    if (!response.ok) return [];
    const payload = await response.json();
    console.log("[tp-flights] risposta API:", JSON.stringify(payload).slice(0, 500));
    const rows = flattenTravelpayoutsRows(payload?.data);
    const targetMs = new Date(departDate).getTime();
    const mapped = rows
      .map((row) => {
        const dep =
          String(row.depart_date || row.departure_at || row.departure_date || row.date || "").slice(0, 10) ||
          departDate;
        const price = Number(row.value ?? row.price);
        if (!Number.isFinite(price) || price <= 0 || !isIsoDate(dep)) return null;
        const ret =
          String(row.return_date || row.return_at || "").slice(0, 10) ||
          (isIsoDate(returnDate) ? returnDate : addDaysIso(dep, Number(ctx.user?.durata || 3)));
        const transfers = Number(row.number_of_changes ?? row.transfers ?? 0);
        if (directOnly && transfers !== 0) return null;
        return {
          row: {
            origin: row.origin || originCode,
            destination: row.destination || tpDestination,
            departure_at: dep,
            return_at: ret,
            transfers,
            airline: row.airline,
            price,
            link: "",
          },
          distance: Math.abs(new Date(dep).getTime() - targetMs),
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.distance - b.distance || Number(a.row.price) - Number(b.row.price));
    const best = mapped[0];
    if (!best) return [];
    const f = mapTravelpayoutsV3RowToFlight(best.row, { ...ctx, priceSource: "travelpayouts_matrix" });
    return f ? [f] : [];
  } catch (_e) {
    return [];
  } finally {
    clearTimeout(tid);
  }
}

async function fetchTravelpayoutsV1CheapFlightsNoDates(ctx) {
  const { token, currency, originCode, tpDestination, directOnly } = ctx;
  const params = new URLSearchParams({
    origin: originCode,
    destination: tpDestination,
    currency,
    token,
  });
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(
      `https://api.travelpayouts.com/v1/prices/cheap?${params.toString()}`,
      { signal: controller.signal, headers: travelpayoutsRequestHeaders(token) }
    );
    console.log("[tp-DEBUG] fetch status:", response.status, response.url);
    if (!response.ok) return [];
    const payload = await response.json();
    console.log("[tp-flights] risposta API:", JSON.stringify(payload).slice(0, 500));
    if (!payload?.success || !payload.data) return [];
    return mapTravelpayoutsV1CheapEntries(payload.data, { ...ctx, priceSource: "travelpayouts_cheap" }).filter(
      (f) => !directOnly || f.flightType === "Diretto"
    );
  } catch (_e) {
    return [];
  } finally {
    clearTimeout(tid);
  }
}

function mergeTravelpayoutsFlightResults(bestFlights, maxFlightReserved, options = {}) {
  if (!bestFlights.length) return [];
  const seen = new Set();
  const merged = [];
  for (const f of bestFlights.sort((a, b) => a.price - b.price)) {
    const k = `${f.from}|${f.destinationCode}|${f.departDate}|${f.returnDate}|${f.price}`;
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(f);
  }
  const maxQuoted = Number(options.maxQuotedFlight);
  const quotedCap =
    Number.isFinite(maxQuoted) && maxQuoted > 0 ? maxQuoted : maxFlightReserved;
  const inQuoted = merged.filter((f) => Number(f.price) > 0 && Number(f.price) <= quotedCap);
  const inBudget = merged.filter(
    (f) => flightPriceReservedForBudget(f.price, f.priceSource) <= maxFlightReserved
  );
  if (options.preferQuotedOnly) {
    return inQuoted.slice(0, 8);
  }
  return (inQuoted.length ? inQuoted : inBudget.length ? inBudget : merged).slice(0, 8);
}

function destinationLabelFromCode(code) {
  const upper = String(code || "").toUpperCase();
  if (upper === "SHJ" || upper === "DWC") return "Dubai";
  const hit = DESTINATIONS.find((d) => d.iata === upper);
  return hit ? hit.label : String(code || "");
}

function getSoloVoliDiretti(user) {
  return Number(user.solo_voli_diretti) === 1 || String(user.solo_voli_diretti || "").trim() === "1";
}

/**
 * Google Maps Platform: chiave solo da `process.env.GOOGLE_MAPS_KEY` (mai nel sorgente).
 */
function getGoogleMapsKey() {
  return String(process.env.GOOGLE_MAPS_KEY || "").trim();
}

async function getWalkingMinutes(origin, destination) {
  const key = getGoogleMapsKey();
  if (!key) return Math.floor(Math.random() * 12) + 3;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000);
  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(
    origin
  )}&destinations=${encodeURIComponent(destination)}&mode=walking&key=${encodeURIComponent(key)}`;
  try {
    const response = await fetch(url, { signal: controller.signal });
    const data = await response.json();
    const seconds = data?.rows?.[0]?.elements?.[0]?.duration?.value;
    if (!seconds) return Math.floor(Math.random() * 12) + 3;
    return Math.round(seconds / 60);
  } catch (_error) {
    return Math.floor(Math.random() * 12) + 3;
  } finally {
    clearTimeout(timeoutId);
  }
}

const XOTELO_API_BASE = "https://data.xotelo.com/api";
const XOTELO_RATES_TIMEOUT_MS = 5500;
const XOTELO_LIST_TIMEOUT_MS = 6500;
/** Max richieste /rates in parallelo (evita burst e timeout serverless). */
const XOTELO_RATES_PARALLEL = 6;
/** Quante strutture Xotelo quotare per slot (prima le più economiche dalla list). */
const XOTELO_MAX_KEYS_TO_RATE = 24;

const xoteloRatesSessionCache = new Map();

function xoteloRatesCacheKey(hotelKey, chkIn, chkOut, guests, currency) {
  return `${hotelKey}|${chkIn}|${chkOut}|${guests}|${currency}`;
}

async function fetchXoteloRatesCached(hotelKey, chkIn, chkOut, guests, currency) {
  const ck = xoteloRatesCacheKey(hotelKey, chkIn, chkOut, guests, currency);
  if (xoteloRatesSessionCache.has(ck)) return xoteloRatesSessionCache.get(ck);
  const result = await fetchXoteloRates(hotelKey, chkIn, chkOut, guests, currency);
  xoteloRatesSessionCache.set(ck, result);
  return result;
}

function clearXoteloRatesSessionCache() {
  xoteloRatesSessionCache.clear();
}

const AMADEUS_API_BASE_DEFAULT = "https://test.api.amadeus.com";
const AMADEUS_HTTP_TIMEOUT_MS = 12000;
const AMADEUS_HOTEL_LIST_RADIUS_KM = 5;
const AMADEUS_HOTEL_IDS_CAP = 60;
const AMADEUS_OFFERS_CHUNK_SIZE = 20;

let amadeusTokenCache = { token: "", expiresAt: 0 };

function getAmadeusApiBase() {
  const raw = (process.env.AMADEUS_API_BASE || AMADEUS_API_BASE_DEFAULT).trim();
  return raw.replace(/\/$/, "") || AMADEUS_API_BASE_DEFAULT;
}

function isAmadeusConfigured() {
  const id = (process.env.AMADEUS_CLIENT_ID || "").trim();
  const secret = (process.env.AMADEUS_CLIENT_SECRET || "").trim();
  return Boolean(id && secret);
}

function amadeusHotelsError(message, code = "AMADEUS_NO_HOTELS") {
  const err = new Error(message);
  err.code = code;
  return err;
}

async function getAmadeusToken() {
  if (!isAmadeusConfigured()) return null;
  const now = Date.now();
  if (amadeusTokenCache.token && now < amadeusTokenCache.expiresAt - 60_000) {
    return amadeusTokenCache.token;
  }
  const base = getAmadeusApiBase();
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: (process.env.AMADEUS_CLIENT_ID || "").trim(),
    client_secret: (process.env.AMADEUS_CLIENT_SECRET || "").trim(),
  });
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), AMADEUS_HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/v1/security/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: controller.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) {
      throw amadeusHotelsError(
        "Amadeus: autenticazione fallita. Controlla AMADEUS_CLIENT_ID e AMADEUS_CLIENT_SECRET.",
        "AMADEUS_AUTH_FAILED"
      );
    }
    const ttlSec = Number(json.expires_in) > 0 ? Number(json.expires_in) : 1800;
    amadeusTokenCache = {
      token: String(json.access_token),
      expiresAt: now + ttlSec * 1000,
    };
    return amadeusTokenCache.token;
  } catch (e) {
    if (e?.code?.startsWith?.("AMADEUS_")) throw e;
    throw amadeusHotelsError(
      "Amadeus non raggiungibile al momento. Riprova tra qualche minuto.",
      "AMADEUS_UNAVAILABLE"
    );
  } finally {
    clearTimeout(tid);
  }
}

async function amadeusApiGet(pathWithQuery, token) {
  const base = getAmadeusApiBase();
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), AMADEUS_HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}${pathWithQuery}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = json?.errors?.[0]?.detail || json?.error_description || res.statusText;
      throw amadeusHotelsError(
        `Amadeus: ${detail || "errore ricerca hotel"}.`,
        res.status === 404 ? "AMADEUS_NO_HOTELS" : "AMADEUS_UNAVAILABLE"
      );
    }
    return json;
  } catch (e) {
    if (e?.code?.startsWith?.("AMADEUS_")) throw e;
    throw amadeusHotelsError(
      "Amadeus non raggiungibile al momento. Riprova tra qualche minuto.",
      "AMADEUS_UNAVAILABLE"
    );
  } finally {
    clearTimeout(tid);
  }
}

async function resolveCityCoordinatesForAmadeus(cityLabel, iataRaw) {
  const iata = sanitizeIata3(iataRaw);
  const metro = iata && KIWI_AIRPORT_TO_METRO[iata] ? sanitizeIata3(KIWI_AIRPORT_TO_METRO[iata]) : "";
  for (const key of [iata, metro]) {
    if (!key) continue;
    const row = amadeusCityCoords[key];
    if (row && Number.isFinite(Number(row.lat)) && Number.isFinite(Number(row.lng))) {
      return { lat: Number(row.lat), lng: Number(row.lng), label: row.city || cityLabel };
    }
  }
  const city = plainDestinationName(cityLabel) || englishCityForOta(cityLabel, iata);
  if (!city) return null;
  const key = getGoogleMapsKey();
  if (!key) return null;
  const q = encodeURIComponent(city);
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${q}&key=${encodeURIComponent(key)}`;
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 7000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const data = await res.json();
    const loc = data?.results?.[0]?.geometry?.location;
    if (loc && Number.isFinite(Number(loc.lat)) && Number.isFinite(Number(loc.lng))) {
      return { lat: Number(loc.lat), lng: Number(loc.lng), label: city };
    }
    return null;
  } catch (_e) {
    return null;
  } finally {
    clearTimeout(tid);
  }
}

async function fetchAmadeusHotelIdsByGeocode(lat, lng, token) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lng),
    radius: String(AMADEUS_HOTEL_LIST_RADIUS_KM),
    radiusUnit: "KM",
    hotelSource: "ALL",
  });
  const json = await amadeusApiGet(
    `/v1/reference-data/locations/hotels/by-geocode?${params.toString()}`,
    token
  );
  const ids = [];
  for (const row of Array.isArray(json?.data) ? json.data : []) {
    const id = String(row?.hotelId || "").trim();
    if (id) ids.push(id);
  }
  return [...new Set(ids)].slice(0, AMADEUS_HOTEL_IDS_CAP);
}

function parseAmadeusHotelOffers(json, nights) {
  const n = Math.max(1, nights);
  const rows = [];
  for (const item of Array.isArray(json?.data) ? json.data : []) {
    const hotel = item?.hotel || {};
    const hotelId = String(hotel.hotelId || "").trim();
    const name = String(hotel.name || "").trim();
    if (!hotelId || !name) continue;
    const offers = Array.isArray(item?.offers) ? item.offers : [];
    if (!offers.length) continue;
    const offer = offers[0];
    const total = Number(offer?.price?.total);
    if (!Number.isFinite(total) || total <= 0) continue;
    const totalStay = Math.ceil(total);
    const nightly = Math.ceil(totalStay / n);
    let ratingTenth = "";
    const ratingRaw = hotel.rating;
    if (ratingRaw != null && String(ratingRaw).trim() !== "") {
      const r = Number(ratingRaw);
      if (Number.isFinite(r)) ratingTenth = r <= 5 ? (r * 2).toFixed(1) : r.toFixed(1);
    }
    rows.push({
      hotelId,
      name,
      totalStay,
      nightly,
      nights: n,
      rating: ratingTenth,
      amadeusOfferId: String(offer?.id || ""),
    });
  }
  return rows;
}

async function fetchAmadeusHotelOffers(hotelIds, checkIn, checkOut, adults, currency, token) {
  const merged = { data: [] };
  for (let i = 0; i < hotelIds.length; i += AMADEUS_OFFERS_CHUNK_SIZE) {
    const chunk = hotelIds.slice(i, i + AMADEUS_OFFERS_CHUNK_SIZE);
    const params = new URLSearchParams({
      hotelIds: chunk.join(","),
      checkInDate: checkIn,
      checkOutDate: checkOut,
      adults: String(Math.max(1, Math.min(9, adults))),
      roomQuantity: "1",
      currency: String(currency || "EUR").toUpperCase().slice(0, 3),
      bestRateOnly: "true",
    });
    const json = await amadeusApiGet(`/v3/shopping/hotel-offers?${params.toString()}`, token);
    if (Array.isArray(json?.data)) merged.data.push(...json.data);
  }
  return merged;
}

/**
 * Cerca hotel con prezzi Amadeus nella città (geocode + offerte).
 * @returns {Promise<Array<{hotelId,name,nightly,totalStay,nights,rating}>>}
 */
async function searchHotelsAmadeus(cityLabel, checkIn, checkOut, adults, maxBudget, iataHint) {
  if (!isIsoDate(checkIn) || !isIsoDate(checkOut)) {
    throw amadeusHotelsError("Date soggiorno non valide per la ricerca Amadeus.", "AMADEUS_INVALID_DATES");
  }
  const token = await getAmadeusToken();
  if (!token) {
    throw amadeusHotelsError(
      "Ricerca hotel non disponibile: configura AMADEUS_CLIENT_ID e AMADEUS_CLIENT_SECRET.",
      "AMADEUS_NOT_CONFIGURED"
    );
  }
  const coords = await resolveCityCoordinatesForAmadeus(cityLabel, iataHint);
  if (!coords) {
    throw amadeusHotelsError(
      `Non troviamo le coordinate per «${plainDestinationName(cityLabel) || cityLabel}». Prova un'altra destinazione.`,
      "AMADEUS_CITY_UNKNOWN"
    );
  }
  const hotelIds = await fetchAmadeusHotelIdsByGeocode(coords.lat, coords.lng, token);
  if (!hotelIds.length) {
    throw amadeusHotelsError(
      `Amadeus non ha hotel disponibili vicino a ${coords.label} per queste date.`,
      "AMADEUS_NO_HOTELS"
    );
  }
  const currency = (process.env.TRAVELPAYOUTS_CURRENCY || "EUR").trim().toUpperCase().slice(0, 3) || "EUR";
  const offersJson = await fetchAmadeusHotelOffers(
    hotelIds,
    checkIn,
    checkOut,
    adults,
    currency,
    token
  );
  const nights = Math.max(
    1,
    Math.round((new Date(checkOut).getTime() - new Date(checkIn).getTime()) / (24 * 60 * 60 * 1000))
  );
  let rows = parseAmadeusHotelOffers(offersJson, nights);
  if (!rows.length) {
    throw amadeusHotelsError(
      `Amadeus non ha tariffe hotel per ${coords.label} dal ${checkIn} al ${checkOut}. Prova altre date.`,
      "AMADEUS_NO_HOTELS"
    );
  }
  if (Number.isFinite(Number(maxBudget)) && Number(maxBudget) > 0) {
    rows = rows.filter((r) => r.totalStay <= Number(maxBudget));
  }
  rows.sort((a, b) => a.totalStay - b.totalStay);
  return rows;
}

/** Tre card hotel Amadeus (prezzi reali) + link Klook per monetizzazione. */
async function searchHotelsAmadeusForSlots(user, slots, destShort, destIata) {
  if (!isAmadeusConfigured()) {
    throw amadeusHotelsError(
      "Ricerca hotel non disponibile: configura AMADEUS_CLIENT_ID e AMADEUS_CLIENT_SECRET su Vercel.",
      "AMADEUS_NOT_CONFIGURED"
    );
  }
  const budget = Math.max(0, Number(user.budget) || 0);
  const guests = hotelGuestCount(user);
  const city =
    plainDestinationName(destShort) ||
    englishCityForOta(destShort, destIata) ||
    destinationLabelFromCode(destIata) ||
    destShort;
  const offersCache = new Map();
  const usedIds = new Set();
  const out = [];
  const kindDefault = destinationKind(destIata);

  for (let slotIdx = 0; slotIdx < 3; slotIdx += 1) {
    const { flight } = slots[slotIdx];
    const chkIn = String(flight.departDate || "").slice(0, 10);
    const chkOut = String(flight.returnDate || "").slice(0, 10);
    if (!isIsoDate(chkIn) || !isIsoDate(chkOut)) return null;
    const nights = stayNightsFromFlight(flight, user.durata);
    const fp = Number(flight.price);
    const maxBudget = hotelStayQuota(budget, fp, flight.priceSource);
    if (!Number.isFinite(fp) || maxBudget < 35) return null;

    const cacheKey = `${city}|${chkIn}|${chkOut}|${guests}`;
    if (!offersCache.has(cacheKey)) {
      const allRows = await searchHotelsAmadeus(city, chkIn, chkOut, guests, null, destIata);
      offersCache.set(cacheKey, allRows);
    }
    const pool = offersCache.get(cacheKey) || [];
    const affordable = pool.filter((r) => r.totalStay <= maxBudget && !usedIds.has(r.hotelId));
    if (!affordable.length) {
      throw amadeusHotelsError(
        `Nessun hotel Amadeus entro €${Math.round(maxBudget)} di budget alloggio (dopo il volo €${Math.round(fp)}). Prova ad alzare il budget o cambiare date.`,
        "AMADEUS_NO_HOTELS_IN_BUDGET"
      );
    }
    affordable.sort((a, b) => a.totalStay - b.totalStay);
    const pick = affordable[0];
    usedIds.add(pick.hotelId);

    const kind = destinationKind(flight.destinationCode) || kindDefault;
    const w = mockWalkForKind(kind);
    const bestPriceLine = `Prezzo live Amadeus · €${Math.round(pick.nightly)}/notte · €${Math.round(
      pick.totalStay
    )} totale · ${nights} notti`;

    out.push({
      slug: `amadeus-${pick.hotelId}`,
      countryCode: "eu",
      roomType: user.tipo_camera || "Doppia",
      mealType: user.tipo_pasto || "Solo pernotto",
      structureType: "Hotel",
      name: pick.name,
      googlePlaceMatched: true,
      googleDisplayName: pick.name,
      rating: pick.rating || "",
      walkToSeaMin: w.sea,
      walkToCenterMin: w.center,
      price: Math.round(pick.totalStay),
      stayNights: nights,
      pricePerNightEstimate: Math.round(pick.nightly),
      pricePerNightXotelo: Math.round(pick.nightly),
      stayTotalEstimate: Math.round(pick.totalStay),
      stayIsEstimate: false,
      priceSource: "amadeus",
      priceVerified: true,
      priceFetchedAt: Date.now(),
      bestPriceProviderName: "Amadeus",
      bestPriceLabel: bestPriceLine,
      bookingProviderCode: "",
      amadeusHotelId: pick.hotelId,
      photos: [],
      bookingLink: buildKlookHotelLink(
        { name: pick.name, googleDisplayName: pick.name, googlePlaceMatched: true },
        flight,
        user.persone,
        city
      ),
      googlePlaceId: "",
      formattedAddress: city,
    });
  }

  return out.length === 3 ? out : null;
}

function hotelNameForKlookSearch(hotel) {
  const g = String(hotel?.googleDisplayName || "").trim();
  const matched = !!hotel?.googlePlaceMatched;
  const x = String(hotel?.xoteloDisplayName || "").trim();
  const n = String(hotel?.name || "").trim();
  if (matched && g) return g;
  if (g) return g;
  return n || x || "Hotel";
}

function cityLabelForKlookSearch(flight, cityHint) {
  let city =
    String(cityHint || "").trim() ||
    plainDestinationName(flight?.destination) ||
    plainDestinationName(destinationLabelFromCode(flight?.destinationCode)) ||
    "";
  try {
    city = city.replace(/\p{Extended_Pictographic}/gu, "");
  } catch (_e) {
    city = city.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "");
  }
  return city.replace(/\s+/g, " ").trim();
}

/** Deeplink hotel Klook via Travelpayouts (città + date volo). */
function buildKlookHotelLink(hotel, flight, people, cityHint) {
  const rawIn = String(flight?.departDate || "").slice(0, 10);
  const rawOut = String(flight?.returnDate || "").slice(0, 10);
  const city = cityLabelForKlookSearch(flight, cityHint);
  return buildKlookAffiliateHotelUrl({
    city,
    destIata: flight?.destinationCode,
    checkIn: isIsoDate(rawIn) ? rawIn : "",
    checkOut: isIsoDate(rawOut) ? rawOut : "",
    adults: hotelGuestCount({ persone: people }),
    currency: "EUR",
  });
}

async function fetchJsonWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return await res.json().catch(() => null);
  } catch (_e) {
    return null;
  } finally {
    clearTimeout(tid);
  }
}

function resolveXoteloLocationKeyFromIata(iataRaw) {
  const direct = sanitizeIata3(iataRaw);
  if (!direct) return "";
  if (xoteloLocationKeys[direct]) return xoteloLocationKeys[direct];
  const metro = KIWI_AIRPORT_TO_METRO[direct];
  if (metro && xoteloLocationKeys[metro]) return xoteloLocationKeys[metro];
  return "";
}

/** Nome città in inglese per query OTA / parametro `location` su Xotelo (best-effort). */
function englishCityForOta(destShort, iata3) {
  const i = sanitizeIata3(iata3);
  const table = {
    ATH: "Athens",
    BCN: "Barcelona",
    MAD: "Madrid",
    ROM: "Rome",
    FCO: "Rome",
    CIA: "Rome",
    MIL: "Milan",
    MXP: "Milan",
    LIN: "Milan",
    BGY: "Milan",
    PAR: "Paris",
    CDG: "Paris",
    ORY: "Paris",
    BVA: "Paris",
    LON: "London",
    LHR: "London",
    LGW: "London",
    STN: "London",
    LTN: "London",
    LCY: "London",
    SEN: "London",
    AMS: "Amsterdam",
    BER: "Berlin",
    MUC: "Munich",
    VIE: "Vienna",
    PRG: "Prague",
    BUD: "Budapest",
    LIS: "Lisbon",
    NAP: "Naples",
    VCE: "Venice",
    FLR: "Florence",
    BKK: "Bangkok",
    DXB: "Dubai",
    NYC: "New York",
    JFK: "New York",
    EWR: "New York",
    LGA: "New York",
    DUB: "Dublin",
    EDI: "Edinburgh",
  };
  if (i && table[i]) return table[i];
  return plainDestinationName(destShort) || "";
}

function foldAsciiLower(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Alias Xotelo troppo generici (es. «Hotel Barcelona») — non abbinare a Google Places. */
function isAmbiguousXoteloAlias(name) {
  const t = foldAsciiLower(name);
  if (!t) return true;
  const parts = t.split(" ").filter((w) => w.length > 0);
  if (parts.length === 1 && /^(barcelona|rome|milan|madrid|paris|london|athens|lisbon)$/i.test(parts[0])) return true;
  if (parts.length === 2 && parts[0] === "hotel" && parts[1].length >= 4) return true;
  if (parts.length === 2 && parts[1] === "hotel") return true;
  return false;
}

function entryHasOnlyAmbiguousXoteloNames(entry) {
  const names = (entry?.names || []).filter(Boolean);
  if (!names.length) return true;
  return names.every((n) => isAmbiguousXoteloAlias(n));
}

function scoreHotelNameMatch(googleName, candidateName) {
  const a = foldAsciiLower(googleName);
  const b = foldAsciiLower(candidateName);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const short = a.length <= b.length ? a : b;
  const long = a.length > b.length ? a : b;
  if (short.length >= 14 && long.includes(short)) {
    const re = new RegExp(`\\b${short.replace(/\s+/g, "\\s+")}\\b`);
    if (re.test(long)) return 0.9;
  }
  const ta = new Set(a.split(" ").filter((t) => t.length > 2));
  const tb = new Set(b.split(" ").filter((t) => t.length > 2));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / Math.max(ta.size, tb.size);
}

function pickOfficialXoteloName(entry) {
  const official = String(entry?.official_name || "").trim();
  if (official) return official;
  const names = (entry?.names || []).map((n) => String(n || "").trim()).filter(Boolean);
  const specific = names.filter((n) => !isAmbiguousXoteloAlias(n));
  if (specific.length) return [...specific].sort((a, b) => b.length - a.length)[0];
  return names[0] || "Hotel";
}

function buildXoteloAliasEntriesFromList(listRows) {
  if (!Array.isArray(listRows)) return [];
  const byKey = new Map();
  for (const row of listRows) {
    const hotelKey = row.key || row.hotel_key;
    if (!hotelKey || !row.name) continue;
    const name = String(row.name).trim();
    const cur = byKey.get(hotelKey) || {
      hotel_key: String(hotelKey),
      names: [],
      tripAdvisorUrl: "",
      official_name: "",
      listImage: "",
    };
    cur.names.push(name);
    cur.official_name = name;
    if (row.image) cur.listImage = String(row.image).trim();
    if (row.review_summary?.rating != null) {
      cur.listReviewRating = Number(row.review_summary.rating);
    }
    if (row.url && /tripadvisor\./i.test(String(row.url))) {
      cur.tripAdvisorUrl = String(row.url).trim();
    }
    byKey.set(hotelKey, cur);
  }
  return [...byKey.values()];
}

function collectXoteloSeedsForIata(iata3) {
  const c = sanitizeIata3(iata3);
  const out = [];
  if (Array.isArray(xoteloHotelSeeds[c])) out.push(...xoteloHotelSeeds[c]);
  const metro = KIWI_AIRPORT_TO_METRO[c];
  if (metro && metro !== c && Array.isArray(xoteloHotelSeeds[metro])) out.push(...xoteloHotelSeeds[metro]);
  return out;
}

function buildXoteloAliasEntriesFromSeeds(iata3) {
  const seeds = collectXoteloSeedsForIata(iata3);
  if (!seeds.length) return [];
  const byKey = new Map();
  for (const row of seeds) {
    if (!row?.hotel_key) continue;
    const cur = byKey.get(row.hotel_key) || {
      hotel_key: row.hotel_key,
      names: [],
      tripAdvisorUrl: "",
      official_name: "",
      listImage: "",
    };
    const official = String(row.official_name || "").trim();
    if (official) {
      cur.official_name = official;
      cur.names.push(official);
    }
    for (const m of row.match || []) {
      const t = String(m || "").trim();
      if (t) cur.names.push(t);
    }
    byKey.set(row.hotel_key, cur);
  }
  return [...byKey.values()];
}

function mergeXoteloAliasEntries(listRows, seedAliases) {
  const map = new Map();
  for (const e of buildXoteloAliasEntriesFromList(listRows)) {
    map.set(e.hotel_key, {
      hotel_key: e.hotel_key,
      names: [...new Set(e.names.filter(Boolean))],
      tripAdvisorUrl: e.tripAdvisorUrl || "",
      official_name: e.official_name || pickOfficialXoteloName(e),
      listImage: e.listImage || "",
      listReviewRating: e.listReviewRating,
    });
  }
  for (const e of seedAliases) {
    if (map.has(e.hotel_key)) {
      const cur = map.get(e.hotel_key);
      if (e.tripAdvisorUrl) cur.tripAdvisorUrl = e.tripAdvisorUrl;
      if (e.listImage) cur.listImage = e.listImage;
      for (const n of e.names) {
        if (!isAmbiguousXoteloAlias(n)) cur.names.push(n);
      }
      cur.names = [...new Set(cur.names.filter(Boolean))];
      continue;
    }
    map.set(e.hotel_key, {
      hotel_key: e.hotel_key,
      names: [...new Set(e.names.filter(Boolean))],
      tripAdvisorUrl: e.tripAdvisorUrl || "",
      official_name: e.official_name || pickOfficialXoteloName(e),
      listImage: e.listImage || "",
    });
  }
  return [...map.values()];
}

function findBestXoteloHotelKeyForPlaceName(googleName, aliasEntries, minScore = 0.34) {
  let bestKey = "";
  let bestScore = minScore;
  for (const e of aliasEntries) {
    let local = 0;
    for (const n of e.names) local = Math.max(local, scoreHotelNameMatch(googleName, n));
    if (local > bestScore) {
      bestScore = local;
      bestKey = e.hotel_key;
    }
  }
  return bestKey;
}

function findBestGooglePlaceForXoteloNames(names, places, usedPlaceIds, minScore = 0.32) {
  let best = null;
  let bestScore = minScore;
  for (const place of places) {
    const pid = place.placeId || place.name;
    if (usedPlaceIds.has(pid)) continue;
    for (const n of names) {
      const s = scoreHotelNameMatch(n, place.name);
      if (s > bestScore) {
        bestScore = s;
        best = place;
      }
    }
  }
  return best;
}

function buildXoteloRateKeyOrder(listRows, aliasEntries) {
  const listHint = new Map();
  if (Array.isArray(listRows)) {
    for (const row of listRows) {
      const k = row.key || row.hotel_key;
      if (!k) continue;
      const mn = Number(row.price_ranges?.minimum);
      listHint.set(String(k), Number.isFinite(mn) ? mn : 99999);
    }
  }
  return [...aliasEntries]
    .map((e) => ({
      ...e,
      /** Senza hint list: priorità alta (seed economici) così non perdiamo dietro ai luxury. */
      sortPrice: listHint.has(e.hotel_key) ? listHint.get(e.hotel_key) : 0,
    }))
    .sort((a, b) => a.sortPrice - b.sortPrice);
}

function pickCheapestXoteloNightly(rates) {
  if (!Array.isArray(rates) || !rates.length) return null;
  let best = null;
  let min = Infinity;
  for (const r of rates) {
    const nightly = Number(r.rate) + Number(r.tax || 0);
    if (!Number.isFinite(nightly) || nightly <= 0) continue;
    if (nightly < min) {
      min = nightly;
      best = r;
    }
  }
  return best && Number.isFinite(min) ? { row: best, nightly: min } : null;
}

/** Tariffa Xotelo più economica escludendo BookingCom (non affidabile senza Demand API). */
function pickCheapestNonBookingXoteloNightly(rates) {
  if (!Array.isArray(rates) || !rates.length) return null;
  let best = null;
  let min = Infinity;
  for (const r of rates) {
    const code = String(r.code || "").trim();
    const name = String(r.name || "");
    if (code === "BookingCom" || /booking/i.test(name)) continue;
    const nightly = Number(r.rate) + Number(r.tax || 0);
    if (!Number.isFinite(nightly) || nightly <= 0) continue;
    if (nightly < min) {
      min = nightly;
      best = r;
    }
  }
  return best && Number.isFinite(min) ? { row: best, nightly: min } : null;
}

/** Tariffa per card live: OTA non-Booking se possibile, altrimenti la più economica disponibile. */
function pickXoteloNightlyForQuote(rates) {
  return pickCheapestNonBookingXoteloNightly(rates) || pickCheapestXoteloNightly(rates);
}

function bookingCcHintFromIata(iata3) {
  const c = sanitizeIata3(iata3);
  const it = new Set([
    "ROM",
    "FCO",
    "CIA",
    "MIL",
    "MXP",
    "LIN",
    "BGY",
    "NAP",
    "VCE",
    "FLR",
    "BLQ",
    "TRN",
    "GOA",
    "PMO",
    "CTA",
    "BRI",
    "BDS",
    "OLB",
    "CAG",
    "PSA",
    "VRN",
    "TRS",
  ]);
  const es = new Set(["BCN", "MAD", "AGP", "VLC", "SVQ", "PMI", "IBZ", "LPA", "TFS", "FUE", "ACE"]);
  const uk = new Set(["LON", "LHR", "LGW", "STN", "LTN", "LCY", "SEN", "EDI", "MAN"]);
  const fr = new Set(["PAR", "CDG", "ORY", "BVA", "NCE", "MRS", "LYS"]);
  const de = new Set(["BER", "MUC", "FRA", "HAM", "CGN", "STR"]);
  const pt = new Set(["LIS", "OPO"]);
  const nl = new Set(["AMS"]);
  const gr = new Set(["ATH", "HER", "RHO", "JTR", "JMK", "CFU", "SKG"]);
  if (it.has(c)) return "it";
  if (es.has(c)) return "es";
  if (uk.has(c)) return "uk";
  if (fr.has(c)) return "fr";
  if (de.has(c)) return "de";
  if (pt.has(c)) return "pt";
  if (nl.has(c)) return "nl";
  if (gr.has(c)) return "gr";
  return "it";
}

function slugifyBookingHotelPathPart(name) {
  const s = foldAsciiLower(name).replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return s.slice(0, 96) || "hotel";
}

/** Chiave Xotelo = pagina TripAdvisor; da lì il pulsante «Vedi offerta» apre Agoda/Booking sulla struttura. */
function buildTripAdvisorHotelUrl(hotelKey, hotelName, tripAdvisorUrl) {
  const direct = String(tripAdvisorUrl || "").trim();
  if (/tripadvisor\./i.test(direct)) return direct;
  const key = String(hotelKey || "").trim();
  if (!/^g\d+-d\d+$/i.test(key)) return "";
  const slug = slugifyBookingHotelPathPart(hotelName) || "Hotel";
  return `https://www.tripadvisor.it/Hotel_Review-${key}-Reviews-${slug}.html`;
}

function xoteloProviderCampaignSlug(rateCode, rateName) {
  const code = String(rateCode || "").trim();
  if (code === "Agoda" || /agoda/i.test(String(rateName || ""))) return "agoda";
  if (code === "BookingCom" || /booking/i.test(String(rateName || ""))) return "booking";
  if (code === "Expedia" || /expedia/i.test(String(rateName || ""))) return "expedia";
  if (code === "HotelsCom2" || /hotels\.com/i.test(String(rateName || ""))) return "hotelscom";
  return "ota";
}

/** Link hotel verificato: deeplink Klook (città + date). */
function buildVerifiedHotelBookingLink({ hotelName, flight, persone, cityEn, hotel }) {
  const h =
    hotel && typeof hotel === "object"
      ? hotel
      : {
          name: String(hotelName || "").trim(),
          googleDisplayName: "",
          googlePlaceMatched: false,
          xoteloDisplayName: String(hotelName || "").trim(),
        };
  return buildKlookHotelLink(h, flight, persone, cityEn);
}

async function fetchXoteloRates(hotelKey, chkIn, chkOut, adults, currency) {
  if (!hotelKey || !isIsoDate(chkIn) || !isIsoDate(chkOut)) return null;
  const params = new URLSearchParams({
    hotel_key: hotelKey,
    chk_in: chkIn,
    chk_out: chkOut,
    currency: String(currency || "EUR").toUpperCase().slice(0, 3),
    adults: String(Math.max(1, Math.min(32, adults))),
    rooms: "1",
  });
  const url = `${XOTELO_API_BASE}/rates?${params.toString()}`;
  const data = await fetchJsonWithTimeout(url, XOTELO_RATES_TIMEOUT_MS);
  if (!data || data.error != null) return null;
  const rates = data?.result?.rates;
  if (!Array.isArray(rates) || !rates.length) return null;
  return {
    ...data.result,
    rates,
    fetchedAt: Number(data.timestamp) > 1e12 ? Number(data.timestamp) : Date.now(),
  };
}

async function fetchXoteloHotelListRows(_cityEn, _chkIn, _chkOut, locationKey) {
  const tryUrls = [];
  if (locationKey) {
    tryUrls.push(
      `${XOTELO_API_BASE}/list?${new URLSearchParams({
        location_key: locationKey,
        offset: "0",
        limit: "100",
        sort: "best_value",
      }).toString()}`
    );
  }

  for (const url of tryUrls) {
    const data = await fetchJsonWithTimeout(url, XOTELO_LIST_TIMEOUT_MS);
    const rows = data?.result?.list;
    if (Array.isArray(rows) && rows.length) return rows;
  }
  return [];
}

/**
 * Hotel con prezzo Xotelo live per le date del volo: nome e tariffa dalla stessa hotel_key
 * (TripAdvisor/Xotelo). Niente abbinamento Google sul prezzo — solo foto elenco Xotelo se c’è.
 */
async function searchHotelsXotelo(user, slots, _placeCandidates, destShort, destIata) {
  clearXoteloRatesSessionCache();
  const budget = Math.max(0, Number(user.budget) || 0);
  if (budget <= 0) return null;
  const iata = sanitizeIata3(destIata);
  const locKey = resolveXoteloLocationKeyFromIata(iata);
  const cityEn = englishCityForOta(destShort, iata);
  const currency = (process.env.TRAVELPAYOUTS_CURRENCY || "EUR").trim().toUpperCase().slice(0, 3) || "EUR";
  const guests = hotelGuestCount(user);
  const seedAliases = buildXoteloAliasEntriesFromSeeds(iata);

  const flight0 = slots[0].flight;
  const chkIn0 = String(flight0.departDate || "").slice(0, 10);
  const chkOut0 = String(flight0.returnDate || "").slice(0, 10);
  let listRows = [];
  if (isIsoDate(chkIn0) && isIsoDate(chkOut0)) {
    listRows = await fetchXoteloHotelListRows(cityEn, chkIn0, chkOut0, locKey);
  }
  const aliasEntries = mergeXoteloAliasEntries(listRows, seedAliases);
  if (!aliasEntries.length) return null;
  const orderedEntries = buildXoteloRateKeyOrder(listRows, aliasEntries);

  const out = [];
  const usedHotelKey = new Set();

  for (let slotIdx = 0; slotIdx < 3; slotIdx += 1) {
    const { flight } = slots[slotIdx];
    const fp = Number(flight.price);
    const hotelCap = hotelStayQuota(budget, fp, flight.priceSource);
    if (!Number.isFinite(fp) || hotelCap < 35) return null;
    const chkIn = String(flight.departDate || "").slice(0, 10);
    const chkOut = String(flight.returnDate || "").slice(0, 10);
    if (!isIsoDate(chkIn) || !isIsoDate(chkOut)) return null;
    const nights = stayNightsFromFlight(flight, user.durata);

    const keysToTry = orderedEntries
      .filter((e) => e.hotel_key && !usedHotelKey.has(e.hotel_key))
      .slice(0, XOTELO_MAX_KEYS_TO_RATE);

    const affordable = [];
    for (let ci = 0; ci < keysToTry.length; ci += XOTELO_RATES_PARALLEL) {
      const chunk = keysToTry.slice(ci, ci + XOTELO_RATES_PARALLEL);
      const part = await Promise.all(
        chunk.map(async (entry) => {
          const result = await fetchXoteloRatesCached(entry.hotel_key, chkIn, chkOut, guests, currency);
          if (!result) return null;
          const pick = pickCheapestNonBookingXoteloNightly(result.rates);
          if (!pick) return null;
          const totalStay = Math.ceil(pick.nightly * nights);
          if (!verifiedTripWithinBudget(fp, totalStay, budget, flight.priceSource)) return null;
          const officialName = pickOfficialXoteloName(entry);
          const listRating =
            entry.listReviewRating != null && Number.isFinite(Number(entry.listReviewRating))
              ? (Number(entry.listReviewRating) * 2).toFixed(1)
              : "";
          return {
            entry,
            officialName,
            hotelKey: entry.hotel_key,
            nightly: pick.nightly,
            totalStay,
            nights,
            providerCode: pick.row.code || "",
            providerName: pick.row.name || "OTA",
            tripAdvisorUrl: entry.tripAdvisorUrl || "",
            listImage: entry.listImage || "",
            listRating,
            priceFetchedAt: Number(result.fetchedAt) || Date.now(),
          };
        })
      );
      affordable.push(...part.filter(Boolean));
      if (affordable.length > 0) break;
    }

    if (!affordable.length) return null;

    affordable.sort((a, b) => a.totalStay - b.totalStay);
    const bestPick = affordable[0];

    usedHotelKey.add(bestPick.hotelKey);

    const kind = destinationKind(flight.destinationCode);
    const w = mockWalkForKind(kind);
    const walkToCenterMin = w.center;
    const walkToSeaMin = w.sea;

    const ratingTenth = bestPick.listRating || "";
    const providerLabel = String(bestPick.providerName || "").replace(/\.com/gi, "").trim() || "OTA";
    const bestPriceLine = `Prezzo live ${providerLabel} · €${Math.round(bestPick.nightly)}/notte · €${Math.round(
      bestPick.totalStay
    )} totale · aggiornato ora (Xotelo)`;
    const bookingLink = buildVerifiedHotelBookingLink({
      hotelName: bestPick.officialName,
      flight,
      persone: user.persone,
      cityEn,
      hotel: {
        name: bestPick.officialName,
        xoteloDisplayName: bestPick.officialName,
        googleDisplayName: "",
        googlePlaceMatched: false,
      },
    });

    out.push({
      slug: bestPick.hotelKey || `xotelo-${slotIdx}`,
      countryCode: "eu",
      roomType: user.tipo_camera || "Doppia",
      mealType: user.tipo_pasto || "Solo pernotto",
      structureType: "Hotel",
      name: bestPick.officialName,
      googlePlaceMatched: false,
      googleDisplayName: "",
      rating: ratingTenth,
      walkToSeaMin,
      walkToCenterMin,
      price: Math.round(bestPick.totalStay),
      stayNights: bestPick.nights,
      pricePerNightEstimate: Math.round(bestPick.nightly),
      pricePerNightXotelo: Math.round(bestPick.nightly),
      stayTotalEstimate: Math.round(bestPick.totalStay),
      stayIsEstimate: false,
      priceSource: "xotelo",
      priceVerified: true,
      priceFetchedAt: bestPick.priceFetchedAt,
      bestPriceProviderName: String(bestPick.providerName || ""),
      bestPriceLabel: bestPriceLine,
      bookingProviderCode: String(bestPick.providerCode || ""),
      xoteloHotelKey: bestPick.hotelKey,
      xoteloDisplayName: bestPick.officialName,
      photos: bestPick.listImage ? [bestPick.listImage] : [],
      bookingLink,
      googlePlaceId: "",
      formattedAddress: "",
    });
  }

  return out.length === 3 ? out : null;
}

function hashStringToUint32(str) {
  let h = 2166136261;
  const s = String(str || "");
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seededShuffleInPlace(list, seedStr) {
  let s = hashStringToUint32(seedStr) || 1;
  for (let i = list.length - 1; i > 0; i -= 1) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function searchHotelsDiversitySeed(user, destIata, flight) {
  return [
    user.budget,
    destIata,
    flight?.departDate,
    flight?.returnDate,
    user.aeroporto_partenza,
    user.persone,
    user.date_from,
    user.date_to,
    crypto.randomBytes(4).toString("hex"),
  ].join("|");
}

function mapGooglePlaceRow(r, key, wantRating, googleMinStars, enforceMin) {
  if (!r?.name) return null;
  if (enforceMin && wantRating > 0 && (r.rating == null || Number(r.rating) + 1e-6 < googleMinStars)) {
    return null;
  }
  const photoRef = r.photos?.[0]?.photo_reference;
  const photoUrl = photoRef
    ? `https://maps.googleapis.com/maps/api/place/photo?maxwidth=800&photo_reference=${encodeURIComponent(
        photoRef
      )}&key=${encodeURIComponent(key)}`
    : "";
  return {
    name: String(r.name).trim(),
    rating: r.rating != null ? Number(r.rating) : null,
    user_ratings_total: r.user_ratings_total,
    photoUrl,
    placeId: r.place_id || "",
    formatted_address: r.formatted_address || "",
    lat: r.geometry?.location?.lat != null ? Number(r.geometry.location.lat) : null,
    lng: r.geometry?.location?.lng != null ? Number(r.geometry.location.lng) : null,
    price_level: r.price_level != null ? Number(r.price_level) : null,
  };
}

async function fetchGooglePlacesHotelsQuery(queryText, limit, ratingMin, key) {
  const wantRating = Number(ratingMin) > 0 ? Number(ratingMin) : 0;
  const googleMinStars = wantRating > 0 ? Math.min(5, Math.max(0, wantRating / 2)) : 0;
  const q = encodeURIComponent(queryText);
  const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${q}&type=lodging&key=${encodeURIComponent(
    key
  )}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const data = await response.json();
    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") return [];
    const rows = Array.isArray(data.results) ? data.results : [];
    const ranked = [...rows].sort((a, b) => (b.rating || 0) - (a.rating || 0));
    const picked = [];
    const seen = new Set();
    const tryPush = (r, enforceMin) => {
      if (picked.length >= limit) return;
      const id = r.place_id || r.name;
      if (seen.has(id)) return;
      const mapped = mapGooglePlaceRow(r, key, wantRating, googleMinStars, enforceMin);
      if (!mapped) return;
      seen.add(id);
      picked.push(mapped);
    };
    for (const r of ranked) tryPush(r, true);
    if (picked.length < limit && wantRating > 0) {
      for (const r of ranked) tryPush(r, false);
    }
    return picked;
  } catch (_e) {
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Pool ampio di hotel reali (Google Places) — più query per varietà, non seed fissi.
 */
async function fetchGooglePlacesHotelPool(cityLabel, limit, ratingMin) {
  const key = getGoogleMapsKey();
  const city = plainDestinationName(cityLabel);
  if (!key || !city) return [];

  const queries = [
    `hotels in ${city}`,
    `hotel ${city} city center`,
    `accommodation ${city}`,
  ];
  const merged = [];
  const seen = new Set();
  for (const queryText of queries) {
    const part = await fetchGooglePlacesHotelsQuery(
      queryText,
      Math.max(8, Math.ceil(limit / queries.length)),
      ratingMin,
      key
    );
    for (const row of part) {
      const id = row.placeId || row.name;
      if (seen.has(id)) continue;
      seen.add(id);
      merged.push(row);
    }
    if (merged.length >= limit) break;
  }
  merged.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  return merged.slice(0, limit);
}

/** @deprecated Usare fetchGooglePlacesHotelPool */
async function fetchGooglePlacesHotels(cityLabel, limit, ratingMin) {
  return fetchGooglePlacesHotelPool(cityLabel, limit, ratingMin);
}

/**
 * Tre hotel reali (Google) + volo nel budget. Niente Xotelo: il prezzo hotel è la quota
 * alloggio calcolata sul budget; il prezzo camera si vede su Klook al click.
 */
async function searchHotelsGoogleLive(user, slots, destShort, destIata) {
  if (!getGoogleMapsKey()) return null;
  const budget = Math.max(0, Number(user.budget) || 0);
  if (budget <= 0) return null;

  const ratingMin = Number(user.rating_minimo) || 0;
  let pool = await fetchGooglePlacesHotelPool(destShort, 24, ratingMin);
  if (pool.length < 3) {
    pool = await fetchGooglePlacesHotelPool(destShort, 24, 0);
  }
  if (pool.length < 3) return null;

  const seed = searchHotelsDiversitySeed(user, destIata, slots[0]?.flight);
  const ordered = seededShuffleInPlace([...pool], seed);

  const used = new Set();
  const out = [];
  const kindDefault = destinationKind(destIata);

  for (let slotIdx = 0; slotIdx < 3; slotIdx += 1) {
    const { flight, alloc } = slots[slotIdx];
    const fp = Number(flight.price);
    const stayTarget = Math.round(Number(alloc?.stayTarget) || 0);
    if (!alloc || stayTarget < 35 || !verifiedTripWithinBudget(fp, stayTarget, budget, flight.priceSource))
      return null;

    let place = null;
    for (const candidate of ordered) {
      const id = candidate.placeId || candidate.name;
      if (used.has(id)) continue;
      used.add(id);
      place = candidate;
      break;
    }
    if (!place) return null;

    const nights = stayNightsFromFlight(flight, user.durata);
    const pn = Math.max(1, Math.round(stayTarget / Math.max(1, nights)));
    const kind = destinationKind(flight.destinationCode) || kindDefault;
    const w = mockWalkForKind(kind);
    const walkToCenterMin = w.center;
    const walkToSeaMin = w.sea;

    const ratingTenth = place.rating != null ? (Number(place.rating) * 2).toFixed(1) : "";
    const bestPriceLine = `Hotel Google · quota alloggio €${stayTarget} (${nights} notti, ~€${pn}/notte nel budget) · tariffa su Klook`;

    out.push({
      slug: place.placeId || `google-${slotIdx}`,
      countryCode: "eu",
      roomType: user.tipo_camera || "Doppia",
      mealType: user.tipo_pasto || "Solo pernotto",
      structureType: "Hotel",
      name: place.name,
      googlePlaceMatched: true,
      googleDisplayName: place.name,
      rating: ratingTenth,
      walkToSeaMin,
      walkToCenterMin,
      price: stayTarget,
      stayNights: nights,
      pricePerNightEstimate: pn,
      stayTotalEstimate: stayTarget,
      stayIsEstimate: true,
      priceSource: "google",
      priceVerified: false,
      priceFetchedAt: Date.now(),
      bestPriceProviderName: "Klook",
      bestPriceLabel: bestPriceLine,
      bookingProviderCode: "",
      photos: place.photoUrl ? [place.photoUrl] : [],
      bookingLink: buildKlookHotelLink(
        {
          name: place.name,
          googleDisplayName: place.name,
          googlePlaceMatched: true,
        },
        flight,
        user.persone,
        destShort
      ),
      googlePlaceId: place.placeId,
      formattedAddress: place.formatted_address || "",
    });
  }

  return out.length === 3 ? out : null;
}

const FLIGHT_COVER_PHOTOS = [
  "https://images.unsplash.com/photo-1436491865332-7a61a109cc05?auto=format&fit=crop&w=1400&q=85",
  "https://images.unsplash.com/photo-1569629740757-6f61cf585be6?auto=format&fit=crop&w=1400&q=85",
  "https://images.unsplash.com/photo-1529074963764-98f45c47344f?auto=format&fit=crop&w=1400&q=85",
  "https://images.unsplash.com/photo-1540962351604-02984b1bf25f?auto=format&fit=crop&w=1400&q=85",
  "https://images.unsplash.com/photo-1474302770737-173ee21bab63?auto=format&fit=crop&w=1400&q=85",
];

function buildEstimatedFlightOffers(user, destinationCode, destinationLabel, departDate, returnDate) {
  const adults = hotelGuestCount(user);
  const B = Math.max(100, Number(user.budget) || 500);
  const maxTotal = maxQuotedFlightTotalForUser(user);
  const unit = Math.max(
    35,
    Math.min(Math.floor(B * 0.22), 180, Math.floor(maxTotal / Math.max(1, adults)))
  );
  const origins = resolveFlightOriginCodes(user.aeroporto_partenza);
  const from =
    sanitizeIata3(origins[0]) || sanitizeIata3(user.aeroporto_partenza) || "NAP";
  const dest =
    sanitizeIata3(destinationCode) ||
    inferDestinationCode(destinationLabel) ||
    sanitizeIata3(user.destinazione_iata);
  const dates = resolveTravelDates(user);
  const flight = {
    from,
    fromName: from,
    destination: destinationLabel || destinationLabelFromCode(dest) || dest,
    destinationCode: dest,
    departDate: departDate || dates.departDate,
    returnDate: returnDate || dates.returnDate,
    airline: "Cerca offerte",
    priceSource: "estimate",
    pricePerPerson: unit,
    price: unit * adults,
    direct: false,
  };
  attachFlightAffiliateLinks(flight, user);
  return [flight];
}

async function searchFlightsAzair(user, options = {}) {
  console.log("[tp-DEBUG] searchFlightsAzair chiamata, token presente:", !!process.env.TRAVELPAYOUTS_API_TOKEN);
  const allowEstimate = options.allowEstimate === true;
  const totalBudget = Math.max(0, Number(user.budget) || 0);
  const tripNights = Math.max(1, Number(user.durata) || 3);
  const minHotel = minHotelStayBudget(tripNights);
  /** Budget totale: il volo (stima prudente) non può assorbire tutto — deve restare almeno il minimo alloggio. */
  const maxFlightReserved = Math.max(0, totalBudget - minHotel);
  if (maxFlightReserved < 40 && !allowEstimate) return [];

  const pref = user.destinazione_preferita && String(user.destinazione_preferita).trim();
  if (isSurpriseSearch(user)) {
    const picked = await pickSurpriseDestination(user);
    const sub = {
      ...user,
      destinazione_preferita: picked.label,
      destinazione_iata: picked.code,
      destinazione_sorpresa: 0,
    };
    return searchFlightsAzair(sub, options);
  }

  const token = (process.env.TRAVELPAYOUTS_API_TOKEN || "").trim();
  /** Mock solo se esplicitamente ALLOW_MOCK_FLIGHTS=true (mai in default: niente prezzi inventati). */
  const allowMockFlights = String(process.env.ALLOW_MOCK_FLIGHTS || "").trim().toLowerCase() === "true";
  const currency = (process.env.TRAVELPAYOUTS_CURRENCY || "EUR").trim().toUpperCase().slice(0, 3) || "EUR";
  const market = (process.env.TRAVELPAYOUTS_MARKET || "it").trim().toLowerCase();
  const destInfo = resolveLiveDestination(user);
  const destinationLabel = destInfo.label || pref || chooseDestination(user);
  const destinationCode = destInfo.code;
  const { departDate, returnDate } = resolveTravelDates(user);
  const exactDates = options.exactDates === true;

  if (!destinationCode && !allowEstimate) {
    const err = new Error("Destinazione non supportata. Inserisci una citta nota o codice IATA (es. ATH, BCN).");
    err.code = "DESTINATION_UNSUPPORTED";
    throw err;
  }
  if (!destinationCode && allowEstimate) {
    return buildEstimatedFlightOffers(
      user,
      "",
      destinationLabel,
      departDate,
      returnDate
    );
  }

  if (!token && !allowMockFlights) {
    if (allowEstimate && destinationCode) {
      return buildEstimatedFlightOffers(
        user,
        destinationCode,
        destinationLabel,
        departDate,
        returnDate
      );
    }
    const err = new Error("Prezzi live non disponibili: manca TRAVELPAYOUTS_API_TOKEN.");
    err.code = "LIVE_PRICES_UNAVAILABLE";
    throw err;
  }

  if (token && destinationCode) {
    const queries = buildDateQueries(departDate, returnDate, { exactOnly: exactDates });
    try {
      const directOnly = getSoloVoliDiretti(user);
      const pass = { oneWay: false, dateQueries: queries };
      const originCodes = resolveFlightOriginCodes(user.aeroporto_partenza);
      const tpDestination = resolveTravelpayoutsDestinationCode(destinationCode);
      const adults = hotelGuestCount(user);
      let bestFlights = [];

      for (const originCode of originCodes) {
        const ctx = {
          token,
          currency,
          market,
          directOnly,
          pass,
          originCode,
          tpDestination,
          queries,
          destinationCode,
          destinationLabel,
          departDate,
          returnDate,
          exactDates,
          user,
          adults,
        };
        let chunk = await fetchTravelpayoutsV3RouteFlights(ctx);
        if (!chunk.length) chunk = await fetchTravelpayoutsV1CheapFlights(ctx);
        if (!chunk.length) chunk = await fetchTravelpayoutsV2MonthMatrixFlights(ctx);
        if (!chunk.length) chunk = await fetchTravelpayoutsV1CheapFlightsNoDates(ctx);
        bestFlights = bestFlights.concat(chunk);
      }

      console.log("[tp-flights] voli trovati:", bestFlights.length);
      const pick = mergeTravelpayoutsFlightResults(bestFlights, maxFlightReserved);
      console.log("[tp-flights] voli dopo filtri:", pick.length);
      console.log("[tp-flights] budget max volo:", maxFlightReserved);
      if (pick.length) return pick;
    } catch (_error) {
      if (allowEstimate) {
        return buildEstimatedFlightOffers(
          user,
          destinationCode,
          destinationLabel,
          departDate,
          returnDate
        );
      }
      if (!allowMockFlights) {
        const err = new Error("Impossibile ottenere prezzi live dal provider in questo momento.");
        err.code = "LIVE_PRICES_UNAVAILABLE";
        throw err;
      }
    }
  }

  if (!allowMockFlights) {
    if (allowEstimate && destinationCode) {
      return buildEstimatedFlightOffers(
        user,
        destinationCode,
        destinationLabel,
        departDate,
        returnDate
      );
    }
    return [];
  }

  // Fallback mock prices when Travelpayouts token is missing/unavailable.
  const adults = hotelGuestCount(user);
  return Array.from({ length: 12 })
    .map(() => {
      const minPrice = Math.max(25, Math.floor(user.budget * 0.22));
      const maxPrice = Math.min(Math.max(minPrice + 5, Math.floor(user.budget * 0.55)), maxFlightReserved);
      const unitPrice = Math.floor(minPrice + Math.random() * Math.max(1, maxPrice - minPrice));
      const coverPhoto =
        FLIGHT_COVER_PHOTOS[Math.floor(Math.random() * FLIGHT_COVER_PHOTOS.length)];

      return {
        from: user.aeroporto_partenza,
        fromName: user.aeroporto_partenza,
        destination: destinationLabel,
        destinationCode,
        departDate,
        returnDate,
        timeBand: user.fascia_oraria === "Indifferente" ? "Mattina" : user.fascia_oraria,
        flightType: "Diretto",
        airlineName: "Compagnia partner",
        pricePerPerson: unitPrice,
        price: Math.round(unitPrice * adults),
        passengersAdults: adults,
        priceSource: "mock",
        coverPhoto,
      };
    })
    .filter((f) => flightPriceReservedForBudget(f.price, f.priceSource) <= maxFlightReserved)
    .sort((a, b) => a.price - b.price)
    .slice(0, 5);
}

const DEFAULT_KIWI_AFFILIATE = "https://kiwi.tpk.lv/UiOvgyTf";
const DEFAULT_AIRHELP_AFFILIATE = "https://airhelp.tpk.lv/BDuyfeVr";

function affiliateFlightUrl() {
  let u = (process.env.PARTIAMO_KIWI_URL || DEFAULT_KIWI_AFFILIATE).trim();
  if (/aviasales\.com/i.test(u)) u = DEFAULT_KIWI_AFFILIATE;
  return u || DEFAULT_KIWI_AFFILIATE;
}

function affiliateAirHelpUrl() {
  const u = (process.env.PARTIAMO_AIRHELP_URL || DEFAULT_AIRHELP_AFFILIATE).trim();
  return u || DEFAULT_AIRHELP_AFFILIATE;
}

/** Codici metro/città con tutti gli aeroporti principali usati da Kiwi. */
const KIWI_METRO_TO_AIRPORTS = {
  PAR: ["CDG", "ORY", "BVA"],
  LON: ["LHR", "LGW", "STN", "LTN", "LCY", "SEN"],
  ROM: ["FCO", "CIA"],
  MIL: ["MXP", "LIN", "BGY"],
  NYC: ["JFK", "EWR", "LGA"],
  YTO: ["YYZ", "YTZ", "YHM"],
  TYO: ["NRT", "HND"],
  OSA: ["KIX", "ITM", "UKB"],
  STO: ["ARN", "BMA", "NYO", "VST"],
  REK: ["KEF", "RKV"],
  WAS: ["IAD", "DCA", "BWI"],
};

const KIWI_AIRPORT_TO_METRO = Object.entries(KIWI_METRO_TO_AIRPORTS).reduce((acc, [metro, airports]) => {
  for (const ap of airports) acc[ap] = metro;
  return acc;
}, {});

/** Travelpayouts prices_for_dates vuole di solito un IATA aeroporto, non codici metro (NYC, LON…). */
function resolveTravelpayoutsDestinationCode(code) {
  const c = sanitizeIata3(code);
  if (!c) return "";
  const list = KIWI_METRO_TO_AIRPORTS[c];
  if (list && list.length) return list[0];
  return c;
}

/** Aeroporti da interrogare su Travelpayouts (metro → più hub, es. Roma FCO+CIA). */
function resolveFlightOriginCodes(aeroportoPartenza) {
  const raw = String(aeroportoPartenza || "").trim().toUpperCase();
  if (!raw) return ["NAP"];
  if (raw === "RMA" || raw === "ROM" || raw === "FCO" || raw === "CIA") return ["FCO", "CIA"];
  const metroList = KIWI_METRO_TO_AIRPORTS[raw];
  if (metroList && metroList.length) return [...metroList];
  const metro = KIWI_AIRPORT_TO_METRO[raw];
  if (metro && KIWI_METRO_TO_AIRPORTS[metro]) return [...KIWI_METRO_TO_AIRPORTS[metro]];
  return [sanitizeIata3(raw)].filter((c) => c.length === 3);
}

function sanitizeIata3(raw) {
  return String(raw || "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 3);
}

function resolveKiwiAirportForUrl(code) {
  const c = sanitizeIata3(code);
  if (c.length !== 3) return "";
  // Se è già un codice metro (es. NYC), lasciamolo com'è per includere tutti gli aeroporti.
  if (KIWI_METRO_TO_AIRPORTS[c]) return c;
  // Se è un aeroporto appartenente a una metro-area, usiamo la metro-area.
  return KIWI_AIRPORT_TO_METRO[c] || c;
}

/** DDMM come da guida Travelpayouts White Label / Kiwi */
function toDdMmKiwi(isoDate) {
  const [y, m, d] = String(isoDate || "").split("-");
  if (!y || !m || !d) return "";
  const day = String(Number(d)).padStart(2, "0");
  const month = String(Number(m)).padStart(2, "0");
  return `${day}${month}`;
}

/**
 * Segmento flightSearch White Label (round trip + passeggeri economy).
 * Es. MOW0101IST02011 — vedi https://support.travelpayouts.com/hc/en-us/articles/115003710648
 */
function buildKiwiFlightSearchSegment(flight, adults) {
  const from = resolveKiwiAirportForUrl(flight.from);
  const to = resolveKiwiAirportForUrl(flight.destinationCode);
  const d1 = toDdMmKiwi(flight.departDate);
  const d2 = toDdMmKiwi(flight.returnDate);
  const n = Math.max(1, Math.min(9, Number(adults) || 1));
  if (from.length !== 3 || to.length !== 3 || d1.length !== 4 || d2.length !== 4) return "";
  return `${from}${d1}${to}${d2}${n}`;
}

function extractAdultsForFlight(flight, contextUser) {
  const stored = Number(flight.passengersAdults);
  if (Number.isFinite(stored) && stored >= 1 && stored <= 9) {
    return Math.floor(stored);
  }
  if (contextUser && contextUser.persone != null) {
    return Math.max(1, Math.min(9, Number(String(contextUser.persone).replace(/\D/g, "")) || 1));
  }
  return 1;
}

/** Aeroporti / mete comuni non presenti come IATA principale nel JSON destinazioni. */
const KIWI_EXTRA_IATA_TO_ROW_IATA = {
  FCO: "ROM",
  CIA: "ROM",
  MXP: "MIL",
  BGY: "MIL",
  LIN: "MIL",
  TSF: "MIL",
  CDG: "PAR",
  ORY: "PAR",
  BVA: "PAR",
  LGW: "LON",
  STN: "LON",
  LTN: "LON",
  LHR: "LON",
  JFK: "NYC",
  EWR: "NYC",
  LGA: "NYC",
  YYZ: "YTO",
  YTZ: "YTO",
  HND: "TYO",
  NRT: "TYO",
  ITM: "OSA",
  UKB: "OSA",
  DCA: "WAS",
  BWI: "WAS",
  SUF: "NAP",
  CRL: "BRU",
};

const ITALIAN_DESTINATION_IATA = new Set([
  "ROM",
  "MIL",
  "NAP",
  "VCE",
  "FLR",
  "BLQ",
  "TRN",
  "GOA",
  "PMO",
  "CTA",
  "BRI",
  "BDS",
  "OLB",
  "CAG",
  "PSA",
  "VRN",
  "TRS",
]);

/** Ordine: stringhe più lunghe prima. */
const COUNTRY_KEYWORD_TO_KIWI_SLUG = [
  ["regno unito", "regno-unito"],
  ["repubblica ceca", "repubblica-ceca"],
  ["paesi bassi", "olanda"],
  ["emirati arabi", "emirati-arabi-uniti"],
  ["emirati", "emirati-arabi-uniti"],
  ["new york city", "stati-uniti"],
  ["costantinopoli", "turchia"],
  ["nicosia area", "cipro"],
  ["germania", "germania"],
  ["francia", "francia"],
  ["spagna", "spagna"],
  ["grecia", "grecia"],
  ["portogallo", "portogallo"],
  ["olanda", "olanda"],
  ["belgio", "belgio"],
  ["austria", "austria"],
  ["svizzera", "svizzera"],
  ["ungheria", "ungheria"],
  ["polonia", "polonia"],
  ["slovenia", "slovenia"],
  ["croazia", "croazia"],
  ["serbia", "serbia"],
  ["romania", "romania"],
  ["bulgaria", "bulgaria"],
  ["egitto", "egitto"],
  ["marocco", "marocco"],
  ["israele", "israele"],
  ["irlanda", "irlanda"],
  ["turchia", "turchia"],
  ["usa", "stati-uniti"],
  ["florida", "stati-uniti"],
  ["california", "stati-uniti"],
  ["canada", "canada"],
  ["messico", "messico"],
  ["giappone", "giappone"],
  ["thailandia", "thailandia"],
  ["indonesia", "indonesia"],
  ["australia", "australia"],
  ["norvegia", "norvegia"],
  ["svezia", "svezia"],
  ["danimarca", "danimarca"],
  ["finlandia", "finlandia"],
  ["islanda", "islanda"],
  ["estonia", "estonia"],
  ["lettonia", "lettonia"],
  ["lituania", "lituania"],
  ["malta", "malta"],
  ["cipro", "cipro"],
  ["sardegna", "italia"],
  ["canarie", "spagna"],
  ["majorca", "spagna"],
];

const KIWI_IATA_FALLBACK_COUNTRY_SLUG = {
  ATH: "grecia",
  BCN: "spagna",
  MAD: "spagna",
  VLC: "spagna",
  SVQ: "spagna",
  AGP: "spagna",
  PMI: "spagna",
  IBZ: "spagna",
  LIS: "portogallo",
  OPO: "portogallo",
  PAR: "francia",
  LYS: "francia",
  NCE: "francia",
  MRS: "francia",
  LON: "regno-unito",
  MAN: "regno-unito",
  EDI: "regno-unito",
  DUB: "irlanda",
  BER: "germania",
  MUC: "germania",
  FRA: "germania",
  HAM: "germania",
  CGN: "germania",
  STR: "germania",
  AMS: "olanda",
  BRU: "belgio",
  VIE: "austria",
  SZG: "austria",
  INN: "austria",
  ZRH: "svizzera",
  GVA: "svizzera",
  BRN: "svizzera",
  PRG: "repubblica-ceca",
  BUD: "ungheria",
  WAW: "polonia",
  KRK: "polonia",
  LJU: "slovenia",
  ZAG: "croazia",
  SPU: "croazia",
  DBV: "croazia",
  BEG: "serbia",
  OTP: "romania",
  SOF: "bulgaria",
  SKG: "grecia",
  HER: "grecia",
  RHO: "grecia",
  JTR: "grecia",
  JMK: "grecia",
  CFU: "grecia",
  IST: "turchia",
  AYT: "turchia",
  CAI: "egitto",
  RAK: "marocco",
  CMN: "marocco",
  TLV: "israele",
  DXB: "emirati-arabi-uniti",
  NYC: "stati-uniti",
  MIA: "stati-uniti",
  LAX: "stati-uniti",
  SFO: "stati-uniti",
  BOS: "stati-uniti",
  ORD: "stati-uniti",
  YTO: "canada",
  CUN: "messico",
  TYO: "giappone",
  OSA: "giappone",
  BKK: "thailandia",
  HKT: "thailandia",
  SIN: "singapore",
  DPS: "indonesia",
  SYD: "australia",
  MEL: "australia",
  OSL: "norvegia",
  STO: "svezia",
  CPH: "danimarca",
  HEL: "finlandia",
  REK: "islanda",
  TLL: "estonia",
  RIX: "lettonia",
  VNO: "lituania",
  MLA: "malta",
  LCA: "cipro",
  RMF: "egitto",
  FUE: "spagna",
  TFS: "spagna",
  LPA: "spagna",
  ACE: "spagna",
  FNC: "portogallo",
  PDL: "portogallo",
  LEJ: "germania",
  DUS: "germania",
};

function slugifyKiwiCityLabel(label) {
  return normalizeDestinationLabel(label).replace(/\s+/g, "-");
}

function countrySlugForDestinationRow(d) {
  const raw = [d.label, ...(d.aliases || [])].join(" ").toLowerCase();
  for (const [needle, slug] of COUNTRY_KEYWORD_TO_KIWI_SLUG) {
    if (raw.includes(needle)) return slug;
  }
  if (ITALIAN_DESTINATION_IATA.has(d.iata)) return "italia";
  return KIWI_IATA_FALLBACK_COUNTRY_SLUG[d.iata] || "";
}

function kiwiCityCountrySlugForRow(d) {
  const city = slugifyKiwiCityLabel(d.label);
  const country = countrySlugForDestinationRow(d);
  if (!city || !country) return "";
  return `${city}-${country}`;
}

/** Metropolitane dove Kiwi distingue regione vs città: serve city-city-country per /search/results (es. NYC). */
const KIWI_FLIGHT_RESULTS_NARROW_DEST_IATA = new Set(["NYC"]);

function kiwiDestinationSlugForFlightResults(d) {
  const base = kiwiCityCountrySlugForRow(d);
  if (!base || !d?.iata) return base;
  if (!KIWI_FLIGHT_RESULTS_NARROW_DEST_IATA.has(d.iata)) return base;
  const city = slugifyKiwiCityLabel(d.label);
  const country = countrySlugForDestinationRow(d);
  if (!city || !country) return base;
  return `${city}-${city}-${country}`;
}

function resolveDestinationRowKeyForIata(iata) {
  const code = sanitizeIata3(iata);
  const mapped = KIWI_EXTRA_IATA_TO_ROW_IATA[code];
  return mapped || code;
}

function findDestinationRowByIata(iata) {
  const key = resolveDestinationRowKeyForIata(iata);
  return DESTINATIONS.find((d) => d.iata === key) || null;
}

function findDestinationRowByLabel(label) {
  const n = normalizeDestinationLabel(label);
  if (!n) return null;
  return (
    DESTINATIONS.find((d) => normalizeDestinationLabel(d.label) === n) ||
    DESTINATIONS.find((d) => (d.aliases || []).some((a) => normalizeDestinationLabel(a) === n)) ||
    null
  );
}

/**
 * URL elenco voli Kiwi (itinerari con filtri), non la landing /tiles con sole “mete popolari”.
 * Per NYC il segmento destinazione deve essere city-city-country (es. new-york-new-york-stati-uniti),
 * altrimenti Kiwi resta sulla vista tiles / generiche.
 * Formato: /it/search/results/napoli-italia/lione-francia/2026-06-15/2026-06-22/1-0-0/
 */
function normalizeKiwiPassengers(input) {
  if (input && typeof input === "object" && Number.isFinite(Number(input.adults))) {
    return parseTripPassengers(input);
  }
  const adults = Math.max(1, Math.min(9, Number(input) || 1));
  return { adults, children: 0, infants: 0 };
}

function buildKiwiSearchResultsUrl(flight, passengersInput) {
  const pax = normalizeKiwiPassengers(passengersInput);
  const fromIata = resolveKiwiAirportForUrl(flight.from);
  const toIata = resolveKiwiAirportForUrl(flight.destinationCode);
  let out = String(flight.departDate || "").slice(0, 10);
  let inn = String(flight.returnDate || "").slice(0, 10);
  if (isIsoDate(out) && isIsoDate(inn) && new Date(inn) < new Date(out)) {
    inn = addDaysIso(out, 3);
  }
  if (!isIsoDate(out) || !isIsoDate(inn)) return "";

  const originRow = findDestinationRowByIata(fromIata);
  const destRow =
    findDestinationRowByLabel(flight.destination) || findDestinationRowByIata(toIata) || findDestinationRowByIata(flight.destinationCode);
  if (!originRow || !destRow) return "";

  const fromSeg = kiwiCityCountrySlugForRow(originRow);
  const toSeg = kiwiDestinationSlugForFlightResults(destRow);
  if (!fromSeg || !toSeg) return "";

  const path = `/it/search/results/${fromSeg}/${toSeg}/${out}/${inn}/${pax.adults}-${pax.children}-${pax.infants}/`;
  return `https://www.kiwi.com${path}`;
}

/**
 * Link diretto kiwi.com (homepage con query) — spesso ignorato dal sito; usato solo come fallback.
 */
function buildKiwiDirectSearchUrl(flight, passengersInput) {
  const pax = normalizeKiwiPassengers(passengersInput);
  const from = resolveKiwiAirportForUrl(flight.from);
  const to = resolveKiwiAirportForUrl(flight.destinationCode);
  let out = String(flight.departDate || "").slice(0, 10);
  let inn = String(flight.returnDate || "").slice(0, 10);
  if (isIsoDate(out) && isIsoDate(inn) && new Date(inn) < new Date(out)) {
    inn = addDaysIso(out, 3);
  }
  if (from.length !== 3 || to.length !== 3 || !isIsoDate(out) || !isIsoDate(inn)) {
    return "";
  }
  const url = new URL("https://www.kiwi.com/it/");
  url.searchParams.set("origin", from);
  url.searchParams.set("destination", to);
  url.searchParams.set("outboundDate", out);
  url.searchParams.set("inboundDate", inn);
  url.searchParams.set("passengers", String(pax.adults));
  if (pax.children > 0) url.searchParams.set("children", String(pax.children));
  if (pax.infants > 0) url.searchParams.set("infants", String(pax.infants));
  url.searchParams.set("lang", "it");
  return url.toString();
}

/** Valore query Kiwi: `MANO.STIVA-` (1.0- solo mano, 0.1- solo stiva, 1.1- entrambi). */
function kiwiBagsQueryValue(user) {
  const bag = String(user?.bagaglio || "Solo cabina").toLowerCase();
  let hand = 1;
  let hold = 0;
  if (/mano e stiva|entrambi/.test(bag)) {
    hand = 1;
    hold = 1;
  } else if (/stiva|hold|checked/.test(bag)) {
    hand = 0;
    hold = 1;
  }
  return `${hand}.${hold}-`;
}

/** Filtri Kiwi: voli diretti e bagaglio nel prezzo mostrato. */
function applyKiwiSearchOptions(urlString, user, opts = {}) {
  if (!urlString) return "";
  let u;
  try {
    u = new URL(urlString);
  } catch (_e) {
    return applyOptionalKiwiQuerySuffix(urlString);
  }
  const handBaggageOnly = opts.handBaggageOnly === true;
  if (!handBaggageOnly && getSoloVoliDiretti(user)) {
    u.searchParams.set("stopNumber", "0~true");
  }
  u.searchParams.set("bags", handBaggageOnly ? "1.0-" : kiwiBagsQueryValue(user));
  u.searchParams.delete("handBags");
  u.searchParams.delete("holdBags");
  return applyOptionalKiwiQuerySuffix(u.toString());
}

function applyOptionalKiwiQuerySuffix(urlString) {
  const suffix = (process.env.PARTIAMO_KIWI_QUERY_SUFFIX || "").trim();
  if (!suffix || !urlString) return urlString;
  let u;
  try {
    u = new URL(urlString);
  } catch (_e) {
    return urlString;
  }
  for (const pair of suffix.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const k = decodeURIComponent(eq === -1 ? pair : pair.slice(0, eq)).trim();
    const v = eq === -1 ? "" : decodeURIComponent(pair.slice(eq + 1));
    if (k) u.searchParams.set(k, v);
  }
  return u.toString();
}

function buildKiwiAffiliateSearchUrl(flight, passengersInput, user) {
  const results = buildKiwiSearchResultsUrl(flight, passengersInput);
  if (results) {
    return applyKiwiSearchOptions(results, user);
  }

  const direct = buildKiwiDirectSearchUrl(flight, passengersInput);
  if (direct) {
    return applyKiwiSearchOptions(direct, user);
  }

  const baseRaw = affiliateFlightUrl().replace(/\/$/, "");
  let baseUrl;
  try {
    baseUrl = new URL(baseRaw);
  } catch (_e) {
    return baseRaw;
  }
  const segment = buildKiwiFlightSearchSegment(flight, adults);
  if (segment) {
    baseUrl.searchParams.set("flightSearch", segment);
  }
  return applyOptionalKiwiQuerySuffix(baseUrl.toString());
}

/**
 * Deep link Aviasales dal campo `link` di Travelpayouts (itinerario + expected_price_uuid).
 * Meglio della sola ricerca Kiwi: punta allo stesso volo trovato in cache.
 */
function buildTravelpayoutsFlightDeepUrl(providerLinkPath) {
  const raw = String(providerLinkPath || "").trim();
  if (!raw) return "";
  let path = raw;
  if (!/\/search\//i.test(path)) {
    path = path.startsWith("/") ? `/search${path}` : `/search/${path}`;
  }
  const host = (process.env.TRAVELPAYOUTS_FLIGHT_HOST || "https://www.aviasales.it").replace(/\/$/, "");
  const marker = (process.env.TRAVELPAYOUTS_MARKER || "").trim();
  let url;
  try {
    url = new URL(path, `${host}/`);
  } catch (_e) {
    return "";
  }
  if (marker) url.searchParams.set("marker", marker);
  return url.toString();
}

function buildAviasalesFlightSearchUrlFromUserDates(flight, contextUser) {
  const adults = extractAdultsForFlight(flight, contextUser);
  const host = (process.env.TRAVELPAYOUTS_FLIGHT_HOST || "https://www.aviasales.it").replace(/\/$/, "");
  const dates = stayDatesForOffer(flight, contextUser || {});
  const from = sanitizeIata3(flight?.from || contextUser?.aeroporto_partenza);
  const to = sanitizeIata3(flight?.destinationCode || contextUser?.destinazione_iata);
  const d1 = toDdMmKiwi(dates.checkIn);
  const d2 = toDdMmKiwi(dates.checkOut);
  const n = Math.max(1, Math.min(9, Number(adults) || 1));
  if (from.length !== 3 || to.length !== 3 || d1.length !== 4 || d2.length !== 4) return "";

  let url;
  try {
    url = new URL(`/search/${from}${d1}${to}${d2}${n}`, `${host}/`);
  } catch (_e) {
    return "";
  }
  const marker = (process.env.TRAVELPAYOUTS_MARKER || "").trim();
  if (marker) url.searchParams.set("marker", marker);
  url.searchParams.set("origin_airports", "0");
  url.searchParams.set("destination_airports", "1");
  url.searchParams.set("show_hotels", "0");
  url.searchParams.set("depart_date", dates.checkIn);
  url.searchParams.set("return_date", dates.checkOut);
  url.searchParams.set("with_request", "1");
  return url.toString();
}

function buildAviasalesHotelUrlFromFlight(flight, contextUser) {
  const host = "https://www.aviasales.it";
  let url;
  try {
    url = new URL("/search", `${host}/`);
  } catch (_e) {
    return "";
  }

  const marker = (process.env.TRAVELPAYOUTS_MARKER || "725780").trim();
  const stayDates = stayDatesForOffer(flight, contextUser || {});
  const destination = sanitizeIata3(flight?.destinationCode || contextUser?.destinazione_iata);
  url.searchParams.set("show_hotels", "1");
  if (destination) url.searchParams.set("destination_iata", resolveTravelpayoutsDestinationCode(destination) || destination);
  if (isIsoDate(stayDates.checkIn)) url.searchParams.set("depart_date", stayDates.checkIn);
  if (isIsoDate(stayDates.checkOut)) url.searchParams.set("return_date", stayDates.checkOut);
  if (marker) url.searchParams.set("marker", marker);
  return url.toString();
}

function attachFlightAffiliateLinks(flight, contextUser) {
  const adults = extractAdultsForFlight(flight, contextUser);
  flight.passengersAdults = adults;
  const tpDeep = buildTravelpayoutsFlightDeepUrl(flight.providerLinkPath);
  const aviasalesSearch = buildAviasalesFlightSearchUrlFromUserDates(flight, contextUser);
  flight.exactFlightLink = tpDeep || "";
  const pax = parseTripPassengers(contextUser || { persone: adults });
  flight.flightLink = aviasalesSearch || tpDeep || buildKiwiAffiliateSearchUrl(flight, pax, contextUser);
  flight.flightLinkSource = aviasalesSearch ? "aviasales_search" : tpDeep ? "travelpayouts" : "kiwi_search";
  flight.hotelLink = buildAviasalesHotelUrlFromFlight(flight, contextUser);
  flight.airHelpLink = affiliateAirHelpUrl();
  delete flight.providerLinkPath;
}

/** Prezzo unitario adulto (Travelpayouts = per persona, andata+ritorno). */
function flightPricePerPerson(flight) {
  const pp = Number(flight?.pricePerPerson);
  if (Number.isFinite(pp) && pp > 0) return pp;
  if (isTravelpayoutsFlightSource(flight?.priceSource)) return Number(flight?.price) || 0;
  return Number(flight?.price) || 0;
}

function flightPriceTotalForUser(flight, user) {
  const adults = extractAdultsForFlight(flight, user);
  if (isTravelpayoutsFlightSource(flight?.priceSource)) {
    return Math.round(flightPricePerPerson(flight) * adults);
  }
  const pp = Number(flight?.pricePerPerson);
  if (Number.isFinite(pp) && pp > 0) return Math.round(pp * adults);
  return Math.round(Number(flight?.price) || 0);
}

function normalizeFlightPricesForPassengers(flight, user) {
  const adults = hotelGuestCount(user);
  flight.passengersAdults = adults;
  const unit = flightPricePerPerson(flight);
  if (isTravelpayoutsFlightSource(flight.priceSource) || Number.isFinite(Number(flight.pricePerPerson))) {
    flight.pricePerPerson = Math.round(unit);
    flight.price = Math.round(unit * adults);
    return;
  }
  if (adults > 1 && unit > 0) {
    flight.pricePerPerson = Math.round(unit);
    flight.price = Math.round(unit * adults);
  }
}

function buildKlookHotelLinkFromFlight(flight, people, hotelName, cityHint) {
  return buildKlookHotelLink(
    { name: String(hotelName || "").trim(), googleDisplayName: "", googlePlaceMatched: false },
    flight,
    people,
    cityHint
  );
}

function flightOfferSignature(flight) {
  return `${String(flight.destinationCode || "").toUpperCase()}|${Number(flight.price)}|${String(
    flight.departDate || ""
  )}|${String(flight.returnDate || "")}`;
}

function buildThreeSlotsRotating(viable, startIdx) {
  const rot = [...viable.slice(startIdx), ...viable.slice(0, startIdx)];
  const slots = [];
  const seen = new Set();
  for (const v of rot) {
    const sig = flightOfferSignature(v.flight);
    if (seen.has(sig)) continue;
    seen.add(sig);
    slots.push(v);
    if (slots.length >= 3) break;
  }
  while (slots.length < 3) {
    slots.push(slots[0]);
  }
  return slots;
}

/** Fallback: obiettivo soggiorno da budget (stima), link Booking ricerca — quando Xotelo non trova 3 hotel. */
async function buildHotelOffersFromPlacesEstimate(user, slots, placeRows, destShort) {
  if (!Array.isArray(placeRows) || placeRows.length < 3) return null;
  const out = [];
  for (let i = 0; i < 3; i += 1) {
    const { flight, alloc } = slots[i];
    const place = placeRows[i];
    if (!place) return null;
    const kind = destinationKind(flight.destinationCode);
    const stayNights = stayNightsFromFlight(flight, user.durata);
    const stayVariant = Math.round(alloc.stayTarget);
    const pn = Math.max(1, Math.round(stayVariant / stayNights));
    let walkToCenterMin = 8;
    let walkToSeaMin = 10;
    if (place.formatted_address && getGoogleMapsKey()) {
      if (kind === "mare") {
        const [c, s] = await Promise.all([
          getWalkingMinutes(place.formatted_address, destShort),
          getWalkingMinutes(place.formatted_address, `${destShort} lungomare`),
        ]);
        walkToCenterMin = c;
        walkToSeaMin = s;
      } else {
        walkToCenterMin = await getWalkingMinutes(place.formatted_address, destShort);
        walkToSeaMin = walkToCenterMin;
      }
    } else {
      const w = mockWalkForKind(kind);
      walkToCenterMin = w.center;
      walkToSeaMin = w.sea;
    }
    out.push({
      slug: place.placeId || `place-${i}`,
      countryCode: "eu",
      roomType: user.tipo_camera || "Doppia",
      mealType: user.tipo_pasto || "Solo pernotto",
      structureType: "Hotel",
      name: place.name,
      rating: place.rating != null ? (Number(place.rating) * 2).toFixed(1) : "",
      walkToSeaMin,
      walkToCenterMin,
      price: stayVariant,
      stayNights,
      pricePerNightEstimate: pn,
      stayTotalEstimate: stayVariant,
      stayIsEstimate: true,
      priceSource: "estimate",
      stayBudgetMin: alloc.interval.min,
      stayBudgetMax: alloc.interval.max,
      stayAllocationEuro: stayVariant,
      photos: place.photoUrl ? [place.photoUrl] : [],
      bookingLink: buildKlookHotelLink(
        {
          name: place.name,
          googleDisplayName: place.name,
          googlePlaceMatched: true,
        },
        flight,
        user.persone,
        destShort
      ),
      googlePlaceId: place.placeId,
      formattedAddress: place.formatted_address || "",
    });
  }
  return out.length === 3 ? out : null;
}

async function buildCandidateFromFlight(flight, user, opts = {}) {
  const B = Number(user.budget);
  const relaxed = opts.relaxed === true;
  const requireQuoted = opts.requireQuoted === true;
  if (requireQuoted && flight.priceSource !== "travelpayouts") return null;

  normalizeFlightPricesForPassengers(flight, user);
  const fp = Number(flight.price);
  if (!Number.isFinite(fp) || fp <= 0) return null;

  const nights = stayNightsForOffer(flight, user);
  const fit = packageTripFitsBudget(B, fp, nights, flight.priceSource);
  const fitsPessimistic = fit.ok;
  if (!requireQuoted && !relaxed && !fitsPessimistic) {
    return null;
  }

  const fpReserved = fit.fpRes || flightPriceReservedForBudget(fp, flight.priceSource);
  const dates = stayDatesForOffer(flight, user);
  const hotelBudget = computeHotelBudgetFromTrip(B, fp, dates.checkIn, dates.checkOut);
  const quota = hotelBudget.hotelTotalBudget;
  const maxPerNight = hotelBudget.hotelMaxPerNight;
  const minHotel = fit.minHotel || minHotelStayBudget(nights);

  attachFlightAffiliateLinks(flight, user);
  if (!relaxed && !isBookableFlightLink(flight.flightLink)) return null;

  const destCity =
    sanitizeCityLabelForKlook(
      plainDestinationName(flight.destination) ||
        destinationLabelFromCode(flight.destinationCode) ||
        flight.destination
    ) || "Destinazione";

  let stayHotel = null;
  if (requireQuoted) {
    stayHotel = await fetchQuotedHotelForLive(flight, user, destCity, flight.destinationCode);
    if (!stayHotel) return null;
  } else {
    stayHotel = buildKlookSlotHotel(flight, destCity, user);
  }

  if (!relaxed && !isBookableHotelLink(stayHotel.bookingLink)) return null;
  const hotelBookingUrl = stayHotel.bookingLink;

  const hotelPrice = Math.round(Number(stayHotel.price) || 0);
  const pricesVerified =
    requireQuoted &&
    hotelPrice > 0 &&
    stayHotel.priceVerified !== false &&
    (stayHotel.priceSource === "amadeus" || stayHotel.priceSource === "xotelo");

  const prezzo_totale = pricesVerified ? packageQuotedTotal(fp, hotelPrice) : Math.round(fp);
  const worstCase = pricesVerified
    ? packageWorstCaseTotal(fp, hotelPrice, flight.priceSource)
    : fitsPessimistic && !relaxed
      ? fit.worstCaseEuro
      : fpReserved + hotelPriceReservedForBudget(quota);

  const withinBudget = pricesVerified
    ? prezzo_totale <= B
    : fitsPessimistic;

  if (requireQuoted && !withinBudget) return null;

  return {
    utente_id: user.id,
    flight,
    flights: [flight],
    hotels: [stayHotel, stayHotel, stayHotel],
    card_mode: pricesVerified ? "quoted_package" : "klook_single",
    destination_city: destCity,
    hotel_stay_quota: pricesVerified ? hotelPrice : quota,
    hotel_price_euro: hotelPrice,
    package_total_euro: prezzo_totale,
    hotel_max_per_night_euro: pricesVerified
      ? Math.max(1, Math.floor(hotelPrice / Math.max(1, nights)))
      : maxPerNight,
    aviasales_hotel_url: hotelBookingUrl,
    stay_nights: stayHotel.stayNights,
    prezzo_totale,
    risparmio: Math.max(0, Math.floor(B - prezzo_totale)),
    package_worst_case_euro: worstCase,
    budget_headroom_euro: Math.max(0, B - worstCase),
    stay_budget_min: minHotel,
    stay_budget_max: pricesVerified ? hotelPrice : quota,
    stay_allocation_euro: pricesVerified ? hotelPrice : quota,
    flight_price_euro: Math.round(fp),
    flight_price_reserved_euro: fpReserved,
    flight_price_is_indicative:
      !pricesVerified &&
      (flightPriceIsIndicative(flight.priceSource) || flight.priceSource === "estimate"),
    fits_budget_pessimistic: withinBudget,
    within_budget: withinBudget,
    package_floor_euro: Math.ceil(B * PACKAGE_MIN_RATIO),
    scade_il: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
    prices_verified: pricesVerified,
  };
}

async function findBestOfferCandidate(user, options = {}) {
  const alwaysOffer = options.alwaysOffer === true;
  const requireQuoted = options.requireQuoted === true;
  const B = Number(user.budget);
  let flightsRaw = await searchFlightsAzair(user, { allowEstimate: !requireQuoted && alwaysOffer });
  if (!flightsRaw.length) {
    const { code, label } = resolveLiveDestination(user);
    if (!requireQuoted && alwaysOffer) {
      const { departDate, returnDate } = resolveTravelDates(user);
      flightsRaw = buildEstimatedFlightOffers(user, code, label, departDate, returnDate);
    }
    if (!flightsRaw.length) {
      throw noFlightsFoundError(user, user.aeroporto_partenza, label);
    }
  }
  for (const f of flightsRaw) normalizeFlightPricesForPassengers(f, user);

  let flightsSorted = [...flightsRaw].sort((a, b) => Number(a.price) - Number(b.price));
  if (requireQuoted) {
    flightsSorted = flightsSorted.filter((f) => isTravelpayoutsFlightSource(f.priceSource));
    if (!flightsSorted.length) {
      throw quotedPackageUnavailableError(user);
    }
  }

  if (!alwaysOffer) {
    const nightsProbe = stayNightsForOffer(flightsSorted[0], user);
    const cheapestFp = Number(flightsSorted[0].price);
    const probeSource = flightsSorted[0].priceSource;
    const probeFit = packageTripFitsBudget(B, cheapestFp, nightsProbe, probeSource);
    if (Number.isFinite(cheapestFp) && !probeFit.ok) {
      throw budgetTooTightError(user, nightsProbe, cheapestFp, probeSource);
    }
  }

  for (const flight of flightsSorted) {
    const candidate = await buildCandidateFromFlight(flight, user, {
      relaxed: false,
      requireQuoted,
    });
    if (candidate) return candidate;
  }

  if (requireQuoted) {
    throw quotedPackageUnavailableError(user);
  }

  if (alwaysOffer) {
    let baseFlight = flightsSorted.find((f) => flightOfferWithinQuotedBudget(f, user)) || null;
    if (!baseFlight) {
      const { code, label } = resolveLiveDestination(user);
      const { departDate, returnDate } = resolveTravelDates(user);
      baseFlight = buildEstimatedFlightOffers(user, code, label, departDate, returnDate)[0];
    }
    if (baseFlight) {
      const relaxed = await buildCandidateFromFlight(baseFlight, user, { relaxed: true });
      if (relaxed) return relaxed;
    }
  }

  const fallback = flightsSorted[0];
  if (fallback && !alwaysOffer) {
    throw budgetTooTightError(
      user,
      stayNightsForOffer(fallback, user),
      Number(fallback.price),
      fallback.priceSource
    );
  }
  return null;
}

async function saveOffer(candidate) {
  const result = await run(
    `INSERT INTO offerte (
      utente_id, volo_json, hotel1_json, hotel2_json, hotel3_json,
      prezzo_totale, risparmio, scade_il, creato_il
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      candidate.utente_id,
      JSON.stringify(candidate.flight),
      JSON.stringify(candidate.hotels[0]),
      JSON.stringify(candidate.hotels[1]),
      JSON.stringify(candidate.hotels[2]),
      candidate.prezzo_totale,
      candidate.risparmio,
      candidate.scade_il,
      new Date().toISOString(),
    ]
  );

  return {
    id: result.lastID,
    utente_id: candidate.utente_id,
    volo_json: JSON.stringify(candidate.flight),
    hotel1_json: JSON.stringify(candidate.hotels[0]),
    hotel2_json: JSON.stringify(candidate.hotels[1]),
    hotel3_json: JSON.stringify(candidate.hotels[2]),
    prezzo_totale: candidate.prezzo_totale,
    risparmio: candidate.risparmio,
    scade_il: candidate.scade_il,
  };
}

function buildLivePackages(flights, hotels, budget) {
  const B = Math.max(0, Number(budget) || 0);
  const list = Array.isArray(flights) && flights.length ? flights : [];
  return hotels.slice(0, 3).map((h, idx) => {
    const flight = list[idx] || list[0];
    const fp = Math.round(Number(flight?.price) || 0);
    const hotelEuro = Math.round(Number(h.price) || 0);
    const total = packageQuotedTotal(fp, hotelEuro);
    const verified =
      (h.priceSource === "amadeus" || h.priceSource === "xotelo" || h.priceSource === "booking") &&
      h.priceVerified !== false;
    const budgetCheck = describePackageBudgetCheck(fp, hotelEuro, B, flight?.priceSource);
    const flightLink = String(flight?.flightLink || "").trim();
    const hotelLink = String(h.bookingLink || "").trim();
    const bookable = packageHasBookableLinks(flight, h);
    return {
      index: idx + 1,
      flight_price_euro: fp,
      hotel_price_euro: hotelEuro,
      package_total_euro: total,
      package_total_worst_case_euro: budgetCheck.package_total_worst_case_euro,
      budget_headroom_euro: budgetCheck.budget_headroom_euro,
      price_variance_allowance_euro: budgetCheck.price_variance_allowance_euro,
      budget_euro: B,
      within_budget: verified ? budgetCheck.within_budget : B <= 0 || total <= B,
      bookable,
      price_verified: verified,
      kiwi_link: flightLink,
      flight_link_source: String(flight?.flightLinkSource || "kiwi_search"),
      booking_link: hotelLink,
      air_help_link: String(flight?.airHelpLink || "").trim(),
      hotel: {
        name: h.name,
        googlePlaceMatched: !!h.googlePlaceMatched,
        googleDisplayName: h.googleDisplayName || "",
        rating: h.rating,
        photo: Array.isArray(h.photos) && h.photos[0] ? h.photos[0] : "",
        structureType: h.structureType,
        roomType: h.roomType,
        mealType: h.mealType,
        walkToCenterMin: h.walkToCenterMin,
        walkToSeaMin: h.walkToSeaMin,
        formattedAddress: h.formattedAddress || h.formatted_address || "",
        bestPriceLabel: h.bestPriceLabel || "",
        bestPriceProviderName: h.bestPriceProviderName || "",
        bookingProviderCode: h.bookingProviderCode || "",
        xoteloDisplayName: h.xoteloDisplayName || h.name || "",
        pricePerNightXotelo:
          h.pricePerNightXotelo != null ? Math.round(Number(h.pricePerNightXotelo)) : null,
        stayNights: h.stayNights != null ? h.stayNights : null,
        priceSource: h.priceSource || "",
      },
    };
  });
}

function assembleLivePreviewFromCandidate(payload, candidate) {
  if (!candidate?.flight) return null;
  const flight = candidate.flight;
  if (flight.priceSource === "mock") return null;

  const budgetNum = Number(payload.budget);
  const pax = hotelGuestCount(payload);
  normalizeFlightPricesForPassengers(flight, payload);
  const fp = Math.round(Number(candidate.flight_price_euro ?? flight.price) || 0);
  const fpPer = Math.round(Number(flight.pricePerPerson) || (pax > 1 ? fp / pax : fp) || 0);
  const fpReserved = Math.round(
    Number(candidate.flight_price_reserved_euro) ||
      flightPriceReservedForBudget(fp, flight.priceSource) ||
      0
  );
  const flightIndicative =
    candidate.flight_price_is_indicative !== false &&
    (flightPriceIsIndicative(flight.priceSource) || flight.priceSource === "estimate");
  const nights = Math.max(1, Number(candidate.stay_nights) || 1);
  const destCity = String(candidate.destination_city || "").trim();
  const stayDates = stayDatesForOffer(flight, payload);
  const hotelBudget = computeHotelBudgetFromTrip(
    budgetNum,
    fp,
    stayDates.checkIn,
    stayDates.checkOut
  );
  const pricesVerified = candidate.prices_verified === true;
  const hotelEuro = Math.round(
    Number(candidate.hotel_price_euro) ||
      (pricesVerified ? candidate.hotel_stay_quota : 0) ||
      Number(candidate.hotels?.[0]?.price) ||
      0
  );
  const quota = pricesVerified
    ? hotelEuro
    : Math.floor(Number(candidate.hotel_stay_quota) || hotelBudget.hotelTotalBudget);
  const packageTotal = pricesVerified
    ? Math.round(Number(candidate.package_total_euro) || packageQuotedTotal(fp, hotelEuro))
    : Math.min(budgetNum, hotelBudget.packagePlanTotal);
  const klookHotelDirectUrl =
    String(candidate.klook_hotel_direct_url || "").trim() ||
    (pricesVerified ? "" : buildKlookHotelSearchUrl({
      city: destCity,
      destIata: flight.destinationCode,
      checkIn: stayDates.checkIn,
      checkOut: stayDates.checkOut,
      adults: pax,
      currency: "EUR",
      maxPricePerNight: hotelBudget.hotelMaxPerNight,
      maxTotalPrice: hotelBudget.hotelTotalBudget,
    }));
  const klookHotelUrl =
    String(candidate.klook_hotel_url || "").trim() ||
    klookHotelDirectUrl ||
    "";
  const aviasalesHotelUrl =
    String(candidate.aviasales_hotel_url || "").trim() ||
    String(candidate.hotels?.[0]?.bookingLink || "").trim() ||
    String(flight.hotelLink || "").trim() ||
    buildAviasalesHotelUrlFromFlight(flight, payload);
  const maxPerNight =
    Math.floor(Number(candidate.hotel_max_per_night_euro)) ||
    (pricesVerified && nights > 0
      ? Math.max(1, Math.floor(hotelEuro / nights))
      : hotelBudget.hotelMaxPerNight);
  const refHotel = candidate.hotels?.[0] || {};

  const voloNote =
    flight.priceSource === "estimate"
      ? "prezzo da verificare su Aviasales"
      : "prezzo trovato su Aviasales";
  const worstClick = Math.round(
    Number(candidate.package_worst_case_euro) ||
      (pricesVerified
        ? packageWorstCaseTotal(fp, hotelEuro, flight.priceSource)
        : packageWorstCaseTotal(fp, quota, flight.priceSource)) ||
      0
  );
  const overrunLikely =
    (!pricesVerified && flight.priceSource === "estimate") ||
    (!pricesVerified &&
    (worstClick > budgetNum + 40 ||
      (isTravelpayoutsFlightSource(flight.priceSource) && fpReserved > budgetNum)));

  const budgetNote = pricesVerified
    ? `Pacchetto quotato €${packageTotal}: volo €${fp} + hotel €${hotelEuro} (${nights} notti)${refHotel.name ? ` · ${refHotel.name}` : ""}. Volo: ${voloNote} — conferma su Aviasales. Hotel: ${refHotel.bestPriceProviderName || "Amadeus/Xotelo"} verificato.`
    : flight.priceSource === "estimate"
      ? `Budget totale €${budgetNum}: il volo non ha un prezzo verificato, quindi la combinazione non è garantita. Verifica prima il totale volo su Aviasales; Klook viene filtrato solo come quota indicativa.`
      : `Volo trovato su Aviasales a circa €${fp}. Non mostriamo prezzi hotel senza verifica Xotelo/Amadeus: apri Aviasales Hotels con date e destinazione già impostate.`;

  return {
    card_mode: pricesVerified ? "quoted_package" : "klook_single",
    prezzo_totale: pricesVerified ? packageTotal : candidate.prezzo_totale,
    risparmio: candidate.risparmio,
    partenza: payload.aeroporto_partenza,
    budget: budgetNum,
    persone: String(payload.persone || "2"),
    passengers_count: pax,
    flight_price_per_person_euro: fpPer,
    flight,
    destination_city: destCity,
    hotel_stay_quota: quota,
    hotel_price_euro: hotelEuro,
    package_total_euro: packageTotal,
    stay_nights: nights,
    requested_check_in: stayDates.checkIn,
    requested_check_out: stayDates.checkOut,
    hotel_primary_url: aviasalesHotelUrl,
    klook_hotel_url: klookHotelUrl,
    klook_hotel_direct_url: klookHotelDirectUrl,
    klook_hotel_direct_url_template: klookHotelDirectUrl,
    klook_hotel_base_url: klookHotelDirectUrl,
    aviasales_hotel_url: aviasalesHotelUrl,
    hotel_search_mode: pricesVerified ? "quoted_amadeus_xotelo" : "aviasales_hotels_link",
    hotels: candidate.hotels,
    packages: [],
    stay_budget_min: Math.round(Number(candidate.stay_budget_min) || 0),
    stay_budget_max: quota,
    stay_allocation_euro: quota,
    hotel_budget_total_euro: hotelBudget.hotelTotalBudget,
    hotel_budget_max_per_night_euro: hotelBudget.hotelMaxPerNight,
    package_floor_euro: candidate.package_floor_euro,
    flight_price_euro: fp,
    flight_price_reserved_euro: fpReserved,
    flight_price_is_indicative: pricesVerified ? isTravelpayoutsFlightSource(flight.priceSource) : flightIndicative,
    fits_budget_pessimistic: candidate.fits_budget_pessimistic === true,
    within_budget: candidate.within_budget === true,
    package_worst_case_euro: candidate.package_worst_case_euro,
    budget_headroom_euro: candidate.budget_headroom_euro,
    price_quoted_at: new Date().toISOString(),
    budget_verification_note: budgetNote,
    stay_pricing_disclaimer: pricesVerified
      ? `Prezzi trovati ora: volo da Aviasales e hotel da ${refHotel.bestPriceProviderName || (refHotel.priceSource === "xotelo" ? "Xotelo" : "fornitore verificato")}. Verifica il totale prima di prenotare.`
      : flight.priceSource === "estimate"
        ? `Prezzo volo non verificato dal feed: prima apri Aviasales. Klook è filtrato in modo indicativo entro circa €${hotelBudget.hotelMaxPerNight}/notte, ma la combinazione vale solo se il volo reale lascia budget residuo.`
        : `Nessun prezzo hotel verificato da Xotelo/Amadeus: apriamo Aviasales Hotels con destinazione e date già impostate, senza mostrare prezzi hotel inventati.`,
    prices_verified: pricesVerified,
    hotel_price_verified: pricesVerified,
    offer_is_estimate: !pricesVerified && flight.priceSource === "estimate",
    package_plan_total_euro: packageTotal,
    budget_overrun_likely: overrunLikely,
    hotel_max_per_night_euro: maxPerNight,
  };
}

function buildEmergencyLivePreview(payload) {
  return null;
}

function buildAviasalesHotelSearchCandidate(flight, user) {
  const B = Math.max(0, Number(user.budget) || 0);
  normalizeFlightPricesForPassengers(flight, user);
  const fp = Math.round(Number(flight.price) || 0);
  if (!isTravelpayoutsFlightSource(flight.priceSource) || !Number.isFinite(fp) || fp <= 0) return null;

  attachFlightAffiliateLinks(flight, user);
  const nights = stayNightsForOffer(flight, user);
  const dates = stayDatesForOffer(flight, user);
  const destCity =
    sanitizeCityLabelForKlook(
      plainDestinationName(user.destinazione_preferita) ||
        plainDestinationName(flight.destination) ||
        destinationLabelFromCode(flight.destinationCode) ||
        flight.destination
    ) || "Destinazione";
  const hotelSearchUrl = buildAviasalesHotelUrlFromFlight(flight, user);
  const stayHotel = {
    slug: `aviasales-hotels-${sanitizeIata3(flight.destinationCode) || "city"}`,
    name: `Hotel a ${destCity}`,
    price: 0,
    stayNights: nights,
    priceSource: "aviasales_hotels_link",
    priceVerified: false,
    bookingLink: hotelSearchUrl,
    directBookingLink: hotelSearchUrl,
    photos: [],
    structureType: "Hotel",
    roomType: user.tipo_camera || "Doppia",
    mealType: user.tipo_pasto || "Solo pernotto",
  };

  return {
    utente_id: user.id,
    flight,
    flights: [flight],
    hotels: [stayHotel, stayHotel, stayHotel],
    card_mode: "hotel_search",
    destination_city: destCity,
    hotel_stay_quota: 0,
    hotel_price_euro: 0,
    package_total_euro: fp,
    hotel_max_per_night_euro: 0,
    requested_check_in: dates.checkIn,
    requested_check_out: dates.checkOut,
    aviasales_hotel_url: hotelSearchUrl,
    stay_nights: nights,
    prezzo_totale: fp,
    risparmio: Math.max(0, Math.floor(B - fp)),
    package_worst_case_euro: fp,
    budget_headroom_euro: Math.max(0, B - fp),
    stay_budget_min: 0,
    stay_budget_max: 0,
    stay_allocation_euro: 0,
    hotel_budget_total_euro: Math.max(0, B - fp),
    hotel_budget_max_per_night_euro: 0,
    flight_price_euro: fp,
    flight_price_reserved_euro: fp,
    flight_price_is_indicative: false,
    fits_budget_pessimistic: false,
    within_budget: false,
    package_floor_euro: Math.ceil(B * PACKAGE_MIN_RATIO),
    scade_il: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
    prices_verified: false,
    hotel_price_verified: false,
  };
}

function buildManualKiwiFlightUrl({ from, to, departure, returnDate, user, applySearchFilters = true }) {
  const origin = sanitizeIata3(from);
  const destination = sanitizeIata3(to);
  if (!origin || !destination || !isIsoDate(departure) || !isIsoDate(returnDate)) return "";

  const pax = parseTripPassengers(user || {});
  const flight = {
    from: origin,
    destinationCode: destination,
    departDate: departure,
    returnDate,
    destination: destinationLabelFromCode(destination),
  };

  let kiwiUrl =
    buildKiwiSearchResultsUrl(flight, pax) || buildKiwiDirectSearchUrl(flight, pax);

  if (!kiwiUrl) {
    const kiwi = new URL("https://www.kiwi.com/deep");
    kiwi.searchParams.set("from", origin);
    kiwi.searchParams.set("to", destination);
    kiwi.searchParams.set("departure", departure);
    kiwi.searchParams.set("return", returnDate);
    kiwiUrl = kiwi.toString();
  }

  if (applySearchFilters === "hand_only") {
    kiwiUrl = applyKiwiSearchOptions(kiwiUrl, user || {}, { handBaggageOnly: true });
  } else if (applySearchFilters !== false) {
    kiwiUrl = applyKiwiSearchOptions(kiwiUrl, user || {});
  }

  const link = new URL("https://c111.travelpayouts.com/click");
  link.searchParams.set("shmarker", process.env.TRAVELPAYOUTS_MARKER || "725780");
  link.searchParams.set("promo_id", "3791");
  link.searchParams.set("source_type", "customlink");
  link.searchParams.set("type", "click");
  link.searchParams.set("custom_url", kiwiUrl);
  return link.toString();
}

function buildTravelpayoutsKiwiManualUrl(opts) {
  return buildManualKiwiFlightUrl(opts);
}

function buildManualKlookListUrlTemplate({ city, checkIn, checkOut, adults, child_num, age, destIata }) {
  const iata3 = sanitizeIata3(destIata);
  const cityHint =
    plainDestinationName(city) || destinationLabelFromCode(iata3) || String(city || iata3 || "");
  const cityLabel = klookSearchCityLabel(iata3, cityHint) || "Destination";
  return (
    buildKlookHotelSearchUrl({
      city: cityLabel,
      destIata,
      checkIn,
      checkOut,
      adults,
      child_num,
      age,
      currency: "EUR",
    }) || ""
  );
}

function buildManualKlookAffiliateUrlTemplate(directTemplate) {
  const direct = String(directTemplate || "").trim();
  if (!direct) return "";
  return direct;
}

async function buildManualKiwiKlookPreview(payload) {
  const user = { ...payload };
  const surprise = isSurpriseSearch(user);
  let surprisePick = null;
  if (surprise) {
    surprisePick = await pickSurpriseDestination(user);
    user.destinazione_preferita = surprisePick.label;
    user.destinazione_iata = surprisePick.code;
  }
  const { code: destCode, label: destLabel } = resolveLiveDestination(user);
  const { departDate, returnDate } = resolveTravelDates(user);
  const origin =
    sanitizeIata3(resolveFlightOriginCodes(user.aeroporto_partenza)[0]) ||
    sanitizeIata3(user.aeroporto_partenza);
  const destination = sanitizeIata3(destCode || user.destinazione_iata);
  if (!origin || !destination) {
    const err = new Error("Partenza o destinazione non riconosciuta. Scegli un aeroporto dai suggerimenti.");
    err.code = "DESTINATION_UNSUPPORTED";
    throw err;
  }
  const pax = parseTripPassengers(user);
  const klookGuests = klookGuestParams(user);
  const nights = stayNightsBetweenIsoDates(departDate, returnDate);
  const destinationCityIt =
    plainDestinationName(destLabel) || destinationLabelFromCode(destination) || destLabel || destination;
  const klookCityLabel = klookSearchCityLabel(destination, destinationCityIt);
  const kiwiUrl = buildManualKiwiFlightUrl({
    from: origin,
    to: destination,
    departure: departDate,
    returnDate,
    user,
    applySearchFilters: surprise ? "hand_only" : true,
  });
  const klookPage = resolveKlookCityPage(destination, klookCityLabel);
  const klookDirectTemplate = buildManualKlookListUrlTemplate({
    city: klookCityLabel,
    destIata: destination,
    checkIn: departDate,
    checkOut: returnDate,
    adults: klookGuests.adults,
    child_num: klookGuests.child_num,
    age: klookGuests.age,
  });
  const klookTemplate = buildManualKlookAffiliateUrlTemplate(klookDirectTemplate);
  const flight = {
    from: origin,
    fromName: origin,
    destination: destinationCityIt,
    destinationCode: destination,
    klookCityLabel,
    departDate,
    returnDate,
    passengersAdults: pax.adults,
    passengersChildren: pax.children,
    passengersInfants: pax.infants,
    priceSource: "manual_kiwi",
    flightLink: kiwiUrl,
    flightLinkSource: "kiwi_manual",
    airHelpLink: affiliateAirHelpUrl(),
  };
  const preview = {
    card_mode: "manual_kiwi_klook",
    partenza: origin,
    budget: Math.max(0, Number(user.budget) || 0),
    persone: String(user.persone || pax.adults),
    passengers: pax,
    passengers_count: totalTripGuests(user),
    passengers_summary: passengerSummaryIt(user),
    solo_voli_diretti: surprise ? 0 : getSoloVoliDiretti(user) ? 1 : 0,
    bagaglio: surprise ? "Solo cabina" : String(user.bagaglio || "Solo cabina"),
    kiwi_filters_applied: 1,
    destinazione_sorpresa: surprise ? 1 : 0,
    surprise_destination: surprise
      ? {
          label: destinationCityIt,
          klook_label: klookCityLabel,
          iata: destination,
          origin_iata: resolveSurpriseOrigin(user),
          world_region: surpriseWorldRegion(destination),
          pick_source: surprisePick?.pick_source || "random",
          budget_estimate: estimateSurprisePackageTotal(
            user,
            { label: destinationCityIt, iata: destination },
            null
          ),
        }
      : null,
    flight,
    destination_city: destinationCityIt,
    klook_city_label: klookCityLabel,
    requested_check_in: departDate,
    requested_check_out: returnDate,
    stay_nights: nights,
    kiwi_flight_url: kiwiUrl,
    klook_hotel_url_template: klookTemplate,
    klook_hotel_direct_url_template: klookDirectTemplate,
    klook_hotel_base_url: klookDirectTemplate,
    klook_city_page_slug: klookPage?.kind === "city" ? String(klookPage.slug || "") : "",
    klook_destination_page_slug:
      klookPage?.kind === "destination" ? String(klookPage.slug || "") : "",
    prices_verified: false,
    flight_price_euro: 0,
    hotel_price_euro: 0,
    hotel_stay_quota: 0,
    stay_pricing_disclaimer:
      "Cerca il volo su Kiwi, inserisci il prezzo totale trovato, poi Partiamo calcola il budget hotel residuo e apre Klook filtrato.",
  };
  return repairKlookPreviewTemplates(preview);
}

/**
 * Pacchetto live minimo: volo + link hotel Klook + budget hotel = budget − volo.
 * Non chiama Xotelo/Amadeus; non blocca se manca un prezzo hotel.
 */
function buildSimpleLiveCandidate(flight, user) {
  const B = Math.max(0, Number(user.budget) || 0);
  normalizeFlightPricesForPassengers(flight, user);
  const fp = Math.round(Number(flight.price) || 0);
  if (!Number.isFinite(fp) || fp <= 0) return null;

  attachFlightAffiliateLinks(flight, user);
  const nights = stayNightsForOffer(flight, user);
  const dates = stayDatesForOffer(flight, user);
  const hotelBudget = computeHotelBudgetFromTrip(B, fp, dates.checkIn, dates.checkOut);
  const quota = hotelBudget.hotelTotalBudget;
  const maxPerNight = hotelBudget.hotelMaxPerNight;

  const destCity =
    sanitizeCityLabelForKlook(
      plainDestinationName(user.destinazione_preferita) ||
        plainDestinationName(flight.destination) ||
        destinationLabelFromCode(flight.destinationCode) ||
        flight.destination
    ) || "Destinazione";

  const guests = hotelGuestCount(user);
  const klookHotelDirectUrl = buildKlookHotelSearchUrl({
    city: destCity,
    destIata: flight.destinationCode || user.destinazione_iata,
    checkIn: dates.checkIn,
    checkOut: dates.checkOut,
    adults: guests,
    currency: "EUR",
    maxPricePerNight: maxPerNight,
    maxTotalPrice: quota,
  });
  const klookHotelUrl = klookHotelDirectUrl;
  const aviasalesHotelUrl = buildAviasalesHotelUrlFromFlight(flight, user);

  const stayHotel = {
    slug: `klook-${sanitizeIata3(flight.destinationCode) || "city"}`,
    name: destCity ? `Alloggio a ${destCity}` : "Alloggio in destinazione",
    price: quota,
    stayNights: nights,
    priceSource: "klook",
    priceVerified: false,
    bookingLink: klookHotelUrl,
    directBookingLink: klookHotelDirectUrl,
    photos: [],
    structureType: "Hotel",
    roomType: user.tipo_camera || "Doppia",
    mealType: user.tipo_pasto || "Solo pernotto",
  };

  return {
    utente_id: user.id,
    flight,
    flights: [flight],
    hotels: [stayHotel, stayHotel, stayHotel],
    card_mode: "klook_single",
    destination_city: destCity,
    hotel_stay_quota: quota,
    hotel_price_euro: 0,
    package_total_euro: Math.min(B, hotelBudget.packagePlanTotal),
    hotel_max_per_night_euro: maxPerNight,
    requested_check_in: dates.checkIn,
    requested_check_out: dates.checkOut,
    klook_hotel_url: klookHotelUrl,
    klook_hotel_direct_url: klookHotelDirectUrl,
    aviasales_hotel_url: aviasalesHotelUrl,
    stay_nights: nights,
    prezzo_totale: Math.round(fp),
    risparmio: Math.max(0, Math.floor(B - fp)),
    package_worst_case_euro: Math.round(fp + quota),
    budget_headroom_euro: Math.max(0, B - fp - quota),
    stay_budget_min: minHotelStayBudget(nights),
    stay_budget_max: quota,
    stay_allocation_euro: quota,
    hotel_budget_total_euro: quota,
    hotel_budget_max_per_night_euro: maxPerNight,
    flight_price_euro: fp,
    flight_price_reserved_euro: flightPriceReservedForBudget(fp, flight.priceSource),
    flight_price_is_indicative: flightPriceIsIndicative(flight.priceSource) || flight.priceSource === "estimate",
    fits_budget_pessimistic: flight.priceSource === "estimate" ? false : fp <= B,
    within_budget: flight.priceSource === "estimate" ? false : fp <= B,
    package_floor_euro: Math.ceil(B * PACKAGE_MIN_RATIO),
    scade_il: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
    prices_verified: false,
  };
}

/**
 * Ricerca live (home): solo voli Travelpayouts reali.
 * Hotel: prezzo solo se verificato da Xotelo/Amadeus, altrimenti link Aviasales Hotels senza prezzo.
 */
async function getLiveSearchPreview(payload) {
  return buildManualKiwiKlookPreview(payload);
}

async function processUserForOffers(user) {
  const lastNotifiedAt = user.ultima_notifica ? new Date(user.ultima_notifica).getTime() : 0;
  if (Date.now() - lastNotifiedAt < 24 * 60 * 60 * 1000) return;

  const candidate = await findBestOfferCandidate(user);
  if (!candidate) return;

  if (user.prezzo_riferimento && candidate.prezzo_totale >= Number(user.prezzo_riferimento)) {
    return;
  }

  const offer = await saveOffer(candidate);

  await sendOfferEmail({ user, offer });
  await run("UPDATE utenti SET ultima_notifica = ?, prezzo_riferimento = ? WHERE id = ?", [
    new Date().toISOString(),
    offer.prezzo_totale,
    user.id,
  ]);
}

module.exports = {
  getLiveSearchPreview,
  processUserForOffers,
  attachFlightAffiliateLinks,
  buildKlookAffiliateHotelUrl,
  buildKlookHotelLink,
  computeHotelBudgetFromTrip,
  getAmadeusToken,
  searchHotelsAmadeus,
  searchHotelsAmadeusForSlots,
  isAmadeusConfigured,
  searchHotelsGoogleLive,
  searchHotelsXotelo,
};
