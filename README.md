# Nieuwsaggregator Zaanstreek-Waterland

Dagelijkse scraper + AI-pitchmachine voor lokale journalistiek in Zaanstreek-Waterland.
Draait volledig gratis op GitHub Pages + GitHub Actions.

## Hoe het werkt

1. Elke avond om 18:00 (NL-tijd) start een GitHub Actions-workflow.
2. `scraper/index.js` haalt nieuws op van alle bronnen in `scraper/bronnen.js`.
3. Berichten worden geteld, gescoord (zie `scraper/score.js`) en gesplitst in
   een lokale en een landelijke lijst.
4. De hoogst scorende berichten (tot een dagcap) gaan één voor één naar
   Gemini, met de juiste prompt uit `scraper/gemini.js`.
5. De resultaten worden weggeschreven naar `data/*.json`.
6. De workflow committet die JSON-bestanden terug naar de repo.
7. GitHub Pages serveert `index.html`, dat die JSON-bestanden inleest en
   toont — inclusief de top 5 pitches van die dag.

## Eenmalige setup

### 1. Repo op GitHub zetten
Maak een nieuwe (public of private) GitHub-repo aan en push deze hele map
erheen.

### 2. GitHub Pages aanzetten
Ga naar **Settings → Pages** in je repo en zet de bron op **"Deploy from a
branch"**, branch `main`, map `/ (root)`. Na een paar minuten is de site
bereikbaar op `https://<gebruikersnaam>.github.io/<reponaam>/`.

