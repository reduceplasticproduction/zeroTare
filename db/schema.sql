-- ZeroTare — schema database prezzi
-- Da eseguire UNA VOLTA nel SQL Editor di Supabase (progetto gratuito va benissimo).
--
-- Un record = una rilevazione di prezzo (non un prodotto): lo stesso prodotto avrà
-- più righe nel tempo, da fonti diverse. Lo storico è quello che alimenta il trend
-- (Compito 4) e il confronto (Compito 1).

create extension if not exists "pgcrypto"; -- per gen_random_uuid()

create table if not exists prezzi (
  id              uuid primary key default gen_random_uuid(),

  prodotto_chiave text not null,               -- generico normalizzato, minuscolo (es. "ossobuco")
  nome            text,                        -- descrizione così come letta/trovata
  barcode         text,                        -- solo per confezionato con barcode globale
  categoria       text,                        -- verdura|frutta|carne|pesce|salumi|formaggi|pane|pasta|conserve|latticini|dolci|bevande|semilavorato|altro

  prezzo          numeric(10,2) not null check (prezzo >= 0),
  unita           text not null check (unita in ('€', '€/kg')),

  data            timestamptz not null default now(),

  latitudine      double precision check (latitudine  between -90  and 90),
  longitudine     double precision check (longitudine between -180 and 180),
  nome_luogo      text,                        -- es. "provincia di Milano" — solo quando disponibile

  -- REGOLA INVIOLABILE (fatta rispettare anche in api/leggi.js e public/index.html):
  -- origine = 'web' o 'openprices' NON è mai "verificato". Solo origine = 'negozio'
  -- porta l'etichetta "verificato oggi da un cliente in provincia di [zona]".
  origine         text not null check (origine in ('negozio', 'web', 'openprices')),
  fonte           text                         -- negozio/insegna, oppure link/descrizione della fonte
);

-- query tipiche: per barcode, per prodotto_chiave, storico ordinato per data (trend)
create index if not exists idx_prezzi_barcode          on prezzi (barcode);
create index if not exists idx_prezzi_prodotto_chiave   on prezzi (prodotto_chiave);
create index if not exists idx_prezzi_data              on prezzi (data desc);
create index if not exists idx_prezzi_barcode_data      on prezzi (barcode, data desc);
create index if not exists idx_prezzi_chiave_data        on prezzi (prodotto_chiave, data desc);

-- Row Level Security ON, NESSUNA policy per anon/authenticated: significa che la
-- tabella è leggibile/scrivibile SOLO con la service_role key, che noi teniamo
-- esclusivamente nelle env var del server (Vercel), mai nel client. Tutte le
-- letture/scritture passano quindi da /api/prezzi.js e /api/leggi.js.
alter table prezzi enable row level security;

comment on table prezzi is
  'Una riga = una rilevazione di prezzo. origine=web/openprices non è mai "verificato": solo origine=negozio lo è.';
