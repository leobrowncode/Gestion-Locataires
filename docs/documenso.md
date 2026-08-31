# Signature électronique — Documenso

Signature du **bail** et des **états des lieux** (entrée et sortie) par le bailleur puis le
locataire, sans serveur supplémentaire : tout tient dans Google Apps Script, un déclencheur horaire
et l'API Documenso V2.

- **Code** : [`Documenso.gs`](../Documenso.gs) (transport HTTP), [`Signature.gs`](../Signature.gs)
  (métier), section « Signature électronique » de [`Mobile.html`](../Mobile.html).
- **Suivi** : onglet `SignatureRequests` du Google Sheet, une ligne par campagne.
- **Archivage** : `LOCATAIRES/<Locataire>/Signature/` dans Drive.

---

## 1. Les quatre campagnes

| Campagne | Documents | Bloc de signature activé |
|---|---|---|
| `BAIL` | le bail | bloc bail |
| `EDL_ENTREE` | l'état des lieux | bloc entrée |
| `EDL_SORTIE` | l'état des lieux | bloc sortie |
| `BAIL_ET_EDL_ENTREE` | bail + état des lieux, **une seule enveloppe** | bloc bail + bloc entrée |

> **« Bail + état des lieux » signifie toujours bail + état des lieux d'ENTRÉE.** Le bail se signe à
> l'entrée, l'état des lieux de sortie en fin de location : la combinaison bail + EDL de sortie est
> refusée explicitement par `chargerContexteSignature`.

Le type d'état des lieux (entrée ou sortie) est **toujours demandé**, jamais déduit.

---

## 2. Migration des modèles Google Docs — à faire à la main

Les modèles vivent sur Drive, pas dans ce dépôt : **ces modifications ne sont pas incluses dans le
code et doivent être faites manuellement** avant le premier envoi. Sans elles, l'envoi est bloqué
avec un message nommant précisément le marqueur absent — jamais d'enveloppe créée à moitié.

### 2.1 Pourquoi des marqueurs `[[...]]` et non `{{...}}`

Le moteur de macros existant remplace toutes les variables `{{Nom_Variable}}` du modèle et laisse
`___` pour celles qu'il ne connaît pas. Écrire `{{signature,r1}}` directement dans un modèle le
ferait donc effacer avant même d'arriver à Documenso.

Les marqueurs internes utilisent une syntaxe que le moteur ignore : `[[SIGNATURE_BAILLEUR_BAIL]]`.
Ils traversent intacts la génération du bail et de l'état des lieux, et ne sont convertis en
placeholders Documenso que dans une **copie technique jetable**.

### 2.2 Modèle de bail (`ID_BAIL_TEMPLATE`)

Dans le tableau de signatures en fin de document :

| Cellule | Contenu à ajouter |
|---|---|
| Colonne « Le bailleur » | `[[SIGNATURE_BAILLEUR_BAIL]]` puis, en dessous, `[[DATE_BAILLEUR_BAIL]]` |
| Colonne « Le locataire » | `[[SIGNATURE_LOCATAIRE_BAIL]]` puis, en dessous, `[[DATE_LOCATAIRE_BAIL]]` |

### 2.3 Modèle d'état des lieux (`ID_EDL_TEMPLATE`)

Le document porte **deux blocs de signature** ; les deux doivent être équipés.

Bloc « POUR L'ENTRÉE » :

| Cellule | Contenu à ajouter |
|---|---|
| Le bailleur | `[[SIGNATURE_BAILLEUR_ENTREE]]` puis `[[DATE_BAILLEUR_ENTREE]]` |
| Le locataire | `[[SIGNATURE_LOCATAIRE_ENTREE]]` puis `[[DATE_LOCATAIRE_ENTREE]]` |

Bloc « POUR LA SORTIE » :

| Cellule | Contenu à ajouter |
|---|---|
| Le bailleur | `[[SIGNATURE_BAILLEUR_SORTIE]]` puis `[[DATE_BAILLEUR_SORTIE]]` |
| Le locataire | `[[SIGNATURE_LOCATAIRE_SORTIE]]` puis `[[DATE_LOCATAIRE_SORTIE]]` |

### 2.4 Règles de mise en forme — à respecter à la lettre

L'analyseur de PDF de Documenso lit du texte : un placeholder mal rendu n'est simplement pas
détecté. Pour chaque marqueur :

