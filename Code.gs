// =============================================================================
// GESTION LOCATAIRE — Google Apps Script
// Système automatisé de gestion des baux pour colocation meublée
// =============================================================================
//
// INSTALLATION :
// 1. Ouvrir le Google Sheet "Gestion Locataires"
// 2. Extensions > Apps Script
// 3. Coller ce code dans l'éditeur
// 4. Sauvegarder (Ctrl+S)
// 5. Recharger le Google Sheet → le menu "🏠 Gestion Locataire" apparaît
//
// PRÉREQUIS :
// - Google Sheet avec les onglets : Locataires, Config, Chambres, Templates
// - Google Docs "Bail_Template" et "Etat_des_lieux_Template" sur Drive (avec les {{variables}})
// - Dossier Drive "02_LOCATAIRE" (les sous-dossiers par locataire sont créés automatiquement)
// - Remplir l'onglet Config avec les IDs et paramètres :
//     Bailleur_Nom, Bailleur_Date, Bailleur_Lieu, Bailleur_Adresse,
//     Location_Adresse, Location_Construction_Date, Location_Surface,
//     Location_Pieces, Location_Autres, Chauffage, Eau,
//     Loyer_Date, ID_BAIL_TEMPLATE, ID_EDL_TEMPLATE, ID_QUITTANCE_TEMPLATE,
//     ID_SIGNATURE_IMAGE, ID_DOSSIER_LOCATAIRES,
//     ID_DOSSIER_DOCS_COMMUNS
// =============================================================================


// ---------------------------------------------------------------------------
// 1. MENU PERSONNALISÉ
// ---------------------------------------------------------------------------

/**
 * Crée le menu personnalisé au chargement du Google Sheet.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🏠 Gestion Locataire')
    .addItem('📄 Générer le bail', 'menuGenererBail')
    .addItem('📄 Générer l\'état des lieux', 'menuGenererEDL')
    .addItem('📄 Générer bail + EDL', 'menuGenererBailEtEDL')
    .addSeparator()
    .addItem('📧 Demander les pièces justificatives', 'menuDemandePieces')
    .addItem('📧 Envoyer le dossier de location', 'menuEnvoyerDossierLocation')
    .addSeparator()
    .addItem('🧾 Générer la quittance + brouillon email', 'menuGenererQuittance')
    .addItem('🧾🧾 Quittances groupées (lignes sélectionnées)', 'menuGenererQuittancesGroupees')
    .addSeparator()
    .addItem('🛡️ Envoyer attestation d\'assurance', 'menuEnvoyerAttestationAssurance')
    .addSeparator()
    .addItem('✍️ Envoyer en signature (Documenso)', 'menuEnvoyerEnSignature')
    .addItem('🔄 Actualiser les statuts de signature', 'menuActualiserStatutsSignature')
    .addItem('🚫 Annuler une demande de signature', 'menuAnnulerSignature')
    .addSeparator()
    .addItem('📩 Répondre au préavis (consignes ménage)', 'menuRepondrePreavis')
    .addItem('📧 Envoyer l\'EDL à l\'ami (Word + PDF)', 'menuEnvoyerEDLAmi')
    .addItem('🗂️ Archiver les dossiers inactifs (→ OLD)', 'menuArchiverDossiersInactifs')
    .addItem('🔧 Réparer le suivi des loyers', 'menuReparerSuiviLoyers')
    .addSeparator()
    .addItem('➕ Ajouter une charge', 'menuAjouterCharge')
    .addItem('📊 Importer relevé CSV banque', 'menuImporterCSV')
    .addItem('🏦 Importer tableau d\'amortissement', 'menuImporterAmortissement')
    .addItem('📈 Actualiser le bilan charges', 'menuActualiserBilan')
    .addToUi();
}


// ---------------------------------------------------------------------------
// 2. LECTURE DES DONNÉES
// ---------------------------------------------------------------------------

/**
 * Lit la configuration depuis l'onglet "Config".
 * Format attendu : colonne A = clé, colonne B = valeur.
 * @return {Object} Paires clé/valeur de la config.
 */
function getConfig() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Config');
  if (!sheet) throw new Error('Onglet "Config" introuvable.');
  var data = sheet.getDataRange().getValues();
  var config = {};
  for (var i = 1; i < data.length; i++) { // skip header
    if (data[i][0]) {
      config[data[i][0].toString().trim()] = data[i][1];
    }
  }
  return config;
}

/**
 * Lit les données de la chambre depuis l'onglet "Chambres".
 * @param {number|string} chambreId — Numéro de chambre (1, 2, ou 3).
 * @return {Object} Données de la chambre.
 */
function getChambreData(chambreId) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Chambres');
  if (!sheet) throw new Error('Onglet "Chambres" introuvable.');
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  // Trouver l'index de la colonne "ID Chambre"
  var idColIndex = -1;
  for (var j = 0; j < headers.length; j++) {
    if (headers[j].toString().trim() === 'ID Chambre') {
      idColIndex = j;
      break;
    }
  }
  if (idColIndex === -1) throw new Error('Colonne "ID Chambre" introuvable dans l\'onglet "Chambres".');

  for (var i = 1; i < data.length; i++) {
    if (data[i][idColIndex].toString() === chambreId.toString()) {
      var chambre = {};
      for (var j = 0; j < headers.length; j++) {
        chambre[headers[j].toString().trim()] = data[i][j];
      }
      return chambre;
    }
  }
  throw new Error('Chambre n°' + chambreId + ' introuvable dans l\'onglet "Chambres".');
}

/**
 * Lit les données du locataire sur la ligne active de l'onglet "Locataires".
 * @return {Object} { rowIndex, data } — données du locataire + n° de ligne.
 */
function getTenantData() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Locataires');
  if (!sheet) throw new Error('Onglet "Locataires" introuvable.');
  var row = sheet.getActiveRange().getRow();
  if (row < 2) throw new Error('Sélectionnez une ligne de locataire (ligne 2 ou plus).');

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
 * Lit les données de TOUTES les lignes sélectionnées dans l'onglet "Locataires".
 * Permet de traiter plusieurs locataires en une seule action (quittances groupées).
 * @return {Object[]} Tableau de données locataires ({ ...champs, _rowIndex, _sheet }).
 */
function getSelectedTenantsData() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Locataires');
  if (!sheet) throw new Error('Onglet "Locataires" introuvable.');

  var selection = sheet.getActiveRange();
  var startRow = selection.getRow();
  var numRows = selection.getNumRows();

  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var tenants = [];

  for (var r = 0; r < numRows; r++) {
    var row = startRow + r;
    if (row < 2) continue; // ignorer la ligne d'en-tête si sélectionnée par erreur

    var values = sheet.getRange(row, 1, 1, sheet.getLastColumn()).getValues()[0];
    var tenant = {};
    for (var i = 0; i < headers.length; i++) {
      tenant[headers[i].toString().trim()] = values[i];
    }
    tenant._rowIndex = row;
    tenant._sheet = sheet;
    tenants.push(tenant);
  }

  if (tenants.length === 0) {
    throw new Error('Aucune ligne de locataire sélectionnée (sélectionnez les lignes 2 et plus).');
  }
  return tenants;
}

/**
 * Met à jour une cellule dans l'onglet Locataires pour la ligne donnée.
 * @param {Sheet} sheet — Feuille Locataires.
 * @param {number} row — Numéro de ligne.
 * @param {string} columnName — Nom de l'en-tête de colonne.
 * @param {*} value — Valeur à écrire.
 */
function updateTenantCell(sheet, row, columnName, value) {
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var colIndex = -1;
  for (var i = 0; i < headers.length; i++) {
    if (headers[i].toString().trim() === columnName) {
      colIndex = i + 1;
      break;
    }
  }
  if (colIndex === -1) throw new Error('Colonne "' + columnName + '" introuvable.');
  sheet.getRange(row, colIndex).setValue(value);
}

/**
 * Comme updateTenantCell, mais ne lève PAS d'erreur si la colonne n'existe pas.
 * Utilisé pour les colonnes optionnelles (ex: ID_DOC_EDL).
 * @return {boolean} true si la cellule a été écrite.
 */
function updateTenantCellIfExists(sheet, row, columnName, value) {
  try {
    updateTenantCell(sheet, row, columnName, value);
    return true;
  } catch (e) {
    return false;
  }
}


// ---------------------------------------------------------------------------
// 2bis. STATUT / ACTIVITÉ DU COLOCATAIRE (colonne A)
// ---------------------------------------------------------------------------
//
// La colonne A s'appelle désormais "Actif" (ex-"STATUT") et contient une
// case à cocher (booléen TRUE/FALSE). Les anciennes valeurs texte ("Parti",
// "Dossier envoyé") restent tolérées pour rétro-compatibilité.
//
// Convention :
//   - case cochée (true)         → colocataire actif
//   - case décochée (false)      → colocataire inactif / parti
//   - cellule vide ('')          → non renseigné (traité comme NON parti)
//   - ancien texte "Parti"       → inactif / parti

/**
 * Renomme le nom de la colonne A présent dans la feuille (compat).
 * @return {string} 'Actif' si présent, sinon 'STATUT', sinon 'Actif' par défaut.
 */
function getStatutColName(sheet) {
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  for (var i = 0; i < headers.length; i++) {
    if (headers[i].toString().trim() === 'Actif') return 'Actif';
  }
  for (var j = 0; j < headers.length; j++) {
    if (headers[j].toString().trim() === 'STATUT') return 'STATUT';
  }
  return 'Actif';
}

/**
 * Lit la valeur brute de la colonne A pour un tenant (objet déjà chargé),
 * quel que soit le nom de l'en-tête.
 */
function getTenantStatutRaw(tenant) {
  if (tenant['Actif'] !== undefined) return tenant['Actif'];
  if (tenant['STATUT'] !== undefined) return tenant['STATUT'];
  return '';
}

/**
 * true si le colocataire est actif (case cochée, ou valeur texte non-"Parti").
 */
function isTenantActif(tenant) {
  var v = getTenantStatutRaw(tenant);
  if (v === true) return true;
  if (v === false) return false;
  var s = (v || '').toString().trim();
  if (s === '') return false;                 // case vide → pas (encore) actif
  return s.toLowerCase() !== 'parti';         // texte autre que "Parti" → actif
}

/**
 * true si le colocataire est parti / inactif (case décochée ou texte "Parti").
 * Une cellule vide n'est PAS considérée comme "parti" (rétro-compat menu).
 */
function isTenantParti(tenant) {
  var v = getTenantStatutRaw(tenant);
  if (v === false) return true;
  var s = (v || '').toString().trim();
  return s.toLowerCase() === 'parti';
}


// ---------------------------------------------------------------------------
// 3. CONSTRUCTION DU DICTIONNAIRE DE REMPLACEMENT
// ---------------------------------------------------------------------------

/**
 * Construit le dictionnaire {{variable}} → valeur pour le bail.
 * Fusionne les données Config + Locataire + Chambre.
 * @param {Object} tenant — Données locataire.
 * @param {Object} config — Données config.
 * @param {Object} chambre — Données chambre.
 * @return {Object} Dictionnaire de remplacement.
 */
