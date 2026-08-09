// api/leggi.js — funzione serverless Vercel
// Riceve la foto di un cartellino, la legge con Claude (vision) e restituisce
// i campi estratti in JSON. La chiave API sta nelle variabili d'ambiente di
// Vercel (ANTHROPIC_API_KEY), MAI nel codice.

// Modello più capace di Haiku sulla lettura di etichette piccole/sfocate: la qualità
// dell'OCR è la priorità qui, la latenza in più è accettabile. Sovrascrivibile da Vercel.
const MODEL = process.env.ZT_MODEL || "claude-sonnet-5";
const ENDPOINT = "https://api.anthropic.com/v1/messages";

const PROMPT = `Sei il motore di lettura di ZeroTare. Ricevi la foto di un CARTELLINO PREZZO
di supermercato (a scaffale o preincartato al banco). Leggi tutto ciò che riesci,
anche se la foto è ruotata o storta, e rispondi SOLO con un oggetto JSON valido,
senza testo prima o dopo, senza backtick.

Leggi il testo lettera per lettera, con la massima attenzione, prima di rispondere.
Non sostituire una parola poco chiara con un'altra parola simile che ti sembra plausibile:
se una lettera o una parola non è leggibile con certezza, prova a dedurla dal contesto
del cartellino (tipo di banco, altre parole vicine), ma non inventare un nome di fantasia.
I cartellini di macelleria/gastronomia usano spesso termini come "bovino adulto", "suino",
"ovino", "rucola", "pinoli", "peperoni": leggili con cura, non storpiarli in parole senza senso.

Campi da restituire:
{
  "nome": string,                      // descrizione prodotto letta dal cartellino
  "prodotto_chiave": string,           // chiave MECCANICA per abbinare sfuso e confezione dello STESSO prodotto. Segui SEMPRE questo procedimento, nell'ordine: (1) individua la categoria/nome generico dell'alimento in italiano, senza marca, senza sigle, senza peso, senza varietà commerciale o taglio specifico (es. "vittoria", "bio", "ovino adulto" si scartano); (2) usa al massimo 2 parole: la categoria base + al massimo 1 aggettivo essenziale che la distingue da altri prodotti della stessa famiglia (es. "uva bianca" non "uva bianca vittoria"; "ossobuco" non "ossobuco ovino adulto"; "pollo" non "pollo fresco italiano"); (3) tutto minuscolo, senza punteggiatura. Esempi: "CPQ UVA BIANCA VITTORIA" e "S&I UVA BIANCA S/SEMI GR.750" danno ENTRAMBI "uva bianca"; "ZUCCHINE BIO 500G" dà "zucchine"; "OSSOBUCO OVINO ADULTO" e "OSSOBUCO DI AGNELLO SFUSO" danno ENTRAMBI "ossobuco". La stessa identica categoria di prodotto deve SEMPRE produrre la stessa identica stringa, scansione dopo scansione: è più importante essere coerenti che essere descrittivi.
  "sfuso": boolean,                    // true se è un cartellino di prodotto SFUSO venduto a peso: prezzo principale espresso "al kg", presenza di "TASTO BILANCIA" o simili, NESSUN peso confezione fisso. false se è una confezione (ha un peso tipo GR.750 e un prezzo fisso della confezione)
  "categoria": string,                 // una tra: verdura, frutta, carne, pesce, salumi, formaggi, pane, pasta, conserve, latticini, dolci, bevande, semilavorato, altro
  "tipo": string,                      // "preincartato" (peso variabile del negozio, barcode che inizia per 2) oppure "industriale" (confezione con barcode GTIN globale)
  "prezzo": number|null,               // importo finito in euro (es. 3.19)
  "prezzo_al_kg": number|null,         // euro al kg se stampato (es. 8.90)
  "peso_netto_g": number|null,         // peso netto in grammi (es. 358)
  "tara_g": number|null,               // tara/peso imballaggio in grammi se stampata (es. 18)
  "barcode": string|null,              // sequenza di cifre del codice a barre se leggibile
  "esiste_sfuso_equivalente": boolean, // true se lo stesso identico prodotto si vende comunemente anche sfuso (frutta, verdura, carni fresche, salumi al taglio)
  "stima_sfuso_al_kg": number|null,    // se esiste_sfuso_equivalente è true, DAI SEMPRE la tua migliore stima del prezzo al kg dello stesso prodotto venduto sfuso in un supermercato italiano. null solo se un equivalente sfuso non esiste davvero.
  "e_semilavorato": boolean,           // true se è un preparato/condito/marinato/da cuocere (non una materia prima grezza)
  "stima_materia_prima_al_kg": number|null, // se e_semilavorato è true, DAI SEMPRE la tua migliore stima del prezzo al kg della materia prima grezza principale (es. il pollo crudo) in un supermercato italiano. null solo se non ha senso.
  "in_ambito": boolean,                // true se è cibo o prodotto da banco alimentare (frutta, verdura, carne, pesce, salumi, formaggi, pane, ecc.). false per non-alimentari (detersivi, deodoranti, cosmetici, ecc.)
  "confidenza": string                 // "alta" | "media" | "bassa" sulla lettura complessiva
}

Regole:
- Distingui LETTURE da STIME. Le LETTURE (prezzo, prezzo_al_kg, peso_netto_g, tara_g, barcode, nome) vanno prese SOLO dall'etichetta: se non le vedi, metti null, non inventarle.
- Le STIME (stima_sfuso_al_kg, stima_materia_prima_al_kg) invece falle SEMPRE col tuo miglior giudizio quando il caso lo richiede: all'utente sono mostrate esplicitamente come "stima", quindi una stima ragionevole è utile, non un inganno. Mettile a null solo quando non hanno senso (nessun equivalente sfuso / non è un semilavorato).
- Se il peso non è stampato ma ci sono prezzo e prezzo_al_kg, calcolalo: peso_netto_g = prezzo/prezzo_al_kg*1000.
- Rispondi SOLO con il JSON.`;

