// api/prezzi.js — funzione serverless Vercel: unico punto di accesso alla tabella
// `prezzi` su Supabase. Le chiavi Supabase vivono solo qui (env var), mai nel client.
//
// GET  ?barcode=... | ?prodotto_chiave=...   → { confronto, trend }
// POST { prodotto_chiave, nome, barcode, categoria, prezzo, unita,
//         latitudine, longitudine, nome_luogo, origine, fonte }  → salva una rilevazione
//
// Nota: /api/leggi.js richiama direttamente le funzioni di lib/supabase.js (stesso
// runtime, niente giro HTTP in più) per salvare la scansione e leggere confronto/trend
// nella stessa risposta. Questo endpoint resta comunque utile per letture/scritture
// dirette (debug, future integrazioni, es. Open Prices → prezzi manuale da web).

import { dbPronto, salvaRilevazione, trovaConfrontoETrend } from "../lib/supabase.js";

export default async function handler(req, res) {
  if (!dbPronto()) {
    return res.status(500).json({ errore: "Database non configurato (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY mancanti su Vercel)" });
  }

  if (req.method === "GET") {
    const { barcode, prodotto_chiave } = req.query || {};
    if (!barcode && !prodotto_chiave) {
      return res.status(400).json({ errore: "Serve barcode o prodotto_chiave" });
    }
    const dati = await trovaConfrontoETrend({ barcode, prodotto_chiave });
    return res.status(200).json(dati);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    const r = await salvaRilevazione(body || {});
    if (!r.salvato) return res.status(400).json({ errore: "Rilevazione non salvata", dettaglio: r.motivo });
    return res.status(200).json({ salvato: true });
  }

  return res.status(405).json({ errore: "Usa GET o POST" });
}
