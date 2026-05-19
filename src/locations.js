/**
 * Ricerca località stile Kiwi: città (tutti gli aeroporti) + ogni aeroporto elencato sotto.
 */
const { searchAirports, getAirportByIata, foldAscii, formatAirportLabel } = require("./airports");

/** Metro note a mano (priorità su raggruppamento automatico). */
const METRO_AREAS = {
  ROM: { label: "Roma, Italia", airports: ["FCO", "CIA"], primary: "FCO" },
  MIL: { label: "Milano, Italia", airports: ["MXP", "LIN", "BGY"], primary: "MXP" },
  NAP: { label: "Napoli, Italia", airports: ["NAP"], primary: "NAP" },
  VCE: { label: "Venezia, Italia", airports: ["VCE", "TSF"], primary: "VCE" },
  PAR: { label: "Parigi, Francia", airports: ["CDG", "ORY", "BVA"], primary: "CDG" },
  LON: { label: "Londra, Regno Unito", airports: ["LHR", "LGW", "STN", "LTN", "LCY"], primary: "LHR" },
  NYC: { label: "New York, Stati Uniti", airports: ["JFK", "EWR", "LGA"], primary: "JFK" },
  BCN: { label: "Barcellona, Spagna", airports: ["BCN"], primary: "BCN" },
  MAD: { label: "Madrid, Spagna", airports: ["MAD"], primary: "MAD" },
  LIS: { label: "Lisbona, Portogallo", airports: ["LIS"], primary: "LIS" },
  AMS: { label: "Amsterdam, Paesi Bassi", airports: ["AMS"], primary: "AMS" },
  BER: { label: "Berlino, Germania", airports: ["BER", "SXF"], primary: "BER" },
  MUC: { label: "Monaco di Baviera, Germania", airports: ["MUC"], primary: "MUC" },
  VIE: { label: "Vienna, Austria", airports: ["VIE"], primary: "VIE" },
  ZRH: { label: "Zurigo, Svizzera", airports: ["ZRH"], primary: "ZRH" },
  ATH: { label: "Atene, Grecia", airports: ["ATH"], primary: "ATH" },
  IST: { label: "Istanbul, Turchia", airports: ["IST", "SAW"], primary: "IST" },
  DXB: { label: "Dubai, Emirati Arabi", airports: ["DXB", "DWC"], primary: "DXB" },
  TYO: { label: "Tokyo, Giappone", airports: ["NRT", "HND"], primary: "NRT" },
  BKK: { label: "Bangkok, Thailandia", airports: ["BKK", "DMK"], primary: "BKK" },
  SIN: { label: "Singapore", airports: ["SIN"], primary: "SIN" },
  SYD: { label: "Sydney, Australia", airports: ["SYD"], primary: "SYD" },
  MOW: { label: "Mosca, Russia", airports: ["SVO", "DME", "VKO"], primary: "SVO" },
  BUE: { label: "Buenos Aires, Argentina", airports: ["EZE", "AEP"], primary: "EZE" },
};

/** Ricerca in italiano → termine OpenFlights. */
const QUERY_ALIASES = {
  cipro: "cyprus",
  cyprus: "cipro",
  mosca: "moscow",
  moscu: "moscow",
  pechino: "beijing",
  beijing: "pechino",
  munich: "munich",
  monaco: "munich",
  zurigo: "zurich",
  zurich: "zurich",
  lisbona: "lisbon",
  lisbon: "lisbon",
  atene: "athens",
  athens: "athens",
  istanbul: "istanbul",
  dubai: "dubai",
  tokyo: "tokyo",
  tokio: "tokyo",
};

const MAX_AIRPORTS_PER_CITY = 8;

const ITALIAN_CITY_PRIMARY = {
  rome: "FCO",
  roma: "FCO",
  milan: "MXP",
  milano: "MXP",
  naples: "NAP",
  napoli: "NAP",
  venice: "VCE",
  venezia: "VCE",
  florence: "FLR",
  firenze: "FLR",
};

let cityGroupsCache = null;
let metroByAirportCache = null;

