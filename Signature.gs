// =============================================================================
// SIGNATURE ÉLECTRONIQUE — Orchestration Documenso
// =============================================================================
//
// Couche métier au-dessus de DocumensoClient (Documenso.gs). Elle s'intègre au
// dossier locataire existant : aucun workflow parallèle, aucune fiche nouvelle.
//
// Quatre campagnes possibles pour un dossier :
//   BAIL                — le bail seul
//   EDL_ENTREE          — l'état des lieux d'entrée seul
//   EDL_SORTIE          — l'état des lieux de sortie seul
//   BAIL_ET_EDL_ENTREE  — bail + EDL d'entrée dans UNE SEULE enveloppe
//
// « Bail + état des lieux » signifie toujours bail + EDL d'ENTRÉE : la
// combinaison bail + EDL de sortie n'a pas de sens métier et est refusée.
//
// PRINCIPE CENTRAL — les Google Docs sources ne sont JAMAIS pollués.
//   Le bail et l'EDL vivent chacun dans un Google Doc de travail, généré par
//   Code.gs et modifiable par l'utilisateur (l'EDL est complété à la sortie).
//   Les balises Documenso ({{signature,r1}}…) ne sont injectées que dans une
//   COPIE TECHNIQUE jetable, à partir de marqueurs internes [[...]] présents
//   dans les modèles. Le Doc de travail reste utilisable pour la campagne
//   suivante, et le PDF d'entrée signé n'est jamais écrasé par celui de sortie.
//
// Le token API n'est JAMAIS lu ici : il vit dans les propriétés de script et
// n'est manipulé que par Documenso.gs.
// =============================================================================


// ---------------------------------------------------------------------------
// 1. CONSTANTES
// ---------------------------------------------------------------------------

/** Onglet de suivi des campagnes de signature (créé à la première demande). */
var SIGNATURE_SHEET_NAME = 'SignatureRequests';

/**
 * Colonnes de l'onglet SignatureRequests — une ligne = une campagne Documenso.
 * Les noms sont ceux du modèle de données métier, en l'état.
 */
var SIGNATURE_HEADERS = [
  'signatureRequestId', 'externalId', 'dossierId', 'tenantRow', 'locationId',
  'campaignType', 'etatDesLieuxType', 'sourceDocumentIds', 'sourceRevisionIds',
  'unsignedPdfFileIds', 'unsignedPdfHashes', 'documensoEnvelopeId',
  'bailleurRecipientId', 'locataireRecipientId', 'bailleurEmail', 'locataireEmail',
  'status', 'bailleurSigningUrl', 'bailleurSignedAt', 'locataireSignedAt',
  'completedAt', 'signedPdfFileIds', 'auditMetadataFileId',
  'lastErrorCode', 'lastErrorMessage', 'createdAt', 'updatedAt'
];

/** Statuts métier d'une campagne. */
var SIGNATURE_STATUTS = {
  DRAFT: 'DRAFT',
  PREPARING: 'PREPARING',
  AWAITING_BAILLEUR: 'AWAITING_BAILLEUR',
  AWAITING_LOCATAIRE: 'AWAITING_LOCATAIRE',
  COMPLETED: 'COMPLETED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
  ERROR: 'ERROR'
};

/** Statuts terminaux : le suivi automatique les ignore. */
var SIGNATURE_STATUTS_FINAUX = ['COMPLETED', 'REJECTED', 'CANCELLED'];

/**
 * Statuts qui interdisent une nouvelle campagne pour les mêmes documents :
 * il faut d'abord reprendre ou annuler l'existante.
 * ERROR en fait partie dès qu'une enveloppe a été créée (contrôlé à part).
 */
var SIGNATURE_STATUTS_ACTIFS = ['DRAFT', 'PREPARING', 'AWAITING_BAILLEUR', 'AWAITING_LOCATAIRE'];

/** Codes d'erreur métier, journalisés dans lastErrorCode. */
var SIGNATURE_ERREURS = {
  MARQUEUR_ABSENT: 'MARQUEUR_ABSENT',
  PLACEHOLDER_INVALIDE: 'PLACEHOLDER_INVALIDE',
  DOC_SOURCE_ABSENT: 'DOC_SOURCE_ABSENT',
  COPIE_IMPOSSIBLE: 'COPIE_IMPOSSIBLE',
  EXPORT_PDF_IMPOSSIBLE: 'EXPORT_PDF_IMPOSSIBLE',
  CHAMPS_INVALIDES: 'CHAMPS_INVALIDES',
  CREATION_ECHOUEE: 'CREATION_ECHOUEE',
  DISTRIBUTION_ECHOUEE: 'DISTRIBUTION_ECHOUEE',
  ARCHIVAGE_PARTIEL: 'ARCHIVAGE_PARTIEL',
  ARCHIVAGE_IMPOSSIBLE: 'ARCHIVAGE_IMPOSSIBLE',
  ENVELOPPE_ABSENTE: 'ENVELOPPE_ABSENTE',
  STATUT_INCONNU: 'STATUT_INCONNU',
  VERROU: 'VERROU'
};

/**
 * Campagnes proposées. `documents` liste les documents de l'enveloppe, dans
 * l'ordre d'envoi ; `edlType` fixe le bloc de signature actif de l'EDL.
 */
var SIGNATURE_CAMPAGNES = {
  BAIL: {
    libelle: 'Bail',
    documents: ['BAIL'],
    edlType: ''
  },
  EDL_ENTREE: {
    libelle: 'État des lieux d\'entrée',
    documents: ['EDL'],
    edlType: 'ENTREE'
  },
  EDL_SORTIE: {
    libelle: 'État des lieux de sortie',
    documents: ['EDL'],
    edlType: 'SORTIE'
  },
  BAIL_ET_EDL_ENTREE: {
    libelle: 'Bail + état des lieux d\'entrée',
    documents: ['BAIL', 'EDL'],
    edlType: 'ENTREE'
  }
};

/**
 * Métadonnées par document. `colonneDoc` porte l'ID du Google Doc DE TRAVAIL
 * (jamais le modèle) : c'est lui qui est copié pour produire le PDF à signer.
 */
var SIGNATURE_DOCUMENTS = {
  BAIL: {
    libelle: 'Bail',
    colonneDoc: 'ID_DOC_BAIL',
    colonnePdf: 'ID_PDF_BAIL',
    cleTemplate: 'ID_BAIL_TEMPLATE'
  },
  EDL: {
    libelle: 'État des lieux',
    colonneDoc: 'ID_DOC_EDL',
    colonnePdf: 'ID_PDF_EDL',
    cleTemplate: 'ID_EDL_TEMPLATE'
  }
};

/**
 * Marqueurs internes attendus dans les Google Docs sources, par bloc de
 * signature. Ils ne sont PAS au format {{...}} : le moteur de macros existant
 * remplacerait ou effacerait des variables {{...}} inconnues.
 *
 * Clé de bloc → { rang → { type de champ → marqueur } }
 */
var SIGNATURE_MARQUEURS = {
  BAIL: {
    r1: { SIGNATURE: '[[SIGNATURE_BAILLEUR_BAIL]]', DATE: '[[DATE_BAILLEUR_BAIL]]' },
    r2: { SIGNATURE: '[[SIGNATURE_LOCATAIRE_BAIL]]', DATE: '[[DATE_LOCATAIRE_BAIL]]' }
  },
  EDL_ENTREE: {
    r1: { SIGNATURE: '[[SIGNATURE_BAILLEUR_ENTREE]]', DATE: '[[DATE_BAILLEUR_ENTREE]]' },
    r2: { SIGNATURE: '[[SIGNATURE_LOCATAIRE_ENTREE]]', DATE: '[[DATE_LOCATAIRE_ENTREE]]' }
  },
  EDL_SORTIE: {
    r1: { SIGNATURE: '[[SIGNATURE_BAILLEUR_SORTIE]]', DATE: '[[DATE_BAILLEUR_SORTIE]]' },
    r2: { SIGNATURE: '[[SIGNATURE_LOCATAIRE_SORTIE]]', DATE: '[[DATE_LOCATAIRE_SORTIE]]' }
  }
};

/** Ordre des champs attendus dans chaque document (4 champs, r1 puis r2). */
var SIGNATURE_CHAMPS_ATTENDUS = [
  { type: 'SIGNATURE', rang: 'r1' },
  { type: 'DATE',      rang: 'r1' },
  { type: 'SIGNATURE', rang: 'r2' },
  { type: 'DATE',      rang: 'r2' }
];

/** Sous-dossiers Drive, dans le dossier du locataire. */
var SIGNATURE_DOSSIER = 'Signature';
var SIGNATURE_DOSSIER_TECHNIQUE = '_Technique';

/** Expression de validation d'email (identique à celle de la web app). */
var SIGNATURE_EMAIL_REGEX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Durée maximale d'attente du verrou anti-double-envoi (ms). */
var SIGNATURE_VERROU_MS = 20000;


// ---------------------------------------------------------------------------
// 2. HELPERS GÉNÉRAUX
// ---------------------------------------------------------------------------

/** true si l'adresse est syntaxiquement valide. */
function isEmailValide(email) {
  return SIGNATURE_EMAIL_REGEX.test((email || '').toString().trim());
}

/** true si une valeur vaut « oui » (OUI/TRUE/1/YES). */
function signatureConfigOui(val, defaut) {
  if (val === null || val === undefined || val.toString().trim() === '') return !!defaut;
  if (val === true) return true;
  if (val === false) return false;
  var s = val.toString().trim().toLowerCase();
  return s === 'oui' || s === 'true' || s === '1' || s === 'yes' || s === 'o';
}

