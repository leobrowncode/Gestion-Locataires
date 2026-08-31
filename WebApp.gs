// =============================================================================
// WEB APP — Interface mobile pour Gestion Locataires
// =============================================================================
//
// DÉPLOIEMENT :
// 1. Dans l'éditeur Apps Script, ajouter ce fichier (à côté de Code.gs)
// 2. Ajouter le fichier HTML (Fichier > Nouveau > HTML) en le nommant "Mobile"
//    (ATTENTION : Apps Script interdit deux fichiers de même nom, .gs et .html
//     ne peuvent pas s'appeler tous les deux "WebApp")
// 3. Déployer > Nouveau déploiement > Type : Application Web
//    - Description       : "Gestion Locataires mobile"
//    - Exécuter en tant que : Moi (votre compte Google)
//    - Qui a accès       : Moi uniquement
// 4. Copier l'URL fournie (https://script.google.com/macros/s/.../exec)
// 5. iPhone : Safari > ouvrir l'URL > Partager > Sur l'écran d'accueil
//    Android: Chrome > ouvrir l'URL > Menu ⋮ > Ajouter à l'écran d'accueil
//
// L'icône lance l'app comme une PWA — toutes les actions du menu accessibles.
// =============================================================================


/**
 * Point d'entrée HTTP — sert l'interface mobile.
 */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Mobile')
    .setTitle('🏠 Gestion Locataires')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}


// ---------------------------------------------------------------------------
// HELPERS — équivalents web de getTenantData (qui dépend de la ligne active)
// ---------------------------------------------------------------------------

/**
 * Lit une ligne spécifique de l'onglet Locataires par numéro de ligne.
 * Remplace getTenantData() qui se base sur la ligne active du Sheet.
 */
function getTenantByRow(row) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Locataires');
  if (!sheet) throw new Error('Onglet "Locataires" introuvable.');
  if (row < 2) throw new Error('Ligne invalide (>= 2 requise).');

  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var values = sheet.getRange(row, 1, 1, sheet.getLastColumn()).getValues()[0];

  var tenant = {};
  for (var i = 0; i < headers.length; i++) {
    tenant[headers[i].toString().trim()] = values[i];
  }
  tenant._rowIndex = row;
  tenant._sheet = sheet;
  return tenant;
}

/**
 * Liste les locataires pour la dropdown.
 * @return {Array<{row,nom,chambre,statut,email}>}
 */
function webGetTenants() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Locataires');
  if (!sheet) throw new Error('Onglet "Locataires" introuvable.');
  var data = sheet.getDataRange().getValues();
  var headers = data[0];

  function col(name) {
    for (var i = 0; i < headers.length; i++) {
      if (headers[i].toString().trim() === name) return i;
    }
    return -1;
  }
  var iNom = col('Locataire_Nom');
  var iChambre = col('Chambre');
  // Colonne A : "Actif" (case à cocher) ou ancien "STATUT" (texte) — compat
  var iStatut = col('Actif');
  if (iStatut < 0) iStatut = col('STATUT');
  var iEmail = col('EMAIL');
  var iBail = col('ID_PDF_BAIL');
  var iEdl = col('ID_PDF_EDL');

  // Chambres dont la quittance du mois CIBLE (cf. getMoisQuittanceCible) est
  // déjà enregistrée — même mois que celui du bouton 1 clic.
  var chambresPayees = chambresQuittanceesPourMois(getMoisQuittanceCible().label);

  var tenants = [];
  for (var r = 1; r < data.length; r++) {
    var nom = (data[r][iNom] || '').toString().trim();
    if (!nom) continue;
    var rawStatut = iStatut >= 0 ? data[r][iStatut] : '';
    var chambre = data[r][iChambre] || '';
    tenants.push({
      row: r + 1,
      nom: nom,
      chambre: chambre,
      statut: (rawStatut === true || rawStatut === false) ? '' : (rawStatut || '').toString().trim(),
      actif: statutValueIsActif(rawStatut),
      email: (iEmail >= 0 ? (data[r][iEmail] || '') : '').toString(),
      // État des documents (badges UI)
      bail: iBail >= 0 ? !!(data[r][iBail] || '').toString().trim() : false,
      edl: iEdl >= 0 ? !!(data[r][iEdl] || '').toString().trim() : false,
      // Quittance du mois courant déjà envoyée pour cette chambre ?
      quittanceMois: chambresPayees['' + parseInt(chambre, 10)] === true
    });
  }
  return tenants;
}

