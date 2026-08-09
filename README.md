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
│   └── leggi.js        → funzione serverless: legge l'etichetta con Claude vision
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
  qui il confronto è tra negozi (dove costa meno). Azione: *aggiungo al carrello*.

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
2. Sostituire le stime AI con medie reali man mano che arrivano scansioni.
3. Salvataggio delle letture in un database (Supabase o simili) per costruire lo
   storico prezzi/luogo e alimentare/leggere Open Prices.
4. Reclutare i primi tester nelle community sfuso/zero-waste (Sfusitalia, Rete Zero
   Waste). Essendo PWA basta condividere il link, niente store.
