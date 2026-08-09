// lib/supabase.js — parla con Supabase via REST (PostgREST), zero dipendenze esterne
// (solo fetch nativo, stesso stile minimale di api/leggi.js).
//
// Le chiavi Supabase restano SEMPRE lato server: SUPABASE_URL e
// SUPABASE_SERVICE_ROLE_KEY sono env var di Vercel, mai spedite al client. La
// tabella `prezzi` ha RLS attivo senza policy per anon/authenticated (vedi
// db/schema.sql): solo la service role key può leggerla/scriverla, quindi ogni
// accesso passa per forza da qui.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export function dbPronto() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

async function supaFetch(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
      ...(opts.headers || {}),
    },
  });
  return r;
}

// normalizzazione minima e coerente tra scrittura e lettura: minuscolo, spazi puliti
function normalizzaChiave(s) {
  return (s || "").toString().toLowerCase().trim().replace(/\s+/g, " ");
}

// ---- scrittura: una rilevazione = una riga ----
// campi attesi: prodotto_chiave, nome, barcode, categoria, prezzo, unita,
// latitudine, longitudine, nome_luogo, origine, fonte
export async function salvaRilevazione(campi) {
  if (!dbPronto()) return { salvato: false, motivo: "supabase non configurato" };
  const { prodotto_chiave, nome, barcode, categoria, prezzo, unita, latitudine, longitudine, nome_luogo, origine, fonte } = campi || {};

  if (!prodotto_chiave || typeof prezzo !== "number" || !isFinite(prezzo)) {
    return { salvato: false, motivo: "campi minimi mancanti (prodotto_chiave/prezzo)" };
  }
  if (unita !== "€" && unita !== "€/kg") return { salvato: false, motivo: "unita non valida" };
  if (!["negozio", "web", "openprices"].includes(origine)) return { salvato: false, motivo: "origine non valida" };

  const riga = {
    prodotto_chiave: normalizzaChiave(prodotto_chiave),
    nome: nome || null,
    barcode: barcode || null,
    categoria: categoria || null,
    prezzo: Math.round(prezzo * 100) / 100,
    unita,
    latitudine: typeof latitudine === "number" ? latitudine : null,
    longitudine: typeof longitudine === "number" ? longitudine : null,
    nome_luogo: nome_luogo || null,
    origine,
    fonte: fonte || null,
  };

  try {
    const r = await supaFetch("prezzi", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify([riga]),
    });
    if (!r.ok) {
      const t = await r.text();
      return { salvato: false, motivo: `supabase ${r.status}: ${t.slice(0, 200)}` };
    }
    return { salvato: true };
  } catch (e) {
    return { salvato: false, motivo: String(e).slice(0, 200) };
  }
}

// ---- lettura: confronto (gerarchia negozio > openprices > web) + trend a 3 stati ----
// cerca per barcode se c'è, altrimenti per prodotto_chiave normalizzata
export async function trovaConfrontoETrend({ barcode, prodotto_chiave }) {
  const vuoto = { confronto: null, trend: { stato: "stabile", n_recenti: 0, n_precedenti: 0 } };
  if (!dbPronto()) return vuoto;
  if (!barcode && !prodotto_chiave) return vuoto;

  const da = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const filtro = barcode
    ? `barcode=eq.${encodeURIComponent(barcode)}`
    : `prodotto_chiave=eq.${encodeURIComponent(normalizzaChiave(prodotto_chiave))}`;

  try {
    const r = await supaFetch(
      `prezzi?select=prezzo,unita,data,origine,nome_luogo,fonte&${filtro}&data=gte.${encodeURIComponent(da)}&order=data.desc&limit=200`
    );
    if (!r.ok) return vuoto;
    const righe = await r.json();
    if (!Array.isArray(righe) || righe.length === 0) return vuoto;

    // --- confronto: gerarchia negozio(0) > openprices(1) > web(2), poi il più recente ---
    const rango = { negozio: 0, openprices: 1, web: 2 };
    const ordinate = [...righe].sort((a, b) => {
      const ra = rango[a.origine] ?? 9, rb = rango[b.origine] ?? 9;
      if (ra !== rb) return ra - rb;
      return new Date(b.data) - new Date(a.data);
    });
    const scelta = ordinate[0];
    const oggiStr = new Date().toISOString().slice(0, 10);
    const confronto = {
      origine: scelta.origine,
      valore: Number(scelta.prezzo),
      unita: scelta.unita,
      data: scelta.data,
      oggi: scelta.origine === "negozio" && String(scelta.data).slice(0, 10) === oggiStr,
      nome_luogo: scelta.nome_luogo || null,
      fonte: scelta.fonte || null,
    };

    // --- trend: ultimi 7gg vs 7gg precedenti, soglia 3%, altrimenti puntino ---
    const ora = Date.now();
    const recenti = righe.filter((x) => ora - new Date(x.data).getTime() <= 7 * 24 * 3600 * 1000);
    const precedenti = righe.filter((x) => {
      const dt = ora - new Date(x.data).getTime();
      return dt > 7 * 24 * 3600 * 1000 && dt <= 14 * 24 * 3600 * 1000;
    });

    let stato = "stabile";
    if (recenti.length >= 3 && precedenti.length >= 1) {
      const media = (arr) => arr.reduce((s, x) => s + Number(x.prezzo), 0) / arr.length;
      const mRec = media(recenti), mPrec = media(precedenti);
      if (mPrec > 0) {
        const delta = (mRec - mPrec) / mPrec;
        if (delta > 0.03) stato = "su";
        else if (delta < -0.03) stato = "giu";
      }
    }
    // meno di 3-4 rilevazioni recenti, o nessuna base di confronto → resta "stabile" (puntino)

    return { confronto, trend: { stato, n_recenti: recenti.length, n_precedenti: precedenti.length } };
  } catch {
    return vuoto;
  }
}