// ---- REGOLA GENERALE per qualunque prezzo di confronto mostrato in app ----
// 1) database ZeroTare: prezzo reale già registrato dall'utente in questa spesa
//    (vedi sfusiRegistrati/confezioniPendenti lato client in public/index.html).
//    NB: oggi è solo la sessione corrente, non ancora un database condiviso tra
//    tutti gli utenti — quello arriverà con un backend persistente (funzione pro).
// 2) Open Prices: prezzo reale, filtrato sull'Italia (solo per prodotti con barcode
//    industriale: uno sfuso non ha un barcode globale da cercare lì).
// 3) ricerca web: MAI il primo prezzo trovato. Si cercano almeno TRE prezzi da fonti
//    diverse, aggiornati nelle ultime 48 ore, e si usa quello (vedi DOMANDA_* sotto).
// 4) solo se anche la ricerca web non trova nulla di verificabile: nessun confronto,
//    resta solo il prezzo letto sul cartellino. Mai un numero inventato "a memoria".
//
// Per CASO C (confezionato industriale) il campo aggiunto al risultato è
// `prezzo_confronto`:
//   { fonte: "openprices"|"stima_web"|"solo_letto", valore: number|null,
//     valuta: "EUR", nota: string, ...dettagli specifici della fonte }

const OPENPRICES_ENDPOINT = "https://prices.openfoodfacts.org/api/v1/prices";

