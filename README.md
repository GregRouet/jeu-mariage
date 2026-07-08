# Le Jeu des Mariés — « Qui des deux ? »

Quiz interactif pour mariage : les invités répondent depuis leur téléphone, l'admin pilote depuis un ordinateur, le classement se met à jour en direct.

## Démarrage en local

```bash
npm install
npm start
```

- **Page invités** : http://localhost:3000/ — chacun entre son prénom et joue.
- **Régie (admin)** : http://localhost:3000/admin — mot de passe par défaut : `mariage` (changeable via la variable d'environnement `ADMIN_PASSWORD`).
- **Classement à projeter** : http://localhost:3000/classement — leaderboard en temps réel (question en cours, compteur de réponses, QR code pour rejoindre), idéal sur grand écran.
- **Affiche A4 à imprimer** : http://localhost:3000/affiche — prénoms + QR code, bouton Imprimer/PDF. ⚠️ À ouvrir depuis l'**URL de production** (le QR encode l'adresse de la page), avec « Graphiques d'arrière-plan » activé à l'impression pour le fond ivoire.

## Déroulement d'une partie

1. Sur `/admin` : entrer les prénoms des mariés, importer le fichier Excel de questions.
2. Les invités scannent le QR code affiché dans la régie (ou tapent l'URL) et entrent leur prénom.
3. Cliquer **« Lancer la première question »** : la question apparaît sur tous les téléphones avec 3 choix (marié·e 1, marié·e 2, les deux).
4. La régie affiche en direct le nombre de réponses reçues. Puis :
   - si la réponse est dans l'Excel → bouton **« Révéler la réponse »** (score automatique) ;
   - sinon (mode « en direct ») → cliquer sur la bonne réponse pour clôturer.
5. Chaque téléphone affiche bonne/mauvaise réponse, la répartition des votes et le classement. **L'écran projeté (`/classement`) affiche aussi la question en grand, un compte à rebours, puis la révélation** (barres de répartition + joueur le plus rapide, ou cible + estimations les plus proches).
6. Après la dernière question : **« Afficher les résultats finaux »** → podium sur tous les téléphones.

**Score** : bonus de rapidité borné — une bonne réponse rapporte **500 à 1000 points** selon le temps de réponse (réponse instantanée ≈ 1000, à l'échéance ≈ 500 ; plancher à 500 pour l'équité 4G). La fenêtre de décroissance = la durée du minuteur si défini, sinon 20 s. Mauvaise réponse = 0. Classement trié par points décroissants, départagé par le temps cumulé (`game.players[].time`). Les points exacts attribués sont mémorisés par réponse pour que l'invalidation les retire précisément.

**Minuteur** (optionnel, réglé dans la régie → *Réglages*, en secondes ; 0 = manuel) : à l'échéance, le vote se ferme ; les questions à réponse connue sont **révélées automatiquement**, les questions « en direct » attendent le clic de l'admin.

**Question d'estimation** (« le plus proche gagne ») : type de question où les joueurs saisissent un **nombre**. Le plus proche de la cible marque le plus (points dégressifs par rang : 1000 / 800 / 600 / 400, plancher 300). Voir le format ci-dessous.

## Format des questions (Excel ou Google Sheets)

Deux formats acceptés, détectés automatiquement (première feuille, une question par ligne) :

**Format 1 — « Question | Réponse »** (voir `questions-exemple.xlsx`) :

| Colonne A (question) | Colonne B (réponse) |
|---|---|
| Qui est le plus gourmand ? | Camille |
| Qui est le plus têtu ? | les deux |
| Qui chante le plus faux sous la douche ? | *(vide → validation en direct par l'admin)* |

- Colonne B : le **prénom exact** d'un des mariés (accents/majuscules ignorés), ou `les deux`, ou **vide**, ou **un nombre** (→ question d'estimation « le plus proche gagne », ex. `30`).
- Une ligne d'en-tête commençant par « Question » est ignorée.

**Format 2 — une colonne TRUE/FALSE par marié·e** :

| Caractéristique | Clémentine | Simon |
|---|---|---|
| Je suis fan des légos | FALSE | TRUE |
| Je suis petit(e) et mignon(ne) | TRUE | TRUE |

- TRUE/FALSE (ou vrai/faux, oui/non) ; TRUE dans les deux colonnes → « les deux » ; FALSE partout → validation en direct.
- Les prénoms de la ligne d'en-tête sont **automatiquement utilisés comme prénoms des mariés**.

L'import peut se refaire à tout moment (il remet la partie au début).

On peut aussi gérer les questions à la main depuis la régie :
- **Ajouter** une question (formulaire sous la liste, ajoutée en fin).
- **Supprimer** une question non jouée (✕).
- **Lancer** n'importe quelle question au choix (▶), dans l'ordre voulu — le bouton « Question suivante » reste disponible pour l'enchaînement séquentiel (= première question non encore jouée).
- **Annuler la question en cours** avant révélation (bouton dans le panneau Déroulé) : réponses jetées, aucun point.
- **Invalider une question déjà révélée** (↩, dans la liste ou le panneau Déroulé) : retire les points qu'elle avait attribués ; elle redevient jouable.
- **Vider toutes les questions** (zone sensible).

Attention : ces modifications manuelles sont écrasées par un nouvel import. Les questions ont un **id stable** (le suivi « jouée / en cours » et l'annulation des points ne dépendent pas de l'ordre dans la liste).

### Import depuis Google Sheets

Dans la régie, colle le lien du document (`https://docs.google.com/spreadsheets/d/…`) et clique « Importer ». Condition : la feuille doit être partagée **« Tous les utilisateurs disposant du lien » (Lecteur)**. L'onglet importé est celui du `gid` présent dans le lien (premier onglet par défaut).

## Historique des parties (stockage durable)

À la fin d'une partie, bouton **« 💾 Sauvegarder cette partie »** dans la régie : le classement final (noms, points, temps) et les questions jouées sont enregistrés. Le panneau **« Historique des parties »** liste les parties sauvegardées — chacune consultable (fenêtre avec le classement), exportable en CSV, ou supprimable.

Le stockage dépend de la configuration (un bandeau dans la régie indique lequel est actif) :
- **Variable `DATABASE_URL` définie** → PostgreSQL : **durable**, survit aux redémarrages. À utiliser sur Render.
- **Sinon** → fichier local `data/games.json` : durable en local / sur disque persistant, mais **éphémère sur l'offre gratuite Render** (effacé à chaque redéploiement/redémarrage).

### Mettre en place une base Postgres gratuite (pour Render)

1. Créer un compte sur [Neon](https://neon.tech) (gratuit, persistant) → nouveau projet → copier la **connection string** (`postgres://…`).
2. Sur Render, service → **Environment** → ajouter `DATABASE_URL` = cette chaîne.
3. Redéployer. La table `games` est créée automatiquement au premier lancement.

(Fonctionne aussi avec Supabase, Render PostgreSQL, ou tout Postgres accessible.)

## Déploiement en ligne (les invités utilisent leur 4G)

Sur [Render](https://render.com) (gratuit) :

1. Pousser ce dossier sur un repo GitHub.
2. Render → **New → Web Service** → connecter le repo.
3. Build command : `npm install` — Start command : `npm start`.
4. Ajouter la variable d'environnement **`ADMIN_PASSWORD`** (sinon c'est `mariage`).
5. L'URL fournie (ex. `https://jeu-mariage.onrender.com`) est celle des invités ; la régie est sur `/admin`.

Fonctionne aussi tel quel sur Railway, Fly.io, ou tout hébergeur Node.js (le port est lu dans `PORT`).

⚠️ **Offre gratuite Render** : le service s'endort après 15 min d'inactivité et l'état du jeu est **en mémoire** (un redémarrage du serveur efface joueurs et scores). Le soir J : ouvrir la page admin ~10 min avant pour réveiller le service, et ne pas redéployer pendant la partie.

## Architecture (notes pour modifications futures)

- `storage.js` — persistance : PostgreSQL si `DATABASE_URL`, sinon fichiers `data/*.json`. API parties terminées : `saveGame / listGames / getGame / deleteGame` ; API **réglages** : `saveSettings / loadSettings`. Le snapshot d'une partie (`gameSnapshot()`) contient le classement et les questions jouées, **sans les photos**. Événements admin : `admin:saveGame`, `admin:history:list/get/delete`.
- **Réglages persistants** : `game` sérialise `{ theme, duration, couple, questions, nextQid }` via `persistSettings()` (debounce, fire-and-forget) à chaque changement (thème, minuteur, prénoms, import/ajout/suppression de questions) ; `storage.loadSettings()` les restaure **au démarrage** (avant `listen`). Durable seulement avec `DATABASE_URL` (le disque Render gratuit est éphémère). L'état **vif** (scores, question en cours, phase) reste en mémoire et n'est pas persisté.
- **Scoring / minuteur / estimation** (dans `server.js`) : `speedPoints(ms)` = bonus de rapidité borné (fenêtre = `game.duration` ou 20 s). `game.duration` (event `admin:setDuration`) arme un `revealTimer` au `launch` ; `doReveal(correct)` calcule et **mémorise les points par réponse** (`game.results[id].answers` → `{choice|value, ms, pts}`) pour une invalidation exacte. Questions `kind:'number'` (estimation) : réponse numérique, scoring par rang de proximité. L'état expose `kind/duration/deadline/now` (compte à rebours corrigé de la dérive d'horloge), `fastest` (plus rapide) et `closest` (meilleures estimations) au reveal.
- `public/classement.html` affiche, en plus du leaderboard, un **plateau** (`#stage`) : question + choix + compte à rebours pendant la question, réponse + barres/plus rapide (ou cible + plus proches) au reveal.
- `server.js` — tout l'état EN COURS du jeu (en mémoire, objet `game`) + événements Socket.IO. Seules les parties explicitement sauvegardées sont persistées (via `storage.js`) ; l'état vif reste en mémoire.
  - Import des questions : `ingest(wb)` partagé entre `/admin/upload` (xlsx) et `/admin/import-gsheet` (lecture CSV publique du sheet, sans clé API). C'est lui qui détecte les deux formats et capte les prénoms de l'en-tête au format TRUE/FALSE.
  - Joueurs identifiés par un **token** stocké dans le `localStorage` du téléphone → survivent au verrouillage d'écran, refresh et coupures 4G (reconnexion automatique avec le score conservé).
  - La réponse Excel est stockée **brute** (`answerRaw`) et résolue à la volée (`resolveAnswer`) : on peut changer les prénoms des mariés après l'import sans casser la correspondance.
  - La bonne réponse n'est **jamais envoyée aux joueurs** avant la phase `reveal`.
  - Phases : `lobby → question → reveal → (question…) → ended`.
  - **Identité des questions par `id` stable**, pas par index de tableau (sinon une suppression décalerait le suivi des questions jouées et des points à annuler). `game.results` (id → réponses figées + bonne réponse) mémorise chaque question révélée pour permettre l'invalidation (réversion exacte des points et du temps). `game.current` = id de la question active/affichée. Les questions jouées se déduisent des clés de `game.results`, pas de l'ordre.
  - `resetProgress()` remet la progression à zéro (questions jouées, question active) sans toucher aux scores ; utilisé par l'import, `admin:reset` (qui en plus remet les scores à 0) et `admin:clearQuestions`.
- `public/index.html` — page joueur (mobile), autonome (CSS/JS inline).
- `public/admin.html` — régie, autonome. Mot de passe gardé en `sessionStorage`, re-login auto à la reconnexion.
- `public/classement.html` — leaderboard temps réel (room Socket.IO `board`, événement `board:join`), animation FLIP sur les changements de position, limité aux 15 premiers à l'écran.
- **Photos des joueurs (avatars)** : prises à l'inscription (optionnel) ou via « changer ma photo » sur l'écran d'attente, compressées côté client en vignette carrée 160px JPEG (`compress()` dans `index.html`). Affichées en rond à côté du nom (classement projeté, régie, écran de résultats), avec l'initiale du prénom en repli si pas de photo.
  - **Jamais dans les broadcasts d'état** (sinon toutes les photos repartiraient à chaque réponse) : associées par un **id public `pid`** (le `token` reste secret) et diffusées une seule fois via l'événement `avatarUpdate` ; la map `pid → image` est envoyée aux nouveaux arrivants dans l'accusé de `join` / `board:join` / `admin:login`. Garde-fou serveur : refus si non `data:image/` ou > 200 Ko.
- **Habillage / thèmes** : deux thèmes clairs, `doré` (par défaut) et `forestier` (vert forêt + doré + feuillages aquarelle, repris du plan de table). Le thème actif vit dans `game.theme` (hors progression : ni `resetProgress` ni l'import ne le touchent), l'admin le change dans le panneau **Réglages** → événement `admin:setTheme` → diffusion `io.emit('theme:set', …)` à **tous** les écrans (joueurs, classement, régie, affiche). Le serveur émet aussi `theme:set` **dès la connexion** de chaque socket (`io.on('connection')`), pour que TOUTE page affiche le bon habillage sans attendre — notamment l'écran d'accueil du joueur **avant** qu'il saisisse son prénom (sinon il resterait doré pendant que le classement projeté est forestier → incohérence).
  - Côté page : chaque page définit ses deux palettes en CSS (`:root` = doré, `:root[data-theme="forest"]` = forestier, mêmes noms de variables `--paper/--ink/--gold/…`), un `applyTheme(t)` pose `data-theme` sur `<html>` et met en cache dans `localStorage['jm_theme']` ; un petit script en `<head>` réapplique ce cache **avant le premier rendu** (anti-flash). Ajouter une variable de thème → l'ajouter dans les deux blocs `:root` de **chaque** page concernée.
  - **Homogénéité** : toute couleur d'ambiance qui était en dur (halo champagne `--halo-1/2`, surbrillances `--wash`, halo du podium `--glow`) est passée en variable de thème pour que forestier ne garde aucune teinte dorée résiduelle. ⚠️ `--ink` (texte brun en forestier) ne doit **jamais** servir de **fond** de bouton/surface : sinon les boutons (« Entrer dans le jeu », choix de vote, blocs du podium) deviennent bruns et boueux. Les surfaces sombres remplies utilisent `--surface-dark` (vert forêt en forestier, `#2c3526` en doré). Si tu ajoutes un élément décoratif coloré, passe par une variable définie dans les **deux** blocs `:root`, jamais un `rgba(...)`/`var(--ink)` en dur.
  - **Feuillages** : 4 PNG aquarelle **à fond transparent** dans `public/deco/leaf-{tl,tr,bl,br}.png`, posés en `.leaf-deco` d'angle (`position:fixed; z-index:0`), **affichés uniquement en thème forestier** (`display:none` sinon). Présents sur index/classement/admin en `position:fixed` ; sur l'affiche A4 ils sont en `position:absolute` **dans la feuille** (`.sheet` en `position:relative; overflow:hidden`) pour s'imprimer proprement dans la page. ⚠️ Pas de `mix-blend-mode` ni de `z-index` négatif : la combinaison `position:fixed` + `mix-blend-mode:multiply` + `z-index:-1` fait **disparaître les feuilles sur iOS Safari** (elles s'affichaient pourtant sur desktop/Android). Le fond blanc a donc été détouré en amont (transparence alpha) et les feuilles passent derrière le contenu via `z-index:0` (tout le contenu des pages est déjà en `z-index ≥ 1`).
  - **Cache navigateur (piège au redéploiement)** : les pages sont autonomes (CSS/JS inline), donc un navigateur qui garde en cache l'ancien `.html` continue d'exécuter l'ancien code après un redéploiement — symptômes trompeurs (thème pas appliqué partout, questions importées qui n'apparaissent qu'après refresh). `server.js` sert donc le HTML avec `Cache-Control: no-cache` (revalidation à chaque chargement) ; les PNG des feuilles gardent le cache par défaut. Après un tout premier passage sur une page déjà visitée avant ce correctif, un `Ctrl+Shift+R` unique peut rester nécessaire.
  - **État en mémoire (Render gratuit)** : `game.theme` (comme les scores) est en RAM et repart à `gold` à chaque veille/redémarrage. À la connexion admin, le dernier thème choisi (mémorisé dans `localStorage['jm_theme']`) est réémis au serveur (`admin:setTheme`) : ouvrir `/admin` suffit à restaurer le thème sur tous les écrans.
- `test-e2e.js` — test complet du flux (`npm install --no-save socket.io-client` puis `node test-e2e.js` avec le serveur démarré).
- Si on ajoute un événement admin avec accusé de réception, penser à appeler le callback côté serveur (sinon les `await emit(...)` du test bloquent).
