// =============================================================================
// Harnais de test — charge le VRAI code Apps Script dans un contexte Node
// =============================================================================
//
// Les fichiers .gs sont du JavaScript : on les évalue tels quels dans un
// contexte `vm` dont les globales sont les stubs de tests/stubs.js. Aucune
// copie du code de production n'est faite → les tests portent bien sur le code
// livré.
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const stubs = require('./stubs');

const RACINE = path.join(__dirname, '..');

/** Fichiers .gs chargés dans le contexte de test, dans cet ordre. */
const FICHIERS_GS = ['Code.gs', 'WebApp.gs', 'Documenso.gs', 'Signature.gs'];

/** Tous les fichiers .gs du dépôt (contrôle de syntaxe). */
const TOUS_LES_GS = ['Code.gs', 'Code_Compta.gs', 'WebApp.gs', 'Documenso.gs', 'Signature.gs'];

// ---------------------------------------------------------------------------
// Jeu de données par défaut
// ---------------------------------------------------------------------------

const EN_TETES_LOCATAIRES = [
  'Actif', 'Locataire_Nom', 'Locataire_Date', 'Locataire_Lieu', 'EMAIL', 'TELEPHONE',
  'Locataire_Adresse', 'Chambre', 'Date_Début', 'Date_Fin', '1er_Loyer', 'Assurance',
  'Compteur_Eau', 'Compteur_Elec', 'Compteur_Eau_Sortie', 'Compteur_Elec_Sortie',
  'Locataire_Nouvelle_Adresse', 'ID_PDF_EDL', 'ID_DOC_BAIL', 'ID_PDF_BAIL', 'NOTES',
  'Dernier_Loyer', 'ID_DOC_EDL', 'Cosignataires', 'Signature_Statut', 'Signature_Envelope_ID'
];

const EN_TETES_CHAMBRES = [
  'ID Chambre', 'Surface', 'Loyer HC', 'Charges', 'Loyer CC', 'Caution', 'Description des meubles'
];

/** Modèle de bail : n'utilise que des variables gérées par buildReplacements. */
const TEMPLATE_BAIL = [
  'CONTRAT DE LOCATION MEUBLÉE',
  'Bailleur : {{Bailleur_Nom}} — {{Bailleur_Adresse}}',
  'Locataire : {{Locataire_Nom}}, né(e) le {{Locataire_Date}} à {{Locataire_Lieu}}',
  'Logement : {{Location_Adresse}} — chambre n°{{Chambre}}',
  'Loyer : {{Loyer_HC}} + charges {{Charges}} = {{Loyer_CC}}',
  'Dépôt de garantie : {{Caution}}',
  'Durée : à compter du {{Date_Début}}',
  '[[SIGNATURES_DOCUMENSO]]'
];

/** Modèle d'EDL : contient les balises de sortie, laissées en blanc à l'entrée. */
const TEMPLATE_EDL = [
  'ÉTAT DES LIEUX CONTRADICTOIRE',
  'Bailleur : {{Bailleur_Nom}} — {{Bailleur_Adresse}}',
  'Locataire : {{Locataire_Nom}} — nouvelle adresse : {{Locataire_Nouvelle_Adresse}}',
  'Compteur eau : {{Compteur_Eau}} / sortie {{Compteur_Eau_Sortie}}',
  'Compteur élec : {{Compteur_Elec}} / sortie {{Compteur_Elec_Sortie}}',
  '3. État des parties privatives',
  'CHAMBRE N°1',
  'Mobilier chambre 1',
  'CHAMBRE N°2',
  'Mobilier chambre 2',
  'CHAMBRE N°3',
  'Mobilier chambre 3',
  '4. État des parties communes',
  'Cuisine, salon, salle de bain',
  '[[SIGNATURES_DOCUMENSO]]'
];

/**
 * Construit un environnement complet (stubs + données) et y charge le code.
 *
 * @param {Object} [opts]
 *   locataires        — lignes de l'onglet Locataires (objets partiels).
 *   config            — surcharges de l'onglet Config.
 *   proprietes        — propriétés de script.
 *   templateBail/Edl  — paragraphes des modèles Google Docs.
 * @return {Object} { ctx, drive, urlFetch, props, onglets, ids }
 */