function buildReplacements(tenant, config, chambre) {
  var replacements = {};

  // --- Config (bailleur + logement) ---
  // Clés Config exactes telles que dans l'onglet Config du Sheet
  var configKeys = [
    'Bailleur_Nom', 'Bailleur_Date', 'Bailleur_Lieu', 'Bailleur_Adresse', 'Bailleur_Ville',
    'Location_Adresse', 'Location_Construction_Date', 'Location_Surface',
    'Location_Pieces', 'Location_Autres', 'Chauffage', 'Eau', 'Loyer_Date'
  ];
  configKeys.forEach(function(key) {
    // La variable dans le template utilise toujours le format {{Clé}} tel quel
    replacements['{{' + key + '}}'] = formatValue(config[key]);
  });

  // --- Locataire ---
  // En-têtes de l'onglet Locataires
  var tenantKeys = [
    'Locataire_Nom', 'Locataire_Date', 'Locataire_Lieu', 'Locataire_Adresse',
    'Date_Début', 'Date_Fin'
  ];
  tenantKeys.forEach(function(key) {
    replacements['{{' + key + '}}'] = formatValue(tenant[key]);
  });

  // --- Prénom (dernier mot de Locataire_Nom, ex: "DE LA FONTAINE Jean" → "Jean")
  var fullName = (tenant['Locataire_Nom'] || '').toString().trim();
  var parts = fullName.split(/\s+/);
  replacements['{{Locataire_Prenom}}'] = parts.length > 1 ? parts[parts.length - 1] : fullName;

  // --- Chambre ---
  // En-têtes de l'onglet Chambres (avec espaces, pas d'underscores)
  replacements['{{Chambre}}'] = formatValue(tenant['Chambre']);
  replacements['{{Charges}}'] = formatEuro(chambre['Charges']);
  replacements['{{Loyer_HC}}'] = formatEuro(chambre['Loyer HC']);
  replacements['{{Loyer_CC}}'] = formatEuro(chambre['Loyer CC']);
  replacements['{{Caution}}'] = formatEuro(chambre['Caution']);

  return replacements;
}

/**
 * Formate une valeur pour insertion dans le document.
 * Gère les dates, nombres et chaînes.
 */
function formatValue(val) {
  if (val === null || val === undefined || val === '') return '___';
  if (val instanceof Date) {
    return Utilities.formatDate(val, Session.getScriptTimeZone(), 'dd/MM/yyyy');
  }
  return val.toString();
}

/**
 * Formate un montant en euros (ex: "620,00 €").
 */
function formatEuro(val) {
  if (val === null || val === undefined || val === '') return '___';
  var num = parseFloat(val);
  if (isNaN(num)) return val.toString();
  return num.toFixed(2).replace('.', ',') + ' €';
}


// ---------------------------------------------------------------------------
// 4. GÉNÉRATION DU BAIL (Google Docs → PDF)
// ---------------------------------------------------------------------------

/**
 * Duplique le modèle de bail, remplace les variables, enregistre en PDF.
 *
 * Le Google Doc de travail est CONSERVÉ (comme celui de l'état des lieux) et
 * son identifiant écrit dans la colonne ID_DOC_BAIL : c'est lui que la
 * signature électronique copie pour produire le PDF à signer. Sans lui, il
 * faudrait régénérer le bail depuis le modèle au moment de la signature, au
 * risque d'envoyer à la signature un document différent de celui déjà transmis
 * au locataire.
 *
 * @param {Object} tenant — Données locataire.
 * @param {Object} config — Données config.
 * @param {Object} chambre — Données chambre.
 * @return {Object} { docId, pdfFile } — ID du doc généré et fichier PDF.
 */
function generateLeaseDoc(tenant, config, chambre) {
  var templateId = config['ID_BAIL_TEMPLATE'];
  if (!templateId) throw new Error('ID_BAIL_TEMPLATE manquant dans l\'onglet Config.');

  // Nom du document
  var docName = 'Bail_' + tenant['Locataire_Nom'].toString().replace(/\s+/g, '_')
                + '_Chambre' + tenant['Chambre']
                + '_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd');

  // Récupérer ou créer le dossier 02_LOCATAIRE/Prénom Nom
  var folder = getOrCreateTenantFolder(config, tenant['Locataire_Nom']);
  var templateFile = DriveApp.getFileById(templateId);
  var copiedFile = templateFile.makeCopy(docName, folder);
  var docId = copiedFile.getId();

  // Ouvrir et remplacer les variables
  var doc = DocumentApp.openById(docId);
  var body = doc.getBody();
  var replacements = buildReplacements(tenant, config, chambre);

  for (var placeholder in replacements) {
    body.replaceText(escapeRegex(placeholder), replacements[placeholder]);
  }

  doc.saveAndClose();

  // Générer le PDF. Le Google Doc reste disponible pour la signature
  // électronique ; son identifiant est mémorisé si la colonne existe.
  var pdfFile = createLeasePdf(docId, docName, folder);
  if (tenant._sheet && tenant._rowIndex) {
    updateTenantCellIfExists(tenant._sheet, tenant._rowIndex, 'ID_DOC_BAIL', docId);
  }

  return { docId: docId, pdfFile: pdfFile };
}

/**
 * Récupère ou crée le dossier du locataire : 02_LOCATAIRE/Prénom Nom
 * @param {Object} config — Données config (doit contenir ID_DOSSIER_LOCATAIRES).
 * @param {string} tenantName — Nom complet du locataire.
 * @return {Folder} Dossier Drive du locataire.
 */
function getOrCreateTenantFolder(config, tenantName) {
  var parentId = config['ID_DOSSIER_LOCATAIRES'];
  if (!parentId) throw new Error('ID_DOSSIER_LOCATAIRES manquant dans l\'onglet Config.');

  var parentFolder = DriveApp.getFolderById(parentId);
  var folderName = tenantName.toString().trim();

  // Chercher si le sous-dossier existe déjà
  var folders = parentFolder.getFoldersByName(folderName);
  if (folders.hasNext()) {
    return folders.next();
  }

  // Chercher aussi dans LOCATAIRES/OLD (dossiers archivés) pour ne pas
  // recréer un dossier vide si le locataire a déjà été archivé.
  var oldIter = parentFolder.getFoldersByName('OLD');
  if (oldIter.hasNext()) {
    var inOld = oldIter.next().getFoldersByName(folderName);
    if (inOld.hasNext()) {
      return inOld.next();
    }
  }

  // Sinon, le créer
  return parentFolder.createFolder(folderName);
}

/**
 * Récupère ou crée un sous-dossier dans un dossier parent.
 * @param {Folder} parentFolder — Dossier Drive parent.
 * @param {string} subFolderName — Nom du sous-dossier.
 * @return {Folder} Sous-dossier Drive.
 */
function getOrCreateSubFolder(parentFolder, subFolderName) {
  var folders = parentFolder.getFoldersByName(subFolderName);
  if (folders.hasNext()) {
    return folders.next();
  }
  return parentFolder.createFolder(subFolderName);
}

/**
 * Convertit un Google Docs en PDF et le place dans le dossier.
 * @param {string} docId — ID du Google Docs.
 * @param {string} name — Nom du fichier PDF.
 * @param {Folder} folder — Dossier de destination.
 * @return {File} Fichier PDF créé.
 */
function createLeasePdf(docId, name, folder) {
  var doc = DriveApp.getFileById(docId);
  var pdfBlob = doc.getAs('application/pdf').setName(name + '.pdf');
  var pdfFile = folder.createFile(pdfBlob);
  return pdfFile;
}

/**
 * Échappe les caractères spéciaux regex pour replaceText.
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


// ---------------------------------------------------------------------------
// 5. GÉNÉRATION DE L'ÉTAT DES LIEUX
// ---------------------------------------------------------------------------

/**
 * Duplique le modèle d'EDL, remplace les variables.
 * @param {Object} tenant — Données locataire.
 * @param {Object} config — Données config.
 * @return {Object} { docId } — ID du doc généré.
 */
function generateEDL(tenant, config) {
  var templateId = config['ID_EDL_TEMPLATE'];
  if (!templateId) throw new Error('ID_EDL_TEMPLATE manquant dans l\'onglet Config.');

  var docName = 'EDL_' + tenant['Locataire_Nom'].toString().replace(/\s+/g, '_')
                + '_Chambre' + tenant['Chambre']
                + '_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd');

  // Récupérer ou créer le dossier 02_LOCATAIRE/Prénom Nom
  var folder = getOrCreateTenantFolder(config, tenant['Locataire_Nom']);
  var templateFile = DriveApp.getFileById(templateId);
  var copiedFile = templateFile.makeCopy(docName, folder);
  var docId = copiedFile.getId();

  var doc = DocumentApp.openById(docId);
  var body = doc.getBody();

  // Supprimer les sections des chambres qui ne correspondent pas au locataire
  var chambreNum = tenant['Chambre'].toString();
  removeOtherRoomSections(body, chambreNum);

  var replacements = {
    '{{Bailleur_Nom}}': formatValue(config['Bailleur_Nom']),
    '{{Bailleur_Adresse}}': formatValue(config['Bailleur_Adresse']),
    '{{Locataire_Nom}}': formatValue(tenant['Locataire_Nom']),
    '{{Chambre}}': formatValue(tenant['Chambre']),
    // Relevés des compteurs — entrée
    '{{Compteur_Eau}}': formatValue(tenant['Compteur_Eau']),
    '{{Compteur_Elec}}': formatValue(tenant['Compteur_Elec'])
  };

  for (var placeholder in replacements) {
    body.replaceText(escapeRegex(placeholder), replacements[placeholder]);
  }

  // Champs de sortie : balises en blanc dans le template.
  // Si la cellule du Sheet est renseignée → remplacer la balise et colorier en noir.
  // Si la cellule est vide → ne pas toucher (la balise reste en blanc = invisible).
  var sortieFields = [
    { placeholder: '{{Compteur_Eau_Sortie}}', value: tenant['Compteur_Eau_Sortie'] },
    { placeholder: '{{Compteur_Elec_Sortie}}', value: tenant['Compteur_Elec_Sortie'] },
    { placeholder: '{{Locataire_Nouvelle_Adresse}}', value: tenant['Locataire_Nouvelle_Adresse'] }
  ];

  sortieFields.forEach(function(field) {
    if (field.value && field.value.toString().trim() !== '') {
      var formattedValue = formatValue(field.value);
      body.replaceText(escapeRegex(field.placeholder), formattedValue);
      setTextColor(body, formattedValue, '#000000');
    }
  });

  doc.saveAndClose();

  // Générer le PDF
  var pdfFile = createLeasePdf(docId, docName, folder);

  return { docId: docId, pdfFile: pdfFile };
}

/**
 * Cherche toutes les occurrences d'un texte dans le body et force leur couleur.
 * Utilisé pour repasser en noir les valeurs de sortie initialement en blanc.
 * @param {Body} body — Corps du document Google Docs.
 * @param {string} searchText — Texte à chercher.
 * @param {string} hexColor — Couleur hex (ex: '#000000').
 */
function setTextColor(body, searchText, hexColor) {
  var found = body.findText(escapeRegex(searchText));
  while (found) {
    var element = found.getElement();
    var start = found.getStartOffset();
    var end = found.getEndOffsetInclusive();
    element.asText().setForegroundColor(start, end, hexColor);
    found = body.findText(escapeRegex(searchText), found);
  }
}

