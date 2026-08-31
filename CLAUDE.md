# CLAUDE.md — Projet Gestion Locataires

## 1. Vue d'ensemble du projet

Système automatisé de **gestion locative meublée** (LMNP) pour une colocation à 3 chambres, basé sur **Google Sheets + Google Apps Script + Google Docs + Google Drive + Gmail**.

Identité du bailleur et adresse du bien sont lues dans l'onglet `Config` du Sheet — **jamais en dur dans le code ni dans cette doc** (repo public).

L'objectif est d'automatiser le cycle de vie d'un locataire :
1. Demande des pièces justificatives
2. Génération du bail (PDF) à partir d'un template Google Docs
3. Génération de l'état des lieux (entrée + sortie) à partir d'un template Google Docs
4. Envoi du dossier complet de location par email
5. Émission mensuelle des quittances de loyer (avec gestion du premier loyer proratisé)
6. Suivi des loyers perçus
7. Suivi comptable des charges (module séparé)

---

## 2. Architecture

### 2.1 Fichiers de code (Google Apps Script)

| Fichier | Rôle |
|---|---|
| `Code.gs` | Module principal : menu `onOpen`, génération bail / EDL / quittance / attestation, envois email, suivi loyers, archivage Drive |
| `Code_Compta.gs` | Module comptabilité : onglet `Comptabilité`, import CSV banque, import amortissement, onglet `Bilan Charges` |
| `Documenso.gs` | Client HTTP de l'API Documenso V2 (`DocumensoClient`) — transport uniquement, aucune logique métier |
| `Signature.gs` | Signature électronique : signataires, placeholders, idempotence, onglet `Signatures`, suivi, archivage Drive, menus + wrappers `web*` du module |
| `WebApp.gs` | Back-end de la web app mobile : `doGet`, lecture par ligne (`getTenantByRow`), wrappers `web*` sans `SpreadsheetApp.getUi()` |
| `Mobile.html` | Interface mobile (PWA) servie par `doGet` — cf. §5.5ter |
| `Compta_Form.html` | Boîte de dialogue « Ajouter une charge » (`menuAjouterCharge`) |
| `Compta_CSV.html` | Boîte de dialogue d'import d'un relevé CSV bancaire (`menuImporterCSV`) |
| `Compta_Amort.html` | Boîte de dialogue d'import d'un tableau d'amortissement (`menuImporterAmortissement`) |

### 2.2 Menu personnalisé `🏠 Gestion Locataire` (créé par `onOpen`)

- 📄 Générer le bail
- 📄 Générer l'état des lieux
- 📄 Générer bail + EDL
- ─────
- 📧 Demander les pièces justificatives
- 📧 Envoyer le dossier de location
- ─────
- 🧾 Générer la quittance + brouillon email
- 🧾🧾 Quittances groupées (lignes sélectionnées)
- ─────
- 🛡️ Envoyer attestation d'assurance
- ─────
- ✍️ Envoyer en signature (Documenso)
- 🔄 Actualiser les statuts de signature
- 🚫 Annuler une demande de signature
- ─────
- 📩 Répondre au préavis (consignes ménage)
- 📧 Envoyer l'EDL à l'ami (Word + PDF)
- 🗂️ Archiver les dossiers inactifs (→ OLD)
- 🔧 Réparer le suivi des loyers
- ─────
- ➕ Ajouter une charge
- 📊 Importer relevé CSV banque
- 🏦 Importer tableau d'amortissement
- 📈 Actualiser le bilan charges

### 2.3 Dossiers Google Drive (référencés via IDs en Config)

