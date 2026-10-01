// scrapers/ibabs.js
//
// Haalt raadsinformatie op uit iBabs (*.bestuurlijkeinformatie.nl) via de
// onderliggende DataTables-API van de rapportpagina, in plaats van de pagina
// zelf met een browser te laten renderen. Deze aanpak — inclusief de
// tussenstap om via de detailpagina eerst de documentId te vinden voordat de
// pdf gedownload kan worden — is overgenomen uit een al werkend Python-
// scraper-script voor hetzelfde iBabs-systeem. Vereist GEEN Playwright/browser.
//
// BELANGRIJK VOOR SNELHEID: het ophalen van de volledige documentinhoud (een
// extra pagina-load + pdf-download per bericht) is duur. Daarom wordt dat
// alleen gedaan voor berichten die (a) niet ouder zijn dan MAX_LEEFTIJD_DAGEN
// en (b) nog niet eerder gezien zijn (via de gezieneUrls-set die index.js
// meegeeft). Zonder die twee filters zou elke dagelijkse run opnieuw de
// documentinhoud van alle ~100 berichten per rapport ophalen, ook van
// berichten die al weken geleden al eens verwerkt zijn — dat duurde in de
// praktijk 30+ minuten voor niets.

const MAX_DOCUMENT_TEKST_LENGTE = 3000; // cap zodat de Gemini-prompt niet buitensporig groot wordt
const REQUEST_TIMEOUT_MS = 15_000; // voorkomt dat één tragere/hangende iBabs-pagina de hele run ophoudt

const { binnenLeeftijdsgrens, MAX_LEEFTIJD_DAGEN, oorzaakTekst } = require("../hulpmiddelen");

let pdfParse;
try {
  pdfParse = require("pdf-parse");
} catch {
  pdfParse = null; // ontbreekt pdf-parse (bv. niet geïnstalleerd) — pdf's worden dan overgeslagen, geen crash
}

const BASE_URL = "https://zaanstad.bestuurlijkeinformatie.nl";
const PAGE_SIZE = 100;

const KOLOMMEN = [
  ["title", false],
  ["datumbericht", true],
  ["portefeuillehouderselectie", true],
  ["typeselectie", true],
  ["afhandelingselectie", true],
  ["registrationdate", true],
  // Niet elk iBabs-rapport gebruikt hetzelfde kolomschema — "Ingekomen
  // stukken" heeft bijvoorbeeld geen "datumbericht"/"registrationdate",
  // maar "datum" ("Datum invoer") en "datumpublicatie" ("Datum publicatie").
  // Onschadelijk om dit voor ALLE ibabs-rapporten op te vragen: een rapport
  // dat deze velden niet heeft, geeft er gewoon niets voor terug (zoals we
  // al zagen bij datumbericht/registrationdate voor dít rapport) — het
  // breekt niets voor rapporten die het al bij het oude kon.
  ["datum", true],
  ["datumpublicatie", true],
];

const GEBRUIKERSAGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

