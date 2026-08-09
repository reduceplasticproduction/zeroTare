-- scripts/seed_estrai.sql — Compito 2, passo 1: ESTRAZIONE a costo zero dai dump
-- ufficiali Open Food Facts / Open Prices (nessuna chiamata a Claude, nessuna ricerca
-- web a pagamento). Va eseguito con DuckDB (https://duckdb.org — un binario gratis,
-- `brew install duckdb` o scaricabile dal sito):
--
--   cd scripts
--   duckdb -c ".read seed_estrai.sql"
--
-- Le query girano DIRETTAMENTE sui file Parquet remoti via httpfs (range request:
-- non scarica i ~4 GB del dump prodotti per intero). Ci mette un po' di tempo secondo
-- la connessione, ma è gratis e non consuma credito Anthropic.
--
-- Produce due CSV in questa cartella:
--   off_italia_top10000.csv → anagrafica dei prodotti più scansionati in Italia (OFF)
--   open_prices_ita.csv     → tutte le rilevazioni di prezzo reali (Open Prices) in EUR,
--                              in Italia, per quei barcode — una riga per rilevazione,
--                              esattamente come la tabella `prezzi`.
--
-- Nota onesta: i prodotti che non hanno ALMENO una rilevazione Open Prices in Italia
-- restano fuori da open_prices_ita.csv, quindi il loro primo prezzo nella tabella
-- `prezzi` arriverà dalla prima scansione reale di un cliente (origine=negozio). Meglio
-- questo che inventare un numero — stesso principio già applicato in api/leggi.js.

INSTALL httpfs;
LOAD httpfs;

-- schema del dump prodotti: utile a colpo d'occhio se in futuro Open Food Facts
-- cambia i nomi delle colonne (il dump viene rigenerato ogni notte).
DESCRIBE SELECT * FROM read_parquet('https://huggingface.co/datasets/openfoodfacts/product-database/resolve/main/food.parquet') LIMIT 0;

-- 1) anagrafica: i ~10.000 prodotti più scansionati in Italia, popolarità = unique_scans_n
COPY (
  SELECT
    code AS barcode,
    product_name AS nome,
    brands,
    quantity,
    unique_scans_n,
    -- prodotto_chiave v1: euristica MECCANICA (non IA) sul nome pulito — minuscolo,
    -- senza numeri/unità di misura, prime 2 parole significative. È più grezza della
    -- chiave che Claude legge dal cartellino in negozio (api/leggi.js), ma il
    -- matching lato app tollera sovrapposizioni parziali tra chiavi diverse
    -- (vedi chiaviCorrispondono in public/index.html), quindi resta comunque utile.
    nullif(trim(
      array_to_string(
        list_slice(
          str_split(
            trim(regexp_replace(regexp_replace(lower(product_name),
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
      WHEN list_contains(categories_tags,'en:fresh-vegetables') OR list_contains(categories_tags,'en:vegetables') THEN 'verdura'
      WHEN list_contains(categories_tags,'en:fresh-fruits') OR list_contains(categories_tags,'en:fruits') THEN 'frutta'
      WHEN list_contains(categories_tags,'en:meats') OR list_contains(categories_tags,'en:fresh-meats') THEN 'carne'
      WHEN list_contains(categories_tags,'en:fishes') OR list_contains(categories_tags,'en:seafood') THEN 'pesce'
      WHEN list_contains(categories_tags,'en:cold-cuts') OR list_contains(categories_tags,'en:charcuterie') THEN 'salumi'
      WHEN list_contains(categories_tags,'en:cheeses') THEN 'formaggi'
      WHEN list_contains(categories_tags,'en:breads') THEN 'pane'
      WHEN list_contains(categories_tags,'en:pastas') THEN 'pasta'
      WHEN list_contains(categories_tags,'en:canned-foods') OR list_contains(categories_tags,'en:tinned-foods') THEN 'conserve'
      WHEN list_contains(categories_tags,'en:dairies') OR list_contains(categories_tags,'en:milks') OR list_contains(categories_tags,'en:yogurts') THEN 'latticini'
      WHEN list_contains(categories_tags,'en:sweets') OR list_contains(categories_tags,'en:biscuits-and-cakes') OR list_contains(categories_tags,'en:chocolates') THEN 'dolci'
      WHEN list_contains(categories_tags,'en:beverages') OR list_contains(categories_tags,'en:drinks') THEN 'bevande'
      ELSE 'altro'
    END AS categoria
  FROM read_parquet('https://huggingface.co/datasets/openfoodfacts/product-database/resolve/main/food.parquet')
  WHERE list_contains(countries_tags, 'en:italy')
    AND code IS NOT NULL
    AND product_name IS NOT NULL AND length(trim(product_name)) > 0
  ORDER BY unique_scans_n DESC NULLS LAST
  LIMIT 10000
) TO 'off_italia_top10000.csv' (HEADER, DELIMITER ',');

-- 2) prezzi reali Open Prices, solo EUR, solo Italia, solo per quei barcode.
-- Una riga per rilevazione (stessa granularità della tabella `prezzi`): se un barcode
-- ha più rilevazioni nel tempo, arrivano tutte, e sono già lo storico che alimenta il
-- trend (Compito 4) fin dal giorno del seeding.
COPY (
  SELECT
    p.product_code AS barcode,
    p.price,
    p.price_per,   -- 'KILOGRAM' per sfuso pesato, altrimenti a pezzo/confezione
    p.date
  FROM read_parquet('https://huggingface.co/datasets/openfoodfacts/open-prices/resolve/main/prices.parquet') p
  WHERE p.currency = 'EUR'
    AND p.location_osm_address_country_code = 'IT'
    AND p.product_code IS NOT NULL
    AND p.price IS NOT NULL
    AND p.product_code IN (SELECT barcode FROM read_csv_auto('off_italia_top10000.csv'))
) TO 'open_prices_ita.csv' (HEADER, DELIMITER ',');

.print '✓ Estrazione completata: off_italia_top10000.csv e open_prices_ita.csv'