async function cercaOpenPrices(barcode) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const url = `${OPENPRICES_ENDPOINT}?product_code=${encodeURIComponent(barcode)}&order_by=-created&size=20`;
    const r = await fetch(url, { signal: controller.signal });
    if (!r.ok) return null;
    const data = await r.json();
    const items = Array.isArray(data.items) ? data.items : [];
    // teniamo solo rilevazioni in euro, in un negozio geolocalizzato in Italia
    const it = items.filter(
      (p) =>
        p.currency === "EUR" &&
        typeof p.price === "number" &&
        p.location &&
        String(p.location.osm_address_country_code || "").toUpperCase() === "IT"
    );
    if (it.length === 0) return null;

    const usati = it.slice(0, 5); // le più recenti (order_by=-created)
    const media = usati.reduce((s, p) => s + p.price, 0) / usati.length;
    const dataPiuRecente = usati.reduce((max, p) => (!max || (p.date && p.date > max) ? p.date : max), null);

    return {
      fonte: "openprices",
      valore: Math.round(media * 100) / 100,
      valuta: "EUR",
      n_rilevazioni: it.length,
      data_piu_recente: dataPiuRecente,
      nota: `Prezzo medio reale da ${it.length} rilevazion${it.length === 1 ? "e" : "i"} in Italia (database aperto Open Prices / Open Food Facts).`,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---- helper generico: una domanda + ricerca web → {valore, fonte_testo} ----
// Usato sia per il prezzo tipico dei confezionati (caso C) sia per rinforzare le stime
// di sfuso/materia prima con un dato cercato in tempo reale invece che "a memoria".
async function cercaStimaWeb(domanda, key) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const r = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
        messages: [{ role: "user", content: domanda }],
      }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    const testo = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .replace(/```json|```/g, "")
      .trim();

    const m = testo.match(/\{[\s\S]*\}/);
    if (!m) return null;
    let obj;
    try {
      obj = JSON.parse(m[0]);
    } catch {
      return null;
    }
    if (typeof obj.valore_eur !== "number") return null;
    return { valore: Math.round(obj.valore_eur * 100) / 100, fonte_testo: obj.fonte || null };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const DOMANDA_PREZZO_TIPICO = (nome) => `Cerca sul web a quanto si trova oggi in vendita online in Italia il
prodotto "${nome}". NON limitarti ai supermercati: cerca anche su siti di comparazione prezzi (Trovaprezzi,
idealo, Google Shopping), farmacie/parafarmacie online, profumerie online, e-commerce generalisti — ovunque
il prodotto sia realmente acquistabile. Fai ricerche multiple e raccogli il prezzo ATTUALE (aggiornato nelle
ultime 48 ore, non un dato vecchio o una pagina cache) di ALMENO TRE venditori/fonti diversi prima di
rispondere: non fermarti al primo prezzo che trovi, un solo dato non basta a fare un confronto onesto. Se
dopo ricerche oneste trovi meno di tre fonti aggiornate e verificabili, dillo nel campo "fonte" invece di
inventare. Rispondi SOLO con un oggetto JSON valido, senza testo prima o dopo, senza backtick, in questa
forma esatta:
{"valore_eur": number|null, "fonte": string|null}

Regole:
- valore_eur: confronta i prezzi delle almeno tre fonti trovate (tutte aggiornate alle ultime 48 ore) e
  prendi il più basso tra quelli verificati (non un prezzo "di listino" o consigliato dal produttore, che è
  quasi sempre più alto di quello realmente pagato). Se trovi più prezzi simili tra loro usa quello
  mediano-basso; se un solo prezzo è nettamente più basso degli altri come probabile promozione isolata,
  preferisci comunque il secondo più basso per non essere ottimistico. Scarta come outlier un prezzo
  palesemente fuori scala rispetto agli altri (es. molto più alto per una variante premium/bio non richiesta):
  meglio tre fonti coerenti tra loro che una isolata e anomala. Metti null se la ricerca non restituisce nulla
  di verificabile: mai un numero a memoria/inventato.
- Questo numero serve a dire all'utente "stai pagando più o meno del normale": deve riflettere cosa
  realisticamente si trova cercando, non una media prudente verso l'alto.
- fonte: breve descrizione testuale di dove hai trovato l'informazione (es. "trovaprezzi.it e idealo.it,
  fascia 2,20-2,50€"), null se valore_eur è null.
- È una stima NAZIONALE: non hai modo di sapere il prezzo nel negozio specifico dell'utente, quindi non
  inventare un negozio o una zona geografica precisa.
- Rispondi SOLO con il JSON.`;

