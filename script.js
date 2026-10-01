// script.js — front-end logica
//
// Deze pagina leest drie statische JSON-bestanden die de GitHub Actions-
// workflow elke avond ververst: data/pitches.json, data/nieuws-lokaal.json
// en data/nieuws-landelijk.json. Geen backend nodig — alles is een simpele
// fetch() naar bestanden in dezelfde repo.

async function laadJson(pad) {
  const response = await fetch(pad, { cache: "no-store" });
  if (!response.ok) throw new Error(`Kon ${pad} niet laden (HTTP ${response.status})`);
  return response.json();
}

function formatteerDatum(isoTekst) {
  if (!isoTekst) return "datum onbekend";
  const datum = new Date(isoTekst);
  if (isNaN(datum.getTime())) return "datum onbekend";
  return datum.toLocaleString("nl-NL", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function renderPitches(data) {
  const container = document.getElementById("pitches-lijst");
  const updateEl = document.getElementById("laatste-update");

  if (updateEl && data.gegenereerdOp) {
    updateEl.textContent = `Laatst bijgewerkt: ${formatteerDatum(data.gegenereerdOp)} · ${data.aantalBerichtenTotaal ?? "?"} berichten verwerkt vandaag`;
  }

  if (!data.topPitches || data.topPitches.length === 0) {
    container.innerHTML = '<p class="leeg">Nog geen pitches vandaag — kom later terug of bekijk de volledige lijsten hieronder.</p>';
    return;
  }

  container.innerHTML = data.topPitches.map(renderPitchKaart).join("");
}

function renderPitchKaart(bericht) {
  const beoordeling = bericht.aiBeoordeling || {};
  const isLandelijk = bericht.categorie === "landelijk";
  const kop = isLandelijk ? beoordeling.voorgesteldeKop : null;
  const invalshoek = isLandelijk ? beoordeling.pitchUitleg || beoordeling.aanleiding : beoordeling.invalshoek;
  const stappen = isLandelijk && Array.isArray(beoordeling.vervolgstappen) ? beoordeling.vervolgstappen : [];

  return `
    <article class="pitch-kaart">
      <span class="badge ${bericht.categorie}">${bericht.categorie}</span>
      ${kop ? `<h3>${escapeHtml(kop)}</h3><p class="bron-titel">Origineel: <a href="${escapeHtml(bericht.url)}" target="_blank" rel="noopener">${escapeHtml(bericht.titel)}</a></p>` : `<h3><a href="${escapeHtml(bericht.url)}" target="_blank" rel="noopener">${escapeHtml(bericht.titel)}</a></h3>`}
      <div class="bericht-meta">${escapeHtml(bericht.bronNaam)} · ${formatteerDatum(bericht.gepubliceerdOp)}</div>
      ${invalshoek ? `<p class="invalshoek">${escapeHtml(invalshoek)}</p>` : ""}
      ${stappen.length > 0 ? `<ul class="vervolgstappen">${stappen.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>` : ""}
      <div class="score">score: ${bericht.score}</div>
    </article>
  `;
}

function renderBerichtenLijst(containerId, berichten) {
  const container = document.getElementById(containerId);
  if (!berichten || berichten.length === 0) {
    container.innerHTML = '<p class="leeg">Geen berichten gevonden voor vandaag.</p>';
    return;
  }

  container.innerHTML = berichten.map(renderBerichtRij).join("");
}

function renderBerichtRij(bericht) {
  return `
    <div class="bericht-rij">
      <a href="${escapeHtml(bericht.url)}" target="_blank" rel="noopener">${escapeHtml(bericht.titel)}</a>
      <span class="bericht-meta">${escapeHtml(bericht.bronNaam)} · score ${bericht.score}</span>
    </div>
  `;
}

function escapeHtml(tekst) {
  const div = document.createElement("div");
  div.textContent = tekst ?? "";
  return div.innerHTML;
}

async function initialiseer() {
  try {
    const pitches = await laadJson("data/pitches.json");
    renderPitches(pitches);
  } catch (fout) {
    document.getElementById("pitches-lijst").innerHTML = `<p class="foutmelding">Pitches konden niet geladen worden: ${fout.message}</p>`;
  }

  try {
    const lokaal = await laadJson("data/nieuws-lokaal.json");
    renderBerichtenLijst("lokaal-lijst", lokaal);
  } catch (fout) {
    document.getElementById("lokaal-lijst").innerHTML = `<p class="foutmelding">Lokaal nieuws kon niet geladen worden: ${fout.message}</p>`;
  }

  try {
    const landelijk = await laadJson("data/nieuws-landelijk.json");
    renderBerichtenLijst("landelijk-lijst", landelijk);
  } catch (fout) {
    document.getElementById("landelijk-lijst").innerHTML = `<p class="foutmelding">Landelijk nieuws kon niet geladen worden: ${fout.message}</p>`;
  }
}

initialiseer();