/**
 * Supprime les sections des chambres non concernées dans l'EDL.
 * Chaque section commence par un élément contenant "CHAMBRE N°X"
 * et se termine juste avant le prochain "CHAMBRE N°" ou la section suivante du document.
 * @param {Body} body — Corps du document Google Docs.
 * @param {string} keepRoom — Numéro de la chambre à conserver (ex: "1").
 */
function removeOtherRoomSections(body, keepRoom) {
  var totalRooms = 3;

  // Supprimer en ordre inverse (3, 2, 1) pour ne pas décaler les index
  for (var room = totalRooms; room >= 1; room--) {
    if (room.toString() === keepRoom) continue;

    var marker = 'CHAMBRE N°' + room;
    var startIndex = findElementIndexByText(body, marker);
    if (startIndex === -1) continue;

    // Trouver la fin de la section : prochain "CHAMBRE N°" ou fin de la zone
    var endIndex = findNextRoomSectionEnd(body, startIndex + 1);

    // Supprimer les éléments de endIndex-1 à startIndex (en ordre inverse)
    for (var i = endIndex - 1; i >= startIndex; i--) {
      body.removeChild(body.getChild(i));
    }
  }
}

/**
 * Trouve l'index du premier élément du body contenant le texte donné.
 * @param {Body} body — Corps du document.
 * @param {string} text — Texte à chercher.
 * @return {number} Index de l'élément, ou -1 si non trouvé.
 */
function findElementIndexByText(body, text) {
  var numChildren = body.getNumChildren();
  for (var i = 0; i < numChildren; i++) {
    var child = body.getChild(i);
    if (child.getText && child.getText().indexOf(text) !== -1) {
      return i;
    }
  }
  return -1;
}

/**
 * Trouve l'index de fin d'une section chambre (début de la prochaine "CHAMBRE N°"
 * ou fin de la zone parties privatives).
 * @param {Body} body — Corps du document.
 * @param {number} startFrom — Index à partir duquel chercher.
 * @return {number} Index du premier élément de la section suivante.
 */
function findNextRoomSectionEnd(body, startFrom) {
  var numChildren = body.getNumChildren();
  for (var i = startFrom; i < numChildren; i++) {
    var child = body.getChild(i);
    if (!child.getText) continue;
    var text = child.getText();
    // Prochain titre de chambre
    if (text.match(/CHAMBRE N°\d/)) return i;
    // Ou début de la section suivante (ex: "4." au début d'un paragraphe)
    if (text.match(/^\d+\.\s/)) return i;
  }
  return numChildren;
}


// ---------------------------------------------------------------------------
// 6. GÉNÉRATION DE LA QUITTANCE DE LOYER
// ---------------------------------------------------------------------------

var MOIS_FR = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];

/**
 * Clé canonique d'un libellé de mois de l'onglet "Suivi Loyers".
 *
 * La colonne A contient normalement du texte ("juillet 2026"), mais Google
 * Sheets peut l'avoir converti en DATE (locale française) sur d'anciennes
 * lignes : la comparaison brute échouait alors systématiquement, laissant la
 * quittance affichée comme manquante dans la web app et créant un doublon de
 * ligne à chaque envoi. On ramène donc toute forme à "mois année" minuscule.
 *
 * @param {*} val — Valeur brute de la cellule (chaîne ou Date).
 * @return {string} Ex. "juillet 2026", ou '' si vide.
 */
function normalizeMoisKey(val) {
  if (val === null || val === undefined || val === '') return '';
  if (val instanceof Date) {
    return MOIS_FR[val.getMonth()] + ' ' + val.getFullYear();
  }
  return val.toString().trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Détecte si le mois demandé correspond au PREMIER ou au DERNIER loyer
 * (proratisé) du locataire, et retourne le montant à appliquer.
 *
 * - Dernier loyer : mois/année = mois de Date_Fin ET colonne Dernier_Loyer
 *   renseignée (> 0). Prioritaire si entrée et sortie tombent le même mois
 *   (dans ce cas, ajuster Dernier_Loyer manuellement dans le Sheet).
 * - Premier loyer : mois/année = mois de Date_Début ET 1er_Loyer renseigné,
 *   > 0 et différent du Loyer CC (logique historique inchangée).
 *
 * @param {Object} tenant — Données locataire.
 * @param {Object} chambre — Données chambre.
 * @param {number} mois — Mois demandé (1-12).
 * @param {number} annee — Année demandée.
 * @return {{montant: number|null, type: string|null}} type = 'premier' | 'dernier' | null.
 */
function detectMontantOverride(tenant, chambre, mois, annee) {
  var loyerCC = parseFloat(chambre['Loyer CC']) || 0;

  // Dernier loyer (sortie ce mois-ci)
  var dateFin = tenant['Date_Fin'];
  var dernierVal = parseEuro(tenant['Dernier_Loyer']);
  if (dateFin instanceof Date
      && dateFin.getMonth() + 1 === mois
      && dateFin.getFullYear() === annee
      && !isNaN(dernierVal) && dernierVal > 0) {
    return { montant: dernierVal, type: 'dernier' };
  }

  // Premier loyer (entrée ce mois-ci)
  var dateDebut = tenant['Date_Début'];
  var premierVal = parseEuro(tenant['1er_Loyer']);
  if (dateDebut instanceof Date
      && dateDebut.getMonth() + 1 === mois
      && dateDebut.getFullYear() === annee
      && !isNaN(premierVal) && premierVal > 0 && premierVal !== loyerCC) {
    return { montant: premierVal, type: 'premier' };
  }

  return { montant: null, type: null };
}

/**
 * Génère une quittance de loyer pour un mois donné.
 * Copie le template, remplace les variables, insère la signature, génère le PDF.
 * @param {Object} tenant — Données locataire.
 * @param {Object} config — Données config.
 * @param {Object} chambre — Données chambre.
 * @param {number} mois — Numéro du mois (1-12).
 * @param {number} annee — Année (ex: 2026).
 * @param {number|null} montantOverride — Montant total à utiliser à la place de Loyer CC (premier loyer proratisé). null = loyer normal.
 * @return {Object} { docId, pdfFile }
 */
function generateQuittance(tenant, config, chambre, mois, annee, montantOverride) {
  var templateId = config['ID_QUITTANCE_TEMPLATE'];
  if (!templateId) throw new Error('ID_QUITTANCE_TEMPLATE manquant dans l\'onglet Config.');

  var moisPadded = ('0' + mois).slice(-2);
  var moisNom = MOIS_FR[mois - 1] + ' ' + annee;

  var docName = 'Quittance_' + tenant['Locataire_Nom'].toString().replace(/\s+/g, '_')
                + '_' + moisPadded + '_' + annee;

  var tenantFolder = getOrCreateTenantFolder(config, tenant['Locataire_Nom']);
  var folder = getOrCreateSubFolder(tenantFolder, 'Quittances');
  var templateFile = DriveApp.getFileById(templateId);
  var copiedFile = templateFile.makeCopy(docName, folder);
  var docId = copiedFile.getId();

  var doc = DocumentApp.openById(docId);
  var body = doc.getBody();

  // Calcul des montants (proratisés si premier loyer)
  var loyerCC = parseFloat(chambre['Loyer CC']) || 0;
  var loyerHC = parseFloat(chambre['Loyer HC']) || 0;
  var charges = parseFloat(chambre['Charges']) || 0;

  if (montantOverride && montantOverride > 0 && loyerCC > 0) {
    var ratio = montantOverride / loyerCC;
    loyerHC = Math.round(loyerHC * ratio * 100) / 100;
    charges = Math.round((montantOverride - loyerHC) * 100) / 100;
    loyerCC = montantOverride;
  }

  // Replacements spécifiques à la quittance
  var replacements = {};
  replacements['{{Bailleur_Nom}}'] = formatValue(config['Bailleur_Nom']);
  replacements['{{Bailleur_Adresse}}'] = formatValue(config['Bailleur_Adresse']);
  replacements['{{Bailleur_Ville}}'] = formatValue(config['Bailleur_Ville']);
  replacements['{{Locataire_Nom}}'] = formatValue(tenant['Locataire_Nom']);
  replacements['{{Location_Adresse}}'] = formatValue(config['Location_Adresse']);
  replacements['{{Loyer_HC}}'] = formatEuro(loyerHC);
  replacements['{{Charges}}'] = formatEuro(charges);
  replacements['{{Loyer_CC}}'] = formatEuro(loyerCC);
  replacements['{{Mois_en_cours}}'] = moisNom;
  replacements['{{Date_Quittance}}'] = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy');

  // Période du mois
  // Par défaut : du 1er au dernier jour du mois.
  // Cas particulier premier loyer : si Date_Début tombe dans le mois sélectionné,
  // on utilise Date_Début comme début de période (ex: arrivée le 06/04 → période 06/04 – 30/04).
  // Cas particulier dernier loyer : si Date_Fin tombe dans le mois sélectionné,
  // on utilise Date_Fin comme fin de période (ex: sortie le 12/09 → période 01/09 – 12/09).
  var premierJour = new Date(annee, mois - 1, 1);
  var dernierJour = new Date(annee, mois, 0);
  var dateDebutTenant = tenant['Date_Début'];
  if (dateDebutTenant instanceof Date
      && dateDebutTenant.getMonth() + 1 === mois
      && dateDebutTenant.getFullYear() === annee) {
    premierJour = dateDebutTenant;
  }
  var dateFinTenant = tenant['Date_Fin'];
  if (dateFinTenant instanceof Date
      && dateFinTenant.getMonth() + 1 === mois
      && dateFinTenant.getFullYear() === annee) {
    dernierJour = dateFinTenant;
  }
  replacements['{{Mois_en_cours_début}}'] = Utilities.formatDate(premierJour, Session.getScriptTimeZone(), 'dd/MM/yyyy');
  replacements['{{Mois_en_cours_fin}}'] = Utilities.formatDate(dernierJour, Session.getScriptTimeZone(), 'dd/MM/yyyy');

  // Date de paiement = date de génération de la quittance
  replacements['{{Date_Paiement}}'] = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy');

  for (var placeholder in replacements) {
    body.replaceText(escapeRegex(placeholder), replacements[placeholder]);
  }

  // Insérer l'image de signature à la place de "(Signature)"
  insertSignatureImage(body, config);

  doc.saveAndClose();

  var pdfFile = createLeasePdf(docId, docName, folder);

  // Supprimer la copie Google Docs (on garde uniquement le PDF)
  DriveApp.getFileById(docId).setTrashed(true);

  return { docId: docId, pdfFile: pdfFile };
}

/**
 * Insère l'image de signature du bailleur à la place du texte "(Signature)".
 * @param {Body} body — Corps du document Google Docs.
 * @param {Object} config — Données config (doit contenir ID_SIGNATURE_IMAGE).
 */
function insertSignatureImage(body, config) {
  var signatureId = config['ID_SIGNATURE_IMAGE'];
  if (!signatureId) return;

  var signatureBlob = DriveApp.getFileById(signatureId).getBlob();
  var found = body.findText('\\(Signature\\)');
  if (!found) return;

  var textElem = found.getElement();
  var para = textElem.getParent().asParagraph();

  // Effacer le texte "(Signature)" et insérer l'image
  para.clear();
  var img = para.appendInlineImage(signatureBlob);
  img.setWidth(150);
  img.setHeight(75);
  para.setAlignment(DocumentApp.HorizontalAlignment.RIGHT);
}


// ---------------------------------------------------------------------------
// 7. SUIVI DES LOYERS
// ---------------------------------------------------------------------------

/**
 * Enregistre le loyer perçu dans l'onglet "Suivi Loyers".
 * Structure : 1 ligne par mois, 1 colonne par chambre, + total.
 * Crée l'onglet et ses en-têtes s'il n'existe pas.
 * @param {Object} tenant — Données locataire.
 * @param {Object} chambre — Données chambre.
 * @param {string} moisNom — Nom du mois + année (ex: "mars 2026").
 * @param {number} [montant] — Montant à inscrire. Si omis, utilise chambre['Loyer CC'].
 */
function addSuiviLoyer(tenant, chambre, moisNom, montant) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Suivi Loyers');

  // Créer l'onglet s'il n'existe pas
  if (!sheet) {
    sheet = ss.insertSheet('Suivi Loyers');
    sheet.appendRow(['Mois', 'Chambre 1', 'Chambre 2', 'Chambre 3', 'Total']);
    sheet.getRange(1, 1, 1, 5).setFontWeight('bold');
    // Formater les colonnes montant en euros
    sheet.getRange('B:E').setNumberFormat('#,##0.00 €');
    // Colonne Mois en TEXTE BRUT : sinon Sheets convertit "juillet 2026" en
    // date (locale FR), la relecture ne retrouve plus le mois et une ligne
    // doublon est créée à chaque quittance.
    sheet.getRange('A2:A').setNumberFormat('@');
  }

  // Trouver ou créer la ligne du mois (comparaison normalisée : tolère une
  // cellule convertie en date, une casse ou des espaces différents)
  var data = sheet.getDataRange().getValues();
  var cible = normalizeMoisKey(moisNom);
  var rowIndex = -1;
  for (var i = 1; i < data.length; i++) {
    if (normalizeMoisKey(data[i][0]) === cible) {
      rowIndex = i + 1; // 1-indexed dans le Sheet
      break;
    }
  }

  if (rowIndex === -1) {
    // Nouvelle ligne pour ce mois
    rowIndex = data.length + 1;
    sheet.getRange(rowIndex, 1).setNumberFormat('@').setValue(moisNom);
    sheet.getRange(rowIndex, 5).setFormula('=B' + rowIndex + '+C' + rowIndex + '+D' + rowIndex);
  }

  // Chambre 1 → colonne B (2), Chambre 2 → colonne C (3), Chambre 3 → colonne D (4)
  var chambreNum = parseInt(tenant['Chambre'], 10);
  var colIndex = chambreNum + 1;

  var valeur = (montant !== undefined && montant !== null) ? montant : (parseFloat(chambre['Loyer CC']) || 0);
  sheet.getRange(rowIndex, colIndex).setValue(valeur);
}


