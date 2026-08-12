-- scripts/seed_estrai.sql — Compito 2, passo 1: ESTRAZIONE a costo zero dai dump
-- ufficiali Open Food Facts / Open Prices (nessuna chiamata a Claude, nessuna ricerca
-- web a pagamento). Va eseguito con DuckDB (https://duckdb.org — un binario gratis,
-- `brew install duckdb` o scaricabile dal sito):
--
--   cd scripts
--   curl -L -o food.csv.gz https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz
--   curl -L -o open_prices.parquet https://huggingface.co/datasets/openfoodfacts/open-prices/resolve/main/prices.parquet
--   duckdb -c ".read seed_estrai.sql"
--
-- (il workflow GitHub Actions fa questi due curl automaticamente, vedi
-- .github/workflows/seed-anagrafica.yml — qui sotto sono per chi lo lancia a mano)
--
-- STORIA (perché è così, non lasciarlo solo nella memoria di chi l'ha scritto):
-- v1 interrogava food.parquet DIRETTAMENTE da Hugging Face via httpfs (query remota,
-- range request). Due problemi successivi:
--   1) product_name in quel Parquet è STRUCT(lang,text)[], non testo semplice — un
--      Binder Error alla prima esecuzione (fix con macro testo_lingua, poi superato).
--   2) 429 Too Many Requests persistente da Hugging Face: i runner GitHub Actions
--      condividono IP con migliaia di altri job, e una query remota su un file di
--      7,74 GB genera centinaia di piccole richieste — il limite anonimo HF (3.000
--      richieste/5min) si esaurisce per traffico non nostro.
-- v2 (questa versione, 2026-08-11): passa al CSV ufficiale OFF su static.openfoodfacts.org
-- — host DIVERSO da Hugging Face (il 429 non c'entra più), un SOLO download invece di
-- centinaia di richieste range, formato tabellare piatto (niente struct multilingua).
-- Stessa logica applicata anche al download di Open Prices: un curl unico invece di
-- interrogare il Parquet remoto via httpfs, per lo stesso motivo (anche se non ha mai
-- dato errore, è la stessa causa potenziale).
--
-- ATTENZIONE (non verificato dal vivo da qui — vedi nota in fondo al file): il file ha
-- estensione ".csv" ma è TAB-separated (TSV), dettaglio noto della distribuzione OFF —
-- per questo sotto il delimitatore è impostato esplicitamente, non lasciato all'autodetect
-- si un file di centinaia di colonne. Letto con all_varchar=true e ignore_errors=true:
-- un dump comunitario di milioni di righe ha quasi sempre qualche riga sporca, meglio
-- scartarla che far fallire l'intera estrazione.
--
-- Produce due CSV in questa cartella:
--   off_italia_top10000.csv → anagrafica dei prodotti più scansionati in Italia (OFF)
--   open_prices_ita.csv     → tutte le rilevazioni di prezzo reali (Open Prices) in EUR,
--                              in Italia, per quei barcode — una riga per rilevazione,
--                              esattamente come la tabella `prezzi`.
--
-- Nota onesta: i prodotti che non hanno ALMENO una rilevazione Open Prices in Italia
-- restano fuori da open_prices_ita.csv (nessun prezzo inventato — stesso principio già
-- applicato in api/leggi.js), ma finiscono comunque in off_italia_top10000.csv:
-- seed_carica.mjs carica QUESTO file per intero come anagrafica pura (origine='anagrafica',
-- prezzo/unita null — richiede la migrazione in db/schema.sql), così l'app riconosce il
-- prodotto anche prima che qualcuno lo scansioni davvero. Il loro primo PREZZO nella
-- tabella arriverà dalla prima scansione reale di un cliente (origine=negozio) o da un
-- futuro seed Open Prices più ricco.

-- tag presente in un campo stile OFF: stringa con più tag separati da virgola, es.
-- "en:italy,en:european-union" (niente più list_contains: nel CSV piatto non sono
-- LIST come nel Parquet, sono semplice testo). Le virgole aggiunte ai bordi evitano
-- falsi positivi tipo "en:italy" che matcherebbe anche "en:italy-something".
CREATE OR REPLACE MACRO tag_presente(campo, tag) AS (
  campo IS NOT NULL AND (',' || campo || ',') LIKE ('%,' || tag || ',%')
);

-- 1) anagrafica: i ~10.000 prodotti più scansionati in Italia, popolarità = unique_scans_n
COPY (
  WITH base AS (
    SELECT
      code AS barcode,
      product_name AS nome,
      brands,
      quantity,
      TRY_CAST(unique_scans_n AS BIGINT) AS unique_scans_n,
      categories_tags
    FROM read_csv('food.csv.gz', delim='\t', header=true, all_varchar=true, ignore_errors=true)
    WHERE tag_presente(countries_tags, 'en:italy')
      AND code IS NOT NULL AND code <> ''
  )
  SELECT
    barcode,
    nome,
    brands,
    quantity,
    unique_scans_n,
    -- prodotto_chiave v1: euristica MECCANICA (non IA) sul nome pulito — minuscolo,
    -- senza numeri/unità di misura, prime 2 parole significative. È più grezza della
    -- chiave che Claude legge dal cartellino in negozio (api/leggi.js), ma il
    -- matching lato app tollera sovrapposizioni parziali tra chiavi diverse
    -- (vedi chiaviCorrispondono in public/index.html), quindi resta comunque utile.
    -- ATTENZIONE COERENZA: stessa identica euristica in lib/openfoodfacts.js
    -- (chiaveDaNome) per il lookup live — se cambi una, cambia anche l'altra.
    nullif(trim(
      array_to_string(
        list_slice(
          str_split(
            trim(regexp_replace(regexp_replace(lower(nome),
              '[0-9]+[.,]?[0-9]*\s*(g|kg|ml|cl|l|gr|pz)\b', '', 'g'),
              '[^\w\s]', ' ', 'g')),
            ' '
          ),
          1, 2
        ),
        ' '
      )
    ), '') AS prodotto_chiave,
    CASE
      WHEN tag_presente(categories_tags,'en:fresh-vegetables') OR tag_presente(categories_tags,'en:vegetables') THEN 'verdura'
      WHEN tag_presente(categories_tags,'en:fresh-fruits') OR tag_presente(categories_tags,'en:fruits') THEN 'frutta'
      WHEN tag_presente(categories_tags,'en:meats') OR tag_presente(categories_tags,'en:fresh-meats') THEN 'carne'
      WHEN tag_presente(categories_tags,'en:fishes') OR tag_presente(categories_tags,'en:seafood') THEN 'pesce'
      WHEN tag_presente(categories_tags,'en:cold-cuts') OR tag_presente(categories_tags,'en:charcuterie') THEN 'salumi'
      WHEN tag_presente(categories_tags,'en:cheeses') THEN 'formaggi'
      WHEN tag_presente(categories_tags,'en:breads') THEN 'pane'
      WHEN tag_presente(categories_tags,'en:pastas') THEN 'pasta'
      WHEN tag_presente(categories_tags,'en:canned-foods') OR tag_presente(categories_tags,'en:tinned-foods') THEN 'conserve'
      WHEN tag_presente(categories_tags,'en:dairies') OR tag_presente(categories_tags,'en:milks') OR tag_presente(categories_tags,'en:yogurts') THEN 'latticini'
      WHEN tag_presente(categories_tags,'en:sweets') OR tag_presente(categories_tags,'en:biscuits-and-cakes') OR tag_presente(categories_tags,'en:chocolates') THEN 'dolci'
      WHEN tag_presente(categories_tags,'en:beverages') OR tag_presente(categories_tags,'en:drinks') THEN 'bevande'
      ELSE 'altro'
    END AS categoria
  FROM base
  WHERE nome IS NOT NULL AND length(trim(nome)) > 0
  ORDER BY unique_scans_n DESC NULLS LAST
  LIMIT 10000
) TO 'off_italia_top10000.csv' (HEADER, DELIMITER ',');

