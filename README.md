# Presso Center : réservations et gestion

Application web de Presso Center, l'activité de récupération sportive mobile (pressothérapie) à Tours. Elle reprend les chiffres du business plan Adie de novembre 2026.

- **`https://pressocenter.fr/`** (`index.html`) : page d'accueil. Présentation, formules et forfaits clubs lus en direct dans la base, prochain créneau libre, contact.
- **`https://pressocenter.fr/reserver.html`** : page où les clients réservent. Formules et tarifs, créneaux libres selon les bottes disponibles, questionnaire de santé, autorisation parentale, ajout à l'agenda, message WhatsApp à Presso Center. Les clubs y demandent aussi un test pilote. Un lien `reserver.html?formule=plus` présélectionne une formule.
- **`https://pressocenter.fr/gestion.html`** : espace de gestion, réservé au gérant.
  - **Accueil** : chiffre d'affaires comparé au prévisionnel, heures de la semaine sur le plafond de 16 h, liste « À faire » (demandes, séances à clôturer, paiements, stock, contrôle du matériel, mensualité Adie, seuil de TVA).
  - **Disponibilités** : bouton « Disponibilité » de l'agenda pour ouvrir une plage, un jour précis ou chaque semaine. Les clients ne réservent que sur ces plages.
  - **Agenda** : semaine sur ordinateur, jour par jour sur téléphone ; séances, domicile, créneaux clubs, événements, indisponibilités ; confirmation et rappel par WhatsApp ; clôture d'une séance (passages, paiement, carte 10 séances).
  - **Clients** : fiches des sportifs (crédits, historique, santé) et suivi des clubs et partenaires, de la demande au contrat. Facturation du forfait mensuel et bilan de fréquentation imprimable pour le renouvellement.
  - **Messages** : les e-mails reçus sur `contact@pressocenter.fr`, avec réponse et nouveau message envoyés au nom de cette adresse.
  - **Finances** : recettes et dépenses, « il me reste » (cotisations 16 %, charges, prêt), trésorerie et provision URSSAF, graphique comparé au prévisionnel, prêt Adie, seuil de franchise de TVA, export du livre des recettes (CSV).
  - **Matériel** : état des 5 bottes, contrôle hebdomadaire, consommables décomptés à chaque séance, rappel de la 6e botte.
  - **Réglages** : coordonnées, plages ouvertes à la réservation, tarifs, paramètres financiers, QR code pour les flyers, sauvegarde.

Le site est statique (HTML, CSS, JavaScript), sans étape de compilation. GitHub Pages le sert tel quel depuis la branche `main`, sur le domaine déclaré dans le fichier `CNAME`.

## Pages légales

- `mentions-legales.html` et `confidentialite.html`. L'identité de l'éditeur (nom, statut, SIRET, adresse, médiateur) se saisit dans Réglages → Informations légales et s'affiche automatiquement.
- Le site ne charge aucune ressource tierce : la police Inter est hébergée dans `assets/fonts/`. Aucun cookie ni outil de mesure d'audience.

## Lieu des séances

Les formules individuelles ont lieu sur place, chez Presso Center. Le site n'affiche qu'un lieu vague (`base_location`). L'adresse exacte (`reception_address`, réglage privé) n'est jamais exposée publiquement : elle est envoyée au client dans l'e-mail et le message de confirmation. La formule « À domicile » reste un déplacement chez le client.

## Deux modes

| Mode | Quand | Données |
|---|---|---|
| Démo | `assets/config.js` vide | Fictives, enregistrées dans le navigateur. Rien n'est partagé. |
| Supabase | `assets/config.js` rempli | Base partagée : les clients réservent, le gérant gère depuis son téléphone. |

## Brancher la base Supabase

La base de production est déjà branchée (`assets/config.js`). Les étapes ci-dessous servent à en installer une nouvelle.

