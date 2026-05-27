#!/usr/bin/env node
/**
 * migrate-content-from-export.js
 *
 * Reprend la CSV d'un export HTML Notion (extrait depuis le ZIP) et copie
 * les colonnes "Ingrédients" et "Recette écrite" dans la table Supabase
 * `recettes` (PATCH par titre normalisé).
 *
 * Pré-requis : les colonnes `ingredients` et `recette_ecrite` doivent
 * exister sur la table. Si non :
 *   alter table public.recettes
 *     add column if not exists ingredients text,
 *     add column if not exists recette_ecrite text;
 *
 * Usage :
 *   node migrate-content-from-export.js <chemin-du-dossier-export>
 *
 * Variables d'environnement :
 *   SB_KEY=...        clé Supabase (défaut : publishable)
 *   OVERWRITE=1       écrase même si déjà rempli (défaut : skip)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SB = 'https://okrkucmfyycaevezmuzo.supabase.co';
const SB_PUBLISHABLE = 'sb_publishable_F6CVp39DGvvXpLDekarKQw_8AtDqDvB';

function normalize(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function parseCSV(s) {
  s = s.replace(/^﻿/, '');
  const rows = [];
  let row = []; let cur = ''; let inQ = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') { if (s[i+1] === '"') { cur += '"'; i++; } else { inQ = false; } }
      else { cur += c; }
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else if (c === '\r') { /* skip */ }
      else cur += c;
    }
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

function findCsvIn(rootDir) {
  const cands = [];
  function walk(dir, depth = 0) {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.csv')) cands.push(p);
    }
  }
  walk(rootDir);
  cands.sort((a, b) => (/Recettes/i.test(path.basename(a)) ? 0 : 1) - (/Recettes/i.test(path.basename(b)) ? 0 : 1));
  return cands[0];
}

async function fetchAllRecettes(key) {
  const res = await fetch(`${SB}/rest/v1/recettes?select=id,titre,ingredients,recette_ecrite&limit=1000`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`Fetch ${res.status}: ${await res.text().catch(() => '')}`);
  return res.json();
}

async function patchRecette(key, id, payload) {
  const res = await fetch(`${SB}/rest/v1/recettes?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`PATCH ${res.status}: ${await res.text().catch(() => '')}`);
}

async function main() {
  const rootArg = process.argv[2];
  if (!rootArg) {
    console.error('Usage: node migrate-content-from-export.js <chemin-du-dossier-export>');
    process.exit(1);
  }
  const rootDir = path.resolve(rootArg);
  if (!fs.existsSync(rootDir)) {
    console.error(`Dossier introuvable : ${rootDir}`);
    process.exit(1);
  }

  const csvPath = findCsvIn(rootDir);
  if (!csvPath) { console.error('CSV introuvable'); process.exit(1); }

  const sbKey = process.env.SB_KEY || SB_PUBLISHABLE;
  const overwrite = process.env.OVERWRITE === '1' || process.env.OVERWRITE === 'true' || process.env.OVERWRITE === 'y';

  console.log(`📄  CSV : ${path.relative(rootDir, csvPath)}`);
  console.log(`♻️   Écrase existant : ${overwrite ? 'oui' : 'non'}\n`);

  const text = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCSV(text);
  const header = rows[0];
  const idxTitle = header.indexOf('Recette');
  const idxIng = header.indexOf('Ingrédients');
  const idxRec = header.indexOf('Recette écrite');
  if (idxTitle < 0 || (idxIng < 0 && idxRec < 0)) {
    console.error('Colonnes attendues introuvables :', JSON.stringify(header));
    process.exit(1);
  }

  console.log('📥  Récupération des recettes Supabase…');
  const recettes = await fetchAllRecettes(sbKey);
  console.log(`    → ${recettes.length} recettes\n`);
  const byTitle = new Map();
  for (const r of recettes) {
    const k = normalize(r.titre);
    if (k) byTitle.set(k, r);
  }

  let ok = 0, skipNoCsv = 0, skipNoMatch = 0, skipHasData = 0, fail = 0;
  const unmatched = [];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const title = (r[idxTitle] || '').trim();
    if (!title) continue;
    const ing = idxIng >= 0 ? (r[idxIng] || '').trim() : '';
    const rec = idxRec >= 0 ? (r[idxRec] || '').trim() : '';
    if (!ing && !rec) { skipNoCsv++; continue; }

    const recette = byTitle.get(normalize(title));
    if (!recette) {
      unmatched.push(title);
      skipNoMatch++;
      continue;
    }

    // Skip si déjà rempli côté Supabase (sauf overwrite)
    if (!overwrite && (recette.ingredients || recette.recette_ecrite)) {
      skipHasData++;
      continue;
    }

    const payload = {};
    if (ing) payload.ingredients = ing;
    if (rec) payload.recette_ecrite = rec;

    try {
      await patchRecette(sbKey, recette.id, payload);
      ok++;
      console.log(`  ✅  ${title}`);
    } catch (e) {
      fail++;
      console.log(`  ❌  ${title} — ${e.message}`);
    }
  }

  console.log('\n──────────────────────────────────────────');
  console.log(`✅  Migrées          : ${ok}`);
  console.log(`⏭️   Déjà rempli     : ${skipHasData}`);
  console.log(`⏭️   Pas dans CSV    : ${skipNoCsv}`);
  console.log(`⏭️   Pas de match    : ${skipNoMatch}`);
  console.log(`❌  Échecs           : ${fail}`);
  if (unmatched.length) {
    console.log('\nTitres Notion sans correspondance Supabase :');
    unmatched.slice(0, 30).forEach(t => console.log(`  • ${t}`));
    if (unmatched.length > 30) console.log(`  … et ${unmatched.length - 30} autres`);
  }
  console.log('\n✨  Terminé\n');
}

main().catch(e => { console.error('\n💥', e.message); process.exit(1); });
