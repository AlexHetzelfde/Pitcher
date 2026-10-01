// scrapers/gemini-recept.js
//
// Generieke scraper voor bronnen die zijn toegevoegd via voeg-bron-toe.js.
// Gebruikt het eenmalig door Gemini gegenereerde "recept" (CSS-selectors,
// opgeslagen in bronnen.js bij bron.selectors) om dagelijks te scrapen —
// puur met cheerio, geen Gemini-aanroep per dag nodig.

const cheerio = require("cheerio");
const { haalOp, haalDatumUitTekst, parseerDatumTekst } = require("../hulpmiddelen");

async function scrapeGeminiRecept(bron) {
  if (!bron.selectors) {
    console.error(`[${bron.id}] Geen 'selectors' gevonden in bronnen.js voor dit gemini-recept-type — bron overgeslagen.`);
    return [];
  }

  const html = await haalOp(bron.url);
  const $ = cheerio.load(html);
  const { itemSelector, titelSelector, linkSelector, datumSelector, datumAttribuut } = bron.selectors;

  const berichten = [];
  $(itemSelector).each((_, el) => {
    const titelEl = titelSelector ? $(el).find(titelSelector).first() : $(el);
    const titel = titelEl.text().trim();
    if (!titel) return;

    let link = null;
    if (linkSelector === "self") {
      link = titelEl.is("a") ? titelEl.attr("href") : titelEl.find("a").attr("href");
    } else if (linkSelector) {
      link = $(el).find(linkSelector).attr("href");
    }
    if (!link) return;

    let datumTekst = null;
    if (datumSelector) {
      const datumEl = $(el).find(datumSelector).first();
      datumTekst = datumAttribuut ? datumEl.attr(datumAttribuut) : datumEl.text().trim();
    }
    // Val terug op de titel/item-tekst zelf als er geen los datum-element is
    // (of dat niets opleverde) — sommige sites (zoals de Zaanstad-
    // hoorzittingen) hebben de datum in de titeltekst gebakken in plaats van
    // in een apart element.
    //
    // Bij agenda-bronnen (bron.soort === "agenda") staan datums vaak zonder
    // jaar ("30 sep"); dan wordt het jaar afgeleid, en kijken we als laatste
    // redmiddel ook in de url zelf (sommige agenda's zetten de datum in het
    // pad, zoals /agenda/2026-09-29-lezing/).
    const agenda = bron.soort === "agenda";
    const opties = { zonderJaar: agenda };
    const nieuweUrl = new URL(link, bron.url).toString();
    const gepubliceerdOp =
      parseerDatumTekst(datumTekst, opties) ||
      haalDatumUitTekst(titel, opties) ||
      haalDatumUitTekst($(el).text(), opties) ||
      (agenda ? haalDatumUitTekst(nieuweUrl) : null);

    berichten.push({
      bronId: bron.id,
      bronNaam: bron.naam,
      categorie: bron.categorie,
      titel,
      url: nieuweUrl,
      samenvatting: "",
      gepubliceerdOp,
      opgehaaldOp: new Date().toISOString(),
    });
  });

  const zonderDatum = berichten.filter((b) => !b.gepubliceerdOp).length;
  if (zonderDatum > 0) {
    console.warn(`[${bron.id}] ${zonderDatum} van ${berichten.length} berichten (gemini-recept) hadden geen herkenbare datum.`);
  }

  return berichten;
}


module.exports = { scrapeGeminiRecept };