/**
 * Répare l'onglet "Suivi Loyers" : remet la colonne Mois en texte brut au
 * format canonique ("juillet 2026") et FUSIONNE les lignes d'un même mois.
 *
 * Nécessaire une fois sur les Sheets existants : tant que la colonne A
 * contenait des dates (conversion automatique de Sheets), chaque quittance
 * ajoutait une ligne au lieu de compléter la ligne du mois, et la web app
 * affichait la quittance comme non envoyée.
 *
 * Idempotent : relancer la fonction sur un onglet déjà sain ne change rien.
 * @return {{lignesAvant:number, lignesApres:number, fusionnees:number}}
 */
function reparerSuiviLoyers() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Suivi Loyers');
  if (!sheet) throw new Error('Onglet "Suivi Loyers" introuvable.');

  var data = sheet.getDataRange().getValues();
  var lignesAvant = Math.max(0, data.length - 1);
  if (lignesAvant === 0) return { lignesAvant: 0, lignesApres: 0, fusionnees: 0 };

  // Regroupe par mois normalisé, en conservant l'ordre d'apparition
  var ordre = [];
  var parMois = {};
  for (var i = 1; i < data.length; i++) {
    var key = normalizeMoisKey(data[i][0]);
    if (!key) continue;
    if (!parMois[key]) { parMois[key] = [0, 0, 0]; ordre.push(key); }
    for (var ch = 0; ch < 3; ch++) {
      var v = parseEuro(data[i][ch + 1]);
      // Dernière valeur non nulle rencontrée : un renvoi de quittance écrase
      // la précédente, comme le ferait addSuiviLoyer.
      if (!isNaN(v) && v > 0) parMois[key][ch] = v;
    }
  }
  if (!ordre.length) return { lignesAvant: lignesAvant, lignesApres: 0, fusionnees: 0 };

  // Réécriture complète des lignes de données
  sheet.getRange(2, 1, lignesAvant, 5).clearContent();
  sheet.getRange(2, 1, ordre.length, 1).setNumberFormat('@');
  for (var r = 0; r < ordre.length; r++) {
    var row = r + 2;
    var montants = parMois[ordre[r]];
    sheet.getRange(row, 1).setValue(ordre[r]);
    for (var c = 0; c < 3; c++) {
      if (montants[c] > 0) sheet.getRange(row, c + 2).setValue(montants[c]);
    }
    sheet.getRange(row, 5).setFormula('=B' + row + '+C' + row + '+D' + row);
  }

  return {
    lignesAvant: lignesAvant,
    lignesApres: ordre.length,
    fusionnees: lignesAvant - ordre.length
  };
}

/**
 * Menu : répare l'onglet "Suivi Loyers" (voir reparerSuiviLoyers).
 */
function menuReparerSuiviLoyers() {
  var ui = SpreadsheetApp.getUi();
  try {
    var confirm = ui.alert(
      'Réparer le suivi des loyers',
      'Cette action réécrit l\'onglet « Suivi Loyers » :\n' +
      '• colonne Mois remise en texte ("juillet 2026")\n' +
      '• lignes en double d\'un même mois fusionnées\n\n' +
      'Les montants sont conservés. Continuer ?',
      ui.ButtonSet.YES_NO
    );
    if (confirm !== ui.Button.YES) return;

    var res = reparerSuiviLoyers();
    ui.alert('Suivi Loyers réparé ✓',
      res.lignesAvant + ' ligne(s) avant → ' + res.lignesApres + ' après\n' +
      res.fusionnees + ' doublon(s) fusionné(s).',
      ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Erreur', e.message, ui.ButtonSet.OK);
  }
}


// ---------------------------------------------------------------------------
// 8. ENVOI D'EMAILS
// ---------------------------------------------------------------------------

/**
 * Lit un template email depuis l'onglet "Templates".
 * @param {string} templateName — Nom du template (colonne A).
 * @return {Object} { objet, corps } — Objet et corps du mail.
 */
function getEmailTemplate(templateName) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Templates');
  if (!sheet) throw new Error('Onglet "Templates" introuvable.');
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0].toString().trim() === templateName) {
      return { objet: data[i][1].toString(), corps: data[i][2].toString() };
    }
  }
  throw new Error('Template "' + templateName + '" introuvable dans l\'onglet Templates.');
}

/**
 * Remplace les placeholders dans un texte avec les données du locataire + config.
 * @param {string} text — Texte avec {{variables}}.
 * @param {Object} tenant — Données locataire.
 * @param {Object} config — Données config.
 * @param {Object} chambre — Données chambre.
 * @return {string} Texte avec variables remplacées.
 */
function replaceEmailPlaceholders(text, tenant, config, chambre) {
  var replacements = buildReplacements(tenant, config, chambre);
  // Ajouter les champs email spécifiques
  replacements['{{EMAIL}}'] = formatValue(tenant['EMAIL']);
  replacements['{{TELEPHONE}}'] = formatValue(tenant['TELEPHONE']);
  replacements['{{Loyer_HC}}'] = formatEuro(chambre['Loyer HC']);

  // Champs financiers (premier loyer, caution, assurance, total)
  var premierLoyer = parseEuro(tenant['1er_Loyer']);
  var caution = parseFloat(chambre['Caution']) || 0;
  var assurance = parseEuro(tenant['Assurance']);
  replacements['{{1er_Loyer}}'] = formatEuro(premierLoyer);
  replacements['{{Caution}}'] = formatEuro(caution);
  replacements['{{Assurance}}'] = formatEuro(assurance);

  // Dernier loyer proratisé (fin de location) — '___' si non renseigné
  var dernierLoyer = parseEuro(tenant['Dernier_Loyer']);
  replacements['{{Dernier_Loyer}}'] = isNaN(dernierLoyer) ? '___' : formatEuro(dernierLoyer);

  // Assurance habitation — quote-part à rembourser en fin de location.
  // Colonne facultative : souvent vide (aucun remboursement dû).
  var assuranceProrata = getAssuranceProrata(tenant);
  var aRembourser = !isNaN(assuranceProrata) && assuranceProrata > 0;
  replacements['{{Assurance_Prorata}}'] = aRembourser ? formatEuro(assuranceProrata) : '___';
  // Paragraphe complet, VIDE si rien à rembourser → le mail de préavis ne
  // comporte aucune ligne "___" quand la colonne n'est pas renseignée.
  replacements['{{Assurance_Prorata_Bloc}}'] = aRembourser
    ? '<p><b>Assurance habitation :</b> votre quote-part ayant été réglée pour '
      + 'la période à venir, un remboursement de <b>' + formatEuro(assuranceProrata)
      + '</b> vous sera versé au prorata de votre départ, en même temps que le '
      + 'dépôt de garantie.</p>'
    : '';
  if (!isNaN(premierLoyer) && !isNaN(assurance) && caution > 0) {
    replacements['{{Total_A_Regler}}'] = formatEuro(premierLoyer + caution + assurance);
  } else {
    replacements['{{Total_A_Regler}}'] = '___';
  }

  for (var placeholder in replacements) {
    text = text.split(placeholder).join(replacements[placeholder]);
  }
  return text;
}

/**
 * Lit la quote-part d'assurance à rembourser au locataire en fin de location.
 * Tolère les deux orthographes d'en-tête ("Assurance prorata" tel que saisi
 * dans le Sheet, ou "Assurance_Prorata" à la convention underscore du projet)
 * pour éviter un remboursement silencieusement absent du mail de préavis.
 * @param {Object} tenant — Données locataire.
 * @return {number} Montant, ou NaN si la colonne est absente/vide.
 */
function getAssuranceProrata(tenant) {
  var noms = ['Assurance prorata', 'Assurance_Prorata', 'Assurance Prorata'];
  for (var i = 0; i < noms.length; i++) {
    var val = tenant[noms[i]];
    if (val !== undefined && val !== null && val !== '') return parseEuro(val);
  }
  return NaN;
}

/**
 * Extrait un nombre depuis une valeur qui peut être un nombre ou une chaîne avec "€".
 * Ex: "542,60 €" → 542.60, 542.6 → 542.6
 * @param {*} val — Valeur brute (nombre ou chaîne).
 * @return {number} Valeur numérique ou NaN.
 */
