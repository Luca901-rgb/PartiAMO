require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const { sendWelcomeEmail } = require("./email");

const app = express();
const PORT = process.env.PORT || 3000;

/** Su Vercel la Lambda ha cwd=/var/task ma gli asset vanno inclusi (vedi vercel.json includeFiles). */
function resolvePublicDir() {
  const candidates = [
    path.join(process.cwd(), "public"),
    path.join(__dirname, "..", "public"),
    path.join(__dirname, "public"),
  ];
  for (const dir of candidates) {
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        return dir;
      }
    } catch (_) {
      /* ignore */
    }
  }
  console.error("[partiamo] public/ non trovato. cwd=%s __dirname=%s", process.cwd(), __dirname);
  return path.join(process.cwd(), "public");
}

const publicDir = resolvePublicDir();

function sendPublicHtml(res, filename) {
  const file = path.join(publicDir, filename);
  res.sendFile(file, (err) => {
    if (err) {
      console.error("[sendFile]", file, err.message);
      if (!res.headersSent) {
        res.status(500).type("text/plain").send("Pagina non disponibile (deploy)");
      }
    }
  });
}

let dbInitPromise = null;
function ensureDbInitialized() {
  if (!dbInitPromise) {
    const { initDb } = require("./db");
    dbInitPromise = initDb().catch((err) => {
      dbInitPromise = null;
      throw err;
    });
  }
  return dbInitPromise;
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/api", async (req, res, next) => {
  // Rotte API senza database
  if (req.path === "/live-search" || req.path === "/destinations" || req.path === "/airports") {
    return next();
  }
  try {
    await ensureDbInitialized();
    next();
  } catch (error) {
    console.error("[db]", error);
    res.status(500).json({ ok: false, error: "Database non disponibile" });
  }
});

app.get("/api/destinations", (req, res) => {
  try {
    const destinations = require("./destinations-data.json");
    res.json({ ok: true, destinations });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Elenco destinazioni non disponibile" });
  }
});

app.get("/api/airports", (req, res) => {
  try {
    const { searchAirports } = require("./airports");
    const q = String(req.query.q || "").trim();
    const limit = Number(req.query.limit) || 12;
    const airports = searchAirports(q, limit);
    res.json({ ok: true, airports, total: airports.length });
  } catch (e) {
    console.error("[airports]", e);
    res.status(500).json({ ok: false, error: "Elenco aeroporti non disponibile" });
  }
});

app.use(
  express.static(publicDir, {
    etag: true,
    lastModified: true,
    setHeaders(res, filepath) {
      if (/\.(js|css|html)$/i.test(filepath)) {
        res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
      }
    },
  })
);

/** Richiesta usata dallo script Travelpayouts (tp-em): evita 404 in console. */
app.get("/live-search", (_req, res) => {
  res.status(204).end();
});
app.head("/live-search", (_req, res) => {
  res.status(204).end();
});

app.get("/favicon.ico", (_req, res) => {
  res.redirect(302, "/partiamo-logo-banner.svg");
});

app.get("/", (req, res) => {
  sendPublicHtml(res, "partiamo.html");
});

app.get("/registrati", (req, res) => {
  sendPublicHtml(res, "registrati.html");
});

app.get("/grazie", (req, res) => {
  sendPublicHtml(res, "grazie.html");
});

app.get("/offerta/:id", (req, res) => {
  sendPublicHtml(res, "offerta.html");
});

app.get("/offerta-live", (req, res) => {
  sendPublicHtml(res, "offerta-live.html");
});

