const fs = require("fs");
const path = require("path");

function canUseTmpOnThisRuntime() {
  if (!process.env.VERCEL) return false;
  const tmpDir = "/tmp";
  try {
    fs.accessSync(tmpDir, fs.constants.W_OK);
    return true;
  } catch (_error) {
    return false;
  }
}

function resolveDbPath() {
  if (canUseTmpOnThisRuntime()) {
    return path.join("/tmp", "partiamo.sqlite");
  }
  const dir = path.join(process.cwd(), "data");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, "partiamo.sqlite");
}

let dbInstance = null;

function getDb() {
  if (!dbInstance) {
    const sqlite3 = require("sqlite3").verbose();
    dbInstance = new sqlite3.Database(resolveDbPath());
  }
  return dbInstance;
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDb().run(sql, params, function onRun(error) {
      if (error) return reject(error);
      return resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDb().get(sql, params, (error, row) => {
      if (error) return reject(error);
      return resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDb().all(sql, params, (error, rows) => {
      if (error) return reject(error);
      return resolve(rows);
    });
  });
}

async function initDb() {
  await run(`
    CREATE TABLE IF NOT EXISTS utenti (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      aeroporto_partenza TEXT NOT NULL,
      budget INTEGER NOT NULL,
      persone TEXT NOT NULL,
      durata INTEGER NOT NULL,
      destinazione_tipo TEXT NOT NULL,
      destinazione_preferita TEXT,
      destinazione_sorpresa INTEGER NOT NULL DEFAULT 0,
      fascia_oraria TEXT NOT NULL,
      tipo_volo TEXT NOT NULL,
      distanza_mare TEXT NOT NULL,
      distanza_centro TEXT NOT NULL,
      rating_minimo REAL NOT NULL,
      tipo_pasto TEXT NOT NULL,
      tipo_camera TEXT NOT NULL,
      tipo_struttura TEXT NOT NULL DEFAULT 'Entrambe',
      bagaglio TEXT NOT NULL,
      prezzo_riferimento INTEGER,
      ultima_notifica TEXT,
      creato_il TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS offerte (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      utente_id INTEGER NOT NULL,
      volo_json TEXT NOT NULL,
      hotel1_json TEXT NOT NULL,
      hotel2_json TEXT NOT NULL,
      hotel3_json TEXT NOT NULL,
      prezzo_totale INTEGER NOT NULL,
      risparmio INTEGER NOT NULL,
      scade_il TEXT NOT NULL,
      creato_il TEXT NOT NULL,
      FOREIGN KEY(utente_id) REFERENCES utenti(id)
    )
  `);

  try {
    await run("ALTER TABLE utenti ADD COLUMN tipo_struttura TEXT NOT NULL DEFAULT 'Entrambe'");
  } catch (error) {
    if (!String(error.message || "").includes("duplicate column name")) {
      throw error;
    }
  }

  try {
    await run("ALTER TABLE utenti ADD COLUMN prezzo_riferimento INTEGER");
  } catch (error) {
    if (!String(error.message || "").includes("duplicate column name")) {
      throw error;
    }
  }

  try {
    await run("ALTER TABLE utenti ADD COLUMN destinazione_preferita TEXT");
  } catch (error) {
    if (!String(error.message || "").includes("duplicate column name")) {
      throw error;
    }
  }

  try {
    await run("ALTER TABLE utenti ADD COLUMN destinazione_sorpresa INTEGER NOT NULL DEFAULT 0");
  } catch (error) {
    if (!String(error.message || "").includes("duplicate column name")) {
      throw error;
    }
  }
}

module.exports = {
  get db() {
    return getDb();
  },
  run,
  get,
  all,
  initDb,
};
