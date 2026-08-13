# 🏠 Gestion Locataires

Automatisation complète de la **gestion locative meublée (LMNP)** d'une colocation, avec pour seule
infrastructure un **Google Sheet** et **Google Apps Script**. Aucun serveur, aucune base de données :
le Sheet est la source de vérité, Drive stocke les documents, Gmail envoie les emails.

Le système couvre le cycle de vie complet d'un locataire — demande des pièces justificatives,
génération du bail et de l'état des lieux, envoi du dossier, quittances mensuelles, réponse au
préavis, archivage — plus un module de comptabilité des charges.

> Ce dépôt ne contient **que du code et de la documentation**. Les identités, adresses et
> identifiants Drive vivent dans l'onglet `Config` du Sheet, jamais dans le repo.

---

## Fichiers

| Fichier | Rôle |
|---|---|
| `Code.gs` | Module principal : menu, bail, état des lieux, quittances, attestation d'assurance, emails, suivi des loyers, archivage Drive |
| `Code_Compta.gs` | Comptabilité : saisie des charges, import CSV bancaire, import d'un tableau d'amortissement, bilan |
| `WebApp.gs` | Back-end de la web app mobile (point d'entrée `doGet`, wrappers `web*`) |
| `Mobile.html` | Interface mobile installable sur l'écran d'accueil (PWA) |
| `Compta_Form.html` | Dialogue « Ajouter une charge » |
| `Compta_CSV.html` | Dialogue d'import d'un relevé bancaire CSV |
| `Compta_Amort.html` | Dialogue d'import d'un tableau d'amortissement de prêt |

## Onglets du Google Sheet

| Onglet | Contenu |
|---|---|
| `Locataires` | Une ligne par locataire (identité, chambre, dates, compteurs, IDs des PDF générés) |
| `Chambres` | Une ligne par chambre : surface, loyer HC, charges, loyer CC, caution, inventaire du mobilier |
| `Config` | Paires clé/valeur : identité du bailleur, adresse du bien, IDs des templates et dossiers Drive |
| `Templates` | Emails (objet + corps HTML) avec placeholders `{{Variable}}` |
| `Suivi Loyers` | Loyers encaissés, un mois par ligne, une colonne par chambre — alimenté à chaque quittance |
| `Comptabilité` | Charges : date, catégorie, description, montant, chambre, justificatif |
| `Bilan Charges` | Synthèse recalculée à la demande : total annuel par catégorie + tableau mois × catégorie |

Les trois derniers onglets sont créés automatiquement à la première utilisation.

## Installation

1. **Projet Apps Script** — dans le Google Sheet : *Extensions ▸ Apps Script*, puis créer un fichier
   par entrée du tableau ci-dessus (`.gs` en fichiers Script, `.html` en fichiers HTML, avec
   exactement les mêmes noms : `Mobile`, `Compta_Form`, `Compta_CSV`, `Compta_Amort`).
2. **Onglet `Config`** — renseigner les clés attendues (identité du bailleur, caractéristiques du
   logement, IDs Drive des templates et dossiers). Liste complète dans
   [`CLAUDE.md` §3.3](CLAUDE.md).
3. **Templates Google Docs** — créer les modèles de bail, état des lieux, quittance et attestation
   d'assurance, avec des placeholders `{{Nom_Variable}}` ; coller leurs IDs dans `Config`.
4. **Onglet `Templates`** — créer les templates d'emails. Corps HTML prêts à l'emploi dans
   [`docs/configuration-sheet.md`](docs/configuration-sheet.md).
5. **Menu** — recharger le Sheet : le menu `🏠 Gestion Locataire` apparaît.
6. **Web app** (optionnel) — *Déployer ▸ Nouveau déploiement ▸ Application Web*, exécuter en tant
   que soi-même, accès « Moi uniquement ». Ouvrir l'URL sur mobile et l'ajouter à l'écran d'accueil.
7. **Archivage automatique** (optionnel) — exécuter une fois `installerTriggerArchivage` pour
   déplacer chaque mois les dossiers des locataires partis vers `LOCATAIRES/OLD`.

## Workflows

**Nouveau locataire** — demander les pièces justificatives ▸ générer bail + état des lieux ▸ envoyer
le dossier de location (bail, EDL et documents communs en pièces jointes) ▸ envoyer l'attestation
d'assurance. Tous les emails à fort enjeu partent en **brouillon Gmail**, jamais en envoi direct.

**Chaque mois** — à réception du virement, un bouton par colocataire dans la web app génère la
quittance, l'enregistre dans `Suivi Loyers` et l'envoie. Le premier loyer (entrée en cours de mois)
et le dernier (mois de sortie) sont proratisés automatiquement.

**Fin de location** — saisir `Date_Fin` ▸ répondre au préavis (consignes de ménage, dernier loyer,
restitution du dépôt) ▸ envoyer l'EDL de sortie au format Word ▸ générer la dernière quittance
▸ décocher `Actif` ▸ le dossier Drive est archivé au prochain passage du trigger.

## Documentation

- [`CLAUDE.md`](CLAUDE.md) — référence technique : structure des onglets, variables des templates,
  logique métier, helpers, pièges connus.
- [`docs/configuration-sheet.md`](docs/configuration-sheet.md) — configuration du Sheet : formule du
  dernier loyer, clés `Config`, corps HTML des templates d'emails, workflow de fin de location.
