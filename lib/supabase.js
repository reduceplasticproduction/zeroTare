// lib/supabase.js — parla con Supabase via REST (PostgREST), zero dipendenze esterne
// (solo fetch nativo, stesso stile minimale di api/leggi.js).
//
// Le chiavi Supabase restano SEMPRE lato server: SUPABASE_URL e
// SUPABASE_SERVICE_ROLE_KEY sono env var di Vercel, mai spedite al client. La
// tabella `prezzi` ha RLS attivo senza policy per anon/authenticated (vedi
// db/schema.sql): solo la service role key può leggerla/scriverla, quindi ogni
// accesso passa per forza da qui.

import { distanzaKm, RAGGIO_VICINO_KM } from "./geo.js";

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

// ---- trend a 3 stati: SOLO su dati reali (negozio + openprices), mai su stime web ----
// (le stime web ora vengono ricontrollate/salvate fino a una volta al giorno per
// prodotto — vedi trovaStimaWebRecente — e mescolarle nel trend ne farebbe rumore
// invece di un segnale di prezzo reale)
export async function trovaTrend({ barcode, prodotto_chiave }) {
  const vuoto = { stato: "stabile", n_recenti: 0, n_precedenti: 0 };
  if (!dbPronto()) return vuoto;
  if (!barcode && !prodotto_chiave) return vuoto;

  const da = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const filtro = barcode
    ? `barcode=eq.${encodeURIComponent(barcode)}`
    : `prodotto_chiave=eq.${encodeURIComponent(normalizzaChiave(prodotto_chiave))}`;

  try {
    const r = await supaFetch(
      `prezzi?select=prezzo,data&origine=in.(negozio,openprices)&${filtro}&data=gte.${encodeURIComponent(da)}&order=data.desc&limit=200`
    );
    if (!r.ok) return vuoto;
    const righe = await r.json();
    if (!Array.isArray(righe) || righe.length === 0) return vuoto;

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

    return { stato, n_recenti: recenti.length, n_precedenti: precedenti.length };
  } catch {
    return vuoto;
  }
}

// finestra di freschezza per "vicino a te": oltre non è abbastanza recente per un
// confronto onesto. Parametro facile da cambiare, come RAGGIO_VICINO_KM in lib/geo.js.
const GIORNI_FRESCHEZZA_VICINO = 60;

// ---- banda 2 del verdetto a tre livelli: il prezzo negozio più basso entro raggioKm ----
// (ogni rilevazione negozio è la verità del SUO negozio: non si scarta nessuno come
// outlier, si prende il minimo vero tra quelli entro raggio e finestra di freschezza)
export async function trovaVicinoATe({ barcode, prodotto_chiave, lat, lng, raggioKm = RAGGIO_VICINO_KM }) {
  const vuoto = { vicino: null, esisteAltrove: false };
  if (!dbPronto()) return vuoto;
  if (typeof lat !== "number" || typeof lng !== "number") return vuoto;
  if (!barcode && !prodotto_chiave) return vuoto;

  const filtro = barcode
    ? `barcode=eq.${encodeURIComponent(barcode)}`
    : `prodotto_chiave=eq.${encodeURIComponent(normalizzaChiave(prodotto_chiave))}`;
  const da = new Date(Date.now() - GIORNI_FRESCHEZZA_VICINO * 24 * 3600 * 1000).toISOString();

  try {
    const r = await supaFetch(
      `prezzi?select=prezzo,unita,data,nome_luogo,latitudine,longitudine&origine=eq.negozio&${filtro}` +
        `&data=gte.${encodeURIComponent(da)}&latitudine=not.is.null&longitudine=not.is.null&order=data.desc&limit=200`
    );
    const righe = r.ok ? await r.json() : [];

    const vicine = (Array.isArray(righe) ? righe : [])
      .map((x) => ({ ...x, distanza_km: distanzaKm(lat, lng, x.latitudine, x.longitudine) }))
      .filter((x) => x.distanza_km != null && x.distanza_km <= raggioKm);

    if (vicine.length === 0) {
      // niente entro raggio/finestra: capiamo comunque se il prodotto è MAI stato
      // scansionato in negozio (a prescindere da dove/quando), solo per scegliere un
      // testo onesto quando il verdetto si appoggia alla stima web ("sei il primo" va
      // detto solo se è vero — vedi api/leggi.js)
      let esisteAltrove = false;
      try {
        const r2 = await supaFetch(`prezzi?select=id&origine=eq.negozio&${filtro}&limit=1`);
        if (r2.ok) {
          const j = await r2.json();
          esisteAltrove = Array.isArray(j) && j.length > 0;
        }
      } catch {
        /* non blocca: resta false, il peggio che succede è un testo leggermente meno preciso */
      }
      return { vicino: null, esisteAltrove };
    }

    vicine.sort((a, b) => a.prezzo - b.prezzo);
    const scelto = vicine[0];
    return {
      vicino: {
        valore: Number(scelto.prezzo),
        unita: scelto.unita,
        data: scelto.data,
        nome_luogo: scelto.nome_luogo || null,
        distanza_km: scelto.distanza_km,
      },
      esisteAltrove: true,
    };
  } catch {
    return vuoto;
  }
}

// ---- banda 3 del verdetto a tre livelli: stima web, cache di 1 ricerca al giorno ----
// per prodotto. Restituisce l'ultima rilevazione origine=web salvata (se c'è), a
// prescindere dalla data: è compito di chi chiama decidere se è "di oggi" o va rifatta.
export async function trovaStimaWebRecente({ barcode, prodotto_chiave }) {
  if (!dbPronto()) return null;
  if (!barcode && !prodotto_chiave) return null;
  const filtro = barcode
    ? `barcode=eq.${encodeURIComponent(barcode)}`
    : `prodotto_chiave=eq.${encodeURIComponent(normalizzaChiave(prodotto_chiave))}`;
  try {
    const r = await supaFetch(`prezzi?select=prezzo,unita,data,fonte&origine=eq.web&${filtro}&order=data.desc&limit=1`);
    if (!r.ok) return null;
    const righe = await r.json();
    if (!Array.isArray(righe) || righe.length === 0) return null;
    return righe[0];
  } catch {
    return null;
  }
}
