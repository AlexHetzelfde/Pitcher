// hulpmiddelen.js
// Gedeelde functies die door meerdere scrapers gebruikt worden.

const Parser = require("rss-parser");
const rssParser = new Parser();
const tls = require("tls");
const crypto = require("crypto");
const { Agent } = require("undici");

const GEBRUIKERSAGENT =
  "NieuwsaggregatorZaanstreekBot/1.0 (+journalistiek studentenproject; contact via github repo)";

// Centrale leeftijdsgrens: berichten ouder dan dit worden nergens meegenomen.
// Dit staat hier, op ÉÉN plek, en wordt door zowel index.js (als centrale,
// gezaghebbende filter voor ALLE bronnen) als door ibabs.js (als vroege
// filter, vóór het dure documentinhoud-ophalen) gebruikt — nooit los
// gedupliceerd per scraper.
const MAX_LEEFTIJD_DAGEN = 7;

/**
 * True als een datum binnen de leeftijdsgrens valt. Een bericht ZONDER
 * betrouwbaar herkende datum telt hier bewust als "te oud"/niet toegestaan —
 * niet als "onbekend dus maar meenemen". Dat laatste zorgde er in de praktijk
 * voor dat een kapotte datumherkenning van een bron (zoals gebeurde bij de
 * WordPress-fallback en bij één van de iBabs-rapporten) onopgemerkt bleef en
 * alle historische berichten liet doorsijpelen in plaats van alleen recente.
 * Een bron waarvan structureel geen datum wordt herkend, levert nu dus 0
 * berichten op — zichtbaar fout, in plaats van onzichtbaar fout.
 */
function binnenLeeftijdsgrens(gepubliceerdOpIso) {
  if (!gepubliceerdOpIso) return false;
  const datum = new Date(gepubliceerdOpIso);
  if (isNaN(datum.getTime())) return false;
  const grens = Date.now() - MAX_LEEFTIJD_DAGEN * 24 * 60 * 60 * 1000;
  return datum.getTime() >= grens;
}

// Agenda-bronnen (bron.soort === "agenda") tonen vooral evenementen die nog moeten
// komen. Daar geldt een ander venster: niet "maximaal 7 dagen oud", maar "van
// gisteren tot een aantal dagen vooruit". De datum is de datum van het
// evenement, niet van publicatie. Een evenement over drie maanden is geen
// tip voor vandaag; het verschijnt vanzelf zodra het binnen het venster valt
// (de dagelijkse run onthoudt alleen berichten die het venster gepasseerd zijn).
const AGENDA_MAX_VERLEDEN_DAGEN = Number(process.env.AGENDA_MAX_VERLEDEN_DAGEN || 1);
const AGENDA_MAX_VOORUIT_DAGEN = Number(process.env.AGENDA_MAX_VOORUIT_DAGEN || 14);

function binnenAgendaVenster(gepubliceerdOpIso) {
  if (!gepubliceerdOpIso) return false;
  const datum = new Date(gepubliceerdOpIso);
  if (isNaN(datum.getTime())) return false;
  const dag = 24 * 60 * 60 * 1000;
  const nu = Date.now();
  return datum.getTime() >= nu - AGENDA_MAX_VERLEDEN_DAGEN * dag && datum.getTime() <= nu + AGENDA_MAX_VOORUIT_DAGEN * dag;
}

/**
 * Het venster voor één bron: het agenda-venster voor agenda-bronnen, de
 * gewone leeftijdsgrens voor alle andere. index.js gebruikt deze functie voor
 * de centrale filter, zodat elke bron precies één regel krijgt.
 */
function binnenVenster(gepubliceerdOpIso, bron) {
  return bron && bron.soort === "agenda" ? binnenAgendaVenster(gepubliceerdOpIso) : binnenLeeftijdsgrens(gepubliceerdOpIso);
}

/**
 * Leeftijd van een bericht in dagen (kan een fractie zijn), of null als er
 * geen betrouwbare datum is. Wordt door score.js gebruikt voor de
 * recency-bonus.
 */
