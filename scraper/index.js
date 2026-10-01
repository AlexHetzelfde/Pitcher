// index.js — hoofdscript van de dagelijkse run
//
// Volgorde:
// 1. Alles scrapen (per bron, met eigen scraper-type)
// 2. Tellen hoeveel berichten er zijn, VOORDAT Gemini wordt aangeroepen
// 3. Scoren (score.js) — puntensysteem als sorteersignaal, geen filter
// 4. Splitsen in lokaal/landelijk en sorteren op score
// 5. Per bericht een Gemini-call met de juiste prompt (met dagcap)
// 6. Top-pitches bepalen (met voorkeur voor lokaal) en wegschrijven naar /data

const fs = require("fs/promises");
const path = require("path");

const bronnen = require("./bronnen");
const { scraperVoorType } = require("./scraper-register");
const { scoorBericht } = require("./score");
const { beoordeelBerichten } = require("./gemini");
const { binnenVenster, MAX_LEEFTIJD_DAGEN, AGENDA_MAX_VERLEDEN_DAGEN, AGENDA_MAX_VOORUIT_DAGEN, oorzaakTekst } = require("./hulpmiddelen");

const DATA_MAP = path.join(__dirname, "..", "data");
const DAGCAP_GEMINI = Number(process.env.DAGCAP_GEMINI || 25);
const AANTAL_PITCHES = Number(process.env.AANTAL_PITCHES || 10);
// Hoeveel punten een landelijk bericht moet "inleveren" bij het samenstellen
// van de pitches — lokaal nieuws krijgt zo voorrang, tenzij een landelijk
// bericht ook ná aftrek van deze marge nog steeds hoger scoort (d.w.z. het
// lokale aanbod die dag merkbaar zwakker is).
const LOKALE_VOORKEURSMARGE = Number(process.env.LOKALE_VOORKEURSMARGE || 5);

// --- Kleine logging-helpers, zodat elke fase duidelijk zichtbaar is in de
// Actions-log: een kopregel, en aan het eind hoelang die fase duurde. ---
function logFase(titel) {
  console.log(`\n=== ${titel} — ${new Date().toISOString()} ===`);
}

function logDuur(startMs, label) {
  const duurSec = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`${label} klaar in ${duurSec}s`);
}

/**
 * Telt per bron hoeveel berichten er gevonden zijn en hoeveel daarvan het
 * venster (leeftijdsfilter, of het agenda-venster) overleefden.
 */
function telPerBron(ruweBerichten, recenteBerichten) {
  const gevondenPerBron = {};
  const overPerBron = {};
  for (const b of ruweBerichten) gevondenPerBron[b.bronId] = (gevondenPerBron[b.bronId] || 0) + 1;
  for (const b of recenteBerichten) overPerBron[b.bronId] = (overPerBron[b.bronId] || 0) + 1;
  return { gevondenPerBron, overPerBron };
}

/**
 * Drukt een duidelijk per-bron statusoverzicht af: hoeveel berichten een
 * bron opleverde, hoeveel daarvan het venster overleefden, en een
 * status-label — zodat een kapotte of stilvallende bron in één oogopslag
 * opvalt tussen de rest van de run-log, zonder dat je de losse regels per
 * bron hoeft na te lopen.
 *
 * Een bron met rustig: true (zie bron-poort.js) is een bron die maar heel
 * weinig berichten toont. Daar is "0 na leeftijdsfilter" normaal en geen
 * reden voor de datum-waarschuwing. "0 gevonden" blijft voor elke bron rood:
 * dat betekent dat de scraper niets meer ziet.
 */
function logBronOverzicht({ gevondenPerBron, overPerBron }) {
  console.log("\n--- Bronoverzicht (gevonden → binnen venster) ---");
  for (const bron of bronnen) {
    const gevonden = gevondenPerBron[bron.id] || 0;
    const over = overPerBron[bron.id] || 0;

    let status;
    if (gevonden === 0) {
      status = "❌ GEEN BERICHTEN GEVONDEN — scraper/selector waarschijnlijk kapot";
    } else if (over === 0 && bron.rustig) {
      status = "💤 rustige bron, nu geen recente berichten (verwacht)";
    } else if (over === 0 && bron.soort === "agenda") {
      status = "⚠️  0 binnen het agenda-venster — check datumherkenning (datums zonder jaar?) of de agenda is leeg";
    } else if (over === 0) {
      status = "⚠️  0 na leeftijdsfilter — check datumherkenning voor deze bron";
    } else {
      status = "✅ OK";
    }

    const soort = bron.soort === "agenda" ? " [agenda]" : "";
    console.log(`  ${(bron.id + soort).padEnd(28)} ${String(gevonden).padStart(3)} → ${String(over).padStart(3)}   ${status}`);
  }
  console.log("---\n");
}

