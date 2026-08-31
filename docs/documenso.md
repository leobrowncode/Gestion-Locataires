# Signature électronique — Documenso

Envoi du **bail** et/ou de l'**état des lieux** en signature électronique, suivi jusqu'à la
finalisation, puis archivage des PDF signés dans Drive. Tout tient dans Apps Script : aucun
serveur, aucun webhook public.

| Fichier | Rôle |
|---|---|
| `Documenso.gs` | `DocumensoClient` — couche HTTP unique (multipart, reprises, erreurs typées) |
| `Signature.gs` | Métier : signataires, placeholders, idempotence, suivi, archivage, menus, wrappers web |
| `Mobile.html` | Carte « Signature électronique » de la web app |

---

## 1. Mise en place (une seule fois)

### 1.1 Compte et token Documenso

1. Créer un compte sur [documenso.com](https://documenso.com) (le plan gratuit suffit :
   **5 documents par mois**, cf. §9).
2. Dans l'application : **Settings ▸ API Tokens ▸ New token**, nommer le token
   (`Gestion Locataires`) et choisir sa durée de validité.
3. Copier le token immédiatement — il commence par `api_` et **ne sera plus affiché ensuite**.

### 1.2 Enregistrer le token dans Apps Script

> Le token ne doit **jamais** être écrit dans une cellule du Sheet, dans un fichier du dépôt,
> ni apparaître dans les logs. Il vit exclusivement dans les propriétés de script.

1. Ouvrir le Sheet ▸ **Extensions ▸ Apps Script**
2. **⚙️ Paramètres du projet ▸ Propriétés du script ▸ Ajouter une propriété**
3. Propriété : `DOCUMENSO_API_TOKEN` — Valeur : le token copié à l'étape précédente

### 1.3 Propriétés de script optionnelles

| Propriété | Défaut | Usage |
|---|---|---|
| `DOCUMENSO_API_TOKEN` | — | **Obligatoire.** Token API. |
| `DOCUMENSO_BASE_URL` | `https://app.documenso.com/api/v2` | Instance auto-hébergée. |
| `DOCUMENSO_AUTH_SCHEME` | `raw` | `bearer` pour préfixer l'en-tête par `Bearer `. |
| `DOCUMENSO_DRY_RUN` | *(vide)* | `true` force le mode test sur **toutes** les demandes. |
| `DOCUMENSO_TIMEOUT_MS` | `60000` | Budget total d'un appel, reprises incluses. |
| `DOCUMENSO_MAX_TENTATIVES` | `3` | 1 appel + 2 reprises, sur erreurs transitoires uniquement. |
| `DOCUMENSO_ENDPOINT_<CLÉ>` | — | Surcharge d'un chemin d'API (cf. §10). |

### 1.4 Clés à ajouter dans l'onglet `Config`

| Clé | Valeur | Obligatoire |
|---|---|---|
| `Bailleur_Email` | Adresse du bailleur (destinataire de la signature `r1`) | Oui, si le bailleur signe |
| `SIGNATURE_BAILLEUR` | `OUI` (défaut) ou `NON` — le bailleur signe-t-il électroniquement ? | Non |
| `SIGNATURE_ORDRE_SEQUENTIEL` | `OUI` = chacun son tour (r1 puis r2…) ; `NON`/vide = tous en même temps | Non |

### 1.5 Colonnes facultatives de l'onglet `Locataires`

Aucune n'est obligatoire — le code les écrit uniquement si elles existent.

| Colonne | Contenu |
|---|---|
| `Cosignataires` | Colocataires devant signer le même document. Format `NOM Prénom <email>`, séparés par `;` ou retour à la ligne. L'ordre des rangs est déterminé par tri sur l'email, indépendamment de la saisie. |
| `Signature_Statut` | Miroir du statut de la dernière demande (lecture seule). |
| `Signature_Envelope_ID` | Miroir de l'identifiant d'enveloppe (lecture seule). |

### 1.6 Déclencheur de suivi automatique

Dans l'éditeur Apps Script, exécuter **une fois** la fonction `installerTriggerSignatures`.
Elle installe un déclencheur **horaire** (`triggerSuiviSignatures`) qui :

- interroge Documenso pour toutes les demandes non finalisées ;
- télécharge et archive les PDF signés dès qu'une enveloppe passe à `COMPLETED` ;
- cesse tout suivi sur les statuts terminaux (`SIGNE`, `REFUSE`, `ANNULE`).