- `ID_DOSSIER_LOCATAIRES` → sous-dossier `LOCATAIRES`, lui-même contenu dans `02_LOCATAIRE` : dossier parent **direct** des dossiers locataires. Un sous-dossier par locataire (nommé d'après `Locataire_Nom`) est créé automatiquement par `getOrCreateTenantFolder`. Sous-dossier `Quittances/` créé pour chaque locataire à la première quittance. **Note** : la clé `ID_DOSSIER_LOCATAIRES` pointe désormais sur `LOCATAIRES`, plus sur `02_LOCATAIRE`. Le code ne référence ce dossier qu'à un seul endroit (`getOrCreateTenantFolder`) → seul le changement de valeur dans Config suffit, aucun code à modifier. La web app ne touche jamais aux dossiers Drive.
- `ID_DOSSIER_DOCS_COMMUNS` : documents communs joints à l'envoi du dossier de location (diagnostics, règlement copro, etc.).
- `ID_BAIL_TEMPLATE` : template Google Docs du bail.
- `ID_EDL_TEMPLATE` : template Google Docs de l'état des lieux.
- `ID_QUITTANCE_TEMPLATE` : template Google Docs de la quittance.
- `ID_SIGNATURE_IMAGE` : image PNG/JPG de la signature insérée dans la quittance.
- `ID_ATTESTATION_ASSURANCE` : template Google Docs de l'attestation de paiement d'assurance habitation (généré par `generateAttestationAssurance`).

---

## 3. Structure du Google Sheet

### 3.1 Onglet `Locataires`

Une ligne par locataire. Colonnes :

| Colonne | Description |
|---|---|
| `Actif` (ex-`STATUT`, colonne A) | **Case à cocher** (booléen TRUE/FALSE) indiquant si le colocataire est présent. Cochée = actif ; décochée = parti/inactif. **N'est plus écrite par les macros** — gérée **manuellement dans le Google Sheet** (case à cocher colonne A). Compat : anciennes valeurs texte (« Parti », « Dossier envoyé ») restent tolérées en lecture. |
| `Locataire_Nom` | Nom complet, format `NOM Prénom` (ex: `DUPONT Marie`). Le prénom est extrait via les mots après le 1er. |
| `Locataire_Date` | Date de naissance |
| `Locataire_Lieu` | Lieu de naissance |
| `EMAIL` | Email du locataire |
| `TELEPHONE` | Téléphone |
| `Locataire_Adresse` | Adresse précédente du locataire |
| `Chambre` | Numéro 1, 2 ou 3 (clé de jointure avec onglet Chambres) |
| `Date_Début` | Date d'entrée dans le logement |
| `Date_Fin` | Date de sortie |
| `1er_Loyer` | Montant du 1er loyer (proratisé si entrée en cours de mois) |
| `Assurance` | Quote-part assurance habitation à régler à l'entrée |
| `Compteur_Eau` | Relevé eau à l'entrée |
| `Compteur_Elec` | Relevé électricité à l'entrée |
| `Compteur_Eau_Sortie` | Relevé eau à la sortie |
| `Compteur_Elec_Sortie` | Relevé élec à la sortie |
| `Locataire_Nouvelle_Adresse` | Nouvelle adresse à la sortie |
| `ID_PDF_EDL` | ID Drive du PDF d'état des lieux généré |
| `ID_DOC_BAIL` | (réservé) |
| `ID_PDF_BAIL` | ID Drive du PDF de bail généré |
| `NOTES` | Notes libres |
| `Dernier_Loyer` | **Formule Sheet** : loyer TTC proratisé du mois de sortie = `Loyer CC × jour(Date_Fin) / nb jours du mois`. Vide tant que `Date_Fin` est vide. Lue par `detectMontantOverride` pour la quittance du mois de sortie. Écrasable manuellement (ex: entrée+sortie le même mois). |
| `ID_DOC_EDL` | ID du **Google Doc** EDL (écrit automatiquement par `generateEDL` via les menus/web app). Utilisé pour l'export Word envoyé à l'ami. Fallback : recherche par nom `EDL_<Nom>...` dans le dossier du locataire. |
| `Cosignataires` | *(facultative)* Colocataires devant signer le même document. Format `NOM Prénom <email>`, séparés par `;` ou retour à la ligne. Ordre des rangs Documenso déterminé par tri sur l'email (indépendant de la saisie). |
| `Signature_Statut` | *(facultative, lecture seule)* Miroir du statut de la dernière demande de signature. Écrite via `updateTenantCellIfExists` → silencieuse si la colonne n'existe pas. |
| `Signature_Envelope_ID` | *(facultative, lecture seule)* Miroir de l'identifiant d'enveloppe Documenso. |

**Sélection** : les fonctions du menu opèrent sur la **ligne active** de l'onglet `Locataires`.

### 3.2 Onglet `Chambres`

| ID Chambre | Surface | Loyer HC | Charges | Loyer CC | Caution | Description des meubles |
|---|---|---|---|---|---|---|
| 1 | 13 m² | 480,0 € | 100,0 € | 580,0 € | 480,0 € | Lit coffre, matelas 140x200, couette, alèse, bureau, chaise de bureau, lampe de bureau, armoire, cintres x8, commode, table de chevet, lampe de chevet, multiprise 6 prises, multiprise 2 prises, ventilateur |
| 2 | 9 m² | 460,0 € | 100,0 € | 560,0 € | 460,0 € | Lit coffre, matelas 140x200, couette, alèse, bureau, chaise de bureau, lampe de bureau, armoire, cintres x8, table de chevet, lampe de chevet, multiprise 6 prises, multiprise 2 prises, ventilateur |
| 3 | 9 m² | 460,0 € | 100,0 € | 560,0 € | 460,0 € | Lit coffre, matelas 140x200, bureau, couette, alèse, chaise de bureau, lampe de bureau, armoire, cintres x8, table de chevet, lampe de chevet, multiprise 6 prises, multiprise 2 prises, ventilateur |

**Note** : les en-têtes contiennent des espaces (ex: `Loyer HC`, `Loyer CC`, `ID Chambre`), pas d'underscores.

### 3.3 Onglet `Config`

Format : 2 colonnes (Clé / Valeur). Lu par `getConfig()`.

> ⚠️ Les valeurs réelles vivent **uniquement dans l'onglet `Config` du Google Sheet** — ce repo
> étant public, la doc n'utilise que des placeholders. Ne jamais recopier ici un ID Drive,
> une adresse ou une identité réelle.

| Clé | Valeur (exemple / format attendu) |
|---|---|
| `Bailleur_Nom` | `<Prénom Nom du bailleur>` |
| `Bailleur_Date` | `<JJ/MM/AAAA>` (date de naissance) |
| `Bailleur_Lieu` | `<Lieu de naissance>` |
| `Bailleur_Adresse` | `<Adresse postale du bailleur>` |
| `Bailleur_Ville` | `<Ville du bailleur>` (utilisée dans « Fait à … ») |
| `Location_Adresse` | `<Adresse du bien loué>` |
| `Location_Construction_Date` | Année de construction (ex: `1964`) |
| `Location_Surface` | Surface totale en m² (ex: `71`) |
| `Location_Pieces` | Nombre de pièces (ex: `4`) |
| `Location_Autres` | Cuisine, Salle de bain, WC, Balcon, Cellier |
| `Chauffage` | Collectif |
| `Eau` | Individuel (Chauffe-eau électrique) |
| `Loyer_Date` | 5 (jour d'échéance du loyer) |
| `ID_BAIL_TEMPLATE` | `<ID du Google Doc modèle de bail>` |
| `ID_EDL_TEMPLATE` | `<ID du Google Doc modèle d'état des lieux>` |
| `ID_DOSSIER_LOCATAIRES` | `<ID du dossier Drive LOCATAIRES>` (sous-dossier `LOCATAIRES` du dossier `02_LOCATAIRE`) |
| `ID_QUITTANCE_TEMPLATE` | `<ID du Google Doc modèle de quittance>` |
| `ID_SIGNATURE_IMAGE` | `<ID de l'image PNG/JPG de signature>` |
| `ID_DOSSIER_DOCS_COMMUNS` | `<ID du dossier Drive des documents communs>` |
| `ID_ATTESTATION_ASSURANCE` | `<ID du Google Doc modèle d'attestation d'assurance>` |
| `EMAIL_AMI_EDL` | Email de l'ami qui réalise les états des lieux (destinataire du brouillon EDL Word+PDF) |
| `Bailleur_Email` | Adresse email du bailleur — destinataire de la signature électronique `r1` (obligatoire si `SIGNATURE_BAILLEUR` = OUI) |
| `SIGNATURE_BAILLEUR` | `OUI` (défaut) / `NON` — le bailleur signe-t-il électroniquement ? Détermine la convention des rangs (cf. §5.8) |
| `SIGNATURE_ORDRE_SEQUENTIEL` | `OUI` = signature chacun son tour (r1 puis r2…) ; vide/`NON` = tous en parallèle (défaut) |

> ⚠️ Le **token API Documenso** n'est **jamais** dans l'onglet `Config` : il vit dans
> `PropertiesService.getScriptProperties()` sous la clé `DOCUMENSO_API_TOKEN` (cf.
> [`docs/documenso.md`](docs/documenso.md)).

### 3.4 Onglet `Templates`

3 colonnes : `NOM_TEMPLATE`, `OBJET`, `CORPS` (HTML). Templates utilisés :

- **`DEMANDE_PIECES`** — Demande des pièces justificatives (CNI, contrat de travail, 3 fiches de paie, mêmes pièces pour le garant ou Visale).
- **`ENVOI_DOCUMENTS`** — Envoi du dossier complet (bail, EDL, inventaire meubles, diagnostics, règlement intérieur, attestation assurance) + montants à régler avant entrée (1er loyer + caution + assurance) + mention signature Yousign.
- **`ENVOI_QUITTANCE`** — Envoi de la quittance avec récap HC / Charges / CC.
- **`ENVOI_ATTESTATION_DE_PAIEMENT_ASSURANCE`** — Attestation de paiement de la quote-part assurance habitation.
- **`ENVOI_EDL_AMI`** — Envoi de l'EDL (Word modifiable + PDF) à l'ami qui réalise les états des lieux, avec instructions (compteurs, légende TB/BE/EU/M, clés, photos, signature).
- **`REPONSE_PREAVIS`** — Réponse au préavis du locataire : confirmation `{{Date_Fin}}`, dernier loyer proratisé `{{Dernier_Loyer}}`, consignes de ménage (chambre + parties communes), restitution clés, dépôt de garantie `{{Caution}}`.

Les corps utilisent du **HTML** et des placeholders `{{Variable}}`.

---

## 3bis. Templates Google Docs (modèles `.docx`)

Les modèles vivent sur Google Drive et sont référencés par leur ID dans l'onglet `Config`. Les variables sont au format `{{Nom_Variable}}` et sont remplacées via `body.replaceText` dans Apps Script. Les fichiers sources `.docx` ne sont pas versionnés dans ce repo : ils vivent sur Google Drive (voir les clés `ID_*_TEMPLATE` de l'onglet `Config`).

### 3bis.1 `Bail_Template.docx` (`ID_BAIL_TEMPLATE`)

Bail meublé conforme à la loi du 6 juillet 1989, signature électronique via Yousign.

**Sections principales :**
1. Parties (Bailleur / Locataire)
2. Conditions financières (Loyer HC + Forfait charges = Total mensuel)
3. Désignation des locaux (Bâtiment Sauternes, Étage 10, Copropriété, description colocation)
4. Désignation des parties et des équipements (référence au plan, chambre n°{{Chambre}})
5. Durée et renouvellement (1 an reconductible tacitement)
6. Assureur multirisque habitation (souscription par le bailleur pour le compte des colocataires)
7. Loyer / Révision (indice IRL — référence saisie manuellement dans le template, ex: « 4ème trimestre 2025, valeur 145.78 »)
8. Charges (forfait mensuel non régularisable, art. 25-10 loi 1989)
9. Dépôt de garantie (montant dynamique via `{{Caution}}` — anciennement « UN MOIS de loyer hors charges » en dur)
10. Résiliation (préavis 1 mois locataire / 3 mois bailleur)
11. Obligations des parties
12. Élection de domicile
13. Pièces annexées (EDL, inventaire mobilier, DDT, attestation assurance, notice d'information, extrait règlement copro)
14. Notice d'information officielle (Arrêté 29 mai 2015) — annexe statique non templatée

**Variables utilisées dans ce template :**
`{{Bailleur_Nom}}`, `{{Bailleur_Date}}`, `{{Bailleur_Lieu}}`, `{{Bailleur_Adresse}}`, `{{Locataire_Nom}}`, `{{Locataire_Date}}`, `{{Locataire_Lieu}}`, `{{Locataire_Adresse}}`, `{{Loyer_HC}}`, `{{Charges}}`, `{{Loyer_CC}}`, `{{Caution}}`, `{{Location_Pieces}}`, `{{Location_Surface}}`, `{{Location_Adresse}}`, `{{Location_Construction_Date}}`, `{{Chauffage}}`, `{{Eau}}`, `{{Chambre}}`, `{{Date_Début}}`, `{{Date_Fin}}`, `{{Loyer_Date}}`.

**Champs assurance vides** dans le template (`Assureur :`, `Date de souscription :`, `Valable jusqu'au :`) → à compléter manuellement avant signature.

### 3bis.2 `Etat_des_lieux_Template.docx` (`ID_EDL_TEMPLATE`)

EDL contradictoire entrée + sortie sur le même document. Structure tableau avec doubles colonnes (Entrée / Sortie).

**Sections :**
1. Les Parties (Bailleur + Locataire avec `{{Locataire_Nouvelle_Adresse}}` pour la sortie)
2. Relevés et clés
   - Compteur électricité : N° de série fixe `<N° de série du compteur>`, index `{{Compteur_Elec}}` / `{{Compteur_Elec_Sortie}}`
   - Compteur eau chaude : N° série N/A, index `{{Compteur_Eau}}` / `{{Compteur_Eau_Sortie}}` (sous trappe meuble SDB)
   - Remise des clés : Badge immeuble (1), Clé porte appartement (1), Clé boîte aux lettres (1)
3. État des parties privatives — **3 sous-sections marquées `CHAMBRE N°1`, `CHAMBRE N°2`, `CHAMBRE N°3`**
   - Chaque tableau chambre : Sols (Lame parquet PVC), Murs, Plafonds, Plinthes, Porte & Poignée, Fenêtre/Store/Volet, Prises & Interrupteurs, Luminaire/Ampoule, Mobilier (liste détaillée par chambre)
   - **Suppression des chambres non concernées** : Apps Script `removeOtherRoomSections` cherche le marqueur littéral `CHAMBRE N°<n>` puis supprime jusqu'au prochain marqueur ou au début de la section suivante (titre numéroté `4. ...`).
4. État des parties communes
   - Entrée / Dégagement (Porte d'entrée, Sols & Plinthes, Murs & Plafonds, Interphone, Tableau électrique, Panneau d'affichage)
   - Cellier (Mobilier, Aspirateur fixé au mur, Sols/Murs/Plafonds)
   - Salon / Séjour (Sols, Murs, Rideaux & tringle, Prises, Mobilier détaillé : chauffeuses x3, table à manger, chaises x4, table basse, meuble TV, tapis, pouf, étagères ; TV/Box Internet)
   - Cuisine (Sols/Murs/Plafonds, Évier, Plaques, Placards, Four, Hotte avec 2 filtres supp., Micro-ondes, Frigo/Congélateur, Lave-vaisselle, Grille-pain, Cafetière, Bouilloire, Lave-linge, Stores, Vaisselle 6+6+6, Ustensiles, Poubelle, Divers)
   - Salle de bain (Sols, Lavabo, Douche, Joints, Miroir, Aération, Distributeur)
   - WC (Cuvette, Sols/Murs, Dérouleur/Brosse, Chauffe-eau)
   - Extérieurs/Balcon (Gazon synthétique, Table et chaise extérieur)
5. Signatures (Bailleur + Locataire pour Entrée et pour Sortie)

**Variables utilisées :**
`{{Chambre}}`, `{{Bailleur_Nom}}`, `{{Bailleur_Adresse}}`, `{{Locataire_Nom}}`, `{{Locataire_Nouvelle_Adresse}}`, `{{Compteur_Elec}}`, `{{Compteur_Elec_Sortie}}`, `{{Compteur_Eau}}`, `{{Compteur_Eau_Sortie}}`.

**Légende des états** : `TB` (Très Bon Etat) - `BE` (Bon État) - `EU` (État d'Usage) - `M` (Mauvais).

**Champs sortie en blanc** dans le template (couleur de police blanche). Si la cellule du Sheet est renseignée → Apps Script `setTextColor` repasse en noir, sinon la balise reste invisible dans le PDF.

### 3bis.3 `Quittance_Template.docx` (`ID_QUITTANCE_TEMPLATE`)

Quittance mensuelle conforme à la loi 89-462 du 6 juillet 1989 (art. 7-1). Document court, généré chaque mois, supprimé après conversion PDF.

**Structure :**
- En-tête : coordonnées bailleur + coordonnées locataire (`{{Bailleur_Nom}}`, `{{Bailleur_Adresse}}`, `{{Locataire_Nom}}`, `{{Location_Adresse}}`)
- Adresse de la location : `{{Location_Adresse}}`
- Corps : « Je soussigné {{Bailleur_Nom}} ... déclare avoir reçu de {{Locataire_Nom}}, la somme de {{Loyer_CC}}, au titre du paiement du loyer et des charges pour la période du {{Mois_en_cours_début}} au {{Mois_en_cours_fin}} ... »
- Détail du règlement :
  - Loyer : `{{Loyer_HC}}`
  - Forfait de charges : `{{Charges}}`
  - **Total :** `{{Loyer_CC}}`
- Date du paiement : `{{Date_Paiement}}`
- Lieu et date : « Fait à {{Bailleur_Ville}}, le {{Date_Quittance}} »
- Marqueur signature : texte `(Signature)` en italique → remplacé par image (`ID_SIGNATURE_IMAGE`, 150×75, alignement droite) via `insertSignatureImage`
- Mention légale finale : « Cette quittance annule tous les reçus ... À conserver pendant trois ans »

**Variables utilisées :**
`{{Bailleur_Nom}}`, `{{Bailleur_Adresse}}`, `{{Bailleur_Ville}}`, `{{Locataire_Nom}}`, `{{Location_Adresse}}`, `{{Loyer_HC}}`, `{{Charges}}`, `{{Loyer_CC}}`, `{{Mois_en_cours}}` (dans le titre du document), `{{Mois_en_cours_début}}`, `{{Mois_en_cours_fin}}`, `{{Date_Paiement}}`, `{{Date_Quittance}}`.

### 3bis.4 `Attestation de Paiement Assurance Habitation.docx` (`ID_ATTESTATION_ASSURANCE`)

Attestation annuelle confirmant que le locataire a réglé sa quote-part d'assurance multirisque habitation. Générée par `generateAttestationAssurance` (PDF dans le dossier du locataire, copie Docs supprimée) puis envoyée en **brouillon Gmail** par `createAttestationAssuranceDraft`. Accessible via le menu (`menuEnvoyerAttestationAssurance`) et via l'étape 4 de la carte « Nouveau locataire » de la web app (`webEnvoyerAttestationAssurance`). Pré-requis : `EMAIL` et `Assurance` renseignés.

**Structure :**
- En-tête bailleur + locataire (`{{Bailleur_Nom}}`, `{{Bailleur_Adresse}}`, `{{Locataire_Nom}}`, `{{Location_Adresse}}`)
- Lieu et date : « Fait à {{Bailleur_Ville}}, le {{Date_Quittance}} »
- Corps : « Je soussigné(e) {{Bailleur_Nom}}, bailleur du bien situé au {{Location_Adresse}}, atteste que : {{Locataire_Prenom}} {{Locataire_Nom}}, locataire de la chambre n°{{Chambre}}, a réglé sa quote-part d'assurance habitation multirisque ... »
- Période couverte : `{{Date_Début}} – {{Date_Fin}}`
- Montant réglé : `{{Assurance}}`
- Mention finale + signature `(Signature)`
- Date de génération : `{{Date_Generation}}`

**Variables utilisées :**
`{{Bailleur_Nom}}`, `{{Bailleur_Adresse}}`, `{{Bailleur_Ville}}`, `{{Locataire_Nom}}`, `{{Locataire_Prenom}}`, `{{Location_Adresse}}`, `{{Chambre}}`, `{{Date_Début}}`, `{{Date_Fin}}`, `{{Assurance}}`, `{{Date_Quittance}}`, `{{Date_Generation}}`.

**Variables hors `buildReplacements`** (ajoutées à la main, ne pas les chercher dans le dictionnaire commun) :
- `{{Date_Generation}}` et `{{Assurance}}` : injectées par `generateAttestationAssurance` (date du jour, montant formaté).
- `{{Année_en_cours}}`, `{{Assurance_Periode}}` (`Date_Début au Date_Fin`), `{{Assurance_Date_Paiement}}` (= `Date_Début`) : injectées par `createAttestationAssuranceDraft` dans **l'email seulement**, pas dans le Docx.

### 3.5 Onglet `Suivi Loyers` (créé automatiquement)

Créé par `addSuiviLoyer()` à la première quittance. Structure :

| Mois | Chambre 1 | Chambre 2 | Chambre 3 | Total |
|---|---|---|---|---|

`Total` est une formule `=B+C+D`. Format euros sur les colonnes B-E.

### 3.6 Onglet `Comptabilité` (créé via `getOrCreateComptaSheet()` / `initComptaSheet()`)

Suivi des charges. Colonnes (`COMPTA_HEADERS`) : `Date`, `Catégorie`, `Description`, `Montant`, `Chambre`, `Justificatif`.

Catégories disponibles (`CATEGORIES_CHARGES_LIST`, validation par liste) :
- Intérêts d'emprunt *(LMNP : seule la part intérêts est déductible)*
- Électricité
- Copropriété
- Assurance PNO
- Taxe foncière
- Eau
- Internet
- Mobilier / Équipements *(à amortir)*
- Travaux *(rénovation, aménagement capitalisable)*
- Entretien / Réparations
- Frais divers

Chambre : `''`, `1`, `2`, `3`, `Commun` (vide = charge commune).

**Saisie** : `menuAjouterCharge` ouvre `Compta_Form.html` → `receiveCharge`. Le justificatif est
rangé dans `LOCATAIRES/_Justificatifs/<année>/<MM>/` (`getOrCreateJustifFolder`).

### 3.7 Imports et bilan (module compta)

- **Import CSV banque** (`menuImporterCSV` → `Compta_CSV.html`) : `previewCSV` propose un mapping
  des colonnes, `parseCSVBanque` catégorise automatiquement chaque ligne via `autoCategorie`
  (dictionnaire `MOTS_CLES_CATEGORIE` : `edf`/`engie` → Électricité, `leroy merlin` → Travaux, etc.),
  puis `importerLignesCSV` écrit dans `Comptabilité`. Dédoublonnage par date + montant + description
  (`getExistingCharges` / `isDuplicate`).
- **Import tableau d'amortissement** (`menuImporterAmortissement` → `Compta_Amort.html`) :
  `parseAmortissementCSV` puis `importerInteretsCredit` n'importe **que la part intérêts** de chaque
  échéance, en catégorie `Intérêts d'emprunt` (le capital remboursé n'est pas une charge déductible).
- **Onglet `Bilan Charges`** (`menuActualiserBilan` → `genererBilan`) : recréé à chaque actualisation
  (contenu et formats effacés). Contient le total annuel par catégorie + un tableau mois × catégorie
  pour l'année la plus récente.

---

### 3.8 Onglet `Signatures` (créé automatiquement par `getOrCreateSignatureSheet()`)

Une ligne par demande de signature électronique. Colonnes (`SIGNATURE_HEADERS`) :

| Colonne | Modèle de données demandé | Contenu |
|---|---|---|
| `Date_Creation` | — | Horodatage de la création de la demande |
| `Ligne` / `Locataire_Nom` / `Chambre` | — | Rattachement au locataire |
| `Documents` | `signatureDocumentTypes` | `BAIL`, `EDL` ou `BAIL+EDL` |
| `External_ID` | `documensoExternalId` | Identifiant externe déterministe (cf. §5.9) |
| `Envelope_ID` | `documensoEnvelopeId` | Identifiant Documenso |
| `Statut` | `signatureStatus` | Cf. statuts ci-dessous |
| `Demande_Le` | `signatureRequestedAt` | Distribution effective |
| `Termine_Le` | `signatureCompletedAt` | Finalisation (signé / refusé / annulé) |
| `Signataires` | `signatureRecipients` | `r1=… ; r2=…` |
| `Fichiers_Signes` | `signedFiles` | Noms des PDF archivés dans Drive |
| `Derniere_Erreur` | `lastSignatureError` | Dernier échec (emails masqués, jamais de token) |
| `Lien` | — | Lien de suivi Documenso |

**Statuts** (`SIGNATURE_STATUTS`) : `NON_ENVOYE`, `PREPARATION`, `EN_ATTENTE_SIGNATURE`,
`PARTIELLEMENT_SIGNE`, `SIGNE`, `REFUSE`, `ANNULE`, `ERREUR`.
`SIGNE` / `REFUSE` / `ANNULE` sont **terminaux** (`SIGNATURE_STATUTS_FINAUX`) → plus interrogés
par le suivi horaire.

---

## 4. Variables (placeholders) — vue transverse

### 4.1 Variables de Config
`{{Bailleur_Nom}}`, `{{Bailleur_Date}}`, `{{Bailleur_Lieu}}`, `{{Bailleur_Adresse}}`, `{{Bailleur_Ville}}`, `{{Location_Adresse}}`, `{{Location_Construction_Date}}`, `{{Location_Surface}}`, `{{Location_Pieces}}`, `{{Location_Autres}}`, `{{Chauffage}}`, `{{Eau}}`, `{{Loyer_Date}}`

### 4.2 Variables Locataire
`{{Locataire_Nom}}`, `{{Locataire_Prenom}}` (extrait du 2e mot+ de `Locataire_Nom`), `{{Locataire_Date}}`, `{{Locataire_Lieu}}`, `{{Locataire_Adresse}}`, `{{Date_Début}}`, `{{Date_Fin}}`, `{{EMAIL}}`, `{{TELEPHONE}}`

### 4.3 Variables Chambre
`{{Chambre}}`, `{{Loyer_HC}}`, `{{Charges}}`, `{{Loyer_CC}}`, `{{Caution}}` (désormais câblée dans `buildReplacements` → utilisable dans tous les templates Docs)

### 4.4 Variables financières / dossier (emails)
`{{1er_Loyer}}`, `{{Assurance}}`, `{{Total_A_Regler}}` (= 1er loyer + caution + assurance)

### 4.5 Variables EDL — sortie (en blanc dans le template, repassées en noir si renseignées)
`{{Compteur_Eau}}`, `{{Compteur_Elec}}`, `{{Compteur_Eau_Sortie}}`, `{{Compteur_Elec_Sortie}}`, `{{Locataire_Nouvelle_Adresse}}`

### 4.6 Variables Quittance
`{{Mois_en_cours}}` (titre du PDF + email), `{{Mois_en_cours_début}}`, `{{Mois_en_cours_fin}}`, `{{Date_Quittance}}`, `{{Date_Paiement}}`

### 4.7 Variables Attestation assurance
- **Présentes dans le template Docx** : `{{Date_Quittance}}`, `{{Date_Generation}}`, `{{Assurance}}` (+ identité bailleur/locataire/chambre/période).
- **Présentes dans le template email** uniquement : `{{Année_en_cours}}`, `{{Assurance_Periode}}`, `{{Assurance_Date_Paiement}}`.
- ⚠️ Ces deux jeux de variables ne se recoupent pas → harmoniser lors de l'automatisation de cette pièce.

### 4.8 Comportement par défaut
- Valeur vide / null → remplacée par `___`
- Date → format `dd/MM/yyyy` (timezone du script)
- Montant → format `0,00 €` (virgule décimale française)

### 4.9 Matrice template ↔ variables

| Variable | Bail | EDL | Quittance | Attestation | Emails |
|---|:---:|:---:|:---:|:---:|:---:|
| `{{Bailleur_Nom}}` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `{{Bailleur_Date}}` / `{{Bailleur_Lieu}}` | ✓ | | | | |
| `{{Bailleur_Adresse}}` | ✓ | ✓ | ✓ | ✓ | |
| `{{Bailleur_Ville}}` | | | ✓ | ✓ | |
| `{{Locataire_Nom}}` | ✓ | ✓ | ✓ | ✓ | |
| `{{Locataire_Prenom}}` | | | | ✓ | ✓ |
| `{{Locataire_Date}}` / `{{Locataire_Lieu}}` / `{{Locataire_Adresse}}` | ✓ | | | | |
| `{{Locataire_Nouvelle_Adresse}}` | | ✓ | | | |
| `{{Location_Adresse}}` | ✓ | | ✓ | ✓ | ✓ |
| `{{Location_Surface}}` / `{{Location_Pieces}}` / `{{Location_Construction_Date}}` / `{{Chauffage}}` / `{{Eau}}` | ✓ | | | | |
| `{{Chambre}}` | ✓ | ✓ | | ✓ | ✓ |
| `{{Loyer_HC}}` / `{{Charges}}` / `{{Loyer_CC}}` | ✓ | | ✓ | | ✓ |
| `{{Caution}}` | ✓ | | | | ✓ |
| `{{Loyer_Date}}` | ✓ | | | | |
| `{{Date_Début}}` / `{{Date_Fin}}` | ✓ | | | ✓ | ✓ |
| `{{Compteur_Eau}}` / `{{Compteur_Elec}}` (+ Sortie) | | ✓ | | | |
| `{{Mois_en_cours_début}}` / `{{Mois_en_cours_fin}}` / `{{Date_Paiement}}` / `{{Date_Quittance}}` | | | ✓ | ✓ | |
| `{{Mois_en_cours}}` | | | | | ✓ |
| `{{1er_Loyer}}` / `{{Assurance}}` / `{{Total_A_Regler}}` | | | | ✓ | ✓ |
| `{{Date_Generation}}` | | | | ✓ | |
| `{{Année_en_cours}}` / `{{Assurance_Periode}}` / `{{Assurance_Date_Paiement}}` | | | | | ✓ |

---

## 5. Logique métier importante

### 5.1 Génération du bail (`generateLeaseDoc`)
1. Copie le template (`ID_BAIL_TEMPLATE`) dans `02_LOCATAIRE/LOCATAIRES/<Locataire_Nom>/`
2. Nom : `Bail_<Nom>_Chambre<N>_<YYYYMMDD>`
3. Remplace toutes les variables via `body.replaceText`
4. Génère le PDF, **supprime la copie Google Docs** (ne garde que le PDF)
5. Écrit `ID_PDF_BAIL` dans la ligne du locataire

### 5.2 Génération de l'EDL (`generateEDL`)
1. Copie le template (`ID_EDL_TEMPLATE`)
2. **Supprime les sections des chambres non concernées** (`removeOtherRoomSections`) en cherchant les marqueurs `CHAMBRE N°1/2/3`
3. Remplace variables d'entrée (compteurs)
4. Pour les variables de sortie : si la cellule du Sheet est renseignée → remplace + repasse le texte en **noir** (`setTextColor`). Sinon, la balise reste en blanc (invisible) dans le PDF.
5. Génère le PDF (le doc Google reste dispo, contrairement au bail)
6. Écrit `ID_PDF_EDL`

### 5.3 Génération de la quittance (`generateQuittance`)
1. Détection automatique premier/dernier loyer via **`detectMontantOverride(tenant, chambre, mois, annee)`** (helper partagé menu / groupé / web app) :
   - **Dernier loyer** (prioritaire) : mois choisi = mois de `Date_Fin` ET `Dernier_Loyer > 0` → montant `Dernier_Loyer`.
   - **Premier loyer** : mois choisi = mois de `Date_Début` ET `1er_Loyer ≠ Loyer CC` ET `> 0` → montant `1er_Loyer`.
   - Le ratio `montant / Loyer_CC` est appliqué sur HC et les charges recalculées.
2. Période : du 1er au dernier jour du mois ; **premier loyer** → commence à `Date_Début` ; **dernier loyer** → se termine à `Date_Fin`.
3. Insère l'image de signature à la place du texte `(Signature)` (taille 150×75, alignement droite).
4. Génère le PDF dans `02_LOCATAIRE/LOCATAIRES/<Locataire_Nom>/Quittances/`
5. Nom : `Quittance_<Nom>_<MM>_<AAAA>.pdf`
6. Supprime la copie Google Docs
7. Enregistre le montant dans `Suivi Loyers`
8. Propose l'envoi par email

### 5.4 Envoi du dossier de location (`createDossierLocationDraft`)
- **Pré-requis** : bail ET EDL générés (`ID_PDF_BAIL` et `ID_PDF_EDL` non vides), `1er_Loyer` et `Assurance` renseignés.
- Pièces jointes : Bail PDF + EDL PDF + tous les fichiers du dossier `ID_DOSSIER_DOCS_COMMUNS`.
- **Crée un brouillon Gmail** (jamais d'envoi direct → revue manuelle obligatoire).
- **N'écrit plus la colonne A** (`Actif`). Le statut est géré manuellement / via le toggle web app.

### 5.5 Envoi de quittance par email
Deux chemins partagent le même builder `buildQuittanceEmail` (objet + corps HTML + PJ PDF) :
- `createQuittanceDraft` → **brouillon Gmail** (menu + bouton web « Générer la quittance + brouillon »).
- `sendQuittanceEmail` → **envoi direct** (pas de brouillon), utilisé par le bouton web « Quittance 1 clic » pour les colocataires actifs.
- Si premier loyer : recalcule HC/Charges/CC pour que le récap dans l'email corresponde au PDF.

### 5.5bis Quittance 1 clic — envoi direct (web app)
- `webEnvoyerQuittanceDirecte(row)` : génère la quittance du **mois en cours**, met à jour `Suivi Loyers`, puis **envoie directement** l'email via `sendQuittanceEmail` (aucun brouillon).
- Garde-fou : refusé si colocataire inactif (`isTenantParti`) ou sans email.
- Côté UI : la section « Quittance 1 clic — colocataires actifs » liste un bouton par coloc actif ; clic → pop-up `confirm()` (« Envoi immédiat — PAS de brouillon ») → envoi immédiat seulement si OK.
- La case `Actif` (colonne A) se gère **manuellement dans le Sheet**. La fonction backend `webSetActif(row, actif)` existe toujours (non câblée à l'UI) si besoin futur.

### 5.5ter Structure de la web app mobile (`Mobile.html`)

Quatre cartes, ordonnées par fréquence d'usage. **Chaque action porte son propre sélecteur** — il n'y a plus de sélecteur global en tête de page.

1. **Quittance 1 clic — colocataires actifs** : hint du mois cible (`webGetMeta` → `getMoisQuittanceCible`) + un bouton par coloc actif (`renderActifs`). Ambre = envoi direct ; gris `done` = quittance du mois cible déjà enregistrée (renvoi possible sur confirmation, `force = true`).
2. **Quittance — autre mois** (rattrapage) : sélecteur `#q-tenant` (**actifs uniquement**, aligné sur le garde-fou `isTenantParti` de `webGenererQuittance`) + badges `Email` / `Quittance <mois cible>` + `#mois` / `#annee` → `genQuittanceMoisChoisi()` → PDF + **brouillon** Gmail.
3. **Nouveau locataire** : bloc « avant la ligne dans le Sheet » (email libre → `webDemandePiecesLibre`), puis sélecteur `#tenant-onboard` (tous locataires) + badges et 4 étapes numérotées — 1 pièces, 2 bail + EDL, 3 dossier, 4 **attestation d'assurance** (`webEnvoyerAttestationAssurance`) — suivies de la ligne de régénération Bail / EDL.

4. **Signature électronique** : sélecteur `#sig-tenant` (tous locataires) + badges `PDF bail` /
   `PDF EDL` / `Email`, sélecteur `#sig-jeu` (Bail / EDL / Bail + EDL), case **Mode test
   (DRY_RUN)**, bouton « 🔍 Vérifier et récapituler » (`webPreparerSignature`, sans effet de bord)
   puis bouton d'envoi **désactivé tant que la vérification n'est pas passée** (`SIG_PRET`), et
   « 🔄 Actualiser les statuts ». Le récapitulatif affiche logement, documents, signataires, emails,
   ordre de signature, identifiant externe et historique.
   ⚠️ `setLoading(false)` réactive **tous** les boutons : `syncSignatureUI()` réapplique l'état réel
   du bouton d'envoi après chaque action, et `sigConfirmer()` re-vérifie `SIG_PRET` côté client
   (le serveur re-fait de toute façon `preflightSignature`).

Supprimé de l'UI : l'ancien sélecteur global « Colocataire actif », la carte fourre-tout « Autres », et le bouton « Réparer le suivi des loyers » (le suivi ne se consulte pas dans la web app → action réservée au menu Sheet `menuReparerSuiviLoyers` ; le wrapper `webReparerSuiviLoyers` reste disponible).

### 5.6 Demande de pièces (`createDemandePiecesDraft`)
- Brouillon Gmail, **sans pièce jointe**.

### 5.6bis Fin de location
- **Saisie** : à réception du préavis, renseigner `Date_Fin` → la formule `Dernier_Loyer` se calcule.
- **`menuRepondrePreavis`** : brouillon Gmail au locataire (template `REPONSE_PREAVIS`). Pré-requis : `EMAIL` + `Date_Fin` renseignés. Avertit si `Dernier_Loyer` vide.
- **`menuEnvoyerEDLAmi`** / `createEDLAmiDraft` : brouillon Gmail à `EMAIL_AMI_EDL` (Config) avec l'EDL en **.docx** (export du Google Doc via `exportDocAsDocx` + `UrlFetchApp` + token OAuth) et en **PDF**. L'ID du doc vient de `ID_DOC_EDL` (via `findEDLDocId`, fallback recherche par nom).
- **Quittance de sortie** : détection automatique (cf. 5.3). ⚠️ Générer la dernière quittance **avant** de décocher `Actif` (inactif = quittance bloquée).
- **Archivage Drive** : `archiverDossiersInactifs()` déplace les dossiers `LOCATAIRES/<Nom>` des colocataires inactifs (`isTenantParti`) vers `LOCATAIRES/OLD` (créé automatiquement, idempotent). Déclenché par trigger mensuel (`triggerArchivageMensuel`, le 1er vers 6h, installé une fois via `installerTriggerArchivage`) ou via le menu. `getOrCreateTenantFolder` cherche aussi dans `OLD` pour ne pas recréer de dossier vide après archivage.

### 5.7 Garde-fous
- Quittance interdite si `STATUT === 'Parti'`.
- Toutes les actions menu vérifient les ID requis dans Config (lèvent une erreur explicite si manquant).
- Toutes les actions sont précédées d'une boîte de confirmation `YES/NO`.

### 5.8 Signature électronique — Documenso (`Signature.gs` + `Documenso.gs`)

Documentation complète : [`docs/documenso.md`](docs/documenso.md). Résumé de la logique :

1. **Marqueur interne, placeholders générés.** Les modèles Docs contiennent un unique marqueur
   `[[SIGNATURES_DOCUMENSO]]` (constante `SIGNATURE_MARQUEUR`), jamais de placeholders figés.
   `insererBlocSignatures` le remplace par un bloc adapté au **nombre réel de signataires** —
   `{{name, rN}}` / `{{signature, rN}}` / `{{date, rN}}`, **un par ligne**, en Arial 11 noir — puis
   supprime le marqueur. Le marqueur doit être un **paragraphe autonome hors tableau** (sinon
   `removeChild` emporterait le tableau : le cas est refusé explicitement, dès le récapitulatif).
2. **Convention des rangs** (`resoudreSignataires`) : `SIGNATURE_BAILLEUR = OUI` → r1 bailleur,
   r2 locataire, r3+ colocataires ; `NON` → r1 locataire, r2+ colocataires. L'ordre du tableau de
   destinataires envoyé à l'API **est** l'ordre des rangs.
3. **Copie prête à signer.** `preparerPdfSignature` duplique le modèle, réutilise
   `applyBailReplacements` / `applyEdlReplacements` (extraits de `generateLeaseDoc` / `generateEDL`),
   **neutralise les variables résiduelles** (`neutraliserVariablesResiduelles` — indispensable pour
   les balises de sortie en blanc de l'EDL), insère le bloc, **valide** (`validerPlaceholders`),
   exporte le PDF puis supprime la copie Docs. Le modèle source n'est jamais modifié.
4. **Envoi** (`envoyerDemandeSignature`) : pré-contrôles → PDF → trace dans `Signatures` **avant**
   tout appel réseau → `createEnvelope` → `validateDetectedFields` → `distributeEnvelope`.
   Bail + EDL = **une seule enveloppe** (2 fichiers), donc un seul document décompté du quota.
5. **Suivi** : `triggerSuiviSignatures` (horaire, installé par `installerTriggerSignatures`) ou
   `actualiserStatutsSignature()` à la demande. Sur `COMPLETED` → téléchargement + archivage, une
   seule fois (idempotent via `Fichiers_Signes`).
6. **DRY_RUN** : génère les PDF (`_DRYRUN`), résout les signataires, construit le payload,
   **n'appelle pas l'API et n'écrit pas dans `Signatures`**. Fonctionne sans token.

### 5.9 Idempotence — identifiant externe

`construireExternalId` produit `GL-<locationId>-<documentSet>-<revision>`, ex.
`GL-ch2-dupont-marie-BAIL_EDL-e03a8053` :

- `locationId` = `ch<chambre>-<slug(Locataire_Nom)>`
- `documentSet` = `BAIL` | `EDL` | `BAIL_EDL`
- `revision` = empreinte MD5 (8 hex) des données qui composent les documents (identité, dates,
  compteurs, montants, bailleur, adresse, emails des signataires dans l'ordre des rangs)

Avant chaque envoi, `preflightSignature` refuse une demande dont l'identifiant existe déjà avec un
statut `PREPARATION` / `EN_ATTENTE_SIGNATURE` / `PARTIELLEMENT_SIGNE` / `SIGNE`, **ou** `ERREUR`
avec un `Envelope_ID` renseigné (une enveloppe existe côté Documenso → il faut l'annuler d'abord).
Une reprise légitime réutilise la même base avec un suffixe `-t2`, `-t3`…

### 5.10 Archivage des documents signés

Dans `LOCATAIRES/<Locataire_Nom>/Signature/`, noms déterministes :
`<yyyy-MM-dd>_<Bail|Etat-des-lieux-entree>_<NOM>_<Original|Signe>.pdf`,
`<yyyy-MM-dd>_Certificat-signature_<NOM>.pdf`, `<yyyy-MM-dd>_Journal-signature_<NOM>.pdf`.
Le PDF original envoyé à la signature est conservé ; le certificat et le journal sont « best
effort » (leur absence n'empêche ni le passage à `SIGNE` ni l'archivage des documents signés).

---

## 6. Helpers / fonctions utilitaires

| Fonction | Rôle |
|---|---|
| `getConfig()` | Lit l'onglet Config en dictionnaire clé→valeur |
| `getChambreData(id)` | Lit la ligne de la chambre par `ID Chambre` |
| `getTenantData()` | Lit la ligne active de Locataires |
| `updateTenantCell(sheet, row, columnName, value)` | Écrit dans une colonne par nom d'en-tête |
| `buildReplacements(tenant, config, chambre)` | Construit le dictionnaire `{{var}}→valeur` complet |
| `formatValue(val)` | Formate dates et chaînes, `___` si vide |
| `formatEuro(val)` | Formate `123.45` → `"123,45 €"` |
| `parseEuro(val)` | Parse `"542,60 €"` → `542.60` |
| `escapeRegex(str)` | Échappe regex pour `replaceText` |
| `getOrCreateTenantFolder(config, name)` | Sous-dossier par locataire dans Drive |
| `getOrCreateSubFolder(parent, name)` | Sous-dossier générique |
| `createLeasePdf(docId, name, folder)` | Convertit un Google Doc en PDF dans le dossier |
| `setTextColor(body, text, hexColor)` | Repasse en couleur (utilisé pour l'EDL sortie) |
| `getEmailTemplate(name)` | Lit `{objet, corps}` depuis l'onglet Templates |
| `replaceEmailPlaceholders(text, tenant, config, chambre)` | Remplace les `{{var}}` dans un email |
| `getFolderAttachments(folderId)` | Liste les blobs d'un dossier Drive (pour PJ) |
| `addSuiviLoyer(tenant, chambre, moisNom, montant)` | Met à jour l'onglet Suivi Loyers |
| `MOIS_FR` | Tableau des noms de mois en français |
| `CATEGORIES_CHARGES_LIST` | Liste des catégories comptables (Code_Compta.gs) |
| `getStatutColName(sheet)` | Résout le nom de la colonne A (`Actif`, sinon `STATUT`) |
| `getTenantStatutRaw(tenant)` | Valeur brute colonne A quel que soit l'en-tête |
| `isTenantActif(tenant)` / `isTenantParti(tenant)` | Lecture flexible actif/inactif (booléen ou texte « Parti ») |
| `buildQuittanceEmail(...)` | Construit objet+corps+PJ d'un email de quittance (partagé brouillon/envoi direct) |
| `sendQuittanceEmail(...)` | **Envoi direct** d'une quittance (pas de brouillon) |
| `webSetActif(row, actif)` | Coche/décoche la case `Actif` depuis la web app |
| `detectMontantOverride(tenant, chambre, mois, annee)` | Détecte premier/dernier loyer proratisé → `{montant, type}` |
| `updateTenantCellIfExists(...)` | Comme `updateTenantCell` mais silencieux si colonne absente (ex: `ID_DOC_EDL`) |
| `findEDLDocId(tenant, config)` | ID du Google Doc EDL (colonne `ID_DOC_EDL`, fallback recherche par nom) |
| `exportDocAsDocx(docId, name)` | Exporte un Google Doc en blob `.docx` |
| `createEDLAmiDraft(...)` / `menuEnvoyerEDLAmi()` | Brouillon Gmail EDL Word+PDF à l'ami (`EMAIL_AMI_EDL`) |
| `menuRepondrePreavis()` | Brouillon Gmail réponse au préavis (template `REPONSE_PREAVIS`) |
| `archiverDossiersInactifs()` / `menuArchiverDossiersInactifs()` | Déplace les dossiers des inactifs vers `LOCATAIRES/OLD` |
| `triggerArchivageMensuel()` / `installerTriggerArchivage()` | Trigger mensuel d'archivage (le 1er vers 6h) |
| `webEnvoyerQuittanceDirecte(row)` | Quittance mois courant + suivi + envoi direct (bouton 1 clic) |
| `statutValueIsActif(v)` | (WebApp) booléen actif depuis la valeur brute colonne A |
| `applyBailReplacements(body, tenant, config, chambre)` | Remplacements du bail — extrait de `generateLeaseDoc`, partagé avec la copie « prête à signer » |
| `applyEdlReplacements(body, tenant, config)` | Suppression des autres chambres + remplacements EDL — extrait de `generateEDL` |

### 6bis. Signature électronique (`Documenso.gs` / `Signature.gs`)

| Fonction | Rôle |
|---|---|
| `DocumensoClient` | Client API V2 : `createEnvelope`, `addOrMapRecipients`, `validateDetectedFields`, `distributeEnvelope`, `getEnvelopeStatus`, `downloadCompletedDocuments`, `cancelEnvelope` |
| `DocumensoError` | Erreur typée : `code`, `httpStatus`, `stage`, `envelopeId`, `safeToRetry` |
| `documensoToken()` / `documensoTokenConfigure()` | Lecture du token (propriétés de script) — jamais journalisé |
| `documensoMaskEmail()` / `documensoExtraitSur()` | Masquage des données personnelles dans les logs et messages |
| `documensoBuildMultipart(parts)` | Corps `multipart/form-data` à plusieurs fichiers (UrlFetchApp ne sait pas envoyer deux champs `files`) |
| `resoudreSignataires(tenant, config)` | Liste ordonnée des signataires → rangs r1, r2, … |
| `parseCosignataires(brut)` | Analyse de la colonne `Cosignataires`, ordre déterministe (tri email) |
| `construireExternalId(...)` | Identifiant externe déterministe (cf. §5.9) |
| `insererBlocSignatures(body, signataires)` | Remplace `[[SIGNATURES_DOCUMENSO]]` par les placeholders |
| `neutraliserVariablesResiduelles(body)` | Retire les `{{...}}` non remplacés avant l'ajout des placeholders |
| `validerPlaceholders(texte, signataires)` | Présence, unicité, rangs cohérents, aucun placeholder coupé |
| `preparerPdfSignature(...)` | Copie du modèle → remplacements → bloc → validation → PDF |
| `preflightSignature(ctx, options)` | Récapitulatif + blocages, sans effet de bord ni appel API |
| `envoyerDemandeSignature(row, jeu, options)` | Orchestration complète de l'envoi (ou du DRY_RUN) |
| `actualiserStatutsSignature()` | Suivi : statuts, téléchargement et archivage des documents finalisés |
| `archiverDocumentsSignes(...)` | Écriture Drive des PDF signés + certificat + journal d'audit |
| `annulerDemandeSignature(externalId, motif)` | Annulation côté Documenso + mise à jour du suivi |
| `triggerSuiviSignatures()` / `installerTriggerSignatures()` | Déclencheur horaire de suivi |
| `webGetSignatureMeta()` / `webPreparerSignature(row, jeu)` / `webEnvoyerSignature(row, jeu, dryRun)` / `webActualiserStatutsSignature()` / `webGetSignaturesLocataire(row)` / `webAnnulerSignature(...)` | Wrappers web app |
| `menuEnvoyerEnSignature()` / `menuActualiserStatutsSignature()` / `menuAnnulerSignature()` | Entrées de menu |

---

## 7. Conventions et pièges connus

1. **Format des nombres** : virgule décimale française partout, symbole `€` (espace insécable optionnel).
2. **Locataire_Nom** : doit être au format `NOM Prénom` (le prénom = tout ce qui suit le 1er mot).
3. **Templates Docs** : les variables sont au format `{{Nom_Variable}}` exactement (sensible à la casse et aux underscores).
4. **EDL** : la suppression des sections d'autres chambres dépend du marqueur littéral `CHAMBRE N°1/2/3` dans le doc + d'un délimiteur de section suivant (titre numéroté `4. ...`). Si le template change, vérifier `removeOtherRoomSections` et `findNextRoomSectionEnd`.
5. **Quittance — premier/dernier loyer** : détection sur `mois/année === Date_Début` (premier) ou `=== Date_Fin` (dernier, prioritaire). `1er_Loyer` et `Dernier_Loyer` sont en TTC (charges incluses). `Dernier_Loyer` est une **formule** dans le Sheet (prorata jours réels) — si entrée et sortie tombent le même mois, écraser la formule manuellement sur la ligne.
6. **Drive** : les fichiers Google Docs intermédiaires (bail, quittance) sont **mis à la corbeille** une fois le PDF créé. Pour l'EDL, le doc Google **reste**.
7. **Colonne A `Actif`** : case à cocher booléenne. Cochée = actif, décochée = inactif/parti. Helpers `isTenantActif` / `isTenantParti` lisent la valeur de façon flexible (booléen OU ancien texte « Parti »). Un colocataire inactif bloque la génération de quittances. **Les macros n'écrivent jamais cette colonne** — elle se gère manuellement dans le Sheet (case à cocher colonne A).
8. **Emails** : `createDraft` pour les emails à fort enjeu (dossier, demande de pièces) → relecture manuelle. `sendEmail` pour les quittances → envoi direct.
9. **Signature électronique** : automatisée via **Documenso** (`Signature.gs`, cf. §5.8 et
   [`docs/documenso.md`](docs/documenso.md)). Le template email `ENVOI_DOCUMENTS` mentionne encore
   « Yousign » — à mettre à jour dans l'onglet `Templates` du Sheet (contenu non versionné).
10. **Modèles Docs et signature** : le marqueur `[[SIGNATURES_DOCUMENSO]]` doit être ajouté à la
    main dans les modèles de bail et d'EDL (ils vivent sur Drive, pas dans le repo). Sans lui,
    l'envoi en signature est bloqué avec un message explicite. Guide : `docs/documenso.md` §2.
11. **Token Documenso** : uniquement dans `PropertiesService.getScriptProperties()`
    (`DOCUMENSO_API_TOKEN`). Jamais dans une cellule, un fichier versionné ou un log. `npm run lint`
    échoue si un token `api_…` apparaît dans un fichier du dépôt.
12. **Tests hors ligne** : `npm test` charge les vrais `.gs` dans un contexte `vm` avec des stubs
    Apps Script (`tests/`). L'API Documenso est mockée — aucun test ne peut déclencher une vraie
    signature. `.claspignore` empêche `clasp push` d'envoyer `tests/` dans le projet Apps Script.

---

## 8. Évolutions possibles (idées non implémentées)

- Génération mensuelle automatique des quittances pour tous les locataires actifs (déclencheur Apps Script).
- Tableau de bord rentabilité (loyers perçus vs charges depuis l'onglet Comptabilité).
- Validation automatique de la cohérence Locataires / Chambres (chambre occupée par 1 seul locataire actif à la fois).