1. **une seule ligne** — jamais de retour à la ligne au milieu ;
2. **police standard** (Arial ou Calibri, 10–12 pt), **noir**, ni gras ni italique ;
3. **saisi d'un seul tenant** — coller le texte, ne pas le composer caractère par caractère ni
   modifier la mise en forme au milieu, ce qui découperait le texte en plusieurs éléments Docs ;
4. **dans la cellule de signature correspondante**, pas dans une zone de texte ni une image ;
5. laisser **assez de place sous le marqueur** : Documenso dessine le champ de signature à
   l'emplacement du placeholder, une cellule trop haute de 8 pt donnera un champ minuscule ;
6. **une seule occurrence** de chaque marqueur dans le document.

### 2.5 Vérifier sans rien envoyer

Une fois les modèles modifiés :

1. régénérer le bail et l'état des lieux du locataire de test (le Google Doc de travail est reconstruit) ;
2. cocher **Mode test (DRY_RUN)** dans la web app, puis lancer une campagne ;
3. le résultat liste les placeholders détectés — attendu : `{{signature,r1}}`, `{{date,r1}}`,
   `{{signature,r2}}`, `{{date,r2}}`, exactement quatre par document ;
4. ouvrir le PDF `…_NON_SIGNE.pdf` déposé dans `LOCATAIRES/<Locataire>/Signature/` et vérifier
   visuellement que les quatre placeholders y sont lisibles, non coupés, dans les bonnes cellules.

Aucune enveloppe n'est créée et aucun email n'est envoyé à cette étape.

---

## 3. Cycle de vie des documents

### 3.1 Le bail

```
Google Doc de travail (ID_DOC_BAIL, conservé par generateLeaseDoc)
  └─ copie technique  →  marqueurs bail → {{signature,rN}} / {{date,rN}}
        └─ export PDF  →  …_Bail_<NOM>_NON_SIGNE.pdf   (conservé, envoyé à Documenso)
              └─ copie technique mise à la corbeille
```

Le Google Doc source n'est jamais modifié ; le PDF signé revient sous
`…_Bail_<NOM>_SIGNE.pdf` et ne remplace pas le PDF non signé.

### 3.2 L'état des lieux — un Doc de travail, deux campagnes

L'état des lieux est **un seul Google Doc** qui sert à l'entrée puis à la sortie.

**À l'entrée** — le Doc de travail (`ID_DOC_EDL`) est copié ; dans la copie, les marqueurs
d'**entrée** deviennent des placeholders et ceux de **sortie** sont effacés. Le PDF d'entrée est
envoyé, signé, puis archivé sous `…_EDL_ENTREE_<NOM>_SIGNE.pdf`.

**À la sortie** — l'utilisateur reprend **le même Google Doc** et le complète : états de sortie,
commentaires, relevés, clés. Le système en fait une **nouvelle** copie technique ; cette fois les
marqueurs de **sortie** deviennent des placeholders et ceux d'**entrée** sont effacés. Le PDF de
sortie contient donc les données d'entrée *et* de sortie, et devient un **nouveau fichier**
`…_EDL_SORTIE_<NOM>_SIGNE.pdf`.

Garanties, vérifiées par les tests :

- le PDF d'entrée signé n'est **jamais** écrasé ;
- le Google Doc de travail reste modifiable et garde ses marqueurs ;
- aucun placeholder Documenso n'est jamais écrit dans le Doc de travail ;
- les deux campagnes ont leurs propres statuts, enveloppes et fichiers.

### 3.3 Régénérer un document déjà en signature

Régénérer le bail ou l'EDL depuis le menu ou la web app **recopie le modèle** : le Google Doc de
travail est remplacé et son identifiant réécrit sur la ligne du locataire. Tout ce qui a été saisi
à la main disparaît — pour l'EDL, les constats et relevés d'entrée dont la campagne de sortie a
besoin — et le document ne correspond plus à celui parti en signature.

`signatureBlocageRegeneration(tenant, 'BAIL'|'EDL')` interpose donc une confirmation dès qu'une
campagne **signée** (`COMPLETED`) ou **en cours** porte sur ce document :