Un bouton **🔄 Actualiser les statuts** (web app) et une entrée de menu font la même chose à la
demande, pour le diagnostic.

---

## 2. Migration des templates Google Docs

> ⚠️ Les modèles de bail et d'état des lieux vivent **uniquement sur Google Drive** (le dépôt ne
> versionne aucun `.docx`). **Ils n'ont donc pas été modifiés par cette intégration** : les
> modifications ci-dessous sont à faire à la main, une seule fois, dans chaque modèle.

### 2.1 Principe : marqueur interne, placeholders générés

Le projet **ne stocke pas** de placeholders `{{signature, r1}}` dans les modèles. Il y stocke un
**marqueur interne** :

```
[[SIGNATURES_DOCUMENSO]]
```

À chaque génération, le code remplace ce marqueur par le bloc de placeholders correspondant au
**nombre réel de signataires**, puis supprime le marqueur. Un bail signé par le bailleur et un
locataire produit 2 blocs ; ajouter un colocataire en produit 3 — sans toucher au modèle.

### 2.2 Où placer le marqueur

**Modèle de bail (`ID_BAIL_TEMPLATE`)** — dans la section de signature, après *« Fait à …, le … »*
et **après** la liste des pièces annexées (§13), **avant** la notice d'information officielle (§14) :

```
Fait à {{Bailleur_Ville}}, le …
En deux exemplaires originaux.

[[SIGNATURES_DOCUMENSO]]
```

Supprimer les lignes de signature manuscrite qui s'y trouvent (« Le Bailleur » / « Le Locataire »
et leurs espaces réservés) : le bloc généré porte déjà ces libellés.

**Modèle d'état des lieux (`ID_EDL_TEMPLATE`)** — dans la section **5. Signatures**, dans la partie
**Entrée** :

```
5. Signatures

Entrée
[[SIGNATURES_DOCUMENSO]]

Sortie
Le Bailleur :                     Le Locataire :
```

Laisser la partie « Sortie » telle quelle : elle sera signée lors de l'état des lieux de sortie et
ne contient aucun placeholder.

### 2.3 Contraintes impératives

| Règle | Pourquoi |
|---|---|
| Le marqueur est un **paragraphe autonome**, seul sur sa ligne | Le code insère le bloc à cet endroit puis supprime le paragraphe |
| **Jamais dans un tableau**, ni dans une liste à puces | La suppression emporterait le tableau entier. Le code refuse ce cas avec un message explicite, dès l'écran de récapitulatif |
| Écrit **d'un seul tenant**, sans mise en forme partielle | Google Docs découpe un texte partiellement stylé en plusieurs éléments : `[[SIGNA` + `TURES_DOCUMENSO]]` ne serait pas reconnu |
| Une seule occurrence par modèle | Seule la première est traitée |

Le bloc généré est forcé en **Arial 11 noir** : l'analyseur PDF de Documenso lit mal les polices
exotiques, et un placeholder mal rendu n'est pas détecté.

### 2.4 Ce que produit le code

Pour un bail avec bailleur + locataire, le marqueur est remplacé par :

```
Le bailleur — Jean MARTIN
Nom : {{name, r1}}
Signature : {{signature, r1}}
Date : {{date, r1}}

Le locataire — DUPONT Marie
Nom : {{name, r2}}
Signature : {{signature, r2}}
Date : {{date, r2}}
```

Un placeholder par ligne : aucune ligne n'est assez longue pour être renvoyée à la ligne, donc
aucun placeholder ne peut être coupé dans le PDF. Documenso masque ces balises après les avoir
transformées en champs de signature.

### 2.5 Convention des rangs

| `SIGNATURE_BAILLEUR` | r1 | r2 | r3, r4… |
|---|---|---|---|
| `OUI` (défaut) | Bailleur | Locataire | Colocataires (`Cosignataires`, triés par email) |
| `NON` | Locataire | Colocataires | — |

L'ordre du tableau de destinataires envoyé à l'API **est** l'ordre des rangs : `r1` désigne
toujours le premier destinataire créé.

### 2.6 Balises de sortie de l'EDL

Le modèle d'état des lieux contient des balises écrites en blanc (`{{Compteur_Eau_Sortie}}`,
`{{Locataire_Nouvelle_Adresse}}`…) qui restent dans le document tant que le locataire n'est pas
parti. Invisibles à l'impression, elles seraient malgré tout analysées par Documenso.

**Rien à faire** : le code les retire automatiquement de la copie destinée à la signature — jamais
du modèle. Elles sont listées dans le récapitulatif du mode test.

