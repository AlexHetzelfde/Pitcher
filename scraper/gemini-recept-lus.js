// gemini-recept-lus.js
//
// De Gemini-stap van bron-ontdekking.js. Gemini leest de HELE pagina, één
// keer, en bedenkt hoe de berichten voortaan automatisch opgehaald kunnen
// worden (een "recept"). Daarna doet gewone code dat elke nacht gratis en
// vast; Gemini is dus alleen het uitzoekwerk.
//
// Drie dingen maken dit betrouwbaar in plaats van hopen:
//
//   1. De hele pagina (opgeschoond), niet de eerste 25.000 tekens. Scripts,
//      svg, inline styles en data-uris gaan eruit, zodat Gemini structuur
//      ziet in plaats van ruis. Wat overblijft past ruim in de context.
//
//   2. Gemini geeft naast het recept ook een lijst van ALLE berichten die hij
//      zelf op de pagina ziet. De code controleert eerst of die links echt in
//      de pagina staan (tegen verzinsels), en de poort eist daarna dat het
//      recept die lijst voor minstens 80% terugvindt. Vindt het recept 3 van
//      de 12, dan wordt het afgekeurd.
//
//   3. Afgekeurd? Dan probeert Gemini het opnieuw, met CONCRETE feedback:
//      hoeveel elementen de selector matchte, welke berichten ontbraken en de
//      HTML rondom die berichten. Poging 2 en 3 gebruiken een sterker model;
//      vanaf poging 3 geeft de code ook kandidaat-blokken (herhalende
//      elementen die de gezochte links bevatten) waaruit Gemini kan kiezen.
//
// Gemini kiest ook de ROUTE: selectors (CSS), een feed-url, of een JSON-API.
// Elke route gaat daarna door dezelfde poort als alle andere methodes.

const cheerio = require("cheerio");
const { normaliseerUrl } = require("./bron-poort");

const MAX_HTML_TEKENS = Number(process.env.MAX_HTML_TEKENS_VOOR_GEMINI || 400_000);
const MAX_POGINGEN = Number(process.env.MAX_GEMINI_POGINGEN || 4);
const MODELLEN = (process.env.GEMINI_MODELLEN || "gemini-flash-lite-latest,gemini-flash-latest,gemini-pro-latest")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
const MAX_GEZIEN = 50;
const MAX_HTML_VOORBEELD = 1200;

const ATTRIBUTEN_WEG = new Set(["style", "srcset", "sizes", "loading", "decoding", "fetchpriority", "tabindex", "integrity", "crossorigin", "nonce"]);

// ---------------------------------------------------------------------------
// 1. De pagina opschonen
// ---------------------------------------------------------------------------

/**
 * Maakt de HTML compact zonder de structuur aan te tasten: alleen dingen die
 * nooit een bericht bevatten gaan eruit. Selectors die Gemini op deze versie
 * bedenkt, werken daarom ook op de originele pagina.
 *
 * Geeft { html, hints, ingekort }. hints zijn de dingen die je uit de
 * scripts en de head wilt weten voor een feed- of API-route, in korte vorm.
 */
