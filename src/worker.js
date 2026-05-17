require("dotenv").config();
const { initDb, all } = require("./db");
const { processUserForOffers } = require("./search");

async function runCycle() {
  try {
    const users = await all("SELECT * FROM utenti");
    for (const user of users) {
      // Sequential run to keep API usage under control.
      await processUserForOffers(user);
    }
    console.log(`[worker] scan complete: ${users.length} utenti`);
  } catch (error) {
    console.error("[worker] error:", error.message);
  }
}

async function startWorker() {
  await initDb();
  await runCycle();
  setInterval(runCycle, 60 * 60 * 1000);
  console.log("[worker] running every 60 minutes");
}

startWorker();