function leeftijdInDagen(gepubliceerdOpIso) {
  if (!gepubliceerdOpIso) return null;
  const datum = new Date(gepubliceerdOpIso);
  if (isNaN(datum.getTime())) return null;
  return (Date.now() - datum.getTime()) / (24 * 60 * 60 * 1000);
}

/**
 * Node's ingebouwde fetch (undici) gooit bij netwerkproblemen bijna altijd
 * alleen de generieke `TypeError: fetch failed` als `.message` — de échte
 * reden (DNS, timeout, connectie geweigerd, TLS-probleem, ...) zit dan in
 * `.cause`, die door Node zelf NIET wordt meegeprint met `fout.message`.
 * Deze helper haalt die oorzaak eruit zodat we hem overal waar we een
 * fetch-fout loggen ook echt kunnen zien, in plaats van alleen "fetch
 * failed" zonder verdere context.
 */
function oorzaakTekst(fout) {
  const oorzaak = fout && fout.cause;
  if (!oorzaak) return "";
  const code = oorzaak.code ? ` [${oorzaak.code}]` : "";
  const tekst = oorzaak.message || String(oorzaak);
  return ` — oorzaak: ${tekst}${code}`;
}

/**
 * Sommige servers (met name kleinere overheids-/instellingshosting, zo blijkt
 * bij loket.zaanstad.nl) sturen bij het TLS-handshaken niet hun volledige
 * certificaatketen mee — ze vergeten het tussencertificaat. Een browser merkt
 * dit nooit, want die repareert het stilzwijgend zelf: hij haalt het
 * ontbrekende tussencertificaat op via een link die IN het certificaat zelf
 * staat (de "Authority Information Access"-extensie, "AIA-fetching"). Node
 * doet dat niet, en faalt dan met UNABLE_TO_VERIFY_LEAF_SIGNATURE.
 *
 * Deze functie doet precies wat de browser doet:
 *   1. Verbindt zonder verificatie, puur om het certificaat te lezen.
 *   2. Leest daaruit de CA-Issuers-URL.
 *   3. Haalt het ontbrekende certificaat daar op (bij de CA zelf, niet bij de
 *      oorspronkelijke server — dát certificaat kunnen we dus wél vertrouwen).
 *   4. Geeft een fetch-optie ({ dispatcher }) terug die dat certificaat
 *      toevoegt aan de normale vertrouwde root-certificaten (niet in de
 *      plaats daarvan), zodat verder niets aan vertrouwen inlevert.
 *
 * Geeft null terug als het niet lukt (bv. geen AIA-extensie aanwezig, of de
 * download zelf faalt) — dan blijft de oorspronkelijke fout gewoon staan en
 * verandert er niets aan het bestaande gedrag.
 */