function maakSchoneHtml(html, paginaUrl) {
  const $ = cheerio.load(html);

  // Aanwijzingen verzamelen voordat de scripts verdwijnen.
  const hints = [];
  $('link[rel~="alternate"]').each((_, el) => {
    const type = $(el).attr("type");
    const href = $(el).attr("href");
    if (href && type && /rss|atom|json/i.test(type)) hints.push(`feed-link (${type}): ${new URL(href, paginaUrl).toString()}`);
  });
  const apiHref = $('link[rel="https://api.w.org/"]').attr("href");
  if (apiHref) hints.push(`WordPress REST API: ${new URL(apiHref, paginaUrl).toString()}`);
  const scriptBronnen = [];
  $("script[src]").each((_, el) => {
    if (scriptBronnen.length < 25) scriptBronnen.push($(el).attr("src"));
  });
  if (scriptBronnen.length) hints.push(`scripts: ${scriptBronnen.join(", ")}`);
  $('script[type="application/json"], script[type="application/ld+json"]').each((i, el) => {
    if (i >= 5) return;
    const inhoud = $(el).contents().text().trim();
    if (inhoud) hints.push(`${$(el).attr("type")}${$(el).attr("id") ? ` #${$(el).attr("id")}` : ""} (eerste 3000 tekens): ${inhoud.slice(0, 3000)}`);
  });

  const opschonen = () => {
    $("script, style, svg, noscript, iframe, canvas, template, meta, link[rel=stylesheet], link[rel=preload], link[rel=prefetch]").remove();
    $("*")
      .contents()
      .filter((_, n) => n.type === "comment")
      .remove();
    $("*").each((_, el) => {
      const attributen = el.attribs;
      if (!attributen) return;
      for (const naam of Object.keys(attributen)) {
        const waarde = attributen[naam];
        if (ATTRIBUTEN_WEG.has(naam) || naam.startsWith("aria-") || /^on[a-z]+$/.test(naam)) {
          delete attributen[naam];
        } else if (typeof waarde === "string" && waarde.startsWith("data:")) {
          attributen[naam] = "data:…";
        } else if (typeof waarde === "string" && waarde.length > 300) {
          attributen[naam] = `${waarde.slice(0, 300)}…`;
        }
      }
    });
  };
  const naarTekst = () => $.html().replace(/>\s+</g, "><").replace(/\s{2,}/g, " ").trim();

  opschonen();
  let resultaat = naarTekst();
  let ingekort = false;

  // Alleen als het nog steeds te groot is: navigatie, header, footer, zijbalk en formulieren eruit.
  if (resultaat.length > MAX_HTML_TEKENS) {
    $("nav, header, footer, aside, form").remove();
    resultaat = naarTekst();
  }
  if (resultaat.length > MAX_HTML_TEKENS) {
    resultaat = `${resultaat.slice(0, MAX_HTML_TEKENS)}<!-- ingekort -->`;
    ingekort = true;
  }
  return { html: resultaat, hints, ingekort };
}

// ---------------------------------------------------------------------------
// 2. De prompt
// ---------------------------------------------------------------------------

function formatteerFeedback(f) {
  const regels = [`--- POGING ${f.poging} (${f.model || "model onbekend"}, route: ${f.route || "onbekend"}) WAS NIET GOED ---`];
  if (f.toelichting) regels.push(`Jouw toelichting toen: ${f.toelichting}`);
  if (f.recept) regels.push(`Jouw recept was: ${JSON.stringify(f.recept)}`);
  if (f.probleem) regels.push(`Probleem: ${f.probleem}`);
  for (const r of f.redenen || []) regels.push(`Afgekeurd omdat: ${r}`);
  if (f.matchStats) {
    regels.push(
      `De itemSelector matchte ${f.matchStats.matches} element(en) op de pagina; daarvan hadden er ${f.matchStats.metTitel} een titel en ${f.matchStats.metLink} een link. Na controle bleven ${f.aantalGevonden} bruikbare berichten over.`
    );
  } else if (f.aantalGevonden != null) {
    regels.push(`Het recept leverde ${f.aantalGevonden} bruikbare bericht(en) op.`);
  }
  if (f.aantalVerwacht != null) regels.push(`In jouw eigen lijst stonden ${f.aantalVerwacht} berichten.`);
  if (f.padHint) regels.push(f.padHint);
  if (f.voorbeeldGevonden && f.voorbeeldGevonden.length) {
    regels.push("Voorbeelden van wat het recept WEL vond:");
    f.voorbeeldGevonden.forEach((b) => regels.push(`  - "${b.titel}" (${b.url}) datum: ${b.datum || "geen"}`));
  }
  if (f.ontbrekend && f.ontbrekend.length) {
    regels.push("Deze berichten uit jouw eigen lijst vond het recept NIET:");
    f.ontbrekend.forEach((b) => {
      regels.push(`  - "${b.titel}" (${b.url})`);
      if (b.htmlRond) regels.push(`    HTML rondom dit bericht: ${b.htmlRond}`);
    });
  }
  return regels.join("\n");
}

function formatteerKandidaatBlokken(blokken) {
  if (!blokken || blokken.length === 0) return "";
  const regels = [
    "--- KANDIDAAT-BLOKKEN (door de code gevonden) ---",
    "Dit zijn herhalende elementen op de pagina die de links uit jouw eigen lijst bevatten. Kies er een als itemSelector (of een preciezere variant), of geef een eigen recept:",
  ];
  blokken.forEach((b, i) => {
    regels.push(`${i + 1}. ${b.selector}: ${b.aantal} elementen op de pagina, bevat ${b.dekking} van jouw berichten. Voorbeeld: ${b.voorbeeldHtml}`);
  });
  return regels.join("\n");
}

function bouwPrompt({ url, schoon, geschiedenis, kandidaatBlokken }) {
  const feedback = geschiedenis.length ? `\n\n${geschiedenis.map(formatteerFeedback).join("\n\n")}\n\nDoe het nu BETER. Kijk goed naar wat er mis ging en pas je recept daarop aan.` : "";
  const blokken = kandidaatBlokken && kandidaatBlokken.length ? `\n\n${formatteerKandidaatBlokken(kandidaatBlokken)}` : "";
  const hints = schoon.hints.length ? `\n\nAANWIJZINGEN UIT DE HEAD EN DE SCRIPTS:\n${schoon.hints.join("\n")}` : "";

  return `Je krijgt de opgeschoonde HTML van een pagina met een lijst nieuwsberichten of evenementen (${url}).
Bepaal hoe die berichten voortaan automatisch opgehaald kunnen worden. Een script haalt de pagina elke nacht opnieuw op en past jouw recept toe, dus het recept moet ook werken voor berichten die er nu nog niet staan.

Kies precies EEN route:
1. "selectors": de berichten staan in de HTML zelf. Geef CSS-selectors (cheerio) voor het herhalende blok en voor titel, link en datum daarbinnen. Dit is de gebruikelijke route.
2. "feed": een RSS/Atom-feed die de berichten van DEZE pagina bevat (dus geen lege of algemene blog-feed). Alleen kiezen als de aanwijzingen zo'n feed noemen.
3. "json-api": de berichten worden via een JSON-endpoint geladen dat in de aanwijzingen of de HTML zichtbaar is. Geef de url en welke velden titel, link en datum bevatten.
4. "geen": de berichten staan niet in deze HTML (bijvoorbeeld een lege pagina met "Loading..." omdat alles met JavaScript wordt opgebouwd, of een inlogscherm).

Geef daarnaast ALTIJD "gezienBerichten": alle berichten die je in de HTML ziet staan (maximaal ${MAX_GEZIEN}, in volgorde van de pagina), met titel, url (exact zoals in de href, ook als die relatief is) en datum (zoals zichtbaar, of null). Laat menu-items, filters, paginering en zijbalklinks weg. De code controleert of jouw recept deze berichten terugvindt; een recept dat er maar een deel van vindt wordt afgekeurd.

Regels voor selectors:
- titelSelector: relatief aan het item-blok. Leeg-string alleen als het hele blok de titel is.
- linkSelector: relatief aan het item-blok, of het woord self als de titel zelf (of een omvattend element) de link is.
- datumSelector: relatief aan het item-blok, of null als er geen apart datum-element is. Staat de datum in de titeltekst (bijvoorbeeld "2026-09-22 Dinsdag 22 september 2026 om 17.15 uur - ..."), zet datumSelector dan op null: de titeltekst wordt daarna automatisch op een datum doorzocht. Staat de datum zonder jaar ("30 sep"), laat die dan gewoon zo staan; het jaar wordt door de code aangevuld.
- datumAttribuut: naam van het attribuut waar de datum in staat (bijvoorbeeld datetime), of null om de zichtbare tekst te gebruiken.
- Kies selectors die specifiek genoeg zijn om geen menu-items mee te nemen, maar breed genoeg om alle berichten te vangen.

Geef ALLEEN geldige JSON terug, exact dit formaat, geen markdown-fences en geen andere tekst:
{
  "route": "selectors" | "feed" | "json-api" | "geen",
  "toelichting": "een of twee zinnen over je keuze",
  "selectors": { "itemSelector": "...", "titelSelector": "...", "linkSelector": "...", "datumSelector": "... of null", "datumAttribuut": "... of null" } of null,
  "feedUrl": "https://... of null",
  "jsonApi": { "url": "https://...", "itemsPad": "pad naar de lijst, bijvoorbeeld data.items, of leeg als de JSON zelf de lijst is", "titelVeld": "...", "linkVeld": "...", "datumVeld": "... of null", "samenvattingVeld": "... of null" } of null,
  "gezienBerichten": [ { "titel": "...", "url": "...", "datum": "... of null" } ]
}${hints}${feedback}${blokken}

HTML:
${schoon.html}`;
}

// ---------------------------------------------------------------------------
// 3. Gemini aanroepen
// ---------------------------------------------------------------------------

function wacht(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function roepGeminiAan(model, prompt, apiKey) {
  for (let poging = 1; poging <= 2; poging++) {
    let response;
    try {
      response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, responseMimeType: "application/json", maxOutputTokens: 16384 },
        }),
      });
    } catch (fout) {
      return { fout: `netwerkfout: ${fout.message}` };
    }
    if (response.ok) {
      const data = await response.json();
      const delen = data?.candidates?.[0]?.content?.parts || [];
      const tekst = delen.filter((d) => !d.thought && typeof d.text === "string").map((d) => d.text).join("");
      return tekst ? { tekst } : { fout: "leeg antwoord" };
    }
    // Tijdelijke fouten (limiet, overbelasting) krijgen één nieuwe kans.
    if ([429, 500, 503].includes(response.status) && poging === 1) {
      await wacht(5000);
      continue;
    }
    return { fout: `HTTP ${response.status}` };
  }
  return { fout: "onbekende fout" };
}

