// bron-ontdekking.js
//
// Zoekt uit HOE een nieuwe bron het beste automatisch opgehaald kan worden,
// en bewijst dat het werkt voordat het als bron wordt teruggegeven.
//
// Volgorde voor gewoon nieuws (elke stap alleen als de vorige niets bruikbaars opleverde):
//   1. RSS/Atom-feeds        (link-tags in de pagina + gangbare paden)
//   2. WordPress REST API    (ook eigen berichttypes, zoals een agenda)
//   3. JSON-LD               (schema.org Event/Article in de pagina zelf)
//   4. Generieke patronen    (bekende CSS-patronen, geen AI)
//   5. Gemini                (hele pagina, kiest de route, zelfcorrigerende lus)
//
// Voor AGENDA'S (soort agenda, of een url die daar op lijkt) gaat het anders:
//   JSON-LD, patronen en Gemini eerst, feed en REST als laatste redmiddel.
//   Reden: een feed en de REST API geven de PUBLICATIEDATUM van een bericht,
//   een agenda-bron heeft de datum van het EVENEMENT nodig (het agenda-venster
//   in hulpmiddelen.js kijkt van gisteren tot 14 dagen vooruit). Een agenda die
//   via een feed binnenkomt, valt terug op gewoon nieuws (publicatiedatum),
//   met een waarschuwing.
//
// Elke kandidaat gaat door de poort uit bron-poort.js: de echte scraper
// draait erop, en het resultaat moet kloppen (kwaliteit, en bij Gemini ook
// volledigheid). Faalt een kandidaat, dan volgt de volgende stap.
//
// Dit bestand wordt gebruikt door voeg-bron-toe.js (nieuwe bron) en door
// herstel-bronnen.js (een bron die niets meer oplevert opnieuw uitzoeken).
// Er is dus één ontdekkingslogica, geen twee die uit elkaar kunnen lopen.

const cheerio = require("cheerio");
const { haalOp, oorzaakTekst } = require("./hulpmiddelen");
const { testBron, normaliseerUrl, voorbeeldRegels, SELECTOR_TYPES } = require("./bron-poort");
const { probeerGeneriekePatronen } = require("./scrapers/generieke-lijst");

const MAX_KANDIDATEN_REST = 6;
const STANDAARD_FEED_PADEN = ["feed/", "rss", "feed.xml", "rss.xml", "atom.xml"];
const WP_NEGEER_TYPES = new Set([
  "attachment", "page", "nav_menu_item", "wp_block", "wp_template", "wp_template_part",
  "wp_navigation", "wp_global_styles", "wp_font_family", "wp_font_face", "revision",
]);

/** Ziet deze url eruit als een agenda of evenementenpagina? Alleen een hint, nooit een harde regel. */
function agendaAchtig(url) {
  try {
    const u = new URL(url);
    return /agenda|evenement|activiteit|kalender|uitagenda|\bevents?\b/i.test(`${u.hostname}${u.pathname}`);
  } catch {
    return false;
  }
}

/** Alle links op de pagina, genormaliseerd, voor de "hoort dit bij de pagina"-check en het valideren van Gemini's lijst. */
function verzamelPaginaLinks($, paginaUrl) {
  const set = new Set();
  $("a[href]").each((_, el) => {
    const genormaliseerd = normaliseerUrl($(el).attr("href"), paginaUrl);
    if (genormaliseerd) set.add(genormaliseerd);
  });
  return set;
}

/**
 * Welke "soort"-varianten testen we voor een kandidaat? De soort bepaalt hoe
 * datums zonder jaar ("30 sep") gelezen worden, en dat speelt alleen bij
 * recepten die datums uit HTML-tekst halen. Feeds, REST en JSON-LD leveren
 * volledige datums en hebben één variant nodig.
 */
function soortVarianten(type, soortKeuze, url) {
  if (soortKeuze === "agenda") return ["agenda"];
  if (soortKeuze === "nieuws") return [undefined];
  if (!SELECTOR_TYPES.includes(type)) return [undefined];
  return agendaAchtig(url) ? ["agenda", undefined] : [undefined, "agenda"];
}

function noteer(verslag, log, stap, kandidaat, oordeel) {
  const label = `${stap}: ${kandidaat.type}${kandidaat.url ? ` ${kandidaat.url}` : ""}`;
  const uitkomst = oordeel.geslaagd ? (oordeel.twijfel ? "twijfel" : "geslaagd") : "afgekeurd";
  verslag.push({ stap, kandidaat: label, uitkomst, redenen: oordeel.redenen, waarschuwingen: oordeel.waarschuwingen, aantal: oordeel.aantal });
  if (oordeel.geslaagd) {
    log.log(`  ${oordeel.twijfel ? "?" : "✓"} ${label}: ${oordeel.aantal} bericht(en)${oordeel.twijfel ? " (twijfel: hoort mogelijk niet bij deze pagina)" : ""}`);
    voorbeeldRegels(oordeel).forEach((r) => log.log(r));
    oordeel.waarschuwingen.forEach((w) => log.log(`    ⚠️  ${w}`));
  } else {
    log.log(`  ✗ ${label}`);
    oordeel.redenen.forEach((r) => log.log(`      - ${r}`));
  }
}

