# Configuration du Google Sheet

Ce que le code attend côté Sheet et qui ne peut pas être créé automatiquement : deux colonnes
(dont une formule), une clé de configuration, deux templates d'emails, un déclencheur.
À faire une fois, à la mise en place du projet.

La liste exhaustive des colonnes, clés `Config` et variables de templates est dans
[`../CLAUDE.md`](../CLAUDE.md) ; cette page ne couvre que ce qui demande une saisie manuelle.

---

## 1. Onglet `Locataires` — 2 colonnes en fin de tableau (après `NOTES`)

| Colonne | Contenu |
|---|---|
| `Dernier_Loyer` | Formule (ci-dessous). Montant TTC proratisé du mois de sortie. |
| `ID_DOC_EDL` | Laisser vide — rempli automatiquement à chaque génération d'EDL (`generateEDL`). |

### Formule `Dernier_Loyer` (ligne 2, à recopier vers le bas)

En supposant l'ordre de colonnes actuel : `Chambre` = **H**, `Date_Fin` = **J** (adapter si différent) :

```
=SI(OU($J2="";$H2="");"";ARRONDI(RECHERCHEV($H2;Chambres!$A:$E;5;FAUX)*JOUR($J2)/JOUR(FIN.MOIS($J2;0));2))
```

- `RECHERCHEV(...;5;FAUX)` → colonne **Loyer CC** (5e colonne de l'onglet `Chambres`)
- Prorata = jour de sortie / nombre de jours réels du mois (ex. sortie le 12/09 → 12/30 × 560 € = 224,00 €)
- Vide tant que `Date_Fin` n'est pas renseignée → aucun impact sur les quittances normales
- Cas rare entrée + sortie le même mois : écraser la formule à la main sur cette ligne

Format de la colonne : monétaire € (le code accepte nombre brut ou `"224,00 €"`).

---

## 2. Onglet `Config` — clé `EMAIL_AMI_EDL`

| Clé | Valeur |
|---|---|
| `EMAIL_AMI_EDL` | Adresse email de la personne qui réalise les états des lieux sur place (destinataire du brouillon EDL Word + PDF) |

*(Pas de clé pour le dossier OLD : le sous-dossier `LOCATAIRES/OLD` est créé automatiquement au premier archivage.)*

---

## 3. Onglet `Templates` — 2 lignes à créer

Corps HTML à coller tels quels dans la colonne `CORPS` (les autres templates sont décrits dans `CLAUDE.md` §3.4).

### Ligne 1 — `ENVOI_EDL_AMI`

**NOM_TEMPLATE** : `ENVOI_EDL_AMI`

**OBJET** : `État des lieux — {{Locataire_Nom}} (Chambre {{Chambre}}) — {{Location_Adresse}}`

**CORPS** :

```html
<p>Salut,</p>
<p>Peux-tu réaliser l'état des lieux pour le locataire suivant ?</p>
<ul>
  <li><b>Locataire :</b> {{Locataire_Nom}} — {{EMAIL}} / {{TELEPHONE}}</li>
  <li><b>Logement :</b> {{Location_Adresse}} — Chambre n°{{Chambre}}</li>
  <li><b>Période du bail :</b> du {{Date_Début}} au {{Date_Fin}}</li>
</ul>
<p>Tu trouveras en pièces jointes :</p>
<ul>
  <li>l'état des lieux au format <b>Word</b> (modifiable — c'est celui-là qu'il faut compléter) ;</li>
  <li>la version <b>PDF</b> pour référence.</li>
</ul>
<p><b>À faire sur place :</b></p>
<ul>
  <li>relever les compteurs (électricité + eau chaude, compteur sous la trappe du meuble de salle de bain) et les noter dans le document ;</li>
  <li>vérifier l'état de la chambre pièce par pièce (sols, murs, plafonds, mobilier) avec la légende TB / BE / EU / M ;</li>
  <li>vérifier les parties communes (entrée, salon, cuisine, salle de bain, WC, cellier, balcon) ;</li>
  <li>compter les clés remises/rendues : badge immeuble (1), clé appartement (1), clé boîte aux lettres (1) ;</li>
  <li>prendre des photos en cas de dégradation ;</li>
  <li>faire signer le document par le locataire, puis me renvoyer le fichier complété (ou scanné).</li>
</ul>
<p>Merci beaucoup !<br>{{Bailleur_Nom}}</p>
```

### Ligne 2 — `REPONSE_PREAVIS`

**NOM_TEMPLATE** : `REPONSE_PREAVIS`

**OBJET** : `Votre préavis — départ le {{Date_Fin}} ({{Location_Adresse}})`

**CORPS** :

```html
<p>Bonjour {{Locataire_Prenom}},</p>
<p>J'accuse bonne réception de votre préavis. Je vous confirme votre date de sortie du logement : <b>{{Date_Fin}}</b>.</p>
<p><b>Dernier loyer :</b> le loyer du mois de sortie est proratisé jusqu'au {{Date_Fin}}, soit <b>{{Dernier_Loyer}}</b> (charges comprises). La quittance correspondante vous sera envoyée comme d'habitude.</p>
<p><b>État des lieux de sortie :</b> il sera réalisé le jour de votre départ, sur rendez-vous (je reviens vers vous pour fixer l'horaire). Merci de me communiquer dès que possible votre <b>nouvelle adresse</b> (nécessaire pour l'état des lieux et la restitution du dépôt de garantie).</p>
<p><b>Avant l'état des lieux, merci de prévoir le ménage suivant :</b></p>
<p><u>Votre chambre (n°{{Chambre}}) :</u></p>
<ul>
  <li>chambre entièrement vidée de vos affaires personnelles ;</li>
  <li>sols aspirés et lavés, plinthes et surfaces dépoussiérées ;</li>
  <li>mobilier propre et remis en place (lit, bureau, armoire, commode/chevet — literie fournie propre) ;</li>
  <li>murs, interrupteurs et poignées nettoyés si marques ;</li>
  <li>fenêtre et rebords nettoyés ;</li>
  <li>trous rebouchés le cas échéant.</li>
</ul>
<p><u>Parties communes (votre quote-part) :</u></p>
<ul>
  <li>cuisine : plaques, four, micro-ondes, hotte et plans de travail dégraissés ; votre étagère du frigo et vos placards vidés et nettoyés ;</li>
  <li>salle de bain : lavabo, douche et joints propres ;</li>
  <li>WC : cuvette et sols propres ;</li>
  <li>salon, entrée et cellier : rangés, sols aspirés ;</li>
  <li>aucune affaire personnelle laissée dans les parties communes (y compris cellier et balcon).</li>
</ul>
<p><b>Le jour du départ :</b> restitution du badge immeuble, de la clé de l'appartement et de la clé de la boîte aux lettres ; relevé des compteurs (électricité et eau) effectué lors de l'état des lieux.</p>
<p><b>Dépôt de garantie ({{Caution}}) :</b> restitué dans un délai maximal d'1 mois après la remise des clés si l'état des lieux de sortie est conforme à celui d'entrée (2 mois en cas de retenues justifiées).</p>
<p>N'hésitez pas si vous avez la moindre question.</p>
<p>Cordialement,<br>{{Bailleur_Nom}}</p>
```

---

## 4. Déclencheur mensuel d'archivage

1. Ouvrir le Sheet → **Extensions > Apps Script**
2. Sélectionner la fonction **`installerTriggerArchivage`** → **Exécuter** (une seule fois, autoriser les droits demandés)
3. Le 1er de chaque mois vers 6h, les dossiers Drive des colocataires dont la case `Actif` est décochée sont déplacés dans `LOCATAIRES/OLD` (créé automatiquement)

L'archivage peut aussi être lancé à la demande via le menu **🗂️ Archiver les dossiers inactifs (→ OLD)**.

---

## 5. Workflow « fin de location »

1. Préavis reçu → saisir **`Date_Fin`** dans la ligne du locataire → `Dernier_Loyer` se calcule tout seul
2. Menu **📩 Répondre au préavis** → brouillon Gmail au locataire (consignes ménage + dernier loyer + déroulé sortie)
3. Menu **📧 Envoyer l'EDL à l'ami** → brouillon Gmail à ton ami avec l'EDL en Word + PDF
4. Au retour de l'EDL : saisir `Compteur_Eau_Sortie`, `Compteur_Elec_Sortie`, `Locataire_Nouvelle_Adresse` → régénérer l'EDL (les champs sortie passent en noir)
5. Quittance du mois de sortie (menu, groupée ou web app) → **détection automatique du dernier loyer** : montant `Dernier_Loyer`, période du 1er du mois au `Date_Fin`
6. ⚠️ Générer la dernière quittance **avant** de décocher `Actif` (un colocataire inactif bloque les quittances)
7. Décocher la case **`Actif`** → au prochain 1er du mois (ou via le menu), son dossier Drive part dans `LOCATAIRES/OLD`
