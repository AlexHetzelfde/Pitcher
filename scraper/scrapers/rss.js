// scrapers/rss.js
//
// Scraapt een standaard RSS 2.0-feed (bijvoorbeeld NOS). Elk <item> wordt
// een apart, duidelijk gescheiden nieuwsbericht — dat "duidelijk scheiden"
// waar je om vroeg zit dus al in deze stap: elk RSS-<item> wordt precies
// één object in de output-array, nooit samengevoegd met een ander bericht.

const { haalOp, parseerRssTekst } = require("../hulpmiddelen");

async function scrapeRss(bron) {
  const tekst = await haalOp(bron.url);
  return parseerRssTekst(tekst, bron);
}

module.exports = { scrapeRss };
