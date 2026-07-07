const path = require('path');
const http = require('http');
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const { Server } = require('socket.io');
const storage = require('./storage');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'mariage';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// HTML re-validé à chaque chargement : après un redéploiement, tous les écrans récupèrent
// la dernière version (sinon le cache navigateur peut servir l'ancienne — thème pas appliqué
// partout). Les autres fichiers (JPEG des feuilles, etc.) gardent le cache par défaut.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));
const sendPage = name => (req, res) =>
  res.sendFile(path.join(__dirname, 'public', name), { headers: { 'Cache-Control': 'no-cache' } });
app.get('/admin', sendPage('admin.html'));
app.get('/classement', sendPage('classement.html'));
app.get('/affiche', sendPage('affiche.html'));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ---------------------------------------------------------------------------
// État du jeu (en mémoire — un redémarrage du serveur remet tout à zéro)
// ---------------------------------------------------------------------------
const game = {
  theme: 'gold',        // 'gold' | 'forest' — habillage partagé, choisi par l'admin (hors progression)
  duration: 0,          // secondes par question ; 0 = pas de minuteur (révélation manuelle)
  couple: { a: 'Marié·e A', b: 'Marié·e B' },
  questions: [],        // { id, text, answerRaw, kind } — kind 'choice'|'number' ; id stable
  nextQid: 1,           // compteur d'id
  current: null,        // id de la question active (ou venant d'être révélée), null sinon
  phase: 'lobby',       // lobby | question | reveal | ended
  startedAt: 0,
  deadline: 0,          // startedAt + duration*1000 si minuteur, sinon 0 (le vote se ferme à l'échéance)
  correct: null,        // 'a'|'b'|'both' (choice) ou la valeur cible (number), figé à la révélation
  counts: null,         // répartition des réponses (figée à la révélation)
  players: new Map(),   // token -> { token, pid, name, score, time, avatar }
  nextPid: 1,           // id PUBLIC du joueur (le token reste secret ; pid sert à associer les photos)
  answers: new Map(),   // token -> { choice|value, ms } pour la question en cours
  results: {},          // id -> { correct, kind, answers: Map(token->{choice|value, ms, pts}) }
};
let revealTimer = null; // handle du setTimeout d'auto-révélation (minuteur)

// Bonus de rapidité borné : réponse instantanée ≈ 1000, à l'échéance ≈ 500 (plancher = équité 4G).
// La fenêtre = la durée du minuteur si défini, sinon 20 s par défaut.
const POINTS_MAX = 1000, POINTS_MIN = 500;
function speedPoints(ms) {
  const window = (game.duration > 0 ? game.duration * 1000 : 20000);
  return POINTS_MIN + Math.round((POINTS_MAX - POINTS_MIN) * (1 - Math.min(1, Math.max(0, ms) / window)));
}

// --- Réglages persistants (survivent aux redémarrages si DATABASE_URL est défini) ---
const currentSettings = () => ({
  theme: game.theme, duration: game.duration, couple: { ...game.couple },
  questions: game.questions, nextQid: game.nextQid,
});
let saveTimer = null;
function persistSettings() { // fire-and-forget, léger debounce
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => storage.saveSettings(currentSettings()).catch(() => {}), 300);
}

// Map { pid -> avatar } envoyée une seule fois aux nouveaux arrivants (jamais dans les broadcasts d'état)
const avatarMap = () => {
  const m = {};
  for (const p of game.players.values()) if (p.avatar) m[p.pid] = p.avatar;
  return m;
};

const newQ = (text, answerRaw, kind = 'choice') => ({ id: game.nextQid++, text, answerRaw, kind });
const qById = id => game.questions.find(q => q.id === id);
const isPlayed = id => Object.prototype.hasOwnProperty.call(game.results, id);