/** Date du jour au format yyyy-MM-dd (préfixe des fichiers archivés). */
function signatureDateJour(date) {
  return Utilities.formatDate(date || new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/** Horodatage lisible pour l'onglet de suivi. */
function signatureHorodatage(date) {
  return Utilities.formatDate(date || new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm');
}

/**
 * Nom court du locataire pour les noms de fichiers : premier mot de
 * « NOM Prénom », en majuscules.
 * @param {string} nomComplet
 * @return {string} Ex. "DUPONT".
 */
function signatureNomCourt(nomComplet) {
  var s = (nomComplet || '').toString().trim();
  if (!s) return 'LOCATAIRE';
  return s.split(/\s+/)[0].toUpperCase().replace(/[^\wÀ-ÿ-]/g, '');
}

/** Slug minuscule utilisable dans un identifiant. */
function signatureSlug(valeur) {
  return (valeur === null || valeur === undefined ? '' : valeur.toString())
    .toLowerCase()
    .replace(/[àáâãäå]/g, 'a').replace(/[èéêë]/g, 'e').replace(/[ìíîï]/g, 'i')
    .replace(/[òóôõö]/g, 'o').replace(/[ùúûü]/g, 'u').replace(/[ç]/g, 'c')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Empreinte SHA-256 hexadécimale.
 * @param {string|number[]} contenu — Texte, ou octets (Blob.getBytes()).
 * @return {string} 64 caractères hexadécimaux minuscules.
 */
function signatureSha256(contenu) {
  var octets = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, contenu);
  var hex = '';
  for (var i = 0; i < octets.length; i++) {
    var v = octets[i] < 0 ? octets[i] + 256 : octets[i];
    hex += (v < 16 ? '0' : '') + v.toString(16);
  }
  return hex;
}

/** Empreinte SHA-256 du contenu binaire d'un PDF. */
function signatureEmpreintePdf(blob) {
  return signatureSha256(blob.getBytes());
}

/** true si le mode DRY_RUN est actif (option d'appel ou propriété de script). */
function signatureDryRun(options) {
  if (options && options.dryRun === true) return true;
  return signatureConfigOui(documensoProp('DOCUMENSO_DRY_RUN', ''), false);
}

/**
 * Séparateur des placeholders Documenso, entre le type et le rang.
 * Par défaut « , » sans espace ({{signature,r1}}). Surchargeable par la
 * propriété de script DOCUMENSO_PLACEHOLDER_SEPARATEUR (par exemple « ,  »)
 * si l'analyseur de Documenso venait à exiger une autre forme — sans
 * redéploiement ni modification des modèles.
 */
function signatureSeparateurPlaceholder() {
  var val = PropertiesService.getScriptProperties()
    ? PropertiesService.getScriptProperties().getProperty('DOCUMENSO_PLACEHOLDER_SEPARATEUR')
    : null;
  return (val === null || val === undefined || val === '') ? ',' : val;
}

/**
 * Placeholder Documenso pour un type de champ et un rang.
 * @param {string} type — 'SIGNATURE' ou 'DATE'.
 * @param {string} rang — 'r1' ou 'r2'.
 * @return {string} Ex. "{{signature,r1}}".
 */
function signaturePlaceholder(type, rang) {
  return '{{' + type.toLowerCase() + signatureSeparateurPlaceholder() + rang + '}}';
}

/** Lien de suivi d'une enveloppe dans l'interface Documenso. */
function signatureLienSuivi(envelopeId) {
  if (!envelopeId) return '';
  var base = documensoUrlApplication(documensoProp('DOCUMENSO_BASE_URL', DOCUMENSO_BASE_URL_DEFAUT));
  return base + '/documents/' + encodeURIComponent(envelopeId);
}

/**
 * Sérialise une correspondance clé→valeur en une cellule lisible.
 * Ex. { BAIL: 'file-1' } → "BAIL=file-1 ; EDL=file-2"
 */
function signatureSerialiserPaires(paires) {
  var out = [];
  for (var cle in paires) out.push(cle + '=' + paires[cle]);
  return out.join(' ; ');
}

/** Inverse de signatureSerialiserPaires. */
function signatureParserPaires(texte) {
  var out = {};
  var s = (texte === null || texte === undefined) ? '' : texte.toString().trim();
  if (!s) return out;
  var morceaux = s.split(';');
  for (var i = 0; i < morceaux.length; i++) {
    var m = morceaux[i].trim();
    if (!m) continue;
    var eq = m.indexOf('=');
    if (eq === -1) continue;
    out[m.substring(0, eq).trim()] = m.substring(eq + 1).trim();
  }
  return out;
}


// ---------------------------------------------------------------------------
// 3. ONGLET SignatureRequests — stockage des campagnes
// ---------------------------------------------------------------------------

/**
 * Récupère (ou crée) l'onglet de suivi des campagnes de signature.
 * @return {Sheet}
 */
function getOrCreateSignatureSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SIGNATURE_SHEET_NAME);
  if (sheet) return sheet;

  sheet = ss.insertSheet(SIGNATURE_SHEET_NAME);
  sheet.appendRow(SIGNATURE_HEADERS);
  sheet.getRange(1, 1, 1, SIGNATURE_HEADERS.length).setFontWeight('bold');
  sheet.setFrozenRows(1);
  return sheet;
}

/** Index 1-based d'une colonne de l'onglet SignatureRequests. */
function signatureColIndex(nom) {
  var i = SIGNATURE_HEADERS.indexOf(nom);
  if (i === -1) throw new Error('Colonne de suivi inconnue : ' + nom);
  return i + 1;
}

/**
 * Lit toutes les campagnes enregistrées.
 * @return {Array<Object>} Objets porteurs de toutes les colonnes + `_row`.
 */
function lireDemandesSignature() {
  var sheet = getOrCreateSignatureSheet();
  var data = sheet.getDataRange().getValues();
  var demandes = [];
  for (var r = 1; r < data.length; r++) {
    if (!data[r][signatureColIndex('signatureRequestId') - 1]) continue;
    var d = { _row: r + 1 };
    for (var c = 0; c < SIGNATURE_HEADERS.length; c++) {
      d[SIGNATURE_HEADERS[c]] = data[r][c] === undefined ? '' : data[r][c];
    }
    demandes.push(d);
  }
  return demandes;
}

/** Campagne par identifiant interne, ou null. */
function trouverDemandeParId(signatureRequestId) {
  var toutes = lireDemandesSignature();
  for (var i = 0; i < toutes.length; i++) {
    if (toutes[i]['signatureRequestId'].toString() === (signatureRequestId || '').toString()) {
      return toutes[i];
    }
  }
  return null;
}

/** Campagnes portant exactement cet identifiant externe. */
function trouverDemandesParExternalId(externalId) {
  return lireDemandesSignature().filter(function(d) {
    return d['externalId'].toString() === (externalId || '').toString();
  });
}

/**
 * Campagne reprenable pour un dossier et un type de campagne : la plus récente
 * qui n'est ni annulée ni refusée. Sert à proposer « reprendre le suivi »
 * plutôt que de créer un doublon.
 *
 * @param {string} dossierId
 * @param {string} campaignType
 * @return {Object|null}
 */
function trouverCampagnePourDossier(dossierId, campaignType) {
  var candidates = lireDemandesSignature().filter(function(d) {
    return d['dossierId'].toString() === dossierId &&
           d['campaignType'].toString() === campaignType &&
           ['REJECTED', 'CANCELLED'].indexOf(d['status'].toString().toUpperCase()) === -1;
  });
  return candidates.length ? candidates[candidates.length - 1] : null;
}

/** true si la campagne bloque la création d'une nouvelle campagne identique. */
function signatureCampagneBloquante(demande) {
  if (!demande) return false;
  var statut = (demande['status'] || '').toString().toUpperCase();
  if (SIGNATURE_STATUTS_ACTIFS.indexOf(statut) !== -1) return true;
  if (statut === SIGNATURE_STATUTS.COMPLETED) return true;
  // Une erreur ne bloque que si une enveloppe existe déjà côté Documenso :
  // sinon relancer est sans risque de doublon.
  if (statut === SIGNATURE_STATUTS.ERROR) {
    return !!(demande['documensoEnvelopeId'] || '').toString().trim();
  }
  return false;
}

/**
 * Ajoute une ligne de campagne.
 * @param {Object} valeurs — Clés = noms de colonnes.
 * @return {number} Numéro de ligne créée.
 */
function enregistrerDemandeSignature(valeurs) {
  var sheet = getOrCreateSignatureSheet();
  var horodatage = signatureHorodatage();
  var ligne = [];
  for (var i = 0; i < SIGNATURE_HEADERS.length; i++) {
    var nom = SIGNATURE_HEADERS[i];
    var v = valeurs[nom];
    if (nom === 'createdAt' || nom === 'updatedAt') v = v || horodatage;
    ligne.push(v === undefined || v === null ? '' : v);
  }
  sheet.appendRow(ligne);
  return sheet.getLastRow();
}

/**
 * Met à jour certaines colonnes d'une campagne. `updatedAt` est toujours
 * rafraîchi.
 * @param {number} row — Numéro de ligne dans l'onglet SignatureRequests.
 * @param {Object} patch — { nomColonne: valeur }.
 */
function majDemandeSignature(row, patch) {
  var sheet = getOrCreateSignatureSheet();
  var complet = {};
  for (var cle in patch) complet[cle] = patch[cle];
  complet['updatedAt'] = signatureHorodatage();
  for (var c in complet) {
    var v = complet[c];
    sheet.getRange(row, signatureColIndex(c)).setValue(v === undefined || v === null ? '' : v);
  }
}

/**
 * Reflète l'identifiant de campagne sur la ligne du locataire, si la colonne
 * optionnelle existe (silencieux sinon — aucun schéma imposé).
 *
 * @param {Object} tenant — Locataire chargé (porte _sheet et _rowIndex).
 * @param {string} campaignType
 * @param {string} signatureRequestId
 */
function refleterCampagneSurLocataire(tenant, campaignType, signatureRequestId) {
  if (!tenant || !tenant._sheet || !tenant._rowIndex) return;
  var colonnes = signatureColonnesLocataire(campaignType);
  for (var i = 0; i < colonnes.length; i++) {
    updateTenantCellIfExists(tenant._sheet, tenant._rowIndex, colonnes[i], signatureRequestId || '');
  }
}

/**
 * Colonnes facultatives de l'onglet Locataires où retrouver la campagne de
 * chaque document. Une campagne « bail + EDL entrée » alimente les deux.
 * @param {string} campaignType
 * @return {string[]}
 */
function signatureColonnesLocataire(campaignType) {
  if (campaignType === 'BAIL') return ['bailSignatureRequestId'];
  if (campaignType === 'EDL_ENTREE') return ['entrySignatureRequestId'];
  if (campaignType === 'EDL_SORTIE') return ['exitSignatureRequestId'];
  if (campaignType === 'BAIL_ET_EDL_ENTREE') return ['bailSignatureRequestId', 'entrySignatureRequestId'];
  return [];
}


// ---------------------------------------------------------------------------
// 4. SIGNATAIRES — r1 bailleur, r2 locataire
// ---------------------------------------------------------------------------

/**
 * Construit la liste ordonnée des signataires : le bailleur signe en premier
 * (r1, signingOrder 1), le locataire ensuite (r2, signingOrder 2).
 *
 * L'ordre est une règle métier, pas une option : Documenso ne sollicite le
 * locataire qu'une fois le bailleur passé.
 *
 * @param {Object} tenant — Données locataire.
 * @param {Object} config — Données config.
 * @return {Array<{rang:string, role:string, nom:string, email:string, ordre:number}>}
 */
function resoudreSignataires(tenant, config) {
  return [
    {
      rang: 'r1',
      ordre: 1,
      role: 'bailleur',
      nom: (config['Bailleur_Nom'] || '').toString().trim(),
      email: (config['Bailleur_Email'] || '').toString().trim()
    },
    {
      rang: 'r2',
      ordre: 2,
      role: 'locataire',
      nom: (tenant['Locataire_Nom'] || '').toString().trim(),
      email: (tenant['EMAIL'] || '').toString().trim()
    }
  ];
}

/** Libellé lisible d'un signataire pour les récapitulatifs. */
function signataireLibelle(s) {
  var role = s.role === 'bailleur' ? 'Bailleur' : 'Locataire';
  return s.rang + ' · ' + role + ' · ' + (s.nom || '(sans nom)') +
         ' · ' + (s.email || '(email manquant)');
}


// ---------------------------------------------------------------------------
// 5. MARQUEURS ET COPIES TECHNIQUES
// ---------------------------------------------------------------------------

/**
 * Clé du bloc de marqueurs à activer pour un document d'une campagne.
 * @param {string} typeDoc — 'BAIL' ou 'EDL'.
 * @param {string} edlType — 'ENTREE' | 'SORTIE' | ''.
 * @return {string} Clé de SIGNATURE_MARQUEURS.
 */
function signatureBlocActif(typeDoc, edlType) {
  if (typeDoc === 'BAIL') return 'BAIL';
  if (edlType !== 'ENTREE' && edlType !== 'SORTIE') {
    throw new Error('Type d\'état des lieux manquant : précisez « entrée » ou « sortie ».');
  }
  return 'EDL_' + edlType;
}

/**
 * Blocs de marqueurs à neutraliser (remplacés par une chaîne vide) pour un
 * document donné : tous ceux du même document qui ne sont pas actifs.
 *
 * L'EDL porte les deux blocs (entrée et sortie) dans le même Doc de travail ;
 * laisser les deux actifs produirait huit champs au lieu de quatre.
 *
 * @param {string} typeDoc
 * @param {string} blocActif
 * @return {string[]} Clés de SIGNATURE_MARQUEURS.
 */
function signatureBlocsANeutraliser(typeDoc, blocActif) {
  var tous = typeDoc === 'BAIL' ? ['BAIL'] : ['EDL_ENTREE', 'EDL_SORTIE'];
  return tous.filter(function(b) { return b !== blocActif; });
}

/**
 * Injecte les placeholders Documenso dans le corps d'une COPIE technique.
 *
 * Chaque marqueur interne actif devient le placeholder correspondant ; les
 * marqueurs du bloc inactif sont effacés. Les marqueurs vivent dans les
 * cellules de signature du modèle : `replaceText` les atteint aussi bien dans
 * un tableau que dans un paragraphe, sans rien déplacer ni supprimer.
 *
 * @param {Body} body — Corps de la copie technique (jamais le Doc source).
 * @param {string} typeDoc — 'BAIL' ou 'EDL'.
 * @param {string} edlType — 'ENTREE' | 'SORTIE' | ''.
 * @return {{blocActif:string, injectes:Object, neutralises:string[]}}
 * @throws {Error} Si un marqueur actif est absent du document.
 */
function injecterPlaceholdersDocumenso(body, typeDoc, edlType) {
  var blocActif = signatureBlocActif(typeDoc, edlType);
  var texteAvant = body.getText();

  // 1. Contrôle de présence AVANT toute modification : un marqueur absent
  //    signifie un modèle non migré — on refuse plutôt que de produire un PDF
  //    sans champ de signature.
  var manquants = [];
  var bloc = SIGNATURE_MARQUEURS[blocActif];
  for (var rang in bloc) {
    for (var type in bloc[rang]) {
      if (texteAvant.indexOf(bloc[rang][type]) === -1) manquants.push(bloc[rang][type]);
    }
  }
  if (manquants.length) {
    var erreur = new Error(
      'Marqueur(s) interne(s) absent(s) du document « ' + SIGNATURE_DOCUMENTS[typeDoc].libelle +
      ' » : ' + manquants.join(', ') + '.\n' +
      'Ajoutez-les dans les cellules de signature du modèle Google Docs correspondant ' +
      '(voir docs/documenso.md § « Migration des modèles Google Docs »), puis régénérez le ' +
      'document. Aucune demande de signature n\'a été créée.');
    erreur.codeMetier = SIGNATURE_ERREURS.MARQUEUR_ABSENT;
    throw erreur;
  }

  // 2. Injection des placeholders du bloc actif.
  var injectes = {};
  for (var r in bloc) {
    for (var t in bloc[r]) {
      var placeholder = signaturePlaceholder(t, r);
      body.replaceText(escapeRegex(bloc[r][t]), placeholder);
      injectes[bloc[r][t]] = placeholder;
    }
  }

  // 3. Neutralisation des marqueurs du bloc inactif.
  var neutralises = [];
  var autres = signatureBlocsANeutraliser(typeDoc, blocActif);
  for (var a = 0; a < autres.length; a++) {
    var inactif = SIGNATURE_MARQUEURS[autres[a]];
    for (var ri in inactif) {
      for (var ti in inactif[ri]) {
        body.replaceText(escapeRegex(inactif[ri][ti]), '');
        neutralises.push(inactif[ri][ti]);
      }
    }
  }

  return { blocActif: blocActif, injectes: injectes, neutralises: neutralises };
}

/**
 * Vérifie le texte d'une copie technique juste avant l'export PDF.
 *
 * Contrôles :
 *   • les quatre placeholders attendus, une occurrence chacun ;
 *   • aucun placeholder d'un autre rang (r3+) ;
 *   • aucun marqueur interne [[...]] restant (bloc actif comme inactif) ;
 *   • aucun placeholder coupé entre deux lignes.
 *
 * @param {string} texte — Texte complet de la copie.
 * @return {{ok:boolean, problemes:string[], detectes:string[]}}
 */
function validerCopieTechnique(texte) {
  texte = (texte || '').toString();
  var problemes = [];

  var marqueursRestants = texte.match(/\[\[[A-Z0-9_]+\]\]/g) || [];
  if (marqueursRestants.length) {
    var uniques = {};
    for (var m = 0; m < marqueursRestants.length; m++) uniques[marqueursRestants[m]] = true;
    problemes.push('Marqueur(s) interne(s) non traité(s) dans la copie : ' +
                   Object.keys(uniques).join(', ') + '.');
  }

  // Placeholder coupé : accolades déséquilibrées sur une ligne.
  var lignes = texte.split('\n');
  for (var l = 0; l < lignes.length; l++) {
    var ouvertes = (lignes[l].match(/\{\{/g) || []).length;
    var fermees = (lignes[l].match(/\}\}/g) || []).length;
    if (ouvertes !== fermees) {
      problemes.push('Placeholder coupé sur plusieurs lignes (ligne ' + (l + 1) + ' du document).');
    }
  }

  // Seuls les placeholders de signature/date de r1 et r2 sont admis. Les
  // variables {{Nom_Variable}} du moteur de macros ont déjà été remplacées
  // dans le Doc de travail : celles qui subsisteraient sont signalées.
  var detectes = texte.match(/\{\{[^{}]*\}\}/g) || [];
  var attendus = {};
  for (var i = 0; i < SIGNATURE_CHAMPS_ATTENDUS.length; i++) {
    var ch = SIGNATURE_CHAMPS_ATTENDUS[i];
    var ph = signaturePlaceholder(ch.type, ch.rang);
    attendus[ph] = true;
    var occurrences = 0;
    for (var d = 0; d < detectes.length; d++) if (detectes[d] === ph) occurrences++;
    if (occurrences === 0) {
      problemes.push('Placeholder manquant : ' + ph + '.');
    } else if (occurrences > 1) {
      problemes.push('Placeholder en double (' + occurrences + '×) : ' + ph + '.');
    }
  }

  var signales = {};
  for (var k = 0; k < detectes.length; k++) {
    if (attendus[detectes[k]] || signales[detectes[k]]) continue;
    signales[detectes[k]] = true;
    var rangHorsBornes = detectes[k].match(/^\{\{\s*\w+\s*,\s*r(\d+)\s*\}\}$/i);
    if (rangHorsBornes) {
      problemes.push('Placeholder « ' + detectes[k] + ' » : le rang r' + rangHorsBornes[1] +
                     ' ne correspond à aucun signataire (r1 = bailleur, r2 = locataire).');
    } else {
      problemes.push('Variable non remplacée dans le document : « ' + detectes[k] +
                     ' » — elle serait interprétée par Documenso.');
    }
  }

  return { ok: problemes.length === 0, problemes: problemes, detectes: detectes };
}


// ---------------------------------------------------------------------------
// 6. GÉNÉRATION DES PDF NON SIGNÉS
// ---------------------------------------------------------------------------

/** Dossier Drive des pièces de signature du locataire. */
function dossierSignature(config, nomLocataire) {
  return getOrCreateSubFolder(getOrCreateTenantFolder(config, nomLocataire), SIGNATURE_DOSSIER);
}

/** Sous-dossier des copies techniques jetables. */
function dossierTechniqueSignature(config, nomLocataire) {
  return getOrCreateSubFolder(dossierSignature(config, nomLocataire), SIGNATURE_DOSSIER_TECHNIQUE);
}

/**
 * Libellé de fichier d'un document dans une campagne.
 * @param {string} typeDoc — 'BAIL' ou 'EDL'.
 * @param {string} edlType — 'ENTREE' | 'SORTIE' | ''.
 * @return {string} 'Bail' | 'EDL_ENTREE' | 'EDL_SORTIE'.
 */
function signatureLibelleFichier(typeDoc, edlType) {
  return typeDoc === 'BAIL' ? 'Bail' : 'EDL_' + edlType;
}

/** Nom du PDF non signé : 2026-08-31_Bail_DUPONT_NON_SIGNE.pdf */
function signatureNomPdfNonSigne(typeDoc, edlType, nomLocataire, date) {
  return signatureDateJour(date) + '_' + signatureLibelleFichier(typeDoc, edlType) +
         '_' + signatureNomCourt(nomLocataire) + '_NON_SIGNE';
}

/** Nom du PDF signé : 2026-08-31_Bail_DUPONT_SIGNE.pdf */
function signatureNomPdfSigne(typeDoc, edlType, nomLocataire, date) {
  return signatureDateJour(date) + '_' + signatureLibelleFichier(typeDoc, edlType) +
         '_' + signatureNomCourt(nomLocataire) + '_SIGNE.pdf';
}

/**
 * Identifiant du Google Doc DE TRAVAIL d'un document, celui qui sera copié.
 *
 * Le bail : colonne ID_DOC_BAIL, écrite par generateLeaseDoc.
 * L'EDL   : colonne ID_DOC_EDL, avec le repli par nom de findEDLDocId — c'est
 *           le document que l'utilisateur complète pour la sortie.
 *
 * @param {string} typeDoc — 'BAIL' ou 'EDL'.
 * @param {Object} tenant
 * @param {Object} config
 * @return {string} ID du Google Doc.
 * @throws {Error} Si le document n'a pas encore été généré.
 */
function resoudreDocSource(typeDoc, tenant, config) {
  var meta = SIGNATURE_DOCUMENTS[typeDoc];
  var docId = '';

  if (typeDoc === 'EDL') {
    // findEDLDocId retombe sur une recherche par nom dans le dossier du
    // locataire ; son échec est traduit dans le vocabulaire de la signature.
    try {
      docId = (findEDLDocId(tenant, config) || '').toString().trim();
    } catch (e) {
      var errEdl = new Error(e.message + '\nAucune demande de signature n\'a été créée.');
      errEdl.codeMetier = SIGNATURE_ERREURS.DOC_SOURCE_ABSENT;
      throw errEdl;
    }
  } else {
    docId = (tenant[meta.colonneDoc] || '').toString().trim();
  }

  if (!docId) {
    // La première ligne doit se suffire à elle-même : c'est la seule reprise
    // dans la liste des blocages du récapitulatif.
    var erreur = new Error(
      'Google Doc « ' + meta.libelle + ' » introuvable (colonne ' + meta.colonneDoc +
      ' vide) — générez d\'abord le document (menu 🏠 Gestion Locataire ▸ 📄 Générer ' +
      (typeDoc === 'BAIL' ? 'le bail' : 'l\'état des lieux') + ').\n' +
      'Aucune demande de signature n\'a été créée.');
    erreur.codeMetier = SIGNATURE_ERREURS.DOC_SOURCE_ABSENT;
    throw erreur;
  }
  return docId;
}

/**
 * Produit le PDF non signé d'un document, prêt à être envoyé à Documenso.
 *
 * Séquence — le Google Doc de travail n'est jamais modifié :
 *   1. copie technique du Doc de travail dans Signature/_Technique ;
 *   2. injection des placeholders du bloc actif, neutralisation de l'autre ;
 *   3. validation du texte de la copie ;
 *   4. export PDF dans Signature/ sous le nom …_NON_SIGNE.pdf ;
 *   5. empreinte SHA-256 du PDF ;
 *   6. mise à la corbeille de la copie technique — conservée en cas d'échec
 *      avant l'export, pour permettre le diagnostic.
 *
 * @param {string} typeDoc — 'BAIL' ou 'EDL'.
 * @param {string} edlType — 'ENTREE' | 'SORTIE' | ''.
 * @param {Object} tenant
 * @param {Object} config
 * @param {Folder} dossier — Dossier de destination du PDF.
 * @param {Folder} dossierTechnique — Dossier des copies jetables.
 * @return {{type, edlType, sourceDocId, sourceRevision, copieId, pdfFile, nom, hash, texte, validation}}
 */
function preparerPdfNonSigne(typeDoc, edlType, tenant, config, dossier, dossierTechnique) {
  var meta = SIGNATURE_DOCUMENTS[typeDoc];
  var sourceDocId = resoudreDocSource(typeDoc, tenant, config);

  var sourceFile;
  try {
    sourceFile = DriveApp.getFileById(sourceDocId);
  } catch (e) {
    var errAcces = new Error('Google Doc « ' + meta.libelle + ' » inaccessible (' + sourceDocId +
                             ') : ' + e.message + '. Aucune demande de signature n\'a été créée.');
    errAcces.codeMetier = SIGNATURE_ERREURS.DOC_SOURCE_ABSENT;
    throw errAcces;
  }

  // Révision du document source : permet de détecter après coup qu'un EDL a
  // été complété entre la campagne d'entrée et celle de sortie.
  var sourceRevision = '';
  try {
    sourceRevision = Utilities.formatDate(sourceFile.getLastUpdated(),
                                          Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  } catch (eRev) {
    sourceRevision = '';
  }

  var nomPdf = signatureNomPdfNonSigne(typeDoc, edlType, tenant['Locataire_Nom']);
  var nomCopie = nomPdf + '_COPIE-TECHNIQUE';

  var copie;
  try {
    copie = sourceFile.makeCopy(nomCopie, dossierTechnique);
  } catch (e2) {
    var errCopie = new Error('Copie technique impossible pour « ' + meta.libelle + ' » : ' +
                             e2.message + '. Aucune demande de signature n\'a été créée.');
    errCopie.codeMetier = SIGNATURE_ERREURS.COPIE_IMPOSSIBLE;
    throw errCopie;
  }
  var copieId = copie.getId();

  var texte;
  try {
    var doc = DocumentApp.openById(copieId);
    var body = doc.getBody();
    injecterPlaceholdersDocumenso(body, typeDoc, edlType);
    texte = body.getText();
    doc.saveAndClose();
  } catch (e3) {
    // La copie technique est CONSERVÉE : c'est la pièce à examiner pour
    // comprendre pourquoi l'injection a échoué.
    e3.message = e3.message + '\nCopie technique conservée pour diagnostic : ' + copieId +
                 ' (dossier ' + SIGNATURE_DOSSIER + '/' + SIGNATURE_DOSSIER_TECHNIQUE + ').';
    throw e3;
  }

  var validation = validerCopieTechnique(texte);
  if (!validation.ok) {
    var errValid = new Error(
      'Placeholders Documenso incohérents dans « ' + meta.libelle + ' » :\n  • ' +
      validation.problemes.join('\n  • ') +
      '\nCopie technique conservée pour diagnostic : ' + copieId +
      '.\nAucune demande de signature n\'a été créée.');
    errValid.codeMetier = SIGNATURE_ERREURS.PLACEHOLDER_INVALIDE;
    throw errValid;
  }

  var pdfFile;
  try {
    pdfFile = createLeasePdf(copieId, nomPdf, dossier);
  } catch (e4) {
    var errPdf = new Error('Conversion PDF impossible pour « ' + meta.libelle + ' » : ' +
                           e4.message + '.\nCopie technique conservée pour diagnostic : ' +
                           copieId + '. Aucune demande de signature n\'a été créée.');
    errPdf.codeMetier = SIGNATURE_ERREURS.EXPORT_PDF_IMPOSSIBLE;
    throw errPdf;
  }

  var blob = pdfFile.getBlob();
  var hash = signatureEmpreintePdf(blob);

  // Export réussi : la copie technique n'a plus d'utilité.
  try { DriveApp.getFileById(copieId).setTrashed(true); } catch (ignore) {}

  return {
    type: typeDoc,
    edlType: edlType,
    libelle: typeDoc === 'BAIL' ? 'Bail'
             : 'État des lieux de ' + (edlType === 'SORTIE' ? 'sortie' : 'l\'entrée'),
    sourceDocId: sourceDocId,
    sourceRevision: sourceRevision,
    copieId: copieId,
    pdfFile: pdfFile,
    nom: nomPdf + '.pdf',
    hash: hash,
    texte: texte,
    validation: validation
  };
}


// ---------------------------------------------------------------------------
// 7. IDENTIFIANTS ET IDEMPOTENCE
// ---------------------------------------------------------------------------

/** Identifiant stable du dossier locataire. */
function signatureDossierId(tenant) {
  return 'L' + tenant._rowIndex + '-' + signatureSlug(tenant['Locataire_Nom']);
}

/** Identifiant du logement (adresse + chambre). */
function signatureLocationId(tenant, config) {
  return signatureSlug(config['Location_Adresse']) + '-ch' +
         (tenant['Chambre'] === undefined || tenant['Chambre'] === null ? '0' : tenant['Chambre']);
}

/**
 * Identifiant externe déterministe d'une campagne.
 *
 * Construit à partir du dossier, du logement, du type de campagne, du type
 * d'état des lieux, des empreintes SHA-256 des PDF non signés et des adresses
 * des deux signataires : deux envois du même contenu aux mêmes personnes
 * produisent le MÊME identifiant, ce qui rend le doublon détectable avant tout
 * appel API. Un contenu modifié en produit un nouveau, donc une campagne
 * légitimement distincte.
 *
 * @param {Object} elements — { dossierId, locationId, campaignType,
 *   etatDesLieuxType, pdfHashes: string[], bailleurEmail, locataireEmail }
 * @return {string}
 */
function construireExternalId(elements) {
  var source = [
    elements.dossierId,
    elements.locationId,
    elements.campaignType,
    elements.etatDesLieuxType || '',
    (elements.pdfHashes || []).join('|'),
    (elements.bailleurEmail || '').toLowerCase(),
    (elements.locataireEmail || '').toLowerCase()
  ].join('\n');
  return 'GL-' + signatureSha256(source).substring(0, 32);
}

/**
 * Identifiant interne d'une campagne : lisible, et unique par construction.
 *
 * Le suffixe est le rang de la campagne pour ce dossier et ce type — compté
 * sur les lignes déjà enregistrées. Plus fiable qu'un fragment d'UUID (dont
 * les premiers caractères ne sont pas garantis distincts) et directement
 * parlant : « SR-BAIL-L2-dupont-marie-20260831-2 » est la 2e tentative.
 *
 * @param {string} campaignType
 * @param {string} dossierId
 * @return {string}
 */
function construireSignatureRequestId(campaignType, dossierId) {
  var deja = lireDemandesSignature().filter(function(d) {
    return d['dossierId'].toString() === dossierId &&
           d['campaignType'].toString() === campaignType;
  }).length;

  var base = 'SR-' + campaignType + '-' + dossierId + '-' +
             Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd') + '-';

  // Garde-fou : si une ligne portait déjà ce rang (import manuel, ligne
  // supprimée puis recréée), on avance jusqu'au premier libre.
  var n = deja + 1;
  while (trouverDemandeParId(base + n)) n++;
  return base + n;
}


// ---------------------------------------------------------------------------
// 8. CONTEXTE, PRÉ-CONTRÔLES ET RÉCAPITULATIF
// ---------------------------------------------------------------------------

/**
 * Charge le contexte d'une campagne et refuse les combinaisons interdites.
 *
 * @param {number} row — Ligne du locataire.
 * @param {string} campaignType — Clé de SIGNATURE_CAMPAGNES.
 * @return {Object}
 */
function chargerContexteSignature(row, campaignType) {
  campaignType = (campaignType || '').toString().toUpperCase();

  // Refus explicite de la combinaison qui n'existe pas : « bail + état des
  // lieux » ne peut désigner que l'entrée.
  if (campaignType === 'BAIL_ET_EDL_SORTIE' || campaignType === 'BAIL_ET_EDL') {
    throw new Error(
      'Combinaison refusée : « bail + état des lieux » ne peut concerner que l\'état des lieux ' +
      'd\'ENTRÉE (campagne BAIL_ET_EDL_ENTREE). Le bail se signe à l\'entrée, l\'état des lieux ' +
      'de sortie en fin de location — les deux ne partent jamais ensemble.');
  }
  if (!SIGNATURE_CAMPAGNES[campaignType]) {
    throw new Error('Type de campagne inconnu : « ' + campaignType + ' ». Valeurs acceptées : ' +
                    Object.keys(SIGNATURE_CAMPAGNES).join(', ') + '.');
  }

  var tenant = getTenantByRow(row);
  var config = getConfig();
  var chambre = getChambreData(tenant['Chambre']);
  var campagne = SIGNATURE_CAMPAGNES[campaignType];
  var signataires = resoudreSignataires(tenant, config);

  return {
    tenant: tenant,
    config: config,
    chambre: chambre,
    campaignType: campaignType,
    campagne: campagne,
    documents: campagne.documents,
    etatDesLieuxType: campagne.edlType,
    signataires: signataires,
    dossierId: signatureDossierId(tenant),
    locationId: signatureLocationId(tenant, config)
  };
}

/**
 * Documents attendus dans l'enveloppe d'une campagne, dans l'ordre d'envoi,
 * avec les champs que Documenso doit détecter pour chacun.
 *
 * @param {Object} ctx — Contexte de campagne.
 * @return {Array<{cle:string, titre:string, champs:Array}>}
 */
function attendusPourCampagne(ctx) {
  return ctx.documents.map(function(typeDoc) {
    return {
      cle: typeDoc,
      titre: signatureNomPdfNonSigne(typeDoc, ctx.etatDesLieuxType, ctx.tenant['Locataire_Nom']) + '.pdf',
      champs: SIGNATURE_CHAMPS_ATTENDUS
    };
  });
}

/**
 * Contrôles préalables. Ne modifie rien, n'appelle pas l'API : construit le
 * récapitulatif affiché avant confirmation, et la liste des blocages.
 *
 * @param {Object} ctx — Contexte de chargerContexteSignature.
 * @param {Object} [options] — { dryRun: boolean }.
 * @return {{ok:boolean, blocages:string[], avertissements:string[], recap:Object, existante:Object|null}}
 */
function preflightSignature(ctx, options) {
  options = options || {};
  var dryRun = signatureDryRun(options);
  var blocages = [];
  var avertissements = [];

  // --- Documents de travail disponibles ------------------------------------
  var documentsRecap = [];
  for (var i = 0; i < ctx.documents.length; i++) {
    var typeDoc = ctx.documents[i];
    var meta = SIGNATURE_DOCUMENTS[typeDoc];
    var libelle = typeDoc === 'BAIL' ? 'Bail'
                  : 'État des lieux ' + (ctx.etatDesLieuxType === 'SORTIE' ? 'de sortie' : 'd\'entrée');
    documentsRecap.push(libelle);

    var docId = '';
    try {
      docId = resoudreDocSource(typeDoc, ctx.tenant, ctx.config);
    } catch (e) {
      blocages.push(e.message.split('\n')[0]);
      continue;
    }

    var soucis = verifierMarqueursDocument(docId, libelle, typeDoc, ctx.etatDesLieuxType);
    if (soucis) blocages.push(soucis);

    if (!(ctx.tenant[meta.colonnePdf] || '').toString().trim()) {
      avertissements.push(libelle + ' : la colonne ' + meta.colonnePdf +
                          ' est vide — le PDF de référence n\'a pas été enregistré, mais le ' +
                          'Google Doc de travail suffit pour la signature.');
    }
  }

  // --- Cohérence métier de l'état des lieux --------------------------------
  if (ctx.etatDesLieuxType === 'SORTIE' && !(ctx.tenant['Date_Fin'] || '').toString().trim()) {
    avertissements.push('Date_Fin non renseignée : vérifiez que l\'état des lieux de sortie est ' +
                        'bien complété dans le Google Doc de travail avant de l\'envoyer.');
  }

  // --- Signataires et emails ------------------------------------------------
  for (var s = 0; s < ctx.signataires.length; s++) {
    var sig = ctx.signataires[s];
    if (!sig.email) {
      blocages.push('Email manquant pour ' + sig.rang + ' (' + sig.role + ')' +
                    (sig.role === 'bailleur'
                      ? ' — renseignez la clé Config « Bailleur_Email ».'
                      : ' — renseignez la colonne EMAIL du locataire.'));
    } else if (!isEmailValide(sig.email)) {
      blocages.push('Email invalide pour ' + sig.rang + ' (' + sig.role + ') : ' + sig.email);
    }
    if (!sig.nom) avertissements.push('Nom manquant pour ' + sig.rang + ' (' + sig.role + ').');
  }
  if (ctx.signataires[0].email && ctx.signataires[1].email &&
      ctx.signataires[0].email.toLowerCase() === ctx.signataires[1].email.toLowerCase()) {
    blocages.push('Le bailleur et le locataire ont la même adresse email (' +
                  ctx.signataires[0].email + ') : Documenso ne peut pas distinguer les deux ' +
                  'signataires.');
  }

  // --- Campagne existante ---------------------------------------------------
  var existante = trouverCampagnePourDossier(ctx.dossierId, ctx.campaignType);
  var refusee = null;
  if (!existante) {
    var refusees = lireDemandesSignature().filter(function(d) {
      return d['dossierId'].toString() === ctx.dossierId &&
             d['campaignType'].toString() === ctx.campaignType;
    });
    refusee = refusees.length ? refusees[refusees.length - 1] : null;
  }

  if (existante && signatureCampagneBloquante(existante)) {
    var statutE = (existante['status'] || '').toString().toUpperCase();
    var message =
      statutE === SIGNATURE_STATUTS.COMPLETED
        ? 'Cette campagne est déjà signée (' + existante['signatureRequestId'] +
          '). Consultez les documents signés plutôt que d\'en créer une nouvelle.'
        : 'Une campagne est déjà en cours pour ces documents (statut ' + statutE +
          (existante['documensoEnvelopeId'] ? ', enveloppe ' + existante['documensoEnvelopeId'] : '') +
          '). Reprenez son suivi, ou annulez-la avant d\'en créer une nouvelle — ' +
          'sinon vous créeriez un doublon.';
    if (dryRun) avertissements.push(message);
    else blocages.push(message);
  } else if (refusee) {
    avertissements.push('Une campagne précédente a été ' +
      ((refusee['status'] || '').toString().toUpperCase() === SIGNATURE_STATUTS.REJECTED
        ? 'refusée' : 'annulée') +
      ' (' + refusee['signatureRequestId'] + '). Confirmez explicitement pour en relancer une.');
  }

  // --- Token ----------------------------------------------------------------
  if (!dryRun && !documensoTokenConfigure()) {
    blocages.push('Token Documenso absent : définissez la propriété de script DOCUMENSO_API_TOKEN ' +
                  '(Apps Script ▸ Paramètres du projet ▸ Propriétés du script), ou utilisez le ' +
                  'mode test DRY_RUN.');
  }

  var emplacement = 'LOCATAIRES/' + formatValue(ctx.tenant['Locataire_Nom']) + '/' + SIGNATURE_DOSSIER;

  var recap = {
    logement: formatValue(ctx.config['Location_Adresse']) + ' — chambre n°' +
              formatValue(ctx.tenant['Chambre']),
    locataire: formatValue(ctx.tenant['Locataire_Nom']),
    locataireEmail: ctx.signataires[1].email || '(manquant)',
    bailleur: formatValue(ctx.config['Bailleur_Nom']),
    bailleurEmail: ctx.signataires[0].email || '(manquant)',
    campaignType: ctx.campaignType,
    campagneLibelle: ctx.campagne.libelle,
    documents: documentsRecap,
    etatDesLieuxType: ctx.etatDesLieuxType || '(sans objet)',
    enveloppeUnique: ctx.documents.length > 1,
    ordre: 'Séquentiel — r1 le bailleur signe, puis r2 le locataire',
    signataires: ctx.signataires.map(function(x) {
      return { rang: x.rang, role: x.role, nom: x.nom, email: x.email, libelle: signataireLibelle(x) };
    }),
    emplacementDrive: emplacement,
    dossierId: ctx.dossierId,
    locationId: ctx.locationId,
    dryRun: dryRun,
    demandeExistante: existante ? {
      signatureRequestId: existante['signatureRequestId'],
      statut: (existante['status'] || '').toString().toUpperCase(),
      envelopeId: existante['documensoEnvelopeId'],
      creeLe: existante['createdAt']
    } : null
  };

  return {
    ok: blocages.length === 0,
    blocages: blocages,
    avertissements: avertissements,
    recap: recap,
    existante: existante || null
  };
}

/**
 * Vérifie qu'un Google Doc de travail porte les marqueurs internes du bloc de
 * signature à activer. Contrôle non destructif : le Doc n'est pas modifié.
 *
 * @param {string} docId — ID du Google Doc de travail.
 * @param {string} libelle — Nom lisible (messages).
 * @param {string} typeDoc — 'BAIL' ou 'EDL'.
 * @param {string} edlType — 'ENTREE' | 'SORTIE' | ''.
 * @return {string|null} Message de blocage, ou null.
 */
function verifierMarqueursDocument(docId, libelle, typeDoc, edlType) {
  var texte;
  try {
    texte = DocumentApp.openById(docId).getBody().getText();
  } catch (e) {
    return 'Document « ' + libelle + ' » inaccessible (' + docId + ') : ' + e.message;
  }

  var blocActif = signatureBlocActif(typeDoc, edlType);
  var bloc = SIGNATURE_MARQUEURS[blocActif];
  var manquants = [];
  for (var rang in bloc) {
    for (var type in bloc[rang]) {
      if (texte.indexOf(bloc[rang][type]) === -1) manquants.push(bloc[rang][type]);
    }
  }
  if (manquants.length) {
    return 'Document « ' + libelle + ' » : marqueur(s) ' + manquants.join(', ') +
           ' absent(s). Ajoutez-les dans les cellules de signature du modèle Google Docs, ' +
           'puis régénérez le document (voir docs/documenso.md).';
  }
  return null;
}


// ---------------------------------------------------------------------------
// 9. ENVOI EN SIGNATURE
// ---------------------------------------------------------------------------

/**
 * Prépare et envoie une campagne de signature.
 *
 * Séquence : pré-contrôles → verrou anti-double-envoi → PDF non signés
 * (placeholders validés) → contrôle d'idempotence → trace → création de
 * l'enveloppe EN BROUILLON → vérification des champs détectés → distribution →
 * récupération de l'URL de signature du bailleur.
 *
 * Aucune enveloppe n'est distribuée avant que les champs détectés
 * correspondent exactement à ce qui était attendu.
 *
 * En mode DRY_RUN : tout jusqu'à la construction du payload, puis arrêt.
 *
 * @param {number} row — Ligne du locataire.
 * @param {string} campaignType — 'BAIL' | 'EDL_ENTREE' | 'EDL_SORTIE' | 'BAIL_ET_EDL_ENTREE'.
 * @param {Object} [options] — { dryRun, confirmerReprise }.
 * @return {Object} Résultat détaillé.
 */
function envoyerDemandeSignature(row, campaignType, options) {
  options = options || {};
  var ctx = chargerContexteSignature(row, campaignType);
  var dryRun = signatureDryRun(options);

  var pre = preflightSignature(ctx, options);
  if (!pre.ok) {
    throw new Error('Envoi en signature impossible :\n  • ' + pre.blocages.join('\n  • '));
  }

  // Une campagne refusée ou annulée peut être relancée, mais jamais en
  // silence : l'utilisateur doit confirmer qu'il veut vraiment recommencer.
  if (!dryRun) {
    var precedentes = lireDemandesSignature().filter(function(d) {
      return d['dossierId'].toString() === ctx.dossierId &&
             d['campaignType'].toString() === ctx.campaignType &&
             ['REJECTED', 'CANCELLED'].indexOf((d['status'] || '').toString().toUpperCase()) !== -1;
    });
    if (precedentes.length && options.confirmerReprise !== true) {
      var derniere = precedentes[precedentes.length - 1];
      return {
        ok: false,
        confirmationRequise: true,
        statutPrecedent: (derniere['status'] || '').toString().toUpperCase(),
        signatureRequestId: derniere['signatureRequestId'],
        recap: pre.recap,
        message: 'Une campagne précédente a été ' +
          ((derniere['status'] || '').toString().toUpperCase() === SIGNATURE_STATUTS.REJECTED
            ? 'REFUSÉE' : 'ANNULÉE') + ' (' + derniere['signatureRequestId'] + ').\n' +
          'Confirmez pour en créer une nouvelle.'
      };
    }
  }

  // --- Verrou : deux clics rapprochés ne créent jamais deux enveloppes ------
  var verrou = signatureAcquerirVerrou(dryRun);
  try {
    return envoyerDemandeSignatureVerrouillee(ctx, pre, dryRun, options);
  } finally {
    if (verrou) { try { verrou.releaseLock(); } catch (ignore) {} }
  }
}

/**
 * Acquiert le verrou de script qui sérialise les envois.
 * @param {boolean} dryRun — Le mode test ne crée rien : pas de verrou.
 * @return {Lock|null}
 */
function signatureAcquerirVerrou(dryRun) {
  if (dryRun) return null;
  if (typeof LockService === 'undefined') return null;
  var verrou = LockService.getScriptLock();
  if (!verrou.tryLock(SIGNATURE_VERROU_MS)) {
    var e = new Error('Un envoi en signature est déjà en cours dans ce classeur. ' +
                      'Attendez qu\'il se termine avant de relancer — un second envoi créerait ' +
                      'une enveloppe en double.');
    e.codeMetier = SIGNATURE_ERREURS.VERROU;
    throw e;
  }
  return verrou;
}

/**
 * Corps de l'envoi, exécuté sous verrou.
 * @see envoyerDemandeSignature
 */
function envoyerDemandeSignatureVerrouillee(ctx, pre, dryRun, options) {
  // --- 1. PDF non signés ----------------------------------------------------
  var dossier = dossierSignature(ctx.config, ctx.tenant['Locataire_Nom']);
  var dossierTechnique = dossierTechniqueSignature(ctx.config, ctx.tenant['Locataire_Nom']);

  var prepares = [];
  for (var i = 0; i < ctx.documents.length; i++) {
    prepares.push(preparerPdfNonSigne(
      ctx.documents[i], ctx.etatDesLieuxType, ctx.tenant, ctx.config, dossier, dossierTechnique
    ));
  }

  // --- 2. Idempotence : identifiant externe sur le contenu réel des PDF -----
  var externalId = construireExternalId({
    dossierId: ctx.dossierId,
    locationId: ctx.locationId,
    campaignType: ctx.campaignType,
    etatDesLieuxType: ctx.etatDesLieuxType,
    pdfHashes: prepares.map(function(p) { return p.hash; }),
    bailleurEmail: ctx.signataires[0].email,
    locataireEmail: ctx.signataires[1].email
  });

  var jumelles = trouverDemandesParExternalId(externalId).filter(signatureCampagneBloquante);
  if (jumelles.length && !dryRun) {
    // Les PDF qui viennent d'être produits sont redondants : on ne laisse pas
    // de doublon dans Drive.
    for (var t = 0; t < prepares.length; t++) {
      try { prepares[t].pdfFile.setTrashed(true); } catch (ignore) {}
    }
    var jumelle = jumelles[jumelles.length - 1];
    return {
      ok: false,
      reprise: true,
      signatureRequestId: jumelle['signatureRequestId'],
      externalId: externalId,
      envelopeId: (jumelle['documensoEnvelopeId'] || '').toString(),
      statut: (jumelle['status'] || '').toString().toUpperCase(),
      recap: pre.recap,
      message: 'Campagne identique déjà enregistrée (' + jumelle['signatureRequestId'] +
               ', statut ' + jumelle['status'] + ') — aucune nouvelle enveloppe créée. ' +
               'Son suivi reprend là où il en était.'
    };
  }

  var titre = ctx.campagne.libelle + ' — ' + formatValue(ctx.tenant['Locataire_Nom']) +
              ' (chambre n°' + formatValue(ctx.tenant['Chambre']) + ')';

  var spec = {
    titre: titre,
    externalId: externalId,
    signataires: ctx.signataires.map(function(s) { return { email: s.email, nom: s.nom }; }),
    fichiers: prepares.map(function(p) { return { nom: p.nom, blob: p.pdfFile.getBlob() }; }),
    meta: {
      subject: titre,
      message: 'Bonjour, merci de signer électroniquement : ' +
               prepares.map(function(p) { return p.libelle; }).join(' et ') + '.'
    }
  };

  // --- 3. Mode test : arrêt avant tout appel réseau -------------------------
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      externalId: externalId,
      envelopeId: null,
      statut: SIGNATURE_STATUTS.DRAFT,
      recap: pre.recap,
      documents: prepares.map(function(p) {
        return {
          type: p.type,
          libelle: p.libelle,
          fichier: p.nom,
          sha256: p.hash,
          sourceDocId: p.sourceDocId,
          placeholders: p.validation.detectes
        };
      }),
      attendus: attendusPourCampagne(ctx),
      payload: signaturePayloadResume(spec),
      message: 'DRY_RUN — ' + prepares.length + ' PDF non signé(s) généré(s), empreintes ' +
               'calculées, payload construit et marqueurs validés. AUCUNE enveloppe créée, ' +
               'AUCUN email envoyé.'
    };
  }

  // --- 4. Trace AVANT tout appel réseau ------------------------------------
  var signatureRequestId = construireSignatureRequestId(ctx.campaignType, ctx.dossierId);
  var pdfIds = {};
  var pdfHashes = {};
  var sourceIds = {};
  var sourceRevisions = {};
  for (var p = 0; p < prepares.length; p++) {
    pdfIds[prepares[p].type] = prepares[p].pdfFile.getId();
    pdfHashes[prepares[p].type] = prepares[p].hash;
    sourceIds[prepares[p].type] = prepares[p].sourceDocId;
    sourceRevisions[prepares[p].type] = prepares[p].sourceRevision;
  }

  var ligne = enregistrerDemandeSignature({
    'signatureRequestId': signatureRequestId,
    'externalId': externalId,
    'dossierId': ctx.dossierId,
    'tenantRow': ctx.tenant._rowIndex,
    'locationId': ctx.locationId,
    'campaignType': ctx.campaignType,
    'etatDesLieuxType': ctx.etatDesLieuxType,
    'sourceDocumentIds': signatureSerialiserPaires(sourceIds),
    'sourceRevisionIds': signatureSerialiserPaires(sourceRevisions),
    'unsignedPdfFileIds': signatureSerialiserPaires(pdfIds),
    'unsignedPdfHashes': signatureSerialiserPaires(pdfHashes),
    'bailleurEmail': ctx.signataires[0].email,
    'locataireEmail': ctx.signataires[1].email,
    'status': SIGNATURE_STATUTS.PREPARING
  });
  refleterCampagneSurLocataire(ctx.tenant, ctx.campaignType, signatureRequestId);

  var client = new DocumensoClient();

  // --- 5. Création de l'enveloppe (BROUILLON) -------------------------------
  var creation;
  try {
    creation = client.createEnvelope(spec);
  } catch (e) {
    signatureEnregistrerErreur(ligne, e, 'création de l\'enveloppe',
                               SIGNATURE_ERREURS.CREATION_ECHOUEE, null);
    throw new Error(signatureMessageErreur(e, 'création de l\'enveloppe', null, signatureRequestId));
  }

  majDemandeSignature(ligne, { 'documensoEnvelopeId': creation.envelopeId });

  // --- 6. Vérification des champs détectés ---------------------------------
  var attendus = attendusPourCampagne(ctx);
  var enveloppe;
  try {
    enveloppe = client.getEnvelope(creation.envelopeId);
  } catch (e2) {
    signatureEnregistrerErreur(ligne, e2, 'relecture de l\'enveloppe',
                               SIGNATURE_ERREURS.CHAMPS_INVALIDES, creation.envelopeId);
    throw new Error(signatureMessageErreur(e2, 'relecture de l\'enveloppe',
                                           creation.envelopeId, signatureRequestId));
  }

  var verif = client.validateDetectedFields(enveloppe, ctx.signataires, attendus);
  if (!verif.ok) {
    var msgChamps =
      'Enveloppe ' + creation.envelopeId + ' créée EN BROUILLON mais NON distribuée : les champs ' +
      'détectés par Documenso ne correspondent pas à ce qui était attendu.\n  • ' +
      verif.problemes.join('\n  • ') +
      '\nAucun email n\'a été envoyé. Corrigez les modèles Google Docs, annulez cette enveloppe ' +
      '(🚫 Annuler une demande de signature), régénérez le document, puis relancez.';
    majDemandeSignature(ligne, {
      'status': SIGNATURE_STATUTS.ERROR,
      'lastErrorCode': SIGNATURE_ERREURS.CHAMPS_INVALIDES,
      'lastErrorMessage': msgChamps
    });
    throw new Error(msgChamps);
  }

  // --- 7. Distribution ------------------------------------------------------
  var distribution;
  try {
    distribution = client.distributeEnvelope(creation.envelopeId, spec.meta);
  } catch (e3) {
    signatureEnregistrerErreur(ligne, e3, 'distribution de l\'enveloppe',
                               SIGNATURE_ERREURS.DISTRIBUTION_ECHOUEE, creation.envelopeId);
    throw new Error(signatureMessageErreur(e3, 'distribution de l\'enveloppe',
                                           creation.envelopeId, signatureRequestId));
  }

  // --- 8. URL de signature du bailleur -------------------------------------
  var parEmail = {};
  for (var d = 0; d < distribution.destinataires.length; d++) {
    parEmail[(distribution.destinataires[d].email || '').toLowerCase()] = distribution.destinataires[d];
  }
  var destBailleur = parEmail[ctx.signataires[0].email.toLowerCase()] || null;
  var destLocataire = parEmail[ctx.signataires[1].email.toLowerCase()] || null;

  var urlBailleur = destBailleur ? destBailleur.url : '';
  if (!urlBailleur) {
    // Repli : reconstruire l'URL depuis le jeton du destinataire.
    try {
      var liens = client.getSigningLinks(creation.envelopeId);
      urlBailleur = liens[ctx.signataires[0].email.toLowerCase()] || '';
    } catch (ignoreLiens) {}
  }

  majDemandeSignature(ligne, {
    'status': SIGNATURE_STATUTS.AWAITING_BAILLEUR,
    'bailleurRecipientId': destBailleur ? destBailleur.id : '',
    'locataireRecipientId': destLocataire ? destLocataire.id : '',
    'bailleurSigningUrl': urlBailleur,
    'lastErrorCode': '',
    'lastErrorMessage': ''
  });

  return {
    ok: true,
    dryRun: false,
    signatureRequestId: signatureRequestId,
    externalId: externalId,
    envelopeId: creation.envelopeId,
    lien: signatureLienSuivi(creation.envelopeId),
    bailleurSigningUrl: urlBailleur,
    statut: SIGNATURE_STATUTS.AWAITING_BAILLEUR,
    ligneSuivi: ligne,
    recap: pre.recap,
    documents: prepares.map(function(p) {
      return { type: p.type, libelle: p.libelle, fichier: p.nom, sha256: p.hash };
    }),
    champs: verif.parDocument,
    message: '✍️ Campagne envoyée — enveloppe ' + creation.envelopeId + '\n' +
             prepares.length + ' document(s). Au bailleur de signer en premier' +
             (urlBailleur ? ' : le bouton « Signer maintenant » est actif.' :
              ' (lien de signature indisponible — utilisez l\'email Documenso).')
  };
}