### 3. Gemini API-key aanmaken
Maak een gratis API-key aan via [Google AI Studio](https://aistudio.google.com/apikey)
(inloggen met een Google-account, op "Create API key" klikken).

### 4. Gemini API-key opslaan als GitHub Secret — **hier, en alleen hier**
Dit is de enige veilige plek voor de key. **Zet 'm nooit in een bestand in de
repo zelf** (ook niet in een `.env`-bestand dat je per ongeluk commit) —
alles in een publieke repo is voor iedereen zichtbaar, en zelfs in een
private repo is een los secret veiliger dan een key die in de geschiedenis
van je commits blijft staan.

Zo zet je 'm goed weg:
1. Ga in je GitHub-repo naar **Settings → Secrets and variables → Actions**.
2. Klik op **"New repository secret"**.
3. Naam: `GEMINI_API_KEY`
4. Waarde: plak je Gemini API-key
5. Klik op **"Add secret"**.

GitHub Actions injecteert deze automatisch als omgevingsvariabele in de
workflow (zie `.github/workflows/dagelijkse-run.yml`, regel met
`GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}`). Het script zelf
(`scraper/gemini.js`) leest 'm alleen uit `process.env.GEMINI_API_KEY` — de
key staat dus nergens anders in de code.

Zonder deze secret blijft de scraper + het scoresysteem gewoon werken; alleen
de AI-beoordeling en de top-5 pitches slaan dan over (zie de waarschuwing die
`index.js` in dat geval print).

### 5. Eerste run
Ga naar het tabblad **Actions** in je repo, kies de workflow "Dagelijkse
nieuwsrun" en klik op **"Run workflow"** om 'm handmatig te testen zonder op
18:00 te wachten.

## Bronnen toevoegen
De gewone manier is de workflow **"Bron toevoegen"** (tabblad Actions). Vul de
url van de nieuwspagina in, een korte bron-id en de categorie. Het script zoekt
zelf uit hoe de bron het best opgehaald kan worden, in deze volgorde: RSS/Atom-
feed, WordPress REST API (ook eigen berichttypes zoals een agenda), JSON-LD
(schema.org), generieke HTML-patronen, en als laatste Gemini, die dan de hele
pagina leest en een recept bedenkt.

**Een bron komt alleen in `bronnen.js` als bewezen is dat hij werkt.** Elke
methode draait via dezelfde scraper als de dagelijkse run (`scraper/bron-poort.js`)
en moet berichten opleveren met een echte titel, een unieke link op dezelfde
site en een leesbare datum die niet overal gelijk is. Bij een Gemini-recept komt
daar een volledigheidscheck bij: Gemini geeft ook de lijst van alle berichten
die hij op de pagina ziet, en het recept moet er minstens 80% van terugvinden.
Lukt dat niet, dan krijgt Gemini concrete feedback (welke berichten ontbraken,
de HTML eromheen) en probeert hij het opnieuw, maximaal 4 keer, met een sterker
model en vanaf poging 3 met kandidaat-blokken die de code zelf vond. Lukt niets,
dan wordt de workflow rood, verandert er niets aan `bronnen.js` en staat er bij
de run-samenvatting wat er geprobeerd is.

Opties bij het toevoegen:
- **soort**: `auto` (standaard) herkent agenda's zelf. Kies `agenda` als de
  datums de datum van het evenement zijn (ook zonder jaar, zoals "30 sep").
  Zo'n bron krijgt `soort: "agenda"` en een eigen venster: van gisteren tot 14
  dagen vooruit, in plaats van "maximaal 7 dagen oud".
- **vervang**: een bestaande bron met hetzelfde id vervangen. Een bron die nu
  niets meer oplevert wordt altijd vervangen, een werkende alleen met deze optie.
- **accepteer twijfel**: alleen nodig als de workflow meldt dat er alleen een
  twijfelachtige kandidaat is (slaagt de poort, maar geen enkel bericht staat
  als link op de pagina). Controleer dan eerst de voorbeelden in de log.

Een bron met maar heel weinig berichten op de pagina krijgt `rustig: true`. De
dagelijkse run meldt "0 na leeftijdsfilter" dan niet als fout. "0 gevonden"
blijft voor elke bron rood.

### Bronnen die stuk gaan
De dagelijkse run houdt per bron bij hoeveel runs achter elkaar er niets
gevonden is (`data/bron-gezondheid.json`). Na twee lege runs zoekt
`scraper/herstel-bronnen.js` opnieuw uit hoe de bron op te halen is. Het
resultaat komt nooit direct op main: bij succes opent het een **pull request**
met de nieuwe configuratie en het bewijs, anders een **issue** met wat er
geprobeerd is. Je kunt het ook zelf starten met de workflow **"Bron herstellen"**.

Eenmalige repo-instelling: zet onder *Settings > Actions > General* de optie
**"Allow GitHub Actions to create and approve pull requests"** aan. Staat die
uit, dan valt het script terug op een issue en staat de oplossing klaar op de
branch `herstel/<bron-id>`.

### Handmatig in `scraper/bronnen.js`
Kan ook. Geldige `type`s (zie `scraper/scraper-register.js`):
- `"rss"`: een RSS/Atom-feed
- `"wp-rest"`: een WordPress REST API-endpoint (`/wp-json/wp/v2/...`)
- `"json-ld"`: schema.org-gegevens in de pagina zelf
- `"json-api"`: een los JSON-endpoint, met de veldkoppeling in `json`
- `"generieke-lijst"`: bekende HTML-patronen, eerst een feed-link in de pagina
- `"gemini-recept"`: CSS-selectors in `selectors`, meestal door Gemini bedacht
- `"wordpress-html"`: oudere WordPress-scraper (feed, anders HTML)
- `"ibabs"`: `*.bestuurlijkeinformatie.nl`-rapportpagina's

Controleer een wijziging met `node valideer-bronnen.js`. Voor een compleet nieuw
brontype: voeg een bestand toe in `scraper/scrapers/` dat een array van
genormaliseerde berichtobjecten teruggeeft (zie de bestaande scrapers voor het
exacte formaat) en registreer het in `scraper/scraper-register.js`.

## Scoresysteem en AI-prompts aanpassen
Alle trefwoordenlijsten en puntenwaarden staan in `scraper/score.js`. De twee
AI-prompts staan in `scraper/gemini.js`. Beide zijn gebaseerd op het document
"scoringsystemen-en-ai-prompts.md" — pas gerust aan naarmate je merkt dat
bepaalde signalen beter of slechter blijken te werken.

## Lokaal testen
```bash
cd scraper
npm install
npx playwright install --with-deps chromium   # eenmalig, voor de iBabs-scraper
GEMINI_API_KEY=jouw-key npm start
```
De output verschijnt in `../data/*.json`. Open daarna `index.html` lokaal in
de browser (of run `python3 -m http.server` in de hoofdmap) om de front-end
te bekijken.