1. Créer un projet Supabase (région européenne).
2. Dans l'éditeur SQL, exécuter `supabase/schema.sql` puis `supabase/seed.sql`.
3. Créer un code d'activation (il ne sert qu'une fois, ne pas le versionner) :
   ```sql
   insert into public.admin_codes (code)
   values (upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 16)))
   returning code;
   ```
4. Dans **Authentication → URL Configuration**, mettre l'adresse de `gestion.html` en Site URL et dans les Redirect URLs, par exemple `https://pressocenter.fr/gestion.html`. Les liens de confirmation et de mot de passe oublié y renverront.
5. Copier l'URL du projet et la clé *publishable* dans `assets/config.js`. Cette clé est publique par conception : la sécurité repose sur les règles RLS.
6. Créer le compte du gérant dans **Authentication → Users → Add user → Create new user**, avec « Auto Confirm User » coché. Le gérant ouvre ensuite `gestion.html`, se connecte et saisit le code d'activation.

Le bouton « Créer mon compte » de `gestion.html` fonctionne aussi, mais il dépend de l'e-mail de confirmation. Le service d'e-mail intégré de Supabase est très limité : pour s'en servir en production (confirmation, mot de passe oublié), brancher un SMTP dans **Authentication → Emails**.

## E-mails (Resend)

Tout le courrier du domaine passe par Resend.