/**
 * Journalise une erreur sur la ligne de campagne.
 * @param {number} ligne
 * @param {Error} e
 * @param {string} etape
 * @param {string} codeDefaut — Code métier si l'erreur n'en porte pas.
 * @param {string|null} envelopeId
 */
function signatureEnregistrerErreur(ligne, e, etape, codeDefaut, envelopeId) {
  majDemandeSignature(ligne, {
    'status': SIGNATURE_STATUTS.ERROR,
    'lastErrorCode': (e && (e.codeMetier || e.code)) || codeDefaut,
    'lastErrorMessage': signatureMessageErreur(e, etape, envelopeId)
  });
}

/**
 * Résumé du payload pour l'affichage DRY_RUN : aucun binaire, adresses email
 * masquées, aucun secret.
 * @param {Object} spec
 * @return {Object}
 */
function signaturePayloadResume(spec) {
  return {
    type: 'DOCUMENT',
    title: spec.titre,
    externalId: spec.externalId,
    signingOrder: 'SEQUENTIAL',
    recipients: spec.signataires.map(function(s, i) {
      return {
        rang: 'r' + (i + 1),
        name: s.nom,
        email: documensoMaskEmail(s.email),
        role: DOCUMENSO_ROLE_SIGNATAIRE,
        signingOrder: i + 1
      };
    }),
    files: spec.fichiers.map(function(f) { return f.nom; })
  };
}