app.post("/api/live-search", async (req, res) => {
  try {
    const { getLiveSearchPreview } = require("./search");
    const { resolveAirportIata } = require("./airports");
    const rawOrigin = String(req.body.aeroporto_partenza || "").trim();
    const rawDestLabel = String(req.body.destinazione_preferita || "").trim();
    const rawDestIata = String(req.body.destinazione_iata || "").trim();
    const rawDest = rawDestLabel || rawDestIata;
    const originResolved = resolveAirportIata(rawOrigin) || (/^[A-Za-z]{3}$/.test(rawOrigin) ? rawOrigin.toUpperCase() : "");
    const rawDestLastPart = rawDestLabel
      .split(/[,\-–—|/]+/)
      .map((p) => p.trim())
      .filter(Boolean)
      .pop() || "";
    const destCandidates = rawDestLabel
      ? [rawDestLabel, rawDestLastPart, rawDestIata]
      : [rawDestIata];
    let destResolved = "";
    for (const candidate of destCandidates) {
      const c = String(candidate || "").trim();
      destResolved = resolveAirportIata(c) || (/^[A-Za-z]{3}$/.test(c) ? c.toUpperCase() : "");
      if (destResolved) break;
    }
    const destLabel = String(rawDestLabel || rawDest || "").trim();
    const dateFrom = String(req.body.date_from || req.body.data_andata || "").trim();
    const dateTo = String(req.body.date_to || req.body.data_ritorno || "").trim();
    const payload = {
      ...req.body,
      aeroporto_partenza: originResolved || rawOrigin.toUpperCase().slice(0, 3) || "NAP",
      destinazione_preferita: destLabel || destResolved,
      destinazione_iata: destResolved || rawDestIata.toUpperCase() || undefined,
      date_from: dateFrom,
      date_to: dateTo,
      budget: Number(req.body.budget),
      durata: Number(req.body.durata),
      rating_minimo: Number(req.body.rating_minimo),
      destinazione_tipo: String(req.body.destinazione_tipo || "Ovunque").trim() || "Ovunque",
      destinazione_sorpresa: req.body.destinazione_sorpresa === "1" ? 1 : 0,
      solo_voli_diretti: req.body.solo_voli_diretti === "1" || req.body.solo_voli_diretti === true ? 1 : 0,
    };
    const preview = await getLiveSearchPreview(payload);
    if (!preview) {
      return res.status(500).json({
        ok: false,
        error: "Impossibile preparare l'offerta in questo momento. Riprova tra poco.",
      });
    }
    return res.json({ ok: true, preview });
  } catch (error) {
    if (error?.code === "DESTINATION_UNSUPPORTED") {
      return res.status(400).json({ ok: false, error: error.message });
    }
    if (error?.code === "NO_FLIGHTS_FOUND") {
      return res.status(404).json({ ok: false, error: error.message, code: "NO_FLIGHTS_FOUND" });
    }
    if (error?.code === "LIVE_PRICES_UNAVAILABLE") {
      return res.status(503).json({ ok: false, error: error.message });
    }
    if (error?.code === "BUDGET_TOO_TIGHT") {
      return res.status(404).json({
        ok: false,
        error: error.message,
        code: "BUDGET_TOO_TIGHT",
        suggested_budget_min: error.suggested_budget_min,
      });
    }
    if (error?.code === "NO_QUOTED_PACKAGE") {
      return res.status(404).json({ ok: false, error: error.message, code: "NO_QUOTED_PACKAGE" });
    }
    if (error?.code === "MAPS_KEY_MISSING") {
      return res.status(503).json({ ok: false, error: error.message });
    }
    return res.status(500).json({ ok: false, error: "Errore ricerca live" });
  }
});