// Normalise un texte pour comparaison : minuscules, sans accents
const fold = s => String(s ?? '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// La réponse de l'Excel est stockée brute et résolue ici, pour que changer
// les prénoms des mariés après l'import ne casse pas la correspondance.
function resolveAnswer(q) {
  if (!q) return null;
  if (q.kind === 'number') {
    const n = parseFloat(String(q.answerRaw).replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
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
    .map(p => ({ pid: p.pid, name: p.name, score: p.score, time: p.time }));
}

// Qui a répondu juste le plus vite (questions à choix) — pour la mise en scène du reveal
function fastestCorrect() {
  const res = game.results[game.current];
  if (!res || res.kind !== 'choice') return null;
  let best = null;
  for (const [token, a] of res.answers) {
    if (a.pts > 0 && (!best || a.ms < best.ms)) {
      const p = game.players.get(token);
      if (p) best = { pid: p.pid, name: p.name, ms: a.ms };
    }
  }
  return best;
}

// Estimations les plus proches de la cible (questions numériques) — top 5 par points
function closestGuesses() {
  const res = game.results[game.current];
  if (!res || res.kind !== 'number') return null;
  return [...res.answers.entries()]
    .map(([token, a]) => { const p = game.players.get(token); return p ? { pid: p.pid, name: p.name, value: a.value, pts: a.pts } : null; })
    .filter(Boolean)
    .sort((x, y) => y.pts - x.pts || x.value - y.value)
    .slice(0, 5);
}

function playerState() {
  const curIdx = game.questions.findIndex(q => q.id === game.current); // position 0-based pour l'affichage « X / Y »
  const q = game.questions[curIdx];
  const kind = q ? q.kind : 'choice';
  const showResults = game.phase === 'reveal' || game.phase === 'ended';
  return {
    phase: game.phase,
    couple: game.couple,
    index: curIdx,
    total: game.questions.length,
    question: q ? q.text : null,
    kind,
    duration: game.duration,
    deadline: game.deadline,
    now: Date.now(), // horloge serveur → le client corrige la dérive pour le compte à rebours
    correct: showResults ? game.correct : null,
    counts: showResults ? game.counts : null,
    leaderboard: showResults ? leaderboard() : null,
    fastest: showResults ? fastestCorrect() : null,
    closest: showResults ? closestGuesses() : null,
    playerCount: game.players.size,
  };
}

function adminState() {
  const playedCount = Object.keys(game.results).length;
  return {
    ...playerState(),
    leaderboard: leaderboard(),
    questions: game.questions.map(q => ({
      id: q.id, text: q.text, answer: resolveAnswer(q), kind: q.kind,
      played: isPlayed(q.id), current: q.id === game.current,
    })),
    playedCount,
    allPlayed: game.questions.length > 0 && playedCount === game.questions.length,
    answered: game.answers.size,
    answerCounts: currentCounts(),
    storageDurable: storage.usingDb, // false = fichier local (non durable sur Render gratuit)
    players: [...game.players.values()]
      .sort((x, y) => y.score - x.score || x.time - y.time)
      .map(p => ({ token: p.token, pid: p.pid, name: p.name, score: p.score, time: p.time, answered: game.answers.has(p.token) })),
  };
}

// Instantané d'une partie pour l'historique (sans les photos, pour rester léger)
function gameSnapshot() {
  return {
    couple: { ...game.couple },
    leaderboard: leaderboard().map(p => ({ name: p.name, score: p.score, time: p.time })),
    questions: Object.keys(game.results).map(id => {
      const q = qById(Number(id));
      return { text: q ? q.text : '(question supprimée)', correct: game.results[id].correct, kind: game.results[id].kind };
    }),
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

  let start = 0, coupleFromHeader = false;
  if (fold(raw[0][0]).startsWith('question')) {
    start = 1; // en-tête « Question | Réponse »
  } else if (hasBoolRows && !isBoolRow(raw[0]) && raw[0][1] && raw[0][2]) {
    // en-tête du format TRUE/FALSE : les colonnes B et C portent les prénoms des mariés
    game.couple = { a: raw[0][1].slice(0, 24), b: raw[0][2].slice(0, 24) };
    coupleFromHeader = true;
    start = 1;
  }

  const isNumeric = s => s !== '' && /^\s*-?\d+([.,]\d+)?\s*$/.test(s) && Number.isFinite(parseFloat(s.replace(',', '.')));
  const questions = raw.slice(start).map(r => {
    const b1 = bool(r[1]), b2 = bool(r[2]);
    if (b1 !== null && b2 !== null) { // format TRUE/FALSE → choix
      return newQ(r[0], b1 && b2 ? 'les deux' : b1 ? 'a' : b2 ? 'b' : '', 'choice');
    }
    // colonne B purement numérique → question d'estimation « le plus proche gagne »
    if (isNumeric(r[1])) return newQ(r[0], r[1].trim(), 'number');
    return newQ(r[0], r[1], 'choice');
  });
  if (!questions.length) throw new Error('Aucune question trouvée (la colonne A est-elle remplie ?)');

  // Format « Question | Réponse » : déduire les prénoms des mariés depuis la colonne réponse
  // (les 2 premiers prénoms distincts rencontrés). Sinon les réponses « Camille »/« Jules » ne
  // résolvent pas et tout tombe en « validation en direct ».
  if (!coupleFromHeader) {
    const seen = new Map(); // prénom normalisé -> affichage (1re occurrence)
    for (const q of questions) {
      if (q.kind !== 'choice') continue;
      const disp = String(q.answerRaw).trim();
      const f = fold(disp);
      if (!f || f.includes('deux') || f.includes('both') || ['a', 'b', '1', '2'].includes(f)) continue;
      if (!seen.has(f)) seen.set(f, disp);
    }
    const names = [...seen.values()];
    if (names.length >= 2) game.couple = { a: names[0].slice(0, 24), b: names[1].slice(0, 24) };
  }

  game.questions = questions;
  resetProgress();
  persistSettings();
  broadcast();
  return questions.length;
}

// Remet à zéro la progression (questions jouées, question active) sans toucher aux scores
function resetProgress() {
  clearTimeout(revealTimer);
  game.current = null;
  game.phase = 'lobby';
  game.answers = new Map();
  game.correct = null;
  game.counts = null;
  game.results = {};
  game.deadline = 0;
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

  // Thème poussé dès la connexion (avant tout join/board:join/login) pour que TOUTES
  // les pages — dont l'écran d'accueil du joueur avant qu'il saisisse son prénom —
  // affichent le bon habillage sans attendre.
  socket.emit('theme:set', game.theme);

  // --- Joueurs -------------------------------------------------------------
  socket.on('join', (data, cb) => {
    const token = String(data?.token || '');
    const name = String(data?.name || '').trim().slice(0, 24);
    if (!token || !name) return cb && cb({ error: 'Prénom requis' });
    let p = game.players.get(token);
    if (!p) {
      p = { token, pid: game.nextPid++, name, score: 0, time: 0, avatar: null };
      game.players.set(token, p);
    } else {
      p.name = name;
    }
    socket.data.token = token;
    socket.join('players');
    socket.join('player:' + token); // salle dédiée pour pouvoir cibler ce joueur (ex. expulsion)
    const ans = game.answers.get(token);
    cb && cb({
      state: playerState(),
      you: { pid: p.pid, name: p.name, score: p.score, choice: ans?.choice ?? null, value: ans?.value ?? null },
      avatars: avatarMap(),
      theme: game.theme,
    });
    broadcast();
  });

  // Photo (vignette compressée côté client) — diffusée une seule fois, hors broadcast d'état
  socket.on('avatar', data => {
    const token = socket.data.token;
    const avatar = String(data || '');
    if (!token) return;
    const p = game.players.get(token);
    if (!p) return;
    if (!avatar.startsWith('data:image/') || avatar.length > 200000) return; // garde-fou taille
    p.avatar = avatar;
    io.emit('avatarUpdate', { pid: p.pid, avatar }); // tous : joueurs, classement, régie
  });

  socket.on('answer', (choice, cb) => {
    const token = socket.data.token;
    if (!token || game.phase !== 'question') return;
    if (game.deadline && Date.now() > game.deadline) return; // temps écoulé : vote clos
    if (game.answers.has(token)) return; // une seule réponse, définitive
    const q = qById(game.current);
    if (q && q.kind === 'number') {
      const v = parseFloat(String(choice).replace(',', '.'));
      if (!Number.isFinite(v)) return;
      game.answers.set(token, { value: v, ms: Date.now() - game.startedAt });
    } else {
      if (!['a', 'b', 'both'].includes(choice)) return;
      game.answers.set(token, { choice, ms: Date.now() - game.startedAt });
    }
    cb && cb({ ok: true });
    broadcast();
  });

  // --- Page classement -------------------------------------------------------
  socket.on('board:join', (data, cb) => {
    socket.join('board');
    cb && cb({ ...boardState(), avatars: avatarMap(), theme: game.theme });
  });

  // --- Admin ---------------------------------------------------------------
  socket.on('admin:login', (password, cb) => {
    if (password !== ADMIN_PASSWORD) return cb && cb({ error: 'Mot de passe incorrect' });
    socket.data.admin = true;
    socket.join('admins');
    cb && cb({ state: adminState(), avatars: avatarMap(), theme: game.theme });
  });

  const admin = fn => (...args) => { if (socket.data.admin) fn(...args); };

  // Habillage partagé (doré ⇄ forestier) : appliqué en direct sur tous les écrans
  socket.on('admin:setTheme', admin(t => {
    game.theme = t === 'forest' ? 'forest' : 'gold';
    persistSettings();
    io.emit('theme:set', game.theme); // joueurs, classement, régie
  }));

  // Durée du minuteur par question (secondes ; 0 = pas de minuteur, révélation manuelle)
  socket.on('admin:setDuration', admin(s => {
    const n = Number(s);
    game.duration = Number.isFinite(n) && n >= 0 && n <= 120 ? Math.round(n) : 0;
    persistSettings();
    broadcast();
  }));

  socket.on('admin:couple', admin(data => {
    game.couple = {
      a: String(data?.a || '').trim().slice(0, 24) || 'Marié·e A',
      b: String(data?.b || '').trim().slice(0, 24) || 'Marié·e B',
    };
    persistSettings();
    broadcast();
  }));

  // Inverse marié·e 1 ↔ marié·e 2 (les réponses restent correctes, seul l'ordre change)
  socket.on('admin:swapCouple', admin(() => {
    game.couple = { a: game.couple.b, b: game.couple.a };
    persistSettings();
    broadcast();
  }));

  socket.on('admin:addQuestion', admin(data => {
    const text = String(data?.text || '').trim();
    if (!text) return;
    if (data?.answer === 'number') { // question d'estimation
      const v = parseFloat(String(data?.value).replace(',', '.'));
      game.questions.push(newQ(text, Number.isFinite(v) ? String(v) : '', 'number'));
    } else {
      const map = { a: 'a', b: 'b', both: 'les deux' };
      game.questions.push(newQ(text, map[data?.answer] || '', 'choice'));
    }
    persistSettings();
    broadcast();
  }));

  socket.on('admin:deleteQuestion', admin(id => {
    id = Number(id);
    // on ne peut supprimer ni la question en cours ni une question déjà jouée
    if (!qById(id) || id === game.current || isPlayed(id)) return;
    game.questions = game.questions.filter(q => q.id !== id);
    persistSettings();
    broadcast();
  }));

  // Vide entièrement la liste des questions et remet la progression à zéro (scores conservés)
  socket.on('admin:clearQuestions', admin(() => {
    game.questions = [];
    resetProgress();
    persistSettings();
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
    game.deadline = game.duration > 0 ? game.startedAt + game.duration * 1000 : 0;
    clearTimeout(revealTimer);
    if (game.deadline) revealTimer = setTimeout(() => autoReveal(id), game.duration * 1000);
    broadcast();
  }

  // Échéance atteinte : on révèle si la réponse est connue (Excel/estimation) ;
  // pour une question « en direct » sans réponse, le vote est clos et l'admin tranche.
  function autoReveal(id) {
    if (game.current !== id || game.phase !== 'question') return;
    const auto = resolveAnswer(qById(id));
    if (auto !== null && auto !== undefined) doReveal(auto);
    else broadcast(); // rafraîchit l'UI (vote clos), en attente du choix admin
  }

  // Fige la question : calcule les points et mémorise pour permettre l'invalidation.
  function doReveal(correct) {
    if (game.phase !== 'question') return;
    clearTimeout(revealTimer);
    const q = qById(game.current);
    const kind = q ? q.kind : 'choice';
    const stored = new Map();
    if (kind === 'number') {
      // rang par écart absolu à la cible (départage : plus rapide) → points dégressifs, plancher 300
      const ranked = [...game.answers.entries()]
        .filter(([, a]) => typeof a.value === 'number')
        .sort((A, B) => Math.abs(A[1].value - correct) - Math.abs(B[1].value - correct) || A[1].ms - B[1].ms);
      ranked.forEach(([token, a], rank) => {
        const pts = Math.max(300, 1000 - rank * 200);
        const p = game.players.get(token);
        if (p) { p.score += pts; p.time += a.ms; }
        stored.set(token, { value: a.value, ms: a.ms, pts });
      });
    } else {
      for (const [token, a] of game.answers) {
        let pts = 0;
        if (a.choice === correct) {
          pts = speedPoints(a.ms);
          const p = game.players.get(token);
          if (p) { p.score += pts; p.time += a.ms; }
        }
        stored.set(token, { choice: a.choice, ms: a.ms, pts });
      }
    }
    game.correct = correct;
    game.counts = currentCounts();
    game.results[game.current] = { correct, kind, answers: stored };
    game.phase = 'reveal';
    game.deadline = 0;
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
    const q = qById(game.current);
    if (q && q.kind === 'number') { // estimation : cible connue, le choix admin est ignoré
      const target = resolveAnswer(q);
      if (target === null) return;
      return doReveal(target);
    }
    const correct = ['a', 'b', 'both'].includes(choice) ? choice : resolveAnswer(q);
    if (!correct) return; // pas de réponse en base : l'admin doit en choisir une
    doReveal(correct);
  }));

  // Annule la question EN COURS avant révélation : réponses jetées, aucun point, retour au lobby
  socket.on('admin:cancelCurrent', admin(() => {
    if (game.phase !== 'question') return;
    clearTimeout(revealTimer);
    game.current = null;
    game.phase = 'lobby';
    game.answers = new Map();
    game.correct = null;
    game.counts = null;
    game.deadline = 0;
    broadcast();
  }));

  // Invalide une question DÉJÀ RÉVÉLÉE : retire les points qu'elle avait attribués (montant exact stocké)
  socket.on('admin:invalidate', admin(id => {
    id = Number(id);
    const res = game.results[id];
    if (!res) return;
    for (const [token, a] of res.answers) {
      const p = game.players.get(token);
      if (p && a.pts) {
        p.score = Math.max(0, p.score - a.pts);
        p.time = Math.max(0, p.time - a.ms);
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
    io.to('players').emit('kicked'); // renvoie tous les téléphones à l'accueil, cache effacé
    game.players = new Map();
    game.answers = new Map();
    broadcast();
  }));

  // --- Historique des parties (stockage durable) ---------------------------
  socket.on('admin:saveGame', admin(async cb => {
    try {
      const snap = gameSnapshot();
      if (!snap.leaderboard.length) return cb && cb({ error: 'Aucun joueur à sauvegarder' });
      const { id, savedAt } = await storage.saveGame(snap);
      cb && cb({ ok: true, id, savedAt });
    } catch (e) { cb && cb({ error: e.message }); }
  }));

  socket.on('admin:history:list', admin(async cb => {
    try { cb && cb({ ok: true, games: await storage.listGames() }); } catch (e) { cb && cb({ error: e.message }); }
  }));

  socket.on('admin:history:get', admin(async (id, cb) => {
    try { cb && cb({ ok: true, game: await storage.getGame(id) }); } catch (e) { cb && cb({ error: e.message }); }
  }));

  socket.on('admin:history:delete', admin(async (id, cb) => {
    try { await storage.deleteGame(id); cb && cb({ ok: true }); } catch (e) { cb && cb({ error: e.message }); }
  }));

  // Supprime un joueur précis (identifié par son token)
  socket.on('admin:removePlayer', admin(token => {
    token = String(token);
    io.to('player:' + token).emit('kicked'); // renvoie son téléphone à l'accueil, cache effacé
    game.players.delete(token);
    game.answers.delete(token);
    broadcast();
  }));
});

// Restaure les réglages persistés (couple, thème, durée, questions) puis démarre.
// Non bloquant en cas d'erreur de stockage : on démarre quand même avec les valeurs par défaut.
storage.loadSettings()
  .then(s => {
    if (!s) return;
    if (s.theme) game.theme = s.theme;
    if (typeof s.duration === 'number') game.duration = s.duration;
    if (s.couple && s.couple.a && s.couple.b) game.couple = s.couple;
    if (Array.isArray(s.questions)) {
      game.questions = s.questions.map(q => ({ kind: 'choice', ...q })); // compat anciens réglages
      if (typeof s.nextQid === 'number') game.nextQid = Math.max(s.nextQid, ...game.questions.map(q => q.id + 1), 1);
    }
  })
  .catch(() => {})
  .finally(() => server.listen(PORT, () => console.log(`Jeu des mariés prêt sur le port ${PORT} — admin sur /admin`)));