async function probeerKetenTeRepareren(url) {
  const { hostname, port, protocol } = new URL(url);
  const tlsPoort = Number(port) || (protocol === "http:" ? 80 : 443);

  let leafCertRaw;
  try {
    leafCertRaw = await new Promise((resolve, reject) => {
      const socket = tls.connect(
        { host: hostname, port: tlsPoort, servername: hostname, rejectUnauthorized: false, timeout: 10_000 },
        () => {
          const cert = socket.getPeerCertificate(false);
          socket.end();
          resolve(cert && cert.raw);
        }
      );
      socket.on("error", reject);
      socket.on("timeout", () => {
        socket.destroy();
        reject(new Error("TLS-verbinding voor ketenreparatie liep vast op een timeout"));
      });
    });
  } catch {
    return null;
  }
  if (!leafCertRaw) return null;

  // Volg de "CA Issuers"-link net zoals een browser dat doet: van het
  // certificaat naar zijn uitgever, en van díé weer naar zíjn uitgever,
  // net zo lang tot er geen link meer is (dan zijn we vermoedelijk bij de
  // root aanbeland, die zichzelf ondertekent en dus geen uitgever-link
  // heeft). Zo repareren we niet alleen een ontbrekend tussencertificaat,
  // maar ook het geval waarin zelfs de root nog niet in Node's eigen
  // meegeleverde lijst zit (bijvoorbeeld bij een overheids-PKI).
  const extraCertificaten = [];
  const gebruikteUrls = [];
  let huidigCertRaw = leafCertRaw;
  const MAX_STAPPEN = 5;

  for (let stap = 0; stap < MAX_STAPPEN; stap++) {
    let x509;
    try {
      x509 = new crypto.X509Certificate(huidigCertRaw);
    } catch {
      break;
    }

    const infoAccess = x509.infoAccess || "";
    const match = infoAccess.match(/CA Issuers - URI:(\S+)/);
    if (!match) break; // geen verdere link meer -- keten is klaar
    const issuerUrl = match[1];

    let issuerBuffer;
    try {
      const response = await fetch(issuerUrl);
      if (!response.ok) break;
      issuerBuffer = Buffer.from(await response.arrayBuffer());
    } catch {
      break;
    }

    let issuerPem;
    let issuerRaw;
    try {
      const tekst = issuerBuffer.toString("utf-8");
      if (tekst.includes("BEGIN CERTIFICATE")) {
        issuerPem = tekst;
        issuerRaw = new crypto.X509Certificate(tekst).raw;
      } else {
        const x = new crypto.X509Certificate(issuerBuffer); // DER-formaat
        issuerPem = x.toString();
        issuerRaw = issuerBuffer;
      }
    } catch {
      break;
    }

    extraCertificaten.push(issuerPem);
    gebruikteUrls.push(issuerUrl);
    huidigCertRaw = issuerRaw;
  }

  if (extraCertificaten.length === 0) return null;

  const agent = new Agent({ connect: { ca: [...tls.rootCertificates, ...extraCertificaten] } });
  return { dispatcher: agent, issuerUrl: gebruikteUrls.join(" -> ") };
}

/**
 * Sommige sites (vaak sessie-gebaseerde overheidsportalen of anti-bot-
 * bescherming, zo blijkt ook bij loket.zaanstad.nl) sturen bij het eerste
 * bezoek een sessie-cookie mee en blijven doorverwijzen totdat die cookie
 * wordt teruggestuurd. Een browser doet dat automatisch; Node's fetch() heeft
 * geen ingebouwde cookie-jar en blijft daardoor eindeloos heen-en-weer
 * gestuurd worden, tot hij opgeeft met "redirect count exceeded".
 *
 * Deze functie volgt redirects zelf (net als een browser doet — dus ook
 * bruikbaar in combinatie met een `dispatcher` van probeerKetenTeRepareren,
 * via de optionele `opties`), houdt cookies bij tussen de hops in, en geeft
 * de uiteindelijke pagina-inhoud terug.
 */
async function haalOpMetCookies(url, opties = {}, maxHops = 20) {
  const cookieJar = new Map();
  let huidigeUrl = url;

  for (let hop = 0; hop < maxHops; hop++) {
    const headers = { ...opties.headers };
    if (cookieJar.size > 0) {
      headers["Cookie"] = [...cookieJar].map(([naam, waarde]) => `${naam}=${waarde}`).join("; ");
    }
    const response = await fetch(huidigeUrl, { ...opties, headers, redirect: "manual" });

    const nieuweCookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
    for (const regel of nieuweCookies) {
      const [naamWaarde] = regel.split(";");
      const gelijkteken = naamWaarde.indexOf("=");
      if (gelijkteken > 0) {
        cookieJar.set(naamWaarde.slice(0, gelijkteken).trim(), naamWaarde.slice(gelijkteken + 1).trim());
      }
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const locatie = response.headers.get("location");
      if (!locatie) throw new Error(`Redirect (${response.status}) zonder Location-header op ${huidigeUrl}`);
      huidigeUrl = new URL(locatie, huidigeUrl).toString();
      continue;
    }

    if (!response.ok) throw new Error(`HTTP ${response.status} voor ${huidigeUrl}`);
    return await response.text();
  }
  throw new Error(`Ook mét cookies nog steeds meer dan ${maxHops} redirects — vermoedelijk een echte lus, geen sessieprobleem`);
}