-- 2) prezzi reali Open Prices, solo EUR, solo Italia, solo per quei barcode. File
-- scaricato in locale una volta sola (vedi comando curl in cima al file) invece di
-- interrogato da remoto — stessa precauzione anti-429 del punto 1.
-- Una riga per rilevazione (stessa granularità della tabella `prezzi`): se un barcode
-- ha più rilevazioni nel tempo, arrivano tutte, e sono già lo storico che alimenta il
-- trend (Compito 4) fin dal giorno del seeding.
COPY (
  SELECT
    p.product_code AS barcode,
    p.price,
    p.price_per,   -- 'KILOGRAM' per sfuso pesato, altrimenti a pezzo/confezione
    p.date
  FROM read_parquet('open_prices.parquet') p
  WHERE p.currency = 'EUR'
    AND p.location_osm_address_country_code = 'IT'
    AND p.product_code IS NOT NULL
    AND p.price IS NOT NULL
    -- CAST esplicito su entrambi i lati: read_csv_auto sui barcode "numerici" di
    -- off_italia_top10000.csv può dedurre BIGINT invece di VARCHAR (i barcode SONO
    -- cifre), mentre product_code nel Parquet potrebbe essere VARCHAR — trovato con
    -- un test locale prima di questo commit (Binder Error senza il cast).
    AND CAST(p.product_code AS VARCHAR) IN (
      SELECT CAST(barcode AS VARCHAR) FROM read_csv_auto('off_italia_top10000.csv')
    )
) TO 'open_prices_ita.csv' (HEADER, DELIMITER ',');

.print '✓ Estrazione completata: off_italia_top10000.csv e open_prices_ita.csv'

-- Nota di verifica (2026-08-11, v2 — passaggio al CSV): la macro tag_presente() e la
-- lettura TSV con all_varchar+ignore_errors sono state testate localmente con DuckDB
-- su un file TSV finto che riproduce la forma attesa dell'export OFF (countries_tags/
-- categories_tags come stringa comma-separata, unique_scans_n come testo da convertire,
-- righe con campi vuoti) — risultati corretti in tutti i casi provati. Quello che NON
-- ho potuto verificare da qui (rete bloccata verso static.openfoodfacts.org da questo
-- sandbox): che i nomi di colonna reali (code, product_name, quantity, brands,
-- categories_tags, countries_tags, unique_scans_n) e il delimitatore TAB siano
-- esattamente questi nel file vero, e che il download da ~0,9 GB completi nei tempi di
-- un job GitHub Actions. La prova reale resta il prossimo run del workflow.
