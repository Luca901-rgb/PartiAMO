/**
 * Aeroporti mondiali (OpenFlights) — ricerca e risoluzione codice IATA.
 */
let airportsList = null;
let airportsByIata = null;

function foldAscii(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function isItalyCountry(country) {
  const c = foldAscii(country);
  return c === "italy" || c === "italia";
}

function countryIt(country) {
  const map = {
    Italy: "Italia",
    France: "Francia",
    Spain: "Spagna",
    Cyprus: "Cipro",
    Romania: "Romania",
    Greece: "Grecia",
    Germany: "Germania",
    "United Kingdom": "Regno Unito",
  };
  return map[country] || country || "";
}

/** Città italiane → aeroporto principale (evita RMA Australia per «Roma»). */
const ITALIAN_CITY_PRIMARY_IATA = {
  roma: "FCO",
  rome: "FCO",
  milano: "MXP",
  milan: "MXP",
  napoli: "NAP",
  naples: "NAP",
  torino: "TRN",
  turin: "TRN",
  bologna: "BLQ",
  firenze: "FLR",
  florence: "FLR",
  venezia: "VCE",
  venice: "VCE",
  palermo: "PMO",
  catania: "CTA",
  bari: "BRI",
  pisa: "PSA",
  verona: "VRN",
  trieste: "TRS",
  cagliari: "CAG",
  olbia: "OLB",
  brindisi: "BDS",
  corfu: "CFU",
  kerkyra: "CFU",
  pechino: "PEK",
  beijing: "PEK",
  peking: "PEK",
};

function loadAirports() {
  if (airportsList) return airportsList;
  airportsList = require("./airports-data.json");
  airportsByIata = new Map(airportsList.map((a) => [a.iata, a]));
  return airportsList;
}

function formatAirportLabel(a) {
  const city = String(a.city || "").trim();
  const name = String(a.name || "").trim();
  if (city && name && !foldAscii(name).includes(foldAscii(city))) {
    return `${city} — ${name}`;
  }
  return city || name || a.iata;
}

/** Hub mostrati con campo vuoto (partenza). */
const POPULAR_DEPARTURE_IATA = [
  "FCO",
  "MXP",
  "NAP",
  "BGY",
  "VCE",
  "BLQ",
  "CTA",
  "PMO",
  "BRI",
  "PSA",
  "TRN",
  "GOA",
  "CDG",
  "ORY",
  "LHR",
  "LGW",
  "BCN",
  "MAD",
  "LIS",
  "AMS",
  "BER",
  "MUC",
  "VIE",
  "ZRH",
  "ATH",
  "IST",
  "DXB",
  "JFK",
  "EWR",
  "LAX",
  "MIA",
  "SIN",
  "HND",
  "NRT",
  "BKK",
  "SYD",
  "GRU",
  "EZE",
];

function searchAirports(query, limit = 12) {
  const list = loadAirports();
  const byIata = airportsByIata;
  const cap = Math.max(1, Math.min(80, Number(limit) || 12));
  const q = foldAscii(query);

  if (!q) {
    return POPULAR_DEPARTURE_IATA.map((iata) => byIata.get(iata))
      .filter(Boolean)
      .slice(0, cap)
      .map((a) => ({
        iata: a.iata,
        label: formatAirportLabel(a),
        city: a.city,
        name: a.name,
        country: a.country,
      }));
  }

  /** Es. "napoli" non deve matchare "Annapolis" (contains debole). */
  const QUERY_ALIASES = {
    napoli: ["naples", "nap"],
    naples: ["napoli", "nap"],
    roma: ["rome", "fco"],
    rome: ["roma", "fco"],
    milano: ["milan", "mxp"],
    milan: ["milano", "mxp"],
    pechino: ["beijing", "pek", "pkx"],
    beijing: ["pechino", "pek", "pkx"],
    peking: ["beijing", "pechino", "pek"],
    cipro: ["cyprus", "lca", "pfo"],
    cyprus: ["cipro", "lca", "pfo"],
  };
  const terms = [q, ...(QUERY_ALIASES[q] || [])];

  const scored = [];
  for (const a of list) {
    if ((q === "roma" || q === "rome") && foldAscii(a.country) === "romania") continue;
    if ((q === "roma" || q === "rome") && a.iata === "RMA") continue;
    let s = 100;
    const iataL = a.iata.toLowerCase();
    const cityF = foldAscii(a.city);
    const nameF = foldAscii(a.name);
    const countryF = foldAscii(a.country);
    const countryItF = foldAscii(countryIt(a.country));

    for (const t of terms) {
      if (!t) continue;
      if ((t === "napoli" || t === "naples") && a.iata === "NAP") {
        s = Math.min(s, 0);
        break;
      }
      if ((t === "roma" || t === "rome") && a.iata === "RMA") {
        s = 99;
        continue;
      }
      if ((t === "roma" || t === "rome") && foldAscii(a.country) === "romania") {
        s = 99;
        continue;
      }
      if ((t === "roma" || t === "rome") && isItalyCountry(a.country) && (a.iata === "FCO" || a.iata === "CIA")) {
        s = Math.min(s, 0);
        break;
      }
      if (ITALIAN_CITY_PRIMARY_IATA[t] && a.iata === ITALIAN_CITY_PRIMARY_IATA[t]) {
        s = Math.min(s, 0);
        break;
      }
      if (iataL === t) {
        s = Math.min(s, 0);
        break;
      }
      if (iataL.startsWith(t)) s = Math.min(s, 1);
      if (cityF === t) s = Math.min(s, 0);
      else if (cityF.startsWith(t)) s = Math.min(s, 2);
      else if (nameF.startsWith(t)) s = Math.min(s, 3);
      else if (countryItF === t || countryF === t) s = Math.min(s, 6);
      else if (t.length >= 5 && (countryItF.startsWith(t) || countryF.startsWith(t))) s = Math.min(s, 7);
    }

    if (s < 100) scored.push({ a, s });
  }

  scored.sort((x, y) => {
    const primary = ITALIAN_CITY_PRIMARY_IATA[q];
    if (primary) {
      if (x.a.iata === primary) return -1;
      if (y.a.iata === primary) return 1;
    }
    if (q === "napoli" || q === "naples") {
      if (x.a.iata === "NAP") return -1;
      if (y.a.iata === "NAP") return 1;
    }
    return (
      x.s - y.s ||
      String(x.a.city).localeCompare(String(y.a.city), "en") ||
      x.a.iata.localeCompare(y.a.iata)
    );
  });

  return scored.slice(0, cap).map(({ a }) => ({
    iata: a.iata,
    label: formatAirportLabel(a),
    city: a.city,
    name: a.name,
    country: a.country,
  }));
}

function getAirportByIata(iata) {
  const code = String(iata || "")
    .trim()
    .toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return null;
  loadAirports();
  const hit = airportsByIata.get(code);
  return hit ? { ...hit, label: formatAirportLabel(hit) } : null;
}

function resolveAirportIata(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  loadAirports();

  const up = raw.toUpperCase();
  if (/^[A-Z]{3}$/.test(up) && airportsByIata.has(up)) {
    if (up === "RMA") return "FCO";
    return up;
  }

  const key = foldAscii(raw);
  if (ITALIAN_CITY_PRIMARY_IATA[key]) return ITALIAN_CITY_PRIMARY_IATA[key];

  let best = null;
  let bestScore = 100;

  for (const a of airportsList) {
    let s = 100;
    const cityF = foldAscii(a.city);
    const nameF = foldAscii(a.name);
    const labelF = foldAscii(formatAirportLabel(a));
    const countryF = foldAscii(a.country);

    if (key === "roma" || key === "rome") {
      if (a.iata === "RMA") continue;
      if (isItalyCountry(a.country) && (a.iata === "FCO" || a.iata === "CIA")) s = 0;
      else if (isItalyCountry(a.country)) s = Math.min(s, 2);
      else continue;
    } else if (labelF === key || cityF === key) s = 0;
    else if (nameF === key) s = 1;
    else if (`${cityF} ${countryF}` === key) s = 2;
    else if (labelF.includes(key) && key.length >= 4) s = 3;

    if (s < bestScore) {
      bestScore = s;
      best = a.iata;
      if (s === 0) break;
    }
  }

  if (best === "RMA") return "FCO";
  return best || "";
}

module.exports = {
  searchAirports,
  resolveAirportIata,
  formatAirportLabel,
  getAirportByIata,
  foldAscii,
};