/**
 * Mois visé par la quittance « 1 clic », selon le jour du mois.
 *
 * Le virement arrive en général en fin de mois pour le loyer du mois suivant :
 *   - à partir du 25 → quittance du mois SUIVANT ;
 *   - avant le 25    → quittance du mois EN COURS (couvre le « avant le 10 »
 *     du cas nominal, et les paiements tardifs du 10 au 24).
 *
 * Source de vérité unique : l'UI affiche le mois renvoyé ici, et
 * webEnvoyerQuittanceDirecte génère ce même mois — pas de divergence
 * possible entre le libellé du bouton et le PDF produit.
 *
 * @param {Date} [now] — Date de référence (défaut : maintenant).
 * @return {{mois:number, annee:number, label:string, suivant:boolean}}
 */
function getMoisQuittanceCible(now) {
  now = now || new Date();
  var jour = now.getDate();
  var mois = now.getMonth() + 1;
  var annee = now.getFullYear();
  var suivant = (jour >= JOUR_BASCULE_MOIS_SUIVANT);
  if (suivant) {
    mois += 1;
    if (mois > 12) { mois = 1; annee += 1; }
  }
  return {
    mois: mois,
    annee: annee,
    label: MOIS_FR[mois - 1] + ' ' + annee,
    suivant: suivant
  };
}

/** Jour du mois à partir duquel la quittance 1 clic vise le mois suivant. */
var JOUR_BASCULE_MOIS_SUIVANT = 25;

/**
 * Retourne un dictionnaire { "1": true, "2": true, ... } des numéros de
 * chambre dont la quittance du mois donné est déjà inscrite dans
 * l'onglet "Suivi Loyers" (cellule > 0).
 * @param {string} moisNom — ex. "Juin 2026".
 * @return {Object<string, boolean>}
 */
function chambresQuittanceesPourMois(moisNom) {
  var out = {};
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Suivi Loyers');
  if (!sheet) return out;
  var data = sheet.getDataRange().getValues();
  var cible = normalizeMoisKey(moisNom);

  // Comparaison normalisée (cellule éventuellement convertie en date par
  // Sheets) et parcours de TOUTES les lignes du mois : d'anciens doublons
  // peuvent répartir les chambres sur plusieurs lignes, s'arrêter à la
  // première en manquerait une partie.
  for (var i = 1; i < data.length; i++) {
    if (normalizeMoisKey(data[i][0]) !== cible) continue;
    // Colonnes B,C,D = Chambre 1,2,3
    for (var ch = 1; ch <= 3; ch++) {
      var val = parseEuro(data[i][ch]);
      if (!isNaN(val) && val > 0) out['' + ch] = true;
    }
  }
  return out;
}

/**
 * true si la quittance du mois CIBLE est déjà enregistrée pour la chambre.
 * @param {(number|string)} chambre — numéro de chambre.
 * @return {boolean}
 */
function webQuittanceDejaEnvoyee(chambre) {
  var payees = chambresQuittanceesPourMois(getMoisQuittanceCible().label);
  return payees['' + parseInt(chambre, 10)] === true;
}

/**
 * true si la valeur brute de la colonne A correspond à un colocataire actif.
 * Case cochée (true) → actif ; décochée (false) → inactif ;
 * texte autre que "Parti"/vide → actif (rétro-compat).
 */
function statutValueIsActif(v) {
  if (v === true) return true;
  if (v === false) return false;
  var s = (v || '').toString().trim();
  if (s === '') return false;
  return s.toLowerCase() !== 'parti';
}