/**
 * Fallback voor als er géén los datum-element op de pagina staat, maar de
 * datum wel ergens in de tekst zelf verstopt zit — zoals bij de Zaanstad-
 * hoorzittingen, waar de titel letterlijk begint met "2026-09-22 Dinsdag 22
 * september 2026 om 17.15 uur - ...". Gemini herkent dat soort titels dan
 * terecht niet als een apart datum-element (dat is het ook niet), maar we
 * kunnen de datum alsnog uit de tekst zelf halen.
 *
 * Probeert eerst een ISO-datum (YYYY-MM-DD, vaak als machine-leesbare
 * sorteersleutel vooraan de tekst), dan een Nederlandse "22 september
 * 2026"-vorm, en alleen met { zonderJaar: true } ook "30 sep" of "30 september"
 * zonder jaar (zie haalDatumZonderJaar). Geeft null terug als niets herkend wordt.
 *
 * Let op de grenzen: er staat bewust (?<!\d) en (?!\d) in plaats van \b. Bij
 * tekst uit HTML zonder spaties ("1 oktober 2026Evenement 2: ...") zit er
 * geen woordgrens tussen het cijfer en de letter, waardoor \b de datum miste.
 */
const NEDERLANDSE_MAANDEN = {
  januari: 0, februari: 1, maart: 2, april: 3, mei: 4, juni: 5,
  juli: 6, augustus: 7, september: 8, oktober: 9, november: 10, december: 11,
};

const MAANDEN_LANG = "januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december";
// Afkortingen zoals agenda's ze schrijven ("30 sep", "1 okt", "12 mrt").
const MAANDEN_KORT = { jan: 0, feb: 1, mrt: 2, apr: 3, mei: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, okt: 9, nov: 10, dec: 11 };
const MAAND_ALLES = `${MAANDEN_LANG}|jan|feb|mrt|apr|jun|jul|aug|sept?|okt|nov|dec`;

