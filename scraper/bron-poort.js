// bron-poort.js
//
// De "poort" waar elke nieuwe bron doorheen moet voordat 'ie in bronnen.js
// komt. Dit is de plek waar "gelukt" wordt bewezen, niet aangenomen.
//
// Waarom dit bestaat: voeg-bron-toe.js meldde bij de bron "orkaan" dat het
// gelukt was, terwijl de bron 0 berichten opleverde. Het script had een
// feed-link in de pagina gezien en daar nooit iets mee getest. Nu geldt voor
// ELKE methode (feed, WordPress REST, JSON-LD, generieke patronen, Gemini):
//
//   1. De methode draait via de ECHTE scraper uit de dagelijkse run (dezelfde
//      functie uit scraper-register.js), niet via een eigen testkopie. Wat
//      hier werkt, werkt 's nachts gegarandeerd hetzelfde.
//   2. Het resultaat moet de kwaliteitscontrole halen (titel, unieke link op
//      dezelfde site, leesbare datum die niet overal gelijk is).
//   3. Als er een referentielijst is (de berichten die Gemini zelf op de
//      pagina ziet), moet het recept die ongeveer volledig terugvinden.
//
// Bewust GEEN vast minimum van "3 berichten": een rustige bron met 2 berichten
// op de pagina mag prima. Dan telt de volledigheid (vindt het recept alles
// wat er staat?) en krijgt de bron in bronnen.js het vlaggetje rustig: true.
//
// De leeftijdsfilter (max 7 dagen) wordt hier bewust NIET toegepast. Een bron
// waar twee weken niets is geplaatst, is geen kapotte bron.

const { scraperVoorType } = require("./scraper-register");

// Recept-typen die op HTML-selectors leunen. Daar kan "1 match" toeval zijn,
// dus zonder referentielijst van Gemini eisen we minstens 3 berichten.
const SELECTOR_TYPES = ["generieke-lijst", "gemini-recept"];

const MIN_DEKKING = 0.8; // recept moet minstens 80% van Gemini's lijst terugvinden
const MIN_DATUMDEKKING = 0.5; // minstens de helft van de berichten moet een leesbare datum hebben
const MIN_ZELFDE_SITE = 0.5; // minstens de helft van de links moet op dezelfde site blijven
const WEINIG_BERICHTEN = 3; // onder dit aantal krijgt een geslaagde bron rustig: true
const MIN_TITEL_TEKENS = 4;

// Linkteksten die geen titel zijn. Als een recept deze als "titel" pakt, heeft
// het de "lees meer"-knop te pakken in plaats van de kop van het bericht.
const GENERIEKE_LINKTEKST = /^(lees\s+(meer|verder)|meer(\s+lezen|\s+info)?|read\s+more|klik\s+hier|bekijk|details?|»|›|>)$/i;

/** Maakt een url vergelijkbaar: geen www, geen #anker, geen slash aan het eind, geen tracking-parameters. */
function normaliseerUrl(url, basis) {
  try {
    const u = new URL(url, basis);
    if (!["http:", "https:"].includes(u.protocol)) return null;
    for (const sleutel of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$)/i.test(sleutel)) u.searchParams.delete(sleutel);
    }
    const pad = u.pathname.replace(/\/+$/, "") || "/";
    return `${u.hostname.toLowerCase().replace(/^www\./, "")}${pad}${u.search}`;
  } catch {
    return null;
  }
}

/** Grove "registreerbaar domein" (zaanstad.nl uit loket.zaanstad.nl), zonder externe lijst. */
function registreerbaarDomein(url) {
  try {
    const labels = new URL(url).hostname.toLowerCase().replace(/^www\./, "").split(".");
    if (labels.length <= 2) return labels.join(".");
    const voorlaatste = labels[labels.length - 2];
    const langeTweeLetterEnding = labels[labels.length - 1].length === 2 && ["co", "com", "org", "net", "gov", "ac"].includes(voorlaatste);
    return labels.slice(langeTweeLetterEnding ? -3 : -2).join(".");
  } catch {
    return null;
  }
}

/** Draait de echte scraper voor een bron-config, precies zoals de dagelijkse run dat doet. */
async function draaiScraper(bron) {
  const scraper = scraperVoorType(bron.type);
  if (!scraper) throw new Error(`Onbekend brontype "${bron.type}"`);
  return scraper(bron, new Set());
}