/**
 * Métadonnées côté client (bailleur, mois/année par défaut).
 */
function webGetMeta() {
  var config = getConfig();
  var cible = getMoisQuittanceCible();
  return {
    bailleur: config['Bailleur_Nom'] || '',
    // Mois pré-sélectionné dans la carte « mois choisi » ET mois du bouton
    // 1 clic : calculés côté serveur pour que le libellé affiché corresponde
    // exactement au PDF généré (le fuseau du navigateur peut différer).
    moisDefaut: cible.mois,
    anneeDefaut: cible.annee,
    moisCibleLabel: cible.label,
    moisCibleSuivant: cible.suivant
  };
}


// ---------------------------------------------------------------------------
// ACTIONS — wrappers sans SpreadsheetApp.getUi()
// Chaque fonction lève une Error en cas d'échec, ou retourne {ok, message}.
// ---------------------------------------------------------------------------

/**
 * Refus structuré quand régénérer écraserait un document rattaché à une
 * signature électronique, `null` si la voie est libre.
 *
 * Le client affiche le message et rappelle la même fonction avec
 * `confirmerSignature = true` si l'utilisateur assume la perte.
 *
 * @param {Object} tenant
 * @param {Array<string>} typesDoc — `'BAIL'` et/ou `'EDL'`, ceux réellement régénérés.
 * @param {boolean} confirmerSignature
 * @return {Object|null}
 */
function webBlocageSignature(tenant, typesDoc, confirmerSignature) {
  if (confirmerSignature === true) return null;
  if (typeof signatureBlocageRegeneration !== 'function') return null;
  var messages = typesDoc
    .map(function(t) { return signatureBlocageRegeneration(tenant, t); })
    .filter(function(m) { return !!m; });
  if (!messages.length) return null;
  return {
    ok: false,
    confirmationRequise: true,
    message: '⚠️ ' + messages.join('\n\n')
  };
}

function webGenererBail(row, force, confirmerSignature) {
  var tenant = getTenantByRow(row);
  if (!force && (tenant['ID_PDF_BAIL'] || '').toString().trim()) {
    throw new Error('Bail déjà généré (ID_PDF_BAIL renseigné). Régénération annulée — utilisez « Régénérer » pour écraser.');
  }
  var blocage = webBlocageSignature(tenant, ['BAIL'], confirmerSignature);
  if (blocage) return blocage;

  var config = getConfig();
  var chambre = getChambreData(tenant['Chambre']);
  var result = generateLeaseDoc(tenant, config, chambre);
  updateTenantCell(tenant._sheet, tenant._rowIndex, 'ID_PDF_BAIL', result.pdfFile.getId());
  return { ok: true, message: '✅ Bail généré\n' + result.pdfFile.getName() };
}

function webGenererEDL(row, force, confirmerSignature) {
  var tenant = getTenantByRow(row);
  if (!force && (tenant['ID_PDF_EDL'] || '').toString().trim()) {
    throw new Error('EDL déjà généré (ID_PDF_EDL renseigné). Régénération annulée — utilisez « Régénérer » pour écraser.');
  }
  var blocage = webBlocageSignature(tenant, ['EDL'], confirmerSignature);
  if (blocage) return blocage;

  var config = getConfig();
  var result = generateEDL(tenant, config);
  updateTenantCell(tenant._sheet, tenant._rowIndex, 'ID_PDF_EDL', result.pdfFile.getId());
  updateTenantCellIfExists(tenant._sheet, tenant._rowIndex, 'ID_DOC_EDL', result.docId);
  return { ok: true, message: '✅ EDL généré\n' + result.pdfFile.getName() };
}

