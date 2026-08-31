// =============================================================================
// SIGNATURE ÉLECTRONIQUE — Orchestration Documenso
// =============================================================================
//
// Couche métier au-dessus de DocumensoClient (Documenso.gs) :
//   • résolution des signataires (bailleur optionnel, locataire, colocataires) ;
//   • génération d'une copie « prête à signer » des documents, avec les
//     placeholders Documenso produits dynamiquement selon le nombre réel de
//     signataires (le template ne contient qu'un marqueur interne) ;
//   • validation des placeholders AVANT export PDF ;
//   • idempotence par identifiant externe déterministe ;
//   • suivi (onglet « Signatures » + déclencheur horaire) ;
//   • archivage Drive des PDF signés, du certificat et du journal d'audit.
//
// Le token API n'est JAMAIS lu ici : il vit dans les propriétés de script et
// n'est manipulé que par Documenso.gs.
// =============================================================================


// ---------------------------------------------------------------------------
// 1. CONSTANTES
// ---------------------------------------------------------------------------

/** Onglet de suivi des demandes de signature (créé à la première demande). */
var SIGNATURE_SHEET_NAME = 'Signatures';

/**
 * Colonnes de l'onglet « Signatures ». Correspondance avec le modèle demandé :
 *   Envelope_ID     → documensoEnvelopeId     Termine_Le      → signatureCompletedAt
 *   External_ID     → documensoExternalId     Documents       → signatureDocumentTypes
 *   Statut          → signatureStatus         Signataires     → signatureRecipients
 *   Demande_Le      → signatureRequestedAt     Fichiers_Signes → signedFiles
 *   Derniere_Erreur → lastSignatureError
 */
var SIGNATURE_HEADERS = [
  'Date_Creation', 'Ligne', 'Locataire_Nom', 'Chambre', 'Documents',
  'External_ID', 'Envelope_ID', 'Statut', 'Demande_Le', 'Termine_Le',
  'Signataires', 'Fichiers_Signes', 'Derniere_Erreur', 'Lien'
];

/** Statuts métier (indépendants du vocabulaire Documenso). */
var SIGNATURE_STATUTS = {
  NON_ENVOYE: 'NON_ENVOYE',
  PREPARATION: 'PREPARATION',
  EN_ATTENTE_SIGNATURE: 'EN_ATTENTE_SIGNATURE',
  PARTIELLEMENT_SIGNE: 'PARTIELLEMENT_SIGNE',
  SIGNE: 'SIGNE',
  REFUSE: 'REFUSE',
  ANNULE: 'ANNULE',
  ERREUR: 'ERREUR'
};

/** Statuts terminaux : plus aucun suivi automatique. */
var SIGNATURE_STATUTS_FINAUX = ['SIGNE', 'REFUSE', 'ANNULE'];

/** Statuts qui interdisent un nouvel envoi du même jeu de documents. */
var SIGNATURE_STATUTS_BLOQUANTS = [
  'PREPARATION', 'EN_ATTENTE_SIGNATURE', 'PARTIELLEMENT_SIGNE', 'SIGNE'
];

/**
 * Marqueur interne à placer dans les templates Google Docs, à l'endroit exact
 * où le bloc de signature doit apparaître. Il est remplacé par les
 * placeholders Documenso au moment de la génération, puis supprimé.
 */
var SIGNATURE_MARQUEUR = '[[SIGNATURES_DOCUMENSO]]';

/** Jeux de documents proposés à l'utilisateur. */
var SIGNATURE_JEUX = {
  BAIL:     { libelle: 'Bail',                    documents: ['BAIL'] },
  EDL:      { libelle: 'État des lieux',          documents: ['EDL'] },
  BAIL_EDL: { libelle: 'Bail + état des lieux',   documents: ['BAIL', 'EDL'] }
};

/** Métadonnées par type de document. */
var SIGNATURE_DOCUMENTS = {
  BAIL: {
    libelle: 'Bail',
    libelleFichier: 'Bail',
    cleTemplate: 'ID_BAIL_TEMPLATE',
    colonnePdf: 'ID_PDF_BAIL'
  },
  EDL: {
    libelle: 'État des lieux d\'entrée',
    libelleFichier: 'Etat-des-lieux-entree',
    cleTemplate: 'ID_EDL_TEMPLATE',
    colonnePdf: 'ID_PDF_EDL'
  }
};

/** Sous-dossier Drive des pièces de signature, dans le dossier du locataire. */
var SIGNATURE_DOSSIER = 'Signature';

/** Expression de validation d'email (identique à celle de la web app). */
var SIGNATURE_EMAIL_REGEX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;


// ---------------------------------------------------------------------------
// 2. HELPERS GÉNÉRAUX
// ---------------------------------------------------------------------------

/** true si l'adresse est syntaxiquement valide. */
function isEmailValide(email) {
  return SIGNATURE_EMAIL_REGEX.test((email || '').toString().trim());
}

/** true si une valeur de Config vaut « oui » (OUI/TRUE/1/YES). */
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
 * « NOM Prénom », en majuscules, espaces remplacés par des tirets.
 * @param {string} nomComplet
 * @return {string} Ex. "DUPONT".
 */
function signatureNomCourt(nomComplet) {
  var s = (nomComplet || '').toString().trim();
  if (!s) return 'LOCATAIRE';
  return s.split(/\s+/)[0].toUpperCase().replace(/[^\wÀ-ÿ-]/g, '');
}

/** Slug minuscule utilisable dans un identifiant externe. */
function signatureSlug(valeur) {
  return (valeur === null || valeur === undefined ? '' : valeur.toString())
    .toLowerCase()
    .replace(/[àáâãäå]/g, 'a').replace(/[èéêë]/g, 'e').replace(/[ìíîï]/g, 'i')
    .replace(/[òóôõö]/g, 'o').replace(/[ùúûü]/g, 'u').replace(/[ç]/g, 'c')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Empreinte MD5 hexadécimale (8 premiers caractères) d'une chaîne.
 * Sert de « documentRevision » dans l'identifiant externe : deux envois du
 * même contenu produisent le même identifiant, un contenu modifié en produit
 * un nouveau.
 * @param {string} texte
 * @return {string} 8 caractères hexadécimaux.
 */
function signatureEmpreinte(texte) {
  var octets = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, texte);
  var hex = '';
  for (var i = 0; i < octets.length && hex.length < 8; i++) {
    var v = octets[i] < 0 ? octets[i] + 256 : octets[i];
    hex += (v < 16 ? '0' : '') + v.toString(16);
  }
  return hex.substring(0, 8);
}

/** true si le mode DRY_RUN est actif (option d'appel ou propriété de script). */
function signatureDryRun(options) {
  if (options && options.dryRun === true) return true;
  var prop = documensoProp('DOCUMENSO_DRY_RUN', '');
  return signatureConfigOui(prop, false);
}

/**
 * Lien de suivi dans l'interface Documenso.
 * ⚠️ La route publique de l'application n'a pas pu être vérifiée depuis
 * l'environnement de développement : l'identifiant d'enveloppe reste la
 * référence fiable, le lien est un raccourci de confort.
 * @param {string} envelopeId
 * @return {string}
 */
function signatureLienSuivi(envelopeId) {
  if (!envelopeId) return '';
  var base = documensoProp('DOCUMENSO_BASE_URL', DOCUMENSO_BASE_URL_DEFAUT)
               .toString().replace(/\/api\/v2\/?$/, '');
  return base + '/documents/' + encodeURIComponent(envelopeId);
}


// ---------------------------------------------------------------------------
// 3. ONGLET « Signatures » — stockage du suivi
// ---------------------------------------------------------------------------

/**
 * Récupère (ou crée) l'onglet de suivi des signatures.
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

/** Index 1-based d'une colonne de l'onglet Signatures. */
function signatureColIndex(nom) {
  var i = SIGNATURE_HEADERS.indexOf(nom);
  if (i === -1) throw new Error('Colonne de suivi inconnue : ' + nom);
  return i + 1;
}

/**
 * Lit toutes les demandes de signature enregistrées.
 * @return {Array<Object>} Objets { _row, Date_Creation, ..., Lien }.
 */
function lireDemandesSignature() {
  var sheet = getOrCreateSignatureSheet();
  var data = sheet.getDataRange().getValues();
  var demandes = [];
  for (var r = 1; r < data.length; r++) {
    if (!data[r][signatureColIndex('External_ID') - 1]) continue;
    var d = { _row: r + 1 };
    for (var c = 0; c < SIGNATURE_HEADERS.length; c++) {
      d[SIGNATURE_HEADERS[c]] = data[r][c] === undefined ? '' : data[r][c];
    }
    demandes.push(d);
  }
  return demandes;
}