/**
 * Message d'erreur exploitable : l'étape qui a échoué, si une enveloppe existe
 * déjà, s'il est sûr de recommencer, et l'identifiant Documenso s'il existe.
 *
 * @param {Error|DocumensoError} e
 * @param {string} etape — Étape en cours, en français.
 * @param {string} [envelopeId]
 * @param {string} [signatureRequestId]
 * @return {string}
 */
function signatureMessageErreur(e, etape, envelopeId, signatureRequestId) {
  var lignes = ['Échec à l\'étape « ' + etape + ' » : ' + (e && e.message ? e.message : e)];

  var id = envelopeId || (e && e.envelopeId) || null;
  if (id) {
    lignes.push('Enveloppe Documenso concernée : ' + id + ' — elle EXISTE côté Documenso.');
    lignes.push('Ne relancez pas l\'envoi tel quel : reprenez cette campagne, ou annulez-la ' +
                '(🚫 Annuler une demande de signature) — sinon vous créerez un doublon.');
  } else if (e && e.safeToRetry) {
    lignes.push('Aucune enveloppe n\'a été créée : vous pouvez relancer l\'envoi sans risque ' +
                'de doublon.');
  } else {
    lignes.push('Statut incertain côté Documenso : actualisez le statut (🔄) avant de relancer.');
  }

  if (signatureRequestId) lignes.push('Campagne : ' + signatureRequestId);
  if (e && (e.codeMetier || e.code)) lignes.push('Code : ' + (e.codeMetier || e.code));

  // Dernier filet : ce message est écrit dans le Sheet et affiché à l'écran ;
  // aucun secret ne doit y survivre, quelle que soit l'origine de l'erreur.
  return documensoExpurgerSecrets(lignes.join('\n'));
}


