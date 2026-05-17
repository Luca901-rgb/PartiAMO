const FLIGHT_FALLBACK_COVER =
  "https://images.unsplash.com/photo-1436491865332-7a61a109cc05?auto=format&fit=crop&w=1400&q=85";
const AFFILIATE_KIWI_FALLBACK = "https://kiwi.tpk.lv/UiOvgyTf";

const KLOOK_COPY_DEFAULT =
  "Apriamo Klook con destinazione, date, ospiti e filtro prezzo entro il budget residuo dopo il volo.";

function escHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

function effectiveFlightUrl(flight) {
  const u = String((flight && flight.flightLink) || "").trim();
  return u || AFFILIATE_KIWI_FALLBACK;
}

function klookHotelHref(preview) {
  const href = String(
    preview?.klook_hotel_direct_url ||
      preview?.hotels?.[0]?.directBookingLink ||
      preview?.klook_hotel_url ||
      preview?.hotels?.[0]?.bookingLink ||
      preview?.aviasales_hotel_url ||
      preview?.flight?.hotelLink ||
      ""
  ).trim();
  return normalizeKlookHotelHref(href, preview);
}

function normalizeKlookHotelHref(href, preview) {
  const url = String(href || "").trim();
  if (!url || !/klook\.com\/hotels/i.test(url)) return url;
  const checkIn = String(preview?.requested_check_in || "").slice(0, 10);
  const checkOut = String(preview?.requested_check_out || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut)) return url;
  try {
    const u = new URL(url);
    u.searchParams.set("check_in", checkIn);
    u.searchParams.set("check_out", checkOut);
    return u.toString();
  } catch (_e) {
    return url;
  }
}

function passengerCountFromPreview(preview) {
  const raw = String(preview?.passengers_count ?? preview?.persone ?? "2").replace(/\D/g, "");
  return Math.max(1, Math.min(9, Number(raw) || 1));
}

function flightButtonLabel(flight, preview) {
  if (
    preview?.flight_price_is_indicative === true ||
    String(flight?.priceSource || "") === "travelpayouts"
  ) {
    return "Verifica prezzo su Aviasales";
  }
  const price = Math.round(Number(preview?.flight_price_euro ?? flight?.price) || 0);
  return price > 0 ? `Cerca volo da €${price}` : "Cerca volo";
}

function renderSingleOffer(preview) {
  const f = preview.flight;
  const fp = Math.round(Number(preview.flight_price_euro != null ? preview.flight_price_euro : f.price) || 0);
  const hotelQuota = Math.floor(Number(preview.hotel_stay_quota) || 0);
  const nights = Math.max(1, Number(preview.stay_nights) || 1);
  const maxNight =
    Math.floor(Number(preview.hotel_max_per_night_euro) || 0) ||
    (nights > 0 ? Math.floor(hotelQuota / nights) : hotelQuota);
  const cityShown = escHtml(preview.destination_city || f.destination || "");
  const klookHref = escHtml(klookHotelHref(preview));
  const kiwiHref = escHtml(effectiveFlightUrl(f));
  const klookCopy = escHtml(String(preview.stay_pricing_disclaimer || "").trim() || KLOOK_COPY_DEFAULT);

  const article = document.createElement("article");
  article.className = "package-card package-card--single package-card--klook fade-up";
  article.innerHTML = `
    <div class="package-card__top">
      <span class="package-card__badge">La tua offerta</span>
      <div class="package-card__total">
        <span class="package-card__total-label">Il tuo viaggio</span>
        <strong class="package-card__total-eur">${escHtml(`${preview.partenza} → ${f.destination}`)}</strong>
        <span class="package-card__total-sub">${escHtml(f.departDate)} → ${escHtml(f.returnDate)} · ${nights} notti</span>
      </div>
    </div>
    <div class="klook-budget-box">
      <p class="klook-budget-box__title">Alloggi selezionati nel tuo budget</p>
      <p class="klook-budget-box__amount">Max <strong>€${maxNight}</strong> a notte</p>
      <p class="klook-budget-box__sub">≈ €${hotelQuota} per ${nights} notti a ${cityShown}</p>
    </div>
    <p class="klook-microcopy">${klookCopy}</p>
    <div class="package-card__actions package-card__actions--stacked">
      <a href="${klookHref}" target="_blank" rel="noopener noreferrer sponsored" class="package-btn package-btn--klook">Verifica hotel su Klook</a>
      <a href="${kiwiHref}" target="_blank" rel="noopener noreferrer sponsored" class="package-btn package-btn--kiwi">${escHtml(flightButtonLabel(f, preview))}</a>
    </div>
  `;
  return article;
}

function initLivePage() {
  const raw = sessionStorage.getItem("partiamo_live_preview");
  if (!raw) {
    document.getElementById("error").textContent =
      "Nessun risultato live disponibile. Torna alla home e avvia una ricerca.";
    return;
  }

  let preview;
  try {
    preview = JSON.parse(raw);
  } catch (_e) {
    document.getElementById("error").textContent = "Risultato non valido. Riprova la ricerca.";
    return;
  }

  if (!preview.flight) {
    document.getElementById("error").textContent = "Risultato incompleto. Riprova la ricerca live.";
    return;
  }

  const f = preview.flight;
  document.getElementById("flightHeroImg").src = f.coverPhoto || FLIGHT_FALLBACK_COVER;
  document.getElementById("flightRoute").textContent = `${preview.partenza} → ${f.destination}`;
  document.getElementById("flightDates").textContent = `${f.departDate} → ${f.returnDate}`;
  document.getElementById("flightPrice").textContent = `da €${Math.round(Number(preview.flight_price_euro ?? f.price) || 0)}`;

  const note = document.getElementById("hotelPartnerNote");
  if (note) {
    note.textContent =
      String(preview.stay_pricing_disclaimer || "").trim() || KLOOK_COPY_DEFAULT;
  }

  const container = document.getElementById("offerContainer");
  container.innerHTML = "";
  container.appendChild(renderSingleOffer(preview));
}

initLivePage();