/**
 * Base d'un identifiant externe : suffixe de reprise « -tN » retiré.
 * @param {string} externalId
 * @return {string}
 */
function signatureExternalIdBase(externalId) {
  return (externalId || '').toString().replace(/-t\d+$/, '');
}

/**
 * Demandes existantes portant le même identifiant externe (toutes tentatives).
 * @param {string} externalIdBase
 * @return {Array<Object>}
 */
function trouverDemandesParExternalId(externalIdBase) {
  return lireDemandesSignature().filter(function(d) {
    return signatureExternalIdBase(d['External_ID']) === externalIdBase;
  });
}

/**
 * Ajoute une ligne de suivi.
 * @param {Object} valeurs — Clés = noms de colonnes de SIGNATURE_HEADERS.
 * @return {number} Numéro de ligne créée.
 */
function enregistrerDemandeSignature(valeurs) {
  var sheet = getOrCreateSignatureSheet();
  var ligne = [];
  for (var i = 0; i < SIGNATURE_HEADERS.length; i++) {
    var v = valeurs[SIGNATURE_HEADERS[i]];
    ligne.push(v === undefined || v === null ? '' : v);
  }
  sheet.appendRow(ligne);
  return sheet.getLastRow();
}

/**
 * Met à jour certaines colonnes d'une ligne de suivi.
 * @param {number} row — Numéro de ligne dans l'onglet Signatures.
 * @param {Object} patch — { NomColonne: valeur }.
 */
function majDemandeSignature(row, patch) {
  var sheet = getOrCreateSignatureSheet();
  for (var cle in patch) {
    var v = patch[cle];
    sheet.getRange(row, signatureColIndex(cle)).setValue(v === undefined || v === null ? '' : v);
  }
}

/**
 * Reflète le statut de signature sur la ligne du locataire, si les colonnes
 * optionnelles existent (silencieux sinon — aucun schéma imposé).
 * @param {Object} tenant — Locataire chargé (porte _sheet et _rowIndex).
 * @param {string} statut
 * @param {string} envelopeId
 */
function refleterStatutSurLocataire(tenant, statut, envelopeId) {
  if (!tenant || !tenant._sheet || !tenant._rowIndex) return;
  updateTenantCellIfExists(tenant._sheet, tenant._rowIndex, 'Signature_Statut', statut);
  updateTenantCellIfExists(tenant._sheet, tenant._rowIndex, 'Signature_Envelope_ID', envelopeId || '');
}


// ---------------------------------------------------------------------------
// 4. SIGNATAIRES
// ---------------------------------------------------------------------------

/**
 * Analyse la colonne facultative « Cosignataires » de l'onglet Locataires.
 * Formats acceptés, séparés par « ; » ou par retour à la ligne :
 *   NOM Prénom <email@exemple.fr>
 *   NOM Prénom email@exemple.fr
 *   email@exemple.fr
 *
 * L'ordre est rendu déterministe par un tri sur l'email : réordonner le
 * contenu de la cellule ne change donc pas l'attribution des rangs r3, r4…
 *
 * @param {*} brut — Contenu de la cellule.
 * @return {Array<{nom:string, email:string, role:string}>}
 */
function parseCosignataires(brut) {
  var texte = (brut === null || brut === undefined) ? '' : brut.toString().trim();
  if (!texte) return [];

  var entrees = texte.split(/[;\n]+/);
  var sortie = [];
  for (var i = 0; i < entrees.length; i++) {
    var e = entrees[i].trim();
    if (!e) continue;
    var m = e.match(/[^\s<>,;]+@[^\s<>,;]+/);
    if (!m) {
      sortie.push({ nom: e, email: '', role: 'colocataire' });
      continue;
    }
    var email = m[0];
    var nom = e.replace(email, '').replace(/[<>]/g, '').replace(/[,;]/g, '').trim();
    sortie.push({ nom: nom, email: email, role: 'colocataire' });
  }

  sortie.sort(function(a, b) {
    return a.email.toLowerCase() < b.email.toLowerCase() ? -1 :
           a.email.toLowerCase() > b.email.toLowerCase() ? 1 : 0;
  });
  return sortie;
}

/**
 * Construit la liste ordonnée des signataires. L'index dans le tableau donne
 * le rang Documenso : le premier élément est r1, le deuxième r2, etc.
 *
 * Convention (configurable par la clé Config « SIGNATURE_BAILLEUR ») :
 *   • SIGNATURE_BAILLEUR = OUI (défaut) → r1 = bailleur, r2 = locataire, r3+ = colocataires
 *   • SIGNATURE_BAILLEUR = NON          → r1 = locataire, r2+ = colocataires
 *
 * @param {Object} tenant — Données locataire.
 * @param {Object} config — Données config.
 * @return {Array<{rang:string, role:string, nom:string, email:string}>}
 */
function resoudreSignataires(tenant, config) {
  var signataires = [];

  if (signatureConfigOui(config['SIGNATURE_BAILLEUR'], true)) {
    signataires.push({
      role: 'bailleur',
      nom: (config['Bailleur_Nom'] || '').toString().trim(),
      email: (config['Bailleur_Email'] || '').toString().trim()
    });
  }

  signataires.push({
    role: 'locataire',
    nom: (tenant['Locataire_Nom'] || '').toString().trim(),
    email: (tenant['EMAIL'] || '').toString().trim()
  });

  var cosignataires = parseCosignataires(tenant['Cosignataires']);
  for (var i = 0; i < cosignataires.length; i++) signataires.push(cosignataires[i]);

  for (var j = 0; j < signataires.length; j++) signataires[j].rang = 'r' + (j + 1);
  return signataires;
}

/** Libellé lisible d'un signataire pour les récapitulatifs. */
function signataireLibelle(s) {
  var role = s.role === 'bailleur' ? 'Bailleur' :
             s.role === 'locataire' ? 'Locataire' : 'Colocataire';
  return s.rang + ' · ' + role + ' · ' + (s.nom || '(sans nom)') + ' · ' + (s.email || '(email manquant)');
}


// ---------------------------------------------------------------------------
// 5. IDENTIFIANT EXTERNE (idempotence)
// ---------------------------------------------------------------------------

/**
 * Identifiant externe déterministe : locationId-documentSet-documentRevision.
 *
 *   locationId       → chambre + nom du locataire (le logement est unique)
 *   documentSet      → BAIL | EDL | BAIL_EDL
 *   documentRevision → empreinte des données qui composent les documents
 *                      (identité, dates, montants, compteurs, signataires)
 *
 * Deux envois strictement identiques produisent le même identifiant : le
 * doublon est détecté avant tout appel API. Une donnée modifiée produit un
 * nouvel identifiant, donc une nouvelle demande légitime.
 *
 * @param {Object} tenant
 * @param {Object} config
 * @param {Object} chambre
 * @param {string} jeu — Clé de SIGNATURE_JEUX.
 * @param {Array<Object>} signataires
 * @return {string}
 */
function construireExternalId(tenant, config, chambre, jeu, signataires) {
  var locationId = 'ch' + (tenant['Chambre'] || '0') + '-' + signatureSlug(tenant['Locataire_Nom']);

  var revisionSource = {
    locataire: {
      nom: formatValue(tenant['Locataire_Nom']),
      naissance: formatValue(tenant['Locataire_Date']),
      lieu: formatValue(tenant['Locataire_Lieu']),
      adresse: formatValue(tenant['Locataire_Adresse']),
      debut: formatValue(tenant['Date_Début']),
      fin: formatValue(tenant['Date_Fin']),
      chambre: formatValue(tenant['Chambre']),
      compteurEau: formatValue(tenant['Compteur_Eau']),
      compteurElec: formatValue(tenant['Compteur_Elec']),
      compteurEauSortie: formatValue(tenant['Compteur_Eau_Sortie']),
      compteurElecSortie: formatValue(tenant['Compteur_Elec_Sortie']),
      nouvelleAdresse: formatValue(tenant['Locataire_Nouvelle_Adresse'])
    },
    chambre: {
      hc: formatEuro(chambre['Loyer HC']),
      charges: formatEuro(chambre['Charges']),
      cc: formatEuro(chambre['Loyer CC']),
      caution: formatEuro(chambre['Caution'])
    },
    bailleur: {
      nom: formatValue(config['Bailleur_Nom']),
      adresse: formatValue(config['Bailleur_Adresse'])
    },
    logement: formatValue(config['Location_Adresse']),
    signataires: signataires.map(function(s) { return s.rang + ':' + (s.email || '').toLowerCase(); })
  };

  return 'GL-' + locationId + '-' + jeu + '-' + signatureEmpreinte(JSON.stringify(revisionSource));
}


