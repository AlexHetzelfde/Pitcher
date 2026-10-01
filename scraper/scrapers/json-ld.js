// scrapers/json-ld.js
//
// Leest berichten uit de gestructureerde data (schema.org, JSON-LD) die veel
// sites in hun eigen pagina zetten voor zoekmachines:
//   <script type="application/ld+json"> {"@type":"Event","name":...} </script>
// Agenda's en nieuwspagina's hebben dit vaak, met nette datums. Het is
// stabieler dan CSS-selectors, want het is bedoeld om door machines gelezen
// te worden.
//
// Ondersteunde types: NewsArticle, Article, BlogPosting, Event (en subtypes
// zoals MusicEvent, TheaterEvent, ...). Voor artikelen is de datum
// datePublished, voor evenementen startDate (de datum van het evenement).

const cheerio = require("cheerio");
const { haalOp } = require("../hulpmiddelen");

const ARTIKEL_TYPES = /^(NewsArticle|Article|BlogPosting|Report|ScholarlyArticle|.*Event)$/;

function alsLijst(waarde) {
  return Array.isArray(waarde) ? waarde : waarde == null ? [] : [waarde];
}

/** Loopt recursief door een JSON-LD-structuur (ook @graph en geneste lijsten) en verzamelt de bruikbare knopen. */
function verzamelKnopen(waarde, uit) {
  if (Array.isArray(waarde)) {
    waarde.forEach((w) => verzamelKnopen(w, uit));
    return;
  }
  if (!waarde || typeof waarde !== "object") return;
  const types = alsLijst(waarde["@type"]).map(String);
  if (types.some((t) => ARTIKEL_TYPES.test(t))) uit.push(waarde);
  for (const sleutel of Object.keys(waarde)) {
    if (sleutel === "@context") continue;
    verzamelKnopen(waarde[sleutel], uit);
  }
}

function linkVan(knoop) {
  const kandidaten = [knoop.url, knoop.mainEntityOfPage && (knoop.mainEntityOfPage["@id"] || knoop.mainEntityOfPage), knoop["@id"]];
  return kandidaten.find((k) => typeof k === "string" && /^(https?:\/\/|\/)/.test(k)) || null;
}

/** Puur: haalt berichten uit een al geladen cheerio-document. Ook los te gebruiken voor tests. */
function haalJsonLdBerichten($, basisUrl, bron) {
  const knopen = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const ruw = $(el).contents().text().trim();
    if (!ruw) return;
    try {
      verzamelKnopen(JSON.parse(ruw), knopen);
    } catch {
      // Ongeldige JSON-LD (komt voor, bijvoorbeeld door losse regeleinden in een tekstveld): overslaan.
    }
  });

  const gezien = new Set();
  const berichten = [];
  for (const knoop of knopen) {
    const titel = String(knoop.name || knoop.headline || "").replace(/\s+/g, " ").trim();
    const link = linkVan(knoop);
    if (!titel || !link) continue;
    let url;
    try {
      url = new URL(link, basisUrl).toString();
    } catch {
      continue;
    }
    if (gezien.has(url)) continue;
    gezien.add(url);

    const datum = new Date(knoop.datePublished || knoop.dateCreated || knoop.startDate || "");
    berichten.push({
      bronId: bron.id,
      bronNaam: bron.naam,
      categorie: bron.categorie,
      titel,
      url,
      samenvatting: String(knoop.description || "").replace(/\s+/g, " ").trim().slice(0, 600),
      gepubliceerdOp: isNaN(datum.getTime()) ? null : datum.toISOString(),
      opgehaaldOp: new Date().toISOString(),
    });
  }
  return berichten;
}

async function scrapeJsonLd(bron) {
  const html = await haalOp(bron.url);
  return haalJsonLdBerichten(cheerio.load(html), bron.url, bron);
}

module.exports = { scrapeJsonLd, haalJsonLdBerichten };
