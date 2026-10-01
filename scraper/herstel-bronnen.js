// herstel-bronnen.js
//
// Zelfherstel voor bronnen die niets meer opleveren. Websites veranderen: een
// nieuw theme, een andere feed-url, een verhuisde nieuwspagina. Zonder dit
// script merk je dat pas als iemand toevallig de logregel "❌ GEEN BERICHTEN
// GEVONDEN" leest. Dit script pakt het zelf op:
//
//   1. Kiest bronnen die N runs achter elkaar niets opleverden (standaard 2,
//      zodat een tijdelijke storing van een website niets uitlokt). De
//      teller staat in data/bron-gezondheid.json, bijgehouden door index.js.
//   2. Zoekt voor die bron opnieuw uit hoe hij op te halen is, met precies
//      dezelfde ontdekking en poort als bij een nieuwe bron (bron-ontdekking.js).
//   3. Levert het resultaat NOOIT direct op main af:
//        gelukt  -> een pull request met de nieuwe bron-config en het bewijs
//        mislukt -> een issue met het rapport van wat er geprobeerd is
//      Jij beslist dus met één klik (mergen of sluiten).
//
// Veiligheidsregels:
//   - Niet meer dan HERSTEL_MAX_PER_RUN bronnen per run (Gemini-kosten, ruis).
//   - Zijn meer dan de helft van de bronnen leeg, dan is het waarschijnlijk een
//     netwerkstoring bij ons en niet bij de sites: dan doet dit script niets.
//   - Bestaat er al een open pull request of issue voor die bron, dan wordt er
//     niet nog een gemaakt.
//   - iBabs-bronnen worden niet automatisch herzocht (eigen scraper, geen
//     generieke ontdekking mogelijk): daar komt alleen een issue.
//
// Gebruik (meestal door de workflow):
//   node herstel-bronnen.js                      bronnen die >= 2 runs leeg zijn
//   HERSTEL_BRON=orkaan node herstel-bronnen.js  één bron forceren (ook als hij niet 2 runs leeg was)
//   HERSTEL_BRON=alle node herstel-bronnen.js    alle bronnen die vandaag leeg waren
//   HERSTEL_DROOG=true ...                       alleen uitzoeken en tonen, geen git/gh
//
// Omgeving: GEMINI_API_KEY, GH_TOKEN (voor gh), en git moet in de workflow
// al zijn ingesteld met een naam en e-mailadres (zie de workflow-bestanden).

const { execFileSync } = require("child_process");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const bronnen = require("./bronnen");
const { ontdekBron, maakRapport, schrijfStapSamenvatting } = require("./bron-ontdekking");
const { schrijfBron, bronNaarTekst } = require("./bronnen-schrijver");
const { voorbeeldRegels } = require("./bron-poort");

const MIN_DAGEN = Number(process.env.HERSTEL_MIN_DAGEN || 2);
const MAX_PER_RUN = Number(process.env.HERSTEL_MAX_PER_RUN || 3);
const DROOG = process.env.HERSTEL_DROOG === "true";
const GEZONDHEID_PAD = path.join(__dirname, "..", "data", "bron-gezondheid.json");
const NIET_HERSTELBAAR = new Set(["ibabs"]);
const REPO_ROOT = path.join(__dirname, "..");

