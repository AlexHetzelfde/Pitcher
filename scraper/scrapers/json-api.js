// scrapers/json-api.js
//
// Generieke scraper voor een JSON-endpoint dat een lijst berichten teruggeeft.
// De koppeling van JSON-velden aan titel/link/datum staat in bronnen.js bij
// bron.json, bijvoorbeeld:
//
//   {
//     id: "voorbeeld", type: "json-api",
//     url: "https://voorbeeld.nl/api/nieuws?limit=20",
//     json: { itemsPad: "data.items", titelVeld: "title", linkVeld: "url",
//             datumVeld: "published_at", samenvattingVeld: "intro" },
//   }
//
// Paden gebruiken punten voor diepte ("data.items", "meta.0.titel"). Een lege
// itemsPad betekent: de JSON zelf is de lijst. Relatieve links worden
// opgelost tegen bron.url. Deze koppeling wordt meestal door Gemini bedacht
// bij het toevoegen van de bron (zie bron-ontdekking.js) en daar getest.

const { haalOp } = require("../hulpmiddelen");

function haalOpPad(object, pad) {
  if (!pad) return object;
  return String(pad)
    .split(".")
    .reduce((huidig, sleutel) => (huidig == null ? undefined : huidig[sleutel]), object);
}

function parseerJsonDatum(waarde) {
  if (waarde == null || waarde === "") return null;
  // Unix-tijd: seconden (10 cijfers) of milliseconden (13 cijfers).
  if (typeof waarde === "number" || /^\d{9,13}$/.test(String(waarde))) {
    const n = Number(waarde);
    const d = new Date(n < 1e12 ? n * 1000 : n);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(String(waarde));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

async function scrapeJsonApi(bron) {
  const cfg = bron.json;
  if (!cfg || !cfg.titelVeld || !cfg.linkVeld) {
    console.error(`[${bron.id}] Geen (complete) 'json'-configuratie in bronnen.js voor type json-api, bron overgeslagen.`);
    return [];
  }

  const tekst = await haalOp(bron.url);
  let data;
  try {
    data = JSON.parse(tekst);
  } catch {
    throw new Error(`Geen geldige JSON op ${bron.url}`);
  }
  const items = haalOpPad(data, cfg.itemsPad);
  if (!Array.isArray(items)) throw new Error(`Pad "${cfg.itemsPad || "(root)"}" is geen lijst in de JSON van ${bron.url}`);

  const berichten = [];
  for (const item of items) {
    const titel = String(haalOpPad(item, cfg.titelVeld) ?? "").replace(/\s+/g, " ").trim();
    const link = haalOpPad(item, cfg.linkVeld);
    if (!titel || !link) continue;
    let url;
    try {
      url = new URL(String(link), bron.url).toString();
    } catch {
      continue;
    }
    berichten.push({
      bronId: bron.id,
      bronNaam: bron.naam,
      categorie: bron.categorie,
      titel,
      url,
      samenvatting: cfg.samenvattingVeld ? String(haalOpPad(item, cfg.samenvattingVeld) ?? "").replace(/\s+/g, " ").trim().slice(0, 600) : "",
      gepubliceerdOp: cfg.datumVeld ? parseerJsonDatum(haalOpPad(item, cfg.datumVeld)) : null,
      opgehaaldOp: new Date().toISOString(),
    });
  }
  return berichten;
}

module.exports = { scrapeJsonApi, haalOpPad, parseerJsonDatum };
