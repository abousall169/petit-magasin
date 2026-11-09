# Caisse – magasin d'alimentation

Application de vente locale : le PC du magasin fait tourner le serveur, les employés vendent depuis leur téléphone ou tablette (Wi-Fi du magasin), en français ou en arabe. Montants en FCFA.

## Démarrer
1. Installer Node.js 24+.
2. Double-cliquer sur `demarrer.bat` (la 1re fois : installation + compilation).
3. La console affiche les adresses. Au **premier démarrage**, Windows demande d'autoriser le réseau : cochez **Réseaux privés**.
4. Premier compte : **Gérant, PIN 1234** → à changer tout de suite dans Réglages.

## Démarrage automatique avec Windows (recommandé pour le PC du magasin)
Double-cliquer sur **`installer-demarrage-auto.bat`** (accepter la demande d'administrateur). Il :
- crée une tâche planifiée qui lance la caisse **au démarrage du PC**, avant même l'ouverture de session (reprise automatique après une coupure de courant) ;
- relance le serveur tout seul s'il s'arrête (vérifié : redémarrage en ~7 s) ;
- ouvre les ports 3000 et 3443 dans le pare-feu **pour le réseau local uniquement** (important : un Wi-Fi classé « Public » bloque sinon les téléphones) ;
- propose d'empêcher la mise en veille du PC sur secteur (un PC en veille = caisse inaccessible).

Ensuite, plus besoin de `demarrer.bat`. Journaux : `data\logs\`. Pour tout retirer : **`desinstaller-demarrage-auto.bat`** (les données sont conservées).
Après une mise à jour du code : relancer `installer-demarrage-auto.bat` (recompile si besoin et redémarre).
Remarque : sous le compte système, une imprimante installée seulement pour *votre* utilisateur peut ne pas être vue ; dans ce cas, installez avec `powershell -File scripts\install-autostart.ps1 -Mode Logon` (démarrage à l'ouverture de session, sans droits administrateur).

## Installer sur un téléphone / une tablette (une seule fois par appareil)
La caméra (scan de codes-barres) et le mode hors-ligne exigent HTTPS. Le serveur crée sa propre autorité de certification locale ; chaque appareil doit l'installer une fois :
1. Sur l'appareil, ouvrir `http://<ip-du-pc>:3000/install` (adresse affichée dans la console) et suivre les étapes (Android / iPhone / arabe).
2. Ensuite, utiliser `https://<ip-du-pc>:3443` et « Ajouter à l'écran d'accueil ».

Conseils : réserver une **adresse IP fixe** au PC dans le routeur (sinon l'adresse peut changer ; le certificat se met à jour tout seul au redémarrage, les téléphones n'ont rien à refaire). Les fichiers sont dans `data/certs/` : **ne jamais partager `ca-key.pem`**. `NO_HTTPS=1` désactive le HTTPS ; `TLS_NAMES=nom,ip` ajoute des noms/adresses au certificat.

## Imprimante de tickets (80 mm, ESC/POS)
Le ticket est dessiné en image (français et arabe corrects) puis envoyé à l'imprimante.
- **USB** : installer l'imprimante dans Windows (pilote du fabricant ou « Generic / Text Only »), puis *Réglages → Imprimante* : la choisir, *Imprimer un ticket test*.
- **Réseau (Ethernet/Wi-Fi)** : choisir « Imprimante réseau » et saisir son IP (port 9100 par défaut).
- Option « imprimer automatiquement après chaque vente » et « couper le papier ».
- Sans imprimante configurée, le bouton utilise l'impression du navigateur.

## Reconnaissance par photo
100 % locale (aucun service externe) : le modèle DINOv2-small (24 Mo) tourne dans le navigateur du téléphone.
- **Enregistrer** : *Produits → ouvrir un produit → Photos de référence* : 3 à 5 photos du produit seul, sous des angles différents, bonne lumière (jusqu'à 12). Les produits sans photo sont signalés par `📸 0` en orange.
- **Utiliser** : à la caisse, bouton 📸 → photo de l'article → l'appli propose les 3 produits les plus proches avec un niveau de confiance ; **le caissier confirme toujours** (rien n'est ajouté automatiquement).
- Le code-barres reste plus fiable pour les produits emballés ; la photo sert surtout pour les produits sans code (fruits, légumes, pain, vrac).
- Au 1er usage, l'appareil télécharge ~50 Mo (modèle + moteur) depuis le PC du magasin, puis les garde en cache (HTTPS recommandé).
- `npm run build` prépare automatiquement le modèle (téléchargement unique, internet requis ce jour-là).

## Codes-barres et étiquettes
- **Produit sans code-barres** : dans la fiche produit, « 🏷 Générer un code » (ou, pour tous d'un coup, *Produits → 🏷 Étiquettes → Générer les codes manquants*). Le code créé est un EAN-13 interne (`20…`), unique, valide pour tous les lecteurs.
- **Imprimer** : *Produits → 🏷 Étiquettes* : cocher les produits, choisir le nombre d'étiquettes et le format de feuille A4 (3×8, 4×10, 5×13), puis « Imprimer la feuille ». Dans la fenêtre d'impression du navigateur : **échelle 100 %**, **sans en-têtes/pieds de page**. Ou « Imprimer sur l'imprimante de tickets » (une étiquette par ticket, avec coupe).
- **Formats lus et imprimés** : EAN-13, EAN-8, UPC-A et Code 128 (pour tout autre code). Un code de 12 chiffres est traité comme un EAN-13 commençant par 0 (même code).
- **Scan** : lecteur USB/Bluetooth (tape le code + Entrée dans la recherche) ou caméra. La caméra utilise le lecteur du navigateur s'il existe (Chrome Android), sinon un décodeur intégré (iPhone, ordinateurs) ; HTTPS requis.

## Développement
- `npm run dev:server` (API, port 3000) et `npm run dev:client` (interface, port 5173, proxy vers l'API).

## Données
- Base SQLite : `data/magasin.db`. Sauvegardes automatiques dans `data/backups/` (14 jours). **Copiez `data/` sur une clé USB régulièrement.**

## Structure
- `server/` API Fastify + SQLite (`node:sqlite`). `server/src/profiles/alimentation.js` = ce qui est propre au type de magasin. `tls.js` (HTTPS), `print/` (impression).
- `client/` PWA React + Tailwind (FR/AR, RTL).
