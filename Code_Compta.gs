// =============================================================================
// CODE_COMPTA.GS — Module Comptabilité LMNP
// Suivi des charges, import CSV banque, bilan par catégorie/mois
// Dépend de : Code.gs (getConfig, getOrCreateSubFolder, formatEuro, MOIS_FR)
// =============================================================================


// ---------------------------------------------------------------------------
// 0. CONSTANTES
// ---------------------------------------------------------------------------

var CATEGORIES_CHARGES_LIST = [
  // ── Charges financières ──────────────────────────────────────────────────
  'Intérêts d\'emprunt',      // LMNP : seule la part intérêts est déductible
  // ── Charges courantes ────────────────────────────────────────────────────
  'Électricité',
  'Copropriété',
  'Assurance PNO',
  'Taxe foncière',
  'Eau',
  'Internet',
  // ── Investissements (à amortir en Phase B) ───────────────────────────────
  'Mobilier / Équipements',   // meubles, électroménager, literie…
  'Travaux',                   // rénovation, aménagement capitalisable
  // ── Maintenance & divers ─────────────────────────────────────────────────
  'Entretien / Réparations',  // petites réparations, dépannage, entretien courant
  'Frais divers'
];

// Mots-clés → catégorie (insensible à la casse, accents normalisés)
var MOTS_CLES_CATEGORIE = {
  'Intérêts d\'emprunt':  ['interets', 'interet credit', 'credit immo', 'pret immo',
                            'caisse epargne', 'credit agricole', 'bnp paribas', 'lcl',
                            'societe generale', 'banque postale', 'ing direct', 'boursorama',
                            'remboursement pret', 'echeance pret', 'mensualite pret'],
  'Électricité':          ['edf', 'enedis', 'engie', 'direct energie', 'electricite', 'electricit',
                            'total energie'],
  'Eau':                  ['veolia', 'lyonnaise des eaux', 'saur', 'suez eau', 'sdea'],
  'Copropriété':          ['syndic', 'copropriete', 'foncia', 'nexity', 'citya', 'gestia',
                            'immo de france', 'charges copro', 'appel de fonds'],
  'Assurance PNO':        ['assurance pno', 'pno', 'allianz immo', 'axa immo', 'mma immo',
                            'maif habitation', 'groupama immo'],
  'Taxe foncière':        ['taxe fonciere', 'fonciere', 'dgfip', 'tresor public',
                            'direction generale des finances'],
  'Internet':             ['orange', 'sfr', 'free', 'bouygues telecom', 'bbox', 'livebox',
                            'freebox', 'numericable', 'sosh'],
  'Mobilier / Équipements': ['ikea', 'conforama', 'alinea', 'but ', 'mobilier', 'meuble',
                              'literie', 'matelas', 'electromenager', 'amazon', 'cdiscount',
                              'darty', 'fnac', 'boulanger', 'but magasin'],
  'Travaux':              ['travaux', 'renovation', 'amenagement', 'maconnerie', 'peinture',
                            'carrelage', 'parquet', 'electricien', 'plombier', 'plomberie',
                            'leroy merlin', 'castorama', 'bricorama', 'bricoman', 'bricomarche',
                            'point p', 'mr bricolage'],
  'Entretien / Réparations': ['reparation', 'entretien', 'depannage', 'serrurier',
                               'chauffagiste', 'vitrier'],
};

// En-têtes et largeurs de l'onglet Comptabilité
var COMPTA_HEADERS    = ['Date', 'Catégorie', 'Description', 'Montant', 'Chambre', 'Justificatif'];
var COMPTA_COL_WIDTHS = [100, 160, 300, 90, 80, 260];


// ---------------------------------------------------------------------------
// 1. ONGLET COMPTABILITÉ
// ---------------------------------------------------------------------------

/**
 * Récupère l'onglet "Comptabilité", ou le crée + initialise s'il n'existe pas.
 * @return {Sheet}
 */
function getOrCreateComptaSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Comptabilité');
  if (!sheet) {
    sheet = ss.insertSheet('Comptabilité');
    initComptaSheet(sheet);
  }
  return sheet;
}

