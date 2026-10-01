// bronnen-schrijver.js
//
// Schrijft een bron naar bronnen.js: voegt 'm toe, of vervangt een bestaande
// bron met hetzelfde id. Wordt gebruikt door voeg-bron-toe.js (nieuwe bron)
// en herstel-bronnen.js (een kapotte bron vervangen door een werkende).
//
// Na het schrijven wordt bronnen.js meteen gevalideerd (valideer-bronnen.js).
// Is het resultaat ongeldig, dan wordt het bestand teruggezet naar hoe het
// was. Er blijft dus nooit een half-kapot bronnen.js achter.
//
// Bij vervangen blijft de rest van het bestand byte-voor-byte gelijk. Alleen
// het blok van die ene bron wordt herschreven (opmerkingen binnen dat blok
// gaan daarbij verloren, opmerkingen tussen de blokken niet).

const fs = require("fs/promises");
const path = require("path");

const BRONNEN_PAD = path.join(__dirname, "bronnen.js");
const VOLGORDE = ["id", "naam", "categorie", "type", "url", "soort", "rustig", "selectors", "json"];

function isIdentifier(sleutel) {
  return /^[A-Za-z_$][\w$]*$/.test(sleutel);
}

/** Schrijft een waarde als JavaScript-literal met onbelemmerde sleutels en nette inspringing. */
function naarLiteral(waarde, inspringing) {
  if (waarde === null || typeof waarde !== "object") return JSON.stringify(waarde);
  const binnen = `${inspringing}  `;
  const regels = Object.entries(waarde)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${binnen}${isIdentifier(k) ? k : JSON.stringify(k)}: ${naarLiteral(v, binnen)},`);
  return `{\n${regels.join("\n")}\n${inspringing}}`;
}

/** Het tekstblok voor één bron, in dezelfde vorm als de rest van bronnen.js. */
function bronNaarTekst(bron) {
  const sleutels = [...VOLGORDE.filter((k) => bron[k] !== undefined), ...Object.keys(bron).filter((k) => !VOLGORDE.includes(k) && bron[k] !== undefined)];
  const regels = sleutels.map((k) => `    ${k}: ${naarLiteral(bron[k], "    ")},`);
  return `  {\n${regels.join("\n")}\n  },`;
}

/** Zoekt het blok van een bron (van "  {" tot en met "  },") en geeft de grenzen terug, of null. */
function vindBlok(inhoud, id) {
  const idPositie = inhoud.search(new RegExp(`\\n    id:\\s*["']${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`));
  if (idPositie === -1) return null;
  const start = inhoud.lastIndexOf("\n  {", idPositie) + 1;
  const eindMarker = inhoud.indexOf("\n  },", idPositie);
  if (start === 0 || eindMarker === -1) return null;
  return { start, einde: eindMarker + "\n  },".length };
}

function laadBronnenOpnieuw() {
  delete require.cache[require.resolve("./bronnen")];
  return require("./bronnen");
}

/**
 * Voegt de bron toe, of vervangt het bestaande blok met hetzelfde id.
 * Geeft { actie: "toegevoegd" | "vervangen" } terug. Gooit een fout (en zet
 * het bestand terug) als bronnen.js daarna niet valideert.
 */
async function schrijfBron(bron) {
  const origineel = await fs.readFile(BRONNEN_PAD, "utf-8");
  const blok = vindBlok(origineel, bron.id);
  const tekst = bronNaarTekst(bron);

  let bijgewerkt;
  let actie;
  if (blok) {
    bijgewerkt = origineel.slice(0, blok.start) + tekst + origineel.slice(blok.einde);
    actie = "vervangen";
  } else {
    if (!/\];\s*$/.test(origineel)) throw new Error("bronnen.js eindigt niet op '];', dus ik weet niet waar de nieuwe bron moet komen.");
    bijgewerkt = origineel.replace(/\];\s*$/, `${tekst}\n];\n`);
    actie = "toegevoegd";
  }

  await fs.writeFile(BRONNEN_PAD, bijgewerkt, "utf-8");
  try {
    const { valideerBronnen } = require("./valideer-bronnen");
    const lijst = laadBronnenOpnieuw();
    const fouten = valideerBronnen(lijst);
    if (!lijst.some((b) => b.id === bron.id)) fouten.push(`de bron "${bron.id}" staat na het schrijven niet in bronnen.js`);
    if (fouten.length) throw new Error(`bronnen.js is na het schrijven ongeldig: ${fouten.join("; ")}`);
  } catch (fout) {
    await fs.writeFile(BRONNEN_PAD, origineel, "utf-8");
    laadBronnenOpnieuw();
    throw new Error(`${fout.message} (bronnen.js is teruggezet naar de vorige staat)`);
  }
  return { actie };
}

module.exports = { schrijfBron, bronNaarTekst, vindBlok, BRONNEN_PAD };