async function scrapeIbabs(bron, gezieneUrls = new Set()) {
  const guidMatch = bron.url.match(/Reports\/Details\/([a-f0-9-]{36})/i);
  if (!guidMatch) {
    console.warn(`[${bron.id}] Kon geen rapport-GUID uit de URL halen: ${bron.url}`);
    return [];
  }
  const guid = guidMatch[1];
  const lijstPageUrl = bron.url;
  const lijstDataUrl = `${BASE_URL}/Reports/GetReportData/${guid}`;

  let cookie = "";
  try {
    const sessieResponse = await fetchMetTimeout(lijstPageUrl, { headers: { "User-Agent": GEBRUIKERSAGENT } });
    cookie = verzamelCookies(sessieResponse);
  } catch (fout) {
    console.warn(`[${bron.id}] Sessie ophalen mislukt (${fout.message}${oorzaakTekst(fout)}) — doorgaan zonder cookie.`);
  }

  let rijen;
  try {
    const response = await fetchMetTimeout(lijstDataUrl, {
      method: "POST",
      headers: {
        "User-Agent": GEBRUIKERSAGENT,
        Accept: "application/json, text/javascript, */*; q=0.01",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        Origin: BASE_URL,
        Referer: lijstPageUrl,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: bouwLijstBody(0, 1),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    rijen = data.data || [];
  } catch (fout) {
    console.error(`[${bron.id}] Lijst ophalen mislukt: ${fout.message}${oorzaakTekst(fout)}`);
    return [];
  }

  const alleBerichten = rijen.map((rij) => normaliseerRij(rij, bron)).filter((b) => b.titel);

  const zonderDatum = alleBerichten.filter((b) => !b.gepubliceerdOp);
  if (zonderDatum.length > 0) {
    console.warn(`[${bron.id}] ${zonderDatum.length} van ${alleBerichten.length} berichten hadden geen herkenbare datum (datumbericht/registrationdate kon niet geparsed worden) — die tellen mee als "te oud" en worden overgeslagen.`);
    // Diagnostisch, geen gok: laat de ruwe datumvelden van een paar
    // voorbeelden zien. Als dit structureel is voor dit rapport (zoals bij
    // ingekomen-stukken), zien we hier meteen het échte veld/formaat in
    // plaats van daar blind naar te moeten raden.
    const voorbeelden = rijen
      .filter((rij) => !parseerNlDatum(rij.datumbericht) && !parseerNlDatum(rij.registrationdate))
      .slice(0, 3);
    for (const rij of voorbeelden) {
      console.warn(
        `[${bron.id}]   voorbeeld — datumbericht: ${JSON.stringify(rij.datumbericht)}, registrationdate: ${JSON.stringify(rij.registrationdate)}, alle velden: ${Object.keys(rij).join(", ")}`
      );
    }
  }

  // Filter 1: niet ouder dan MAX_LEEFTIJD_DAGEN, via de centrale functie in
  // hulpmiddelen.js — dus ook hier geldt: geen betrouwbare datum = eruit,
  // niet uit voorzichtigheid meegenomen.
  const recenteBerichten = alleBerichten.filter((b) => binnenLeeftijdsgrens(b.gepubliceerdOp));
  const aantalTeOud = alleBerichten.length - recenteBerichten.length;
  if (aantalTeOud > 0) {
    console.log(`[${bron.id}] ${aantalTeOud} bericht(en) ouder dan ${MAX_LEEFTIJD_DAGEN} dagen overgeslagen.`);
  }

  // Filter 2: al eerder geziene berichten hoeven geen nieuwe documentinhoud —
  // die worden dan ook door index.js's dedup weggefilterd, dus we besparen
  // onszelf hier alvast de dure ophaalstap.
  const nieuweBerichten = recenteBerichten.filter((b) => !gezieneUrls.has(b.url));
  const aantalAlGezien = recenteBerichten.length - nieuweBerichten.length;
  if (aantalAlGezien > 0) {
    console.log(`[${bron.id}] ${aantalAlGezien} al eerder gezien bericht(en) overgeslagen (geen nieuwe documentinhoud nodig).`);
  }

  console.log(`[${bron.id}] ${nieuweBerichten.length} bericht(en) waarvoor documentinhoud wordt opgehaald.`);

  const compleetBerichten = [];
  let teller = 0;
  for (const bericht of nieuweBerichten) {
    teller++;
    const berichtMetInhoud = await voegDocumentInhoudToe(bericht, cookie);
    if (teller % 10 === 0) {
      console.log(`[${bron.id}] documentinhoud opgehaald: ${teller}/${nieuweBerichten.length}`);
    }
    compleetBerichten.push(berichtMetInhoud);
  }

  return compleetBerichten;
}

async function fetchMetTimeout(url, opties = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opties, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function verzamelCookies(response) {
  const ruw =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);
  return ruw.map((c) => c.split(";")[0]).join("; ");
}

function bouwLijstBody(start, draw) {
  const params = new URLSearchParams();
  params.set("draw", String(draw));
  KOLOMMEN.forEach(([naam, heeftPipe], i) => {
    params.set(`columns[${i}][data]`, naam);
    params.set(`columns[${i}][name]`, naam);
    params.set(`columns[${i}][searchable]`, "true");
    params.set(`columns[${i}][orderable]`, "true");
    params.set(`columns[${i}][search][value]`, heeftPipe ? "|" : "");
    params.set(`columns[${i}][search][regex]`, "false");
  });
  params.set("order[0][column]", "5");
  params.set("order[0][dir]", "desc");
  params.set("order[0][name]", "registrationdate");
  params.set("start", String(start));
  params.set("length", String(PAGE_SIZE));
  params.set("search[value]", "");
  params.set("search[regex]", "false");
  return params.toString();
}

function normaliseerRij(rij, bron) {
  return {
    bronId: bron.id,
    bronNaam: bron.naam,
    categorie: bron.categorie,
    titel: (rij.title || "").trim(),
    itemId: rij.DT_RowId,
    url: rij.DT_RowId ? `${BASE_URL}/Reports/Item/${rij.DT_RowId}` : bron.url,
    samenvatting: [rij.typeselectie, rij.portefeuillehouderselectie, rij.afhandelingselectie]
      .filter(Boolean)
      .join(" — "),
    gepubliceerdOp:
      parseerNlDatum(rij.datumbericht) ||
      parseerNlDatum(rij.datumpublicatie) ||
      parseerNlDatum(rij.datum) ||
      parseerNlDatum(rij.registrationdate),
    opgehaaldOp: new Date().toISOString(),
  };
}

function parseerNlDatum(tekst) {
  if (!tekst) return null;
  const match = String(tekst).match(/(\d{1,2})-(\d{1,2})-(\d{4})/);
  if (!match) return null;
  const [, dag, maand, jaar] = match;
  const datum = new Date(Number(jaar), Number(maand) - 1, Number(dag));
  return isNaN(datum.getTime()) ? null : datum.toISOString();
}

/**
 * Volgt dezelfde tweestapsroute als het werkende Python-script: eerst de
 * detailpagina van het item ophalen om de documentId te vinden, dan pas de
 * pdf zelf downloaden. Faalt dit, dan blijft het bericht gewoon staan met
 * alleen de tabelgegevens — geen crash voor de rest van de run. Elke
 * netwerkaanvraag heeft een timeout, zodat één trage pagina niet de hele
 * run kan ophouden.
 */
async function voegDocumentInhoudToe(bericht, cookie) {
  if (!bericht.itemId) return { ...bericht, documentInhoudOpgehaald: false };

  try {
    const itemUrl = `${BASE_URL}/Reports/Item/${bericht.itemId}`;
    const itemResponse = await fetchMetTimeout(itemUrl, {
      headers: {
        "User-Agent": GEBRUIKERSAGENT,
        Accept: "text/html",
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });
    if (!itemResponse.ok) throw new Error(`detailpagina HTTP ${itemResponse.status}`);
    const html = await itemResponse.text();

    const documentIdMatch =
      html.match(new RegExp(`/Reports/Document/${bericht.itemId}\\?documentId=([a-f0-9-]{36})`)) ||
      html.match(/documentId=([a-f0-9-]{36})/);
    if (!documentIdMatch) {
      return { ...bericht, documentInhoudOpgehaald: false };
    }
    const documentId = documentIdMatch[1];

    const pdfUrl = `${BASE_URL}/Document/View/${documentId}`;
    const pdfResponse = await fetchMetTimeout(pdfUrl, {
      headers: {
        "User-Agent": GEBRUIKERSAGENT,
        Referer: itemUrl,
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });
    if (!pdfResponse.ok) throw new Error(`pdf HTTP ${pdfResponse.status}`);

    const buffer = Buffer.from(await pdfResponse.arrayBuffer());
    if (buffer.subarray(0, 4).toString() !== "%PDF") {
      return { ...bericht, documentInhoudOpgehaald: false };
    }
    if (!pdfParse) {
      console.warn(`[${bericht.bronId}] pdf-parse niet beschikbaar — pdf overgeslagen voor "${bericht.titel}".`);
      return { ...bericht, documentInhoudOpgehaald: false };
    }

    const data = await pdfParse(buffer);
    const documentTekst = (data.text || "").replace(/\s+/g, " ").trim().slice(0, MAX_DOCUMENT_TEKST_LENGTE);

    return {
      ...bericht,
      url: pdfUrl,
      samenvatting: [bericht.samenvatting, documentTekst].filter(Boolean).join(" — "),
      documentInhoudOpgehaald: documentTekst.length > 0,
    };
  } catch (fout) {
    console.warn(`[${bericht.bronId}] Kon documentinhoud niet ophalen voor "${bericht.titel}": ${fout.message}${oorzaakTekst(fout)}`);
    return { ...bericht, documentInhoudOpgehaald: false };
  }
}

module.exports = { scrapeIbabs };
