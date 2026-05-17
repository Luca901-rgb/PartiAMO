const nodemailer = require("nodemailer");

function createTransporter() {
  const { NODEMAILER_EMAIL, NODEMAILER_PASSWORD } = process.env;
  if (!NODEMAILER_EMAIL || !NODEMAILER_PASSWORD) return null;

  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: NODEMAILER_EMAIL,
      pass: NODEMAILER_PASSWORD,
    },
  });
}

async function sendEmail({ to, subject, text, html }) {
  const transporter = createTransporter();
  if (!transporter) {
    console.log("Email skipped: missing NODEMAILER_EMAIL/NODEMAILER_PASSWORD");
    return;
  }

  await transporter.sendMail({
    from: `"Partiamo" <${process.env.NODEMAILER_EMAIL}>`,
    to,
    subject,
    text,
    html,
  });
}

async function sendWelcomeEmail(user) {
  await sendEmail({
    to: user.email,
    subject: "Benvenuto su Partiamo",
    text: `Ciao ${user.nome}, benvenuto su Partiamo. Ti avviseremo quando troviamo il viaggio giusto per te.`,
    html: `<p>Ciao <strong>${user.nome}</strong>,</p><p>Benvenuto su Partiamo. Ti avviseremo quando troviamo il viaggio giusto per te.</p>`,
  });
}

async function sendOfferEmail({ user, offer }) {
  const volo = JSON.parse(offer.volo_json);
  const hotels = [offer.hotel1_json, offer.hotel2_json, offer.hotel3_json].map((h) =>
    JSON.parse(h)
  );

  const subject = `✈️ Trovato! ${volo.fromName} → ${volo.destination} nel tuo budget`;
  const offerUrl = `${process.env.BASE_URL || "http://localhost:3000"}/offerta/${offer.id}`;

  const text = `Ciao ${user.nome},

Abbiamo trovato un viaggio perfetto per te!

VOLO
${volo.fromName} → ${volo.destination}
${volo.timeBand} · ${volo.flightType} · ${volo.departDate} - ${volo.returnDate}

BUDGET
Totale: €${offer.prezzo_totale} su €${user.budget}
Risparmi: €${offer.risparmio}

ALLOGGIO (Klook)
Quota hotel nel budget: fino a €${hotels[0]?.price ?? "—"}
${hotels[0]?.name ? `Destinazione: ${hotels[0].name}` : "Miglior hotel nel budget — vedi in pagina"}

Vedi tutto e prenota qui:
${offerUrl}

⚠️ Offerta disponibile per 6 ore`;

  const html = `
    <p>Ciao ${user.nome},</p>
    <p>Abbiamo trovato un viaggio perfetto per te!</p>
    <h3>✈️ VOLO</h3>
    <p>${volo.fromName} → ${volo.destination}<br>${volo.timeBand} · ${volo.flightType} · ${volo.departDate} - ${volo.returnDate}</p>
    <h3>💰 BUDGET</h3>
    <p>Totale: €${offer.prezzo_totale} su €${user.budget}<br>Risparmi: €${offer.risparmio}</p>
    <h3>🏨 ALLOGGIO</h3>
    <p>Quota hotel nel budget: fino a €${hotels[0]?.price ?? "—"}<br>
    ${hotels[0]?.name ? String(hotels[0].name) : "Alloggio su Klook — apri il link per vedere le tariffe nel tuo budget."}</p>
    <p><a href="${offerUrl}">→ Vedi tutto e prenota qui</a></p>
    <p>⚠️ Offerta disponibile per 6 ore</p>
  `;

  await sendEmail({ to: user.email, subject, text, html });
}

module.exports = {
  sendWelcomeEmail,
  sendOfferEmail,
};