function webGenererBailEtEDL(row, force, confirmerSignature) {
  var tenant = getTenantByRow(row);
  var config = getConfig();
  var chambre = getChambreData(tenant['Chambre']);

  var bailExiste = !!(tenant['ID_PDF_BAIL'] || '').toString().trim();
  var edlExiste = !!(tenant['ID_PDF_EDL'] || '').toString().trim();

  // Le garde-fou ne porte que sur les documents réellement régénérés : sans
  // force, les pièces déjà là sont conservées et ne risquent rien.
  var regeneres = [];
  if (!bailExiste || force) regeneres.push('BAIL');
  if (!edlExiste || force) regeneres.push('EDL');
  var blocage = webBlocageSignature(tenant, regeneres, confirmerSignature);
  if (blocage) return blocage;

  // Sans force : ne (re)génère que les pièces manquantes, signale les existantes
  var lignes = [];
  if (!bailExiste || force) {
    var bail = generateLeaseDoc(tenant, config, chambre);
    updateTenantCell(tenant._sheet, tenant._rowIndex, 'ID_PDF_BAIL', bail.pdfFile.getId());
    lignes.push('✅ Bail : ' + bail.pdfFile.getName());
  } else {
    lignes.push('⏭️ Bail déjà généré (conservé)');
  }
  if (!edlExiste || force) {
    var edl = generateEDL(tenant, config);
    updateTenantCell(tenant._sheet, tenant._rowIndex, 'ID_PDF_EDL', edl.pdfFile.getId());
    updateTenantCellIfExists(tenant._sheet, tenant._rowIndex, 'ID_DOC_EDL', edl.docId);
    lignes.push('✅ EDL : ' + edl.pdfFile.getName());
  } else {
    lignes.push('⏭️ EDL déjà généré (conservé)');
  }

  return { ok: true, message: lignes.join('\n') };
}

function webDemandePieces(row) {
  var tenant = getTenantByRow(row);
  var config = getConfig();
  var chambre = getChambreData(tenant['Chambre']);
  if (!tenant['EMAIL']) throw new Error('Pas d\'email pour ce locataire.');
  createDemandePiecesDraft(tenant, config, chambre);
  return { ok: true, message: '✅ Brouillon Gmail créé\n' + tenant['EMAIL'] };
}

/**
 * Brouillon "demande de pièces" pour un candidat qui n'a pas (encore) de ligne
 * dans l'onglet Locataires — l'email est saisi à la main dans la web app.
 * Les champs absents (dates, adresse…) sont rendus "___" par formatValue.
 *
 * @param {string} email — Adresse du candidat (obligatoire).
 * @param {string} [nom] — "NOM Prénom" ; alimente {{Locataire_Nom}} / {{Locataire_Prenom}}.
 * @param {(number|string)} [chambreId] — Chambre pressentie ; alimente loyer/charges/caution.
 * @return {{ok:boolean, message:string}}
 */
function webDemandePiecesLibre(email, nom, chambreId) {
  email = (email || '').toString().trim();
  if (!email) throw new Error('Adresse email requise.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error('Adresse email invalide : ' + email);
  }

  var config = getConfig();
  // Sans chambre : {} suffit, formatEuro renvoie "___" pour les montants absents.
  var chambre = {};
  var chambreVal = (chambreId === null || chambreId === undefined) ? '' : chambreId.toString().trim();
  if (chambreVal) chambre = getChambreData(chambreVal);

  var tenant = {
    'Locataire_Nom': (nom || '').toString().trim(),
    'EMAIL': email,
    'Chambre': chambreVal
  };

  createDemandePiecesDraft(tenant, config, chambre);
  return { ok: true, message: '✅ Brouillon Gmail créé\n' + email };
}

function webEnvoyerDossier(row) {
  var tenant = getTenantByRow(row);
  var config = getConfig();
  var chambre = getChambreData(tenant['Chambre']);
  if (!tenant['EMAIL']) throw new Error('Pas d\'email pour ce locataire.');
  if (!tenant['ID_PDF_BAIL']) throw new Error('Générez d\'abord le bail.');
  if (!tenant['ID_PDF_EDL']) throw new Error('Générez d\'abord l\'EDL.');

  createDossierLocationDraft(tenant, config, chambre);
  // La colonne A ("Actif") n'est plus écrite par cette macro (gérée manuellement / toggle web app).
  return { ok: true, message: '✅ Brouillon dossier créé\n' + tenant['EMAIL'] };
}

