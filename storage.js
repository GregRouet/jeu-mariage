// Stockage des parties terminées.
//   - Si DATABASE_URL est défini → PostgreSQL (durable, survit aux redémarrages : recommandé sur Render).
//   - Sinon → fichier JSON local data/games.json (durable en local / sur disque persistant ;
//     ÉPHÉMÈRE sur l'offre gratuite Render, donc non durable là-bas).
const fs = require('fs');
const path = require('path');

const DB_URL = process.env.DATABASE_URL;
let pool = null, ready = Promise.resolve();

if (DB_URL) {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  ready = pool.query(`CREATE TABLE IF NOT EXISTS games (
    id serial PRIMARY KEY,
    saved_at timestamptz NOT NULL DEFAULT now(),
    couple_a text,
    couple_b text,
    player_count int,
    data jsonb NOT NULL
  )`);
}

// --- Repli fichier JSON ---
const FILE = path.join(__dirname, 'data', 'games.json');
const readFile = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; } };
const writeFile = arr => { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(arr)); };

async function saveGame(rec) {
  if (pool) {
    await ready;
    const r = await pool.query(
      'INSERT INTO games (couple_a, couple_b, player_count, data) VALUES ($1,$2,$3,$4) RETURNING id, saved_at',
      [rec.couple.a, rec.couple.b, rec.leaderboard.length, rec],
    );
    return { id: r.rows[0].id, savedAt: r.rows[0].saved_at };
  }
  const arr = readFile();
  const id = arr.reduce((m, g) => Math.max(m, g.id), 0) + 1;
  const savedAt = new Date().toISOString();
  arr.push({ id, savedAt, ...rec });
  writeFile(arr);
  return { id, savedAt };
}

async function listGames() {
  if (pool) {
    await ready;
    const r = await pool.query('SELECT id, saved_at, couple_a, couple_b, player_count FROM games ORDER BY saved_at DESC');
    return r.rows.map(x => ({ id: x.id, savedAt: x.saved_at, couple: { a: x.couple_a, b: x.couple_b }, playerCount: x.player_count }));
  }
  return readFile().sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)))
    .map(g => ({ id: g.id, savedAt: g.savedAt, couple: g.couple, playerCount: g.leaderboard.length }));
}

async function getGame(id) {
  id = Number(id);
  if (pool) {
    await ready;
    const r = await pool.query('SELECT id, saved_at, data FROM games WHERE id=$1', [id]);
    return r.rows.length ? { ...r.rows[0].data, id: r.rows[0].id, savedAt: r.rows[0].saved_at } : null;
  }
  return readFile().find(g => g.id === id) || null;
}

async function deleteGame(id) {
  id = Number(id);
  if (pool) { await ready; await pool.query('DELETE FROM games WHERE id=$1', [id]); return; }
  writeFile(readFile().filter(g => g.id !== id));
}

module.exports = { saveGame, listGames, getGame, deleteGame, usingDb: !!pool };
