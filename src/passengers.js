/**
 * Passeggeri viaggio: adulti, bambini (2–11), neonati (<2).
 * Usato per Kiwi (/search/results/.../A-C-I/) e Klook (adult_num, child_num, age).
 */

function parseTripPassengers(user = {}) {
  const adultsRaw = user.adults ?? user.adulti;
  const childrenRaw = user.children ?? user.bambini;
  const infantsRaw = user.infants ?? user.neonati ?? user.infant;

  let adults = Math.floor(Number(adultsRaw));
  if (!Number.isFinite(adults) || adults < 1) {
    const legacy = String(user.persone || "2").replace(/\D/g, "");
    adults = Math.max(1, Math.min(9, Number(legacy) || 2));
  }
  adults = Math.max(1, Math.min(9, adults));

  let children = Math.floor(Number(childrenRaw));
  if (!Number.isFinite(children) || children < 0) children = 0;
  children = Math.max(0, Math.min(8, children));

  let infants = Math.floor(Number(infantsRaw));
  if (!Number.isFinite(infants) || infants < 0) infants = 0;
  infants = Math.max(0, Math.min(adults, infants));

  return { adults, children, infants };
}

/** Totale ospiti (Klook / budget copy). */
function totalTripGuests(user) {
  const p = parseTripPassengers(user);
  return p.adults + p.children + p.infants;
}

/** Compat: numero usato storicamente come «persone» (adulti). */
function hotelGuestCount(user) {
  return parseTripPassengers(user).adults;
}

/** Parametri ospiti Klook hotel. */
function klookGuestParams(user) {
  const p = parseTripPassengers(user);
  const ages = [];
  for (let i = 0; i < p.children; i++) ages.push(8);
  for (let i = 0; i < p.infants; i++) ages.push(1);
  return {
    adults: p.adults,
    child_num: p.children + p.infants,
    age: ages.length ? ages.join(",") : "",
  };
}

function passengerSummaryIt(user) {
  const p = parseTripPassengers(user);
  const parts = [`${p.adults} adult${p.adults === 1 ? "o" : "i"}`];
  if (p.children > 0) parts.push(`${p.children} bambin${p.children === 1 ? "o" : "i"}`);
  if (p.infants > 0) parts.push(`${p.infants} neonat${p.infants === 1 ? "o" : "i"}`);
  return parts.join(", ");
}

module.exports = {
  parseTripPassengers,
  totalTripGuests,
  hotelGuestCount,
  klookGuestParams,
  passengerSummaryIt,
};