function git(...args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gh(...args) {
  return execFileSync("gh", args, { cwd: REPO_ROOT, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function leesGezondheid() {
  try {
    return JSON.parse(await fs.readFile(GEZONDHEID_PAD, "utf-8"));
  } catch {
    return {};
  }
}

const aantalLeeg = (gezondheid, id) => (gezondheid[id] && gezondheid[id].opeenvolgendGeenBerichten) || 0;

/** Welke bronnen pakken we op? Geeft { doelen, reden } terug; doelen is leeg als er niets te doen is. */
function kiesDoelen(gezondheid, geforceerd) {
  if (geforceerd && geforceerd !== "alle") {
    const bron = bronnen.find((b) => b.id === geforceerd);
    if (!bron) throw new Error(`Bron "${geforceerd}" staat niet in bronnen.js.`);
    return { doelen: [bron], reden: `handmatig gekozen: ${geforceerd}` };
  }
  if (geforceerd === "alle") {
    return { doelen: bronnen.filter((b) => aantalLeeg(gezondheid, b.id) >= 1), reden: "handmatig: alle bronnen die de laatste run leeg waren" };
  }

  const vandaagLeeg = bronnen.filter((b) => aantalLeeg(gezondheid, b.id) >= 1);
  if (vandaagLeeg.length > bronnen.length / 2) {
    return { doelen: [], reden: `${vandaagLeeg.length} van de ${bronnen.length} bronnen waren leeg: waarschijnlijk een netwerkstoring bij ons, niet bij de sites. Niets gedaan.` };
  }
  return {
    doelen: bronnen.filter((b) => aantalLeeg(gezondheid, b.id) >= MIN_DAGEN),
    reden: `bronnen die ${MIN_DAGEN} of meer runs achter elkaar leeg waren`,
  };
}

/** Bij een RSS-bron is de url een feed, geen pagina: dan zoeken we vanaf de hoofdpagina van de site. */
function zoekUrlVoor(bron) {
  if (bron.type === "rss" || bron.type === "json-api" || bron.type === "wp-rest") {
    try {
      return `${new URL(bron.url).origin}/`;
    } catch {
      return bron.url;
    }
  }
  return bron.url;
}

function runLink() {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  return GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}` : null;
}

function prTekst(oud, nieuw, uit, gezondheid) {
  const leeg = aantalLeeg(gezondheid, oud.id);
  const link = runLink();
  const regels = [
    `De bron \`${oud.id}\` leverde ${leeg} run(s) achter elkaar geen enkel bericht op. Er is automatisch opnieuw uitgezocht hoe de bron op te halen is.`,
    "",
    "**Was:**",
    "```js",
    bronNaarTekst(oud),
    "```",
    "**Wordt:**",
    "```js",
    bronNaarTekst(nieuw),
    "```",
    "",
    `**Bewijs:** de echte scraper haalde ${uit.oordeel.aantal} bericht(en) op en het resultaat haalde de poort (titel, unieke link op dezelfde site, leesbare datum${nieuw.soort === "agenda" ? ", agenda-venster" : ""}). Voorbeelden:`,
    "```",
    ...voorbeeldRegels(uit.oordeel, 5),
    "```",
    ...uit.oordeel.waarschuwingen.map((w) => `- ⚠️ ${w}`),
  ];
  if (uit.twijfelachtig) {
    regels.push(
      "",
      "⚠️ **Let op, twijfelachtig:** dit resultaat haalde de poort, maar geen enkel bericht staat als link op de opgegeven pagina. Controleer de voorbeelden hierboven voordat je merget."
    );
  }
  regels.push("", "Mergen voert de wijziging door in de volgende dagelijkse run. Sluiten negeert hem.");
  if (link) regels.push("", `Gemaakt door [deze run](${link}).`);
  return regels.join("\n");
}

function issueTekst(oud, uit, gezondheid, reden) {
  const leeg = aantalLeeg(gezondheid, oud.id);
  const link = runLink();
  const regels = [
    `De bron \`${oud.id}\` (${oud.type}, ${oud.url}) leverde ${leeg} run(s) achter elkaar geen enkel bericht op.`,
    "",
    reden || "Er is automatisch opnieuw gezocht naar een werkende manier om hem op te halen, maar niets haalde de poort.",
    "",
    maakRapport({ url: zoekUrlVoor(oud), id: oud.id, verslag: uit ? uit.verslag : [], fout: uit && uit.fout }),
    "**Wat nu?** Kijk of de site is verhuisd of veranderd. Staat er een nieuwe url, start dan de workflow *Bron toevoegen* met het id `" +
      oud.id +
      "` en de nieuwe url: een kapotte bron wordt daarbij automatisch vervangen. Bestaat de bron niet meer, haal hem dan uit `scraper/bronnen.js`.",
  ];
  if (link) regels.push("", `Gemaakt door [deze run](${link}).`);
  return regels.join("\n");
}

/** Bestaat er al een open pull request of issue voor deze bron? Dan niet nog een maken. */
function bestaatAlOpen(id) {
  if (DROOG) return null;
  const prs = JSON.parse(gh("pr", "list", "--state", "open", "--head", `herstel/${id}`, "--json", "number"));
  if (prs.length) return `pull request #${prs[0].number}`;
  const titel = `Bron kapot: ${id}`;
  const issues = JSON.parse(gh("issue", "list", "--state", "open", "--search", `"${titel}" in:title`, "--json", "number,title"));
  const gelijk = issues.find((i) => i.title === titel);
  return gelijk ? `issue #${gelijk.number}` : null;
}

async function maakIssue(oud, uit, gezondheid, reden) {
  const titel = `Bron kapot: ${oud.id}`;
  const body = issueTekst(oud, uit, gezondheid, reden);
  if (DROOG) {
    console.log(`  [droog] zou issue maken: "${titel}"\n${body.split("\n").map((r) => `    | ${r}`).join("\n")}`);
    return "issue (droog)";
  }
  const tmp = path.join(os.tmpdir(), `issue-${oud.id}.md`);
  await fs.writeFile(tmp, body, "utf-8");
  const uitvoer = gh("issue", "create", "--title", titel, "--body-file", tmp);
  return `issue ${uitvoer}`;
}

/** Zet de verbeterde bron op een eigen branch en opent een pull request. Valt terug op een issue als dat niet mag. */
async function maakPullRequest(oud, nieuw, uit, gezondheid) {
  const titel = `Herstel bron: ${oud.id}`;
  const body = prTekst(oud, nieuw, uit, gezondheid);
  if (DROOG) {
    console.log(`  [droog] zou pull request maken: "${titel}" (branch herstel/${oud.id})\n${body.split("\n").map((r) => `    | ${r}`).join("\n")}`);
    return "pull request (droog)";
  }

  const origineleRef = git("rev-parse", "--abbrev-ref", "HEAD") === "HEAD" ? git("rev-parse", "HEAD") : git("rev-parse", "--abbrev-ref", "HEAD");
  if (git("status", "--porcelain", "--", "scraper/bronnen.js")) throw new Error("scraper/bronnen.js heeft lokale wijzigingen; niet overschrijven.");
  const branch = `herstel/${oud.id}`;
  try {
    git("checkout", "-B", branch);
    await schrijfBron(nieuw);
    git("add", "scraper/bronnen.js");
    git("commit", "-m", `Herstel bron ${oud.id}: nieuwe methode (${oud.type} -> ${nieuw.type})`);
    git("push", "--force", "origin", branch);
    const tmp = path.join(os.tmpdir(), `pr-${oud.id}.md`);
    await fs.writeFile(tmp, body, "utf-8");
    try {
      return `pull request ${gh("pr", "create", "--base", "main", "--head", branch, "--title", titel, "--body-file", tmp)}`;
    } catch (fout) {
      // Vaak: "GitHub Actions is not permitted to create or approve pull requests" (repo-instelling). De branch staat dan al klaar.
      console.warn(`  Pull request maken mislukte (${String(fout.stderr || fout.message).trim().split("\n")[0]}). Terugvallen op een issue met de wijziging.`);
      const reden = `De verbeterde configuratie staat klaar op de branch \`${branch}\` (een pull request maken was niet toegestaan; zie Settings > Actions > General > "Allow GitHub Actions to create and approve pull requests"). Nieuw:\n\n\`\`\`js\n${bronNaarTekst(nieuw)}\n\`\`\``;
      return await maakIssue(oud, uit, gezondheid, reden);
    }
  } finally {
    git("checkout", origineleRef);
  }
}

/** Herstelt één bron. Geeft { id, uitkomst, detail } terug voor de samenvatting. */
async function herstelEen(bron, gezondheid) {
  console.log(`\n=== Herstel: ${bron.id} (${bron.type}, ${aantalLeeg(gezondheid, bron.id)} run(s) leeg) ===`);

  const bestaand = bestaatAlOpen(bron.id);
  if (bestaand) {
    console.log(`  Er staat al een open ${bestaand} voor deze bron; overgeslagen.`);
    return { id: bron.id, uitkomst: "overgeslagen", detail: `al open: ${bestaand}` };
  }

  if (NIET_HERSTELBAAR.has(bron.type)) {
    console.log(`  Type ${bron.type} heeft een eigen scraper; automatisch herzoeken is niet mogelijk. Alleen een issue.`);
    const detail = await maakIssue(bron, null, gezondheid, `Dit is een \`${bron.type}\`-bron met een eigen scraper. Die kan niet automatisch opnieuw worden uitgezocht: kijk handmatig of de iBabs-pagina of het rapport is veranderd.`);
    return { id: bron.id, uitkomst: "issue", detail };
  }

  const uit = await ontdekBron({
    url: zoekUrlVoor(bron),
    id: bron.id,
    naam: bron.naam,
    categorie: bron.categorie,
    soort: bron.soort === "agenda" ? "agenda" : "auto",
    apiKey: process.env.GEMINI_API_KEY,
  });

  if (!uit.bron) {
    console.log(`  Niets haalde de poort: ${uit.fout}`);
    return { id: bron.id, uitkomst: "issue", detail: await maakIssue(bron, uit, gezondheid) };
  }

  // Precies dezelfde config als nu? Dan is het geen herstel, en de bron is blijkbaar (weer) OK.
  if (bronNaarTekst(uit.bron) === bronNaarTekst(bron)) {
    console.log("  De gevonden methode is gelijk aan de huidige; niets te herstellen (de site is mogelijk weer hersteld).");
    return { id: bron.id, uitkomst: "ongewijzigd", detail: "gevonden methode is gelijk aan de huidige" };
  }

  const detail = await maakPullRequest(bron, uit.bron, uit, gezondheid);
  // Viel het op een issue terug (PR's niet toegestaan), dan staat de oplossing wel klaar op een branch.
  return { id: bron.id, uitkomst: detail.startsWith("issue") ? "issue (oplossing staat klaar op een branch)" : "pull request", detail };
}

async function main() {
  const geforceerd = (process.env.HERSTEL_BRON || "").trim();
  const gezondheid = await leesGezondheid();
  const { doelen, reden } = kiesDoelen(gezondheid, geforceerd);

  console.log(`Zelfherstel: ${reden.replace(/\.$/, "")}.`);
  if (doelen.length === 0) {
    console.log("Niets te herstellen.");
    return;
  }

  const teDoen = doelen.slice(0, MAX_PER_RUN);
  if (doelen.length > teDoen.length) {
    console.log(`${doelen.length} kandidaten; deze run maximaal ${MAX_PER_RUN}. De rest volgt bij een volgende run: ${doelen.slice(MAX_PER_RUN).map((b) => b.id).join(", ")}.`);
  }

  const resultaten = [];
  for (const bron of teDoen) {
    try {
      resultaten.push(await herstelEen(bron, gezondheid));
    } catch (fout) {
      console.error(`  Herstel van ${bron.id} mislukte onverwacht: ${fout.message}`);
      resultaten.push({ id: bron.id, uitkomst: "fout", detail: fout.message });
    }
  }

  schrijfStapSamenvatting(["### Zelfherstel van bronnen", "", ...resultaten.map((r) => `- \`${r.id}\`: **${r.uitkomst}** (${r.detail})`)].join("\n"));

  // Bij een handmatig gekozen bron wil je rood zien als het niet gelukt is.
  if (geforceerd && geforceerd !== "alle" && resultaten.some((r) => ["issue", "fout"].includes(r.uitkomst))) process.exit(1);
}

main().catch((fout) => {
  console.error(`Zelfherstel stopte met een fout: ${fout.stack || fout.message}`);
  process.exit(1);
});
