# ZeroTare — pacchetto di pubblicazione

Web app (PWA) che legge il cartellino prezzo di un prodotto e mostra quanto stai
pagando in più per plastica, comodità o solo perché lo compri nel negozio sbagliato.
Missione: ridurre la spazzatura da imballaggio spingendo il mercato verso lo sfuso.

Questo pacchetto è pronto per il deploy su Vercel. Sotto: cosa contiene, come
pubblicarlo, e le decisioni di progetto da tenere presenti mentre lo si porta avanti.

---

## Cosa c'è dentro

```
zerotare/
├── public/
│   ├── index.html      → tutta l'app (carrello, cattura, verdetto, chiusura)
│   └── manifest.json   → PWA (installabile da telefono)
├── api/
│   ├── leggi.js         → funzione serverless: legge l'etichetta con Claude vision
│   └── prezzi.js         → funzione serverless: salva/legge rilevazioni su Supabase
├── lib/
│   ├── supabase.js      → helper REST verso Supabase (usato da leggi.js e prezzi.js)
│   └── geo.js           → distanza haversine + RAGGIO_VICINO_KM (25, facile da cambiare)
├── db/
│   └── schema.sql       → migrazione: tabella `prezzi`, indici, RLS
├── scripts/
│   ├── seed_estrai.sql  → seeding, passo 1: estrae dai dump OFF/Open Prices (DuckDB)
│   └── seed_carica.mjs  → seeding, passo 2: carica i CSV estratti su Supabase
├── package.json
├── vercel.json
└── README.md
```

In `public/` c'è un **`logo.png` segnaposto** (500×500, trasparente): compare nella
schermata di benvenuto e come icona dell'app. Per il logo definitivo — la scritta
"zeroTare" con la T che diventa una bilancia a due piatti — basta sostituire quel
file con un PNG bianco 500×500, stesso nome, e non serve toccare altro.

La schermata di benvenuto (logo + missione + tre righe) appare solo al primo avvio;
dopo si va dritti al carrello. Lo stato è salvato sul telefono.

---

## Come si pubblica (dal browser, senza terminale)

Prerequisiti già pronti: domini acquistati, account Anthropic con chiave API e
limite di spesa, account GitHub, account Vercel collegato a GitHub.

1. **GitHub** — crea un repository nuovo (es. `zerotare`) e carica il contenuto di
   questa cartella trascinando i file nella pagina web del repo.
2. **Vercel** — *Add New → Project*, importa il repository. Vercel riconosce da solo
   la cartella `public/` come sito e `api/` come funzioni. Non serve build command.
3. **Chiave API** — in Vercel, *Settings → Environment Variables*, aggiungi
   `ANTHROPIC_API_KEY` = la tua chiave `sk-ant-...`. È cifrata e non finisce mai nel
   codice pubblico.
4. **Deploy** — premi *Deploy*. In un minuto l'app è online su `zerotare.vercel.app`.
5. **Dominio** — *Settings → Domains*, aggiungi `zerotare.com` e segui le istruzioni
   DNS dal pannello dove hai comprato il dominio.

Dopo ogni modifica caricata su GitHub, Vercel ripubblica da solo.

---

## Come funziona il verdetto — i tre casi

L'app riconosce da sola, dalla lettura dell'etichetta, quale caso ha davanti.

- **A — esiste lo sfuso identico** (zucchine, frutta, carni fresche). Confronta il
  prezzo della confezione con gli stessi grammi comprati sfusi. Il delta è il costo
  della plastica. Due pulsanti reali: *prendo lo sfuso* / *prendo la confezione*.
- **B — semipreparato** (alette condite, spiedini). Non ha un gemello sfuso: scorpora
  la materia prima ("il pollo crudo, da solo, costerebbe X") e mostra il resto come
  comodità + imballaggio. Azione: *prendo, mi va la comodità*.