function webGenererQuittance(row, mois, annee) {
  var tenant = getTenantByRow(row);
  var config = getConfig();
  var chambre = getChambreData(tenant['Chambre']);

  if (isTenantParti(tenant)) throw new Error('Colocataire inactif (case "Actif" décochée) — quittance refusée.');

  mois = parseInt(mois, 10);
  annee = parseInt(annee, 10);
  if (isNaN(mois) || mois < 1 || mois > 12) throw new Error('Mois invalide.');
  if (isNaN(annee) || annee < 2000) throw new Error('Année invalide.');

  // Détection premier / dernier loyer proratisé (helper partagé Code.gs)
  var loyerCC = parseFloat(chambre['Loyer CC']) || 0;
  var detection = detectMontantOverride(tenant, chambre, mois, annee);
  var montantTotal = detection.montant;
  var moisNom = MOIS_FR[mois - 1] + ' ' + annee;

  var result = generateQuittance(tenant, config, chambre, mois, annee, montantTotal);

  var montantSuivi = (montantTotal !== null) ? montantTotal : loyerCC;
  addSuiviLoyer(tenant, chambre, moisNom, montantSuivi);

  var draftMsg = '';
  if (tenant['EMAIL']) {
    createQuittanceDraft(tenant, config, chambre, moisNom, result.pdfFile, montantTotal);
    draftMsg = '\n📧 Brouillon Gmail créé pour ' + tenant['EMAIL'];
  } else {
    draftMsg = '\n⚠️ Pas d\'email — brouillon non créé';
  }

  var prefix = detection.type === 'premier' ? '⚙️ Premier loyer détecté : ' + formatEuro(montantTotal) + '\n' :
               detection.type === 'dernier' ? '⚙️ Dernier loyer détecté : ' + formatEuro(montantTotal) + '\n' : '';
  return { ok: true, message: prefix + '✅ Quittance ' + moisNom + ' générée\n' + result.pdfFile.getName() + draftMsg };
}

/**
 * Répare l'onglet "Suivi Loyers" depuis la web app (voir reparerSuiviLoyers).
 * À lancer si une quittance envoyée reste affichée comme manquante.
 *
 * NOTE : plus de bouton dans l'UI mobile (le suivi des loyers ne s'y consulte
 * pas). Accessible via le menu Sheet "🔧 Réparer le suivi des loyers"
 * (menuReparerSuiviLoyers) ; wrapper conservé pour un appel manuel/futur.
 * @return {{ok:boolean, message:string}}
 */
function webReparerSuiviLoyers() {
  var res = reparerSuiviLoyers();
  return {
    ok: true,
    message: '🔧 Suivi Loyers réparé\n' +
      res.lignesAvant + ' ligne(s) → ' + res.lignesApres + '\n' +
      res.fusionnees + ' doublon(s) fusionné(s)'
  };
}

function webEnvoyerAttestationAssurance(row) {
  var tenant = getTenantByRow(row);
  var config = getConfig();
  var chambre = getChambreData(tenant['Chambre']);
  if (!tenant['EMAIL']) throw new Error('Pas d\'email pour ce locataire.');
  if (!config['ID_ATTESTATION_ASSURANCE']) throw new Error('ID_ATTESTATION_ASSURANCE manquant en Config.');
  var assuranceVal = parseEuro(tenant['Assurance']);
  if (isNaN(assuranceVal) || assuranceVal <= 0) throw new Error('Colonne "Assurance" vide ou invalide.');

  var result = generateAttestationAssurance(tenant, config, chambre);
  createAttestationAssuranceDraft(tenant, config, chambre, result.pdfFile);
  return { ok: true, message: '✅ Attestation générée\n' + result.pdfFile.getName() + '\n📧 Brouillon créé pour ' + tenant['EMAIL'] };
}


