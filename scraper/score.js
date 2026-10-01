// score.js
//
// Implementatie van de twee puntensystemen uit "scoringsystemen-en-ai-prompts.md",
// gebaseerd op Basisboek journalistiek schrijven (5e druk), §5.1.3 en §1.3.4.
//
// BELANGRIJK: dit is een sorteersignaal, geen filter. Er wordt hier nooit een
// bericht verwijderd — alleen een score toegekend waarop later gesorteerd kan
// worden (bijvoorbeeld om te bepalen welke berichten bij een dagcap het eerst
// naar Gemini gaan).
//
// De trefwoordenlijsten hieronder zijn een startpunt. Vul ze gerust aan in
// TREFWOORDEN_LOKAAL / TREFWOORDEN_LANDELIJK naarmate je merkt dat bepaalde
// woorden vaker relevant nieuws voorspellen.

const { leeftijdInDagen, MAX_LEEFTIJD_DAGEN, AGENDA_MAX_VOORUIT_DAGEN } = require("./hulpmiddelen");

const ZAANSTREEK_PLAATSNAMEN = [
  "zaandam", "zaanstad", "koog aan de zaan", "zaandijk", "wormerveer",
  "krommenie", "assendelft", "westzaan", "wormerland", "oostzaan",
  "purmerend", "edam", "volendam", "waterland", "zaanse schans",
];

const TREFWOORDEN_LOKAAL = {
  actualiteit: ["vandaag", "gisteravond", "gisteren", "zojuist", "deze week", "vanmiddag", "vanochtend"],
  afwijking: ["brand", "ongeval", "aanrijding", "schade", "ruzie", "conflict", "diefstal", "vandalisme", "prijs gewonnen", "record", "incident"],
  belang: ["besluit", "verhoging", "sluiting", "subsidie", "vergunning", "verbod", "maatregel", "bezuiniging", "tarief"],
  nieuwsVanMorgen: ["aanstaande", "volgende week", "op de agenda", "vergadert over", "aankondiging"],
  voorHetEerst: ["eerste", "voor het eerst", "nieuw", "opening van", "geopend"],
  primeurBron: ["gemeente", "ibabs", "raadsinformatie", "buurtvereniging", "wijkraad"],
};

const NEGATIEVE_TREFWOORDEN_LOKAAL = [
  "schoolfotograaf", "lunchmenu", "vakantierooster", "agenda:", "sponsorloop-uitnodiging",
];

const TREFWOORDEN_LANDELIJK = {
  gemeentelijkBeleid: [
    "energietoeslag", "jeugdzorg", "huisvesting", "woningnood", "verkiezingen",
    "gemeenten", "gemeentelijk", "bijstand", "participatiewet", "wmo",
  ],
  sector: [
    "onderwijs", "school", "zorg", "ziekenhuis", "ondernemers", "mkb",
    "woningbouw", "landbouw", "boer", "industrie", "fabriek",
  ],
  bevolkingsgroep: [
    "arbeidsmigranten", "studenten", "ouderen", "zzp'ers", "zzp",
    "huurders", "eenoudergezinnen", "vluchtelingen", "statushouders",
  ],
  jaarlijksCijferBericht: ["cbs", "rivm", "cijfers per gemeente", "regionale cijfers"],
};

/**
 * Scoort een lokaal nieuwsbericht op nieuwswaarde (§5.1.3 top 10 + Zweedse
 * criteria). Retourneert { score, toelichting } zodat de reden van de score
 * ook zichtbaar/debugbaar blijft (handig bij het bijstellen van de lijsten).
 */
function scoorLokaalBericht(bericht) {
  const tekst = `${bericht.titel} ${bericht.samenvatting}`.toLowerCase();
  let score = 0;
  const toelichting = [];

  const telt = (woorden, punten, label) => {
    if (woorden.some((w) => tekst.includes(w))) {
      score += punten;
      toelichting.push(`${label} (+${punten})`);
    }
  };

  telt(TREFWOORDEN_LOKAAL.actualiteit, 3, "actualiteit");
  telt(TREFWOORDEN_LOKAAL.afwijking, 3, "afwijking");
  telt(TREFWOORDEN_LOKAAL.belang, 4, "belang");
  telt(TREFWOORDEN_LOKAAL.nieuwsVanMorgen, 2, "nieuws van morgen");
  telt(TREFWOORDEN_LOKAAL.voorHetEerst, 2, "voor het eerst");
  telt(TREFWOORDEN_LOKAAL.primeurBron, 3, "primeur/eerstehands bron");

  if (ZAANSTREEK_PLAATSNAMEN.some((p) => tekst.includes(p))) {
    score += 4;
    toelichting.push("nabijheid (+4)");
  }

  if (NEGATIEVE_TREFWOORDEN_LOKAAL.some((w) => tekst.includes(w))) {
    score -= 2;
    toelichting.push("agenda-item zonder inhoud (-2)");
  }

  return { score, toelichting };
}