// ---------------------------------------------------------------------------
// 6. PLACEHOLDERS DOCUMENSO — génération et validation
// ---------------------------------------------------------------------------

/**
 * Lignes de placeholders à insérer pour un jeu de signataires.
 * Un placeholder par ligne : aucune ligne n'est assez longue pour être
 * renvoyée à la ligne par le moteur de rendu, donc aucun placeholder ne peut
 * être coupé dans le PDF.
 *
 * @param {Array<Object>} signataires
 * @return {string[]}
 */
function construireLignesPlaceholders(signataires) {
  var lignes = [];
  for (var i = 0; i < signataires.length; i++) {
    var s = signataires[i];
    var rang = 'r' + (i + 1);
    var role = s.role === 'bailleur' ? 'Le bailleur' :
               s.role === 'locataire' ? 'Le locataire' : 'Le colocataire';
    lignes.push(role + ' — ' + (s.nom || ''));
    lignes.push('Nom : {{name, ' + rang + '}}');
    lignes.push('Signature : {{signature, ' + rang + '}}');
    lignes.push('Date : {{date, ' + rang + '}}');
    lignes.push('');
  }
  return lignes;
}

/**
 * Remplace le marqueur interne du template par le bloc de placeholders
 * Documenso adapté au nombre réel de signataires, puis supprime le marqueur.
 *
 * Les paragraphes insérés sont forcés en police standard (Arial 11, noir) :
 * l'analyseur PDF de Documenso lit mal les polices exotiques, et un
 * placeholder mal rendu n'est pas détecté.
 *
 * @param {Body} body — Corps du Google Doc (copie de travail).
 * @param {Array<Object>} signataires
 * @throws {Error} Si le marqueur est absent du template.
 */
function insererBlocSignatures(body, signataires) {
  var index = findElementIndexByText(body, SIGNATURE_MARQUEUR);
  if (index === -1) {
    throw new Error(
      'Marqueur ' + SIGNATURE_MARQUEUR + ' absent du modèle Google Docs. ' +
      'Ajoutez-le sur une ligne seule, à l\'endroit où le bloc de signatures doit ' +
      'apparaître (voir docs/documenso.md § « Migration des templates »). ' +
      'Aucune demande de signature n\'a été créée.'
    );
  }

  // Le marqueur doit être un paragraphe autonome : s'il est dans un tableau,
  // la suppression du marqueur emporterait le tableau entier.
  var element = body.getChild(index);
  if (element.getType && DocumentApp.ElementType &&
      element.getType() !== DocumentApp.ElementType.PARAGRAPH) {
    throw new Error(
      'Le marqueur ' + SIGNATURE_MARQUEUR + ' doit être un paragraphe autonome, ' +
      'hors de tout tableau (il est actuellement dans un élément de type ' +
      element.getType() + '). Déplacez-le sur une ligne seule. ' +
      'Aucune demande de signature n\'a été créée.'
    );
  }

  var lignes = construireLignesPlaceholders(signataires);
  for (var i = 0; i < lignes.length; i++) {
    var para = body.insertParagraph(index + i, lignes[i]);
    para.editAsText()
        .setFontFamily('Arial')
        .setFontSize(11)
        .setForegroundColor('#000000');
  }

  // Le marqueur a été décalé de lignes.length positions.
  var indexMarqueur = index + lignes.length;
  if (indexMarqueur === body.getNumChildren() - 1) {
    // Google Docs refuse de supprimer le dernier paragraphe du corps :
    // on le vide plutôt que de laisser remonter une erreur opaque.
    body.getChild(indexMarqueur).asParagraph().setText('');
  } else {
    body.removeChild(body.getChild(indexMarqueur));
  }
}

/**
 * Supprime les variables de modèle {{...}} encore présentes après les
 * remplacements, AVANT l'insertion du bloc de signature.
 *
 * Cas réel : dans le modèle d'état des lieux, les balises de sortie
 * ({{Compteur_Eau_Sortie}}, {{Locataire_Nouvelle_Adresse}}…) sont écrites en
 * blanc et restent dans le document tant que le locataire n'est pas parti.
 * Invisibles à l'impression, elles seraient malgré tout analysées par
 * Documenso comme des placeholders. On les retire donc de la copie destinée à
 * la signature — sans jamais toucher au modèle source.
 *
 * @param {Body} body — Corps de la copie de travail.
 * @return {string[]} Variables retirées (remontées en avertissement).
 */
function neutraliserVariablesResiduelles(body) {
  var restants = body.getText().match(/\{\{[^{}]*\}\}/g) || [];
  var vues = {};
  var uniques = [];
  for (var i = 0; i < restants.length; i++) {
    if (vues[restants[i]]) continue;
    vues[restants[i]] = true;
    uniques.push(restants[i]);
    body.replaceText(escapeRegex(restants[i]), '');
  }
  return uniques;
}

/**
 * Valide la présence et la cohérence des placeholders dans le texte final du
 * document, juste avant l'export PDF.
 *
 * Contrôles :
 *   • chaque signataire rN possède exactement un {{name}}, {{signature}} et {{date}} ;
 *   • aucun rang au-delà du nombre de signataires ;
 *   • aucun placeholder résiduel non prévu (variable de template oubliée) ;
 *   • aucun marqueur interne restant ;
 *   • aucun placeholder coupé sur deux lignes.
 *
 * @param {string} texte — Texte complet du document.
 * @param {Array<Object>} signataires
 * @return {{ok: boolean, problemes: string[], detectes: string[]}}
 */
function validerPlaceholders(texte, signataires) {
  texte = (texte || '').toString();
  var problemes = [];
  var detectes = texte.match(/\{\{[^{}]*\}\}/g) || [];

  if (texte.indexOf(SIGNATURE_MARQUEUR) !== -1) {
    problemes.push('Le marqueur interne ' + SIGNATURE_MARQUEUR + ' est encore présent dans le document.');
  }

  // Placeholder coupé : une accolade ouvrante sans fermeture sur la même ligne.
  var lignes = texte.split('\n');
  for (var l = 0; l < lignes.length; l++) {
    var ouvertes = (lignes[l].match(/\{\{/g) || []).length;
    var fermees = (lignes[l].match(/\}\}/g) || []).length;
    if (ouvertes !== fermees) {
      problemes.push('Placeholder coupé sur plusieurs lignes (ligne ' + (l + 1) + ' du document).');
    }
  }

  var attendus = {};
  for (var i = 0; i < signataires.length; i++) {
    var rang = 'r' + (i + 1);
    var types = ['name', 'signature', 'date'];
    for (var t = 0; t < types.length; t++) {
      var ph = '{{' + types[t] + ', ' + rang + '}}';
      attendus[ph] = true;
      var occurrences = 0;
      for (var d = 0; d < detectes.length; d++) if (detectes[d] === ph) occurrences++;
      if (occurrences === 0) {
        problemes.push('Placeholder manquant : ' + ph + '.');
      } else if (occurrences > 1) {
        problemes.push('Placeholder en double (' + occurrences + '×) : ' + ph + '.');
      }
    }
  }

  for (var k = 0; k < detectes.length; k++) {
    if (attendus[detectes[k]]) continue;
    var m = detectes[k].match(/^\{\{\s*\w+\s*,\s*r(\d+)\s*\}\}$/i);
    if (m) {
      problemes.push('Placeholder « ' + detectes[k] + ' » : le rang r' + m[1] +
                     ' ne correspond à aucun signataire (' + signataires.length + ' attendu(s)).');
    } else {
      problemes.push('Placeholder inattendu dans le document : « ' + detectes[k] +
                     ' » (variable de modèle non remplacée ?).');
    }
  }

  return { ok: problemes.length === 0, problemes: problemes, detectes: detectes };
}


// ---------------------------------------------------------------------------
// 7. GÉNÉRATION DES PDF « PRÊTS À SIGNER »
// ---------------------------------------------------------------------------

/**
 * Dossier Drive des pièces de signature du locataire.
 * @param {Object} config
 * @param {string} nomLocataire
 * @return {Folder}
 */
function dossierSignature(config, nomLocataire) {
  return getOrCreateSubFolder(getOrCreateTenantFolder(config, nomLocataire), SIGNATURE_DOSSIER);
}