// ---------------------------------------------------------------------------
// 10. SUIVI DES CAMPAGNES
// ---------------------------------------------------------------------------

/**
 * Traduit l'état Documenso d'une enveloppe en statut métier.
 *
 * @param {Object} enveloppe — Enveloppe normalisée.
 * @param {Object} demande — Ligne de campagne (pour retrouver les deux emails).
 * @return {{statut:string|null, bailleurSigneLe:string, locataireSigneLe:string, motifRefus:string}}
 */
function mapStatutDocumenso(enveloppe, demande) {
  var statut = (enveloppe && enveloppe.statut ? enveloppe.statut : '').toUpperCase();
  var dest = (enveloppe && enveloppe.destinataires) || [];

  var emailBailleur = (demande && demande['bailleurEmail'] || '').toString().toLowerCase();
  var emailLocataire = (demande && demande['locataireEmail'] || '').toString().toLowerCase();

  function chercher(email, ordre) {
    for (var i = 0; i < dest.length; i++) {
      if (email && (dest[i].email || '').toLowerCase() === email) return dest[i];
    }
    // Repli sur signingOrder si les emails ont changé entre-temps.
    for (var j = 0; j < dest.length; j++) {
      if (dest[j].ordre === ordre) return dest[j];
    }
    return null;
  }

  var bailleur = chercher(emailBailleur, 1);
  var locataire = chercher(emailLocataire, 2);

  function estSigne(d) {
    return !!d && ['SIGNED', 'COMPLETED'].indexOf((d.statutSignature || '').toUpperCase()) !== -1;
  }
  function estRefuse(d) {
    return !!d && ['REJECTED', 'DECLINED'].indexOf((d.statutSignature || '').toUpperCase()) !== -1;
  }

  var motifRefus = '';
  if (estRefuse(bailleur)) motifRefus = 'Refus du bailleur' + (bailleur.motifRefus ? ' : ' + bailleur.motifRefus : '');
  else if (estRefuse(locataire)) motifRefus = 'Refus du locataire' + (locataire.motifRefus ? ' : ' + locataire.motifRefus : '');

  var resultat = {
    statut: null,
    bailleurSigneLe: estSigne(bailleur) ? signatureFormaterInstant(bailleur.signeLe) : '',
    locataireSigneLe: estSigne(locataire) ? signatureFormaterInstant(locataire.signeLe) : '',
    motifRefus: motifRefus
  };

  if (statut === 'COMPLETED') { resultat.statut = SIGNATURE_STATUTS.COMPLETED; return resultat; }
  if (statut === 'REJECTED' || statut === 'DECLINED') { resultat.statut = SIGNATURE_STATUTS.REJECTED; return resultat; }
  if (statut === 'CANCELLED' || statut === 'CANCELED' || statut === 'VOIDED') {
    resultat.statut = SIGNATURE_STATUTS.CANCELLED;
    return resultat;
  }
  if (motifRefus) { resultat.statut = SIGNATURE_STATUTS.REJECTED; return resultat; }

  if (statut === 'DRAFT') {
    // Aucun destinataire = enveloppe à peine créée ; sinon elle attend d'être
    // distribuée.
    resultat.statut = dest.length ? SIGNATURE_STATUTS.PREPARING : SIGNATURE_STATUTS.DRAFT;
    return resultat;
  }

  if (statut === 'PENDING' || statut === 'SENT') {
    // Le passage à COMPLETED est piloté par l'enveloppe, pas par le décompte
    // des signataires : c'est la seule condition sous laquelle Documenso sert
    // la version signée des documents, donc la seule qui permette d'archiver.
    // Documenso bascule l'enveloppe au moment même où le dernier signataire
    // valide ; la fenêtre « les deux ont signé mais l'enveloppe est encore
    // PENDING » est donc transitoire et se résorbe au passage suivant.
    resultat.statut = estSigne(bailleur)
      ? SIGNATURE_STATUTS.AWAITING_LOCATAIRE
      : SIGNATURE_STATUTS.AWAITING_BAILLEUR;
    return resultat;
  }

  return resultat;   // statut null = état Documenso non reconnu
}