function haalDatumUitTekst(tekst, opties = {}) {
  if (!tekst) return null;

  const iso = tekst.match(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/);
  if (iso) {
    const d = new Date(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00`);
    if (!isNaN(d.getTime())) return d.toISOString();
  }

  const nl = tekst.match(new RegExp(`(?<!\\d)(\\d{1,2})\\s+(${MAANDEN_LANG})\\s+(\\d{4})(?!\\d)`, "i"));
  if (nl) {
    const maand = NEDERLANDSE_MAANDEN[nl[2].toLowerCase()];
    const d = new Date(Number(nl[3]), maand, Number(nl[1]));
    if (!isNaN(d.getTime())) return d.toISOString();
  }

  if (opties.zonderJaar) return haalDatumZonderJaar(tekst, opties.nu);
  return null;
}

/**
 * Leest een datum zonder jaartal ("30 sep", "1 oktober", "27 sep6 sep"), zoals
 * agenda's die tonen. Het jaar wordt afgeleid: het jaar waarbij de datum het
 * dichtst bij vandaag ligt (dus in december wordt "3 jan" volgend jaar, en in
 * januari wordt "28 dec" vorig jaar). Bij een bereik ("30 sep11 okt") telt de
 * EERSTE datum, de startdatum. Geeft null als er geen datum in staat.
 *
 * Bewust alleen te gebruiken als de bron als agenda is gemarkeerd: bij
 * gewoon nieuws is een datum zonder jaar te dubbelzinnig om aan te nemen.
 */
function haalDatumZonderJaar(tekst, nu = new Date()) {
  if (!tekst) return null;
  const m = String(tekst).match(new RegExp(`(?<!\\d)(\\d{1,2})\\s*(${MAAND_ALLES})\\.?(?![a-z])`, "i"));
  if (!m) return null;
  const dag = Number(m[1]);
  const sleutel = m[2].toLowerCase();
  const maand = NEDERLANDSE_MAANDEN[sleutel] ?? MAANDEN_KORT[sleutel];
  if (maand === undefined || dag < 1 || dag > 31) return null;

  let beste = null;
  for (const jaar of [nu.getFullYear() - 1, nu.getFullYear(), nu.getFullYear() + 1]) {
    const d = new Date(jaar, maand, dag);
    if (d.getMonth() !== maand) continue; // bestaat niet, zoals 31 februari
    if (!beste || Math.abs(d - nu) < Math.abs(beste - nu)) beste = d;
  }
  return beste ? beste.toISOString() : null;
}

/**
 * Leest een datum uit tekst of een attribuutwaarde. Vervangt de losse
 * parseerDatum-functies met new Date(tekst), die twee problemen hadden:
 *   - Nederlandse maanden die JavaScript niet kent ("oktober", "maart", "mei")
 *     gaven een ongeldige datum;
 *   - tekst zonder jaar ("30 sep") werd stilletjes als het jaar 2001 gelezen,
 *     waardoor een bericht er als "te oud" uitzag zonder dat iets faalde.
 * new Date() wordt daarom alleen vertrouwd als er een jaartal van 4 cijfers in
 * de tekst staat; dag-maand-jaar met streepjes of slashes wordt als Nederlands
 * (DD-MM-JJJJ) gelezen, niet als Amerikaans.
 */
function parseerDatumTekst(tekst, opties = {}) {
  if (tekst == null) return null;
  const t = String(tekst).trim();
  if (!t) return null;

  const dmj = t.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (dmj) {
    const d = new Date(Number(dmj[3]), Number(dmj[2]) - 1, Number(dmj[1]), Number(dmj[4] || 0), Number(dmj[5] || 0));
    if (!isNaN(d.getTime()) && d.getMonth() === Number(dmj[2]) - 1) return d.toISOString();
  }

  if (/\d{4}/.test(t)) {
    const d = new Date(t);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return haalDatumUitTekst(t, opties);
}

/**
 * Haalt een URL op met een nette user-agent en duidelijke timeout/foutmelding.
 * Wordt door alle scrapers gebruikt zodat we op één plek retry-/timeoutlogica
 * kunnen aanpassen. Met { stil: true } als derde argument blijven de
 * waarschuwingen per mislukte poging achterwege.
 */
async function haalOpEcht(url, pogingen = 3, opties = {}) {
  let laatsteFout;
  let dispatcher; // blijft gezet zodra een reparatie eenmaal gelukt is voor deze host
  for (let poging = 1; poging <= pogingen; poging++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20_000);
      const opties = {
        headers: { "User-Agent": GEBRUIKERSAGENT },
        signal: controller.signal,
      };
      if (dispatcher) opties.dispatcher = dispatcher;
      const response = await fetch(url, opties);
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} voor ${url}`);
      }
      return await response.text();
    } catch (fout) {
      laatsteFout = fout;

      if (fout.cause && fout.cause.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" && !dispatcher) {
        console.warn(`Certificaatketen van ${url} is onvolledig — probeer het ontbrekende tussencertificaat zelf op te halen...`);
        const reparatie = await probeerKetenTeRepareren(url).catch(() => null);
        if (reparatie) {
          console.warn(`Ontbrekend tussencertificaat gevonden via ${reparatie.issuerUrl}, opnieuw proberen.`);
          dispatcher = reparatie.dispatcher;
          continue; // meteen opnieuw fetchen met de gerepareerde keten
        }
      }

      if (fout.cause && fout.cause.message === "redirect count exceeded") {
        console.warn(`${url} stuurt eindeloos door (waarschijnlijk is een sessie-cookie vereist) — probeer met cookie-ondersteuning...`);
        try {
          const cookieOpties = { headers: { "User-Agent": GEBRUIKERSAGENT } };
          if (dispatcher) cookieOpties.dispatcher = dispatcher;
          return await haalOpMetCookies(url, cookieOpties);
        } catch (cookieFout) {
          laatsteFout = cookieFout;
          console.warn(`Cookie-ondersteuning hielp niet: ${cookieFout.message}`);
        }
      }

      // opties.stil: voor proefpogingen (bijvoorbeeld raden of /feed/ bestaat)
      // waar een 404 de normale, verwachte uitkomst is.
      if (!opties.stil) console.warn(`Poging ${poging}/${pogingen} mislukt voor ${url}: ${fout.message}${oorzaakTekst(fout)}`);
      if (poging < pogingen) {
        await nieuweWacht(1000 * poging); // simpele backoff: 1s, 2s, 3s...
      }
    }
  }
  throw laatsteFout;
}