---

## 3. Tester sans rien envoyer (DRY_RUN)

Avant le premier envoi réel, faire au moins un essai en mode test. Il :

- génère les PDF (suffixés `_DRYRUN`, rangés dans `LOCATAIRES/<Nom>/Signature/`) ;
- affiche les signataires résolus et les placeholders réellement détectés ;
- construit le payload complet (emails masqués) ;
- **ne crée aucune enveloppe, n'envoie aucun email, n'écrit rien dans l'onglet `Signatures`**.

Trois façons de le déclencher :

| Où | Comment |
|---|---|
| Web app | Cocher **Mode test (DRY_RUN)** avant de vérifier |
| Menu Sheet | Saisir `1 test`, `2 test` ou `3 test` dans la boîte de dialogue |
| Global | Propriété de script `DOCUMENSO_DRY_RUN = true` (toutes les demandes) |

Le mode test fonctionne **sans token** : c'est la façon de valider la migration des modèles avant
même d'avoir créé le compte Documenso.

---

## 4. Envoyer en signature

### Depuis la web app (parcours recommandé)

1. Carte **Signature électronique** ▸ choisir le locataire
2. Choisir : **Bail** / **État des lieux** / **Bail + état des lieux**
3. **🔍 Vérifier et récapituler** → affiche logement, documents, signataires, emails, ordre de
   signature, identifiant externe et historique
4. **✍️ Confirmer l'envoi** → seconde confirmation, puis envoi
5. Le résultat affiche l'identifiant d'enveloppe et le lien de suivi

Le bouton d'envoi reste **désactivé** tant que la vérification n'a pas été passée sans blocage.
Changer de locataire, de jeu de documents ou de mode invalide le récapitulatif.

### Depuis le menu du Sheet

**🏠 Gestion Locataire ▸ ✍️ Envoyer en signature (Documenso)** sur la ligne du locataire :
saisir `1`, `2` ou `3` → récapitulatif → confirmation.

### Ce qui bloque l'envoi

| Blocage | Correction |
|---|---|
| `ID_PDF_BAIL` / `ID_PDF_EDL` vide | Générer d'abord le document (menu ou web app) |
| Modèle sans marqueur, ou marqueur dans un tableau | Cf. §2 |
| Email manquant ou invalide (locataire, bailleur, colocataire) | Corriger le Sheet / `Bailleur_Email` |
| Deux signataires avec la même adresse | Corriger `Cosignataires` |
| Demande identique déjà en attente, signée, ou en erreur avec enveloppe créée | Attendre, ou annuler la demande existante |
| `DOCUMENSO_API_TOKEN` absent | Cf. §1.2 (ou passer en mode test) |
| Placeholders incohérents après génération | Message détaillant le problème ; aucune enveloppe n'est créée |

### Bail + état des lieux

Les deux PDF partent dans **une seule enveloppe Documenso** : un seul email par signataire, une
seule signature à poser, **un seul document décompté** du quota mensuel.

---

## 5. Idempotence — pas de double envoi

Chaque demande porte un identifiant externe déterministe :

```
GL-ch2-dupont-marie-BAIL_EDL-e03a8053
└┬┘ └──────┬───────┘ └───┬───┘ └──┬───┘
 │      locationId   documentSet  documentRevision (empreinte du contenu)
 │
 └─ préfixe projet
```

`documentRevision` est l'empreinte MD5 des données qui composent les documents : identité et dates
du locataire, chambre, montants, compteurs, identité du bailleur, adresse du logement, emails des
signataires dans l'ordre des rangs.

Conséquences :

- **Même contenu → même identifiant** : la deuxième demande est refusée avant tout appel réseau.
- **Une donnée change → nouvel identifiant** : la demande est légitime et passe.
- Après une annulation ou un refus, une nouvelle demande reprend la même base avec un suffixe
  `-t2`, `-t3`… (unique côté API, traçable côté Sheet).

---

## 6. Suivi — onglet `Signatures`

Créé automatiquement à la première demande. Une ligne par demande.

| Colonne | Contenu |
|---|---|
| `Date_Creation` | Horodatage de la demande |
| `Ligne` / `Locataire_Nom` / `Chambre` | Rattachement au locataire |
| `Documents` | `BAIL`, `EDL` ou `BAIL+EDL` |
| `External_ID` | Identifiant externe déterministe (§5) |
| `Envelope_ID` | Identifiant Documenso |
| `Statut` | Statut métier (ci-dessous) |
| `Demande_Le` / `Termine_Le` | Envoi / finalisation |
| `Signataires` | `r1=…  ; r2=…` |
| `Fichiers_Signes` | Noms des PDF archivés |
| `Derniere_Erreur` | Dernier échec (emails masqués, jamais de token) |
| `Lien` | Lien de suivi Documenso |

