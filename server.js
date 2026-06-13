const path = require('path');
const http = require('http');
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'mariage';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/classement', (req, res) => res.sendFile(path.join(__dirname, 'public', 'classement.html')));
app.get('/affiche', (req, res) => res.sendFile(path.join(__dirname, 'public', 'affiche.html')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ---------------------------------------------------------------------------
// État du jeu (en mémoire — un redémarrage du serveur remet tout à zéro)
// ---------------------------------------------------------------------------
const game = {
  couple: { a: 'Marié·e A', b: 'Marié·e B' },
  questions: [],        // { text, answerRaw }
  current: -1,          // index de la question en cours
  phase: 'lobby',       // lobby | question | reveal | ended
  startedAt: 0,
  correct: null,        // 'a' | 'b' | 'both' (figé à la révélation)
  counts: null,         // répartition des réponses (figée à la révélation)
  players: new Map(),   // token -> { token, name, score, time }
  answers: new Map(),   // token -> { choice, ms } pour la question en cours
};

// Normalise un texte pour comparaison : minuscules, sans accents
const fold = s => String(s ?? '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// La réponse de l'Excel est stockée brute et résolue ici, pour que changer
// les prénoms des mariés après l'import ne casse pas la correspondance.
function resolveAnswer(q) {
  if (!q) return null;
  const v = fold(q.answerRaw);
  if (!v) return null;
  if (v.includes('deux') || v.includes('both')) return 'both';
  if (v === 'a' || v === '1' || v === fold(game.couple.a)) return 'a';
  if (v === 'b' || v === '2' || v === fold(game.couple.b)) return 'b';
  return null; // non reconnu → validation en direct par l'admin
}

function currentCounts() {
  const c = { a: 0, b: 0, both: 0 };
  for (const ans of game.answers.values()) c[ans.choice]++;
  return c;
}

// Classement : score décroissant, départagé par le temps de réponse cumulé
function leaderboard() {
  return [...game.players.values()]
    .sort((x, y) => y.score - x.score || x.time - y.time)
    .map(p => ({ name: p.name, score: p.score, time: p.time }));
}

function playerState() {
  const q = game.questions[game.current];
  const showResults = game.phase === 'reveal' || game.phase === 'ended';
  return {
    phase: game.phase,
    couple: game.couple,
    index: game.current,
    total: game.questions.length,
    question: q ? q.text : null,
    correct: showResults ? game.correct : null,
    counts: showResults ? game.counts : null,
    leaderboard: showResults ? leaderboard() : null,
    playerCount: game.players.size,
  };
}

function adminState() {
  return {
    ...playerState(),
    leaderboard: leaderboard(),
    questions: game.questions.map(q => ({ text: q.text, answer: resolveAnswer(q) })),
    answered: game.answers.size,
    answerCounts: currentCounts(),
    players: [...game.players.values()]
      .sort((x, y) => y.score - x.score || x.time - y.time)
      .map(p => ({ name: p.name, score: p.score, time: p.time, answered: game.answers.has(p.token) })),
  };
}

// État pour la page classement (/classement) : leaderboard toujours visible
function boardState() {
  return { ...playerState(), leaderboard: leaderboard(), answered: game.answers.size };
}

function broadcast() {
  io.to('players').emit('state', playerState());
  io.to('admins').emit('state', adminState());
  io.to('board').emit('state', boardState());
}

// ---------------------------------------------------------------------------
// Import du fichier Excel (colonne A : question, colonne B : réponse optionnelle)
// ---------------------------------------------------------------------------
// Charge les questions depuis un classeur (xlsx ou csv) et remet la partie au début.
// Deux formats acceptés :
//   1. « Question | Réponse » : colonne B = prénom, "les deux", ou vide (validation en direct)
//   2. « Question | Marié·e 1 | Marié·e 2 » : colonnes B et C en TRUE/FALSE (ou vrai/faux,
//      oui/non) ; l'en-tête fournit alors les prénoms des mariés.
function ingest(wb) {
  const raw = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, blankrows: false, defval: '' })
    .map(r => [String(r[0] ?? '').trim(), String(r[1] ?? '').trim(), String(r[2] ?? '').trim()])
    .filter(r => r[0]);
  if (!raw.length) throw new Error('Aucune question trouvée (la colonne A est-elle remplie ?)');

  const bool = v => {
    const f = fold(v);
    return ['true', 'vrai', 'oui'].includes(f) ? true : ['false', 'faux', 'non'].includes(f) ? false : null;
  };
  const isBoolRow = r => bool(r[1]) !== null && bool(r[2]) !== null;
  const hasBoolRows = raw.some(isBoolRow);

  let start = 0;
  if (fold(raw[0][0]).startsWith('question')) {
    start = 1; // en-tête « Question | Réponse »
  } else if (hasBoolRows && !isBoolRow(raw[0]) && raw[0][1] && raw[0][2]) {
    // en-tête du format TRUE/FALSE : les colonnes B et C portent les prénoms des mariés
    game.couple = { a: raw[0][1].slice(0, 24), b: raw[0][2].slice(0, 24) };
    start = 1;
  }

  const questions = raw.slice(start).map(r => {
    const b1 = bool(r[1]), b2 = bool(r[2]);
    const answerRaw = (b1 !== null && b2 !== null)
      ? (b1 && b2 ? 'les deux' : b1 ? 'a' : b2 ? 'b' : '') // FALSE/FALSE → validation en direct
      : r[1];
    return { text: r[0], answerRaw };
  });
  if (!questions.length) throw new Error('Aucune question trouvée (la colonne A est-elle remplie ?)');

  game.questions = questions;
  game.current = -1;
  game.phase = 'lobby';
  game.answers = new Map();
  game.correct = null;
  game.counts = null;
  broadcast();
  return questions.length;
}

app.post('/admin/upload', upload.single('file'), (req, res) => {
  if ((req.body.password || '') !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Mot de passe incorrect' });
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    res.json({ ok: true, count: ingest(wb) });
  } catch (e) {
    res.status(400).json({ error: 'Fichier illisible : ' + e.message });
  }
});

// Import depuis Google Sheets : la feuille doit être partagée
// « Tous les utilisateurs disposant du lien » (lecteur) — on la lit en CSV, sans clé API.
app.post('/admin/import-gsheet', express.json(), async (req, res) => {
  if ((req.body.password || '') !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Mot de passe incorrect' });
  const url = String(req.body.url || '');
  const id = (url.match(/\/d\/([a-zA-Z0-9_-]+)/) || [])[1];
  if (!id) return res.status(400).json({ error: 'Lien non reconnu (attendu : https://docs.google.com/spreadsheets/d/…)' });
  const gid = (url.match(/[#&?]gid=(\d+)/) || [])[1] || '0';
  try {
    const r = await fetch(`https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`);
    const text = await r.text();
    if (!r.ok || /<html/i.test(text.slice(0, 500))) {
      return res.status(400).json({ error: 'Feuille inaccessible : dans Google Sheets, Partager → « Tous les utilisateurs disposant du lien » (Lecteur)' });
    }
    const wb = XLSX.read(text, { type: 'string' });
    res.json({ ok: true, count: ingest(wb) });
  } catch (e) {
    res.status(400).json({ error: 'Import impossible : ' + e.message });
  }
});

// ---------------------------------------------------------------------------
// Temps réel
// ---------------------------------------------------------------------------
io.on('connection', socket => {

  // --- Joueurs -------------------------------------------------------------
  socket.on('join', (data, cb) => {
    const token = String(data?.token || '');
    const name = String(data?.name || '').trim().slice(0, 24);
    if (!token || !name) return cb && cb({ error: 'Prénom requis' });
    let p = game.players.get(token);
    if (!p) {
      p = { token, name, score: 0, time: 0 };
      game.players.set(token, p);
    } else {
      p.name = name;
    }
    socket.data.token = token;
    socket.join('players');
    cb && cb({
      state: playerState(),
      you: { name: p.name, score: p.score, choice: game.answers.get(token)?.choice ?? null },
    });
    broadcast();
  });

  socket.on('answer', (choice, cb) => {
    const token = socket.data.token;
    if (!token || game.phase !== 'question') return;
    if (!['a', 'b', 'both'].includes(choice)) return;
    if (game.answers.has(token)) return; // une seule réponse, définitive
    game.answers.set(token, { choice, ms: Date.now() - game.startedAt });
    cb && cb({ ok: true });
    broadcast();
  });

  // --- Page classement -------------------------------------------------------
  socket.on('board:join', (data, cb) => {
    socket.join('board');
    cb && cb(boardState());
  });

  // --- Admin ---------------------------------------------------------------
  socket.on('admin:login', (password, cb) => {
    if (password !== ADMIN_PASSWORD) return cb && cb({ error: 'Mot de passe incorrect' });
    socket.data.admin = true;
    socket.join('admins');
    cb && cb({ state: adminState() });
  });

  const admin = fn => (...args) => { if (socket.data.admin) fn(...args); };

  socket.on('admin:couple', admin(data => {
    game.couple = {
      a: String(data?.a || '').trim().slice(0, 24) || 'Marié·e A',
      b: String(data?.b || '').trim().slice(0, 24) || 'Marié·e B',
    };
    broadcast();
  }));

  socket.on('admin:addQuestion', admin(data => {
    const text = String(data?.text || '').trim();
    if (!text) return;
    const map = { a: 'a', b: 'b', both: 'les deux' };
    game.questions.push({ text, answerRaw: map[data?.answer] || '' });
    broadcast();
  }));

  socket.on('admin:deleteQuestion', admin(i => {
    i = Number(i);
    // on ne peut supprimer ni la question en cours ni une question déjà jouée
    if (!Number.isInteger(i) || i <= game.current || i >= game.questions.length) return;
    game.questions.splice(i, 1);
    broadcast();
  }));

  socket.on('admin:next', admin(() => {
    if (game.current + 1 >= game.questions.length) return;
    game.current += 1;
    game.phase = 'question';
    game.answers = new Map();
    game.correct = null;
    game.counts = null;
    game.startedAt = Date.now();
    broadcast();
  }));

  socket.on('admin:reveal', admin(choice => {
    if (game.phase !== 'question') return;
    const correct = ['a', 'b', 'both'].includes(choice) ? choice : resolveAnswer(game.questions[game.current]);
    if (!correct) return; // pas de réponse en base : l'admin doit en choisir une
    game.correct = correct;
    game.counts = currentCounts();
    for (const [token, ans] of game.answers) {
      const p = game.players.get(token);
      if (p && ans.choice === correct) {
        p.score += 1;
        p.time += ans.ms;
      }
    }
    game.phase = 'reveal';
    broadcast();
  }));

  socket.on('admin:end', admin(() => {
    game.phase = 'ended';
    broadcast();
  }));

  socket.on('admin:reset', admin(() => {
    game.current = -1;
    game.phase = 'lobby';
    game.answers = new Map();
    game.correct = null;
    game.counts = null;
    for (const p of game.players.values()) {
      p.score = 0;
      p.time = 0;
    }
    broadcast();
  }));
});

server.listen(PORT, () => console.log(`Jeu des mariés prêt sur le port ${PORT} — admin sur /admin`));