/**
 * Responscache voor één ontdekkingsrun (bron-ontdekking.js). Bij het uitzoeken
 * van een bron wordt dezelfde pagina door veel tests gebruikt: de ontdekking
 * zelf, de JSON-LD-test, en elke Gemini-poging (soms twee keer). Zonder cache
 * waren dat tientallen verzoeken op één url binnen een minuut; sommige sites
 * (of hun firewall) laten de verbinding dan verlopen, waarna een goed recept
 * ten onrechte als fout werd beoordeeld. Met de cache gaat elke url één keer
 * over het netwerk, en testen alle methodes op precies dezelfde HTML.
 *
 * Alleen aan tijdens een ontdekkingsrun. De dagelijkse run gebruikt hem niet,
 * want daar wil je elke nacht verse pagina's. Met RESPONSCACHE=uit staat hij
 * ook tijdens ontdekking uit (alleen voor het zoeken naar fouten).
 */
let responsCache = null;

function startResponsCache() {
  responsCache = process.env.RESPONSCACHE === "uit" ? null : new Map();
}

function stopResponsCache() {
  responsCache = null;
}

async function haalOp(url, pogingen = 3, opties = {}) {
  if (responsCache && responsCache.has(url)) return responsCache.get(url);
  const tekst = await haalOpEcht(url, pogingen, opties);
  if (responsCache) responsCache.set(url, tekst);
  return tekst;
}

/**
 * Is dit een fout van het netwerk of de server (time-out, verbinding verbroken,
 * 429, 5xx, 403) in plaats van een fout in wat we ermee doen? Dan zegt een
 * mislukte test niets over de kwaliteit van een recept, en moeten we dat ook
 * niet als zodanig behandelen.
 */
function isNetwerkFout(fout) {
  if (!fout) return false;
  const codes = ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT"];
  const cause = fout.cause;
  const gevonden = [fout.code, cause && cause.code, ...((cause && cause.errors) || []).map((e) => e && e.code)];
  if (gevonden.some((c) => codes.includes(c))) return true;
  return /fetch failed|aborted|timed out|timeout|HTTP (403|429|5\d\d)\b/i.test(String(fout.message));
}

function nieuweWacht(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parset RSS-XML-tekst naar een lijst van genormaliseerde berichtobjecten.
 * Elk <item> wordt hier al een los, duidelijk gescheiden bericht (zie ook
 * scrapers/rss.js) — dit is dus het punt waarop "elk nieuwsbericht duidelijk
 * gescheiden" in de RSS wordt gegarandeerd.
 */
async function parseerRssTekst(tekst, bron) {
  const feed = await rssParser.parseString(tekst);
  return (feed.items || []).map((item) => ({
    bronId: bron.id,
    bronNaam: bron.naam,
    categorie: bron.categorie,
    titel: (item.title || "").trim(),
    url: item.link || "",
    samenvatting: schoonmakenSamenvatting(item.contentSnippet || item.content || ""),
    gepubliceerdOp: item.isoDate || item.pubDate || null,
    opgehaaldOp: new Date().toISOString(),
  }));
}

function schoonmakenSamenvatting(tekst) {
  return tekst.replace(/\s+/g, " ").trim().slice(0, 600);
}

module.exports = {
  haalOp,
  startResponsCache,
  stopResponsCache,
  isNetwerkFout,
  parseerRssTekst,
  oorzaakTekst,
  probeerKetenTeRepareren,
  haalOpMetCookies,
  haalDatumUitTekst,
  haalDatumZonderJaar,
  parseerDatumTekst,
  GEBRUIKERSAGENT,
  MAX_LEEFTIJD_DAGEN,
  AGENDA_MAX_VERLEDEN_DAGEN,
  AGENDA_MAX_VOORUIT_DAGEN,
  binnenLeeftijdsgrens,
  binnenAgendaVenster,
  binnenVenster,
  leeftijdInDagen,
};
