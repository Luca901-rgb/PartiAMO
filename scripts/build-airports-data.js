/**
 * Scarica airports.dat (OpenFlights) e genera src/airports-data.json
 * Uso: node scripts/build-airports-data.js
 */
const fs = require("fs");
const path = require("path");
const https = require("https");

const URL =
  "https://raw.githubusercontent.com/jpatokal/openflights/master/data/airports.dat";
const OUT = path.join(__dirname, "..", "src", "airports-data.json");

function parseCsvLine(line) {
  const parts = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      inQ = !inQ;
      continue;
    }
    if (ch === "," && !inQ) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchText(res.headers.location).then(resolve).catch(reject);
          return;
        }
        let data = "";
        res.on("data", (c) => {
          data += c;
        });
        res.on("end", () => resolve(data));
      })
      .on("error", reject);
  });
}

async function main() {
  const raw = await fetchText(URL);
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const p = parseCsvLine(line);
    const iata = String(p[4] || "").trim();
    if (!/^[A-Z]{3}$/.test(iata)) continue;
    const name = String(p[1] || "").trim();
    const city = String(p[2] || "").trim();
    const country = String(p[3] || "").trim();
    out.push({ iata, name, city, country });
  }
  out.sort((a, b) => a.city.localeCompare(b.city, "en") || a.iata.localeCompare(b.iata));
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`Wrote ${out.length} airports to ${OUT} (${fs.statSync(OUT).size} bytes)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