### Statuts

```
NON_ENVOYE → PREPARATION → EN_ATTENTE_SIGNATURE → PARTIELLEMENT_SIGNE → SIGNE
                     │                    │
                     └──→ ERREUR          └──→ REFUSE / ANNULE
```

`SIGNE`, `REFUSE` et `ANNULE` sont **terminaux** : ces demandes ne sont plus interrogées.

---

## 7. Archivage

Dès qu'une enveloppe est finalisée, tout est déposé dans
`LOCATAIRES/<Locataire_Nom>/Signature/`, avec des noms déterministes :

```
2026-08-31_Bail_DUPONT_Original.pdf                  ← PDF envoyé à la signature (conservé)
2026-08-31_Etat-des-lieux-entree_DUPONT_Original.pdf
2026-08-31_Bail_DUPONT_Signe.pdf                     ← version signée
2026-08-31_Etat-des-lieux-entree_DUPONT_Signe.pdf
2026-08-31_Certificat-signature_DUPONT.pdf           ← certificat de signature
2026-08-31_Journal-signature_DUPONT.pdf              ← piste d'audit
```

- Les **Google Docs modèles ne sont jamais modifiés** ; les copies de travail sont supprimées après
  export.
- Les PDF **originaux** ayant servi à la demande sont conservés à côté des versions signées.
- Si le certificat ou le journal n'est pas récupérable, les documents signés sont **quand même**
  archivés et le statut passe à `SIGNE` ; l'avertissement est consigné dans `Derniere_Erreur`.
- Chaque partie reçoit par ailleurs sa copie **directement de Documenso** par email à la
  finalisation, et peut la retélécharger depuis son espace Documenso.

---

## 8. Annuler, relancer, récupérer

| Besoin | Action |
|---|---|
| Annuler une demande en cours | Menu **🚫 Annuler une demande de signature** → liste numérotée → confirmation |
| Forcer une actualisation | **🔄 Actualiser les statuts** (menu ou web app) |
| Relancer après annulation/refus | Refaire un envoi : l'identifiant externe reçoit un suffixe `-tN` |
| Récupérer les PDF signés | Ils sont déjà dans Drive (§7) ; sinon `🔄 Actualiser les statuts` relance le téléchargement |
| Consulter l'historique d'un locataire | Onglet `Signatures`, ou `webGetSignaturesLocataire(row)` |

Une demande en `ERREUR` **avec** un `Envelope_ID` bloque tout nouvel envoi identique : l'enveloppe
existe côté Documenso, il faut l'annuler d'abord. C'est le seul garde-fou contre le doublon dans ce
cas ambigu, et il est volontairement strict.

---

## 9. Limite gratuite : 5 documents par mois

Le plan gratuit Documenso plafonne à **5 documents par mois**. Avec 3 chambres, le volume attendu
(1 à 5 demandes par mois) tient, à condition de :

- **regrouper bail + EDL dans une seule enveloppe** (choix « Bail + état des lieux ») — cela ne
  consomme qu'un document, là où deux envois séparés en consommeraient deux ;
- utiliser le **mode test** pour les essais : il ne consomme rien.

Quand le quota est atteint, l'API répond une erreur que le code identifie comme telle :

> Quota Documenso atteint (HTTP 403). Le plan gratuit est limité à 5 documents par mois. Réessayez
> au prochain cycle ou passez à un plan supérieur. Aucune enveloppe n'a été créée.

Aucune enveloppe n'ayant été créée, il est sûr de relancer le mois suivant : l'identifiant externe
est inchangé, la demande repart à l'identique.

---

## 10. Endpoints de l'API — état de vérification

L'environnement de développement de ce dépôt **n'a pas accès** à `docs.documenso.com`,
`app.documenso.com` ni `openapi.documenso.com` (bloqués par la politique de sortie réseau). Les
chemins ont donc été établis à partir de la documentation publique telle qu'indexée, pas contre
l'OpenAPI officielle.