function parseEuro(val) {
  if (val === null || val === undefined || val === '') return NaN;
  if (typeof val === 'number') return val;
  var cleaned = val.toString().replace(/[€\s]/g, '').replace(',', '.');
  return parseFloat(cleaned);
}

/**
 * Récupère tous les fichiers d'un dossier Drive sous forme de blobs (pièces jointes).
 * @param {string} folderId — ID du dossier Drive.
 * @return {Blob[]} Liste de blobs pour pièces jointes.
 */
function getFolderAttachments(folderId) {
  var folder = DriveApp.getFolderById(folderId);
  var files = folder.getFiles();
  var attachments = [];
  while (files.hasNext()) {
    var file = files.next();
    attachments.push(file.getBlob());
  }
  return attachments;
}

/**
 * Crée un brouillon Gmail pour la demande de pièces justificatives.
 * Aucune pièce jointe.
 * @param {Object} tenant — Données locataire.
 * @param {Object} config — Données config.
 * @param {Object} chambre — Données chambre.
 * @return {GmailDraft} Le brouillon créé.
 */
function createDemandePiecesDraft(tenant, config, chambre) {
  var email = tenant['EMAIL'];
  if (!email) throw new Error('Pas d\'adresse email pour ce locataire.');

  var template = getEmailTemplate('DEMANDE_PIECES');
  var objet = replaceEmailPlaceholders(template.objet, tenant, config, chambre);
  var corps = replaceEmailPlaceholders(template.corps, tenant, config, chambre);

  return GmailApp.createDraft(email, objet, '', {
    htmlBody: corps,
    name: config['Bailleur_Nom']
  });
}

/**
 * Crée un brouillon Gmail pour l'envoi du dossier complet de location.
 * Pièces jointes : bail PDF + EDL PDF + tous les documents communs du dossier Drive.
 * @param {Object} tenant — Données locataire.
 * @param {Object} config — Données config.
 * @param {Object} chambre — Données chambre.
 * @return {GmailDraft} Le brouillon créé.
 */
function createDossierLocationDraft(tenant, config, chambre) {
  var email = tenant['EMAIL'];
  if (!email) throw new Error('Pas d\'adresse email pour ce locataire.');

  var pdfBailId = tenant['ID_PDF_BAIL'];
  if (!pdfBailId) throw new Error('Aucun PDF de bail trouvé. Générez d\'abord le bail.');

  var pdfEdlId = tenant['ID_PDF_EDL'];
  if (!pdfEdlId) throw new Error('Aucun PDF d\'état des lieux trouvé. Générez d\'abord l\'EDL.');

  var docsCommuns = config['ID_DOSSIER_DOCS_COMMUNS'];
  if (!docsCommuns) throw new Error('ID_DOSSIER_DOCS_COMMUNS manquant dans l\'onglet Config.');

  // PJ nominatives : bail + EDL
  var attachments = [
    DriveApp.getFileById(pdfBailId).getBlob(),
    DriveApp.getFileById(pdfEdlId).getBlob()
  ];

  // PJ communes : tous les fichiers du dossier partagé
  var commonDocs = getFolderAttachments(docsCommuns);
  attachments = attachments.concat(commonDocs);

  // Vérifications financières
  var premierLoyer = parseEuro(tenant['1er_Loyer']);
  var assurance = parseEuro(tenant['Assurance']);
  if (isNaN(premierLoyer)) throw new Error('Colonne "1er_Loyer" vide ou invalide pour ce locataire.');
  if (isNaN(assurance)) throw new Error('Colonne "Assurance" vide ou invalide pour ce locataire.');

  var template = getEmailTemplate('ENVOI_DOCUMENTS');
  var objet = replaceEmailPlaceholders(template.objet, tenant, config, chambre);
  var corps = replaceEmailPlaceholders(template.corps, tenant, config, chambre);

  return GmailApp.createDraft(email, objet, '', {
    htmlBody: corps,
    attachments: attachments,
    name: config['Bailleur_Nom']
  });
}


// ---------------------------------------------------------------------------
// 9. ACTIONS DU MENU (orchestration)
// ---------------------------------------------------------------------------

/**
 * Confirmation supplémentaire quand régénérer écraserait le Google Doc de
 * travail rattaché à une signature électronique.
 *
 * @param {Object} ui — SpreadsheetApp.getUi().
 * @param {Object} tenant
 * @param {Array<string>} typesDoc — `'BAIL'` et/ou `'EDL'`.
 * @return {boolean} true si la génération peut se poursuivre.
 */
function confirmerRegenerationSignature(ui, tenant, typesDoc) {
  if (typeof signatureBlocageRegeneration !== 'function') return true;

  var messages = [];
  for (var i = 0; i < typesDoc.length; i++) {
    var message = signatureBlocageRegeneration(tenant, typesDoc[i]);
    if (message) messages.push(message);
  }
  if (!messages.length) return true;

  return ui.alert(
    'Signature électronique en jeu',
    messages.join('\n\n') + '\n\nRégénérer quand même ?',
    ui.ButtonSet.YES_NO
  ) === ui.Button.YES;
}


/**
 * Menu : Générer le bail pour le locataire sélectionné.
 */
function menuGenererBail() {
  var ui = SpreadsheetApp.getUi();
  try {
    var tenant = getTenantData();
    var config = getConfig();
    var chambre = getChambreData(tenant['Chambre']);

    // Confirmation
    var confirm = ui.alert(
      'Générer le bail',
      'Générer le bail pour ' + tenant['Locataire_Nom'] + ' (Chambre ' + tenant['Chambre'] + ') ?',
      ui.ButtonSet.YES_NO
    );
    if (confirm !== ui.Button.YES) return;
    if (!confirmerRegenerationSignature(ui, tenant, ['BAIL'])) return;

    var result = generateLeaseDoc(tenant, config, chambre);

    // Mettre à jour le Sheet
    updateTenantCell(tenant._sheet, tenant._rowIndex, 'ID_PDF_BAIL', result.pdfFile.getId());

    ui.alert('Bail généré ✓',
      'PDF : ' + result.pdfFile.getName() + '\n\n' +
      'Le fichier est dans votre dossier Drive.',
      ui.ButtonSet.OK);

  } catch (e) {
    ui.alert('Erreur', e.message, ui.ButtonSet.OK);
  }
}

/**
 * Menu : Créer un brouillon de demande de pièces justificatives.
 */
function menuDemandePieces() {
  var ui = SpreadsheetApp.getUi();
  try {
    var tenant = getTenantData();
    var config = getConfig();
    var chambre = getChambreData(tenant['Chambre']);

    var confirm = ui.alert(
      'Demande de pièces',
      'Créer un brouillon de demande de pièces justificatives pour ' +
      tenant['Locataire_Nom'] + ' (' + tenant['EMAIL'] + ') ?',
      ui.ButtonSet.YES_NO
    );
    if (confirm !== ui.Button.YES) return;

    createDemandePiecesDraft(tenant, config, chambre);

    ui.alert('Brouillon créé ✓',
      'Un brouillon a été créé dans Gmail pour ' + tenant['EMAIL'] + '.\n\n' +
      'Ouvrez Gmail > Brouillons pour relire et envoyer.',
      ui.ButtonSet.OK);

  } catch (e) {
    ui.alert('Erreur', e.message, ui.ButtonSet.OK);
  }
}

/**
 * Menu : Créer un brouillon d'envoi du dossier complet de location.
 * Inclut bail PDF + EDL PDF + documents communs en PJ.
 */
function menuEnvoyerDossierLocation() {
  var ui = SpreadsheetApp.getUi();
  try {
    var tenant = getTenantData();
    var config = getConfig();
    var chambre = getChambreData(tenant['Chambre']);

    // Vérifier que bail et EDL sont générés
    if (!tenant['ID_PDF_BAIL']) throw new Error('Générez d\'abord le bail (📄 Générer le bail).');
    if (!tenant['ID_PDF_EDL']) throw new Error('Générez d\'abord l\'état des lieux (📄 Générer l\'état des lieux).');

    var premierLoyer = parseEuro(tenant['1er_Loyer']);
    var cautionVal = parseFloat(chambre['Caution']) || 0;
    var assuranceVal = parseEuro(tenant['Assurance']);
    var totalStr = (!isNaN(premierLoyer) && !isNaN(assuranceVal) && cautionVal > 0)
                   ? formatEuro(premierLoyer + cautionVal + assuranceVal)
                   : 'N/A';

    var confirm = ui.alert(
      'Dossier de location',
      'Créer un brouillon pour ' + tenant['Locataire_Nom'] + ' (' + tenant['EMAIL'] + ') :\n\n' +
      'Pièces jointes :\n' +
      '  • Bail de location (PDF)\n' +
      '  • État des lieux (PDF)\n' +
      '  • Documents communs (diagnostics, copro, etc.)\n\n' +
      'Montants rappelés dans le mail :\n' +
      '  • Premier loyer : ' + formatEuro(premierLoyer) + '\n' +
      '  • Dépôt de garantie : ' + formatEuro(cautionVal) + '\n' +
      '  • Assurance : ' + formatEuro(assuranceVal) + '\n' +
      '  • Total : ' + totalStr + '\n\n' +
      'Créer le brouillon ?',
      ui.ButtonSet.YES_NO
    );
    if (confirm !== ui.Button.YES) return;

    createDossierLocationDraft(tenant, config, chambre);

    // NOTE : la colonne A ("Actif", ex-"STATUT") n'est plus écrite par les macros.
    // Elle est gérée manuellement / via le toggle de la web app (case à cocher).

    ui.alert('Brouillon créé ✓',
      'Brouillon créé dans Gmail pour ' + tenant['EMAIL'] + '.\n\n' +
      'Ouvrez Gmail > Brouillons pour relire, ajouter l\'attestation d\'assurance si besoin, puis envoyer.',
      ui.ButtonSet.OK);

  } catch (e) {
    ui.alert('Erreur', e.message, ui.ButtonSet.OK);
  }
}

/**
 * Menu : Générer l'état des lieux pour le locataire sélectionné.
 */
function menuGenererEDL() {
  var ui = SpreadsheetApp.getUi();
  try {
    var tenant = getTenantData();
    var config = getConfig();

    var confirm = ui.alert(
      'Générer l\'état des lieux',
      'Générer l\'EDL pour ' + tenant['Locataire_Nom'] + ' (Chambre ' + tenant['Chambre'] + ') ?',
      ui.ButtonSet.YES_NO
    );
    if (confirm !== ui.Button.YES) return;
    if (!confirmerRegenerationSignature(ui, tenant, ['EDL'])) return;

    var result = generateEDL(tenant, config);

    // Sauvegarder l'ID du PDF EDL dans l'onglet Locataires
    updateTenantCell(tenant._sheet, tenant._rowIndex, 'ID_PDF_EDL', result.pdfFile.getId());
    // Sauvegarder aussi l'ID du Google Doc EDL (colonne optionnelle ID_DOC_EDL)
    updateTenantCellIfExists(tenant._sheet, tenant._rowIndex, 'ID_DOC_EDL', result.docId);

    ui.alert('État des lieux généré ✓',
      'Document : ' + result.docId + '\n' +
      'PDF : ' + result.pdfFile.getName() + '\n' +
      'Les fichiers sont dans votre dossier Drive.',
      ui.ButtonSet.OK);

  } catch (e) {
    ui.alert('Erreur', e.message, ui.ButtonSet.OK);
  }
}

