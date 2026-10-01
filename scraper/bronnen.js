// bronnen.js
// Centrale lijst van bronnen. Elke bron krijgt een categorie: "lokaal" of "landelijk".
// Voeg hier nieuwe bronnen toe zodra je er meer wilt scrapen — de rest van de
// pipeline (scoren, AI-beoordeling, front-end) werkt automatisch mee.

module.exports = [
  {
    id: "zaansche-molen",
    naam: "De Zaansche Molen — Nieuws",
    categorie: "lokaal",
    type: "wordpress-html", // scraapt de HTML van een WordPress-nieuwsoverzicht
    url: "https://www.zaanschemolen.nl/nieuws/",
  },
  {
    id: "ibabs-collegeberichten",
    naam: "Zaanstad — Collegeberichten (iBabs)",
    categorie: "lokaal",
    type: "ibabs",
    url: "https://zaanstad.bestuurlijkeinformatie.nl/Reports/Details/8ea04074-52e6-4284-bd1a-66e378b40ec1",
  },
  {
    id: "ibabs-ingekomen-stukken",
    naam: "Zaanstad — Ingekomen stukken (iBabs)",
    categorie: "lokaal",
    type: "ibabs",
    url: "https://zaanstad.bestuurlijkeinformatie.nl/Reports/Details/58e397b1-0b36-49e2-90ed-325405f27f72",
  },
  {
    id: "ovo-zaanstad",
    naam: "OVO Zaanstad (koepel 7 vo-scholen)",
    categorie: "lokaal",
    type: "generieke-lijst",
    url: "https://www.ovo-zaanstad.nl/nieuws/",
  },
  {
    id: "blaise-pascal-college",
    naam: "Blaise Pascal College",
    categorie: "lokaal",
    type: "generieke-lijst",
    url: "https://www.blaisepascalcollege.nl/",
  },
  {
    id: "pascal-zuid",
    naam: "Pascal Zuid",
    categorie: "lokaal",
    type: "wordpress-html",
    url: "https://pascalzuid.nl/pascal-zuid/nieuws/",
  },
  {
    id: "zaans-museum",
    naam: "Zaans Museum — Nieuws & Pers",
    categorie: "lokaal",
    type: "generieke-lijst",
    url: "https://zaansmuseum.nl/nieuws-pers/",
  },
  {
    id: "zaanse-schans",
    naam: "Zaanse Schans — Actueel",
    categorie: "lokaal",
    type: "generieke-lijst",
    url: "https://www.dezaanseschans.nl/contact/actueel/",
  },
  {
    id: "hhnk-nieuws",
    naam: "Hoogheemraadschap Hollands Noorderkwartier — Nieuws",
    categorie: "lokaal",
    type: "generieke-lijst",
    url: "https://www.hhnk.nl/nieuws",
  },
  {
    id: "hhnk-actueel",
    naam: "Hoogheemraadschap Hollands Noorderkwartier — Actueel",
    categorie: "lokaal",
    type: "generieke-lijst",
    url: "https://www.hhnk.nl/actueel",
  },
  {
    id: "nh-actueel",
    naam: "Provincie Noord-Holland — Actueel",
    categorie: "lokaal",
    // De /Actueel-pagina zelf heeft een opmaak die geen van de generieke
    // patronen herkent (0 berichten, structureel). De provincie heeft
    // echter een eigen RSS-feed met exact dezelfde content, mét nette
    // pubDate's — dus die gebruiken we in plaats van HTML te scrapen.
    type: "rss",
    url: "https://www.noord-holland.nl/pnhnieuws",
  },
  {
    id: "nh-cultuur",
    naam: "Provincie Noord-Holland — Cultuur en Erfgoed",
    categorie: "lokaal",
    type: "generieke-lijst",
    url: "https://www.noord-holland.nl/Onderwerpen/Cultuur_en_Erfgoed",
  },
  {
    id: "zaanstad-hoorzittingen",
    naam: "zaanstad-hoorzittingen",
    categorie: "lokaal",
    type: "gemini-recept",
    url: "https://loket.zaanstad.nl/mozard/!suite16.scherm1168?mGmr=2168",
    selectors: {"itemSelector":".zaakregel","titelSelector":"h3","linkSelector":"a.zaakregel__verwijzing","datumSelector":null,"datumAttribuut":null},
  },
  {
    id: "zaandijk-leeft",
    naam: "zaandijk-leeft",
    categorie: "lokaal",
    type: "wordpress-html",
    url: "https://zaandijkleeft.nl/",
  },
  {
    id: "OmgevingsdienstNHN",
    naam: "OmgevingsdienstNHN",
    categorie: "lokaal",
    type: "generieke-lijst",
    url: "https://www.odnhn.nl/Menu/Over_ons/Nieuws/2022",
  },
  {
    id: "omgevingsdienstnoordzeekanaal",
    naam: "omgevingsdienstnoordzeekanaal",
    categorie: "lokaal",
    type: "wordpress-html",
    url: "https://odnzkg.nl/nieuws/",
  },
  {
    id: "zaans-cultuur-huis",
    naam: "zaans-cultuur-huis",
    categorie: "lokaal",
    type: "generieke-lijst",
    url: "https://zaanscultuurhuis.nl/agenda",
  },
  {
    id: "WaarheenAgenda",
    naam: "WaarheenAgenda",
    categorie: "lokaal",
    type: "gemini-recept",
    url: "https://waarheen.deorkaan.nl/agenda/",
    soort: "agenda",
    selectors: {
      itemSelector: "a.event-card",
      titelSelector: "h2",
      linkSelector: "self",
      datumSelector: ".date",
      datumAttribuut: null,
    },
  },
  {
    id: "hhnk",
    naam: "hhnk",
    categorie: "lokaal",
    type: "generieke-lijst",
    url: "https://www.hhnk.nl/nieuws",
  },
];