/**
 * Génère une copie du document contenant les placeholders Documenso, et
 * l'exporte en PDF. Le Google Doc source (le modèle) n'est jamais modifié :
 * on travaille sur une copie, supprimée après export.
 *
 * @param {string} type — 'BAIL' ou 'EDL'.
 * @param {Object} tenant
 * @param {Object} config
 * @param {Object} chambre
 * @param {Array<Object>} signataires
 * @param {Folder} dossier — Dossier de destination du PDF.
 * @param {Object} [options] — { dryRun: boolean }.
 * @return {{type:string, pdfFile:File, nom:string, texte:string, validation:Object}}
 */
function preparerPdfSignature(type, tenant, config, chambre, signataires, dossier, options) {
  options = options || {};
  var meta = SIGNATURE_DOCUMENTS[type];
  if (!meta) throw new Error('Type de document inconnu : ' + type);

  var templateId = config[meta.cleTemplate];
  if (!templateId) {
    throw new Error(meta.cleTemplate + ' manquant dans l\'onglet Config — impossible de générer ' +
                    meta.libelle + '. Aucune demande de signature n\'a été créée.');
  }

  var nomCourt = signatureNomCourt(tenant['Locataire_Nom']);
  var suffixe = options.dryRun ? '_DRYRUN' : '_Original';
  var docName = signatureDateJour() + '_' + meta.libelleFichier + '_' + nomCourt + suffixe;

  var copie;
  try {
    copie = DriveApp.getFileById(templateId).makeCopy(docName, dossier);
  } catch (e) {
    throw new Error('Modèle Google Docs inaccessible (' + meta.cleTemplate + ' = ' + templateId +
                    ') : ' + e.message + '. Aucune demande de signature n\'a été créée.');
  }
  var docId = copie.getId();

  var texte;
  var residuels = [];
  try {
    var doc = DocumentApp.openById(docId);
    var body = doc.getBody();

    if (type === 'BAIL') {
      applyBailReplacements(body, tenant, config, chambre);
    } else {
      applyEdlReplacements(body, tenant, config);
    }

    // Toute variable non remplacée est retirée AVANT d'ajouter les
    // placeholders Documenso : seuls les nôtres subsistent dans le PDF.
    residuels = neutraliserVariablesResiduelles(body);

    insererBlocSignatures(body, signataires);
    texte = body.getText();
    doc.saveAndClose();
  } catch (e) {
    // La copie de travail ne doit jamais rester derrière en cas d'échec.
    try { DriveApp.getFileById(docId).setTrashed(true); } catch (ignore) {}
    throw e;
  }

  var validation = validerPlaceholders(texte, signataires);
  if (!validation.ok) {
    try { DriveApp.getFileById(docId).setTrashed(true); } catch (ignore2) {}
    throw new Error('Placeholders incohérents dans « ' + meta.libelle + ' » :\n  • ' +
                    validation.problemes.join('\n  • ') +
                    '\nAucune demande de signature n\'a été créée.');
  }

  var pdfFile;
  try {
    pdfFile = createLeasePdf(docId, docName, dossier);
  } catch (e) {
    try { DriveApp.getFileById(docId).setTrashed(true); } catch (ignore3) {}
    throw new Error('Conversion PDF impossible pour « ' + meta.libelle + '  » : ' + e.message +
                    '. Aucune demande de signature n\'a été créée.');
  }

  // Seule la copie Google Docs intermédiaire est supprimée ; le PDF envoyé à
  // Documenso est conservé comme original de la demande.
  DriveApp.getFileById(docId).setTrashed(true);

  return {
    type: type,
    pdfFile: pdfFile,
    nom: docName + '.pdf',
    texte: texte,
    residuels: residuels,
    validation: validation
  };
}


// ---------------------------------------------------------------------------
// 8. PRÉ-CONTRÔLES ET RÉCAPITULATIF
// ---------------------------------------------------------------------------

/**
 * Charge tout le contexte nécessaire à une demande de signature.
 * @param {number} row — Ligne du locataire.
 * @param {string} jeu — Clé de SIGNATURE_JEUX.
 * @return {Object} { tenant, config, chambre, jeu, documents, signataires, externalId }
 */
function chargerContexteSignature(row, jeu) {
  if (!SIGNATURE_JEUX[jeu]) {
    throw new Error('Jeu de documents inconnu : « ' + jeu + ' ». Valeurs acceptées : ' +
                    Object.keys(SIGNATURE_JEUX).join(', ') + '.');
  }
  var tenant = getTenantByRow(row);
  var config = getConfig();
  var chambre = getChambreData(tenant['Chambre']);
  var signataires = resoudreSignataires(tenant, config);

  return {
    tenant: tenant,
    config: config,
    chambre: chambre,
    jeu: jeu,
    documents: SIGNATURE_JEUX[jeu].documents,
    signataires: signataires,
    externalId: construireExternalId(tenant, config, chambre, jeu, signataires)
  };
}

/**
 * Contrôles préalables. Ne modifie rien, n'appelle pas l'API : construit le
 * récapitulatif affiché à l'utilisateur et la liste des blocages.
 *
 * @param {Object} ctx — Contexte de chargerContexteSignature.
 * @param {Object} [options] — { dryRun: boolean }.
 * @return {{ok:boolean, blocages:string[], avertissements:string[], recap:Object}}
 */
function preflightSignature(ctx, options) {
  options = options || {};
  var dryRun = signatureDryRun(options);
  var blocages = [];
  var avertissements = [];

  // --- Documents disponibles -----------------------------------------------
  for (var i = 0; i < ctx.documents.length; i++) {
    var meta = SIGNATURE_DOCUMENTS[ctx.documents[i]];
    if (!ctx.config[meta.cleTemplate]) {
      blocages.push('Modèle manquant : la clé ' + meta.cleTemplate + ' est vide dans l\'onglet Config.');
      continue;
    }
    if (!(ctx.tenant[meta.colonnePdf] || '').toString().trim()) {
      blocages.push(meta.libelle + ' non généré : la colonne ' + meta.colonnePdf +
                    ' est vide. Générez d\'abord le document avant de l\'envoyer en signature.');
    }
    // Le marqueur doit exister dans le modèle, sinon aucun bloc de signature
    // ne pourra être placé (contrôle fait avant toute copie).
    var soucis = verifierMarqueurTemplate(ctx.config[meta.cleTemplate], meta.libelle);
    if (soucis) blocages.push(soucis);
  }

  // --- Signataires et emails ------------------------------------------------
  for (var s = 0; s < ctx.signataires.length; s++) {
    var sig = ctx.signataires[s];
    if (!sig.email) {
      blocages.push('Email manquant pour ' + sig.rang + ' (' + sig.role + ')' +
                    (sig.role === 'bailleur'
                      ? ' — renseignez la clé Config « Bailleur_Email », ou passez SIGNATURE_BAILLEUR à NON.'
                      : '.'));
    } else if (!isEmailValide(sig.email)) {
      blocages.push('Email invalide pour ' + sig.rang + ' (' + sig.role + ') : ' + sig.email);
    }
    if (!sig.nom) avertissements.push('Nom manquant pour ' + sig.rang + ' (' + sig.role + ').');
  }

  var emailsVus = {};
  for (var e = 0; e < ctx.signataires.length; e++) {
    var mail = (ctx.signataires[e].email || '').toLowerCase();
    if (!mail) continue;
    if (emailsVus[mail]) {
      blocages.push('Adresse email en double parmi les signataires : ' + ctx.signataires[e].email);
    }
    emailsVus[mail] = true;
  }

  // --- Doublon --------------------------------------------------------------
  var existantes = trouverDemandesParExternalId(ctx.externalId);
  var bloquante = null;
  for (var d = 0; d < existantes.length; d++) {
    var statut = (existantes[d]['Statut'] || '').toString().toUpperCase();
    if (SIGNATURE_STATUTS_BLOQUANTS.indexOf(statut) !== -1) { bloquante = existantes[d]; break; }
    if (statut === SIGNATURE_STATUTS.ERREUR && (existantes[d]['Envelope_ID'] || '').toString().trim()) {
      bloquante = existantes[d];
      break;
    }
  }
  if (bloquante) {
    var statutB = (bloquante['Statut'] || '').toString().toUpperCase();
    var messageDoublon =
      'Une demande identique existe déjà (statut ' + statutB +
      (bloquante['Envelope_ID'] ? ', enveloppe ' + bloquante['Envelope_ID'] : '') +
      '). ' + (statutB === SIGNATURE_STATUTS.ERREUR
        ? 'Une enveloppe a été créée côté Documenso : annulez-la avant de relancer.'
        : 'Annulez-la ou attendez sa finalisation avant d\'en créer une nouvelle.');
    // En mode test rien n'est envoyé : le doublon n'est qu'une information,
    // et pouvoir rejouer le diagnostic sur une demande en cours est utile.
    if (dryRun) avertissements.push(messageDoublon);
    else blocages.push(messageDoublon);
  }

  // --- Token ----------------------------------------------------------------
  if (!dryRun && !documensoTokenConfigure()) {
    blocages.push('Token Documenso absent : définissez la propriété de script DOCUMENSO_API_TOKEN ' +
                  '(ou utilisez le mode test DRY_RUN).');
  }

  var recap = {
    logement: formatValue(ctx.config['Location_Adresse']) + ' — chambre n°' + formatValue(ctx.tenant['Chambre']),
    locataire: formatValue(ctx.tenant['Locataire_Nom']),
    documents: ctx.documents.map(function(t) { return SIGNATURE_DOCUMENTS[t].libelle; }),
    jeu: ctx.jeu,
    jeuLibelle: SIGNATURE_JEUX[ctx.jeu].libelle,
    enveloppeUnique: ctx.documents.length > 1,
    signataires: ctx.signataires.map(function(x) {
      return { rang: x.rang, role: x.role, nom: x.nom, email: x.email, libelle: signataireLibelle(x) };
    }),
    ordre: signatureConfigOui(ctx.config['SIGNATURE_ORDRE_SEQUENTIEL'], false)
             ? 'Séquentiel (chacun son tour, dans l\'ordre r1, r2, …)'
             : 'Parallèle (tous les signataires en même temps)',
    externalId: ctx.externalId,
    dryRun: dryRun,
    historique: existantes.map(function(h) {
      return { statut: h['Statut'], envelopeId: h['Envelope_ID'], date: h['Date_Creation'] };
    })
  };

  return { ok: blocages.length === 0, blocages: blocages, avertissements: avertissements, recap: recap };
}