- **C — confezionato industriale** (Nutella, pasta di marca). Ha un barcode globale:
  verdetto a **tre bande** (fino a tre, quelle senza dati si omettono) — 1) quello che
  hai fotografato; 2) miglior prezzo vicino a te (il più basso tra le rilevazioni reali
  in negozio entro 25 km in linea d'aria, raggio facilmente modificabile in
  `lib/geo.js`); 3) migliore sul web, solo se manca la banda 2 (stima, mai in
  grassetto, cache di massimo una ricerca al giorno per prodotto). Il grassetto segna
  il prezzo più basso *azionabile* (mai il web) tra fotografato e vicino a te; a parità
  vince "fotografato". Due pulsanti a posizione fissa — *aggiungi al carrello* /
  *continua con un altro prodotto* — con il verde che segna l'azione giusta spostandosi
  tra i due, senza mai scambiarli di posto.

Chiusura carrello: una **bilancia** tra il meglio e il peggio che potevi fare, con
la tacca su dove sei finito; il risparmio in evidenza; e — sussurrata, una riga in
fondo — la plastica evitata con la proiezione su tutta l'Italia.

---

## Onestà dei numeri al lancio (importante)

Il calcolo dipende da dati che oggi in parte non esistono ancora:

- **Il costo della plastica (caso A) è il dato più solido**: si ricava dal delta
  confezionato-vs-sfuso e dalla tara stampata sull'etichetta. Vero dal giorno uno.
- **Le stime di prezzo sfuso e materia prima** oggi le produce il modello AI e sono
  marcate "stima". Vanno sostituite da medie reali man mano che il database di
  scansioni cresce. Finché è magro, restano approssimazioni oneste, mai numeri
  spacciati per certi.
- **Il confronto tra negozi (C)** parte vuoto: le prime scansioni lo costruiscono.

Regola d'oro: meglio dire "non lo so ancora, la tua scansione aiuta" che sparare un
numero inventato. La funzione `leggi.js` è istruita a lasciare i campi a `null` in
caso di dubbio.

---

## Database prezzi — Supabase (attivo)

La tabella `prezzi` (uno storico di rilevazioni, non un catalogo prodotti) vive su
Supabase. Setup, una tantum:

1. **Crea un progetto Supabase gratuito** su [supabase.com](https://supabase.com) (piano
   Free, nessun costo).
2. **SQL Editor** → incolla ed esegui tutto `db/schema.sql`. Crea la tabella `prezzi`
   con i campi esatti richiesti (`prodotto_chiave`, `nome`, `barcode`, `categoria`,
   `prezzo`, `unita`, `data`, `latitudine`, `longitudine`, `nome_luogo`, `origine`,
   `fonte`), gli indici, e attiva Row Level Security **senza** policy per anon/
   authenticated: solo la service role key può leggere/scrivere. Le chiavi Supabase
   non arrivano mai al browser, tutto passa dalle funzioni serverless.
3. **Project Settings → API** → copia `Project URL` e `service_role` key (non la
   `anon` key).
4. **Vercel → Settings → Environment Variables**, aggiungi:
   - `SUPABASE_URL` = il Project URL
   - `SUPABASE_SERVICE_ROLE_KEY` = la service role key
5. Redeploy. Da questo momento ogni scansione salva una rilevazione reale
   (`origine=negozio`), il confronto prezzi usa la gerarchia **negozio → openprices
   → stima web**, e il trend (Compito 4) si calcola dallo storico in tabella.

**Regola inviolabile**, applicata sia in `api/leggi.js` sia in `public/index.html`:
`origine = web` o `openprices` non è **mai** mostrata come "verificato". Solo
`origine = negozio` porta l'etichetta "verificato oggi da un cliente in provincia di
[zona]" (o "rilevato il [data]..." se non è di oggi).

### Popolare il database — seeding a costo zero (una tantum)