/**
 * Menu : Générer une quittance de loyer pour le locataire sélectionné.
 * Par défaut : mois en cours (le locataire paye pour le mois à venir).
 * Propose ensuite d'envoyer par email.
 */
function menuGenererQuittance() {
  var ui = SpreadsheetApp.getUi();
  try {
    var tenant = getTenantData();
    var config = getConfig();
    var chambre = getChambreData(tenant['Chambre']);

    // Vérifier que le colocataire n'est pas marqué inactif (case "Actif" décochée)
    if (isTenantParti(tenant)) {
      throw new Error('Ce colocataire est marqué inactif (case "Actif" décochée). Impossible de générer une quittance.');
    }

    // Mois par défaut : mois en cours
    var now = new Date();
    var defaultMois = now.getMonth() + 1; // 1-indexed
    var defaultAnnee = now.getFullYear();

    var defaultStr = ('0' + defaultMois).slice(-2) + '/' + defaultAnnee;

    var response = ui.prompt(
      'Générer une quittance',
      'Mois/Année (format MM/AAAA) :\n\nLaissez vide pour le mois en cours (' + defaultStr + ')',
      ui.ButtonSet.OK_CANCEL
    );
    if (response.getSelectedButton() !== ui.Button.OK) return;

    var input = response.getResponseText().trim();
    var mois, annee;

    if (input === '') {
      mois = defaultMois;
      annee = defaultAnnee;
    } else {
      var parts = input.split('/');
      if (parts.length !== 2) throw new Error('Format invalide. Utilisez MM/AAAA (ex: 03/2026).');
      mois = parseInt(parts[0], 10);
      annee = parseInt(parts[1], 10);
      if (isNaN(mois) || isNaN(annee) || mois < 1 || mois > 12) {
        throw new Error('Mois invalide. Utilisez un nombre entre 01 et 12.');
      }
    }

    var moisNom = MOIS_FR[mois - 1] + ' ' + annee;

    // Détection automatique premier / dernier loyer proratisé
    var loyerCC = parseFloat(chambre['Loyer CC']) || 0;
    var detection = detectMontantOverride(tenant, chambre, mois, annee);

    if (detection.type === 'premier') {
      ui.alert('Premier loyer détecté',
        'Le mois sélectionné correspond au mois d\'entrée du locataire.\n\n' +
        'Montant appliqué : ' + formatEuro(detection.montant) + ' (au lieu de ' + formatEuro(loyerCC) + ')',
        ui.ButtonSet.OK);
    } else if (detection.type === 'dernier') {
      ui.alert('Dernier loyer détecté',
        'Le mois sélectionné correspond au mois de sortie du locataire (' +
        formatValue(tenant['Date_Fin']) + ').\n\n' +
        'Montant appliqué : ' + formatEuro(detection.montant) + ' (au lieu de ' + formatEuro(loyerCC) + ')\n' +
        'Période : du 1er du mois au ' + formatValue(tenant['Date_Fin']),
        ui.ButtonSet.OK);
    }

    var montantTotal = detection.montant;
    var typeLabel = detection.type === 'premier' ? ' (premier loyer : ' :
                    detection.type === 'dernier' ? ' (dernier loyer : ' : '';

    var confirmMsg = ui.alert(
      'Confirmation',
      'Générer la quittance de ' + moisNom + ' pour ' + tenant['Locataire_Nom'] +
      (montantTotal !== null ? typeLabel + formatEuro(montantTotal) + ')' : '') + ' ?',
      ui.ButtonSet.YES_NO
    );
    if (confirmMsg !== ui.Button.YES) return;

    var result = generateQuittance(tenant, config, chambre, mois, annee, montantTotal);

    // Enregistrer dans le suivi des loyers (avec le bon montant)
    var montantSuivi = (montantTotal !== null) ? montantTotal : loyerCC;
    addSuiviLoyer(tenant, chambre, moisNom, montantSuivi);

    // Créer automatiquement le brouillon Gmail
    var draftMsg = '';
    if (tenant['EMAIL']) {
      createQuittanceDraft(tenant, config, chambre, moisNom, result.pdfFile, montantTotal);
      draftMsg = '\nBrouillon Gmail créé pour ' + tenant['EMAIL'] + '.\nOuvrez Gmail > Brouillons pour relire et envoyer.';
    } else {
      draftMsg = '\nAucune adresse email renseignée — brouillon non créé.';
    }

    ui.alert('Quittance générée ✓',
      'PDF : ' + result.pdfFile.getName() + '\n' +
      'Loyer enregistré dans Suivi Loyers.' +
      draftMsg,
      ui.ButtonSet.OK);

  } catch (e) {
    ui.alert('Erreur', e.message, ui.ButtonSet.OK);
  }
}


/**
 * Crée un brouillon Gmail avec la quittance en pièce jointe.
 * (Remplace l'ancien sendQuittanceEmail — plus d'envoi direct.)
 * @param {Object} tenant — Données locataire.
 * @param {Object} config — Données config.
 * @param {Object} chambre — Données chambre.
 * @param {string} moisNom — Nom du mois + année (ex: "mars 2026").
 * @param {File} pdfFile — Fichier PDF de la quittance.
 * @param {number|null} montantOverride — Montant proratisé (premier loyer) ou null.
 * @return {GmailDraft} Le brouillon créé.
 */
function createQuittanceDraft(tenant, config, chambre, moisNom, pdfFile, montantOverride) {
  var m = buildQuittanceEmail(tenant, config, chambre, moisNom, pdfFile, montantOverride);
  return GmailApp.createDraft(m.email, m.objet, '', {
    htmlBody: m.corps,
    attachments: [m.attachment],
    name: config['Bailleur_Nom']
  });
}

/**
 * Envoie DIRECTEMENT par email la quittance (sans passer par un brouillon).
 * Utilisé par le bouton "1 clic" de la web app pour les colocataires actifs.
 * Mêmes règles de proratisation que createQuittanceDraft.
 * @return {string} L'email destinataire (pour message de confirmation).
 */
function sendQuittanceEmail(tenant, config, chambre, moisNom, pdfFile, montantOverride) {
  var m = buildQuittanceEmail(tenant, config, chambre, moisNom, pdfFile, montantOverride);
  GmailApp.sendEmail(m.email, m.objet, '', {
    htmlBody: m.corps,
    attachments: [m.attachment],
    name: config['Bailleur_Nom']
  });
  return m.email;
}

/**
 * Construit le contenu d'un email de quittance (objet, corps HTML, pièce jointe).
 * Factorisé pour être partagé entre createQuittanceDraft (brouillon) et
 * sendQuittanceEmail (envoi direct).
 * @return {{email:string, objet:string, corps:string, attachment:Blob}}
 */
function buildQuittanceEmail(tenant, config, chambre, moisNom, pdfFile, montantOverride) {
  var email = tenant['EMAIL'];
  if (!email) throw new Error('Pas d\'adresse email pour ce locataire.');

  // Si premier loyer proratisé : recalculer HC/Charges/CC pour que le récapitulatif
  // de l'email affiche les mêmes montants que la quittance PDF.
  var chambreForEmail = chambre;
  if (montantOverride && montantOverride > 0) {
    var loyerCCBase = parseFloat(chambre['Loyer CC']) || 0;
    var loyerHCBase = parseFloat(chambre['Loyer HC']) || 0;
    if (loyerCCBase > 0) {
      var ratio = montantOverride / loyerCCBase;
      var loyerHCAdj = Math.round(loyerHCBase * ratio * 100) / 100;
      var chargesAdj = Math.round((montantOverride - loyerHCAdj) * 100) / 100;
      chambreForEmail = {};
      for (var k in chambre) chambreForEmail[k] = chambre[k];
      chambreForEmail['Loyer HC'] = loyerHCAdj;
      chambreForEmail['Charges'] = chargesAdj;
      chambreForEmail['Loyer CC'] = montantOverride;
    }
  }

  var template = getEmailTemplate('ENVOI_QUITTANCE');
  var objet = replaceEmailPlaceholders(template.objet, tenant, config, chambreForEmail);
  var corps = replaceEmailPlaceholders(template.corps, tenant, config, chambreForEmail);

  // Remplacer la variable spécifique quittance (non présente dans buildReplacements)
  objet = objet.split('{{Mois_en_cours}}').join(moisNom);
  corps = corps.split('{{Mois_en_cours}}').join(moisNom);

  return {
    email: email,
    objet: objet,
    corps: corps,
    attachment: pdfFile.getAs(MimeType.PDF)
  };
}


/**
 * Menu : Générer les quittances + brouillons email pour plusieurs locataires en une fois.
 * Utilise la sélection multiple de lignes dans l'onglet "Locataires".
 * Un brouillon Gmail est créé par locataire ; le suivi des loyers est mis à jour pour chacun.
 * Les erreurs individuelles n'interrompent pas le traitement des autres lignes.
 */
