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
  questions: [],        // { id, text, answerRaw } — id stable (l'index de tableau bouge si on supprime)
  nextQid: 1,           // compteur d'id
  current: null,        // id de la question active (ou venant d'être révélée), null sinon
  phase: 'lobby',       // lobby | question | reveal | ended
  startedAt: 0,
  correct: null,        // 'a' | 'b' | 'both' (figé à la révélation)
  counts: null,         // répartition des réponses (figée à la révélation)
  players: new Map(),   // token -> { token, name, score, time }
  answers: new Map(),   // token -> { choice, ms } pour la question en cours
  results: {},          // id -> { correct, answers } pour chaque question jouée (permet d'annuler)
};

const newQ = (text, answerRaw) => ({ id: game.nextQid++, text, answerRaw });
const qById = id => game.questions.find(q => q.id === id);
const isPlayed = id => Object.prototype.hasOwnProperty.call(game.results, id);

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
  const curIdx = game.questions.findIndex(q => q.id === game.current); // position 0-based pour l'affichage « X / Y »
  const q = game.questions[curIdx];
  const showResults = game.phase === 'reveal' || game.phase === 'ended';
  return {
    phase: game.phase,
    couple: game.couple,
    index: curIdx,
    total: game.questions.length,
    question: q ? q.text : null,
    correct: showResults ? game.correct : null,
    counts: showResults ? game.counts : null,
    leaderboard: showResults ? leaderboard() : null,
    playerCount: game.players.size,
  };
}

function adminState() {
  const playedCount = Object.keys(game.results).length;
  return {
    ...playerState(),
    leaderboard: leaderboard(),
    questions: game.questions.map(q => ({
      id: q.id, text: q.text, answer: resolveAnswer(q),
      played: isPlayed(q.id), current: q.id === game.current,
    })),
    playedCount,
    allPlayed: game.questions.length > 0 && playedCount === game.questions.length,
    answered: game.answers.size,
    answerCounts: currentCounts(),
    players: [...game.players.values()]
      .sort((x, y) => y.score - x.score || x.time - y.time)
      .map(p => ({ token: p.token, name: p.name, score: p.score, time: p.time, answered: game.answers.has(p.token) })),
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
    return newQ(r[0], answerRaw);
  });
  if (!questions.length) throw new Error('Aucune question trouvée (la colonne A est-elle remplie ?)');

  game.questions = questions;
  resetProgress();
  broadcast();
  return questions.length;
}

// Remet à zéro la progression (questions jouées, question active) sans toucher aux scores
function resetProgress() {
  game.current = null;
  game.phase = 'lobby';
  game.answers = new Map();
  game.correct = null;
  game.counts = null;
  game.results = {};
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
    game.questions.push(newQ(text, map[data?.answer] || ''));
    broadcast();
  }));

  socket.on('admin:deleteQuestion', admin(id => {
    id = Number(id);
    // on ne peut supprimer ni la question en cours ni une question déjà jouée
    if (!qById(id) || id === game.current || isPlayed(id)) return;
    game.questions = game.questions.filter(q => q.id !== id);
    broadcast();
  }));

  // Vide entièrement la liste des questions et remet la progression à zéro (scores conservés)
  socket.on('admin:clearQuestions', admin(() => {
    game.questions = [];
    resetProgress();
    broadcast();
  }));

  // Lance une question précise (dans l'ordre que veut l'admin) — sauf si déjà jouée
  function launch(id) {
    if (!qById(id) || isPlayed(id)) return;
    game.current = id;
    game.phase = 'question';
    game.answers = new Map();
    game.correct = null;
    game.counts = null;
    game.startedAt = Date.now();
    broadcast();
  }

  socket.on('admin:launch', admin(id => launch(Number(id))));

  // « Question suivante » : la première question non encore jouée, dans l'ordre de la liste
  socket.on('admin:next', admin(() => {
    const q = game.questions.find(q => !isPlayed(q.id) && q.id !== game.current);
    if (q) launch(q.id);
  }));

  socket.on('admin:reveal', admin(choice => {
    if (game.phase !== 'question') return;
    const correct = ['a', 'b', 'both'].includes(choice) ? choice : resolveAnswer(qById(game.current));
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
    // mémorise le résultat pour pouvoir l'annuler plus tard
    game.results[game.current] = { correct, answers: new Map(game.answers) };
    game.phase = 'reveal';
    broadcast();
  }));

  // Annule la question EN COURS avant révélation : réponses jetées, aucun point, retour au lobby
  socket.on('admin:cancelCurrent', admin(() => {
    if (game.phase !== 'question') return;
    game.current = null;
    game.phase = 'lobby';
    game.answers = new Map();
    game.correct = null;
    game.counts = null;
    broadcast();
  }));

  // Invalide une question DÉJÀ RÉVÉLÉE : retire les points qu'elle avait attribués
  socket.on('admin:invalidate', admin(id => {
    id = Number(id);
    const res = game.results[id];
    if (!res) return;
    for (const [token, ans] of res.answers) {
      const p = game.players.get(token);
      if (p && ans.choice === res.correct) {
        p.score = Math.max(0, p.score - 1);
        p.time = Math.max(0, p.time - ans.ms);
      }
    }
    delete game.results[id];
    // si c'est la question affichée actuellement, on revient au lobby
    if (id === game.current) {
      game.current = null;
      game.phase = 'lobby';
      game.answers = new Map();
      game.correct = null;
      game.counts = null;
    }
    broadcast();
  }));

  socket.on('admin:end', admin(() => {
    game.phase = 'ended';
    broadcast();
  }));

  socket.on('admin:reset', admin(() => {
    resetProgress();
    for (const p of game.players.values()) {
      p.score = 0;
      p.time = 0;
    }
    broadcast();
  }));

  // Vide entièrement la liste des joueurs (utile pour effacer les joueurs de test avant la soirée)
  socket.on('admin:clearPlayers', admin(() => {
    game.players = new Map();
    game.answers = new Map();
    broadcast();
  }));

  // Supprime un joueur précis (identifié par son token)
  socket.on('admin:removePlayer', admin(token => {
    game.players.delete(String(token));
    game.answers.delete(String(token));
    broadcast();
  }));
});

server.listen(PORT, () => console.log(`Jeu des mariés prêt sur le port ${PORT} — admin sur /admin`));
