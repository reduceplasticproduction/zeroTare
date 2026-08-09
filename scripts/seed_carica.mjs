#!/usr/bin/env node
// scripts/seed_carica.mjs — Compito 2, passo 2: CARICAMENTO su Supabase dei due CSV
// prodotti da seed_estrai.sql. Zero dipendenze esterne, zero chiamate a Claude o a
// ricerca web: solo fetch nativo verso Supabase.
//
// Uso:
//   SUPABASE_URL=https://xxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=xxx \
//     node scripts/seed_carica.mjs [--dry-run]
//
// --dry-run: legge i CSV, stampa quante righe verrebbero inserite, non tocca il database.
//
// Una tantum: rieseguirlo senza svuotare prima la tabella duplica le righe (ogni riga
// è "una rilevazione", quindi tecnicamente non è sbagliato, ma è ridondante). Se serve
// rilanciarlo, svuota prima la tabella o filtra su origine='openprices'.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const QUI = dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes("--dry-run");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!DRY_RUN && (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)) {
  console.error("Mancano SUPABASE_URL e/o SUPABASE_SERVICE_ROLE_KEY nell'ambiente.");
  console.error("Esempio: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/seed_carica.mjs");
  process.exit(1);
}

// ---- parser CSV minimale ma corretto (gestisce virgolette e virgole nei campi) ----
function parseCSV(testo) {
  const righe = [];
  let riga = [], campo = "", inVirgolette = false;
  for (let i = 0; i < testo.length; i++) {
    const c = testo[i], succ = testo[i + 1];
    if (inVirgolette) {
      if (c === '"' && succ === '"') { campo += '"'; i++; }
      else if (c === '"') { inVirgolette = false; }
      else campo += c;
    } else {
      if (c === '"') inVirgolette = true;
      else if (c === ',') { riga.push(campo); campo = ""; }
      else if (c === '\n') { riga.push(campo); righe.push(riga); riga = []; campo = ""; }
      else if (c === '\r') { /* ignora */ }
      else campo += c;
    }
  }
  if (campo.length || riga.length) { riga.push(campo); righe.push(riga); }
  if (!righe.length) return [];
  const intestazione = righe[0];
  return righe.slice(1)
    .filter((r) => r.length === intestazione.length && r.some((v) => v !== ""))
    .map((r) => Object.fromEntries(intestazione.map((h, i) => [h, r[i]])));
}

function leggiCSV(nomeFile) {
  const percorso = join(QUI, nomeFile);
  let testo;
  try {
    testo = readFileSync(percorso, "utf8");
  } catch {
    console.error(`Non trovo ${percorso}. Esegui prima seed_estrai.sql con DuckDB (vedi commento in cima al file).`);
    process.exit(1);
  }
  return parseCSV(testo);
}

// ---- 1) prodotti (anagrafica) ----
const prodottiRighe = leggiCSV("off_italia_top10000.csv");
const prodotti = new Map(); // barcode -> {nome, categoria, prodotto_chiave}
for (const r of prodottiRighe) {
  if (!r.barcode) continue;
  prodotti.set(r.barcode, {
    nome: r.nome || null,
    categoria: r.categoria || "altro",
    prodotto_chiave: r.prodotto_chiave || null,
  });
}

// ---- 2) prezzi reali (Open Prices) ----
const prezziRighe = leggiCSV("open_prices_ita.csv");

let righeDaInserire = [];
let saltatiSenzaProdotto = 0, saltatiSenzaChiave = 0, saltatiPrezzoNonValido = 0;

for (const r of prezziRighe) {
  const prodotto = prodotti.get(r.barcode);
  if (!prodotto) { saltatiSenzaProdotto++; continue; }
  if (!prodotto.prodotto_chiave) { saltatiSenzaChiave++; continue; }
  const prezzo = parseFloat(r.price);
  if (!isFinite(prezzo) || prezzo < 0) { saltatiPrezzoNonValido++; continue; }

  righeDaInserire.push({
    prodotto_chiave: prodotto.prodotto_chiave,
    nome: prodotto.nome,
    barcode: r.barcode,
    categoria: prodotto.categoria,
    prezzo: Math.round(prezzo * 100) / 100,
    unita: r.price_per === "KILOGRAM" ? "€/kg" : "€",
    data: r.date ? `${r.date}T00:00:00Z` : new Date().toISOString(),
    latitudine: null,
    longitudine: null,
    nome_luogo: null,
    origine: "openprices",
    fonte: "Open Prices (Open Food Facts) — dump ufficiale",
  });
}

const barcodeConPrezzo = new Set(righeDaInserire.map((r) => r.barcode)).size;

console.log(`Prodotti (anagrafica OFF) letti:        ${prodotti.size}`);
console.log(`Rilevazioni Open Prices lette:            ${prezziRighe.length}`);
console.log(`  → scartate (barcode fuori dai 10.000):  ${saltatiSenzaProdotto}`);
console.log(`  → scartate (chiave prodotto vuota):     ${saltatiSenzaChiave}`);
console.log(`  → scartate (prezzo non valido):         ${saltatiPrezzoNonValido}`);
console.log(`Righe pronte per l'inserimento:            ${righeDaInserire.length}`);
console.log(`Prodotti (barcode unici) con ≥1 prezzo:    ${barcodeConPrezzo} su ${prodotti.size}`);

if (DRY_RUN) {
  console.log("\n--dry-run: nessuna scrittura su Supabase.");
  process.exit(0);
}
if (righeDaInserire.length === 0) {
  console.log("Niente da inserire.");
  process.exit(0);
}

// ---- 3) caricamento a blocchi su Supabase (REST/PostgREST) ----
const BLOCCO = 500;
let inseriti = 0, errori = 0;

for (let i = 0; i < righeDaInserire.length; i += BLOCCO) {
  const blocco = righeDaInserire.slice(i, i + BLOCCO);
  const r = await fetch(`${SUPABASE_URL}/rest/v1/prezzi`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(blocco),
  });
  if (r.ok) {
    inseriti += blocco.length;
    process.stdout.write(`\rInserite ${inseriti}/${righeDaInserire.length}...`);
  } else {
    errori += blocco.length;
    console.error(`\nErrore sul blocco ${i}-${i + blocco.length}: ${r.status} ${(await r.text()).slice(0, 300)}`);
  }
}
console.log(`\n✓ Fatto. Inserite ${inseriti} righe, ${errori} in errore.`);