/** Kandidaat-feeds: alle feed-links in de pagina zelf, daarna gangbare paden. */
function feedKandidaten($, url) {
  const uit = [];
  $('link[rel~="alternate"][type*="rss"], link[rel~="alternate"][type*="atom"]').each((_, el) => {
    try {
      uit.push(new URL($(el).attr("href"), url).toString());
    } catch {
      /* ongeldige href overslaan */
    }
  });
  const origin = new URL(url).origin;
  const paginaMetSlash = url.replace(/[?#].*$/, "").replace(/\/?$/, "/");
  for (const pad of STANDAARD_FEED_PADEN) {
    uit.push(new URL(pad, paginaMetSlash).toString());
    uit.push(new URL(`/${pad}`, origin).toString());
  }
  return [...new Set(uit)];
}

async function probeerTekst(url) {
  try {
    return await haalOp(url, 1, { stil: true });
  } catch {
    return null;
  }
}

/** WordPress REST-kandidaten: eerst de berichttypes waarvan de naam in de pagina-url voorkomt (agenda, nieuws), dan de rest. */
async function restKandidaten($, url) {
  const apiHref = $('link[rel="https://api.w.org/"]').attr("href");
  let apiRoot;
  try {
    apiRoot = new URL(apiHref || "/wp-json/", url).toString();
  } catch {
    return [];
  }
  if (!apiRoot.endsWith("/")) apiRoot += "/";
  if (/[?]/.test(apiRoot)) return []; // ?rest_route=-variant: niet ondersteund, feeds/patronen nemen het over

  const typesTekst = await probeerTekst(new URL("wp/v2/types", apiRoot).toString());
  let types = [];
  if (typesTekst) {
    try {
      const json = JSON.parse(typesTekst);
      types = Object.entries(json)
        .filter(([slug, t]) => t && t.rest_base && !WP_NEGEER_TYPES.has(slug))
        .map(([slug, t]) => ({ slug, restBase: t.rest_base }));
    } catch {
      /* geen JSON: geen REST API (of geblokkeerd) */
    }
  }
  // Geen enkele aanwijzing dat dit WordPress met een REST API is (geen link in de pagina, en de
  // typelijst is niet op te halen)? Dan niet blind endpoints gaan raden.
  if (types.length === 0 && !apiHref) return [];
  if (!types.some((t) => t.restBase === "posts")) types.push({ slug: "post", restBase: "posts" });

  const pad = new URL(url).pathname.toLowerCase();
  const rang = (t) => (pad.includes(t.slug.toLowerCase()) || pad.includes(t.restBase.toLowerCase()) ? 0 : t.slug === "post" ? 2 : 1);
  types.sort((a, b) => rang(a) - rang(b));

  return types.slice(0, MAX_KANDIDATEN_REST).map(
    (t) => new URL(`wp/v2/${t.restBase}?per_page=20&orderby=date&order=desc&_fields=date_gmt,date,link,title,excerpt`, apiRoot).toString()
  );
}

/**
 * Bouwt de definitieve bron-config voor bronnen.js. Volgorde van velden is
 * vast, zodat het bestand leesbaar blijft.
 */
function bouwEindBron(basis, kandidaat, oordeel, soort) {
  const bron = { id: basis.id, naam: basis.naam, categorie: basis.categorie, type: kandidaat.type, url: kandidaat.url };
  if (soort) bron.soort = soort;
  if (oordeel.rustig) bron.rustig = true;
  if (kandidaat.selectors) bron.selectors = kandidaat.selectors;
  if (kandidaat.json) bron.json = kandidaat.json;
  return bron;
}

/**
 * Bepaalt of de bron een agenda is. Een expliciete keuze wint altijd; anders
 * wint agenda als de bron de agenda-datumlezing nodig had, als de url naar
 * een agenda wijst, of als een groot deel van de datums in de toekomst ligt.
 */
function kiesSoort(soortKeuze, gebruiktSoort, url, oordeel) {
  if (soortKeuze === "agenda" || soortKeuze === "nieuws") return soortKeuze === "agenda" ? "agenda" : undefined;
  if (gebruiktSoort === "agenda") return "agenda";
  const metDatum = oordeel.statistieken.metDatum || 0;
  const toekomst = oordeel.statistieken.toekomst || 0;
  if (agendaAchtig(url) || (metDatum >= 3 && toekomst / metDatum >= 0.4)) return "agenda";
  return undefined;
}

/**
 * Hoofdfunctie.
 *
 * opties: { url, id, naam, categorie, soort: "auto"|"nieuws"|"agenda",
 *           apiKey, vraagGemini (voor tests), log }
 * Geeft terug: { bron, oordeel, verslag, twijfelachtig, fout }
 *   bron === null als niets de poort haalde. twijfelachtig === true als er
 *   alleen een kandidaat is die slaagde maar mogelijk niet bij de pagina hoort.
 */
async function ontdekBron(opties) {
  const { url, id, categorie = "lokaal", soort: soortKeuze = "auto", apiKey, vraagGemini, log = console } = opties;
  const naam = opties.naam || id;
  const basis = { id, naam, categorie };
  const verslag = [];

  log.log(`Bron ophalen: ${url}`);
  let html;
  try {
    html = await haalOp(url);
  } catch (fout) {
    return { bron: null, oordeel: null, verslag, fout: `Kon de pagina niet ophalen: ${fout.message}${oorzaakTekst(fout)}` };
  }
  const $ = cheerio.load(html);
  const paginaLinks = verzamelPaginaLinks($, url);

  let reserve = null; // geslaagde maar twijfelachtige kandidaat, alleen te gebruiken als niets anders lukt
  const agendaVoorkeur = soortKeuze === "agenda" || (soortKeuze === "auto" && agendaAchtig(url));

  /**
   * Test een kandidaat via de poort, met de juiste soort-varianten. Geeft
   * { bron, oordeel } van de eerste variant die slaagt, anders van de eerste.
   */
  async function testKandidaat(kandidaat, extra = {}) {
    let eerste = null;
    for (const variant of soortVarianten(kandidaat.type, soortKeuze, url)) {
      const testBronConfig = { ...basis, ...kandidaat, ...(variant ? { soort: variant } : {}) };
      const oordeel = await testBron(testBronConfig, { siteUrl: url, ...extra });
      const resultaat = { kandidaat, oordeel, gebruiktSoort: variant };
      if (oordeel.geslaagd) return resultaat;
      if (!eerste) eerste = resultaat;
    }
    return eerste;
  }

  /**
   * Verwerkt een uitkomst: geeft het eindresultaat terug als de kandidaat goed is, anders null.
   * datumSoort: "publicatie" voor methodes die de publicatiedatum leveren (feed, REST, JSON-API),
   * "gebeurtenis" voor methodes die de datum uit de pagina lezen (patronen, Gemini, JSON-LD).
   * Een publicatiedatum past niet bij het agenda-venster, dus zulke bronnen krijgen nooit soort agenda.
   */
  function verwerk(stap, resultaat, datumSoort = "gebeurtenis") {
    noteer(verslag, log, stap, resultaat.kandidaat, resultaat.oordeel);
    if (!resultaat.oordeel.geslaagd) return null;
    let soort;
    if (datumSoort === "publicatie") {
      soort = undefined;
      if (soortKeuze === "agenda" || agendaVoorkeur) {
        const w = "Deze methode levert de publicatiedatum van berichten, niet de datum van het evenement. De bron wordt daarom als gewoon nieuws opgeslagen: nieuw geplaatste evenementen verschijnen, evenementen die al lang op de site staan niet.";
        resultaat.oordeel.waarschuwingen.push(w);
        log.log(`    ⚠️  ${w}`);
      }
    } else {
      soort = kiesSoort(soortKeuze, resultaat.gebruiktSoort, url, resultaat.oordeel);
    }
    const bron = bouwEindBron(basis, resultaat.kandidaat, resultaat.oordeel, soort);
    if (resultaat.oordeel.twijfel) {
      if (!reserve) reserve = { bron, oordeel: resultaat.oordeel };
      return null;
    }
    return { bron, oordeel: resultaat.oordeel, verslag };
  }

  let geminiFout = null;
  const stappen = {
    feed: async () => {
      const feeds = feedKandidaten($, url);
      log.log(`RSS/Atom-feeds proberen (${feeds.length} kandidaten)...`);
      for (const feedUrl of feeds) {
        const tekst = await probeerTekst(feedUrl);
        // Veel sites geven bij een onbestaand feed-pad gewoon een HTML-pagina terug (soft 404): dat is geen feed.
        if (!tekst || !/<(rss|feed|rdf:RDF)[\s>]/i.test(tekst.slice(0, 2000))) continue;
        const klaar = verwerk("feed", await testKandidaat({ type: "rss", url: feedUrl }, { paginaLinks }), "publicatie");
        if (klaar) return klaar;
      }
      return null;
    },

    "wp-rest": async () => {
      log.log("WordPress REST API proberen...");
      const rest = await restKandidaten($, url);
      if (rest.length === 0) log.log("  (geen REST API gevonden)");
      for (const endpoint of rest) {
        const klaar = verwerk("wp-rest", await testKandidaat({ type: "wp-rest", url: endpoint }, { paginaLinks }), "publicatie");
        if (klaar) return klaar;
      }
      return null;
    },

    "json-ld": async () => {
      log.log("JSON-LD (schema.org) proberen...");
      if ($('script[type="application/ld+json"]').length === 0) {
        log.log("  (geen JSON-LD in de pagina)");
        return null;
      }
      return verwerk("json-ld", await testKandidaat({ type: "json-ld", url }, { paginaLinks }));
    },

    generiek: async () => {
      log.log("Generieke patronen proberen...");
      const generiek = probeerGeneriekePatronen($, { ...basis, url, ...(agendaVoorkeur ? { soort: "agenda" } : {}) });
      if (!generiek) {
        log.log("  (geen enkel generiek patroon leverde 3 bruikbare berichten)");
        return null;
      }
      log.log(`  Patroon "${generiek.selector}" vond ${generiek.berichten.length} bericht(en), nu testen met de echte scraper...`);
      return verwerk("generieke-lijst", await testKandidaat({ type: "generieke-lijst", url }));
    },

    gemini: async () => {
      if (!apiKey && !vraagGemini) {
        log.log("Gemini: overgeslagen (geen GEMINI_API_KEY beschikbaar).");
        geminiFout = "Gemini-stap overgeslagen: geen GEMINI_API_KEY.";
        verslag.push({ stap: "gemini", kandidaat: "gemini", uitkomst: "overgeslagen", redenen: [geminiFout], waarschuwingen: [], aantal: 0 });
        return null;
      }
      log.log("Gemini laten kijken naar de hele pagina...");
      const { geminiPad } = require("./gemini-recept-lus");
      const uitkomst = await geminiPad({ $, html, url, paginaLinks, apiKey, vraagGemini, testKandidaat, verwerk, verslag, log });
      return uitkomst.klaar || null;
    },
  };

  const volgorde = agendaVoorkeur ? ["json-ld", "generiek", "gemini", "feed", "wp-rest"] : ["feed", "wp-rest", "json-ld", "generiek", "gemini"];
  if (agendaVoorkeur) {
    log.log("\nDit lijkt een agenda: eerst methodes die de datum van het evenement geven, feed en REST (publicatiedatum) als laatste redmiddel.");
  }
  let stapNummer = 0;
  for (const naamStap of volgorde) {
    stapNummer++;
    log.log(`\nStap ${stapNummer}/${volgorde.length}: ${naamStap}`);
    const klaar = await stappen[naamStap]();
    if (klaar) return klaar;
  }

  // --- Reserve: slaagde wel, maar hoort mogelijk niet bij de pagina ---
  if (reserve) {
    log.log("\nAlleen een twijfelachtige kandidaat gevonden (slaagt de poort, maar staat niet als link op de pagina).");
    return { bron: reserve.bron, oordeel: reserve.oordeel, verslag, twijfelachtig: true };
  }

  return { bron: null, oordeel: null, verslag, fout: "Geen enkele methode haalde de poort." };
}

/** Maakt een leesbaar rapport (markdown) van wat er geprobeerd is. Voor de log, de Actions-samenvatting en issues. */
function maakRapport({ url, id, verslag, fout }) {
  const regels = [`## Bron ${id}: wat er geprobeerd is`, "", `Pagina: ${url}`, ""];
  if (fout) regels.push(`**Uitkomst:** ${fout}`, "");
  for (const v of verslag) {
    regels.push(`- **${v.uitkomst}** ${v.kandidaat}${v.aantal ? ` (${v.aantal} bericht(en))` : ""}`);
    for (const r of v.redenen || []) regels.push(`  - ${r}`);
    for (const w of v.waarschuwingen || []) regels.push(`  - waarschuwing: ${w}`);
  }
  regels.push("");
  return regels.join("\n");
}

/** Zet tekst op de samenvattingspagina van een GitHub Actions-run (als we in Actions draaien). Voor andere omgevingen een no-op. */
function schrijfStapSamenvatting(markdown) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  try {
    require("fs").appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  } catch {
    /* de samenvatting is een extraatje, nooit een reden om te falen */
  }
}

module.exports = { ontdekBron, maakRapport, agendaAchtig, verzamelPaginaLinks, soortVarianten, schrijfStapSamenvatting };