Script separato, **non gira all'avvio dell'app**, va lanciato a mano una volta sola dal
tuo computer (non consuma credito Anthropic: nessuna chiamata a Claude, nessuna
ricerca web a pagamento — solo dump ufficiali gratuiti).

1. **Estrazione** (richiede [DuckDB](https://duckdb.org), un binario gratis:
   `brew install duckdb` su Mac):
   ```
   cd scripts
   duckdb -c ".read seed_estrai.sql"
   ```
   Interroga direttamente (via httpfs, senza scaricare l'intero dump) i due dump
   ufficiali su Hugging Face:
   - `openfoodfacts/product-database` (`food.parquet`) → anagrafica dei ~10.000
     prodotti più scansionati in Italia (popolarità = `unique_scans_n`).
   - `openfoodfacts/open-prices` (`prices.parquet`) → tutte le rilevazioni di prezzo
     reali in EUR, in Italia, per quei barcode.

   Produce `off_italia_top10000.csv` e `open_prices_ita.csv` nella cartella `scripts/`.

2. **Caricamento su Supabase**:
   ```
   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/seed_carica.mjs --dry-run
   ```
   controlla i numeri stampati (prodotti letti, righe pronte, prodotti con almeno un
   prezzo), poi rilancia senza `--dry-run` per scrivere davvero.

**Onestà sui numeri**: i prodotti dei ~10.000 più scansionati in Italia che non hanno
*nessuna* rilevazione Open Prices in EUR restano senza prezzo nella tabella finché non
arriva o una scansione reale in negozio (`origine=negozio`) o Open Prices li registra.
Meglio un prodotto senza prezzo che un numero inventato — stesso principio già
applicato in `api/leggi.js` per le stime. La copertura reale (quanti prodotti su
10.000 hanno effettivamente un prezzo) la vedi nell'output dello script al passo 2.

## Database prezzi — dove agganciarsi (fase due)

**Open Prices** di Open Food Facts (`prices.openfoodfacts.org`) è un database aperto
e crowdsourced di prezzi. Salva per ogni prezzo: **barcode, prezzo, valuta, data,
luogo (via OpenStreetMap), sconto, unità (al kg / a pezzo), categoria**. Lettura
libera senza autenticazione; scrittura con token Bearer. Licenza OdBL: va citata la
fonte e i dati aggiunti vanno restituiti.

- Produttore, marca e categoria merceologica vivono nel database principale
  **Open Food Facts**, a cui Open Prices si aggancia via barcode.
- Copre solo il **confezionato con barcode globale** (caso C). Per il banco (A e B),
  i barcode iniziano per 2 e non sono in nessuno dei due database: lì la categoria e
  i campi vanno estratti dalla lettura AI dell'etichetta.
- **Trend prezzi** (prodotto in aumento/calo): ricavabile, perché ogni prezzo è
  prezzo+data+luogo, quindi lo storico è già una serie temporale. Diventa affidabile
  solo con abbastanza rilevazioni. Sviluppo futuro.

Consiglio già applicato nella logica: salvare ogni lettura nel formato
**prezzo / data / luogo / categoria** anche per A e B, così la serie storica tua
nasce dal giorno uno ed è già compatibile con Open Prices quando vorrai contribuire.

---

## Prossimi passi

1. Aggiungere logo e icone.
2. Sostituire le stime AI con medie reali man mano che arrivano scansioni (il database
   e il seeding ci sono già, vedi sopra).
3. ~~Salvataggio delle letture in un database~~ — fatto (Supabase, vedi sopra).
4. Reclutare i primi tester nelle community sfuso/zero-waste (Sfusitalia, Rete Zero
   Waste). Essendo PWA basta condividere il link, niente store.
5. `prodotto_chiave` del seeding è un'euristica meccanica (prime 2 parole del nome
   pulito), più grezza di quella letta da Claude sul cartellino: da affinare quando si
   vede quanto spesso non fa match con le chiavi delle scansioni reali.