const DOMANDA_SFUSO_KG = (nome) => `Cerca sul web il prezzo al kg dello stesso prodotto "${nome}" venduto
SFUSO, cioè a peso variabile (banco frutta/verdura, macelleria, gastronomia), in un supermercato in Italia.
Usa listini online, e-commerce di supermercati italiani, siti di comparazione prezzi. Fai ricerche multiple
e confronta ALMENO TRE fonti/venditori diversi, con prezzi ATTUALI aggiornati nelle ultime 48 ore (non un
dato vecchio o una pagina cache), prima di rispondere: non fermarti al primo prezzo che trovi. Se dopo
ricerche oneste trovi meno di tre fonti aggiornate e verificabili, dillo nel campo "fonte" invece di
inventare. Rispondi SOLO con un oggetto JSON valido, senza testo prima o dopo, senza backtick, in questa
forma esatta:
{"valore_eur": number|null, "fonte": string|null}

Regole:
- valore_eur: confronta le almeno tre fonti trovate (tutte aggiornate alle ultime 48 ore) e dai la tua
  migliore stima del prezzo al kg (es. 2.5) dello stesso prodotto venduto sfuso, usando il valore
  mediano-basso tra quelli trovati. Scarta come outlier un prezzo palesemente fuori scala rispetto agli
  altri (es. una varietà premium/bio quando il cartellino non lo specifica): meglio tre fonti coerenti che
  una isolata e anomala. Metti null se non trovi nulla di ragionevolmente attendibile: mai un numero
  inventato.
- fonte: breve descrizione testuale di dove hai trovato l'informazione, null se valore_eur è null.
- È una stima NAZIONALE, non del negozio specifico dell'utente.
- Rispondi SOLO con il JSON.`;

const DOMANDA_MATERIA_PRIMA_KG = (nome) => `Cerca sul web il prezzo al kg della materia prima grezza
principale usata per preparare "${nome}" (es. per delle alette condite, il pollo crudo; per uno spiedino,
la carne cruda) venduta in un supermercato in Italia. Fai ricerche multiple e confronta ALMENO TRE fonti/
venditori diversi, con prezzi ATTUALI aggiornati nelle ultime 48 ore (non un dato vecchio o una pagina
cache), prima di rispondere: non fermarti al primo prezzo che trovi. Se dopo ricerche oneste trovi meno di
tre fonti aggiornate e verificabili, dillo nel campo "fonte" invece di inventare. Rispondi SOLO con un
oggetto JSON valido, senza testo prima o dopo, senza backtick, in questa forma esatta:
{"valore_eur": number|null, "fonte": string|null}

Regole:
- valore_eur: confronta le almeno tre fonti trovate (tutte aggiornate alle ultime 48 ore) e dai la tua
  migliore stima del prezzo al kg della materia prima cruda, usando il valore mediano-basso tra quelli
  trovati. Scarta come outlier un prezzo palesemente fuori scala rispetto agli altri. Metti null se non
  trovi nulla di ragionevolmente attendibile: mai un numero inventato.
- fonte: breve descrizione testuale di dove hai trovato l'informazione, null se valore_eur è null.
- Rispondi SOLO con il JSON.`;

async function cercaPrezzoWeb(parsed, key) {
  const nome = parsed.nome || parsed.prodotto_chiave;
  if (!nome) return null;
  const r = await cercaStimaWeb(DOMANDA_PREZZO_TIPICO(nome), key);
  if (!r) return null;
  return {
    fonte: "stima_web",
    valore: r.valore,
    valuta: "EUR",
    dettaglio_fonte: r.fonte_testo,
    nota:
      "Non ho ancora un prezzo reale per questo prodotto: dalla ricerca web, potresti pagarlo circa " +
      "questa cifra. È una stima di prezzo tipico nazionale — il web non dice cosa costa \"nella tua " +
      "zona\" — non il prezzo esatto del tuo negozio.",
  };
}

// sostituisce stima_sfuso_al_kg (dato "a memoria" dalla lettura iniziale, senza ricerca)
// con un dato cercato sul web in tempo reale, verificato su almeno tre fonti aggiornate:
// più affidabile per un confronto che l'utente userà davvero per decidere cosa comprare.
// Se la ricerca non trova nulla di verificabile NON si torna al numero a memoria: meglio
// nessun confronto che un prezzo inventato mostrato come fosse una stima (regola generale
// dei prezzi di confronto, vedi commento in cima al file).
async function arricchisciStimaSfuso(parsed, key) {
  if (!parsed || !parsed.esiste_sfuso_equivalente) return;
  const nome = parsed.nome || parsed.prodotto_chiave;
  if (!nome) { parsed.stima_sfuso_al_kg = null; return; }
  const r = await cercaStimaWeb(DOMANDA_SFUSO_KG(nome), key);
  if (r && typeof r.valore === "number") {
    parsed.stima_sfuso_al_kg = r.valore;
    parsed.stima_sfuso_fonte = "web";
  } else {
    parsed.stima_sfuso_al_kg = null;
  }
}