/**
 * Met en forme l'onglet Comptabilité (appelé une seule fois à la création).
 * @param {Sheet} sheet
 */
function initComptaSheet(sheet) {
  // En-têtes
  var headerRange = sheet.getRange(1, 1, 1, COMPTA_HEADERS.length);
  headerRange.setValues([COMPTA_HEADERS]);
  headerRange.setFontWeight('bold');
  headerRange.setBackground('#2C5282');
  headerRange.setFontColor('#FFFFFF');
  headerRange.setHorizontalAlignment('center');
  sheet.setFrozenRows(1);

  // Largeurs de colonnes
  for (var i = 0; i < COMPTA_COL_WIDTHS.length; i++) {
    sheet.setColumnWidth(i + 1, COMPTA_COL_WIDTHS[i]);
  }

  // Validation colonne Catégorie (B)
  var catRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(CATEGORIES_CHARGES_LIST, true)
    .setAllowInvalid(false)
    .build();
  sheet.getRange(2, 2, 2000, 1).setDataValidation(catRule);

  // Validation colonne Chambre (E)
  var chambreRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['', '1', '2', '3', 'Commun'], true)
    .setAllowInvalid(true)
    .build();
  sheet.getRange(2, 5, 2000, 1).setDataValidation(chambreRule);

  // Formats
  sheet.getRange('A:A').setNumberFormat('dd/mm/yyyy');
  sheet.getRange('D:D').setNumberFormat('#,##0.00 €');

  // Alternance de couleurs (banding)
  try {
    var banding = sheet.getRange('A2:F2001').applyRowBanding();
    banding.setFirstRowColor('#FFFFFF');
    banding.setSecondRowColor('#EBF3FB');
  } catch (e) { /* ignore si déjà appliqué */ }
}


// ---------------------------------------------------------------------------
// 2. MENU : AJOUTER UNE CHARGE
// ---------------------------------------------------------------------------

/**
 * Menu : ouvre le formulaire d'ajout de charge.
 */
function menuAjouterCharge() {
  getOrCreateComptaSheet();
  var html = HtmlService.createHtmlOutputFromFile('Compta_Form')
    .setWidth(480)
    .setHeight(510);
  SpreadsheetApp.getUi().showModalDialog(html, '➕ Ajouter une charge');
}

/**
 * Fournit les données d'initialisation au formulaire HTML.
 * Appelé via google.script.run depuis Compta_Form.html.
 * @return {Object} { categories, chambres, today }
 */
function getComptaFormData() {
  return {
    categories: CATEGORIES_CHARGES_LIST,
    chambres: ['', '1', '2', '3', 'Commun'],
    today: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd')
  };
}

/**
 * Enregistre une charge soumise depuis le formulaire HTML.
 * Appelé via google.script.run depuis Compta_Form.html.
 * @param {Object} data — { date, categorie, description, montant, chambre,
 *                          justifBase64, justifName, justifMime }
 * @return {string} 'OK' si succès, lance une exception sinon.
 */
function receiveCharge(data) {
  // --- Validation ---
  if (!data.date)       throw new Error('La date est obligatoire.');
  if (!data.categorie)  throw new Error('La catégorie est obligatoire.');
  if (!data.description || data.description.trim() === '') {
    throw new Error('La description est obligatoire.');
  }
  var montant = parseFloat((data.montant || '').toString().replace(',', '.'));
  if (isNaN(montant) || montant <= 0) {
    throw new Error('Le montant doit être un nombre positif.');
  }

  var dateObj = parseFlexDate(data.date);
  if (!dateObj) throw new Error('Date invalide.');

  // --- Justificatif (optionnel) ---
  var justifUrl = '';
  if (data.justifBase64 && data.justifName) {
    try {
      var config = getConfig();
      var justifFolder = getOrCreateJustifFolder(
        config, dateObj.getFullYear(), dateObj.getMonth() + 1
      );
      var blob = Utilities.newBlob(
        Utilities.base64Decode(data.justifBase64),
        data.justifMime || 'application/octet-stream',
        data.justifName
      );
      var file = justifFolder.createFile(blob);
      justifUrl = file.getUrl();
    } catch (e) {
      // Non bloquant
      justifUrl = '[Erreur upload: ' + e.message + ']';
    }
  }

  // --- Insertion ---
  var sheet = getOrCreateComptaSheet();
  sheet.appendRow([
    dateObj,
    data.categorie,
    data.description.trim(),
    montant,
    data.chambre || '',
    justifUrl
  ]);

  return 'OK';
}