function menuGenererQuittancesGroupees() {
  var ui = SpreadsheetApp.getUi();
  try {
    var tenants = getSelectedTenantsData();
    var config = getConfig();

    // Mois par défaut : mois en cours
    var now = new Date();
    var defaultMois = now.getMonth() + 1;
    var defaultAnnee = now.getFullYear();
    var defaultStr = ('0' + defaultMois).slice(-2) + '/' + defaultAnnee;

    var response = ui.prompt(
      'Quittances groupées — Mois / Année',
      'Mois/Année (format MM/AAAA) pour ' + tenants.length + ' locataire(s) sélectionné(s) :\n\n' +
      'Laissez vide pour le mois en cours (' + defaultStr + ')',
      ui.ButtonSet.OK_CANCEL
    );
    if (response.getSelectedButton() !== ui.Button.OK) return;

    var input = response.getResponseText().trim();
    var mois, annee;

    if (input === '') {
      mois = defaultMois;
      annee = defaultAnnee;
    } else {
      var parts = input.split('/');
      if (parts.length !== 2) throw new Error('Format invalide. Utilisez MM/AAAA (ex: 03/2026).');
      mois = parseInt(parts[0], 10);
      annee = parseInt(parts[1], 10);
      if (isNaN(mois) || isNaN(annee) || mois < 1 || mois > 12) {
        throw new Error('Mois invalide. Utilisez un nombre entre 01 et 12.');
      }
    }

    var moisNom = MOIS_FR[mois - 1] + ' ' + annee;

    // Confirmation avec la liste des locataires concernés
    var tenantLines = tenants.map(function(t) {
      return '  • ' + t['Locataire_Nom'] + ' (Chambre ' + t['Chambre'] + ')';
    }).join('\n');

    var confirm = ui.alert(
      'Confirmer les quittances groupées',
      'Générer les quittances de ' + moisNom + ' pour :\n\n' +
      tenantLines + '\n\n' +
      'Un brouillon Gmail sera créé pour chaque locataire.',
      ui.ButtonSet.YES_NO
    );
    if (confirm !== ui.Button.YES) return;

    // Traitement locataire par locataire — les erreurs sont collectées, pas bloquantes
    var successes = [];
    var errors = [];

    for (var idx = 0; idx < tenants.length; idx++) {
      var tenant = tenants[idx];
      try {
        // Garde-fou : colocataire inactif (case "Actif" décochée)
        if (isTenantParti(tenant)) {
          errors.push(tenant['Locataire_Nom'] + ' : colocataire inactif, ignoré.');
          continue;
        }

        var chambre = getChambreData(tenant['Chambre']);
        var loyerCC = parseFloat(chambre['Loyer CC']) || 0;

        // Détection premier / dernier loyer proratisé
        var detection = detectMontantOverride(tenant, chambre, mois, annee);
        var montantTotal = detection.montant;

        // Génération du PDF
        var result = generateQuittance(tenant, config, chambre, mois, annee, montantTotal);

        // Suivi des loyers
        var montantSuivi = (montantTotal !== null) ? montantTotal : loyerCC;
        addSuiviLoyer(tenant, chambre, moisNom, montantSuivi);

        // Brouillon Gmail
        if (tenant['EMAIL']) {
          createQuittanceDraft(tenant, config, chambre, moisNom, result.pdfFile, montantTotal);
          successes.push(tenant['Locataire_Nom'] + ' → brouillon créé pour ' + tenant['EMAIL'] +
                         (montantTotal ? ' (' + formatEuro(montantTotal) + ' proratisé — ' + detection.type + ' loyer)' : ''));
        } else {
          successes.push(tenant['Locataire_Nom'] + ' → PDF généré, pas d\'email renseigné.');
        }

      } catch (err) {
        errors.push(tenant['Locataire_Nom'] + ' : ' + err.message);
      }
    }

    // Rapport final
    var rapport = '';
    if (successes.length > 0) {
      rapport += '✓ Réussis (' + successes.length + ') :\n' +
                 successes.map(function(s) { return '  • ' + s; }).join('\n');
    }
    if (errors.length > 0) {
      if (rapport) rapport += '\n\n';
      rapport += '✗ Erreurs (' + errors.length + ') :\n' +
                 errors.map(function(e) { return '  • ' + e; }).join('\n');
    }

    ui.alert('Quittances groupées — ' + moisNom, rapport, ui.ButtonSet.OK);

  } catch (e) {
    ui.alert('Erreur', e.message, ui.ButtonSet.OK);
  }
}


// ---------------------------------------------------------------------------
// 10. ATTESTATION DE PAIEMENT D'ASSURANCE HABITATION
// ---------------------------------------------------------------------------

/**
 * Génère l'attestation de paiement de la quote-part d'assurance habitation.
 * Copie le template, remplace les variables, insère la signature, génère le PDF.
 * @param {Object} tenant — Données locataire.
 * @param {Object} config — Données config.
 * @param {Object} chambre — Données chambre.
 * @return {Object} { pdfFile }
 */
function generateAttestationAssurance(tenant, config, chambre) {
  var templateId = config['ID_ATTESTATION_ASSURANCE'];
  if (!templateId) throw new Error('ID_ATTESTATION_ASSURANCE manquant dans l\'onglet Config.');

  var anneeCourante = new Date().getFullYear();
  var docName = 'Attestation_Assurance_' + tenant['Locataire_Nom'].toString().replace(/\s+/g, '_')
                + '_' + anneeCourante;

  var folder = getOrCreateTenantFolder(config, tenant['Locataire_Nom']);
  var templateFile = DriveApp.getFileById(templateId);
  var copiedFile = templateFile.makeCopy(docName, folder);
  var docId = copiedFile.getId();

  var doc = DocumentApp.openById(docId);
  var body = doc.getBody();

  // Construit le dictionnaire de remplacement (réutilise buildReplacements + ajouts spécifiques)
  var replacements = buildReplacements(tenant, config, chambre);

  var assuranceVal = parseEuro(tenant['Assurance']);
  var dateNow = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy');
  replacements['{{Assurance}}'] = formatEuro(isNaN(assuranceVal) ? 0 : assuranceVal);
  replacements['{{Date_Generation}}'] = dateNow;

  for (var placeholder in replacements) {
    body.replaceText(escapeRegex(placeholder), replacements[placeholder]);
  }

  // Insérer l'image de signature à la place du marqueur "(Signature)"
  insertSignatureImage(body, config);

  doc.saveAndClose();

  var pdfFile = createLeasePdf(docId, docName, folder);
  // Supprimer la copie Google Docs (on garde uniquement le PDF)
  DriveApp.getFileById(docId).setTrashed(true);

  return { pdfFile: pdfFile };
}

/**
 * Crée un brouillon Gmail pour l'envoi de l'attestation de paiement d'assurance.
 * @param {Object} tenant — Données locataire.
 * @param {Object} config — Données config.
 * @param {Object} chambre — Données chambre.
 * @param {File} pdfFile — Fichier PDF de l'attestation.
 * @return {GmailDraft} Le brouillon créé.
 */
function createAttestationAssuranceDraft(tenant, config, chambre, pdfFile) {
  var email = tenant['EMAIL'];
  if (!email) throw new Error('Pas d\'adresse email pour ce locataire.');

  var template = getEmailTemplate('ENVOI_ATTESTATION_DE_PAIEMENT_ASSURANCE');
  var objet = replaceEmailPlaceholders(template.objet, tenant, config, chambre);
  var corps = replaceEmailPlaceholders(template.corps, tenant, config, chambre);

  // Variables spécifiques à l'attestation (non couvertes par buildReplacements)
  var anneeCourante = new Date().getFullYear();
  var dateDebutFmt = formatValue(tenant['Date_Début']);
  var dateFinFmt = formatValue(tenant['Date_Fin']);
  var periode = dateDebutFmt + ' au ' + dateFinFmt;
  // Date de paiement = date d'entrée du locataire (l'assurance est réglée à l'entrée)
  var datePaiement = dateDebutFmt;

  objet = objet.split('{{Année_en_cours}}').join(anneeCourante);
  corps = corps.split('{{Année_en_cours}}').join(anneeCourante);
  corps = corps.split('{{Assurance_Periode}}').join(periode);
  corps = corps.split('{{Assurance_Date_Paiement}}').join(datePaiement);

  return GmailApp.createDraft(email, objet, '', {
    htmlBody: corps,
    attachments: [pdfFile.getAs(MimeType.PDF)],
    name: config['Bailleur_Nom']
  });
}


// ---------------------------------------------------------------------------
// 11. ACTIONS MENU SUPPLÉMENTAIRES (bail+EDL combinés, attestation assurance)
// ---------------------------------------------------------------------------

/**
 * Menu : Générer le bail ET l'état des lieux en une seule action.
 */
function menuGenererBailEtEDL() {
  var ui = SpreadsheetApp.getUi();
  try {
    var tenant = getTenantData();
    var config = getConfig();
    var chambre = getChambreData(tenant['Chambre']);

    var confirm = ui.alert(
      'Générer bail + EDL',
      'Générer le BAIL et l\'ÉTAT DES LIEUX pour ' + tenant['Locataire_Nom'] +
      ' (Chambre ' + tenant['Chambre'] + ') ?',
      ui.ButtonSet.YES_NO
    );
    if (confirm !== ui.Button.YES) return;
    if (!confirmerRegenerationSignature(ui, tenant, ['BAIL', 'EDL'])) return;

    // 1) Génération du bail
    var bailResult = generateLeaseDoc(tenant, config, chambre);
    updateTenantCell(tenant._sheet, tenant._rowIndex, 'ID_PDF_BAIL', bailResult.pdfFile.getId());

    // 2) Génération de l'EDL
    var edlResult = generateEDL(tenant, config);
    updateTenantCell(tenant._sheet, tenant._rowIndex, 'ID_PDF_EDL', edlResult.pdfFile.getId());
    updateTenantCellIfExists(tenant._sheet, tenant._rowIndex, 'ID_DOC_EDL', edlResult.docId);

    ui.alert('Bail + EDL générés ✓',
      'Bail PDF : ' + bailResult.pdfFile.getName() + '\n' +
      'EDL PDF  : ' + edlResult.pdfFile.getName() + '\n\n' +
      'Les fichiers sont dans le dossier Drive du locataire.',
      ui.ButtonSet.OK);

  } catch (e) {
    ui.alert('Erreur', e.message, ui.ButtonSet.OK);
  }
}

// ---------------------------------------------------------------------------
// 12. FIN DE LOCATION — EDL à l'ami, réponse au préavis, archivage Drive
// ---------------------------------------------------------------------------

/**
 * Retrouve l'ID du Google Doc de l'EDL du locataire.
 * 1) Colonne ID_DOC_EDL si renseignée (rempli automatiquement depuis cette version).
 * 2) Fallback : recherche du Google Doc "EDL_<Nom>..." le plus récent dans le
 *    dossier Drive du locataire (pour les EDL générés avant l'ajout de la colonne).
 * @param {Object} tenant — Données locataire.
 * @param {Object} config — Données config.
 * @return {string} ID du Google Doc EDL.
 */
function findEDLDocId(tenant, config) {
  var stored = (tenant['ID_DOC_EDL'] || '').toString().trim();
  if (stored) return stored;

  var folder = getOrCreateTenantFolder(config, tenant['Locataire_Nom']);
  var prefix = 'EDL_' + tenant['Locataire_Nom'].toString().replace(/\s+/g, '_');
  var files = folder.getFilesByType(MimeType.GOOGLE_DOCS);
  var best = null;
  while (files.hasNext()) {
    var f = files.next();
    if (f.getName().indexOf(prefix) === 0) {
      if (!best || f.getLastUpdated() > best.getLastUpdated()) best = f;
    }
  }
  if (!best) {
    throw new Error('Google Doc EDL introuvable pour ' + tenant['Locataire_Nom'] +
                    '. Générez l\'EDL (📄 Générer l\'état des lieux) ou renseignez la colonne ID_DOC_EDL.');
  }
  return best.getId();
}

/**
 * Exporte un Google Doc au format Word (.docx).
 * @param {string} docId — ID du Google Doc.
 * @param {string} name — Nom du fichier (sans extension).
 * @return {Blob} Blob .docx.
 */
function exportDocAsDocx(docId, name) {
  var url = 'https://docs.google.com/document/d/' + docId + '/export?format=docx';
  var response = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }
  });
  return response.getBlob().setName(name + '.docx');
}

/**
 * Crée un brouillon Gmail pour l'AMI qui réalise les états des lieux.
 * Destinataire : EMAIL_AMI_EDL (onglet Config).
 * Pièces jointes : EDL en Word (.docx, modifiable) + EDL en PDF.
 * @param {Object} tenant — Données locataire.
 * @param {Object} config — Données config.
 * @param {Object} chambre — Données chambre.
 * @return {GmailDraft} Le brouillon créé.
 */