/**
 * Vérifie que le modèle Google Docs contient le marqueur de signature.
 * @param {string} templateId — ID du Google Doc modèle.
 * @param {string} libelle — Nom lisible du document (messages).
 * @return {string|null} Message de blocage, ou null si tout va bien.
 */
function verifierMarqueurTemplate(templateId, libelle) {
  var body;
  try {
    body = DocumentApp.openById(templateId).getBody();
  } catch (e) {
    return 'Modèle « ' + libelle + ' » inaccessible (' + templateId + ') : ' + e.message;
  }

  var index = findElementIndexByText(body, SIGNATURE_MARQUEUR);
  if (index === -1) {
    return 'Modèle « ' + libelle + ' » : marqueur ' + SIGNATURE_MARQUEUR + ' absent. ' +
           'Ajoutez-le à l\'emplacement du bloc de signatures (voir docs/documenso.md).';
  }

  var element = body.getChild(index);
  if (element.getType && DocumentApp.ElementType &&
      element.getType() !== DocumentApp.ElementType.PARAGRAPH) {
    return 'Modèle « ' + libelle + ' » : le marqueur ' + SIGNATURE_MARQUEUR +
           ' est dans un élément de type ' + element.getType() +
           ' — il doit être un paragraphe autonome, hors de tout tableau.';
  }
  return null;
}


// ---------------------------------------------------------------------------
// 9. ENVOI EN SIGNATURE
// ---------------------------------------------------------------------------

/**
 * Prépare et envoie une demande de signature.
 *
 * Séquence : pré-contrôles → génération des PDF (placeholders validés) →
 * enregistrement de la trace → création de l'enveloppe → vérification des
 * champs détectés → distribution → mise à jour du statut.
 *
 * En mode DRY_RUN, tout s'arrête après la construction du payload : les PDF
 * sont générés (et conservés, suffixés _DRYRUN) mais rien n'est envoyé.
 *
 * @param {number} row — Ligne du locataire.
 * @param {string} jeu — 'BAIL' | 'EDL' | 'BAIL_EDL'.
 * @param {Object} [options] — { dryRun: boolean }.
 * @return {Object} Résultat détaillé (voir le corps de la fonction).
 */
function envoyerDemandeSignature(row, jeu, options) {
  options = options || {};
  var ctx = chargerContexteSignature(row, jeu);
  var dryRun = signatureDryRun(options);

  var pre = preflightSignature(ctx, options);
  if (!pre.ok) {
    throw new Error('Envoi en signature impossible :\n  • ' + pre.blocages.join('\n  • '));
  }

  // --- 1. PDF prêts à signer ------------------------------------------------
  var dossier = dossierSignature(ctx.config, ctx.tenant['Locataire_Nom']);
  var prepares = [];
  for (var i = 0; i < ctx.documents.length; i++) {
    prepares.push(preparerPdfSignature(
      ctx.documents[i], ctx.tenant, ctx.config, ctx.chambre, ctx.signataires, dossier, { dryRun: dryRun }
    ));
  }

  var sequentiel = signatureConfigOui(ctx.config['SIGNATURE_ORDRE_SEQUENTIEL'], false);
  var titre = SIGNATURE_JEUX[jeu].libelle + ' — ' + formatValue(ctx.tenant['Locataire_Nom']) +
              ' (chambre n°' + formatValue(ctx.tenant['Chambre']) + ')';

  // Numéro de tentative : une reprise après échec/annulation garde la même
  // base d'identifiant externe, avec un suffixe qui la rend unique côté API.
  var tentative = trouverDemandesParExternalId(ctx.externalId).length + 1;
  var externalId = tentative > 1 ? ctx.externalId + '-t' + tentative : ctx.externalId;

  var spec = {
    titre: titre,
    externalId: externalId,
    sequentiel: sequentiel,
    signataires: ctx.signataires.map(function(s) { return { email: s.email, nom: s.nom }; }),
    fichiers: prepares.map(function(p) { return { nom: p.nom, blob: p.pdfFile.getBlob() }; }),
    meta: {
      subject: titre,
      message: 'Bonjour, merci de signer électroniquement le(s) document(s) ci-joint(s) : ' +
               ctx.documents.map(function(t) { return SIGNATURE_DOCUMENTS[t].libelle; }).join(' et ') + '.'
    }
  };

  // --- 2. Mode test : on s'arrête ici --------------------------------------
  if (dryRun) {
    return {
      dryRun: true,
      ok: true,
      externalId: externalId,
      envelopeId: null,
      statut: SIGNATURE_STATUTS.NON_ENVOYE,
      recap: pre.recap,
      documents: prepares.map(function(p) {
        return {
          type: p.type,
          fichier: p.nom,
          placeholders: p.validation.detectes,
          variablesRetirees: p.residuels
        };
      }),
      payload: signaturePayloadResume(spec),
      message: 'DRY_RUN — ' + prepares.length + ' PDF généré(s), payload construit, ' +
               'AUCUNE enveloppe créée et aucun email envoyé.'
    };
  }

  // --- 3. Trace AVANT tout appel réseau ------------------------------------
  var ligneSuivi = enregistrerDemandeSignature({
    'Date_Creation': signatureHorodatage(),
    'Ligne': row,
    'Locataire_Nom': formatValue(ctx.tenant['Locataire_Nom']),
    'Chambre': formatValue(ctx.tenant['Chambre']),
    'Documents': ctx.documents.join('+'),
    'External_ID': externalId,
    'Envelope_ID': '',
    'Statut': SIGNATURE_STATUTS.PREPARATION,
    'Signataires': ctx.signataires.map(function(s) { return s.rang + '=' + s.email; }).join(' ; ')
  });
  refleterStatutSurLocataire(ctx.tenant, SIGNATURE_STATUTS.PREPARATION, '');

  var client = new DocumensoClient();

  // --- 4. Création de l'enveloppe ------------------------------------------
  var creation;
  try {
    creation = client.createEnvelope(spec);
  } catch (e) {
    majDemandeSignature(ligneSuivi, {
      'Statut': SIGNATURE_STATUTS.ERREUR,
      'Derniere_Erreur': signatureMessageErreur(e, 'création de l\'enveloppe')
    });
    refleterStatutSurLocataire(ctx.tenant, SIGNATURE_STATUTS.ERREUR, '');
    throw new Error(signatureMessageErreur(e, 'création de l\'enveloppe'));
  }

  majDemandeSignature(ligneSuivi, {
    'Envelope_ID': creation.envelopeId,
    'Lien': signatureLienSuivi(creation.envelopeId)
  });
  refleterStatutSurLocataire(ctx.tenant, SIGNATURE_STATUTS.PREPARATION, creation.envelopeId);

  // --- 5. Vérification des champs détectés ---------------------------------
  var verif;
  try {
    verif = client.validateDetectedFields(creation.envelopeId, ctx.signataires);
  } catch (e2) {
    majDemandeSignature(ligneSuivi, {
      'Statut': SIGNATURE_STATUTS.ERREUR,
      'Derniere_Erreur': signatureMessageErreur(e2, 'vérification des champs', creation.envelopeId)
    });
    throw new Error(signatureMessageErreur(e2, 'vérification des champs', creation.envelopeId));
  }

  if (!verif.ok) {
    var msgChamps =
      'Enveloppe ' + creation.envelopeId + ' créée en BROUILLON mais non envoyée : ' +
      'Documenso n\'a pas détecté tous les champs attendus.\n  • ' + verif.problemes.join('\n  • ') +
      '\nCorrigez les modèles, annulez cette enveloppe (🚫 Annuler une demande de signature), puis relancez.';
    majDemandeSignature(ligneSuivi, {
      'Statut': SIGNATURE_STATUTS.ERREUR,
      'Derniere_Erreur': msgChamps
    });
    throw new Error(msgChamps);
  }

  // --- 6. Distribution ------------------------------------------------------
  try {
    client.distributeEnvelope(creation.envelopeId, spec.meta);
  } catch (e3) {
    var msgDistrib = signatureMessageErreur(e3, 'envoi de l\'enveloppe', creation.envelopeId);
    majDemandeSignature(ligneSuivi, { 'Statut': SIGNATURE_STATUTS.ERREUR, 'Derniere_Erreur': msgDistrib });
    refleterStatutSurLocataire(ctx.tenant, SIGNATURE_STATUTS.ERREUR, creation.envelopeId);
    throw new Error(msgDistrib);
  }

  majDemandeSignature(ligneSuivi, {
    'Statut': SIGNATURE_STATUTS.EN_ATTENTE_SIGNATURE,
    'Demande_Le': signatureHorodatage(),
    'Derniere_Erreur': ''
  });
  refleterStatutSurLocataire(ctx.tenant, SIGNATURE_STATUTS.EN_ATTENTE_SIGNATURE, creation.envelopeId);

  return {
    dryRun: false,
    ok: true,
    externalId: externalId,
    envelopeId: creation.envelopeId,
    lien: signatureLienSuivi(creation.envelopeId),
    statut: SIGNATURE_STATUTS.EN_ATTENTE_SIGNATURE,
    ligneSuivi: ligneSuivi,
    recap: pre.recap,
    documents: prepares.map(function(p) { return { type: p.type, fichier: p.nom }; }),
    champs: verif.parSignataire,
    message: '✍️ Demande envoyée — enveloppe ' + creation.envelopeId + '\n' +
             prepares.length + ' document(s), ' + ctx.signataires.length + ' signataire(s).'
  };
}