// ---------------------------------------------------------------------------
// NOUVEAU — Gestion "Actif" (colonne A) + envoi direct quittance 1 clic
// ---------------------------------------------------------------------------

/**
 * Coche / décoche la case "Actif" (colonne A) d'un colocataire.
 * @param {number} row — Ligne du locataire (>= 2).
 * @param {boolean} actif — true (coché) ou false (décoché).
 * @return {{ok:boolean, message:string, actif:boolean}}
 */
function webSetActif(row, actif) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Locataires');
  if (!sheet) throw new Error('Onglet "Locataires" introuvable.');
  if (row < 2) throw new Error('Ligne invalide (>= 2 requise).');

  var tenant = getTenantByRow(row);
  var colName = getStatutColName(sheet);          // 'Actif' (ou 'STATUT' en compat)
  var val = (actif === true || actif === 'true');
  updateTenantCell(sheet, row, colName, val);

  return {
    ok: true,
    actif: val,
    message: (val ? '✅ ' : '⬜ ') + tenant['Locataire_Nom'] + ' marqué ' + (val ? 'ACTIF' : 'inactif')
  };
}

/**
 * ENVOI DIRECT (sans brouillon) de la quittance à un colocataire, pour le
 * mois renvoyé par getMoisQuittanceCible() (mois suivant à partir du 25,
 * mois en cours avant). Déclenché par le bouton "1 clic" de la web app
 * quand le virement est constaté.
 *
 * Étapes : garde-fous → détection premier loyer → génération PDF →
 * mise à jour Suivi Loyers → envoi email direct via sendQuittanceEmail.
 *
 * @param {number} row — Ligne du locataire.
 * @return {{ok:boolean, message:string}}
 */
function webEnvoyerQuittanceDirecte(row, force) {
  var tenant = getTenantByRow(row);
  var config = getConfig();
  var chambre = getChambreData(tenant['Chambre']);

  if (isTenantParti(tenant)) {
    throw new Error('Colocataire inactif (case "Actif" décochée) — envoi refusé.');
  }
  if (!tenant['EMAIL']) throw new Error('Pas d\'email pour ce colocataire.');

  // Garde anti-double-envoi : quittance du mois en cours déjà enregistrée ?
  if (!force && webQuittanceDejaEnvoyee(tenant['Chambre'])) {
    throw new Error('Quittance du mois en cours déjà envoyée pour cette chambre (voir « Suivi Loyers »). Renvoi annulé.');
  }

  // Mois visé : suivant à partir du 25 (virement de fin de mois), sinon
  // mois en cours. Même règle que le libellé du bouton côté UI.
  var cible = getMoisQuittanceCible();
  var mois = cible.mois;
  var annee = cible.annee;

  // Détection premier / dernier loyer proratisé (helper partagé Code.gs)
  var loyerCC = parseFloat(chambre['Loyer CC']) || 0;
  var detection = detectMontantOverride(tenant, chambre, mois, annee);
  var montantTotal = detection.montant;
  var moisNom = MOIS_FR[mois - 1] + ' ' + annee;

  // Génération du PDF de quittance
  var result = generateQuittance(tenant, config, chambre, mois, annee, montantTotal);

  // Suivi des loyers
  var montantSuivi = (montantTotal !== null) ? montantTotal : loyerCC;
  addSuiviLoyer(tenant, chambre, moisNom, montantSuivi);

  // ENVOI DIRECT (pas de brouillon)
  var sentTo = sendQuittanceEmail(tenant, config, chambre, moisNom, result.pdfFile, montantTotal);

  var prefix = detection.type === 'premier' ? '⚙️ Premier loyer détecté : ' + formatEuro(montantTotal) + '\n' :
               detection.type === 'dernier' ? '⚙️ Dernier loyer détecté : ' + formatEuro(montantTotal) + '\n' : '';
  return {
    ok: true,
    message: prefix + '📨 Quittance ' + moisNom + ' ENVOYÉE à ' + sentTo + '\n' + result.pdfFile.getName()
  };
}