const GEZONDHEID_BESTAND = path.join(DATA_MAP, "bron-gezondheid.json");

/**
 * Houdt per bron bij hoeveel runs achter elkaar er NIETS gevonden is. Dat
 * bestand wordt met de rest van data/*.json teruggecommit. herstel-bronnen.js
 * gebruikt het om pas in actie te komen als een bron twee runs achter elkaar
 * leeg is, zodat een tijdelijke storing van een website geen herstelpoging
 * (en geen pull request) uitlokt.
 */
async function werkBronGezondheidBij({ gevondenPerBron, overPerBron }) {
  let vorige = {};
  try {
    vorige = JSON.parse(await fs.readFile(GEZONDHEID_BESTAND, "utf-8"));
  } catch {
    /* eerste run, of bestand nog niet aanwezig */
  }
  const nieuw = {};
  for (const bron of bronnen) {
    const gevonden = gevondenPerBron[bron.id] || 0;
    const eerder = (vorige[bron.id] && vorige[bron.id].opeenvolgendGeenBerichten) || 0;
    nieuw[bron.id] = {
      laatsteRun: new Date().toISOString(),
      gevonden,
      binnenVenster: overPerBron[bron.id] || 0,
      opeenvolgendGeenBerichten: gevonden === 0 ? eerder + 1 : 0,
    };
  }
  await schrijfJson("bron-gezondheid.json", nieuw);
}

async function scrapeAlleBronnen(gezieneUrls) {
  const alleBerichten = [];

  for (const bron of bronnen) {
    const scraper = scraperVoorType(bron.type);
    if (!scraper) {
      console.warn(`[${bron.id}] Onbekend brontype "${bron.type}" — overgeslagen.`);
      continue;
    }

    const startBron = Date.now();
    try {
      // gezieneUrls wordt alleen door de iBabs-scraper gebruikt (om dure
      // documentinhoud-ophaal-stappen over te slaan voor berichten die al
      // eerder verwerkt zijn) — andere scraper-types negeren dit argument.
      const berichten = await scraper(bron, gezieneUrls);
      const duurSec = ((Date.now() - startBron) / 1000).toFixed(1);
      console.log(`[${bron.id}] ${berichten.length} bericht(en) gevonden (${duurSec}s).`);
      alleBerichten.push(...berichten);
    } catch (fout) {
      // Eén kapotte bron mag de hele dagelijkse run niet laten crashen.
      const duurSec = ((Date.now() - startBron) / 1000).toFixed(1);
      console.error(`[${bron.id}] Scrapen mislukt na ${duurSec}s: ${fout.message}${oorzaakTekst(fout)}`);
    }
  }

  return alleBerichten;
}

const GEZIENE_URLS_BESTAND = path.join(DATA_MAP, "geziene-urls.json");

async function laadGezieneUrls() {
  try {
    const inhoud = await fs.readFile(GEZIENE_URLS_BESTAND, "utf-8");
    return new Set(JSON.parse(inhoud));
  } catch {
    return new Set(); // eerste keer draaien, of bestand nog niet aanwezig
  }
}

async function schrijfGezieneUrls(set) {
  await fs.mkdir(DATA_MAP, { recursive: true });
  const array = Array.from(set).slice(-5000);
  await fs.writeFile(GEZIENE_URLS_BESTAND, JSON.stringify(array, null, 2), "utf-8");
}

function filterOpNieuw(berichten, gezieneUrls) {
  return berichten.filter((b) => b.url && !gezieneUrls.has(b.url));
}

function verwijderDubbelen(berichten) {
  const geziereUrls = new Set();
  return berichten.filter((b) => {
    if (!b.url || geziereUrls.has(b.url)) return false;
    geziereUrls.add(b.url);
    return true;
  });
}