/**
 * Résumé du payload pour l'affichage DRY_RUN : aucune donnée sensible, pas de
 * fichiers binaires, adresses email masquées.
 * @param {Object} spec
 * @return {Object}
 */
function signaturePayloadResume(spec) {
  return {
    type: 'DOCUMENT',
    title: spec.titre,
    externalId: spec.externalId,
    signingOrder: spec.sequentiel ? 'SEQUENTIAL' : 'PARALLEL',
    recipients: spec.signataires.map(function(s, i) {
      return { rang: 'r' + (i + 1), name: s.nom, email: documensoMaskEmail(s.email), role: 'SIGNER' };
    }),
    files: spec.fichiers.map(function(f) { return f.nom; })
  };
}

/**
 * Message d'erreur exploitable par l'utilisateur : ce qui a échoué, si une
 * demande a déjà été créée, s'il est sûr de recommencer, et l'identifiant
 * Documenso quand il existe.
 *
 * @param {Error|DocumensoError} e
 * @param {string} etape — Étape en cours, en français.
 * @param {string} [envelopeId]
 * @return {string}
 */
function signatureMessageErreur(e, etape, envelopeId) {
  var lignes = ['Échec à l\'étape « ' + etape + ' » : ' + (e && e.message ? e.message : e)];

  var id = envelopeId || (e && e.envelopeId) || null;
  if (id) {
    lignes.push('Enveloppe Documenso concernée : ' + id + ' — elle EXISTE côté Documenso.');
    lignes.push('Ne relancez pas l\'envoi tel quel : annulez d\'abord cette enveloppe ' +
                '(🚫 Annuler une demande de signature), sinon vous créerez un doublon.');
  } else if (e && e.safeToRetry) {
    lignes.push('Aucune enveloppe n\'a été créée : vous pouvez relancer l\'envoi sans risque de doublon.');
  } else {
    lignes.push('Statut incertain côté Documenso : vérifiez dans Documenso (ou via 🔄 Actualiser les ' +
                'statuts de signature) avant de relancer.');
  }

  if (e && e.code) lignes.push('Code : ' + e.code);
  return lignes.join('\n');
}


// ---------------------------------------------------------------------------
// 10. SUIVI DES DEMANDES
// ---------------------------------------------------------------------------

/**
 * Traduit l'état Documenso en statut métier.
 * @param {Object} enveloppe — Retour de getEnvelopeStatus.
 * @return {string|null} Statut métier, ou null si l'état est inconnu.
 */
function mapStatutDocumenso(enveloppe) {
  var statut = (enveloppe && enveloppe.statut ? enveloppe.statut : '').toUpperCase();

  if (statut === 'COMPLETED') return SIGNATURE_STATUTS.SIGNE;
  if (statut === 'REJECTED' || statut === 'DECLINED') return SIGNATURE_STATUTS.REFUSE;
  if (statut === 'CANCELLED' || statut === 'CANCELED' || statut === 'VOIDED') return SIGNATURE_STATUTS.ANNULE;
  if (statut === 'DRAFT') return SIGNATURE_STATUTS.PREPARATION;

  if (statut === 'PENDING' || statut === 'SENT') {
    var dest = enveloppe.destinataires || [];
    var signes = 0;
    for (var i = 0; i < dest.length; i++) {
      var st = (dest[i].statutSignature || '').toUpperCase();
      if (st === 'SIGNED' || st === 'COMPLETED') signes++;
      if (st === 'REJECTED' || st === 'DECLINED') return SIGNATURE_STATUTS.REFUSE;
    }
    if (signes > 0 && signes < dest.length) return SIGNATURE_STATUTS.PARTIELLEMENT_SIGNE;
    return SIGNATURE_STATUTS.EN_ATTENTE_SIGNATURE;
  }

  return null;
}

/**
 * Interroge Documenso pour toutes les demandes non finalisées, met à jour les
 * statuts et archive les documents dès qu'une enveloppe est finalisée.
 *
 * Idempotent : une demande déjà archivée (colonne Fichiers_Signes renseignée)
 * n'est pas re-téléchargée.
 *
 * @param {Object} [deps] — { client } — injection pour les tests.
 * @return {{traitees:number, misesAJour:Array, erreurs:Array, rapport:string}}
 */