function countryIt(country) {
  const map = {
    Italy: "Italia",
    France: "Francia",
    Spain: "Spagna",
    Portugal: "Portogallo",
    Germany: "Germania",
    "United Kingdom": "Regno Unito",
    Greece: "Grecia",
    Turkey: "Turchia",
    Cyprus: "Cipro",
    Netherlands: "Paesi Bassi",
    Switzerland: "Svizzera",
    Austria: "Austria",
    "United States": "Stati Uniti",
    Japan: "Giappone",
    Thailand: "Thailandia",
    Australia: "Australia",
    "United Arab Emirates": "Emirati Arabi",
    Russia: "Russia",
    Argentina: "Argentina",
  };
  return map[country] || country || "";
}

function cityCountryLabel(city, country) {
  const c = String(city || "").trim();
  const co = countryIt(country);
  if (c && co) return `${c}, ${co}`;
  return c || co || "";
}

function isValidCityName(city) {
  const c = String(city || "").trim();
  if (c.length < 2) return false;
  if (!/[a-zA-Z]/.test(c)) return false;
  return true;
}

function rankAirportRecord(a) {
  let score = 0;
  const name = foldAscii(a.name);
  if (name.includes("international")) score += 12;
  if (name.includes("airport") && !name.includes("heliport") && !name.includes("seaplane")) score += 4;
  if (name.includes("air force") || name.includes("army") || name.includes("raf ")) score -= 8;
  return score;
}

/** Evita elenchi enormi da dati OpenFlights incompleti: max 8 hub per città. */
function capAirportCodes(airports, max = MAX_AIRPORTS_PER_CITY) {
  const sorted = [...airports].sort(
    (a, b) => rankAirportRecord(b) - rankAirportRecord(a) || a.iata.localeCompare(b.iata)
  );
  return [...new Set(sorted.map((a) => a.iata))].slice(0, max);
}

function pickPrimaryAirport(airports) {
  const codes = airports.map((a) => a.iata);
  const cityKey = foldAscii(airports[0]?.city);
  const preferred = ITALIAN_CITY_PRIMARY[cityKey];
  if (preferred && codes.includes(preferred)) return preferred;
  const best = [...airports].sort((a, b) => rankAirportRecord(b) - rankAirportRecord(a))[0];
  return best?.iata || codes.sort()[0];
}

function expandSearchQuery(query) {
  const q = foldAscii(query);
  return QUERY_ALIASES[q] || query;
}