/**
 * Auto-catégorisation par mots-clés — utilisée en temps réel depuis le formulaire
 * ET pendant l'import CSV.
 * Appelé via google.script.run depuis le HTML.
 * @param {string} description
 * @return {string} Catégorie détectée, '' si aucune.
 */
function autoCategorie(description) {
  if (!description) return '';
  // Normaliser : minuscules + supprimer accents
  var desc = description.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
  for (var cat in MOTS_CLES_CATEGORIE) {
    var keywords = MOTS_CLES_CATEGORIE[cat];
    for (var i = 0; i < keywords.length; i++) {
      var kw = keywords[i].toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '');
      if (desc.indexOf(kw) !== -1) return cat;
    }
  }
  return '';
}


// ---------------------------------------------------------------------------
// 3. MENU : IMPORTER CSV BANQUE
// ---------------------------------------------------------------------------

/**
 * Menu : ouvre le dialog d'import CSV.
 */
function menuImporterCSV() {
  getOrCreateComptaSheet();
  var html = HtmlService.createHtmlOutputFromFile('Compta_CSV')
    .setWidth(720)
    .setHeight(580);
  SpreadsheetApp.getUi().showModalDialog(html, '📊 Importer un relevé bancaire CSV');
}

/**
 * Aperçu de la structure du CSV (5 premières lignes découpées).
 * Appelé depuis Compta_CSV.html pour configurer le mapping de colonnes.
 * @param {string} csvText
 * @param {string} sep — Séparateur détecté (';', ',', '\t')
 * @return {string[][]}
 */
function previewCSV(csvText, sep) {
  sep = sep || ';';
  var lines = csvText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  var preview = [];
  for (var i = 0; i < Math.min(6, lines.length); i++) {
    var line = lines[i].trim();
    if (line) preview.push(splitCSVLine(line, sep));
  }
  return preview;
}

/**
 * Parse le CSV et retourne les lignes avec auto-catégorisation + marquage doublons.
 * Appelé depuis Compta_CSV.html après configuration du mapping.
 * @param {string} csvText
 * @param {Object} mapping — { dateCol, descCol, montantCol, separator, startRow }
 *   (indices 0-based)
 * @return {Object} { rows: [...], dupeCount: number }
 *   rows: [{ date, dateISO, description, montant, categorie, isDupe }]
 */