- **Réception** : un message envoyé à une adresse `@pressocenter.fr` (par exemple `contact@pressocenter.fr`) arrive chez Resend, qui prévient la fonction `mail`. Si le compte Resend reçoit aussi le courrier d'autres domaines, la fonction les ignore : elle ne traite que les messages adressés au domaine de `MAIL_FROM`. Celle-ci l'enregistre dans la table `messages` (écran Messages de l'espace de gestion, en texte seul) et en envoie une copie à la boîte du gérant, pièces jointes comprises.
- **Envoi depuis l'application** : une réponse ou un nouveau message part au nom de `contact@pressocenter.fr` par la route `/send` de la fonction, qui vérifie que l'appel vient du compte gérant.
- **Notifications** : à chaque réservation en ligne, le gérant reçoit une alerte et le client un accusé de réception. Quand la demande passe à « confirmée », le client reçoit la confirmation. Une demande de test pilote déclenche aussi une alerte. Le client ne reçoit rien s'il n'a pas indiqué d'e-mail.

- **Modèles** : la fenêtre « Nouveau message » propose une liste « Modèle » (sportifs, clubs et coachs). Les prix viennent des réglages ; ce qui reste à préciser est entre crochets et l'envoi est bloqué tant qu'un crochet subsiste.

Fonctionnement : les déclencheurs de `supabase/mail.sql` appellent la fonction Edge `supabase/functions/mail` (routes `/notify`, `/inbound` et `/send`). La table de la messagerie est créée par `supabase/messages.sql`. L'appel est asynchrone : une erreur d'e-mail ne bloque jamais une réservation.

Réglages, hors du dépôt :

| Où | Nom | Rôle |
|---|---|---|
| Secrets de la fonction | `RESEND_API_KEY` | clé Resend (lecture des e-mails reçus et envoi) |
| Secrets de la fonction | `RESEND_WEBHOOK_SECRET` | vérifie la signature des appels de Resend |
| Secrets de la fonction | `HOOK_SECRET` | secret partagé avec la base |
| Secrets de la fonction | `NOTIFY_TO` | boîte qui reçoit les alertes et les transferts |
| Secrets de la fonction | `MAIL_FROM`, `SITE_URL` | expéditeur et adresse du site |
| Secrets de la fonction | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_JWK` | clés des notifications push (la publique est aussi dans `assets/config.js`) |
| Supabase Vault | `presso_mail_url`, `presso_hook_secret` | adresse de la fonction et secret partagé |

DNS : le domaine doit être vérifié chez Resend (DKIM, SPF sur `send`, MX de réception à la racine). Les lignes exactes sont dans Resend → Domains.

Pour diagnostiquer : `select * from net._http_response order by id desc limit 5;` montre les dernières réponses de la fonction.

## Newsletter

- **Abonnés** : table `subscribers` (`supabase/newsletter.sql`). On s'inscrit sur la page d'accueil ou en cochant la case à la réservation ; le gérant peut aussi ajouter une personne qui a donné son accord. Rien n'est envoyé au moment de l'inscription.
- **Envoi** : onglet Messages → Newsletter. « M'envoyer un test » n'écrit qu'au gérant ; l'envoi à la liste passe par la route `/newsletter` de la fonction, réservée au compte gérant, par lots de 100. `{prénom}` est remplacé par le prénom de l'abonné.
- **Désinscription** : chaque newsletter contient un lien personnel vers `desinscription.html` (un clic de confirmation sur la page) et l'en-tête `List-Unsubscribe` pour le bouton des messageries (route `/unsubscribe`). Une personne désinscrite ne peut pas être réajoutée à la main.

## Notifications sur le téléphone

L'espace de gestion est installable (`manifest.webmanifest`) et peut envoyer des notifications push : nouvelle demande de réservation, demande de test pilote, message reçu.

- **Activation** : Réglages → Notifications, une fois par appareil. Sur iPhone et iPad, il faut d'abord ajouter l'application à l'écran d'accueil (iOS 16.4 ou plus récent) et l'ouvrir depuis l'icône.
- **Fonctionnement** : `sw.js` reçoit et affiche les notifications (il ne met rien en cache). Chaque appareil enregistre son abonnement dans `push_subscriptions` (`supabase/push.sql`) ; la fonction `mail` chiffre et signe les envois elle-même (Web Push, clés VAPID). Un abonnement expiré est supprimé automatiquement.
- **Changer les clés** : générer une nouvelle paire, mettre à jour les deux secrets et `vapidPublicKey` ; chaque appareil doit alors désactiver puis réactiver les notifications.

## Sécurité

- Toutes les tables sont protégées par RLS. Seul un compte inscrit dans `admins` lit et écrit.
- Un visiteur n'accède qu'à six fonctions : `public_info`, `public_busy`, `book`, `club_request`, `newsletter_subscribe` et `newsletter_unsubscribe`. Les créneaux occupés sont renvoyés sans nom ni téléphone.
- `book` revérifie tout côté serveur : formule, horaires (heure de Paris), délai minimum, bottes disponibles, chevauchements, questionnaire de santé, autorisation parentale, longueur des champs et limite de demandes en attente par numéro. Elle calcule aussi le prix.

## Fichiers

```
CNAME               domaine servi par GitHub Pages
index.html          page d'accueil
mentions-legales.html, confidentialite.html   pages légales
desinscription.html désinscription de la newsletter
manifest.webmanifest, sw.js   application installable et notifications
reserver.html       page de réservation
404.html            page introuvable
gestion.html        espace de gestion
assets/
  config.js         connexion Supabase (vide = démo)
  core.js           catalogue, règles de créneaux, stockage local ou Supabase
  landing.js        page d'accueil (tarifs en direct, prochain créneau)
  landing.css       styles de la page d'accueil
  book.js           page de réservation
  admin.js          espace de gestion
  unsub.js          page de désinscription
  icons/            icônes de l'application
  styles.css        styles (clair et sombre)
  vendor/           supabase-js 2.45.4 et qrcode-generator 1.4.4 (licence MIT)
supabase/
  schema.sql        tables, RLS, fonctions
  mail.sql          déclencheurs d'e-mails
  messages.sql      table de la messagerie
  newsletter.sql    abonnés à la newsletter, inscription et désinscription
  push.sql          appareils abonnés aux notifications
  functions/mail/   fonction Edge : e-mails, newsletter, notifications push
  seed.sql          réglages et tarifs du plan, bottes, consommables, partenaires
```

Les tarifs, horaires et paramètres financiers par défaut sont dans `PC.DEFAULT_SETTINGS` (`assets/core.js`). `seed.sql` en est généré. Une fois en ligne, tout se modifie depuis l'écran Réglages.