/** Formate un instant renvoyé par l'API (ISO ou Date) pour l'onglet de suivi. */
function signatureFormaterInstant(valeur) {
  if (!valeur) return '';
  var d = (valeur instanceof Date) ? valeur : new Date(valeur);
  if (isNaN(d.getTime())) return valeur.toString();
  return signatureHorodatage(d);
}

/**
 * Interroge Documenso pour toutes les campagnes non finalisées, met à jour les
 * statuts, et archive les documents dès qu'une enveloppe est finalisée.
 *
 * Idempotent : une campagne déjà archivée n'est pas re-téléchargée, et un
 * appel répété ne produit aucun doublon dans Drive.
 *
 * @param {Object} [deps] — { client, filtreDossierId } — injection pour tests / vue locataire.
 * @return {{traitees:number, misesAJour:Array, erreurs:Array, rapport:string}}
 */
function actualiserStatutsSignature(deps) {
  deps = deps || {};
  var demandes = lireDemandesSignature().filter(function(d) {
    var st = (d['status'] || '').toString().toUpperCase();
    if (SIGNATURE_STATUTS_FINAUX.indexOf(st) !== -1) return false;
    if (deps.filtreDossierId && d['dossierId'].toString() !== deps.filtreDossierId) return false;
    return true;
  });

  if (!demandes.length) {
    return { traitees: 0, misesAJour: [], erreurs: [], rapport: 'Aucune campagne de signature en cours.' };
  }

  var client = deps.client || new DocumensoClient();
  var config = getConfig();
  var misesAJour = [];
  var erreurs = [];

  for (var i = 0; i < demandes.length; i++) {
    var d = demandes[i];
    var envelopeId = (d['documensoEnvelopeId'] || '').toString().trim();
    var etiquette = d['signatureRequestId'] + ' (' + d['campaignType'] + ')';
    var ancien = (d['status'] || '').toString().toUpperCase();

    if (!envelopeId) {
      majDemandeSignature(d._row, {
        'status': SIGNATURE_STATUTS.ERROR,
        'lastErrorCode': SIGNATURE_ERREURS.ENVELOPPE_ABSENTE,
        'lastErrorMessage': 'Aucune enveloppe Documenso : la campagne n\'a jamais abouti. ' +
                            'Relancer l\'envoi est sans risque de doublon.'
      });
      erreurs.push(etiquette + ' : aucune enveloppe créée.');
      continue;
    }

    try {
      var enveloppe = client.getEnvelope(envelopeId);
      var etat = mapStatutDocumenso(enveloppe, d);
      if (!etat.statut) {
        majDemandeSignature(d._row, {
          'lastErrorCode': SIGNATURE_ERREURS.STATUT_INCONNU,
          'lastErrorMessage': 'État Documenso non reconnu : « ' + enveloppe.statut + ' ».'
        });
        erreurs.push(etiquette + ' : état Documenso non reconnu (« ' + enveloppe.statut + ' »).');
        continue;
      }

      var patch = {
        'bailleurSignedAt': etat.bailleurSigneLe || d['bailleurSignedAt'] || '',
        'locataireSignedAt': etat.locataireSigneLe || d['locataireSignedAt'] || '',
        'lastErrorCode': '',
        'lastErrorMessage': ''
      };

      // L'URL de signature du bailleur peut manquer (erreur après
      // distribution) : on la récupère dès qu'elle est utile.
      if (!(d['bailleurSigningUrl'] || '').toString().trim() &&
          etat.statut === SIGNATURE_STATUTS.AWAITING_BAILLEUR) {
        try {
          var liens = client.getSigningLinks(enveloppe);
          var url = liens[(d['bailleurEmail'] || '').toString().toLowerCase()];
          if (url) patch['bailleurSigningUrl'] = url;
        } catch (ignoreLiens) {}
      }

      if (etat.statut === SIGNATURE_STATUTS.COMPLETED) {
        // L'enveloppe est signée : la campagne ne passe à COMPLETED qu'une
        // fois TOUS les PDF signés archivés dans Drive.
        var archive = archiverDocumentsSignes(client, d, config, enveloppe);
        patch['signedPdfFileIds'] = signatureSerialiserPaires(archive.fichiers);
        if (archive.auditFileId) patch['auditMetadataFileId'] = archive.auditFileId;

        if (archive.manquants.length) {
          patch['status'] = SIGNATURE_STATUTS.ERROR;
          patch['lastErrorCode'] = SIGNATURE_ERREURS.ARCHIVAGE_PARTIEL;
          patch['lastErrorMessage'] =
            'Enveloppe signée, mais archivage incomplet : ' + archive.manquants.join(', ') +
            '. Les documents manquants restent téléchargeables depuis Documenso (enveloppe ' +
            envelopeId + ') ; une nouvelle actualisation reprendra l\'archivage là où il s\'est ' +
            'arrêté.' + (archive.avertissements.length ? '\n' + archive.avertissements.join('\n') : '');
          erreurs.push(etiquette + ' : archivage partiel (' + archive.manquants.join(', ') + ').');
        } else {
          patch['status'] = SIGNATURE_STATUTS.COMPLETED;
          patch['completedAt'] = d['completedAt'] || signatureHorodatage();
        }
      } else {
        patch['status'] = etat.statut;
        if (etat.statut === SIGNATURE_STATUTS.REJECTED) {
          patch['completedAt'] = d['completedAt'] || signatureHorodatage();
          patch['lastErrorCode'] = SIGNATURE_STATUTS.REJECTED;
          patch['lastErrorMessage'] = etat.motifRefus || 'Signature refusée.';
        } else if (etat.statut === SIGNATURE_STATUTS.CANCELLED) {
          patch['completedAt'] = d['completedAt'] || signatureHorodatage();
        }
      }

      majDemandeSignature(d._row, patch);
      if (patch['status'] && patch['status'] !== ancien) {
        misesAJour.push(etiquette + ' : ' + ancien + ' → ' + patch['status']);
      }

    } catch (e) {
      majDemandeSignature(d._row, {
        'lastErrorCode': (e && (e.codeMetier || e.code)) || SIGNATURE_ERREURS.STATUT_INCONNU,
        'lastErrorMessage': signatureMessageErreur(e, 'actualisation du statut', envelopeId)
      });
      erreurs.push(etiquette + ' : ' + (e && e.message ? e.message : e));
    }
  }

  var rapport = demandes.length + ' campagne(s) en cours examinée(s).';
  if (misesAJour.length) rapport += '\n✓ ' + misesAJour.join('\n✓ ');
  if (erreurs.length) rapport += '\n✗ ' + erreurs.join('\n✗ ');
  if (!misesAJour.length && !erreurs.length) rapport += '\nAucun changement.';

  return { traitees: demandes.length, misesAJour: misesAJour, erreurs: erreurs, rapport: rapport };
}

/** Handler du déclencheur horaire (aucune UI — exécution silencieuse). */
function triggerSuiviSignatures() {
  var res = actualiserStatutsSignature();
  Logger.log('Suivi signatures : ' + res.rapport);
}

/**
 * À EXÉCUTER UNE FOIS pour installer le suivi automatique des signatures
 * (toutes les heures). Supprime les doublons éventuels avant de recréer.
 */
function installerTriggerSignatures() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'triggerSuiviSignatures') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('triggerSuiviSignatures').timeBased().everyHours(1).create();
  Logger.log('Trigger horaire installé : suivi des campagnes de signature Documenso.');
}

/** true si le déclencheur de suivi est installé. */
function signatureTriggerInstalle() {
  try {
    var triggers = ScriptApp.getProjectTriggers();
    for (var i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === 'triggerSuiviSignatures') return true;
    }
  } catch (e) { /* droits insuffisants : on ne bloque rien */ }
  return false;
}


// ---------------------------------------------------------------------------
// 11. ARCHIVAGE DES DOCUMENTS SIGNÉS
// ---------------------------------------------------------------------------