/**
 * Scoort een landelijk nieuwsbericht op lokaliseerbaarheid (§1.3.4:
 * perspectief & invalshoek / regionaliseren). Meet niet "is dit nieuws" maar
 * "hoe waarschijnlijk is een lokaal aanknopingspunt".
 */
function scoorLandelijkBericht(bericht) {
  const tekst = `${bericht.titel} ${bericht.samenvatting}`.toLowerCase();
  let score = 0;
  const toelichting = [];

  const telt = (woorden, punten, label) => {
    if (woorden.some((w) => tekst.includes(w))) {
      score += punten;
      toelichting.push(`${label} (+${punten})`);
    }
  };

  telt(TREFWOORDEN_LANDELIJK.gemeentelijkBeleid, 4, "raakt gemeentelijk beleidsterrein");
  telt(TREFWOORDEN_LANDELIJK.sector, 3, "raakt lokaal vertegenwoordigde sector");
  telt(TREFWOORDEN_LANDELIJK.bevolkingsgroep, 3, "gaat over ook-lokaal-aanwezige groep");
  telt(TREFWOORDEN_LANDELIJK.jaarlijksCijferBericht, 2, "cijfers met mogelijke lokale uitsplitsing");

  // Een landelijk bericht dat toevallig al een Zaanstreek-plaatsnaam noemt,
  // heeft per definitie al een lokaal aanknopingspunt.
  if (ZAANSTREEK_PLAATSNAMEN.some((p) => tekst.includes(p))) {
    score += 5;
    toelichting.push("noemt expliciet Zaanstreek-Waterland (+5)");
  }

  return { score, toelichting };
}

// Maximale recency-bonus, toegekend aan een bericht van precies vandaag.
// Schaalt lineair af naar 0 op de leeftijdsgrens (MAX_LEEFTIJD_DAGEN) — dus
// hoe dichter een bericht bij de dag van scrapen zit, hoe relevanter het
// wordt geacht, en dat weegt voortaan voor lokaal én landelijk even zwaar
// mee (voorheen zat dit alleen, en als grove bonus/aftrek, in het lokale
// scoresysteem).
const MAX_RECENCY_BONUS = 8;

function berekenRecencyBonus(bericht) {
  const dagen = leeftijdInDagen(bericht.gepubliceerdOp);
  if (dagen === null) return { bonus: 0, toelichting: null }; // zou hier niet moeten voorkomen (index.js filtert dit al weg), maar geen crash als het toch gebeurt
  // Een negatieve leeftijd is een evenement in de toekomst (agenda-bronnen). Die
  // krijgt geen bonus boven het maximum: hoe dichter bij vandaag, hoe hoger,
  // afschalend naar 0 aan het einde van het agenda-venster.
  if (dagen < 0) {
    const factorToekomst = Math.max(0, 1 - -dagen / AGENDA_MAX_VOORUIT_DAGEN);
    const bonusToekomst = Math.round(MAX_RECENCY_BONUS * factorToekomst);
    return { bonus: bonusToekomst, toelichting: bonusToekomst > 0 ? `recency (+${bonusToekomst}, evenement over ${(-dagen).toFixed(1)} dag(en))` : null };
  }
  const factor = Math.max(0, 1 - dagen / MAX_LEEFTIJD_DAGEN);
  const bonus = Math.round(MAX_RECENCY_BONUS * factor);
  return { bonus, toelichting: bonus > 0 ? `recency (+${bonus}, ${dagen.toFixed(1)} dag(en) oud)` : null };
}

/**
 * Past het juiste scoresysteem toe op basis van bericht.categorie, telt daar
 * de centrale recency-bonus bovenop, en retourneert een nieuw object (het
 * origineel wordt niet gemuteerd).
 */
function scoorBericht(bericht) {
  const resultaat =
    bericht.categorie === "lokaal" ? scoorLokaalBericht(bericht) : scoorLandelijkBericht(bericht);

  const recency = berekenRecencyBonus(bericht);
  const toelichting = recency.toelichting ? [...resultaat.toelichting, recency.toelichting] : resultaat.toelichting;

  return {
    ...bericht,
    score: resultaat.score + recency.bonus,
    scoreToelichting: toelichting,
  };
}

module.exports = { scoorBericht, scoorLokaalBericht, scoorLandelijkBericht };