function creerEnvironnement(opts) {
  opts = opts || {};

  // --- Drive -------------------------------------------------------------
  const drive = new stubs.FakeDrive();
  const dossierLocataires = drive.creerDossier('folder-locataires', 'LOCATAIRES', 'root');
  const docBail = drive.creerDoc('Bail_Template', opts.templateBail || TEMPLATE_BAIL, 'root');
  const docEdl = drive.creerDoc('EDL_Template', opts.templateEdl || TEMPLATE_EDL, 'root');

  // --- Config ------------------------------------------------------------
  const config = Object.assign({
    Bailleur_Nom: 'Jean MARTIN',
    Bailleur_Email: 'bailleur@example.com',
    Bailleur_Adresse: '1 rue des Tests, 33000 Bordeaux',
    Bailleur_Ville: 'Bordeaux',
    Location_Adresse: '12 avenue du Lac, 33000 Bordeaux',
    ID_BAIL_TEMPLATE: docBail.id,
    ID_EDL_TEMPLATE: docEdl.id,
    ID_DOSSIER_LOCATAIRES: dossierLocataires.id,
    SIGNATURE_BAILLEUR: 'OUI'
  }, opts.config || {});

  const lignesConfig = [['Clé', 'Valeur']];
  Object.keys(config).forEach((k) => {
    if (config[k] !== null && config[k] !== undefined) lignesConfig.push([k, config[k]]);
  });

  // --- Locataires --------------------------------------------------------
  const locatairesParDefaut = [{
    Actif: true,
    Locataire_Nom: 'DUPONT Marie',
    Locataire_Date: new Date(1998, 4, 12),
    Locataire_Lieu: 'Bordeaux',
    EMAIL: 'marie.dupont@example.com',
    TELEPHONE: '0600000000',
    Locataire_Adresse: '5 rue Précédente, 33000 Bordeaux',
    Chambre: 2,
    'Date_Début': new Date(2026, 8, 1),
    Compteur_Eau: '123',
    Compteur_Elec: '4567',
    ID_PDF_BAIL: 'pdf-bail-existant',
    ID_PDF_EDL: 'pdf-edl-existant'
  }];

  const lignes = (opts.locataires || locatairesParDefaut).map((loc) =>
    EN_TETES_LOCATAIRES.map((h) => (loc[h] === undefined ? '' : loc[h])));

  // --- Onglets -----------------------------------------------------------
  const onglets = new Map();
  onglets.set('Config', new stubs.FakeSheet('Config', lignesConfig));
  onglets.set('Locataires', new stubs.FakeSheet('Locataires', [EN_TETES_LOCATAIRES].concat(lignes)));
  onglets.set('Chambres', new stubs.FakeSheet('Chambres', [
    EN_TETES_CHAMBRES,
    [1, '13 m²', 480, 100, 580, 480, 'Lit, bureau, armoire'],
    [2, '9 m²', 460, 100, 560, 460, 'Lit, bureau, armoire'],
    [3, '9 m²', 460, 100, 560, 460, 'Lit, bureau, armoire']
  ]));

  // --- Services ----------------------------------------------------------
  const urlFetch = stubs.construireUrlFetchApp();
  const props = stubs.construirePropertiesService(Object.assign({
    DOCUMENSO_API_TOKEN: 'api_token_de_test'
  }, opts.proprietes || {}));

  const journaux = [];
  const sandbox = {
    SpreadsheetApp: stubs.construireSpreadsheetApp(onglets),
    DriveApp: stubs.construireDriveApp(drive),
    DocumentApp: stubs.construireDocumentApp(drive),
    UrlFetchApp: urlFetch,
    Utilities: stubs.construireUtilities(),
    PropertiesService: props,
    Session: { getScriptTimeZone: () => 'Europe/Paris' },
    Logger: { log: (m) => journaux.push(String(m)) },
    MimeType: { PDF: 'application/pdf', GOOGLE_DOCS: 'application/vnd.google-apps.document' },
    GmailApp: {
      createDraft: () => ({ getId: () => 'draft' }),
      sendEmail: () => {}
    },
    ScriptApp: {
      getProjectTriggers: () => [],
      newTrigger: () => ({
        timeBased: () => ({
          everyHours: () => ({ create: () => {} }),
          onMonthDay: () => ({ atHour: () => ({ create: () => {} }) })
        })
      }),
      deleteTrigger: () => {},
      getOAuthToken: () => 'oauth-test'
    },
    console,
    JSON,
    Math,
    Date,
    Object,
    Array,
    String,
    Number,
    RegExp,
    Error,
    isNaN,
    parseInt,
    parseFloat,
    encodeURIComponent,
    decodeURIComponent
  };
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);
  FICHIERS_GS.forEach((nom) => {
    const source = fs.readFileSync(path.join(RACINE, nom), 'utf8');
    vm.runInContext(source, ctx, { filename: nom });
  });

  return {
    ctx,
    drive,
    urlFetch,
    props,
    onglets,
    journaux,
    ids: {
      bailTemplate: docBail.id,
      edlTemplate: docEdl.id,
      dossierLocataires: dossierLocataires.id
    }
  };
}

/**
 * Contrôle de syntaxe de tous les fichiers .gs (tient lieu de lint : le projet
 * n'a aucune dépendance npm et Apps Script n'accepte pas d'outillage).
 * @return {string[]} Erreurs rencontrées (vide si tout est bon).
 */
function verifierSyntaxe() {
  const erreurs = [];
  TOUS_LES_GS.forEach((nom) => {
    const chemin = path.join(RACINE, nom);
    if (!fs.existsSync(chemin)) {
      erreurs.push(nom + ' : fichier absent');
      return;
    }
    try {
      new vm.Script(fs.readFileSync(chemin, 'utf8'), { filename: nom });
    } catch (e) {
      erreurs.push(nom + ' : ' + e.message);
    }
  });
  return erreurs;
}

module.exports = {
  creerEnvironnement,
  verifierSyntaxe,
  EN_TETES_LOCATAIRES,
  TEMPLATE_BAIL,
  TEMPLATE_EDL,
  FICHIERS_GS,
  TOUS_LES_GS
};