/**
 * Télécharge et archive dans Drive les PDF signés d'une enveloppe finalisée,
 * plus le certificat de signature et le journal d'audit s'ils sont
 * disponibles.
 *
 * Tous les envelopeItems sont parcourus — jamais seulement le premier. Chaque
 * fichier écrit est relu pour confirmer sa création avant d'être compté comme
 * archivé, et un élément déjà archivé n'est pas re-téléchargé.
 *
 * Les PDF non signés (…_NON_SIGNE.pdf) et les Google Docs de travail restent
 * intacts : rien n'est écrasé.
 *
 * @param {DocumensoClient} client
 * @param {Object} demande — Ligne de campagne.
 * @param {Object} config
 * @param {Object} enveloppe — Enveloppe normalisée (déjà lue).
 * @return {{fichiers:Object, manquants:string[], avertissements:string[], auditFileId:string}}
 */
function archiverDocumentsSignes(client, demande, config, enveloppe) {
  var avertissements = [];
  var manquants = [];
  var dejaArchives = signatureParserPaires(demande['signedPdfFileIds']);
  var fichiers = {};
  for (var k in dejaArchives) fichiers[k] = dejaArchives[k];

  var nomLocataire = signatureNomLocataireDeDemande(demande);
  var dossier;
  try {
    dossier = dossierSignature(config, nomLocataire);
  } catch (e) {
    var err = new Error('Archivage impossible (dossier Drive du locataire « ' + nomLocataire +
                        ' ») : ' + e.message + ' — les documents restent téléchargeables ' +
                        'depuis Documenso (enveloppe ' + demande['documensoEnvelopeId'] + ').');
    err.codeMetier = SIGNATURE_ERREURS.ARCHIVAGE_IMPOSSIBLE;
    throw err;
  }

  var campagne = SIGNATURE_CAMPAGNES[(demande['campaignType'] || '').toString()] ||
                 { documents: [], edlType: '' };
  var edlType = (demande['etatDesLieuxType'] || campagne.edlType || '').toString();
  var elements = enveloppe.elements || [];

  if (!elements.length) {
    avertissements.push('Aucun document listé dans l\'enveloppe ' + demande['documensoEnvelopeId'] + '.');
  }

  for (var i = 0; i < elements.length; i++) {
    var el = elements[i];
    var typeDoc = signatureTypeDocumentPourElement(el, campagne.documents, edlType, nomLocataire, i);
    var cle = typeDoc || ('DOC' + (i + 1));

    if (!el.id) {
      manquants.push(cle + ' (élément sans identifiant)');
      continue;
    }

    // Déjà archivé lors d'un passage précédent : on confirme que le fichier
    // existe toujours, sans re-télécharger.
    if (fichiers[cle]) {
      if (signatureFichierExiste(fichiers[cle])) continue;
      avertissements.push('Le fichier archivé pour ' + cle + ' a disparu de Drive : nouveau ' +
                          'téléchargement.');
      delete fichiers[cle];
    }

    var blob;
    try {
      blob = client.downloadEnvelopeItem(el.id, 'signed');
    } catch (e2) {
      manquants.push(cle);
      avertissements.push('Téléchargement impossible pour ' + cle + ' : ' + e2.message);
      continue;
    }

    var nom = typeDoc
      ? signatureNomPdfSigne(typeDoc, edlType, nomLocataire)
      : signatureDateJour() + '_' + (el.titre || cle) + '_SIGNE.pdf';

    try {
      var fichier = dossier.createFile(blob.setName(nom));
      var idFichier = fichier.getId();
      // Contrôle explicite : le fichier Drive a-t-il réellement été créé ?
      if (!signatureFichierExiste(idFichier)) {
        manquants.push(cle);
        avertissements.push('Le fichier ' + nom + ' n\'a pas pu être relu après écriture.');
        continue;
      }
      fichiers[cle] = idFichier;
    } catch (e3) {
      manquants.push(cle);
      avertissements.push('Écriture Drive impossible pour ' + nom + ' : ' + e3.message);
    }
  }

  // Certificat et journal d'audit : utiles à l'audit, jamais bloquants.
  var auditFileId = (demande['auditMetadataFileId'] || '').toString().trim();
  if (!auditFileId) {
    var nomCourt = signatureNomCourt(nomLocataire);
    try {
      var certificat = client.downloadCertificate(demande['documensoEnvelopeId']);
      var fCert = dossier.createFile(
        certificat.setName(signatureDateJour() + '_Certificat-signature_' + nomCourt + '.pdf'));
      auditFileId = fCert.getId();
    } catch (e4) {
      avertissements.push('Certificat de signature non récupéré : ' + e4.message);
    }
    try {
      var journal = client.downloadAuditLog(demande['documensoEnvelopeId']);
      var fJournal = dossier.createFile(
        journal.setName(signatureDateJour() + '_Journal-audit_' + nomCourt + '.pdf'));
      if (!auditFileId) auditFileId = fJournal.getId();
    } catch (e5) {
      avertissements.push('Journal d\'audit non récupéré : ' + e5.message);
    }
  }

  return {
    fichiers: fichiers,
    manquants: manquants,
    avertissements: avertissements,
    auditFileId: auditFileId
  };
}

/** true si le fichier Drive existe et n'est pas à la corbeille. */
function signatureFichierExiste(fileId) {
  if (!fileId) return false;
  try {
    var f = DriveApp.getFileById(fileId);
    return !(f.isTrashed && f.isTrashed());
  } catch (e) {
    return false;
  }
}

/**
 * Type de document ('BAIL' ou 'EDL') correspondant à un envelopeItem.
 * Priorité au titre (nom du PDF envoyé), repli sur l'ordre d'envoi — jamais
 * une hypothèse sur envelopeItems[0].
 *
 * @param {Object} element — { id, titre, ordre }.
 * @param {string[]} documents — Documents de la campagne, dans l'ordre.
 * @param {string} edlType
 * @param {string} nomLocataire
 * @param {number} index
 * @return {string|null}
 */
function signatureTypeDocumentPourElement(element, documents, edlType, nomLocataire, index) {
  var titre = (element.titre || '').toString().toLowerCase();
  for (var i = 0; i < documents.length; i++) {
    var attendu = signatureNomPdfNonSigne(documents[i], edlType, nomLocataire).toLowerCase();
    if (titre && (titre === attendu || titre === attendu + '.pdf')) return documents[i];
  }
  // Repli lexical, puis positionnel.
  if (titre.indexOf('bail') !== -1) return documents.indexOf('BAIL') !== -1 ? 'BAIL' : null;
  if (titre.indexOf('edl') !== -1 || titre.indexOf('etat') !== -1 || titre.indexOf('état') !== -1) {
    return documents.indexOf('EDL') !== -1 ? 'EDL' : null;
  }
  return documents[index] || null;
}

/** Nom du locataire rattaché à une campagne (via sa ligne, avec repli). */
function signatureNomLocataireDeDemande(demande) {
  var row = parseInt(demande['tenantRow'], 10);
  if (row >= 2) {
    try { return (getTenantByRow(row)['Locataire_Nom'] || '').toString(); } catch (e) { /* ligne supprimée */ }
  }
  // Repli : le dossierId encode le nom sous forme de slug.
  return (demande['dossierId'] || '').toString().replace(/^L\d+-/, '').replace(/-/g, ' ').toUpperCase();
}


// ---------------------------------------------------------------------------
// 12. ANNULATION
// ---------------------------------------------------------------------------

/**
 * Annule une campagne côté Documenso et met le suivi à jour.
 *
 * @param {string} signatureRequestId — Identifiant interne de la campagne.
 * @param {string} [motif]
 * @param {Object} [deps] — { client } — injection pour les tests.
 * @return {{ok:boolean, message:string}}
 */
function annulerDemandeSignature(signatureRequestId, motif, deps) {
  deps = deps || {};
  var cible = trouverDemandeParId(signatureRequestId);
  if (!cible) throw new Error('Campagne de signature introuvable : ' + signatureRequestId);

  var statut = (cible['status'] || '').toString().toUpperCase();
  if (SIGNATURE_STATUTS_FINAUX.indexOf(statut) !== -1) {
    throw new Error('Campagne déjà finalisée (statut ' + statut + ') — annulation impossible.');
  }

  var envelopeId = (cible['documensoEnvelopeId'] || '').toString().trim();
  if (!envelopeId) {
    majDemandeSignature(cible._row, {
      'status': SIGNATURE_STATUTS.CANCELLED,
      'completedAt': signatureHorodatage(),
      'lastErrorCode': '',
      'lastErrorMessage': ''
    });
    return { ok: true, message: 'Campagne annulée localement (aucune enveloppe n\'avait été créée).' };
  }

  var client = deps.client || new DocumensoClient();
  try {
    client.cancelEnvelope(envelopeId, motif || 'Annulation depuis Gestion Locataires');
  } catch (e) {
    var msg = signatureMessageErreur(e, 'annulation de l\'enveloppe', envelopeId, signatureRequestId);
    majDemandeSignature(cible._row, {
      'lastErrorCode': (e && (e.codeMetier || e.code)) || SIGNATURE_ERREURS.STATUT_INCONNU,
      'lastErrorMessage': msg
    });
    throw new Error(msg);
  }

  majDemandeSignature(cible._row, {
    'status': SIGNATURE_STATUTS.CANCELLED,
    'completedAt': signatureHorodatage(),
    'lastErrorCode': '',
    'lastErrorMessage': ''
  });
  return { ok: true, message: '🚫 Enveloppe ' + envelopeId + ' annulée.' };
}


// ---------------------------------------------------------------------------
// 13. ÉTAT AFFICHABLE PAR DOCUMENT
// ---------------------------------------------------------------------------

/** Libellé français d'un statut de campagne. */
var SIGNATURE_STATUT_LIBELLES = {
  NON_ENVOYE: 'Non envoyé',
  DRAFT: 'Brouillon',
  PREPARING: 'Préparation',
  AWAITING_BAILLEUR: 'En attente du bailleur',
  AWAITING_LOCATAIRE: 'En attente du locataire',
  COMPLETED: 'Signé',
  REJECTED: 'Refusé',
  CANCELLED: 'Annulé',
  ERROR: 'Erreur'
};

/**
 * Les trois lignes de statut affichées sur la fiche locataire : bail, état des
 * lieux d'entrée, état des lieux de sortie.
 *
 * Une campagne « bail + EDL entrée » alimente les deux premières lignes : c'est
 * la même enveloppe, mais l'utilisateur suit chaque document séparément.
 *
 * @param {number} row — Ligne du locataire.
 * @return {Array<Object>}
 */
function etatSignatureLocataire(row) {
  var tenant = getTenantByRow(row);
  var dossierId = signatureDossierId(tenant);
  var demandes = lireDemandesSignature().filter(function(d) {
    return d['dossierId'].toString() === dossierId;
  });

  var lignes = [
    { cle: 'BAIL',       libelle: 'Bail',                      campaignTypes: ['BAIL', 'BAIL_ET_EDL_ENTREE'], document: 'BAIL' },
    { cle: 'EDL_ENTREE', libelle: 'État des lieux d\'entrée',  campaignTypes: ['EDL_ENTREE', 'BAIL_ET_EDL_ENTREE'], document: 'EDL' },
    { cle: 'EDL_SORTIE', libelle: 'État des lieux de sortie',  campaignTypes: ['EDL_SORTIE'], document: 'EDL' }
  ];

  return lignes.map(function(ligne) {
    var pertinentes = demandes.filter(function(d) {
      return ligne.campaignTypes.indexOf(d['campaignType'].toString()) !== -1;
    });
    var courante = null;
    for (var i = pertinentes.length - 1; i >= 0; i--) {
      var st = (pertinentes[i]['status'] || '').toString().toUpperCase();
      if (st !== SIGNATURE_STATUTS.CANCELLED && st !== SIGNATURE_STATUTS.REJECTED) {
        courante = pertinentes[i];
        break;
      }
    }
    if (!courante && pertinentes.length) courante = pertinentes[pertinentes.length - 1];

    var statut = courante ? (courante['status'] || '').toString().toUpperCase() : 'NON_ENVOYE';
    var fichiersSignes = courante ? signatureParserPaires(courante['signedPdfFileIds']) : {};
    var fichierDoc = fichiersSignes[ligne.document] || '';

    return {
      cle: ligne.cle,
      libelle: ligne.libelle,
      // Campagne à lancer depuis cette ligne (le bail+EDL se choisit à part).
      campaignType: ligne.cle,
      statut: statut,
      statutLibelle: SIGNATURE_STATUT_LIBELLES[statut] || statut,
      signatureRequestId: courante ? courante['signatureRequestId'] : '',
      envelopeId: courante ? (courante['documensoEnvelopeId'] || '').toString() : '',
      lienSuivi: courante ? signatureLienSuivi(courante['documensoEnvelopeId']) : '',
      bailleurSigningUrl: courante ? (courante['bailleurSigningUrl'] || '').toString() : '',
      bailleurSignedAt: courante ? (courante['bailleurSignedAt'] || '').toString() : '',
      locataireSignedAt: courante ? (courante['locataireSignedAt'] || '').toString() : '',
      fichierSigneId: fichierDoc,
      fichierSigneUrl: fichierDoc ? 'https://drive.google.com/file/d/' + fichierDoc + '/view' : '',
      erreur: courante ? (courante['lastErrorMessage'] || '').toString() : '',
      codeErreur: courante ? (courante['lastErrorCode'] || '').toString() : '',
      actionPrincipale: signatureActionPrincipale(statut),
      actions: signatureActionsDisponibles(statut, !!fichierDoc)
    };
  });
}

