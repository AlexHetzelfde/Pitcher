// scrapers/wordpress-html.js
//
// Scraapt een WordPress-nieuwsoverzichtspagina (zoals zaanschemolen.nl/nieuws/).
// WordPress-sites hebben bijna altijd ook een RSS-feed op /feed/ — die proberen
// we eerst, want dat is veel robuuster dan HTML-scrapen (minder kans op breken
// bij een theme-update). Lukt dat niet, dan valt de functie terug op het
// scrapen van de HTML-lijst zelf.

const cheerio = require("cheerio");
const { haalOp, parseerRssTekst, oorzaakTekst } = require("../hulpmiddelen");

async function scrapeWordpress(bron) {
  // Stap 1: probeer de standaard WordPress RSS-feed.
  const feedUrl = bron.url.replace(/\/?$/, "/feed/");
  try {
    const feedTekst = await haalOp(feedUrl);
    const items = await parseerRssTekst(feedTekst, bron);
    if (items.length > 0) {
      console.log(`[${bron.id}] RSS-feed gebruikt (${feedUrl}), ${items.length} bericht(en).`);
      return items;
    }
  } catch (fout) {
    console.warn(`[${bron.id}] RSS-feed niet bruikbaar (${feedUrl}): ${fout.message}${oorzaakTekst(fout)}. Val terug op HTML-scrape.`);
  }

  // Stap 2: fallback — scrape de HTML van de nieuwsoverzichtspagina zelf.
  console.log(`[${bron.id}] Geen bruikbare RSS-feed, HTML-fallback gebruikt.`);
  const html = await haalOp(bron.url);
  const $ = cheerio.load(html);
  const berichten = [];

  // WordPress-thema's verschillen, dus we proberen een paar veelvoorkomende
  // patronen: een <article>, of een blok met een <h2>/<h3> die naar een los
  // artikel linkt, gevolgd door een datum in de buurt.
  $("article, .post, .news-item").each((_, el) => {
    const titelEl = $(el).find("h1, h2, h3").first();
    const titel = titelEl.text().trim();
    const link = titelEl.find("a").attr("href") || $(el).find("a").first().attr("href");
    if (!titel || !link) return;

    const datumTekst = $(el).find("time").attr("datetime") || $(el).find("time").text().trim();
    const gepubliceerdOp = parseerDatum(datumTekst) || datumUitPermalink($, el);

    berichten.push({
      bronId: bron.id,
      bronNaam: bron.naam,
      categorie: bron.categorie,
      titel,
      url: link,
      samenvatting: "",
      gepubliceerdOp,
      opgehaaldOp: new Date().toISOString(),
    });
  });

  const zonderDatum = berichten.filter((b) => !b.gepubliceerdOp).length;
  if (zonderDatum > 0) {
    console.warn(`[${bron.id}] ${zonderDatum} van ${berichten.length} berichten (HTML-fallback) hadden geen herkenbare datum — deze site heeft waarschijnlijk maatwerk-selectors nodig voor de datum.`);
  }

  return berichten;
}

/**
 * WordPress zet de publicatiedatum vaak ook gewoon in de permalink-URL zelf
 * (bv. .../2025/04/23/artikel-titel/), soms als een los datum-linkje met de
 * tijd in het title-attribuut (zoals bij zaanschemolen.nl: <a
 * href=".../2025/04/23/" title="10:22 am">apr232025</a>) in plaats van in een
 * <time>-element. Dit is een betrouwbare extra bron voor de datum die geen
 * enkele aanname doet over het thema — puur de standaard WordPress-URL-opbouw.
 */
function datumUitPermalink($, el) {
  let gevonden = null;
  $(el)
    .find("a")
    .each((_, a) => {
      if (gevonden) return;
      const href = $(a).attr("href") || "";
      const match = href.match(/\/(\d{4})\/(\d{2})\/(\d{2})\//);
      if (!match) return;
      const [, jaar, maand, dag] = match;
      const tijdTekst = $(a).attr("title") || "";
      const tijdMatch = tijdTekst.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
      let uur = 0;
      let minuut = 0;
      if (tijdMatch) {
        uur = Number(tijdMatch[1]) % 12;
        minuut = Number(tijdMatch[2]);
        if ((tijdMatch[3] || "").toLowerCase() === "pm") uur += 12;
      }
      const datum = new Date(Number(jaar), Number(maand) - 1, Number(dag), uur, minuut);
      if (!isNaN(datum.getTime())) gevonden = datum.toISOString();
    });
  return gevonden;
}

function parseerDatum(tekst) {
  if (!tekst) return null;
  const d = new Date(tekst);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

module.exports = { scrapeWordpress };
