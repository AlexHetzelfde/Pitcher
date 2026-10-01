// scrapers/gemini-recept.js
//
// Generieke scraper voor bronnen die zijn toegevoegd via voeg-bron-toe.js.
// Gebruikt het eenmalig door Gemini gegenereerde "recept" (CSS-selectors,
// opgeslagen in bronnen.js bij bron.selectors) om dagelijks te scrapen —
// puur met cheerio, geen Gemini-aanroep per dag nodig.

const cheerio = require("cheerio");
const { haalOp, haalDatumUitTekst, parseerDatumTekst } = require("../hulpmiddelen");

/**
 * Zoekt een element BINNEN een item, maar ook het item zelf. cheerio's find()
 * kijkt alleen naar afstammelingen, dus een selector die het item zelf
 * beschrijft (bijvoorbeeld "a.kaart" als de hele kaart een link is) werd
 * nooit gevonden.
 */
function vindInItem($, el, selector) {
  if (!selector) return $();
  const binnen = $(el).find(selector).first();
  if (binnen.length) return binnen;
  return $(el).is(selector) ? $(el) : binnen;
}

function bruikbareHref(href) {
  return href && !href.startsWith("#") && !/^(javascript|mailto|tel):/i.test(href) ? href : null;
}

/**
 * Leest titel, link en datumtekst uit één item. Wordt door de scraper EN door
 * de diagnose in gemini-recept-lus.js gebruikt, zodat wat Gemini te horen krijgt
 * ("de selector matchte 12 elementen, 0 hadden een link") altijd hetzelfde
 * is als wat de scraper werkelijk doet.
 *
 * De link wordt in deze volgorde gezocht, en de eerste die bestaat wint:
 *   1. linkSelector, binnen het item (of het item zelf)
 *   2. het titel-element zelf, of de eerste link daarbinnen, of de link eromheen
 *   3. het item zelf als dat een <a> is, of de link eromheen
 *   4. de eerste link binnen het item
 * Stap 2 tot 4 vangen de gangbare variant op waarbij een hele kaart één
 * aanklikbare <a> is (zoals bij evenementenagenda's): daar is het item zelf de
 * link, en "self" of "a" als linkSelector vond die eerder niet.
 */
function leesItem($, el, selectors) {
  const { titelSelector, linkSelector, datumSelector, datumAttribuut } = selectors;

  const titelEl = titelSelector ? vindInItem($, el, titelSelector) : $(el);
  const titel = titelEl.text().replace(/\s+/g, " ").trim();

  const kandidaten = [];
  if (linkSelector && linkSelector !== "self" && linkSelector !== "item") {
    kandidaten.push(vindInItem($, el, linkSelector).attr("href"));
  }
  kandidaten.push(titelEl.is("a") ? titelEl.attr("href") : null);
  kandidaten.push(titelEl.find("a[href]").first().attr("href"));
  kandidaten.push(titelEl.closest("a[href]").attr("href"));
  kandidaten.push($(el).is("a") ? $(el).attr("href") : null);
  kandidaten.push($(el).closest("a[href]").attr("href"));
  kandidaten.push($(el).find("a[href]").first().attr("href"));
  const link = kandidaten.map(bruikbareHref).find(Boolean) || null;

  let datumTekst = null;
  if (datumSelector) {
    const datumEl = vindInItem($, el, datumSelector);
    datumTekst = datumAttribuut ? datumEl.attr(datumAttribuut) : datumEl.text().replace(/\s+/g, " ").trim();
  }
  return { titel, link, datumTekst };
}

async function scrapeGeminiRecept(bron) {
  if (!bron.selectors) {
    console.error(`[${bron.id}] Geen 'selectors' gevonden in bronnen.js voor dit gemini-recept-type — bron overgeslagen.`);
    return [];
  }

  const html = await haalOp(bron.url);
  const $ = cheerio.load(html);

  const berichten = [];
  $(bron.selectors.itemSelector).each((_, el) => {
    const { titel, link, datumTekst } = leesItem($, el, bron.selectors);
    if (!titel || !link) return;

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

module.exports = { scrapeGeminiRecept, leesItem };