function actualiserStatutsSignature(deps) {
  deps = deps || {};
  var demandes = lireDemandesSignature().filter(function(d) {
    var st = (d['Statut'] || '').toString().toUpperCase();
    return SIGNATURE_STATUTS_FINAUX.indexOf(st) === -1;
  });

  if (!demandes.length) {
    return { traitees: 0, misesAJour: [], erreurs: [], rapport: 'Aucune demande de signature en cours.' };
  }

  var client = deps.client || new DocumensoClient();
  var config = getConfig();
  var misesAJour = [];
  var erreurs = [];

  for (var i = 0; i < demandes.length; i++) {
    var d = demandes[i];
    var envelopeId = (d['Envelope_ID'] || '').toString().trim();
    var etiquette = d['Locataire_Nom'] + ' (' + d['Documents'] + ')';

    if (!envelopeId) {
      // Demande interrompue avant la création de l'enveloppe : rien à suivre.
      majDemandeSignature(d._row, {
        'Statut': SIGNATURE_STATUTS.ERREUR,
        'Derniere_Erreur': 'Aucun identifiant d\'enveloppe : la demande n\'a jamais abouti. ' +
                           'Relancer l\'envoi est sans risque de doublon.'
      });
      erreurs.push(etiquette + ' : aucune enveloppe créée.');
      continue;
    }

    try {
      var enveloppe = client.getEnvelopeStatus(envelopeId);
      var nouveau = mapStatutDocumenso(enveloppe);
      if (!nouveau) {
        erreurs.push(etiquette + ' : état Documenso non reconnu (« ' + enveloppe.statut + ' »).');
        continue;
      }

      var patch = { 'Statut': nouveau, 'Derniere_Erreur': '' };

      if (nouveau === SIGNATURE_STATUTS.SIGNE && !(d['Fichiers_Signes'] || '').toString().trim()) {
        var archive = archiverDocumentsSignes(client, d, config, envelopeId);
        patch['Fichiers_Signes'] = archive.fichiers.join(' ; ');
        patch['Termine_Le'] = signatureHorodatage();
        if (archive.avertissements.length) {
          patch['Derniere_Erreur'] = 'Archivage partiel — ' + archive.avertissements.join(' | ');
        }
      } else if (nouveau === SIGNATURE_STATUTS.SIGNE) {
        patch['Termine_Le'] = d['Termine_Le'] || signatureHorodatage();
      } else if (nouveau === SIGNATURE_STATUTS.REFUSE || nouveau === SIGNATURE_STATUTS.ANNULE) {
        patch['Termine_Le'] = signatureHorodatage();
      }

      majDemandeSignature(d._row, patch);
      if (nouveau !== (d['Statut'] || '').toString().toUpperCase()) {
        misesAJour.push(etiquette + ' : ' + d['Statut'] + ' → ' + nouveau);
      }

    } catch (e) {
      var msg = signatureMessageErreur(e, 'actualisation du statut', envelopeId);
      majDemandeSignature(d._row, { 'Derniere_Erreur': msg });
      erreurs.push(etiquette + ' : ' + (e && e.message ? e.message : e));
    }
  }

  var rapport = demandes.length + ' demande(s) en cours examinée(s).';
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
  Logger.log('Trigger horaire installé : suivi des demandes de signature Documenso.');
}


// ---------------------------------------------------------------------------
// 11. ARCHIVAGE DES DOCUMENTS SIGNÉS
// ---------------------------------------------------------------------------

/**
 * Télécharge et archive dans Drive les documents signés, le certificat de
 * signature et le journal d'audit d'une enveloppe finalisée.
 *
 * Les PDF originaux ayant servi à la demande sont déjà dans le même dossier
 * (suffixe _Original) et ne sont jamais écrasés ; les Google Docs sources ne
 * sont pas touchés.
 *
 * @param {DocumensoClient} client
 * @param {Object} demande — Ligne de suivi.
 * @param {Object} config
 * @param {string} envelopeId
 * @return {{fichiers:string[], avertissements:string[]}}
 */
function archiverDocumentsSignes(client, demande, config, envelopeId) {
  var telechargement = client.downloadCompletedDocuments(envelopeId);
  var avertissements = telechargement.avertissements.slice(0);
  var fichiers = [];

  var nomLocataire = (demande['Locataire_Nom'] || '').toString();
  var nomCourt = signatureNomCourt(nomLocataire);
  var jour = signatureDateJour();
  var dossier;
  try {
    dossier = dossierSignature(config, nomLocataire);
  } catch (e) {
    throw new Error('Archivage impossible (dossier Drive du locataire) : ' + e.message +
                    ' — les documents restent téléchargeables depuis Documenso (enveloppe ' +
                    envelopeId + ').');
  }

  var typesEnvoyes = (demande['Documents'] || '').toString().split('+');

  for (var i = 0; i < telechargement.documents.length; i++) {
    var doc = telechargement.documents[i];
    var libelle = libelleFichierDepuisTitre(doc.titre, typesEnvoyes, i);
    var nom = jour + '_' + libelle + '_' + nomCourt + '_Signe.pdf';
    try {
      dossier.createFile(doc.blob.setName(nom));
      fichiers.push(nom);
    } catch (e2) {
      avertissements.push('Écriture Drive impossible pour ' + nom + ' : ' + e2.message);
    }
  }

  if (telechargement.certificat) {
    var nomCert = jour + '_Certificat-signature_' + nomCourt + '.pdf';
    try {
      dossier.createFile(telechargement.certificat.setName(nomCert));
      fichiers.push(nomCert);
    } catch (e3) {
      avertissements.push('Écriture Drive impossible pour le certificat : ' + e3.message);
    }
  }

  if (telechargement.journal) {
    var nomJournal = jour + '_Journal-signature_' + nomCourt + '.pdf';
    try {
      dossier.createFile(telechargement.journal.setName(nomJournal));
      fichiers.push(nomJournal);
    } catch (e4) {
      avertissements.push('Écriture Drive impossible pour le journal d\'audit : ' + e4.message);
    }
  }

  return { fichiers: fichiers, avertissements: avertissements };
}

/**
 * Détermine le libellé de fichier d'un document signé.
 * Priorité au titre renvoyé par Documenso ; à défaut, l'ordre d'envoi
 * (déterministe : bail puis état des lieux).
 *
 * @param {string} titre — Titre Documenso.
 * @param {string[]} typesEnvoyes — Types envoyés, dans l'ordre ('BAIL', 'EDL').
 * @param {number} index — Position du document.
 * @return {string}
 */
function libelleFichierDepuisTitre(titre, typesEnvoyes, index) {
  var t = (titre || '').toString().toLowerCase();
  if (t.indexOf('bail') !== -1) return SIGNATURE_DOCUMENTS.BAIL.libelleFichier;
  if (t.indexOf('edl') !== -1 || t.indexOf('etat') !== -1 || t.indexOf('état') !== -1) {
    return SIGNATURE_DOCUMENTS.EDL.libelleFichier;
  }
  var type = typesEnvoyes[index];
  if (type && SIGNATURE_DOCUMENTS[type]) return SIGNATURE_DOCUMENTS[type].libelleFichier;
  return 'Document-' + (index + 1);
}


// ---------------------------------------------------------------------------
// 12. ANNULATION
// ---------------------------------------------------------------------------

/**
 * Annule une demande de signature côté Documenso et met le suivi à jour.
 * @param {string} externalId — Identifiant externe de la demande (colonne External_ID).
 * @param {string} [motif]
 * @param {Object} [deps] — { client } — injection pour les tests.
 * @return {{ok:boolean, message:string}}
 */
function annulerDemandeSignature(externalId, motif, deps) {
  deps = deps || {};
  var cible = null;
  var demandes = lireDemandesSignature();
  for (var i = 0; i < demandes.length; i++) {
    if ((demandes[i]['External_ID'] || '').toString() === (externalId || '').toString()) {
      cible = demandes[i];
      break;
    }
  }
  if (!cible) throw new Error('Demande de signature introuvable : ' + externalId);

  var statut = (cible['Statut'] || '').toString().toUpperCase();
  if (SIGNATURE_STATUTS_FINAUX.indexOf(statut) !== -1) {
    throw new Error('Demande déjà finalisée (statut ' + statut + ') — annulation impossible.');
  }

  var envelopeId = (cible['Envelope_ID'] || '').toString().trim();
  if (!envelopeId) {
    majDemandeSignature(cible._row, {
      'Statut': SIGNATURE_STATUTS.ANNULE,
      'Termine_Le': signatureHorodatage(),
      'Derniere_Erreur': ''
    });
    return { ok: true, message: 'Demande annulée localement (aucune enveloppe n\'avait été créée).' };
  }

  var client = deps.client || new DocumensoClient();
  try {
    client.cancelEnvelope(envelopeId, motif || 'Annulation depuis Gestion Locataires');
  } catch (e) {
    var msg = signatureMessageErreur(e, 'annulation de l\'enveloppe', envelopeId);
    majDemandeSignature(cible._row, { 'Derniere_Erreur': msg });
    throw new Error(msg);
  }

  majDemandeSignature(cible._row, {
    'Statut': SIGNATURE_STATUTS.ANNULE,
    'Termine_Le': signatureHorodatage(),
    'Derniere_Erreur': ''
  });
  return { ok: true, message: '🚫 Enveloppe ' + envelopeId + ' annulée.' };
}


// ---------------------------------------------------------------------------
// 13. WRAPPERS WEB APP (sans SpreadsheetApp.getUi())
// ---------------------------------------------------------------------------

/**
 * Métadonnées de la carte « Signature électronique » de la web app.
 * Ne divulgue jamais le token — seulement sa présence.
 * @return {Object}
 */
