#!/usr/bin/env node
/**
 * migrate-photos-from-export.js
 *
 * Variante de migrate-photos.js qui prend en entrée un export HTML Notion
 * (extrait depuis le ZIP). Utile quand l'API Notion est verrouillée
 * (workspace entreprise), parce que l'export fonctionne partout.
 *
 * Lit la CSV "Recettes" exportée par Notion, suit la colonne
 * "Fichiers et médias" pour trouver les images sur le disque, les upload
 * dans le bucket Supabase recettes-photos, et met à jour photo_url
 * (match par titre normalisé).
 *
 * Usage :
 *   node migrate-photos-from-export.js <chemin-du-dossier-export>
 *
 *   Le dossier doit contenir "Privé et partagé/Recettes …. csv" et
 *   les sous-dossiers avec les images.
 *
 * Nécessite Node 18+ (fetch natif).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SB = 'https://okrkucmfyycaevezmuzo.supabase.co';
const SB_PUBLISHABLE = 'sb_publishable_F6CVp39DGvvXpLDekarKQw_8AtDqDvB';
const BUCKET = 'recettes-photos';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

let _rl = null;
function getRl() {
  if (!_rl) _rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return _rl;
}
function closeRl() { if (_rl) { _rl.close(); _rl = null; } }
function prompt(question) {
  return new Promise((resolve) => {
    getRl().question(question, (a) => resolve(a));
  });
}

function normalize(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function parseCSV(s) {
  // BOM
  s = s.replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') { cur += '"'; i++; }
        else { inQ = false; }
      } else {
        cur += c;
      }
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

function contentTypeFromExt(ext) {
  const map = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg',
    png: 'image/png', webp: 'image/webp',
    gif: 'image/gif', avif: 'image/avif',
    heic: 'image/heic', heif: 'image/heif',
  };
  return map[ext.toLowerCase()] || 'application/octet-stream';
}

// ─────────────────────────────────────────────────────────────────────────────
// Supabase
// ─────────────────────────────────────────────────────────────────────────────

async function fetchAllRecettes(key) {
  const res = await fetch(`${SB}/rest/v1/recettes?select=id,titre,photo_url&limit=1000`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`Supabase fetch ${res.status}: ${await res.text().catch(() => '')}`);
  return res.json();
}

async function uploadToStorage(key, storagePath, buffer, contentType) {
  const res = await fetch(`${SB}/storage/v1/object/${BUCKET}/${storagePath}`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': contentType,
      'x-upsert': 'true',
      'Cache-Control': '3600',
    },
    body: buffer,
  });
  if (!res.ok) throw new Error(`Storage ${res.status}: ${await res.text().catch(() => '')}`);
  return `${SB}/storage/v1/object/public/${BUCKET}/${storagePath}`;
}

async function updateRecettePhotoUrl(key, id, photoUrl) {
  const res = await fetch(`${SB}/rest/v1/recettes?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ photo_url: photoUrl }),
  });
  if (!res.ok) throw new Error(`Update ${res.status}: ${await res.text().catch(() => '')}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Export Notion
// ─────────────────────────────────────────────────────────────────────────────

function findCsvIn(rootDir) {
  // On cherche le CSV dans "Privé et partagé/" ou à la racine
  const candidates = [];
  function walk(dir, depth = 0) {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.csv')) candidates.push(p);
    }
  }
  walk(rootDir);
  // Préfère un CSV qui s'appelle "Recettes …. csv"
  candidates.sort((a, b) => {
    const aR = /Recettes/i.test(path.basename(a)) ? 0 : 1;
    const bR = /Recettes/i.test(path.basename(b)) ? 0 : 1;
    return aR - bR;
  });
  return candidates[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n📸  Migration photos export Notion → Supabase\n');

  const rootArg = process.argv[2];
  if (!rootArg) {
    console.error('Usage: node migrate-photos-from-export.js <chemin-du-dossier-export>');
    process.exit(1);
  }
  const rootDir = path.resolve(rootArg);
  if (!fs.existsSync(rootDir)) {
    console.error(`Dossier introuvable : ${rootDir}`);
    process.exit(1);
  }

  const csvPath = findCsvIn(rootDir);
  if (!csvPath) {
    console.error('Aucun CSV trouvé dans le dossier export');
    process.exit(1);
  }
  console.log(`📄  CSV : ${path.relative(rootDir, csvPath)}`);

  // Le dossier qui contient le CSV est la racine effective des chemins relatifs
  const csvDir = path.dirname(csvPath);

  // Permet de bypasser les prompts via env vars / args
  // SB_KEY=... OVERWRITE=1 node ...
  let sbKey = process.env.SB_KEY;
  let overwrite = process.env.OVERWRITE === '1' || process.env.OVERWRITE === 'true' || process.env.OVERWRITE === 'y';
  const noPrompt = process.env.NO_PROMPT === '1' || !process.stdin.isTTY;

  if (!sbKey) {
    if (noPrompt) {
      sbKey = SB_PUBLISHABLE;
      console.log('🗝️   Clé Supabase : publishable (par défaut)');
    } else {
      const input = (await prompt('🗝️   Clé Supabase (Entrée pour publishable): ')).trim();
      sbKey = input || SB_PUBLISHABLE;
    }
  }
  if (!process.env.OVERWRITE && !noPrompt) {
    const input = (await prompt('♻️   Remplacer les photos existantes ? (y/N): ')).trim().toLowerCase();
    overwrite = input === 'y' || input === 'yes' || input === 'o';
  }
  closeRl();
  console.log(`♻️   Remplacer existant : ${overwrite ? 'oui' : 'non'}\n`);

  // Charger CSV
  const text = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCSV(text);
  const header = rows[0];
  const idxTitle = header.indexOf('Recette');
  const idxFiles = header.indexOf('Fichiers et médias');
  if (idxTitle < 0 || idxFiles < 0) {
    console.error(`Colonnes attendues introuvables. Header : ${JSON.stringify(header)}`);
    process.exit(1);
  }

  // Récupérer recettes Supabase
  console.log('📥  Récupération des recettes Supabase…');
  const recettes = await fetchAllRecettes(sbKey);
  console.log(`    → ${recettes.length} recettes\n`);

  const recettesByTitle = new Map();
  for (const r of recettes) {
    const k = normalize(r.titre);
    if (k) recettesByTitle.set(k, r);
  }

  let ok = 0, skipNoPhoto = 0, skipNoMatch = 0, skipHasPhoto = 0, skipMissingFile = 0, fail = 0;
  const unmatched = [];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const title = (r[idxTitle] || '').trim();
    if (!title) continue;
    const filesField = (r[idxFiles] || '').trim();
    if (!filesField) { skipNoPhoto++; continue; }

    const recette = recettesByTitle.get(normalize(title));
    if (!recette) {
      unmatched.push(title);
      skipNoMatch++;
      continue;
    }
    if (!overwrite && recette.photo_url) {
      skipHasPhoto++;
      continue;
    }

    // Première image (les chemins sont séparés par ", " et URL-encodés)
    const firstPathEncoded = filesField.split(/,\s*(?=Recettes\/)/)[0].trim();
    let firstPath;
    try { firstPath = decodeURIComponent(firstPathEncoded); }
    catch { firstPath = firstPathEncoded; }

    const absPath = path.join(csvDir, firstPath);
    if (!fs.existsSync(absPath)) {
      console.log(`  ⚠️   ${title} — fichier introuvable : ${firstPath}`);
      skipMissingFile++;
      continue;
    }
    let ext = path.extname(absPath).slice(1).toLowerCase();
    if (ext === 'jpeg') ext = 'jpg';
    if (!['jpg', 'png', 'webp', 'gif', 'avif', 'heic', 'heif'].includes(ext)) {
      console.log(`  ⏭️   ${title} — extension non gérée : ${ext}`);
      skipMissingFile++;
      continue;
    }

    try {
      const buf = fs.readFileSync(absPath);
      const storagePath = `${recette.id}.${ext}`;
      const baseUrl = await uploadToStorage(sbKey, storagePath, buf, contentTypeFromExt(ext));
      const publicUrl = `${baseUrl}?v=${Date.now()}`;
      await updateRecettePhotoUrl(sbKey, recette.id, publicUrl);
      ok++;
      console.log(`  ✅  ${title}`);
    } catch (e) {
      fail++;
      console.log(`  ❌  ${title} — ${e.message}`);
    }
  }

  console.log('\n──────────────────────────────────────────');
  console.log(`✅  Migrées          : ${ok}`);
  console.log(`⏭️   Déjà une photo  : ${skipHasPhoto}`);
  console.log(`⏭️   Pas de photo CSV : ${skipNoPhoto}`);
  console.log(`⏭️   Pas de match     : ${skipNoMatch}`);
  console.log(`⚠️   Fichier manquant : ${skipMissingFile}`);
  console.log(`❌  Échecs           : ${fail}`);
  if (unmatched.length) {
    console.log('\nTitres Notion sans correspondance Supabase :');
    unmatched.slice(0, 30).forEach((t) => console.log(`  • ${t}`));
    if (unmatched.length > 30) console.log(`  … et ${unmatched.length - 30} autres`);
  }
  console.log('\n✨  Terminé\n');
}

main().catch((e) => {
  console.error('\n💥', e.message);
  process.exit(1);
});
