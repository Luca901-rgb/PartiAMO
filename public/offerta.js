const FLIGHT_FALLBACK_COVER =
  "https://images.unsplash.com/photo-1436491865332-7a61a109cc05?auto=format&fit=crop&w=1400&q=85";
const AFFILIATE_KIWI_FALLBACK = "https://kiwi.tpk.lv/UiOvgyTf";
const AFFILIATE_AIRHELP_FALLBACK = "https://airhelp.tpk.lv/BDuyfeVr";
function effectiveFlightUrl(flight) {
  const u = String((flight && flight.flightLink) || "").trim();
  if (u) return u;
  return AFFILIATE_KIWI_FALLBACK;
}

function affiliateUrls(flight) {
  return {
    kiwi: effectiveFlightUrl(flight),
    airHelp: flight.airHelpLink || AFFILIATE_AIRHELP_FALLBACK,
  };
}

function escAttr(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function parseOfferId() {
  const chunks = window.location.pathname.split("/");
  return chunks[chunks.length - 1];
}

function renderCountdown(expiryIso) {
  const el = document.getElementById("countdown");
  const tick = () => {
    const ms = new Date(expiryIso).getTime() - Date.now();
    if (ms <= 0) {
      el.textContent = "Offerta scaduta";
      return;
    }
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    el.textContent = `Scade tra ${h}h ${m}m ${s}s`;
  };
  tick();
  setInterval(tick, 1000);
}

function createHotelCard(hotel, flight, persone) {
  const u = affiliateUrls(flight);
  const hotelBookHref = escAttr(String(hotel.bookingLink || "").trim());
  const walkHtml =
    hotel.walkToCenterMin != null
      ? hotel.walkToSeaMin != null
        ? `🚶 ${hotel.walkToSeaMin} min dal mare · 🚶 ${hotel.walkToCenterMin} min dal centro`
        : `🚶 ca. ${hotel.walkToCenterMin} min dal centro`
      : "Dettagli e prezzo finale su Klook.";
  const priceHtml =
    hotel.priceSource === "xotelo" || hotel.priceSource === "booking"
      ? `€${hotel.price} soggiorno${hotel.stayNights != null ? ` · ${hotel.stayNights} notti` : ""}${
          hotel.pricePerNightXotelo != null ? ` (~€${Math.round(Number(hotel.pricePerNightXotelo))}/notte)` : ""
        }${hotel.bestPriceLabel ? ` · ${hotel.bestPriceLabel}` : ""}`
      : hotel.price != null && hotel.price !== ""
        ? `~€${hotel.price} soggiorno${
            hotel.stayNights != null ? ` · ${hotel.stayNights} notti` : ""
          }${hotel.pricePerNightEstimate != null ? ` (~€${hotel.pricePerNightEstimate}/notte stima)` : ""}`
        : hotel.stayAllocationEuro != null
          ? `Obiettivo soggiorno ~€${Math.round(Number(hotel.stayAllocationEuro))}${
              hotel.stayBudgetMax != null ? ` (max €${hotel.stayBudgetMax})` : ""
            }`
          : "Prezzo indicativo — Klook al click";
  const hotelCta = "Verifica alloggi su Klook.com →";
  const card = document.createElement("article");
  card.className = "card fade-up booking-card";
  card.innerHTML = `
    <div class="hotel-images">
      ${hotel.photos.map((p) => `<img src="${p}" alt="Struttura" />`).join("")}
    </div>
    <div class="booking-top">
      <p class="booking-title masked-name">Struttura selezionata</p>
      <span class="booking-score">⭐ ${hotel.rating}</span>
    </div>
    <p class="booking-meta">${hotel.structureType} · ${hotel.roomType} · ${hotel.mealType}</p>
    <p class="booking-meta">${walkHtml}</p>
    <div class="booking-footer">
      <p class="booking-price">${priceHtml}</p>
      <button type="button" class="btn btn-booking reveal-booking">Sblocca e prenota</button>
    </div>
    <div class="booking-reveal hidden-box" style="display:none;margin-top:12px">
      <p class="booking-meta"><strong>${hotel.name}</strong></p>
      <p class="booking-meta">Compagnia volo: ${flight.airlineName}</p>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px">
        <a href="${u.kiwi}" target="_blank" rel="noopener noreferrer sponsored"
          ><button type="button" class="btn btn-booking">Voli su Kiwi.com</button></a
        >
        <a href="${u.airHelp}" target="_blank" rel="noopener noreferrer sponsored"
          ><button type="button" class="btn btn-outline-partiamo">AirHelp — diritti passeggeri</button></a
        >
        <a href="${hotelBookHref}" target="_blank" rel="noopener noreferrer sponsored nofollow"
          ><button type="button" class="btn btn-booking">${hotelCta}</button></a
        >
      </div>
    </div>
  `;
  card.querySelector(".reveal-booking").addEventListener("click", () => {
    card.querySelector(".booking-reveal").style.display = "block";
    card.querySelector(".masked-name").textContent = hotel.name;
    card.querySelector(".reveal-booking").remove();
  });
  return card;
}

async function init() {
  const id = parseOfferId();
  const response = await fetch(`/api/offerta/${id}`);
  const result = await response.json();
  if (!response.ok || !result.ok) {
    document.getElementById("error").textContent = result.error || "Offerta non disponibile.";
    return;
  }

  const { offer } = result;
  const f = offer.flight;

  document.getElementById("flightHeroImg").src = f.coverPhoto || FLIGHT_FALLBACK_COVER;
  document.getElementById("flightRoute").textContent = `${offer.partenza} → ${f.destination}`;
  document.getElementById("dateVolo").textContent = `${f.departDate} · ritorno ${f.returnDate}`;
  document.getElementById("fascia").textContent = f.timeBand;
  document.getElementById("tipoVolo").textContent = f.flightType;
  document.getElementById("compagnia").textContent = f.airlineName;
  document.getElementById("prezzoVolo").textContent = `€${f.price}`;
  document.getElementById("prezzo").textContent = `€${offer.prezzo_totale} su €${offer.budget}`;
  document.getElementById("risparmio").textContent = `Risparmi €${offer.risparmio}`;

  const u = affiliateUrls(f);
  const voloTop = document.getElementById("voloLinkTop");
  voloTop.href = u.kiwi;
  voloTop.style.display = "inline-flex";
  const airTop = document.getElementById("airHelpLinkTop");
  airTop.href = u.airHelp;
  airTop.style.display = "inline-flex";

  renderCountdown(offer.scade_il);

  const grid = document.getElementById("hotelGrid");
  const persone = offer.persone != null ? offer.persone : "2";
  offer.hotels.forEach((hotel) => grid.appendChild(createHotelCard(hotel, f, persone)));
}

init();
