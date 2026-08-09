// api/leggi.js — funzione serverless Vercel
// Riceve la foto di un cartellino, la legge con Claude (vision) e restituisce
// i campi estratti in JSON. La chiave API sta nelle variabili d'ambiente di
// Vercel (ANTHROPIC_API_KEY), MAI nel codice.

const MODEL = process.env.ZT_MODEL || "claude-haiku-4-5-20251001"; // sovrascrivibile da Vercel
const ENDPOINT = "https://api.anthropic.com/v1/messages";

const PROMPT = `Sei il motore di lettura di ZeroTare. Ricevi la foto di un CARTELLINO PREZZO
di supermercato (a scaffale o preincartato al banco). Leggi tutto ciò che riesci,
anche se la foto è ruotata o storta, e rispondi SOLO con un oggetto JSON valido,
senza testo prima o dopo, senza backtick.

Campi da restituire:
{
  "nome": string,                      // descrizione prodotto letta dal cartellino
  "prodotto_chiave": string,           // nome generico normalizzato per abbinare sfuso e confezione dello STESSO prodotto: minuscolo, senza marca/sigle/peso (es. "CPQ UVA BIANCA VITTORIA" e "S&I UVA BIANCA S/SEMI GR.750" danno entrambi "uva bianca"; "ZUCCHINE BIO 500G" dà "zucchine")
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

    return res.status(200).json(parsed);
  } catch (e) {
    return res.status(500).json({ errore: "Errore interno", dettaglio: String(e).slice(0, 300) });
  }
}
