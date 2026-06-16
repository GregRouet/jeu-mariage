// Test de bout en bout : import Excel, joueurs, question auto, question en direct, scores.
// Usage : node test-e2e.js (le serveur doit tourner sur :3000)
const { io } = require('socket.io-client');
const fs = require('fs');

const URL = 'http://localhost:3000';
const assert = (cond, msg) => { if (!cond) { console.error('ÉCHEC :', msg); process.exit(1); } console.log('OK :', msg); };
// Si pas de donnée, ne pas envoyer d'arg parasite avant l'ack (socket.io = ack en dernier arg)
const emit = (sock, ev, arg) => new Promise(res => arg === undefined ? sock.emit(ev, res) : sock.emit(ev, arg, res));
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // 1. Import du fichier Excel
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync('questions-exemple.xlsx')]), 'questions.xlsx');
  fd.append('password', 'mariage');
  const up = await (await fetch(URL + '/admin/upload', { method: 'POST', body: fd })).json();
  assert(up.ok && up.count === 5, 'import Excel : 5 questions (reçu ' + JSON.stringify(up) + ')');

  const bad = await fetch(URL + '/admin/upload', { method: 'POST', body: (() => { const f = new FormData(); f.append('password', 'faux'); return f; })() });
  assert(bad.status === 403, 'upload refusé avec mauvais mot de passe');

  // 2. Admin
  const admin = io(URL);
  const badLogin = await emit(admin, 'admin:login', 'faux');
  assert(badLogin.error, 'login admin refusé avec mauvais mot de passe');
  const login = await emit(admin, 'admin:login', 'mariage');
  assert(login.state, 'login admin accepté');
  let adminState = login.state;
  admin.on('state', s => adminState = s);

  admin.emit('admin:couple', { a: 'Camille', b: 'Jules' });
  await wait(200);
  assert(adminState.couple.a === 'Camille', 'prénoms des mariés enregistrés');
  assert(adminState.questions[0].answer === 'a', 'réponse "Camille" résolue → a');
  assert(adminState.questions[1].answer === 'b', 'réponse "Jules" résolue → b');
  assert(adminState.questions[2].answer === 'both', 'réponse "les deux" résolue → both');
  assert(adminState.questions[3].answer === null, 'réponse vide → validation en direct');

  // 3. Joueurs
  const players = [];
  for (const name of ['Alice', 'Bob', 'Chloé']) {
    const sock = io(URL);
    const res = await emit(sock, 'join', { token: 'tok-' + name, name });
    assert(res.you && res.you.name === name, 'joueur ' + name + ' inscrit');
    players.push({ name, sock, state: res.state });
    sock.on('state', s => players.find(p => p.sock === sock).state = s);
  }
  await wait(100);
  // membership (et non === 3) : d'autres clients (onglets ouverts) peuvent être connectés
  assert(['Alice', 'Bob', 'Chloé'].every(n => adminState.players.some(p => p.name === n)),
    'les 3 invités du test sont connectés côté admin');

  // 4. Question 1 (réponse auto : Camille). Alice et Bob répondent juste, Chloé faux.
  admin.emit('admin:next');
  await wait(150);
  assert(players[0].state.phase === 'question' && players[0].state.question.includes('gourmand'), 'question 1 diffusée aux joueurs');
  assert(players[0].state.correct === null, 'la bonne réponse n’est pas divulguée pendant la question');
  await emit(players[0].sock, 'answer', 'a');
  await emit(players[1].sock, 'answer', 'a');
  players[1].sock.emit('answer', 'b'); // tentative de double réponse (ignorée par le serveur, sans accusé)
  await emit(players[2].sock, 'answer', 'both');
  await wait(150);
  assert(['Alice', 'Bob', 'Chloé'].every(n => adminState.players.find(p => p.name === n)?.answered),
    'les 3 réponses du test sont comptées côté admin');

  admin.emit('admin:reveal');
  await wait(150);
  assert(players[0].state.phase === 'reveal' && players[0].state.correct === 'a', 'révélation auto : bonne réponse = a');
  assert(players[0].state.counts.a === 2 && players[0].state.counts.both === 1, 'répartition des votes correcte (double réponse ignorée)');
  const lb1 = players[0].state.leaderboard;
  assert(lb1.find(p => p.name === 'Alice').score === 1 && lb1.find(p => p.name === 'Chloé').score === 0, 'scores Q1 : Alice 1, Chloé 0');

  // 5. Question 2 et 3 : Chloé seule répond juste à chaque fois → doit passer en tête
  for (const correct of ['b', 'both']) {
    admin.emit('admin:next');
    await wait(150);
    await emit(players[2].sock, 'answer', correct);
    await emit(players[0].sock, 'answer', 'a');
    admin.emit('admin:reveal');
    await wait(150);
  }
  const lb3 = players[0].state.leaderboard;
  assert(lb3[0].name === 'Chloé' && lb3[0].score === 2, 'Chloé en tête avec 2 points après Q3');

  // 6. Question 4 : validation en direct (pas de réponse dans l'Excel)
  admin.emit('admin:next');
  await wait(150);
  await emit(players[0].sock, 'answer', 'b');
  admin.emit('admin:reveal'); // sans choix → doit être ignoré (pas de réponse en base)
  await wait(150);
  assert(players[0].state.phase === 'question', 'révélation sans choix ignorée en mode direct');
  admin.emit('admin:reveal', 'b');
  await wait(150);
  assert(players[0].state.correct === 'b', 'révélation en direct avec choix admin');
  assert(players[0].state.leaderboard.find(p => p.name === 'Alice').score === 2, 'Alice à 2 points après Q4');

  // 6b. Page classement : leaderboard reçu et mis à jour en temps réel
  const board = io(URL);
  let boardState = await emit(board, 'board:join', null);
  board.on('state', s => boardState = s);
  assert(Array.isArray(boardState.leaderboard) && boardState.leaderboard.some(p => p.name === 'Alice'),
    'page classement : leaderboard reçu à la connexion');

  // 6c. Ajout / suppression de questions (identité par id, stable)
  admin.emit('admin:addQuestion', { text: 'Question ajoutée en cours de route ?', answer: 'both' });
  await wait(150);
  let last = adminState.questions[adminState.questions.length - 1];
  assert(last.text === 'Question ajoutée en cours de route ?' && last.answer === 'both', 'question ajoutée avec réponse « les deux »');
  const nq = adminState.questions.length;
  admin.emit('admin:deleteQuestion', last.id);
  await wait(150);
  assert(adminState.questions.length === nq - 1, 'question (non jouée) supprimée par id');
  const playedQ = adminState.questions.find(q => q.played);
  admin.emit('admin:deleteQuestion', playedQ.id); // déjà jouée → doit être refusée
  await wait(150);
  assert(adminState.questions.length === nq - 1, 'suppression d’une question déjà jouée refusée');

  // 7. Reconnexion : Bob revient avec le même token, garde son score
  players[1].sock.disconnect();
  const bob2 = io(URL);
  const re = await emit(bob2, 'join', { token: 'tok-Bob', name: 'Bob' });
  assert(re.you.score === 1, 'Bob reconnecté retrouve son score (1)');

  // 7b. Suppression d'un joueur précis (par token) puis vidage complet
  assert(adminState.players.some(p => p.name === 'Alice' && p.token), 'le token des joueurs est exposé à l’admin');
  let aliceKicked = false;
  players[0].sock.on('kicked', () => { aliceKicked = true; });
  admin.emit('admin:removePlayer', 'tok-Alice');
  await wait(150);
  assert(aliceKicked, 'le joueur supprimé reçoit l’ordre de revenir à l’accueil (kicked)');
  assert(!adminState.players.some(p => p.name === 'Alice'), 'joueur Alice supprimé');
  assert(adminState.players.some(p => p.name === 'Chloé'), 'les autres joueurs restent après suppression d’un seul');

  // 8. Fin + reset
  admin.emit('admin:end');
  await wait(150);
  assert(players[0].state.phase === 'ended', 'phase finale diffusée');
  assert(boardState.phase === 'ended' && boardState.leaderboard.length >= 2, 'page classement à jour en fin de partie');
  admin.emit('admin:reset');
  await wait(150);
  assert(players[0].state.phase === 'lobby' && adminState.players.every(p => p.score === 0), 'reset : retour au lobby, scores à zéro');

  // 8b. Vidage complet de la liste des joueurs
  let chloeKicked = false;
  players[2].sock.on('kicked', () => { chloeKicked = true; });
  admin.emit('admin:clearPlayers');
  await wait(150);
  assert(chloeKicked, 'vidage : les joueurs restants reçoivent kicked');
  assert(adminState.players.length === 0 && adminState.playerCount === 0, 'liste des joueurs entièrement vidée');

  // 9. Scénario isolé : vider les questions, lancer au choix, annuler, invalider
  admin.emit('admin:clearQuestions');
  await wait(120);
  assert(adminState.questions.length === 0 && adminState.phase === 'lobby', 'toutes les questions vidées, retour au lobby');

  admin.emit('admin:addQuestion', { text: 'QA', answer: 'a' });
  admin.emit('admin:addQuestion', { text: 'QB', answer: 'b' });
  await wait(150);
  const qa = adminState.questions[0], qb = adminState.questions[1];
  const z = io(URL);
  const zJoin = await emit(z, 'join', { token: 'tok-Z', name: 'Zoe' });
  assert(zJoin.you.pid && zJoin.avatars && typeof zJoin.avatars === 'object', 'le join renvoie un id public + la map des photos');

  // 9b. Photo : diffusée par id public via avatarUpdate, hors broadcast d'état
  let gotAvatar = null;
  admin.on('avatarUpdate', d => { gotAvatar = d; });
  z.emit('avatar', 'data:image/jpeg;base64,/9j/4AAQSkZJRg==');
  await wait(150);
  assert(gotAvatar && gotAvatar.pid === zJoin.you.pid && gotAvatar.avatar.startsWith('data:image/'), 'photo diffusée via avatarUpdate avec le pid public');
  gotAvatar = null;
  z.emit('avatar', 'pas-une-image'); // format invalide → ignoré, aucune diffusion
  await wait(120);
  assert(gotAvatar === null, 'photo au format invalide rejetée (aucune diffusion)');

  // lancer directement la 2e question (au choix, pas la 1re)
  admin.emit('admin:launch', qb.id);
  await wait(150);
  assert(adminState.phase === 'question' && adminState.questions.find(q => q.current).id === qb.id, 'lancer une question au choix (la 2e avant la 1re)');

  // annuler la question en cours : aucun point, aucune question jouée
  admin.emit('admin:cancelCurrent');
  await wait(150);
  assert(adminState.phase === 'lobby' && !adminState.questions.some(q => q.current) && adminState.playedCount === 0, 'annulation de la question en cours (rien n’est compté)');

  // rejouer QB et marquer un point
  admin.emit('admin:launch', qb.id);
  await wait(150);
  await emit(z, 'answer', 'b');
  admin.emit('admin:reveal');
  await wait(150);
  assert(adminState.players.find(p => p.name === 'Zoe').score === 1, 'Zoe marque 1 point sur QB');
  assert(adminState.questions.find(q => q.id === qb.id).played, 'QB marquée comme jouée');

  // invalider QB : Zoe reperd son point, QB redevient jouable
  admin.emit('admin:invalidate', qb.id);
  await wait(150);
  assert(adminState.players.find(p => p.name === 'Zoe').score === 0, 'invalidation : Zoe reperd son point');
  assert(!adminState.questions.find(q => q.id === qb.id).played, 'QB n’est plus jouée après invalidation');
  assert(adminState.phase === 'lobby', 'retour au lobby après invalidation de la question affichée');

  // 10. Historique : sauvegarde, liste, consultation, suppression (stockage fichier en test)
  admin.emit('admin:launch', qa.id);
  await wait(120);
  await emit(z, 'answer', 'a');
  admin.emit('admin:reveal');
  await wait(120);
  const save = await emit(admin, 'admin:saveGame');
  assert(save.ok && save.id, 'partie sauvegardée dans l’historique');
  const list = await emit(admin, 'admin:history:list');
  assert(list.ok && list.games.some(g => g.id === save.id), 'la partie apparaît dans la liste de l’historique');
  const got = await emit(admin, 'admin:history:get', save.id);
  assert(got.ok && got.game && got.game.leaderboard.find(p => p.name === 'Zoe'), 'consultation d’une partie sauvegardée (classement présent)');
  const del = await emit(admin, 'admin:history:delete', save.id);
  const list2 = await emit(admin, 'admin:history:list');
  assert(del.ok && !list2.games.some(g => g.id === save.id), 'suppression d’une partie de l’historique');

  console.log('\nTous les tests passent ✦');
  process.exit(0);
})().catch(e => { console.error('ERREUR :', e); process.exit(1); });
