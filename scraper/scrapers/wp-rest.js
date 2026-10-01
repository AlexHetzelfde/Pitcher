// scrapers/wp-rest.js
//
// Haalt berichten op via de WordPress REST API, bijvoorbeeld
//   https://voorbeeld.nl/wp-json/wp/v2/posts?per_page=20&orderby=date&order=desc
// of, voor een eigen berichttype zoals een evenementenagenda,
//   https://voorbeeld.nl/wp-json/wp/v2/agenda?per_page=20&orderby=date&order=desc
//
// Waarom dit bestaat: veel WordPress-sites hebben een lege of onbruikbare
// RSS-feed (de algemene /feed/ toont alleen gewone berichten), terwijl hun
// agenda of nieuws als eigen berichttype wel via de REST API beschikbaar is.
// JSON is stabieler dan HTML-selectors: een theme-update breekt dit niet.
//
// De datum is de publicatiedatum van het bericht op de site (date_gmt), dus
// niet de datum van een evenement.

const cheerio = require("cheerio");
const { haalOp } = require("../hulpmiddelen");

/** Haalt platte tekst uit HTML zoals WordPress die in title.rendered en excerpt.rendered levert (met entiteiten als &amp;). */
function platteTekst(html) {
  if (!html) return "";
  return cheerio.load(`<div>${html}</div>`).text().replace(/\s+/g, " ").trim();
}

async function scrapeWpRest(bron) {
  const tekst = await haalOp(bron.url);
  let data;
  try {
    data = JSON.parse(tekst);
  } catch {
    throw new Error(`Geen geldige JSON van de WordPress REST API op ${bron.url}`);
  }
  if (!Array.isArray(data)) {
    const melding = data && data.message ? `: ${data.message}` : "";
    throw new Error(`De WordPress REST API gaf geen lijst terug${melding}`);
  }

  return data
    .map((item) => {
      // date_gmt heeft geen tijdzone-aanduiding ("2026-09-29T10:00:00"), maar is wel UTC.
      const datumGmt = item.date_gmt && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(item.date_gmt) ? `${item.date_gmt}Z` : item.date_gmt;
      const datum = new Date(datumGmt || item.date || "");
      return {
        bronId: bron.id,
        bronNaam: bron.naam,
        categorie: bron.categorie,
        titel: platteTekst(item.title && item.title.rendered),
        url: item.link || "",
        samenvatting: platteTekst(item.excerpt && item.excerpt.rendered).slice(0, 600),
        gepubliceerdOp: isNaN(datum.getTime()) ? null : datum.toISOString(),
        opgehaaldOp: new Date().toISOString(),
      };
    })
    .filter((b) => b.titel && b.url);
}

module.exports = { scrapeWpRest, platteTekst };