/**
 * Action principale proposée pour un statut — c'est elle qui pilote le libellé
 * du bouton mis en avant sur la fiche.
 * @param {string} statut
 * @return {{cle:string, libelle:string}}
 */
function signatureActionPrincipale(statut) {
  switch (statut) {
    case SIGNATURE_STATUTS.AWAITING_BAILLEUR:
      return { cle: 'SIGNER', libelle: 'Signer maintenant' };
    case SIGNATURE_STATUTS.AWAITING_LOCATAIRE:
      return { cle: 'ACTUALISER', libelle: 'En attente du locataire — Actualiser' };
    case SIGNATURE_STATUTS.COMPLETED:
      return { cle: 'TELECHARGER', libelle: 'Télécharger le document signé' };
    case SIGNATURE_STATUTS.ERROR:
      return { cle: 'REPRENDRE', libelle: 'Reprendre la campagne' };
    case SIGNATURE_STATUTS.DRAFT:
    case SIGNATURE_STATUTS.PREPARING:
      return { cle: 'ACTUALISER', libelle: 'Actualiser' };
    default:
      return { cle: 'ENVOYER', libelle: 'Envoyer en signature' };
  }
}

/** Actions secondaires disponibles pour un statut. */
function signatureActionsDisponibles(statut, aFichierSigne) {
  var actions = [];
  if (['NON_ENVOYE', 'REJECTED', 'CANCELLED'].indexOf(statut) !== -1) actions.push('ENVOYER');
  if (statut === SIGNATURE_STATUTS.AWAITING_BAILLEUR) actions.push('SIGNER');
  if (SIGNATURE_STATUTS_FINAUX.indexOf(statut) === -1 && statut !== 'NON_ENVOYE') {
    actions.push('ACTUALISER');
    actions.push('ANNULER');
  }
  if (aFichierSigne) actions.push('TELECHARGER');
  return actions;
}


// ---------------------------------------------------------------------------
// 14. WRAPPERS WEB APP (sans SpreadsheetApp.getUi())
// ---------------------------------------------------------------------------

/**
 * Métadonnées de la section « Signature électronique ».
 * Ne divulgue jamais le token — seulement sa présence.
 * @return {Object}
 */
function webGetSignatureMeta() {
  return {
    tokenConfigure: documensoTokenConfigure(),
    dryRunGlobal: signatureDryRun(),
    triggerInstalle: signatureTriggerInstalle(),
    campagnes: Object.keys(SIGNATURE_CAMPAGNES).map(function(cle) {
      return {
        cle: cle,
        libelle: SIGNATURE_CAMPAGNES[cle].libelle,
        documents: SIGNATURE_CAMPAGNES[cle].documents,
        etatDesLieuxType: SIGNATURE_CAMPAGNES[cle].edlType
      };
    })
  };
}

/**
 * État de signature des trois documents d'un locataire (fiche locataire).
 * @param {number} row
 * @return {Array<Object>}
 */
function webGetSignatureEtat(row) {
  return etatSignatureLocataire(row);
}

/**
 * Récapitulatif + blocages avant confirmation. Aucun effet de bord.
 * @param {number} row
 * @param {string} campaignType
 * @return {Object}
 */
function webPreparerSignature(row, campaignType) {
  var ctx = chargerContexteSignature(row, campaignType);
  var pre = preflightSignature(ctx, {});
  return {
    ok: pre.ok,
    blocages: pre.blocages,
    avertissements: pre.avertissements,
    recap: pre.recap
  };
}

/**
 * Envoi (ou simulation) d'une campagne depuis la web app.
 * @param {number} row
 * @param {string} campaignType
 * @param {boolean} dryRun
 * @param {boolean} confirmerReprise — true pour relancer après refus/annulation.
 * @return {Object}
 */
function webEnvoyerSignature(row, campaignType, dryRun, confirmerReprise) {
  var res = envoyerDemandeSignature(row, campaignType, {
    dryRun: dryRun === true || dryRun === 'true',
    confirmerReprise: confirmerReprise === true || confirmerReprise === 'true'
  });

  var lignes = [res.message];
  if (res.envelopeId) lignes.push('Enveloppe : ' + res.envelopeId);
  if (res.dryRun) {
    lignes.push('Signataires : ' +
      res.recap.signataires.map(function(s) { return s.libelle; }).join(' | '));
    lignes.push('PDF non signés : ' + res.documents.map(function(d) {
      return d.fichier + ' (sha256 ' + d.sha256.substring(0, 12) + '…)';
    }).join(' | '));
  }

  return {
    ok: res.ok !== false,
    dryRun: !!res.dryRun,
    reprise: !!res.reprise,
    confirmationRequise: !!res.confirmationRequise,
    signatureRequestId: res.signatureRequestId || '',
    envelopeId: res.envelopeId || '',
    bailleurSigningUrl: res.bailleurSigningUrl || '',
    statut: res.statut || '',
    message: lignes.join('\n')
  };
}

/**
 * Actualisation des statuts, éventuellement limitée à un locataire.
 * Idempotente : deux appels de suite ne changent rien de plus.
 * @param {number} [row] — Ligne du locataire, ou rien pour tout le classeur.
 * @return {{ok:boolean, message:string, etat:Array|null}}
 */
function webActualiserStatutsSignature(row) {
  var deps = {};
  if (row) deps.filtreDossierId = signatureDossierId(getTenantByRow(row));
  var res = actualiserStatutsSignature(deps);
  return {
    ok: true,
    message: '🔄 ' + res.rapport,
    etat: row ? etatSignatureLocataire(row) : null
  };
}

/**
 * URL de signature du bailleur pour une campagne (bouton « Signer maintenant »).
 * Le lien est relu depuis Documenso s'il n'a pas été conservé.
 * @param {string} signatureRequestId
 * @return {{ok:boolean, url:string, message:string}}
 */
function webGetSigningUrlBailleur(signatureRequestId) {
  var demande = trouverDemandeParId(signatureRequestId);
  if (!demande) throw new Error('Campagne introuvable : ' + signatureRequestId);

  var url = (demande['bailleurSigningUrl'] || '').toString().trim();
  if (url) return { ok: true, url: url, message: '' };

  var envelopeId = (demande['documensoEnvelopeId'] || '').toString().trim();
  if (!envelopeId) {
    return { ok: false, url: '',
             message: 'Aucune enveloppe Documenso pour cette campagne : elle n\'a jamais été ' +
                      'distribuée. Relancez l\'envoi.' };
  }

  var client = new DocumensoClient();
  var liens = client.getSigningLinks(envelopeId);
  url = liens[(demande['bailleurEmail'] || '').toString().toLowerCase()] || '';
  if (url) majDemandeSignature(demande._row, { 'bailleurSigningUrl': url });

  return {
    ok: !!url,
    url: url,
    message: url ? '' : 'Documenso n\'a pas fourni de lien de signature pour le bailleur. ' +
                        'Utilisez l\'email reçu de Documenso, ou l\'interface Documenso.'
  };
}

/**
 * Annulation depuis la web app.
 * @param {string} signatureRequestId
 * @param {string} [motif]
 * @return {{ok:boolean, message:string}}
 */
function webAnnulerSignature(signatureRequestId, motif) {
  return annulerDemandeSignature(signatureRequestId, motif);
}


// ---------------------------------------------------------------------------
// 15. ACTIONS DU MENU
// ---------------------------------------------------------------------------

/**
 * Menu : envoyer en signature, pour la ligne active.
 * Le type d'état des lieux est demandé explicitement — jamais deviné.
 */
function menuEnvoyerEnSignature() {
  var ui = SpreadsheetApp.getUi();
  try {
    var tenant = getTenantData();

    var choix = ui.prompt(
      'Envoyer en signature — documents',
      'Que faut-il envoyer pour ' + tenant['Locataire_Nom'] + ' ?\n\n' +
      '  1 — Bail\n' +
      '  2 — État des lieux d\'ENTRÉE\n' +
      '  3 — État des lieux de SORTIE\n' +
      '  4 — Bail + état des lieux d\'entrée (une seule enveloppe)\n\n' +
      'Saisissez 1, 2, 3 ou 4 (ajoutez « test » pour un essai DRY_RUN sans envoi) :',
      ui.ButtonSet.OK_CANCEL
    );
    if (choix.getSelectedButton() !== ui.Button.OK) return;

    var saisie = choix.getResponseText().trim().toLowerCase();
    var dryRun = saisie.indexOf('test') !== -1;
    var num = saisie.replace(/[^1234]/g, '').charAt(0);
    var campaignType = num === '1' ? 'BAIL'
                     : num === '2' ? 'EDL_ENTREE'
                     : num === '3' ? 'EDL_SORTIE'
                     : num === '4' ? 'BAIL_ET_EDL_ENTREE' : null;
    if (!campaignType) throw new Error('Choix invalide : saisissez 1, 2, 3 ou 4.');

    var ctx = chargerContexteSignature(tenant._rowIndex, campaignType);
    var pre = preflightSignature(ctx, { dryRun: dryRun });

    if (!pre.ok) {
      ui.alert('Envoi impossible',
        'Corrigez les points suivants :\n\n  • ' + pre.blocages.join('\n  • '),
        ui.ButtonSet.OK);
      return;
    }

    var r = pre.recap;
    var recapTexte =
      'Logement : ' + r.logement + '\n' +
      'Locataire : ' + r.locataire + ' — ' + r.locataireEmail + '\n' +
      'Bailleur : ' + r.bailleur + ' — ' + r.bailleurEmail + '\n' +
      'Documents : ' + r.documents.join(' + ') +
        (r.enveloppeUnique ? ' (une seule enveloppe)' : '') + '\n' +
      'État des lieux : ' + r.etatDesLieuxType + '\n' +
      'Ordre de signature : ' + r.ordre + '\n' +
      'Emplacement Drive : ' + r.emplacementDrive + '\n' +
      (r.demandeExistante
        ? 'Demande existante : ' + r.demandeExistante.signatureRequestId +
          ' (' + r.demandeExistante.statut + ')\n'
        : 'Demande existante : aucune\n') +
      (pre.avertissements.length ? '\n⚠️ ' + pre.avertissements.join('\n⚠️ ') + '\n' : '') +
      (dryRun ? '\n🧪 MODE TEST : les PDF seront générés, RIEN ne sera envoyé.\n' : '') +
      '\nConfirmer ' + (dryRun ? 'la simulation' : 'l\'envoi pour signature') + ' ?';

    if (ui.alert('Récapitulatif', recapTexte, ui.ButtonSet.YES_NO) !== ui.Button.YES) return;

    var res = envoyerDemandeSignature(tenant._rowIndex, campaignType, { dryRun: dryRun });

    if (res.confirmationRequise) {
      if (ui.alert('Campagne précédente ' + res.statutPrecedent,
            res.message + '\n\nCréer malgré tout une nouvelle campagne ?',
            ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
      res = envoyerDemandeSignature(tenant._rowIndex, campaignType,
                                    { dryRun: dryRun, confirmerReprise: true });
    }

    var titre = res.reprise ? 'Campagne déjà existante'
              : dryRun ? 'Simulation terminée ✓' : 'Campagne envoyée ✓';
    var corps = res.message +
      (res.bailleurSigningUrl ? '\n\nSigner maintenant (bailleur) :\n' + res.bailleurSigningUrl : '');
    ui.alert(titre, corps, ui.ButtonSet.OK);

  } catch (e) {
    ui.alert('Erreur', e.message, ui.ButtonSet.OK);
  }
}

/** Menu : interroger Documenso pour toutes les campagnes en cours. */
function menuActualiserStatutsSignature() {
  var ui = SpreadsheetApp.getUi();
  try {
    var res = actualiserStatutsSignature();
    ui.alert('Statuts de signature', res.rapport, ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Erreur', e.message, ui.ButtonSet.OK);
  }
}

/** Menu : annuler une campagne en cours. */
function menuAnnulerSignature() {
  var ui = SpreadsheetApp.getUi();
  try {
    var enCours = lireDemandesSignature().filter(function(d) {
      return SIGNATURE_STATUTS_FINAUX.indexOf((d['status'] || '').toString().toUpperCase()) === -1;
    });
    if (!enCours.length) {
      ui.alert('Annuler une campagne', 'Aucune campagne de signature en cours.', ui.ButtonSet.OK);
      return;
    }

    var liste = enCours.map(function(d, i) {
      return '  ' + (i + 1) + ' — ' + d['dossierId'] + ' · ' + d['campaignType'] +
             ' · ' + d['status'] + '\n      ' + d['signatureRequestId'];
    }).join('\n');

    var choix = ui.prompt('Annuler une campagne de signature',
      'Campagnes en cours :\n' + liste + '\n\nNuméro à annuler :',
      ui.ButtonSet.OK_CANCEL);
    if (choix.getSelectedButton() !== ui.Button.OK) return;

    var idx = parseInt(choix.getResponseText().trim(), 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= enCours.length) throw new Error('Numéro invalide.');

    var cible = enCours[idx];
    if (ui.alert('Confirmer l\'annulation',
        'Annuler la campagne ' + cible['signatureRequestId'] + ' (' + cible['campaignType'] + ') ?\n' +
        'Enveloppe : ' + (cible['documensoEnvelopeId'] || '(aucune)'),
        ui.ButtonSet.YES_NO) !== ui.Button.YES) return;

    var res = annulerDemandeSignature(cible['signatureRequestId'], 'Annulation depuis le menu Sheet');
    ui.alert('Annulation', res.message, ui.ButtonSet.OK);

  } catch (e) {
    ui.alert('Erreur', e.message, ui.ButtonSet.OK);
  }
}