| Contexte | Comportement |
|---|---|
| Menu du Sheet | `ui.alert` YES/NO supplémentaire listant les campagnes concernées |
| Web app | `webGenererBail` / `webGenererEDL` / `webGenererBailEtEDL` renvoient `{ ok: false, confirmationRequise: true, message }` tant que leur 3e argument `confirmerSignature` vaut `false` ; l'action est rejouée avec `true` si l'utilisateur accepte |
| « Bail + EDL » | Contrôle limité aux pièces réellement régénérées (sans `force`, celles déjà présentes sont conservées, donc rien n'est menacé) |

Une campagne `CANCELLED` ou `REJECTED` ne bloque rien. Sans campagne — et même sans onglet
`SignatureRequests` — le comportement d'origine est strictement inchangé.

### 3.4 Copies techniques

Elles sont créées dans `LOCATAIRES/<Locataire>/Signature/_Technique/`, mises à la corbeille après un
export PDF réussi, et **conservées en cas d'échec** — leur identifiant figure dans le message
d'erreur, pour ouvrir le document et voir ce qui a coincé.

---

## 4. Ordre de signature

Convention fixe, non configurable :

| Rang | Personne | `signingOrder` |
|---|---|---|
| `r1` | le bailleur (`Bailleur_Email` dans `Config`) | 1 |
| `r2` | le locataire (colonne `EMAIL`) | 2 |

L'enveloppe est créée avec `meta.signingOrder = "SEQUENTIAL"` : Documenso ne sollicite le locataire
qu'une fois le bailleur passé.

Après distribution, l'URL de signature du bailleur est conservée (`bailleurSigningUrl`) et alimente
le bouton **Signer maintenant** de la web app. Ce bouton **ouvre** la page Documenso du bailleur —
le système ne signe jamais à sa place. L'interface de signature n'est pas intégrée dans la web app
(cela demanderait un forfait supérieur) : une redirection suffit.

---

## 5. Validation des champs avant distribution

L'enveloppe est **toujours créée en brouillon**. Elle n'est distribuée que si les champs détectés par
Documenso correspondent exactement à l'attendu :

| Campagne | Champs attendus |
|---|---|
| Bail seul | 4 (signature + date, pour r1 et r2) |
| EDL d'entrée | 4, tous dans le bloc d'entrée |
| EDL de sortie | 4, tous dans le bloc de sortie |
| Bail + EDL d'entrée | 8 — 4 par `envelopeItem` |

La distribution est bloquée si un placeholder n'a pas été détecté, si le nombre de champs est
incorrect, si un champ est attribué au mauvais destinataire, si un signataire n'a aucun champ, ou si
un document attendu est absent de l'enveloppe. L'enveloppe reste alors en **brouillon** : aucun
email n'est parti, il suffit de l'annuler puis de corriger le modèle.

Les documents sont appariés par **titre** (le nom du PDF envoyé), avec repli sur l'ordre d'envoi.
Le code ne suppose jamais que `envelopeItems[0]` est l'unique document.

---

## 6. Idempotence — aucun double envoi

Trois garde-fous se cumulent :

1. **Verrou de script** (`LockService`) autour de tout l'envoi : deux clics rapprochés ne peuvent
   pas produire deux enveloppes.
2. **Pré-contrôle** : une campagne déjà en cours (ou déjà signée) pour les mêmes documents bloque la
   création d'une nouvelle et propose de reprendre son suivi.
3. **Identifiant externe déterministe**, calculé après génération des PDF :

   ```
   externalId = "GL-" + SHA256(
       dossierId + locationId + campaignType + etatDesLieuxType
     + empreintes SHA-256 des PDF non signés
     + email du bailleur + email du locataire )[:32]
   ```

   Deux envois du même contenu aux mêmes personnes produisent le même identifiant ; le doublon est
   détecté **avant** l'appel à Documenso, et les PDF fraîchement générés sont mis à la corbeille.

Comportement selon l'état de la campagne existante :

| État | Comportement |
|---|---|
| en cours | reprise du suivi, aucune nouvelle enveloppe |
| terminée | les documents signés sont affichés, nouvel envoi refusé |
| refusée / annulée | relance possible, **après confirmation explicite** |
| en erreur avec enveloppe | l'identifiant est conservé, le suivi repart de cette enveloppe |

---

## 7. Statuts

| Statut | Signification |
|---|---|
| `DRAFT` | enveloppe créée, sans destinataire |
| `PREPARING` | PDF produits, enveloppe en cours de création |
| `AWAITING_BAILLEUR` | distribuée, le bailleur n'a pas signé |
| `AWAITING_LOCATAIRE` | le bailleur a signé, le locataire pas encore |
| `COMPLETED` | signée **et** archivée dans Drive |
| `REJECTED` | refus d'un signataire |
| `CANCELLED` | annulée |
| `ERROR` | échec — `lastErrorCode` / `lastErrorMessage` donnent l'étape et l'action corrective |

`COMPLETED`, `REJECTED` et `CANCELLED` sont terminaux : le suivi horaire ne les interroge plus.

> `COMPLETED` n'est posé **qu'après** l'archivage réussi de tous les PDF signés. Un archivage
> partiel laisse la campagne en `ERROR` avec le code `ARCHIVAGE_PARTIEL` ; l'actualisation suivante
> reprend là où elle s'était arrêtée, sans re-télécharger ce qui est déjà là.

---

## 8. Configuration

### 8.1 Propriétés de script

*Apps Script ▸ ⚙️ Paramètres du projet ▸ Propriétés du script.* **Jamais dans le Google Sheet.**

| Propriété | Obligatoire | Défaut | Rôle |
|---|:---:|---|---|
| `DOCUMENSO_API_TOKEN` | oui | — | Token API Documenso (`api_…`) |
| `DOCUMENSO_BASE_URL` | non | `https://app.documenso.com/api/v2` | Instance auto-hébergée, le cas échéant |
| `DOCUMENSO_DRY_RUN` | non | `NON` | `OUI` force le mode test pour tout le script |
| `DOCUMENSO_AUTH_SCHEME` | non | `raw` | `bearer` pour préfixer le token de `Bearer ` |
| `DOCUMENSO_TIMEOUT_MS` | non | `60000` | Budget total d'un appel, reprises incluses |
| `DOCUMENSO_MAX_TENTATIVES` | non | `3` | 1 appel + 2 reprises sur erreur transitoire |
| `DOCUMENSO_PLACEHOLDER_SEPARATEUR` | non | `,` | Séparateur du placeholder (`{{signature,r1}}`) |
| `DOCUMENSO_ENDPOINT_<CLE>` | non | — | Surcharge d'un chemin d'API sans toucher au code |

Le token n'est **jamais** journalisé, ni renvoyé au navigateur, ni écrit dans une cellule : la web
app n'expose que sa *présence*. Les messages d'erreur passent par `documensoExpurgerSecrets`, qui
remplace tout ce qui ressemble à un token ou à un en-tête `Authorization`. `npm run lint` échoue si
un token `api_…` apparaît dans un fichier versionné.

### 8.2 Clés de l'onglet `Config`

| Clé | Rôle |
|---|---|
| `Bailleur_Email` | Adresse du bailleur — destinataire `r1`. **Obligatoire.** |
| `Bailleur_Nom` | Nom affiché du bailleur |
| `ID_BAIL_TEMPLATE` / `ID_EDL_TEMPLATE` | Modèles à équiper des marqueurs (cf. §2) |

### 8.3 Colonnes de l'onglet `Locataires`

| Colonne | Rôle |
|---|---|
| `ID_DOC_BAIL` | Google Doc de travail du bail — **écrit automatiquement** par `generateLeaseDoc` |
| `ID_DOC_EDL` | Google Doc de travail de l'état des lieux |
| `bailSignatureRequestId` | *(facultative)* campagne du bail |
| `entrySignatureRequestId` | *(facultative)* campagne de l'EDL d'entrée |
| `exitSignatureRequestId` | *(facultative)* campagne de l'EDL de sortie |

Les trois dernières sont écrites par `updateTenantCellIfExists` : si vous ne les créez pas, rien ne
casse, la fiche retrouve simplement les campagnes par l'onglet `SignatureRequests`.

### 8.4 Déclencheur de suivi

À exécuter **une seule fois**, depuis l'éditeur Apps Script :

```
installerTriggerSignatures()
```

Il installe `triggerSuiviSignatures` toutes les heures : les campagnes non terminales sont
interrogées, les statuts mis à jour, et les documents signés téléchargés puis archivés. La fonction
supprime d'abord les déclencheurs homonymes — la relancer ne crée jamais de doublon.

La web app signale « ⚠️ Suivi horaire non installé » tant que ce n'est pas fait. Le bouton
**🔄 Actualiser les statuts** fait le même travail à la demande, et est idempotent.

---

## 9. Mode test (DRY_RUN)

Cocher **Mode test** dans la web app, ou ajouter « test » à la saisie du menu, ou poser
`DOCUMENSO_DRY_RUN=OUI`.

En mode test le système : crée les copies techniques, injecte les placeholders, exporte les PDF,
calcule les empreintes SHA-256, résout les signataires, construit le payload et valide les
marqueurs — puis **s'arrête**. Aucune enveloppe n'est créée, aucun email envoyé, aucune ligne
écrite dans `SignatureRequests`. Le mode test fonctionne **sans token**.

Les PDF `…_NON_SIGNE.pdf` produits restent dans Drive pour relecture.

Côté tests automatisés : l'API Documenso est intégralement simulée (`tests/stubs.js`), aucun test ne
peut atteindre le réseau ni envoyer un email.

```bash
npm run lint    # syntaxe .gs et .html, absence de secrets versionnés
npm test        # suite complète, API Documenso mockée
npm run check   # les deux
```

---

## 10. Modèle de données — onglet `SignatureRequests`

Une ligne par campagne. Créé automatiquement à la première demande.

| Colonne | Contenu |
|---|---|
| `signatureRequestId` | Identifiant interne, ex. `SR-BAIL-dupont-marie-ch2-20260831-1` |
| `externalId` | Identifiant déterministe transmis à Documenso (cf. §6) |
| `dossierId` / `tenantRow` / `locationId` | Rattachement au dossier, à la ligne et au logement (cf. §10.1) |
| `campaignType` | `BAIL` / `EDL_ENTREE` / `EDL_SORTIE` / `BAIL_ET_EDL_ENTREE` |
| `etatDesLieuxType` | `ENTREE`, `SORTIE`, ou vide |
| `sourceDocumentIds` / `sourceRevisionIds` | Google Docs de travail copiés, et leur date de dernière modification |
| `unsignedPdfFileIds` / `unsignedPdfHashes` | PDF envoyés à Documenso, et leur empreinte SHA-256 |
| `documensoEnvelopeId` | Identifiant de l'enveloppe |
| `bailleurRecipientId` / `locataireRecipientId` | Identifiants Documenso des destinataires |
| `bailleurEmail` / `locataireEmail` | Adresses au moment de l'envoi |
| `status` | Cf. §7 |
| `bailleurSigningUrl` | Lien « Signer maintenant » du bailleur |
| `bailleurSignedAt` / `locataireSignedAt` / `completedAt` | Horodatages |
| `signedPdfFileIds` | PDF signés archivés, par document (`BAIL=…` ; `EDL=…`) |
| `auditMetadataFileId` | Certificat de signature / journal d'audit |
| `lastErrorCode` / `lastErrorMessage` | Dernier échec — sans jamais de secret |
| `createdAt` / `updatedAt` | Horodatages de la ligne |

---

### 10.1 Le rattachement ne passe pas par le numéro de ligne

Une campagne vit plusieurs jours ; entre-temps l'onglet `Locataires` peut être trié, complété d'une
ligne ou allégé d'une autre. Un rattachement par index de ligne se serait alors décalé : au mieux la
fiche du locataire aurait réaffiché « non envoyé » et laissé créer un doublon, au pire un PDF signé
aurait été archivé dans le dossier Drive d'un autre locataire.

- `dossierId` vaut la colonne facultative **`dossierId`** de la ligne si elle est renseignée — gelée
  au premier envoi, donc insensible à une correction de nom ou à un changement de chambre — sinon
  `<slug du nom>-ch<chambre>`.
- Les comparaisons passent toutes par `signatureMemeDossier`, qui neutralise l'ancien préfixe
  `L<ligne>-` et le suffixe de chambre : **les campagnes déjà ouvertes restent rattachées**, aucune
  reprise manuelle n'est nécessaire.
- `tenantRow` reste écrit, mais n'est qu'un raccourci : il n'est retenu que si la ligne porte
  toujours le même dossier ; sinon l'onglet est balayé pour retrouver le bon locataire.

Ajouter la colonne `dossierId` à l'onglet `Locataires` est **facultatif** et recommandé : sans elle,
renommer un locataire ou changer sa chambre pendant une campagne détacherait celle-ci.

Limite assumée : deux locataires **homonymes exacts** partageraient la même clé. Le cas échéant,
distinguer leurs dossiers dans la colonne `dossierId` (`dupont-marie-1`, `dupont-marie-2`) — seul le
suffixe `-ch<n>` est neutralisé à la comparaison.

---

## 11. Archivage Drive

Dans `LOCATAIRES/<Locataire_Nom>/Signature/` :

```
2026-08-31_Bail_DUPONT_NON_SIGNE.pdf          exactement ce qui a été envoyé
2026-08-31_Bail_DUPONT_SIGNE.pdf              version signée, téléchargée avec version=signed
2026-08-31_EDL_ENTREE_DUPONT_NON_SIGNE.pdf
2026-08-31_EDL_ENTREE_DUPONT_SIGNE.pdf
2026-08-31_EDL_SORTIE_DUPONT_NON_SIGNE.pdf
2026-08-31_EDL_SORTIE_DUPONT_SIGNE.pdf
2026-08-31_Certificat-signature_DUPONT.pdf    best effort
2026-08-31_Journal-audit_DUPONT.pdf           best effort
_Technique/                                    copies jetables (vidées après export)
```

Une enveloppe à deux documents donne **deux** PDF signés, aux noms distincts. Chaque fichier écrit
est relu pour confirmer sa création avant d'être compté comme archivé, et un document déjà archivé
n'est jamais re-téléchargé. Le certificat et le journal d'audit sont « best effort » : leur absence
n'empêche ni le passage à `COMPLETED` ni l'archivage des documents signés.

---

## 12. Erreurs traitées explicitement

| Situation | Ce que dit le système |
|---|---|
| Token absent / invalide | La propriété à corriger est nommée ; aucune enveloppe créée |
| Quota Documenso atteint | Message distinct du token invalide (l'action corrective n'est pas la même) |
| API indisponible / réseau | Reprise automatique limitée aux erreurs transitoires, jamais sur un 4xx |
| Google Doc absent ou inaccessible | Nomme la colonne vide et le menu qui génère le document |
| Copie technique ou export PDF impossible | Copie conservée, son identifiant est donné pour diagnostic |
| Marqueur interne absent | Nomme le marqueur manquant et la cellule où l'ajouter |
| Placeholder non détecté, mauvais nombre de champs, mauvais destinataire | Enveloppe laissée en brouillon, aucun email parti |
| Email absent ou invalide | Bloqué avant tout appel API |
| Enveloppe créée mais non distribuée | Identifiant conservé, avertissement explicite sur le risque de doublon |
| Campagne déjà existante | Reprise proposée plutôt qu'un doublon |
| Refus, annulation | Statut terminal, motif de refus conservé |
| Archivage partiel | Reste en `ERROR`, reprend au passage suivant |
| Déclencheur non installé | Signalé dans l'en-tête de la web app |

Chaque message indique l'étape qui a échoué, si une enveloppe existe déjà côté Documenso, s'il est
sûr de recommencer, l'identifiant Documenso quand il existe, et l'action corrective.

---

## 13. Endpoints utilisés

Relevés dans le SDK officiel `@documenso/sdk-typescript` v0.9.0, généré depuis l'OpenAPI Documenso.

| Appel | Endpoint |
|---|---|
| `createEnvelope` | `POST /envelope/create` — multipart : `payload` (JSON) + `files[]` (un par PDF) |
| `getEnvelope` | `GET /envelope/{envelopeId}` |
| `distributeEnvelope` | `POST /envelope/distribute` — renvoie `recipients[].signingUrl` |
| `downloadEnvelopeItem` | `GET /envelope/item/{envelopeItemId}/download?version=signed` |
| `downloadCertificate` | `GET /envelope/{envelopeId}/certificate/download` |
| `downloadAuditLog` | `GET /envelope/{envelopeId}/audit-log/download` |
| `cancelEnvelope` | `POST /envelope/cancel` — annulation, **pas** une suppression |

Authentification : en-tête `Authorization: api_xxxxxxxx`, **sans** préfixe `Bearer`.

Chaque chemin est surchargeable par une propriété `DOCUMENSO_ENDPOINT_<CLE>` (par exemple
`DOCUMENSO_ENDPOINT_ENVELOPECANCEL`), et les réponses sont lues de façon tolérante : une évolution
de nommage côté API se corrige sans redéployer le code.

Références : [API Documenso](https://docs.documenso.com/docs/developers/api) ·
[authentification](https://docs.documenso.com/docs/developers/getting-started/authentication) ·
[placeholders PDF](https://docs.documenso.com/docs/users/documents/advanced/pdf-placeholders) ·
[destinataires](https://docs.documenso.com/docs/developers/api/recipients) ·
[OpenAPI](https://openapi.documenso.com/reference)