function webGetSignatureMeta() {
  var config = getConfig();
  return {
    tokenConfigure: documensoTokenConfigure(),
    dryRunGlobal: signatureDryRun(),
    bailleurSigne: signatureConfigOui(config['SIGNATURE_BAILLEUR'], true),
    sequentiel: signatureConfigOui(config['SIGNATURE_ORDRE_SEQUENTIEL'], false),
    jeux: Object.keys(SIGNATURE_JEUX).map(function(cle) {
      return { cle: cle, libelle: SIGNATURE_JEUX[cle].libelle };
    })
  };
}

/**
 * Récapitulatif + blocages pour un locataire et un jeu de documents.
 * Aucun effet de bord : c'est l'écran de confirmation.
 * @param {number} row
 * @param {string} jeu
 * @return {Object}
 */
function webPreparerSignature(row, jeu) {
  var ctx = chargerContexteSignature(row, jeu);
  var pre = preflightSignature(ctx, {});
  return {
    ok: pre.ok,
    blocages: pre.blocages,
    avertissements: pre.avertissements,
    recap: pre.recap
  };
}

/**
 * Envoi (ou simulation) d'une demande de signature depuis la web app.
 * @param {number} row
 * @param {string} jeu
 * @param {boolean} dryRun
 * @return {{ok:boolean, message:string, envelopeId:string, externalId:string}}
 */
function webEnvoyerSignature(row, jeu, dryRun) {
  var res = envoyerDemandeSignature(row, jeu, { dryRun: dryRun === true || dryRun === 'true' });
  var lignes = [res.message];
  if (res.envelopeId) lignes.push('Identifiant de suivi : ' + res.envelopeId);
  if (res.lien) lignes.push(res.lien);
  if (res.dryRun) {
    lignes.push('Signataires : ' + res.recap.signataires.map(function(s) { return s.libelle; }).join(' | '));
    lignes.push('Placeholders détectés : ' + res.documents.map(function(d) {
      return d.type + ' → ' + d.placeholders.join(' ');
    }).join(' || '));
  }
  return {
    ok: true,
    dryRun: !!res.dryRun,
    envelopeId: res.envelopeId || '',
    externalId: res.externalId,
    message: lignes.join('\n')
  };
}

/**
 * Actualisation manuelle des statuts depuis la web app (diagnostic).
 * @return {{ok:boolean, message:string}}
 */
function webActualiserStatutsSignature() {
  var res = actualiserStatutsSignature();
  return { ok: true, message: '🔄 ' + res.rapport };
}

/**
 * Demandes de signature d'un locataire (les plus récentes en premier).
 * @param {number} row
 * @return {Array<Object>}
 */
function webGetSignaturesLocataire(row) {
  return lireDemandesSignature()
    .filter(function(d) { return parseInt(d['Ligne'], 10) === parseInt(row, 10); })
    .reverse()
    .map(function(d) {
      return {
        externalId: d['External_ID'],
        envelopeId: d['Envelope_ID'],
        statut: d['Statut'],
        documents: d['Documents'],
        creeLe: d['Date_Creation'],
        termineLe: d['Termine_Le'],
        fichiers: d['Fichiers_Signes'],
        erreur: d['Derniere_Erreur']
      };
    });
}

/**
 * Annulation depuis la web app.
 * @param {string} externalId
 * @param {string} [motif]
 * @return {{ok:boolean, message:string}}
 */
function webAnnulerSignature(externalId, motif) {
  return annulerDemandeSignature(externalId, motif);
}


// ---------------------------------------------------------------------------
// 14. ACTIONS DU MENU
// ---------------------------------------------------------------------------

/**
 * Menu : envoyer en signature le bail, l'EDL ou les deux, pour la ligne active.
 */
function menuEnvoyerEnSignature() {
  var ui = SpreadsheetApp.getUi();
  try {
    var tenant = getTenantData();

    var choix = ui.prompt(
      'Envoyer en signature — documents',
      'Que faut-il envoyer pour ' + tenant['Locataire_Nom'] + ' ?\n\n' +
      '  1 — Bail uniquement\n' +
      '  2 — État des lieux uniquement\n' +
      '  3 — Bail + état des lieux (une seule enveloppe)\n\n' +
      'Saisissez 1, 2 ou 3 (ajoutez « test » pour un essai DRY_RUN sans envoi) :',
      ui.ButtonSet.OK_CANCEL
    );
    if (choix.getSelectedButton() !== ui.Button.OK) return;

    var saisie = choix.getResponseText().trim().toLowerCase();
    var dryRun = saisie.indexOf('test') !== -1;
    var num = saisie.replace(/[^123]/g, '').charAt(0);
    var jeu = num === '1' ? 'BAIL' : num === '2' ? 'EDL' : num === '3' ? 'BAIL_EDL' : null;
    if (!jeu) throw new Error('Choix invalide : saisissez 1, 2 ou 3.');

    // Récapitulatif avant confirmation explicite
    var ctx = chargerContexteSignature(tenant._rowIndex, jeu);
    var pre = preflightSignature(ctx, { dryRun: dryRun });

    if (!pre.ok) {
      ui.alert('Envoi impossible',
        'Corrigez les points suivants :\n\n  • ' + pre.blocages.join('\n  • '),
        ui.ButtonSet.OK);
      return;
    }

    var recapTexte =
      'Logement : ' + pre.recap.logement + '\n' +
      'Documents : ' + pre.recap.documents.join(' + ') +
      (pre.recap.enveloppeUnique ? ' (une seule enveloppe)' : '') + '\n' +
      'Signataires :\n  ' + pre.recap.signataires.map(function(s) { return s.libelle; }).join('\n  ') + '\n' +
      'Ordre de signature : ' + pre.recap.ordre + '\n' +
      'Identifiant externe : ' + pre.recap.externalId + '\n' +
      (pre.avertissements.length ? '\n⚠️ ' + pre.avertissements.join('\n⚠️ ') + '\n' : '') +
      (dryRun ? '\n🧪 MODE TEST : les PDF seront générés, RIEN ne sera envoyé.\n' : '') +
      '\nConfirmer ' + (dryRun ? 'la simulation' : 'l\'envoi pour signature') + ' ?';

    if (ui.alert('Récapitulatif', recapTexte, ui.ButtonSet.YES_NO) !== ui.Button.YES) return;

    var res = envoyerDemandeSignature(tenant._rowIndex, jeu, { dryRun: dryRun });
    ui.alert(dryRun ? 'Simulation terminée ✓' : 'Demande envoyée ✓', res.message, ui.ButtonSet.OK);

  } catch (e) {
    ui.alert('Erreur', e.message, ui.ButtonSet.OK);
  }
}

/** Menu : interroger Documenso pour toutes les demandes en cours. */
function menuActualiserStatutsSignature() {
  var ui = SpreadsheetApp.getUi();
  try {
    var res = actualiserStatutsSignature();
    ui.alert('Statuts de signature', res.rapport, ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Erreur', e.message, ui.ButtonSet.OK);
  }
}

/** Menu : annuler une demande de signature en cours. */
function menuAnnulerSignature() {
  var ui = SpreadsheetApp.getUi();
  try {
    var enCours = lireDemandesSignature().filter(function(d) {
      return SIGNATURE_STATUTS_FINAUX.indexOf((d['Statut'] || '').toString().toUpperCase()) === -1;
    });
    if (!enCours.length) {
      ui.alert('Annuler une demande', 'Aucune demande de signature en cours.', ui.ButtonSet.OK);
      return;
    }

    var liste = enCours.map(function(d, i) {
      return '  ' + (i + 1) + ' — ' + d['Locataire_Nom'] + ' · ' + d['Documents'] +
             ' · ' + d['Statut'] + '\n      ' + d['External_ID'];
    }).join('\n');

    var choix = ui.prompt('Annuler une demande de signature',
      'Demandes en cours :\n' + liste + '\n\nNuméro à annuler :',
      ui.ButtonSet.OK_CANCEL);
    if (choix.getSelectedButton() !== ui.Button.OK) return;

    var idx = parseInt(choix.getResponseText().trim(), 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= enCours.length) throw new Error('Numéro invalide.');

    var cible = enCours[idx];
    if (ui.alert('Confirmer l\'annulation',
        'Annuler la demande de ' + cible['Locataire_Nom'] + ' (' + cible['Documents'] + ') ?\n' +
        'Enveloppe : ' + (cible['Envelope_ID'] || '(aucune)'),
        ui.ButtonSet.YES_NO) !== ui.Button.YES) return;

    var res = annulerDemandeSignature(cible['External_ID'], 'Annulation depuis le menu Sheet');
    ui.alert('Annulation', res.message, ui.ButtonSet.OK);

  } catch (e) {
    ui.alert('Erreur', e.message, ui.ButtonSet.OK);
  }
}
