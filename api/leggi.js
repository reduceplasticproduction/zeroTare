// api/leggi.js — funzione serverless Vercel
// Riceve la foto di un cartellino, la legge con Claude (vision) e restituisce
// i campi estratti in JSON. La chiave API sta nelle variabili d'ambiente di
// Vercel (ANTHROPIC_API_KEY), MAI nel codice.

const MODEL = "claude-haiku-4-5-20251001"; // economico, adatto alla lettura testo
const ENDPOINT = "https://api.anthropic.com/v1/messages";

const PROMPT = `Sei il motore di lettura di ZeroTare. Ricevi la foto di un CARTELLINO PREZZO
di supermercato (a scaffale o preincartato al banco). Leggi tutto ciò che riesci,
anche se la foto è ruotata o storta, e rispondi SOLO con un oggetto JSON valido,
senza testo prima o dopo, senza backtick.

Campi da restituire:
{
  "nome": string,                      // descrizione prodotto letta dal cartellino
  "categoria": string,                 // una tra: verdura, frutta, carne, pesce, salumi, formaggi, pane, pasta, conserve, latticini, dolci, bevande, semilavorato, altro
  "tipo": string,                      // "preincartato" (peso variabile del negozio, barcode che inizia per 2) oppure "industriale" (confezione con barcode GTIN globale)
  "prezzo": number|null,               // importo finito in euro (es. 3.19)
  "prezzo_al_kg": number|null,         // euro al kg se stampato (es. 8.90)
  "peso_netto_g": number|null,         // peso netto in grammi (es. 358)
  "tara_g": number|null,               // tara/peso imballaggio in grammi se stampata (es. 18)
  "barcode": string|null,              // sequenza di cifre del codice a barre se leggibile
  "e_semilavorato": boolean,           // true se è un preparato/condito/marinato/da cuocere (non una materia prima grezza)
  "esiste_sfuso_equivalente": boolean, // true se lo stesso identico prodotto si vende comunemente anche sfuso (frutta, verdura, carni fresche, salumi al taglio)
  "stima_sfuso_al_kg": number|null,    // SOLO se esiste_sfuso_equivalente: stima ragionevole del prezzo al kg dello sfuso equivalente. null se non sai stimarlo con onestà.
  "stima_materia_prima_al_kg": number|null, // SOLO se e_semilavorato: stima del prezzo al kg della materia prima grezza principale (es. il pollo crudo). null se non sai stimarlo.
  "confidenza": string                 // "alta" | "media" | "bassa" sulla lettura complessiva
}

Regole:
- Se un campo non è leggibile o non applicabile, metti null (o false per i booleani).
- Non inventare numeri. Le stime vanno date solo se plausibili e vanno lasciate a null in caso di dubbio: meglio "non lo so" di un numero sbagliato.
- Se il peso non è stampato ma ci sono prezzo e prezzo_al_kg, il peso si ricava (peso_netto_g = prezzo/prezzo_al_kg*1000): calcolalo tu.
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
    const { image, mime } = req.body || {};
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
      parsed = JSON.parse(testo);
    } catch {
      return res.status(200).json({ errore: "Lettura non interpretabile", grezzo: testo });
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