app.post("/api/register", async (req, res) => {
  try {
    const { run } = require("./db");
    const { resolveAirportIata } = require("./airports");
    const rawOrigin = String(req.body.aeroporto_partenza || "").trim();
    const originResolved = resolveAirportIata(rawOrigin) || (/^[A-Za-z]{3}$/.test(rawOrigin) ? rawOrigin.toUpperCase() : "");
    const payload = {
      ...req.body,
      aeroporto_partenza: originResolved || rawOrigin.toUpperCase().slice(0, 3) || "NAP",
    };
    const result = await run(
      `INSERT INTO utenti (
        nome, email, aeroporto_partenza, budget, persone, durata,
        destinazione_tipo, destinazione_preferita, destinazione_sorpresa, fascia_oraria, tipo_volo, distanza_mare, distanza_centro,
        rating_minimo, tipo_pasto, tipo_camera, tipo_struttura, bagaglio, prezzo_riferimento, ultima_notifica, creato_il
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payload.nome,
        payload.email,
        payload.aeroporto_partenza,
        Number(payload.budget),
        payload.persone,
        Number(payload.durata),
        payload.destinazione_tipo,
        payload.destinazione_preferita || null,
        payload.destinazione_sorpresa === "1" ? 1 : 0,
        payload.fascia_oraria,
        payload.tipo_volo,
        payload.distanza_mare,
        payload.distanza_centro,
        Number(payload.rating_minimo),
        payload.tipo_pasto,
        payload.tipo_camera,
        payload.tipo_struttura || "Entrambe",
        payload.bagaglio,
        payload.prezzo_riferimento ? Number(payload.prezzo_riferimento) : null,
        null,
        new Date().toISOString(),
      ]
    );

    await sendWelcomeEmail({
      nome: payload.nome,
      email: payload.email,
    });

    res.json({ ok: true, userId: result.lastID });
  } catch (error) {
    if (String(error.message || "").includes("UNIQUE")) {
      return res.status(400).json({ ok: false, error: "Email gia registrata" });
    }
    return res.status(500).json({ ok: false, error: "Errore server" });
  }
});

app.get("/api/offerta/:id", async (req, res) => {
  const { get } = require("./db");
  const offer = await get("SELECT * FROM offerte WHERE id = ?", [req.params.id]);
  if (!offer) return res.status(404).json({ ok: false, error: "Offerta non trovata" });

  if (Date.now() > new Date(offer.scade_il).getTime()) {
    return res.status(410).json({ ok: false, error: "Offerta scaduta" });
  }

  const user = await get("SELECT nome, budget, aeroporto_partenza, persone FROM utenti WHERE id = ?", [
    offer.utente_id,
  ]);

  const flight = JSON.parse(offer.volo_json);
  const { attachFlightAffiliateLinks, buildKlookHotelLink } = require("./search");
  attachFlightAffiliateLinks(flight);
  const hotels = [offer.hotel1_json, offer.hotel2_json, offer.hotel3_json].map((h) => JSON.parse(h));
  const persone = user?.persone != null ? user.persone : "2";
  for (const h of hotels) {
    h.bookingLink = buildKlookHotelLink(h, flight, persone);
  }

  return res.json({
    ok: true,
    offer: {
      id: offer.id,
      scade_il: offer.scade_il,
      prezzo_totale: offer.prezzo_totale,
      risparmio: offer.risparmio,
      budget: user.budget,
      partenza: user.aeroporto_partenza,
      persone,
      flight,
      hotels,
    },
  });
});

app.use((err, req, res, next) => {
  console.error("[express]", err);
  if (!res.headersSent) {
    res.status(500).type("text/plain").send(process.env.VERCEL ? "Errore server" : String(err.message || err));
  }
});

if (!process.env.VERCEL) {
  const { initDb } = require("./db");
  initDb()
    .then(() => {
      const startPort = Number(PORT);
      const maxPort = startPort + 20;

      const listenOnPort = (port) => {
        const server = app
          .listen(port, () => {
            console.log(`Partiamo live su http://localhost:${port}`);
          })
          .on("error", (error) => {
            if (error.code === "EADDRINUSE" && port < maxPort) {
              console.warn(`Porta ${port} occupata, provo ${port + 1}...`);
              return listenOnPort(port + 1);
            }
            console.error("Server error:", error.message);
          });
      };

      listenOnPort(startPort);
      setInterval(() => {}, 60 * 60 * 1000);
    })
    .catch((err) => {
      console.error("initDb:", err);
      process.exit(1);
    });
}

module.exports = app;