function parseCSVBanque(csvText, mapping) {
  var sep      = mapping.separator || ';';
  var dateIdx  = parseInt(mapping.dateCol, 10)    || 0;
  var descIdx  = parseInt(mapping.descCol, 10)    || 1;
  var montIdx  = parseInt(mapping.montantCol, 10) || 2;
  var startRow = parseInt(mapping.startRow, 10)   || 1; // 0-indexed (skip header)

  var lines = csvText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  var sheet    = getOrCreateComptaSheet();
  var existing = getExistingCharges(sheet);

  var rows = [];
  var dupeCount = 0;

  for (var i = startRow; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;

    var cols = splitCSVLine(line, sep);
    var maxIdx = Math.max(dateIdx, descIdx, montIdx);
    if (cols.length <= maxIdx) continue;

    var rawDate  = cols[dateIdx].trim().replace(/['"]/g, '');
    var rawDesc  = cols[descIdx].trim().replace(/['"]/g, '');
    var rawMont  = cols[montIdx].trim().replace(/['"]/g, '').replace(/\s/g, '');

    var dateObj = parseFlexDate(rawDate);
    if (!dateObj) continue;

    // Montant : négatif (débit) → valeur absolue
    var montant = parseFloat(rawMont.replace(',', '.'));
    if (isNaN(montant) || montant === 0) continue;
    montant = Math.abs(montant);

    var categorie = autoCategorie(rawDesc);
    var isDupe    = isDuplicate(existing, dateObj, montant, rawDesc);
    if (isDupe) dupeCount++;

    rows.push({
      date:        Utilities.formatDate(dateObj, Session.getScriptTimeZone(), 'dd/MM/yyyy'),
      dateISO:     Utilities.formatDate(dateObj, Session.getScriptTimeZone(), 'yyyy-MM-dd'),
      description: rawDesc,
      montant:     montant,
      categorie:   categorie,
      isDupe:      isDupe
    });
  }

  return { rows: rows, dupeCount: dupeCount };
}

/**
 * Importe dans l'onglet Comptabilité les lignes validées par l'utilisateur.
 * Appelé depuis Compta_CSV.html après confirmation de l'aperçu.
 * @param {Object[]} rows — [{ dateISO, description, montant, categorie, chambre }]
 * @return {number} Nombre de lignes importées.
 */
function importerLignesCSV(rows) {
  var sheet = getOrCreateComptaSheet();
  var imported = 0;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var dateObj = parseFlexDate(r.dateISO);
    if (!dateObj) continue;
    var montant = parseFloat(r.montant);
    if (isNaN(montant) || montant <= 0) continue;
    var cat = r.categorie || 'Frais divers';
    sheet.appendRow([
      dateObj,
      cat,
      (r.description || '').trim(),
      montant,
      r.chambre || '',
      ''
    ]);
    imported++;
  }
  return imported;
}

/**
 * Retourne les catégories disponibles (pour le select dans l'aperçu CSV).
 * @return {string[]}
 */
function getCategoriesList() {
  return CATEGORIES_CHARGES_LIST;
}


// ---------------------------------------------------------------------------
// 4. BILAN DES CHARGES
// ---------------------------------------------------------------------------

/**
 * Menu : actualise (ou crée) l'onglet "Bilan Charges".
 */
function menuActualiserBilan() {
  var ui = SpreadsheetApp.getUi();
  try {
    var ss          = SpreadsheetApp.getActiveSpreadsheet();
    var comptaSheet = getOrCreateComptaSheet();
    var comptaData  = comptaSheet.getDataRange().getValues();

    if (comptaData.length < 2) {
      ui.alert('Bilan Charges',
        'Aucune charge enregistrée dans l\'onglet Comptabilité.',
        ui.ButtonSet.OK);
      return;
    }

    // Récupérer ou créer l'onglet Bilan
    var bilanSheet = ss.getSheetByName('Bilan Charges');
    if (!bilanSheet) {
      bilanSheet = ss.insertSheet('Bilan Charges');
    } else {
      bilanSheet.clearContents();
      bilanSheet.clearFormats();
    }

    genererBilan(comptaData, bilanSheet);
    ss.setActiveSheet(bilanSheet);

    ui.alert('Bilan mis à jour ✓',
      'L\'onglet "Bilan Charges" a été actualisé avec succès.',
      ui.ButtonSet.OK);

  } catch (e) {
    SpreadsheetApp.getUi().alert('Erreur', e.message, ui.ButtonSet.OK);
  }
}

/**
 * Génère le contenu de l'onglet "Bilan Charges" :
 *   – Total annuel par catégorie
 *   – Tableau mois × catégorie pour l'année la plus récente
 * @param {Object[][]} comptaData — Données brutes de l'onglet Comptabilité (avec en-tête).
 * @param {Sheet} bilanSheet
 */
function genererBilan(comptaData, bilanSheet) {
  // --- Structurer les données ---
  var rows = [];
  for (var i = 1; i < comptaData.length; i++) {
    var r = comptaData[i];
    if (!r[0] || !r[1] || !r[3]) continue;
    var d = r[0] instanceof Date ? r[0] : parseFlexDate(r[0]);
    if (!d) continue;
    rows.push({
      date:      d,
      annee:     d.getFullYear(),
      mois:      d.getMonth() + 1,   // 1-12
      categorie: r[1].toString().trim(),
      montant:   parseFloat(r[3]) || 0,
      chambre:   (r[4] || '').toString().trim()
    });
  }
  if (rows.length === 0) return;

  // Années disponibles (desc)
  var anneesSet = {};
  rows.forEach(function(r) { anneesSet[r.annee] = true; });
  var annees = Object.keys(anneesSet).map(Number).sort(function(a, b) { return b - a; });

  var crow = 1; // curseur de ligne dans bilanSheet

  // ---- Pour chaque année : tableau mensuel ----
  annees.forEach(function(annee) {
    var rowsA = rows.filter(function(r) { return r.annee === annee; });
    if (!rowsA.length) return;

    // Titre année
    bilanSheet.getRange(crow, 1).setValue('CHARGES ' + annee);
    bilanSheet.getRange(crow, 1, 1, 14)
      .merge()
      .setFontWeight('bold').setFontSize(12)
      .setBackground('#2C5282').setFontColor('#FFFFFF')
      .setHorizontalAlignment('center');
    bilanSheet.getRange(crow, 1).setValue('CHARGES ' + annee);
    crow++;

    // En-tête colonnes : Catégorie | Jan | Fév | ... | Déc | TOTAL
    var header = ['Catégorie'].concat(MOIS_FR).concat(['TOTAL']);
    bilanSheet.getRange(crow, 1, 1, header.length).setValues([header]);
    bilanSheet.getRange(crow, 1, 1, header.length)
      .setFontWeight('bold').setBackground('#4A90D9').setFontColor('#FFFFFF')
      .setHorizontalAlignment('center');
    crow++;

    var totalParMois = new Array(12).fill(0);
    var totalGeneral = 0;

    CATEGORIES_CHARGES_LIST.forEach(function(cat) {
      var rowsC = rowsA.filter(function(r) { return r.categorie === cat; });
      var rowData = [cat];
      var totalCat = 0;
      for (var m = 1; m <= 12; m++) {
        var montantMois = rowsC
          .filter(function(r) { return r.mois === m; })
          .reduce(function(sum, r) { return sum + r.montant; }, 0);
        rowData.push(montantMois > 0 ? montantMois : '');
        if (montantMois > 0) {
          totalParMois[m - 1] += montantMois;
          totalCat += montantMois;
        }
      }
      rowData.push(totalCat > 0 ? totalCat : '');
      totalGeneral += totalCat;

      bilanSheet.getRange(crow, 1, 1, rowData.length).setValues([rowData]);
      // Format euros sur les colonnes montant (B à N)
      bilanSheet.getRange(crow, 2, 1, 13).setNumberFormat('#,##0.00 €');
      // Fond blanc/gris alterné
      bilanSheet.getRange(crow, 1, 1, header.length)
        .setBackground((crow % 2 === 0) ? '#FFFFFF' : '#EBF3FB');
      crow++;
    });

    // Ligne TOTAL
    var totalRow = ['TOTAL'].concat(totalParMois.map(function(v) { return v > 0 ? v : ''; }));
    totalRow.push(totalGeneral);
    bilanSheet.getRange(crow, 1, 1, totalRow.length).setValues([totalRow]);
    bilanSheet.getRange(crow, 1, 1, totalRow.length)
      .setFontWeight('bold').setBackground('#D6E4F0');
    bilanSheet.getRange(crow, 2, 1, 13).setNumberFormat('#,##0.00 €');
    crow += 2; // ligne vide entre les années
  });

  // Mise en forme globale
  bilanSheet.setColumnWidth(1, 200);
  for (var m = 0; m < 13; m++) {
    bilanSheet.setColumnWidth(m + 2, 80);
  }
  bilanSheet.setFrozenRows(0);
  bilanSheet.setFrozenColumns(1);
}


// ---------------------------------------------------------------------------
// 5. DOSSIER JUSTIFICATIFS SUR DRIVE
// ---------------------------------------------------------------------------

/**
 * Récupère ou crée le dossier Drive pour les justificatifs.
 * Structure : 02_LOCATAIRE/_Justificatifs/<annee>/<mm>/
 * @param {Object} config
 * @param {number} annee
 * @param {number} mois  (1-12)
 * @return {Folder}
 */
function getOrCreateJustifFolder(config, annee, mois) {
  var parentId = config['ID_DOSSIER_LOCATAIRES'];
  if (!parentId) throw new Error('ID_DOSSIER_LOCATAIRES manquant dans Config.');
  var parent      = DriveApp.getFolderById(parentId);
  var justifRoot  = getOrCreateSubFolder(parent, '_Justificatifs');
  var anneeFolder = getOrCreateSubFolder(justifRoot, annee.toString());
  var moisFolder  = getOrCreateSubFolder(anneeFolder, ('0' + mois).slice(-2));
  return moisFolder;
}


// ---------------------------------------------------------------------------
// 6. UTILITAIRES INTERNES
// ---------------------------------------------------------------------------

/**
 * Retourne les charges existantes (pour dédoublonnage CSV).
 * @param {Sheet} sheet
 * @return {Object[]} [{ date, montant, description }]
 */
function getExistingCharges(sheet) {
  var data = sheet.getDataRange().getValues();
  var charges = [];
  for (var i = 1; i < data.length; i++) {
    if (!data[i][0] || !data[i][3]) continue;
    var d = data[i][0] instanceof Date ? data[i][0] : parseFlexDate(data[i][0]);
    if (!d) continue;
    charges.push({
      date:        d,
      montant:     parseFloat(data[i][3]) || 0,
      description: (data[i][2] || '').toString().toLowerCase().trim()
    });
  }
  return charges;
}

/**
 * Vérifie si une ligne est un doublon (même date ±1j + même montant + même libellé).
 * @param {Object[]} existing
 * @param {Date} date
 * @param {number} montant
 * @param {string} description
 * @return {boolean}
 */
function isDuplicate(existing, date, montant, description) {
  var descNorm = description.toLowerCase().trim();
  var dateMs   = date.getTime();
  for (var i = 0; i < existing.length; i++) {
    var e = existing[i];
    if (!e.date) continue;
    if (Math.abs(e.montant - montant) < 0.01
        && Math.abs(e.date.getTime() - dateMs) < 86400000
        && e.description === descNorm) {
      return true;
    }
  }
  return false;
}

/**
 * Parse une date dans plusieurs formats : dd/mm/yyyy, dd-mm-yyyy, yyyy-mm-dd.
 * @param {string|Date} raw
 * @return {Date|null}
 */
function parseFlexDate(raw) {
  if (raw instanceof Date) return isNaN(raw.getTime()) ? null : raw;
  if (!raw) return null;
  var s = raw.toString().trim();

  // dd/mm/yyyy ou dd-mm-yyyy
  var m1 = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
  if (m1) {
    var d = parseInt(m1[1], 10), mo = parseInt(m1[2], 10) - 1;
    var y = parseInt(m1[3], 10);
    if (y < 100) y += 2000;
    var dt = new Date(y, mo, d);
    return isNaN(dt.getTime()) ? null : dt;
  }

  // yyyy-mm-dd ou yyyy/mm/dd
  var m2 = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (m2) {
    var dt2 = new Date(parseInt(m2[1], 10), parseInt(m2[2], 10) - 1, parseInt(m2[3], 10));
    return isNaN(dt2.getTime()) ? null : dt2;
  }

  return null;
}

/**
 * Découpe une ligne CSV en colonnes (gère les guillemets doubles).
 * @param {string} line
 * @param {string} sep
 * @return {string[]}
 */
function splitCSVLine(line, sep) {
  var cols = [], inQuotes = false, current = '';
  for (var i = 0; i < line.length; i++) {
    var c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; } // guillemet échappé
      else { inQuotes = !inQuotes; }
    } else if (c === sep && !inQuotes) {
      cols.push(current); current = '';
    } else {
      current += c;
    }
  }
  cols.push(current);
  return cols;
}


// ---------------------------------------------------------------------------
// 7. IMPORT TABLEAU D'AMORTISSEMENT CRÉDIT
// ---------------------------------------------------------------------------

/**
 * Menu : ouvre le dialog d'import du tableau d'amortissement.
 */
function menuImporterAmortissement() {
  getOrCreateComptaSheet();
  var html = HtmlService.createHtmlOutputFromFile('Compta_Amort')
    .setWidth(700)
    .setHeight(560);
  SpreadsheetApp.getUi().showModalDialog(html, '🏦 Importer tableau d\'amortissement');
}

/**
 * Aperçu des premières lignes du tableau d'amortissement.
 * Réutilise previewCSV (même logique).
 */
function previewAmortissement(csvText, sep) {
  return previewCSV(csvText, sep);
}

/**
 * Parse le tableau d'amortissement et retourne les lignes d'intérêts.
 * N'importe que les lignes dont la date est ≤ aujourd'hui (échéances passées).
 *
 * @param {string} csvText
 * @param {Object} mapping — { dateCol, interetsCol, separator, startRow, descPrefix }
 * @return {Object} { rows, futureCount, dupeCount }
 *   rows: [{ date, dateISO, moisAnnee, interets, isDupe }]
 */
function parseAmortissementCSV(csvText, mapping) {
  var sep      = mapping.separator  || ';';
  var dateIdx  = parseInt(mapping.dateCol,    10) || 0;
  var intIdx   = parseInt(mapping.interetsCol, 10) || 3;
  var startRow = parseInt(mapping.startRow,   10) || 1;
  var prefix   = mapping.descPrefix || 'Intérêts crédit';

  var lines = csvText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  var today = new Date();
  today.setHours(23, 59, 59, 0);

  var sheet    = getOrCreateComptaSheet();
  var existing = getExistingCharges(sheet);

  var rows = [], futureCount = 0, dupeCount = 0;

  for (var i = startRow; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;

    var cols = splitCSVLine(line, sep);
    if (cols.length <= Math.max(dateIdx, intIdx)) continue;

    var rawDate  = cols[dateIdx].trim().replace(/['"]/g, '');
    var rawInt   = cols[intIdx].trim().replace(/['"]/g, '').replace(/\s/g, '');

    var dateObj = parseFlexDate(rawDate);
    if (!dateObj) continue;

    // Ignorer les échéances futures
    if (dateObj > today) { futureCount++; continue; }

    var interets = parseFloat(rawInt.replace(',', '.'));
    if (isNaN(interets) || interets <= 0) continue;

    // Description : "Intérêts crédit — MM/YYYY"
    var moisAnnee = Utilities.formatDate(dateObj, Session.getScriptTimeZone(), 'MM/yyyy');
    var description = prefix + ' — ' + moisAnnee;

    var isDupe = isDuplicate(existing, dateObj, interets, description);
    if (isDupe) dupeCount++;

    rows.push({
      date:        Utilities.formatDate(dateObj, Session.getScriptTimeZone(), 'dd/MM/yyyy'),
      dateISO:     Utilities.formatDate(dateObj, Session.getScriptTimeZone(), 'yyyy-MM-dd'),
      moisAnnee:   moisAnnee,
      description: description,
      interets:    interets,
      isDupe:      isDupe
    });
  }

  return { rows: rows, futureCount: futureCount, dupeCount: dupeCount };
}

/**
 * Importe les lignes d'intérêts validées dans l'onglet Comptabilité.
 * Appelé depuis Compta_Amort.html.
 * @param {Object[]} rows — [{ dateISO, description, interets }]
 * @return {number} Nombre de lignes importées.
 */
function importerInteretsCredit(rows) {
  var sheet = getOrCreateComptaSheet();
  var imported = 0;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var dateObj = parseFlexDate(r.dateISO);
    if (!dateObj) continue;
    var montant = parseFloat(r.interets);
    if (isNaN(montant) || montant <= 0) continue;
    sheet.appendRow([
      dateObj,
      'Intérêts d\'emprunt',
      r.description,
      montant,
      '',   // chambre vide — charge globale du bien
      ''
    ]);
    imported++;
  }
  return imported;
}