async function schrijfJson(bestandsnaam, data) {
  await fs.mkdir(DATA_MAP, { recursive: true });
  await fs.writeFile(path.join(DATA_MAP, bestandsnaam), JSON.stringify(data, null, 2), "utf-8");
}

/**
 * Combineert kansrijke lokale en landelijke berichten tot de uiteindelijke
 * pitchlijst, met voorkeur voor lokaal: een landelijk bericht wordt alleen
 * boven een lokaal bericht gerangschikt als het, ná aftrek van
 * LOKALE_VOORKEURSMARGE, nog steeds hoger scoort. Dat betekent: bij een
 * "normale" dag wint lokaal bijna altijd; alleen als het lokale aanbod die
 * dag merkbaar zwakker scoort dan het landelijke, komt landelijk hoger.
 */
function stelPitchesSamen(kansrijkeLokaal, kansrijkLandelijk, aantal) {
  const gecombineerd = [
    ...kansrijkeLokaal.map((b) => ({ bericht: b, vergelijkingsscore: b.score })),
    ...kansrijkLandelijk.map((b) => ({ bericht: b, vergelijkingsscore: b.score - LOKALE_VOORKEURSMARGE })),
  ];

  return gecombineerd
    .sort((a, b) => b.vergelijkingsscore - a.vergelijkingsscore)
    .slice(0, aantal)
    .map((x) => x.bericht);
}

