#!/usr/bin/env node
/**
 * migrate-photos.js
 *
 * Récupère les photos de couverture (et les fichiers attachés) depuis une
 * database Notion, les upload dans le bucket "recettes-photos" de Supabase
 * Storage, puis met à jour la colonne `photo_url` de la table `recettes`
 * (match par titre normalisé).
 *
 * Usage :   node migrate-photos.js
 *
 * Le script demande au lancement :
 *   - le token d'intégration Notion (secret_...)
 *   - l'ID de la database Notion contenant les recettes
 *   - (optionnel) une clé Supabase ; sinon utilise la publishable en dur
 *
 * Nécessite Node 18+ (fetch natif).
 */

'use strict';

const readline = require('readline');

const SB = 'https://okrkucmfyycaevezmuzo.supabase.co';
const SB_PUBLISHABLE = 'sb_publishable_F6CVp39DGvvXpLDekarKQw_8AtDqDvB';
const BUCKET = 'recettes-photos';
const NOTION_VERSION = '2022-06-28';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function prompt(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (hidden) {
      const stdin = process.openStdin();
      process.stdout.write(question);
      let answer = '';
      const onData = (char) => {
        char = char.toString();
        if (char === '\n' || char === '\r' || char === '') {
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          rl.close();
          resolve(answer);
        } else if (char === '') {
          process.exit(1);
        } else {
          answer += char;
          process.stdout.write('*');
        }
      };
      stdin.on('data', onData);
    } else {
      rl.question(question, (a) => { rl.close(); resolve(a); });
    }
  });
}

function normalize(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function guessExt(url, contentType) {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  if (ct.includes('png')) return 'png';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('gif')) return 'gif';
  if (ct.includes('avif')) return 'avif';
  const clean = (url || '').split('?')[0].toLowerCase();
  const m = clean.match(/\.(jpe?g|png|webp|gif|avif)$/);
  if (m) return m[1] === 'jpeg' ? 'jpg' : m[1];
  return 'jpg';
}

function contentTypeFromExt(ext) {
  if (ext === 'jpg') return 'image/jpeg';
  return `image/${ext}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Notion
// ─────────────────────────────────────────────────────────────────────────────

async function fetchAllNotionPages(token, dbId) {
  const all = [];
  let cursor;
  while (true) {
    const body = cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 };
    const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Notion query ${res.status}: ${txt}`);
    }
    const data = await res.json();
    all.push(...data.results);
    if (!data.has_more) break;
    cursor = data.next_cursor;
  }
  return all;
}

function extractTitle(page) {
  const props = page.properties || {};
  for (const k of Object.keys(props)) {
    const p = props[k];
    if (p && p.type === 'title' && Array.isArray(p.title) && p.title.length) {
      return p.title.map((t) => t.plain_text).join('').trim();
    }
  }
  return null;
}

function extractImageUrl(page) {
  // 1. Cover de la page
  if (page.cover) {
    if (page.cover.type === 'external' && page.cover.external) return page.cover.external.url;
    if (page.cover.type === 'file' && page.cover.file) return page.cover.file.url;
  }
  // 2. Première propriété de type "files"
  const props = page.properties || {};
  for (const k of Object.keys(props)) {
    const p = props[k];
    if (p && p.type === 'files' && Array.isArray(p.files) && p.files.length) {
      const f = p.files[0];
      if (f.type === 'external' && f.external) return f.external.url;
      if (f.type === 'file' && f.file) return f.file.url;
    }
  }
  return null;
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

async function uploadToStorage(key, path, buffer, contentType) {
  const res = await fetch(`${SB}/storage/v1/object/${BUCKET}/${path}`, {
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
  return `${SB}/storage/v1/object/public/${BUCKET}/${path}`;
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
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n📸  Migration Notion → Supabase\n');

  const notionToken = (await prompt('🔑  Token Notion (secret_...): ')).trim();
  if (!notionToken) throw new Error('Token Notion requis');

  const notionDbId = (await prompt('📚  ID de la database Notion: ')).trim().replace(/-/g, '');
  if (!notionDbId) throw new Error('ID de database requis');

  const sbKeyInput = (await prompt(`🗝️   Clé Supabase (Entrée pour publishable): `)).trim();
  const sbKey = sbKeyInput || SB_PUBLISHABLE;

  const overwriteInput = (await prompt('♻️   Remplacer les photos existantes ? (y/N): ')).trim().toLowerCase();
  const overwrite = overwriteInput === 'y' || overwriteInput === 'yes' || overwriteInput === 'o';

  console.log('\n📥  Récupération des pages Notion…');
  const pages = await fetchAllNotionPages(notionToken, notionDbId);
  console.log(`    → ${pages.length} pages`);

  console.log('📥  Récupération des recettes Supabase…');
  const recettes = await fetchAllRecettes(sbKey);
  console.log(`    → ${recettes.length} recettes`);

  // Index recettes par titre normalisé
  const recettesByTitle = new Map();
  for (const r of recettes) {
    const k = normalize(r.titre);
    if (k) recettesByTitle.set(k, r);
  }

  let ok = 0, skipNoMatch = 0, skipNoImage = 0, skipHasPhoto = 0, fail = 0;
  const unmatched = [];

  for (const page of pages) {
    const title = extractTitle(page);
    if (!title) { skipNoMatch++; continue; }
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
    const imageUrl = extractImageUrl(page);
    if (!imageUrl) {
      console.log(`  ⏭️   ${title} — aucune image dans Notion`);
      skipNoImage++;
      continue;
    }
    try {
      const dl = await fetch(imageUrl);
      if (!dl.ok) throw new Error(`download ${dl.status}`);
      const ct = dl.headers.get('content-type') || '';
      const ext = guessExt(imageUrl, ct);
      const buffer = Buffer.from(await dl.arrayBuffer());
      const path = `${recette.id}.${ext}`;
      const publicUrlBase = await uploadToStorage(sbKey, path, buffer, contentTypeFromExt(ext));
      const publicUrl = `${publicUrlBase}?v=${Date.now()}`;
      await updateRecettePhotoUrl(sbKey, recette.id, publicUrl);
      ok++;
      console.log(`  ✅  ${title}`);
    } catch (e) {
      fail++;
      console.log(`  ❌  ${title} — ${e.message}`);
    }
  }

  console.log('\n──────────────────────────────────────────');
  console.log(`✅  Migrées       : ${ok}`);
  console.log(`⏭️   Déjà une photo : ${skipHasPhoto}`);
  console.log(`⏭️   Pas d'image    : ${skipNoImage}`);
  console.log(`⏭️   Pas de match   : ${skipNoMatch}`);
  console.log(`❌  Échecs        : ${fail}`);
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