function createEDLAmiDraft(tenant, config, chambre) {
  var emailAmi = (config['EMAIL_AMI_EDL'] || '').toString().trim();
  if (!emailAmi) throw new Error('EMAIL_AMI_EDL manquant dans l\'onglet Config.');

  var pdfEdlId = (tenant['ID_PDF_EDL'] || '').toString().trim();
  if (!pdfEdlId) throw new Error('Aucun PDF d\'état des lieux. Générez d\'abord l\'EDL.');

  var docId = findEDLDocId(tenant, config);
  var docName = DriveApp.getFileById(docId).getName();

  var attachments = [
    exportDocAsDocx(docId, docName),
    DriveApp.getFileById(pdfEdlId).getBlob()
  ];

  var template = getEmailTemplate('ENVOI_EDL_AMI');
  var objet = replaceEmailPlaceholders(template.objet, tenant, config, chambre);
  var corps = replaceEmailPlaceholders(template.corps, tenant, config, chambre);

  return GmailApp.createDraft(emailAmi, objet, '', {
    htmlBody: corps,
    attachments: attachments,
    name: config['Bailleur_Nom']
  });
}

/**
 * Menu : Créer un brouillon Gmail avec l'EDL (Word + PDF) pour l'ami
 * qui réalise les états des lieux.
 */
function menuEnvoyerEDLAmi() {
  var ui = SpreadsheetApp.getUi();
  try {
    var tenant = getTenantData();
    var config = getConfig();
    var chambre = getChambreData(tenant['Chambre']);

    var emailAmi = (config['EMAIL_AMI_EDL'] || '').toString().trim();
    if (!emailAmi) throw new Error('EMAIL_AMI_EDL manquant dans l\'onglet Config (email de l\'ami).');

    var confirm = ui.alert(
      'Envoyer l\'EDL à l\'ami',
      'Créer un brouillon Gmail pour ' + emailAmi + ' :\n\n' +
      'Locataire : ' + tenant['Locataire_Nom'] + ' (Chambre ' + tenant['Chambre'] + ')\n' +
      'Pièces jointes : EDL en Word (modifiable) + EDL en PDF\n\n' +
      'Créer le brouillon ?',
      ui.ButtonSet.YES_NO
    );
    if (confirm !== ui.Button.YES) return;

    createEDLAmiDraft(tenant, config, chambre);

    ui.alert('Brouillon créé ✓',
      'Brouillon créé dans Gmail pour ' + emailAmi + '.\n\n' +
      'Ouvrez Gmail > Brouillons pour compléter (date de RDV, etc.) et envoyer.',
      ui.ButtonSet.OK);

  } catch (e) {
    ui.alert('Erreur', e.message, ui.ButtonSet.OK);
  }
}

/**
 * Menu : Créer un brouillon Gmail de réponse au préavis du locataire,
 * avec les consignes de ménage (chambre + parties communes) et le rappel
 * des étapes de sortie (EDL, compteurs, clés, dernier loyer, caution).
 * Pré-requis : Date_Fin renseignée (date de sortie convenue).
 */
function menuRepondrePreavis() {
  var ui = SpreadsheetApp.getUi();
  try {
    var tenant = getTenantData();
    var config = getConfig();
    var chambre = getChambreData(tenant['Chambre']);

    if (!tenant['EMAIL']) throw new Error('Pas d\'adresse email pour ce locataire.');
    if (!(tenant['Date_Fin'] instanceof Date)) {
      throw new Error('Renseignez d\'abord la colonne Date_Fin (date de sortie) pour ce locataire.');
    }

    var dernierLoyer = parseEuro(tenant['Dernier_Loyer']);
    var dernierLoyerStr = isNaN(dernierLoyer)
      ? '⚠️ non calculé (colonne Dernier_Loyer vide)'
      : formatEuro(dernierLoyer);

    var assuranceProrata = getAssuranceProrata(tenant);
    var assuranceStr = (!isNaN(assuranceProrata) && assuranceProrata > 0)
      ? formatEuro(assuranceProrata)
      : 'aucun (colonne "Assurance prorata" vide) — non mentionné dans le mail';

    var confirm = ui.alert(
      'Répondre au préavis',
      'Créer un brouillon de réponse au préavis pour ' + tenant['Locataire_Nom'] +
      ' (' + tenant['EMAIL'] + ') :\n\n' +
      'Date de sortie : ' + formatValue(tenant['Date_Fin']) + '\n' +
      'Dernier loyer proratisé : ' + dernierLoyerStr + '\n' +
      'Remboursement assurance : ' + assuranceStr + '\n\n' +
      'Le mail contient les consignes de ménage et le déroulé de la sortie.\n' +
      'Créer le brouillon ?',
      ui.ButtonSet.YES_NO
    );
    if (confirm !== ui.Button.YES) return;

    var template = getEmailTemplate('REPONSE_PREAVIS');
    var objet = replaceEmailPlaceholders(template.objet, tenant, config, chambre);
    var corps = replaceEmailPlaceholders(template.corps, tenant, config, chambre);

    GmailApp.createDraft(tenant['EMAIL'], objet, '', {
      htmlBody: corps,
      name: config['Bailleur_Nom']
    });

    ui.alert('Brouillon créé ✓',
      'Brouillon de réponse au préavis créé dans Gmail pour ' + tenant['EMAIL'] + '.\n\n' +
      'Ouvrez Gmail > Brouillons pour relire et envoyer.',
      ui.ButtonSet.OK);

  } catch (e) {
    ui.alert('Erreur', e.message, ui.ButtonSet.OK);
  }
}


// ---------------------------------------------------------------------------
// 13. ARCHIVAGE DRIVE DES COLOCATAIRES INACTIFS (LOCATAIRES/OLD)
// ---------------------------------------------------------------------------

/**
 * Déplace vers LOCATAIRES/OLD les dossiers Drive des colocataires dont la
 * case "Actif" (colonne A) est décochée. Le sous-dossier OLD est créé au
 * premier passage. Idempotent : un dossier déjà archivé n'est pas retrouvé
 * à la racine de LOCATAIRES, donc ignoré.
 * @return {string} Rapport texte (déplacés / ignorés / erreurs).
 */
function archiverDossiersInactifs() {
  var config = getConfig();
  var parentId = config['ID_DOSSIER_LOCATAIRES'];
  if (!parentId) throw new Error('ID_DOSSIER_LOCATAIRES manquant dans l\'onglet Config.');
  var parentFolder = DriveApp.getFolderById(parentId);
  var oldFolder = getOrCreateSubFolder(parentFolder, 'OLD');

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Locataires');
  if (!sheet) throw new Error('Onglet "Locataires" introuvable.');
  var data = sheet.getDataRange().getValues();
  var headers = data[0];

  var deplaces = [];
  var erreurs = [];

  for (var i = 1; i < data.length; i++) {
    var tenant = {};
    for (var j = 0; j < headers.length; j++) {
      tenant[headers[j].toString().trim()] = data[i][j];
    }
    var nom = (tenant['Locataire_Nom'] || '').toString().trim();
    if (!nom) continue;
    if (!isTenantParti(tenant)) continue; // actif → on ne touche pas

    try {
      // Chercher le dossier UNIQUEMENT à la racine de LOCATAIRES
      // (s'il est déjà dans OLD, il n'est pas retrouvé ici → ignoré)
      var folders = parentFolder.getFoldersByName(nom);
      if (folders.hasNext()) {
        var folder = folders.next();
        folder.moveTo(oldFolder);
        deplaces.push(nom);
      }
    } catch (err) {
      erreurs.push(nom + ' : ' + err.message);
    }
  }

  var rapport = 'Archivage LOCATAIRES/OLD — ' +
                Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm') + '\n';
  rapport += deplaces.length > 0
    ? '✓ Déplacés (' + deplaces.length + ') : ' + deplaces.join(', ')
    : '✓ Aucun dossier à déplacer.';
  if (erreurs.length > 0) {
    rapport += '\n✗ Erreurs (' + erreurs.length + ') :\n' +
               erreurs.map(function(e) { return '  • ' + e; }).join('\n');
  }
  Logger.log(rapport);
  return rapport;
}

/**
 * Menu : Archiver manuellement les dossiers des colocataires inactifs.
 */
function menuArchiverDossiersInactifs() {
  var ui = SpreadsheetApp.getUi();
  try {
    var confirm = ui.alert(
      'Archiver les dossiers inactifs',
      'Déplacer vers LOCATAIRES/OLD les dossiers Drive de tous les colocataires ' +
      'dont la case "Actif" est décochée ?',
      ui.ButtonSet.YES_NO
    );
    if (confirm !== ui.Button.YES) return;

    var rapport = archiverDossiersInactifs();
    ui.alert('Archivage terminé', rapport, ui.ButtonSet.OK);

  } catch (e) {
    ui.alert('Erreur', e.message, ui.ButtonSet.OK);
  }
}

/**
 * Handler du déclencheur mensuel (pas d'UI — exécution silencieuse).
 */
function triggerArchivageMensuel() {
  archiverDossiersInactifs();
}

/**
 * À EXÉCUTER UNE FOIS (éditeur Apps Script > Exécuter) pour installer le
 * déclencheur mensuel : archivage automatique le 1er de chaque mois vers 6h.
 * Supprime les éventuels doublons avant de recréer le trigger.
 */
function installerTriggerArchivage() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'triggerArchivageMensuel') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('triggerArchivageMensuel')
    .timeBased()
    .onMonthDay(1)
    .atHour(6)
    .create();
  Logger.log('Trigger mensuel installé : archivage le 1er de chaque mois vers 6h.');
}


/**
 * Menu : Générer l'attestation de paiement d'assurance habitation
 * et créer le brouillon Gmail pour envoi au locataire.
 */
function menuEnvoyerAttestationAssurance() {
  var ui = SpreadsheetApp.getUi();
  try {
    var tenant = getTenantData();
    var config = getConfig();
    var chambre = getChambreData(tenant['Chambre']);

    if (!tenant['EMAIL']) throw new Error('Pas d\'adresse email pour ce locataire.');
    if (!config['ID_ATTESTATION_ASSURANCE']) {
      throw new Error('ID_ATTESTATION_ASSURANCE manquant dans l\'onglet Config.');
    }

    var assuranceVal = parseEuro(tenant['Assurance']);
    if (isNaN(assuranceVal) || assuranceVal <= 0) {
      throw new Error('Colonne "Assurance" vide ou invalide pour ce locataire.');
    }

    var confirm = ui.alert(
      'Attestation de paiement d\'assurance',
      'Générer l\'attestation et créer un brouillon Gmail pour ' +
      tenant['Locataire_Nom'] + ' (' + tenant['EMAIL'] + ') ?\n\n' +
      'Montant attesté : ' + formatEuro(assuranceVal) + '\n' +
      'Période : ' + formatValue(tenant['Date_Début']) + ' au ' + formatValue(tenant['Date_Fin']),
      ui.ButtonSet.YES_NO
    );
    if (confirm !== ui.Button.YES) return;

    // 1) Générer le PDF
    var result = generateAttestationAssurance(tenant, config, chambre);

    // 2) Créer le brouillon Gmail
    createAttestationAssuranceDraft(tenant, config, chambre, result.pdfFile);

    ui.alert('Attestation générée ✓',
      'PDF : ' + result.pdfFile.getName() + '\n\n' +
      'Brouillon créé dans Gmail pour ' + tenant['EMAIL'] + '.\n' +
      'Ouvrez Gmail > Brouillons pour relire et envoyer.',
      ui.ButtonSet.OK);

  } catch (e) {
    ui.alert('Erreur', e.message, ui.ButtonSet.OK);
  }
}

