// valideer-bronnen.js
//
// Controleert bronnen.js op de twee fouten die er op 2026-09-21/22
// daadwerkelijk in zaten en allebei dagenlang onopgemerkt bleven:
//   1. Een bron met een "type" waar geen scraper voor bestaat (het
//      "onbekend brontype"-drama — zaanstad-hoorzittingen sloeg een hele
//      nacht over doordat het type wel in bronnen.js stond maar niet in de
//      dispatch-tabel).
//   2. Twee bronnen met hetzelfde "id" (zaandijk-leeft stond dubbel: een
//      oude, kapotte entry naast de nieuwe, werkende — allebei draaiden ze
//      mee, dubbel werk en verwarrende logs).
// Plus een derde, goedkope check: is de url syntactisch geldig (http/https)?
// Dat vangt evidente typefouten af (zoals de oude ".../nieuws/"-url die niet
// eens bestond) vóórdat er een hele nacht overheen gaat.
//
// Gebruik:
//   node valideer-bronnen.js          — print bevindingen, exit 1 bij fouten
// Wordt aangeroepen als eerste stap in zowel bron-toevoegen.yml als
// dagelijkse-run.yml, zodat een fout hier de run stopt vóórdat er iets
// misloopt of overschreven wordt — in plaats van pas zichtbaar te worden in
// een logregel die iemand toevallig leest.

const bronnen = require("./bronnen");
const { geldigeTypes, scraperVoorType } = require("./scraper-register");

function valideerBronnen(lijst) {
  const fouten = [];
  const gezienIds = new Map(); // id -> index van eerste voorkomen

  lijst.forEach((bron, i) => {
    const label = bron.id || `(bron zonder id, positie ${i})`;

    if (!bron.id) {
      fouten.push(`${label}: mist een "id".`);
    } else if (gezienIds.has(bron.id)) {
      fouten.push(`"${bron.id}" komt dubbel voor (posities ${gezienIds.get(bron.id)} en ${i}) — welke van de twee draait, is dan afhankelijk van toeval/volgorde.`);
    } else {
      gezienIds.set(bron.id, i);
    }

    if (!bron.type) {
      fouten.push(`${label}: mist een "type".`);
    } else if (!scraperVoorType(bron.type)) {
      fouten.push(`${label}: type "${bron.type}" bestaat niet. Geldige types: ${geldigeTypes().join(", ")}.`);
    }

    if (!bron.url) {
      fouten.push(`${label}: mist een "url".`);
    } else {
      try {
        const parsed = new URL(bron.url);
        if (!["http:", "https:"].includes(parsed.protocol)) {
          fouten.push(`${label}: url "${bron.url}" is geen http(s)-adres.`);
        }
      } catch {
        fouten.push(`${label}: url "${bron.url}" is geen geldige url.`);
      }
    }

    if (bron.type === "gemini-recept" && !bron.selectors) {
      fouten.push(`${label}: type "gemini-recept" maar geen "selectors" aanwezig — deze bron zou 0 berichten opleveren.`);
    }

    // Nieuwe velden en types (zie bron-poort.js en bron-ontdekking.js):
    if (bron.type === "json-api" && !(bron.json && bron.json.titelVeld && bron.json.linkVeld)) {
      fouten.push(`${label}: type "json-api" mist "json" met minstens "titelVeld" en "linkVeld" — deze bron zou 0 berichten opleveren.`);
    }
    if (bron.soort !== undefined && bron.soort !== "agenda") {
      fouten.push(`${label}: soort "${bron.soort}" bestaat niet. Laat "soort" weg voor gewoon nieuws, of gebruik "agenda".`);
    }
    if (bron.rustig !== undefined && typeof bron.rustig !== "boolean") {
      fouten.push(`${label}: "rustig" moet true of false zijn.`);
    }
    if (bron.categorie !== undefined && !["lokaal", "landelijk"].includes(bron.categorie)) {
      fouten.push(`${label}: categorie "${bron.categorie}" bestaat niet (kies lokaal of landelijk).`);
    }
  });

  return fouten;
}

if (require.main === module) {
  const fouten = valideerBronnen(bronnen);
  console.log(`${bronnen.length} bronnen gecontroleerd.`);
  if (fouten.length === 0) {
    console.log("✓ Geen problemen gevonden.");
    process.exit(0);
  }
  console.error(`✗ ${fouten.length} probleem/problemen gevonden in bronnen.js:`);
  for (const fout of fouten) console.error(`  - ${fout}`);
  process.exit(1);
}

module.exports = { valideerBronnen };