async function main() {
  const startRun = Date.now();
  console.log(`Start dagelijkse run: ${new Date().toISOString()}`);
  console.log(`Instellingen: dagcap=${DAGCAP_GEMINI}/lijst, pitches=${AANTAL_PITCHES}, lokale voorkeursmarge=${LOKALE_VOORKEURSMARGE}`);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn(
      "GEMINI_API_KEY is niet gezet — de scrape- en scorestap draaien gewoon door, " +
        "maar er worden geen AI-beoordelingen/pitches gegenereerd."
    );
  }

  // Stap 1: scrapen — geziene-urls wordt eerst geladen zodat scrapers die
  // dat willen (zoals iBabs, waar het ophalen van documentinhoud duur is)
  // al eerder verwerkte berichten meteen kunnen overslaan.
  logFase("STAP 1 — Scrapen");
  const gezieneUrls = await laadGezieneUrls();
  const startScrapen = Date.now();
  const ruweBerichten = await scrapeAlleBronnen(gezieneUrls);
  logDuur(startScrapen, `Scrapen van ${bronnen.length} bronnen`);
  console.log(`Ruw aantal berichten (vóór leeftijdsfilter/dedup): ${ruweBerichten.length}`);

  // Centrale leeftijdsgrens — geldt voor ALLE bronnen tegelijk, hier op één
  // plek, in plaats van los per scraper (dat leidde er eerder toe dat de
  // grens alleen bij iBabs was toegepast en nergens anders). Een bericht
  // zonder betrouwbare datum wordt hier ook geweerd, niet uit voorzichtigheid
  // meegenomen — zie de toelichting bij binnenLeeftijdsgrens() in
  // hulpmiddelen.js voor waarom dat bewust zo is.
  //
  // Agenda-bronnen (soort: "agenda") krijgen een eigen venster, omdat hun
  // datum de datum van het evenement is: van gisteren tot een aantal dagen
  // vooruit, in plaats van "maximaal 7 dagen oud".
  const bronPerId = Object.fromEntries(bronnen.map((b) => [b.id, b]));
  const binnen = (b) => binnenVenster(b.gepubliceerdOp, bronPerId[b.bronId]);
  const recenteBerichten = ruweBerichten.filter(binnen);
  const perBronZonderDatum = {};
  for (const b of ruweBerichten) {
    if (!binnen(b)) {
      perBronZonderDatum[b.bronId] = (perBronZonderDatum[b.bronId] || 0) + 1;
    }
  }
  console.log(`Na leeftijdsfilter (max ${MAX_LEEFTIJD_DAGEN} dagen; agenda-bronnen: ${AGENDA_MAX_VERLEDEN_DAGEN} dag terug tot ${AGENDA_MAX_VOORUIT_DAGEN} dagen vooruit): ${recenteBerichten.length} van ${ruweBerichten.length} berichten.`);
  for (const [bronId, aantal] of Object.entries(perBronZonderDatum)) {
    console.warn(`[${bronId}] ${aantal} bericht(en) geweerd door leeftijdsfilter (te oud, buiten het venster, of geen betrouwbare datum).`);
  }
  const tellingen = telPerBron(ruweBerichten, recenteBerichten);
  logBronOverzicht(tellingen);
  await werkBronGezondheidBij(tellingen);

  // Stap 1b: dedupliceren binnen deze run + alleen berichten die we nog
  // niet eerder (in een vorige run) hebben gezien.
  const berichtenVanVandaag = filterOpNieuw(verwijderDubbelen(recenteBerichten), gezieneUrls);

  // Stap 2: tellen, vóórdat de AI wordt aangeroepen
  console.log(`Totaal aantal nieuwe berichten vandaag: ${berichtenVanVandaag.length}`);

  berichtenVanVandaag.forEach((b) => gezieneUrls.add(b.url));
  await schrijfGezieneUrls(gezieneUrls);

  // Stap 3: scoren
  logFase("STAP 2 — Scoren");
  const gescoordeBerichten = berichtenVanVandaag.map(scoorBericht);

  // Stap 4: splitsen + sorteren op score (hoog naar laag)
  const lokaal = gescoordeBerichten
    .filter((b) => b.categorie === "lokaal")
    .sort((a, b) => b.score - a.score);
  const landelijk = gescoordeBerichten
    .filter((b) => b.categorie === "landelijk")
    .sort((a, b) => b.score - a.score);

  console.log(`Lokaal: ${lokaal.length} berichten (hoogste score: ${lokaal[0]?.score ?? "-"}).`);
  console.log(`Landelijk: ${landelijk.length} berichten (hoogste score: ${landelijk[0]?.score ?? "-"}).`);

  await schrijfJson("nieuws-lokaal.json", lokaal);
  await schrijfJson("nieuws-landelijk.json", landelijk);

  if (!apiKey) {
    console.log("Klaar (zonder AI-beoordeling).");
    return;
  }

  // Stap 5: Gemini-beoordeling, met dagcap per lijst
  logFase("STAP 3 — Gemini-beoordeling");
  const startGemini = Date.now();

  console.log(`Lokaal: ${Math.min(lokaal.length, DAGCAP_GEMINI)} van ${lokaal.length} berichten gaan naar Gemini.`);
  const lokaalBeoordeeld = await beoordeelBerichten(lokaal, apiKey, DAGCAP_GEMINI, "lokaal");

  console.log(`Landelijk: ${Math.min(landelijk.length, DAGCAP_GEMINI)} van ${landelijk.length} berichten gaan naar Gemini.`);
  const landelijkBeoordeeld = await beoordeelBerichten(landelijk, apiKey, DAGCAP_GEMINI, "landelijk");

  logDuur(startGemini, "Gemini-beoordeling");

  await schrijfJson("nieuws-lokaal.json", lokaalBeoordeeld);
  await schrijfJson("nieuws-landelijk.json", landelijkBeoordeeld);

  // Stap 6: pitches samenstellen, met voorkeur voor lokaal nieuws.
  logFase("STAP 4 — Pitches samenstellen");
  const kansrijkeLokaal = lokaalBeoordeeld.filter((b) => b.aiBeoordeling?.oppakbaar === "ja");
  const kansrijkLandelijk = landelijkBeoordeeld.filter((b) => b.aiBeoordeling?.lokaleInvalshoek === "ja");
  console.log(`Kansrijk: ${kansrijkeLokaal.length} lokaal, ${kansrijkLandelijk.length} landelijk (vóór voorkeursmarge-sortering).`);

  const pitches = stelPitchesSamen(kansrijkeLokaal, kansrijkLandelijk, AANTAL_PITCHES);
  const aantalLokaalInPitches = pitches.filter((p) => p.categorie === "lokaal").length;
  console.log(`Pitches samengesteld: ${aantalLokaalInPitches} lokaal, ${pitches.length - aantalLokaalInPitches} landelijk.`);

  await schrijfJson("pitches.json", {
    gegenereerdOp: new Date().toISOString(),
    aantalBerichtenTotaal: berichtenVanVandaag.length,
    topPitches: pitches,
  });

  logDuur(startRun, "\nVolledige run");
  console.log(`Klaar. ${pitches.length} pitch(es) klaargezet.`);
}

main().catch((fout) => {
  console.error("Onverwachte fout in de dagelijkse run:", fout);
  process.exit(1);
});
