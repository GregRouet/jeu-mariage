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
5. Chaque téléphone affiche bonne/mauvaise réponse, la répartition des votes et le classement.
6. Après la dernière question : **« Afficher les résultats finaux »** → podium sur tous les téléphones.

**Score** : 1 point par bonne réponse. En cas d'égalité, le plus rapide (temps de réponse cumulé) est devant.

## Format des questions (Excel ou Google Sheets)

Deux formats acceptés, détectés automatiquement (première feuille, une question par ligne) :

**Format 1 — « Question | Réponse »** (voir `questions-exemple.xlsx`) :

| Colonne A (question) | Colonne B (réponse) |
|---|---|
| Qui est le plus gourmand ? | Camille |
| Qui est le plus têtu ? | les deux |
| Qui chante le plus faux sous la douche ? | *(vide → validation en direct par l'admin)* |

- Colonne B : le **prénom exact** d'un des mariés (accents/majuscules ignorés), ou `les deux`, ou **vide**.
- Une ligne d'en-tête commençant par « Question » est ignorée.

**Format 2 — une colonne TRUE/FALSE par marié·e** :

| Caractéristique | Clémentine | Simon |
|---|---|---|
| Je suis fan des légos | FALSE | TRUE |
| Je suis petit(e) et mignon(ne) | TRUE | TRUE |

- TRUE/FALSE (ou vrai/faux, oui/non) ; TRUE dans les deux colonnes → « les deux » ; FALSE partout → validation en direct.
- Les prénoms de la ligne d'en-tête sont **automatiquement utilisés comme prénoms des mariés**.

L'import peut se refaire à tout moment (il remet la partie au début).

On peut aussi **ajouter une question à la main** (formulaire sous la liste, ajoutée en fin de liste) ou **en supprimer** (✕ au survol — uniquement les questions pas encore jouées). Attention : ces modifications manuelles sont écrasées par un nouvel import.

### Import depuis Google Sheets

Dans la régie, colle le lien du document (`https://docs.google.com/spreadsheets/d/…`) et clique « Importer ». Condition : la feuille doit être partagée **« Tous les utilisateurs disposant du lien » (Lecteur)**. L'onglet importé est celui du `gid` présent dans le lien (premier onglet par défaut).

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

- `server.js` — tout l'état du jeu (en mémoire, objet `game`) + événements Socket.IO.
  - Import des questions : `ingest(wb)` partagé entre `/admin/upload` (xlsx) et `/admin/import-gsheet` (lecture CSV publique du sheet, sans clé API). C'est lui qui détecte les deux formats et capte les prénoms de l'en-tête au format TRUE/FALSE.
  - Joueurs identifiés par un **token** stocké dans le `localStorage` du téléphone → survivent au verrouillage d'écran, refresh et coupures 4G (reconnexion automatique avec le score conservé).
  - La réponse Excel est stockée **brute** (`answerRaw`) et résolue à la volée (`resolveAnswer`) : on peut changer les prénoms des mariés après l'import sans casser la correspondance.
  - La bonne réponse n'est **jamais envoyée aux joueurs** avant la phase `reveal`.
  - Phases : `lobby → question → reveal → (question…) → ended`.
- `public/index.html` — page joueur (mobile), autonome (CSS/JS inline).
- `public/admin.html` — régie, autonome. Mot de passe gardé en `sessionStorage`, re-login auto à la reconnexion.
- `public/classement.html` — leaderboard temps réel (room Socket.IO `board`, événement `board:join`), animation FLIP sur les changements de position, limité aux 15 premiers à l'écran.
- `test-e2e.js` — test complet du flux (`npm install --no-save socket.io-client` puis `node test-e2e.js` avec le serveur démarré).
- Si on ajoute un événement admin avec accusé de réception, penser à appeler le callback côté serveur (sinon les `await emit(...)` du test bloquent).