/** Tutte le città con 2+ aeroporti (da OpenFlights) + metro manuali. */
function getAllCityGroups() {
  if (cityGroupsCache) return cityGroupsCache;

  const list = require("./airports-data.json");
  const buckets = new Map();
  for (const a of list) {
    if (!a.iata || !/^[A-Z]{3}$/.test(a.iata)) continue;
    if (!isValidCityName(a.city)) continue;
    const key = `${foldAscii(a.city)}|${foldAscii(a.country)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(a);
  }

  const groups = {};
  for (const [, airports] of buckets) {
    const codes = capAirportCodes(airports);
    if (codes.length < 2) continue;
    const sample = airports[0];
    const key = `${foldAscii(sample.city)}|${foldAscii(sample.country)}`;
    const capped = airports.filter((a) => codes.includes(a.iata));
    groups[key] = {
      label: cityCountryLabel(sample.city, sample.country),
      airports: codes,
      primary: pickPrimaryAirport(capped),
      cityKey: key,
    };
  }

  for (const [metro, def] of Object.entries(METRO_AREAS)) {
    if (def.airports.length < 2) continue;
    const sample = getAirportByIata(def.primary || def.airports[0]);
    const key = sample
      ? `${foldAscii(sample.city)}|${foldAscii(sample.country)}`
      : `metro:${metro}`;
    groups[key] = {
      label: def.label,
      airports: [...def.airports],
      primary: def.primary || def.airports[0],
      metro,
      cityKey: key,
    };
  }

  cityGroupsCache = groups;
  return groups;
}

function getMetroByAirport() {
  if (metroByAirportCache) return metroByAirportCache;
  const map = {};
  for (const def of Object.values(getAllCityGroups())) {
    for (const ap of def.airports) map[ap] = def;
  }
  metroByAirportCache = map;
  return map;
}

function groupMatchesQuery(def, q) {
  if (!q) return false;
  const labelF = foldAscii(def.label);
  if (labelF.startsWith(q) || labelF === q) return true;
  for (const code of def.airports) {
    const codeF = foldAscii(code);
    if (codeF === q || codeF.startsWith(q)) return true;
    const hit = getAirportByIata(code);
    if (!hit) continue;
    if ((q === "roma" || q === "rome") && foldAscii(hit.country) === "romania") continue;
    const cityF = foldAscii(hit.city);
    const nameF = foldAscii(hit.name);
    const countryItF = foldAscii(countryIt(hit.country));
    if (cityF === q || cityF.startsWith(q)) return true;
    if (nameF.startsWith(q)) return true;
    if (countryItF === q || (q.length >= 4 && countryItF.startsWith(q))) return true;
  }
  return false;
}

function scoreAirportForQuery(a, q) {
  if (!q) return 50;
  let s = 100;
  const iataL = a.iata.toLowerCase();
  const cityF = foldAscii(a.city);
  const nameF = foldAscii(a.name);
  const countryF = foldAscii(a.country);
  const countryItF = foldAscii(countryIt(a.country));
  const labelF = foldAscii(`${a.city} ${countryIt(a.country)}`);
  if (iataL === q) s = 0;
  else if (cityF === q || countryF === q || countryItF === q || labelF.includes(q)) s = 1;
  else if (cityF.startsWith(q) || countryItF.startsWith(q)) s = 2;
  else if (nameF.startsWith(q) || iataL.startsWith(q)) s = 3;
  else if (cityF.includes(q) || nameF.includes(q)) s = 5;
  else if (countryItF === q || (q.length >= 4 && countryItF.startsWith(q))) s = 4;
  else if (q.length >= 5 && countryF.includes(q)) s = 6;
  return s;
}

function airportItem(hit, score) {
  const ap = typeof hit === "string" ? getAirportByIata(hit) : hit;
  if (!ap) return null;
  const co = countryIt(ap.country);
  return {
    type: "airport",
    iata: ap.iata,
    code: ap.iata,
    title: ap.name || formatAirportLabel(ap),
    subtitle: co ? `${ap.city || ""}${ap.city ? ", " : ""}${co}`.replace(/^,\s*/, "") : ap.city || "",
    score,
  };
}

function cityItem(def, score) {
  const codes = def.airports;
  return {
    type: "city",
    kind: def.metro ? "metro" : "city",
    iata: def.primary,
    metro: def.metro,
    code: def.metro || def.primary,
    title: def.label,
    subtitle: `Tutti gli aeroporti · ${codes.join(", ")}`,
    airports: codes,
    score,
  };
}

function pushCityWithAirports(items, listed, def, score) {
  const codes = [...new Set(def.airports)];
  const normalized = { ...def, airports: codes };
  items.push(cityItem(normalized, score));
  let i = 0;
  for (const code of codes) {
    if (listed.has(code)) continue;
    const item = airportItem(code, score + 1 + i * 0.01);
    if (!item) continue;
    listed.add(code);
    items.push(item);
    i += 1;
  }
}

const POPULAR_ON_EMPTY = ["ROM", "MIL", "NAP", "VCE", "PAR", "LON", "BCN", "FCO", "CIA", "MXP", "LIN", "BGY"];

/**
 * @returns {{ type: 'city'|'airport'|'destination', iata: string, title: string, subtitle: string, code: string }[]}
 */
function searchLocations(query, { limit = 18, partiamoDestinations = [], scope = "" } = {}) {
  const cap = Math.max(1, Math.min(500, Number(limit) || 18));
  const scopeNorm = String(scope || "").toLowerCase();
  const q = foldAscii(query);
  const airportQuery = expandSearchQuery(query);
  const items = [];
  const listed = new Set();
  const matchedGroups = new Set();

  if (!q) {
    const groups = getAllCityGroups();
    for (const metroKey of ["ROM", "MIL", "NAP", "VCE", "PAR", "LON", "BCN"]) {
      const def = Object.values(groups).find((g) => g.metro === metroKey);
      if (def && def.airports.length >= 2) {
        pushCityWithAirports(items, listed, def, 1);
        matchedGroups.add(def.cityKey);
      }
    }
    for (const code of POPULAR_ON_EMPTY) {
      if (listed.has(code)) continue;
      const item = airportItem(code, 20);
      if (item) {
        listed.add(code);
        items.push(item);
      }
    }
    if (scopeNorm === "from") {
      const italianAirports = require("./airports-data.json");
      for (const ap of italianAirports) {
        const countryF = foldAscii(ap.country);
        if (countryF !== "italy" && countryF !== "italia") continue;
        if (listed.has(ap.iata)) continue;
        const item = airportItem(ap, 25);
        if (!item) continue;
        listed.add(ap.iata);
        items.push(item);
      }
    }
    if (scopeNorm === "to" && Array.isArray(partiamoDestinations) && partiamoDestinations.length) {
      const sortedDest = [...partiamoDestinations].sort((a, b) =>
        String(a.label || "").localeCompare(String(b.label || ""), "it")
      );
      for (const d of sortedDest) {
        if (!d?.iata || listed.has(d.iata)) continue;
        listed.add(d.iata);
        items.push({
          type: "destination",
          iata: d.iata,
          code: d.iata,
          title: d.label,
          subtitle: "Destinazione Partiamo",
          score: 30,
        });
      }
    }
  }

  if (q === "cipro" || q === "cyprus") {
    const cyp = { label: "Cipro", airports: ["LCA", "PFO"], primary: "LCA", metro: "CYP", cityKey: "cipro" };
    pushCityWithAirports(items, listed, cyp, 0);
    matchedGroups.add("cipro");
  }

  for (const def of Object.values(getAllCityGroups())) {
    if (def.airports.length < 2) continue;
    if (!q) continue;
    if (!groupMatchesQuery(def, q)) continue;
    if (matchedGroups.has(def.cityKey)) continue;
    matchedGroups.add(def.cityKey);
    pushCityWithAirports(items, listed, def, 0);
  }

  const airportHits = searchAirports(airportQuery, 30);
  const cityBuckets = new Map();

  for (const hit of airportHits) {
    if (listed.has(hit.iata)) continue;
    const metroDef = getMetroByAirport()[hit.iata];
    if (metroDef && matchedGroups.has(metroDef.cityKey)) continue;

    const score = scoreAirportForQuery(hit, q);
    if (q && score >= 100) continue;

    const key = `${foldAscii(hit.city)}|${foldAscii(hit.country)}`;
    if (matchedGroups.has(key)) continue;

    if (!cityBuckets.has(key)) {
      cityBuckets.set(key, { city: hit.city, country: hit.country, airports: [], bestScore: score });
    }
    const bucket = cityBuckets.get(key);
    bucket.airports.push(hit);
    bucket.bestScore = Math.min(bucket.bestScore, score);
  }

  for (const bucket of cityBuckets.values()) {
    if (bucket.airports.length < 2) continue;
    const codes = [...new Set(bucket.airports.map((a) => a.iata))];
    const def = {
      label: cityCountryLabel(bucket.city, bucket.country),
      airports: codes,
      primary: pickPrimaryAirport(bucket.airports),
      cityKey: `${foldAscii(bucket.city)}|${foldAscii(bucket.country)}`,
    };
    pushCityWithAirports(items, listed, def, bucket.bestScore);
    matchedGroups.add(def.cityKey);
  }

  for (const hit of airportHits) {
    if (listed.has(hit.iata)) continue;
    const score = scoreAirportForQuery(hit, q);
    if (q && score >= 100) continue;
    const item = airportItem(hit, score + 10);
    if (!item) continue;
    listed.add(hit.iata);
    items.push(item);
  }

  if (q && Array.isArray(partiamoDestinations) && partiamoDestinations.length) {
    for (const d of partiamoDestinations) {
      if (listed.has(d.iata)) continue;
      const labelF = foldAscii(d.label);
      const iataL = (d.iata || "").toLowerCase();
      let match = false;
      if (iataL === q) match = true;
      else if (labelF.startsWith(q) || labelF.includes(q)) match = true;
      else if ((d.aliases || []).some((a) => foldAscii(a).includes(q))) match = true;
      if (!match) continue;
      listed.add(d.iata);
      items.push({
        type: "destination",
        iata: d.iata,
        code: d.iata,
        title: d.label,
        subtitle: "Destinazione Partiamo",
        score: 4,
      });
    }
  }

  items.sort((a, b) => (a.score ?? 50) - (b.score ?? 50) || a.title.localeCompare(b.title, "it"));

  return items.slice(0, cap).map(({ score: _s, airports: _a, ...rest }) => rest);
}

module.exports = {
  searchLocations,
  METRO_AREAS,
  getAllCityGroups,
  getMetroByAirport,
};