function dagSleutel(iso) {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * Beoordeelt het resultaat van een scraper-run.
 *
 * opties:
 *   siteUrl     de pagina waar de bron bij hoort (voor de zelfde-site-check)
 *   verwacht    [{ titel, url }] referentielijst van Gemini (al gecontroleerd
 *               tegen de echte links op de pagina); zet de volledigheidscheck aan
 *   paginaLinks Set met genormaliseerde links op de pagina; alleen voor
 *               feed/API-kandidaten, om te zien of ze bij deze pagina horen
 *   padKandidaten  genormaliseerde links onder hetzelfde pad als de lijstpagina
 *               (zonder query, zonder paginering); geeft een waarschuwing als
 *               het recept er veel minder van vindt dan er staan
 *
 * Geeft terug: { geslaagd, twijfel, rustig, aantal, redenen, waarschuwingen,
 *                dekking, ontbrekend, geldig, statistieken }
 */
function beoordeelResultaat(bron, berichten, opties = {}) {
  const redenen = [];
  const waarschuwingen = [];
  const siteUrl = opties.siteUrl || bron.url;

  // --- Per bericht: titel + geldige, unieke link ---
  let zonderTitel = 0;
  let zonderLink = 0;
  let dubbel = 0;
  const gezien = new Set();
  const geldig = [];
  for (const b of berichten || []) {
    const titel = (b.titel || "").replace(/\s+/g, " ").trim();
    if (titel.length < MIN_TITEL_TEKENS || GENERIEKE_LINKTEKST.test(titel)) {
      zonderTitel++;
      continue;
    }
    const genormaliseerd = normaliseerUrl(b.url || "");
    if (!genormaliseerd) {
      zonderLink++;
      continue;
    }
    if (gezien.has(genormaliseerd)) {
      dubbel++;
      continue;
    }
    gezien.add(genormaliseerd);
    geldig.push({ ...b, titel });
  }

  const aantal = geldig.length;
  const statistieken = { ruw: (berichten || []).length, geldig: aantal, zonderTitel, zonderLink, dubbel };

  if (aantal === 0) {
    redenen.push(
      `Geen enkel bruikbaar bericht (${statistieken.ruw} ruwe items: ${zonderTitel} zonder echte titel, ${zonderLink} zonder geldige link, ${dubbel} dubbel).`
    );
    return { geslaagd: false, twijfel: false, rustig: false, aantal, redenen, waarschuwingen, dekking: null, ontbrekend: [], geldig, statistieken };
  }
  if (zonderTitel + zonderLink > 0) {
    waarschuwingen.push(`${zonderTitel + zonderLink} van ${statistieken.ruw} items overgeslagen (geen echte titel of geen geldige link).`);
  }

  // --- Zelfde site ---
  const eigenDomein = registreerbaarDomein(siteUrl);
  const opEigenSite = geldig.filter((b) => registreerbaarDomein(b.url) === eigenDomein).length;
  if (eigenDomein && opEigenSite / aantal < MIN_ZELFDE_SITE) {
    redenen.push(`Slechts ${opEigenSite} van ${aantal} links blijft op ${eigenDomein}; dit lijken geen berichten van deze bron.`);
  }

  // --- Datums ---
  const metDatum = geldig.filter((b) => b.gepubliceerdOp && dagSleutel(b.gepubliceerdOp));
  const datumDekking = metDatum.length / aantal;
  statistieken.metDatum = metDatum.length;
  if (datumDekking < MIN_DATUMDEKKING) {
    redenen.push(
      `Slechts ${metDatum.length} van ${aantal} berichten hebben een leesbare datum. De dagelijkse run weert berichten zonder datum als "te oud", dus deze bron zou vrijwel niets opleveren.`
    );
  } else if (metDatum.length < aantal) {
    waarschuwingen.push(`${aantal - metDatum.length} van ${aantal} berichten hebben geen leesbare datum; die worden 's nachts als "te oud" geweerd.`);
  }
  const uniekeDagen = new Set(metDatum.map((b) => dagSleutel(b.gepubliceerdOp)));
  if (metDatum.length >= 4 && uniekeDagen.size === 1) {
    redenen.push(`Alle ${metDatum.length} berichten hebben dezelfde datum (${[...uniekeDagen][0]}); waarschijnlijk wordt de datum van de pagina gepakt in plaats van die van elk bericht.`);
  } else if (metDatum.length >= 2 && uniekeDagen.size === 1) {
    waarschuwingen.push(`Alle ${metDatum.length} berichten met datum hebben dezelfde dag (${[...uniekeDagen][0]}); controleer of dat klopt.`);
  }
  const nu = Date.now();
  statistieken.toekomst = metDatum.filter((b) => new Date(b.gepubliceerdOp).getTime() > nu + 12 * 3600 * 1000).length;

  // --- Volledigheid tegen de referentielijst van Gemini ---
  let dekking = null;
  let ontbrekend = [];
  const verwacht = opties.verwacht || [];
  if (verwacht.length > 0) {
    const gevondenSet = new Set(geldig.map((b) => normaliseerUrl(b.url)));
    const gevonden = verwacht.filter((v) => gevondenSet.has(normaliseerUrl(v.url)));
    ontbrekend = verwacht.filter((v) => !gevondenSet.has(normaliseerUrl(v.url)));
    dekking = gevonden.length / verwacht.length;
    statistieken.verwacht = verwacht.length;
    statistieken.gevondenVanVerwacht = gevonden.length;
    if (dekking < MIN_DEKKING) {
      redenen.push(`Het recept vindt ${gevonden.length} van de ${verwacht.length} berichten die Gemini op de pagina ziet (minimaal ${Math.round(MIN_DEKKING * 100)}% nodig).`);
    }
    if (verwacht.length < 50 && aantal > verwacht.length * 2 + 3) {
      waarschuwingen.push(`Het recept vindt ${aantal} items, Gemini ziet er maar ${verwacht.length}. Mogelijk worden ook menu- of zijbalk-items meegenomen.`);
    }
    const padKandidaten = opties.padKandidaten || [];
    if (padKandidaten.length >= 6) {
      const dekkingPad = padKandidaten.filter((u) => gevondenSet.has(u)).length / padKandidaten.length;
      statistieken.padKandidaten = padKandidaten.length;
      statistieken.padDekking = dekkingPad;
      if (dekkingPad < 0.5) {
        waarschuwingen.push(
          `Op de pagina staan ${padKandidaten.length} links onder hetzelfde pad, het recept vindt er ${Math.round(dekkingPad * padKandidaten.length)}. Mogelijk mist het recept een deel van de lijst (of het zijn categorie- en filterlinks).`
        );
      }
    }
  } else if (SELECTOR_TYPES.includes(bron.type) && aantal < WEINIG_BERICHTEN) {
    redenen.push(
      `Een selector-recept dat maar ${aantal} bericht(en) vindt, kan zonder referentielijst van Gemini niet gecontroleerd worden (toeval is dan niet uit te sluiten).`
    );
  }

  // --- Hoort dit bij de pagina? (feed / API / JSON-LD) ---
  let twijfel = false;
  if (opties.paginaLinks && verwacht.length === 0) {
    const opPagina = geldig.filter((b) => opties.paginaLinks.has(normaliseerUrl(b.url))).length;
    statistieken.opPagina = opPagina;
    if (opPagina === 0) {
      twijfel = true;
      waarschuwingen.push(
        `Geen enkel bericht uit deze bron staat als link op de opgegeven pagina. Het kan een feed of API zijn die niet bij deze pagina hoort (bijvoorbeeld een algemene blog-feed naast een agenda).`
      );
    }
  }

  const geslaagd = redenen.length === 0;
  const rustig = geslaagd && aantal < WEINIG_BERICHTEN;
  if (rustig) waarschuwingen.push(`Slechts ${aantal} bericht(en) gevonden; de bron krijgt rustig: true zodat de dagelijkse run dit niet als fout meldt.`);

  return { geslaagd, twijfel: geslaagd && twijfel, rustig, aantal, redenen, waarschuwingen, dekking, ontbrekend, geldig, statistieken };
}

/** Draait de echte scraper en beoordeelt de uitkomst. Vangt scraper-fouten op als afkeurreden. */
async function testBron(bron, opties = {}) {
  let berichten;
  try {
    berichten = await draaiScraper(bron);
  } catch (fout) {
    return {
      geslaagd: false,
      twijfel: false,
      rustig: false,
      aantal: 0,
      redenen: [`De scraper zelf gaf een fout: ${fout.message}`],
      waarschuwingen: [],
      dekking: null,
      ontbrekend: [],
      geldig: [],
      statistieken: { ruw: 0, geldig: 0 },
    };
  }
  return beoordeelResultaat(bron, berichten, opties);
}

/** Korte, controleerbare voorproef voor in de log: de eerste berichten met hun datum. */
function voorbeeldRegels(oordeel, aantal = 3) {
  return oordeel.geldig.slice(0, aantal).map((b, i) => `  ${i + 1}. "${b.titel}" (datum: ${b.gepubliceerdOp ? String(b.gepubliceerdOp).slice(0, 10) : "geen"}) ${b.url}`);
}

module.exports = {
  normaliseerUrl,
  registreerbaarDomein,
  draaiScraper,
  beoordeelResultaat,
  testBron,
  voorbeeldRegels,
  MIN_DEKKING,
  WEINIG_BERICHTEN,
  SELECTOR_TYPES,
};