/** Standaard-aanroep: het gewenste model, en als dat niet lukt (niet beschikbaar, limiet) telkens het model eronder. */
function maakStandaardVraag(apiKey, log) {
  return async ({ modelIndex, prompt }) => {
    for (let i = modelIndex; i >= 0; i--) {
      const uit = await roepGeminiAan(MODELLEN[i], prompt, apiKey);
      if (uit.tekst) return uit.tekst;
      log.log(`  Gemini (${MODELLEN[i]}) mislukte: ${uit.fout}${i > 0 ? `; terugvallen op ${MODELLEN[i - 1]}` : ""}`);
    }
    return null;
  };
}

/** Leest het antwoord van Gemini: object of JSON-tekst (eventueel met markdown-fences). */
function leesAntwoord(ruw) {
  if (ruw && typeof ruw === "object") return ruw;
  if (typeof ruw !== "string") return null;
  try {
    return JSON.parse(ruw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 4. Antwoord controleren en omzetten naar een kandidaat-bron
// ---------------------------------------------------------------------------

function geldigeSelector(selector) {
  try {
    cheerio.load("<div></div>")(selector);
    return true;
  } catch {
    return false;
  }
}

function absoluut(href, basis) {
  try {
    const u = new URL(href, basis);
    return ["http:", "https:"].includes(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Controleert Gemini's antwoord en zet het om in een kandidaat-bron voor de
 * poort. De lijst gezienBerichten wordt gefilterd op links die echt in de
 * pagina staan: Gemini mag niets verzinnen dat we vervolgens als waarheid
 * gebruiken om het recept mee te controleren.
 */
function valideerAntwoord(antwoord, { url, paginaLinks }) {
  const uit = { route: antwoord.route, toelichting: antwoord.toelichting, kandidaat: null, probleem: null, gezien: [], verzonnen: 0 };

  const gezien = [];
  const gezienSet = new Set();
  for (const b of Array.isArray(antwoord.gezienBerichten) ? antwoord.gezienBerichten : []) {
    if (!b || typeof b.url !== "string") continue;
    const volledig = absoluut(b.url, url);
    const norm = volledig && normaliseerUrl(volledig);
    if (!norm || gezienSet.has(norm)) continue;
    if (!paginaLinks.has(norm)) {
      uit.verzonnen++;
      continue;
    }
    gezienSet.add(norm);
    gezien.push({ titel: String(b.titel || "").trim(), url: volledig, datum: b.datum || null });
    if (gezien.length >= MAX_GEZIEN) break;
  }
  uit.gezien = gezien;

  switch (antwoord.route) {
    case "selectors": {
      const s = antwoord.selectors;
      if (!s || typeof s.itemSelector !== "string" || !s.itemSelector.trim()) {
        uit.probleem = 'Route "selectors" gekozen, maar er staat geen itemSelector in het antwoord.';
        break;
      }
      if (!s.linkSelector) {
        uit.probleem = 'Er staat geen linkSelector in het antwoord (gebruik het woord "self" als de titel zelf de link is).';
        break;
      }
      const alle = [s.itemSelector, s.titelSelector, s.datumSelector].filter((x) => typeof x === "string" && x.trim());
      if (s.linkSelector !== "self") alle.push(s.linkSelector);
      const kapot = alle.find((sel) => !geldigeSelector(sel));
      if (kapot) {
        uit.probleem = `De selector "${kapot}" is geen geldige CSS-selector.`;
        break;
      }
      uit.kandidaat = {
        type: "gemini-recept",
        url,
        selectors: {
          itemSelector: s.itemSelector.trim(),
          titelSelector: typeof s.titelSelector === "string" ? s.titelSelector.trim() : "",
          linkSelector: s.linkSelector,
          datumSelector: typeof s.datumSelector === "string" && s.datumSelector.trim() ? s.datumSelector.trim() : null,
          datumAttribuut: typeof s.datumAttribuut === "string" && s.datumAttribuut.trim() ? s.datumAttribuut.trim() : null,
        },
      };
      break;
    }
    case "feed": {
      const feedUrl = typeof antwoord.feedUrl === "string" ? absoluut(antwoord.feedUrl, url) : null;
      if (!feedUrl) uit.probleem = 'Route "feed" gekozen, maar feedUrl ontbreekt of is geen geldige url.';
      else uit.kandidaat = { type: "rss", url: feedUrl };
      break;
    }
    case "json-api": {
      const j = antwoord.jsonApi;
      const apiUrl = j && typeof j.url === "string" ? absoluut(j.url, url) : null;
      if (!apiUrl || !j.titelVeld || !j.linkVeld) {
        uit.probleem = 'Route "json-api" gekozen, maar url, titelVeld of linkVeld ontbreekt.';
        break;
      }
      const json = { itemsPad: j.itemsPad || "", titelVeld: j.titelVeld, linkVeld: j.linkVeld };
      if (j.datumVeld) json.datumVeld = j.datumVeld;
      if (j.samenvattingVeld) json.samenvattingVeld = j.samenvattingVeld;
      uit.kandidaat = { type: "json-api", url: apiUrl, json };
      break;
    }
    case "geen":
      uit.probleem = "Gemini ziet geen berichten in de HTML (waarschijnlijk met JavaScript opgebouwd of achter een login).";
      break;
    default:
      uit.probleem = `Onbekende route "${antwoord.route}" (verwacht: selectors, feed, json-api of geen).`;
  }
  return uit;
}

// ---------------------------------------------------------------------------
// 5. Feedback voor een volgende poging
// ---------------------------------------------------------------------------

/** Diagnose van een selector-recept op de echte pagina: hoeveel elementen, en waar het misgaat. */
function analyseerSelectors($, selectors) {
  const stats = { matches: 0, metTitel: 0, metLink: 0 };
  $(selectors.itemSelector).each((_, el) => {
    stats.matches++;
    const titelEl = selectors.titelSelector ? $(el).find(selectors.titelSelector).first() : $(el);
    if (titelEl.text().trim()) stats.metTitel++;
    const link = selectors.linkSelector === "self" ? (titelEl.is("a") ? titelEl.attr("href") : titelEl.find("a").attr("href")) : $(el).find(selectors.linkSelector).attr("href");
    if (link) stats.metLink++;
  });
  return stats;
}

/** Het herhalende HTML-blok rondom een link, ingekort. Laat Gemini zien hoe een bericht dat het recept miste er echt uitziet. */
function htmlRondLink($, doelNorm, paginaUrl) {
  let anker = null;
  $("a[href]").each((_, el) => {
    if (!anker && normaliseerUrl($(el).attr("href"), paginaUrl) === doelNorm) anker = el;
  });
  if (!anker) return null;
  let el = anker;
  for (let stap = 0; stap < 6; stap++) {
    const ouder = el.parent;
    if (!ouder || ouder.type !== "tag" || ["body", "html"].includes(ouder.name)) break;
    if (stap >= 1 && $(ouder).children(el.name).length >= 3) break; // el is een van meerdere gelijke broers: dit is het herhalende blok
    el = ouder;
  }
  return $.html(el).replace(/\s+/g, " ").slice(0, MAX_HTML_VOORBEELD);
}

function selectorVoor($, el) {
  const klassen = ($(el).attr("class") || "").split(/\s+/).filter((k) => /^[A-Za-z_][\w-]*$/.test(k)).slice(0, 3);
  return `${el.name}${klassen.map((k) => `.${k}`).join("")}`;
}

/**
 * Zoekt herhalende blokken die de referentie-links bevatten. Werkt zonder AI:
 * voor elke referentie-link omhoog lopen door de voorouders, en tellen
 * welke tag+klasse-combinaties vaak voorkomen en veel referenties omvatten.
 */
function vindKandidaatBlokken($, referentieUrls, paginaUrl) {
  const doelen = new Set(referentieUrls.map((u) => normaliseerUrl(u)));
  const ankers = [];
  $("a[href]").each((_, el) => {
    const norm = normaliseerUrl($(el).attr("href"), paginaUrl);
    if (doelen.size ? doelen.has(norm) : $(el).closest("h1, h2, h3, h4").length) ankers.push(el);
  });
  if (ankers.length < 2) return [];

  const perSelector = new Map();
  ankers.forEach((anker, index) => {
    let el = anker.parent;
    for (let stap = 0; stap < 6 && el && el.type === "tag" && !["body", "html"].includes(el.name); stap++, el = el.parent) {
      const sel = selectorVoor($, el);
      if (!perSelector.has(sel)) perSelector.set(sel, new Set());
      perSelector.get(sel).add(index);
    }
  });

  const minimaal = Math.max(2, Math.ceil(ankers.length * 0.5));
  return [...perSelector.entries()]
    .map(([selector, dekking]) => ({ selector, dekking: dekking.size, aantal: $(selector).length }))
    .filter((b) => b.dekking >= minimaal && b.aantal >= 2 && b.aantal <= 300)
    .sort((a, b) => b.dekking - a.dekking || Math.abs(a.aantal - ankers.length) - Math.abs(b.aantal - ankers.length))
    .slice(0, 5)
    .map((b) => ({ ...b, voorbeeldHtml: $.html($(b.selector).first()).replace(/\s+/g, " ").slice(0, MAX_HTML_VOORBEELD) }));
}

/** Links onder hetzelfde pad als de lijstpagina (geen filters, geen paginering): de "verwachte" berichtlinks. */
function bepaalPadKandidaten(paginaLinks, url) {
  const eigen = normaliseerUrl(url);
  if (!eigen) return [];
  const pad = eigen.replace(/\?.*$/, "");
  const padDeel = pad.replace(/^[^/]+/, "");
  if (padDeel === "" || padDeel === "/") return []; // startpagina: te veel ruis (menu, footer)
  return [...paginaLinks].filter((l) => !l.includes("?") && l.startsWith(`${pad}/`) && !/\/(page|pagina)\/\d+$/.test(l));
}

function bouwFeedback({ poging, model, v, resultaat, $, url, verwacht, padKandidaten }) {
  const oordeel = resultaat ? resultaat.oordeel : null;
  const f = {
    poging,
    model,
    route: v.route,
    toelichting: v.toelichting,
    recept: v.kandidaat ? v.kandidaat.selectors || v.kandidaat.json || v.kandidaat.url : null,
    probleem: v.probleem,
    redenen: oordeel ? oordeel.redenen : [],
    aantalGevonden: oordeel ? oordeel.aantal : null,
    aantalVerwacht: verwacht.length || null,
    voorbeeldGevonden: oordeel ? oordeel.geldig.slice(0, 3).map((b) => ({ titel: b.titel, url: b.url, datum: b.gepubliceerdOp ? String(b.gepubliceerdOp).slice(0, 10) : null })) : [],
    ontbrekend: [],
  };
  if (v.kandidaat && v.kandidaat.selectors) {
    try {
      f.matchStats = analyseerSelectors($, v.kandidaat.selectors);
    } catch {
      /* ongeldige selector is al als probleem gemeld */
    }
  }
  if (oordeel && oordeel.ontbrekend.length) {
    f.ontbrekend = oordeel.ontbrekend.slice(0, 5).map((b, i) => ({
      titel: b.titel,
      url: b.url,
      htmlRond: i < 3 ? htmlRondLink($, normaliseerUrl(b.url), url) : null,
    }));
  }
  if (oordeel && oordeel.statistieken.padKandidaten) {
    f.padHint = `Op de pagina staan ${oordeel.statistieken.padKandidaten} links onder hetzelfde pad als de lijstpagina; het recept dekte ${Math.round(oordeel.statistieken.padDekking * 100)}% daarvan.`;
  } else if (padKandidaten.length >= 6 && oordeel) {
    f.padHint = `Op de pagina staan ${padKandidaten.length} links onder hetzelfde pad als de lijstpagina.`;
  }
  return f;
}

// ---------------------------------------------------------------------------
// 6. De lus
// ---------------------------------------------------------------------------

/**
 * Draait de zelfcorrigerende lus. ctx komt uit bron-ontdekking.js:
 *   $, html, url, paginaLinks, apiKey, vraagGemini (optioneel, voor tests),
 *   testKandidaat(kandidaat, extraOpties), verwerk(stap, resultaat), verslag, log
 * Geeft { klaar } terug: het eindresultaat bij succes, anders klaar: null.
 */
async function geminiPad(ctx) {
  const { $, html, url, paginaLinks, apiKey, testKandidaat, verwerk, verslag, log } = ctx;
  const vraag = ctx.vraagGemini || maakStandaardVraag(apiKey, log);

  const schoon = maakSchoneHtml(html, url);
  log.log(`  De hele pagina gaat naar Gemini: ${schoon.html.length} tekens (origineel ${html.length}${schoon.ingekort ? ", ingekort" : ""}).`);

  const padKandidaten = bepaalPadKandidaten(paginaLinks, url);
  const geschiedenis = [];
  let laatsteGezien = [];
  let geenAchtereen = 0;

  for (let poging = 1; poging <= MAX_POGINGEN; poging++) {
    const modelIndex = Math.min(poging - 1, MODELLEN.length - 1);
    const model = MODELLEN[modelIndex];
    const kandidaatBlokken = poging >= 3 ? vindKandidaatBlokken($, laatsteGezien.map((g) => g.url), url) : [];

    log.log(`\n  Poging ${poging}/${MAX_POGINGEN} (${model})${kandidaatBlokken.length ? `, met ${kandidaatBlokken.length} kandidaat-blok(ken)` : ""}...`);
    const prompt = bouwPrompt({ url, schoon, geschiedenis, kandidaatBlokken });

    let antwoord = null;
    try {
      antwoord = leesAntwoord(await vraag({ model, modelIndex, prompt, poging }));
    } catch (fout) {
      log.log(`  Gemini-aanroep mislukte: ${fout.message}`);
    }
    if (!antwoord) {
      const probleem = "Gemini gaf geen bruikbaar antwoord (geen geldige JSON).";
      log.log(`  ✗ ${probleem}`);
      verslag.push({ stap: `gemini-poging-${poging}`, kandidaat: `gemini poging ${poging} (${model})`, uitkomst: "afgekeurd", redenen: [probleem], waarschuwingen: [], aantal: 0 });
      geschiedenis.push({ poging, model, probleem });
      continue;
    }

    const v = valideerAntwoord(antwoord, { url, paginaLinks });
    if (v.gezien.length) laatsteGezien = v.gezien;
    log.log(`  Gemini koos route "${v.route}"; ziet ${v.gezien.length} bericht(en) op de pagina${v.verzonnen ? ` (${v.verzonnen} verzonnen link(s) genegeerd)` : ""}.`);

    if (v.route === "geen") {
      geenAchtereen++;
    } else {
      geenAchtereen = 0;
    }

    if (!v.kandidaat) {
      log.log(`  ✗ ${v.probleem}`);
      verslag.push({ stap: `gemini-poging-${poging}`, kandidaat: `gemini poging ${poging} (${model}), route ${v.route}`, uitkomst: "afgekeurd", redenen: [v.probleem], waarschuwingen: [], aantal: 0 });
      geschiedenis.push(bouwFeedback({ poging, model, v, resultaat: null, $, url, verwacht: v.gezien, padKandidaten }));
      // Twee keer achter elkaar "geen berichten in de HTML" is een duidelijk signaal (JavaScript-site): niet nog meer pogingen verspillen.
      if (geenAchtereen >= 2) {
        log.log("  Twee keer achter elkaar ziet Gemini geen berichten in de HTML; verder proberen heeft geen zin.");
        break;
      }
      continue;
    }

    // Selectors worden gecontroleerd op volledigheid tegen Gemini's eigen lijst; feed en API tegen de pagina zelf.
    const extra = v.kandidaat.type === "gemini-recept" ? { verwacht: v.gezien, padKandidaten } : { paginaLinks };
    const resultaat = await testKandidaat(v.kandidaat, extra);
    const klaar = verwerk(`gemini-poging-${poging}`, resultaat);
    if (klaar) return { klaar };

    geschiedenis.push(bouwFeedback({ poging, model, v, resultaat, $, url, verwacht: v.gezien, padKandidaten }));
  }
  return { klaar: null };
}

module.exports = {
  geminiPad,
  maakSchoneHtml,
  bouwPrompt,
  valideerAntwoord,
  vindKandidaatBlokken,
  bepaalPadKandidaten,
  htmlRondLink,
  leesAntwoord,
  MODELLEN,
  MAX_POGINGEN,
};