async function arricchisciStimaMateriaPrima(parsed, key) {
  if (!parsed || !parsed.e_semilavorato) return;
  const nome = parsed.nome || parsed.prodotto_chiave;
  if (!nome) { parsed.stima_materia_prima_al_kg = null; return; }
  const r = await cercaStimaWeb(DOMANDA_MATERIA_PRIMA_KG(nome), key);
  if (r && typeof r.valore === "number") {
    parsed.stima_materia_prima_al_kg = r.valore;
    parsed.stima_materia_prima_fonte = "web";
  } else {
    parsed.stima_materia_prima_al_kg = null;
  }
}

async function trovaPrezzoConfronto(parsed, key) {
  if (!parsed) return null;
  // Il confronto tra negozi/web vale per i prodotti "caso C": confezioni con barcode
  // industriale, alimentari o no (es. un deodorante). Per questi non esiste uno sfuso
  // equivalente, quindi il confronto utile è "quanto costa altrove" — non escludiamo più
  // i non alimentari: anche per loro il database utenti parte vuoto e la ricerca web
  // dà comunque un riferimento onesto invece di rifiutare il prodotto.
  if (parsed.tipo !== "industriale") return null;

  let risultato = null;
  if (parsed.barcode) {
    risultato = await cercaOpenPrices(parsed.barcode);
  }
  if (!risultato) {
    risultato = await cercaPrezzoWeb(parsed, key);
  }
  if (!risultato) {
    risultato = {
      fonte: "solo_letto",
      valore: null,
      valuta: "EUR",
      nota: "Nessun prezzo di confronto disponibile per ora, né da Open Prices né dalla ricerca web: vedi solo il prezzo letto sul cartellino.",
    };
  }
  return risultato;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ errore: "Usa POST" });
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return res.status(500).json({ errore: "Chiave API non configurata su Vercel" });
  }

  try {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    const { image, mime } = body || {};
    if (!image) return res.status(400).json({ errore: "Manca l'immagine" });

    const r = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 700,
        // niente "temperature": questo modello la rifiuta (invalid_request_error). La
        // coerenza di prodotto_chiave tra due scansioni dello stesso prodotto si affida
        // solo al prompt più meccanico e al confronto tollerante lato client.
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: mime || "image/jpeg", data: image },
              },
              { type: "text", text: PROMPT },
            ],
          },
        ],
      }),
    });

    if (!r.ok) {
      const t = await r.text();
      return res.status(502).json({ errore: "Errore dal modello", dettaglio: t.slice(0, 500) });
    }

    const data = await r.json();
    const testo = (data.content || [])
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .replace(/```json|```/g, "")
      .trim();

    let parsed;
    try {
      const m = testo.match(/\{[\s\S]*\}/); // isola il primo oggetto JSON
      parsed = JSON.parse(m ? m[0] : testo);
    } catch {
      return res.status(200).json({ errore: "Lettura non interpretabile", grezzo: testo.slice(0, 300) });
    }

    // se il peso manca ma abbiamo prezzo e prezzo_al_kg, lo ricaviamo
    if (!parsed.peso_netto_g && parsed.prezzo && parsed.prezzo_al_kg) {
      parsed.peso_netto_g = Math.round((parsed.prezzo / parsed.prezzo_al_kg) * 1000);
    }

    // arricchimenti via ricerca web, in parallelo: se qualcosa va storto qui non deve
    // far fallire la lettura già riuscita, al peggio restano le stime "a memoria" del modello.
    const compiti = [
      trovaPrezzoConfronto(parsed, key)
        .then((v) => {
          parsed.prezzo_confronto = v;
        })
        .catch(() => {
          parsed.prezzo_confronto = {
            fonte: "solo_letto",
            valore: null,
            valuta: "EUR",
            nota: "Errore nel recupero del prezzo di confronto.",
          };
        }),
    ];
    if (parsed.esiste_sfuso_equivalente) {
      compiti.push(arricchisciStimaSfuso(parsed, key).catch(() => {}));
    }
    if (parsed.e_semilavorato) {
      compiti.push(arricchisciStimaMateriaPrima(parsed, key).catch(() => {}));
    }
    await Promise.all(compiti);

    return res.status(200).json(parsed);
  } catch (e) {
    return res.status(500).json({ errore: "Errore interno", dettaglio: String(e).slice(0, 300) });
  }
}