| Clé | Chemin | État |
|---|---|---|
| `envelopeCreate` | `POST /envelope/create` (multipart) | Concordant sur plusieurs sources |
| `envelopeDistribute` | `POST /envelope/distribute` | Concordant |
| `envelopeGet` | `GET /envelope/{envelopeId}` | Concordant |
| `itemDownload` | `GET /envelope/item/{envelopeItemId}/download` | Concordant |
| `envelopeDelete` | `POST /envelope/delete` | **À confirmer** |
| `certificateDownload` | `GET /envelope/{envelopeId}/certificate/download` | **À confirmer** |
| `auditLogDownload` | `GET /envelope/{envelopeId}/audit-log/download` | **À confirmer** |

Aucun code n'est à modifier pour corriger un chemin : ajouter une propriété de script
`DOCUMENSO_ENDPOINT_<CLÉ EN MAJUSCULES>`, par exemple

```
DOCUMENSO_ENDPOINT_ENVELOPEDELETE = /envelope/cancel
```

Les réponses sont lues de façon tolérante (`id`, `envelopeId`, `secondaryId`, `envelope.id`…), et
le téléchargement accepte aussi bien un flux PDF direct qu'un JSON contenant une `downloadUrl`.

**Vérification recommandée avant le premier envoi réel** : consulter la référence OpenAPI de
Documenso et confronter les trois chemins « à confirmer ». Le certificat et le journal d'audit sont
optionnels — leur absence n'empêche ni la signature ni l'archivage des documents signés.

---

## 11. Erreurs et messages

Chaque message indique **ce qui a échoué**, **si une enveloppe a été créée**, **s'il est sûr de
recommencer**, et **l'identifiant Documenso** quand il existe.

| Situation | Comportement |
|---|---|
| Token absent | Bloqué à la préparation, avant tout appel |
| Token refusé (401/403) | `TOKEN_INVALIDE` — aucune enveloppe créée, reprise sûre |
| Quota atteint | `QUOTA` — aucune enveloppe créée, reprise sûre au prochain cycle |
| Modèle Google inaccessible | Erreur nommant la clé `Config` et l'ID fautif |
| Conversion PDF impossible | Copie de travail supprimée, aucune enveloppe créée |
| Marqueur absent / dans un tableau | Bloqué dès le récapitulatif |
| Placeholder manquant, en double, ou rang hors bornes | Bloqué après génération, avant l'appel API |
| Signataire sans champ détecté | Enveloppe créée en **brouillon**, **non distribuée** ; consigne : corriger puis annuler |
| Email invalide | Bloqué à la préparation |
| Réponse API sans identifiant | Reprise déclarée **non sûre** — vérifier dans Documenso |
| Enveloppe déjà distribuée (409) | `CONFLIT` — ne pas relancer sans vérifier le statut |
| Refus / annulation | Statut `REFUSE` / `ANNULE`, suivi arrêté |
| PDF signé indisponible | Documents manquants signalés, le reste est archivé |
| Erreur Drive à l'archivage | Statut conservé, avertissement dans `Derniere_Erreur` |
| Timeout / indisponibilité (429, 5xx, réseau) | Jusqu'à 2 reprises avec back-off, puis abandon explicite |

**Reprises** : uniquement sur erreurs transitoires (429, 5xx, réseau), dans la limite du budget
temps. Jamais après une réponse métier (4xx) — une enveloppe a pu être créée.

**Confidentialité des messages** : les adresses email sont masquées (`m***@example.com`), les corps
de réponse tronqués à 300 caractères, le token n'est jamais journalisé ni écrit dans le Sheet.

---

## 12. Tests

```bash
npm test                    # contrôle de syntaxe + 43 tests
npm run lint                # syntaxe .gs + JS des .html + recherche de secrets versionnés
npm run check               # lint puis tests
node tests/run.js signature # filtre les tests par nom
```

Aucune dépendance npm. Le harnais (`tests/harness.js`) charge les **vrais** fichiers `.gs` dans un
contexte `vm` dont les globales sont des stubs Apps Script en mémoire (Sheets, Drive, Docs,
UrlFetch, Properties). **L'API Documenso est intégralement mockée : aucun test ne peut déclencher
une vraie demande de signature.**

Couverture : sélection Bail / EDL / les deux, un locataire, plusieurs colocataires, bailleur
signataire ou non, marqueur absent, marqueur dans un tableau, placeholders manquants / en double /
hors bornes, emails invalides, doublons, erreur avant création, erreur après création avant
distribution, champ non détecté, quota, token refusé, reprise transitoire, finalisation et
archivage, certificat indisponible, refus, annulation, DRY_RUN, et non-régression de
`generateLeaseDoc` / `generateEDL`.
