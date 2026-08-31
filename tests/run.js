// =============================================================================
// Tests — intégration Documenso (aucune dépendance npm, aucun appel réseau)
// =============================================================================
//
//   node tests/run.js            → contrôle de syntaxe + tous les tests
//   node tests/run.js signature  → filtre les tests dont le nom contient "signature"
//
// L'API Documenso est intégralement mockée : AUCUN test ne peut déclencher une
// vraie demande de signature.
// =============================================================================

'use strict';

const harness = require('./harness');

// ---------------------------------------------------------------------------
// Micro-framework
// ---------------------------------------------------------------------------

const tests = [];
let echecs = 0;
let reussites = 0;
const filtre = (process.argv[2] || '').toLowerCase();

function test(nom, fn) { tests.push({ nom, fn }); }

function assert(condition, message) {
  if (!condition) throw new Error('Assertion échouée : ' + message);
}
function assertEgal(reel, attendu, message) {
  if (reel !== attendu) {
    throw new Error('Assertion échouée : ' + message +
      '\n    attendu : ' + JSON.stringify(attendu) +
      '\n    obtenu  : ' + JSON.stringify(reel));
  }
}
function assertContient(texte, fragment, message) {
  if (String(texte).indexOf(fragment) === -1) {
    throw new Error('Assertion échouée : ' + message +
      '\n    « ' + fragment +' » absent de : ' + String(texte).slice(0, 400));
  }
}
function assertLeve(fn, fragment, message) {
  let leve = null;
  try { fn(); } catch (e) { leve = e; }
  assert(leve !== null, message + ' (aucune erreur levée)');
  if (fragment) assertContient(leve.message, fragment, message);
  return leve;
}

// ---------------------------------------------------------------------------
// Serveur Documenso simulé
// ---------------------------------------------------------------------------

/**
 * Routeur HTTP simulé.
 * @param {Object} cfg
 *   create      — réponse (ou fonction(n)) de POST /envelope/create
 *   get         — réponse (ou fonction(n)) de GET /envelope/{id}
 *   distribute  — réponse de POST /envelope/distribute
 *   del         — réponse de POST /envelope/delete
 *   item        — réponse de GET /envelope/item/{id}/download
 *   certificat  — réponse du certificat
 *   audit       — réponse du journal d'audit
 */
function routeur(cfg) {
  cfg = cfg || {};
  const compteurs = {};

  function resoudre(cle, defaut) {
    compteurs[cle] = (compteurs[cle] || 0) + 1;
    const v = cfg[cle] === undefined ? defaut : cfg[cle];
    return typeof v === 'function' ? v(compteurs[cle]) : v;
  }

  return function (url) {
    if (url.indexOf('/envelope/create') !== -1) {
      return resoudre('create', { code: 200, corps: { envelopeId: 'env_test_1' } });
    }
    if (url.indexOf('/envelope/distribute') !== -1) {
      return resoudre('distribute', { code: 200, corps: { success: true } });
    }
    if (url.indexOf('/envelope/delete') !== -1) {
      return resoudre('del', { code: 200, corps: { success: true } });
    }
    if (url.indexOf('/download') !== -1 && url.indexOf('/item/') !== -1) {
      return resoudre('item', {
        code: 200, corps: '%PDF-signe', headers: { 'Content-Type': 'application/pdf' }
      });
    }
    if (url.indexOf('/certificate/download') !== -1) {
      return resoudre('certificat', {
        code: 200, corps: '%PDF-certificat', headers: { 'Content-Type': 'application/pdf' }
      });
    }
    if (url.indexOf('/audit-log/download') !== -1) {
      return resoudre('audit', {
        code: 200, corps: '%PDF-journal', headers: { 'Content-Type': 'application/pdf' }
      });
    }
    if (url.indexOf('/envelope/') !== -1) {
      return resoudre('get', { code: 200, corps: enveloppe('DRAFT') });
    }
    throw new Error('URL non simulée : ' + url);
  };
}

/**
 * Corps d'une enveloppe Documenso.
 * @param {string} statut — DRAFT | PENDING | COMPLETED | REJECTED…
 * @param {Object} [opts] — { emails, signes, sansChamps, elements }
 */
function enveloppe(statut, opts) {
  opts = opts || {};
  const emails = opts.emails || ['bailleur@example.com', 'marie.dupont@example.com'];
  const signes = opts.signes || [];
  return {
    id: 'env_test_1',
    envelopeId: 'env_test_1',
    status: statut,
    recipients: emails.map((email, i) => ({
      id: i + 1,
      email,
      name: 'Signataire ' + (i + 1),
      signingStatus: signes.indexOf(email) !== -1 ? 'SIGNED' : 'NOT_SIGNED',
      fields: opts.sansChamps && opts.sansChamps.indexOf(email) !== -1
        ? []
        : [{ type: 'SIGNATURE' }, { type: 'NAME' }, { type: 'DATE' }]
    })),
    envelopeItems: opts.elements || [
      { envelopeItemId: 'item_1', title: 'Bail DUPONT' }
    ]
  };
}

/** Corps du multipart de la n-ième requête create, en texte. */
function corpsCreate(env, n) {
  const appels = env.urlFetch.appels().filter((a) => a.url.indexOf('/envelope/create') !== -1);
  const appel = appels[(n || 1) - 1];
  assert(appel, 'aucun appel /envelope/create enregistré');
  return Buffer.from(appel.params.payload).toString('utf8');
}

/** Payload JSON envoyé lors du create (partie « payload » du multipart). */
function payloadCreate(env, n) {
  const corps = corpsCreate(env, n);
  const m = corps.match(/name="payload"\r\n\r\n([\s\S]*?)\r\n--/);
  assert(m, 'partie « payload » introuvable dans le multipart');
  return JSON.parse(m[1]);
}

/** Lignes de l'onglet Signatures sous forme d'objets. */
function lignesSuivi(env) {
  return env.ctx.lireDemandesSignature();
}

/** Noms des fichiers présents dans Drive. */
function fichiersDrive(env) {
  return [...env.drive.fichiers.values()].filter((f) => !f.trashed).map((f) => f.name);
}

// ---------------------------------------------------------------------------
// TESTS — sélection des documents
// ---------------------------------------------------------------------------

test('sélection Bail : un seul document, PDF généré et envoyé', () => {
  const env = harness.creerEnvironnement();
  env.urlFetch.setRouteur(routeur({}));

  const res = env.ctx.envoyerDemandeSignature(2, 'BAIL');
  assertEgal(res.envelopeId, 'env_test_1', 'identifiant d\'enveloppe remonté');
  assertEgal(res.documents.length, 1, 'un seul document envoyé');
  assertEgal(res.documents[0].type, 'BAIL', 'le document est le bail');

  const payload = payloadCreate(env);
  assertEgal(payload.type, 'DOCUMENT', 'type d\'enveloppe');
  assertContient(corpsCreate(env), 'filename="', 'un fichier joint');
  assertEgal((corpsCreate(env).match(/filename="/g) || []).length, 1, 'exactement 1 fichier');
});

test('sélection État des lieux : le bon modèle est utilisé', () => {
  const env = harness.creerEnvironnement();
  env.urlFetch.setRouteur(routeur({}));

  const res = env.ctx.envoyerDemandeSignature(2, 'EDL');
  assertEgal(res.documents[0].type, 'EDL', 'le document est l\'EDL');
  assertContient(corpsCreate(env), 'ÉTAT DES LIEUX CONTRADICTOIRE', 'contenu du modèle EDL');
  assertContient(res.documents[0].fichier, 'Etat-des-lieux-entree', 'nom de fichier déterministe');
});

test('sélection Bail + EDL : une seule enveloppe contenant les deux PDF', () => {
  const env = harness.creerEnvironnement();
  env.urlFetch.setRouteur(routeur({}));

  const res = env.ctx.envoyerDemandeSignature(2, 'BAIL_EDL');
  const creates = env.urlFetch.appels().filter((a) => a.url.indexOf('/envelope/create') !== -1);
  assertEgal(creates.length, 1, 'une seule enveloppe créée');
  assertEgal(res.documents.length, 2, 'deux documents');

  const corps = corpsCreate(env);
  assertEgal((corps.match(/filename="/g) || []).length, 2, 'deux fichiers dans le multipart');
  assertContient(corps, 'CONTRAT DE LOCATION MEUBLÉE', 'le bail est joint');
  assertContient(corps, 'ÉTAT DES LIEUX CONTRADICTOIRE', 'l\'EDL est joint');
  assertEgal(lignesSuivi(env)[0]['Documents'], 'BAIL+EDL', 'suivi : les deux types');
});

// ---------------------------------------------------------------------------
// TESTS — signataires
// ---------------------------------------------------------------------------

test('un locataire : r1 bailleur, r2 locataire', () => {
  const env = harness.creerEnvironnement();
  const ctx = env.ctx;
  const signataires = ctx.resoudreSignataires(ctx.getTenantByRow(2), ctx.getConfig());

  assertEgal(signataires.length, 2, 'deux signataires');
  assertEgal(signataires[0].rang, 'r1', 'premier rang');
  assertEgal(signataires[0].role, 'bailleur', 'r1 = bailleur');
  assertEgal(signataires[1].role, 'locataire', 'r2 = locataire');
  assertEgal(signataires[1].email, 'marie.dupont@example.com', 'email du locataire');
});

test('plusieurs colocataires : rangs r3/r4 dans un ordre déterministe', () => {
  const env = harness.creerEnvironnement({
    locataires: [{
      Actif: true,
      Locataire_Nom: 'DUPONT Marie',
      EMAIL: 'marie.dupont@example.com',
      Chambre: 2,
      'Date_Début': new Date(2026, 8, 1),
      ID_PDF_BAIL: 'pdf-bail',
      ID_PDF_EDL: 'pdf-edl',
      // Saisis volontairement dans le désordre
      Cosignataires: 'ZOE Martin <zoe@example.com>; ANNA Blanc <anna@example.com>'
    }]
  });
  const ctx = env.ctx;
  const signataires = ctx.resoudreSignataires(ctx.getTenantByRow(2), ctx.getConfig());

  assertEgal(signataires.length, 4, 'quatre signataires');
  assertEgal(signataires[2].email, 'anna@example.com', 'r3 = premier email dans l\'ordre alphabétique');
  assertEgal(signataires[3].email, 'zoe@example.com', 'r4');
  assertEgal(signataires[2].nom, 'ANNA Blanc', 'nom du colocataire extrait');

  // L'ordre ne dépend pas de la saisie : la liste inversée donne le même résultat
  const env2 = harness.creerEnvironnement({
    locataires: [{
      Locataire_Nom: 'DUPONT Marie', EMAIL: 'marie.dupont@example.com', Chambre: 2,
      ID_PDF_BAIL: 'pdf-bail', ID_PDF_EDL: 'pdf-edl',
      Cosignataires: 'ANNA Blanc <anna@example.com>\nZOE Martin <zoe@example.com>'
    }]
  });
  const s2 = env2.ctx.resoudreSignataires(env2.ctx.getTenantByRow(2), env2.ctx.getConfig());
  assertEgal(s2[2].email, 'anna@example.com', 'ordre stable quelle que soit la saisie');

  env.urlFetch.setRouteur(routeur({
    get: () => ({
      code: 200,
      corps: enveloppe('DRAFT', {
        emails: ['bailleur@example.com', 'marie.dupont@example.com',
                 'anna@example.com', 'zoe@example.com']
      })
    })
  }));
  const res = ctx.envoyerDemandeSignature(2, 'BAIL');
  const payload = payloadCreate(env);
  assertEgal(payload.recipients.length, 4, 'quatre destinataires envoyés');
  assertEgal(payload.recipients[3].email, 'zoe@example.com', 'ordre du payload = ordre des rangs');
  assertEgal(res.champs.length, 4, 'champs vérifiés pour chaque signataire');
});

test('bailleur non signataire : le locataire devient r1', () => {
  const env = harness.creerEnvironnement({ config: { SIGNATURE_BAILLEUR: 'NON' } });
  const ctx = env.ctx;
  const signataires = ctx.resoudreSignataires(ctx.getTenantByRow(2), ctx.getConfig());

  assertEgal(signataires.length, 1, 'un seul signataire');
  assertEgal(signataires[0].role, 'locataire', 'r1 = locataire');

  env.urlFetch.setRouteur(routeur({
    get: () => ({ code: 200, corps: enveloppe('DRAFT', { emails: ['marie.dupont@example.com'] }) })
  }));
  ctx.envoyerDemandeSignature(2, 'BAIL');
  const corps = corpsCreate(env);
  assertContient(corps, '{{signature, r1}}', 'placeholder r1 présent');
  assert(corps.indexOf('{{signature, r2}}') === -1, 'aucun placeholder r2 généré');
});

test('bailleur signataire sans email configuré : envoi bloqué', () => {
  const env = harness.creerEnvironnement({ config: { Bailleur_Email: '' } });
  const pre = env.ctx.webPreparerSignature(2, 'BAIL');
  assertEgal(pre.ok, false, 'préparation bloquée');
  assertContient(pre.blocages.join(' '), 'Bailleur_Email', 'la clé manquante est nommée');
});

// ---------------------------------------------------------------------------
// TESTS — placeholders
// ---------------------------------------------------------------------------

test('placeholders générés dans le PDF, un par ligne', () => {
  const env = harness.creerEnvironnement();
  env.urlFetch.setRouteur(routeur({}));
  env.ctx.envoyerDemandeSignature(2, 'BAIL');

  const corps = corpsCreate(env);
  ['{{name, r1}}', '{{signature, r1}}', '{{date, r1}}',
   '{{name, r2}}', '{{signature, r2}}', '{{date, r2}}'].forEach((ph) => {
    assertContient(corps, ph, 'placeholder ' + ph);
  });
  // Chaque placeholder est ouvert ET fermé sur la même ligne (aucune coupure).
  // On n'inspecte que les lignes contenant un placeholder : la partie JSON du
  // multipart contient des accolades qui ne sont pas des placeholders.
  corps.split('\n').filter((l) => l.indexOf('{{') !== -1).forEach((ligne) => {
    assertEgal((ligne.match(/\{\{/g) || []).length, (ligne.match(/\}\}/g) || []).length,
      'placeholder non coupé sur la ligne : ' + ligne);
    assertEgal((ligne.match(/\{\{/g) || []).length, 1, 'un seul placeholder par ligne : ' + ligne);
  });
  assert(corps.indexOf('[[SIGNATURES_DOCUMENSO]]') === -1, 'marqueur interne retiré');
});

test('placeholders manquants : modèle sans marqueur → envoi bloqué', () => {
  const env = harness.creerEnvironnement({
    templateBail: ['CONTRAT', 'Locataire : {{Locataire_Nom}}', 'Fait à Bordeaux']
  });
  const pre = env.ctx.webPreparerSignature(2, 'BAIL');
  assertEgal(pre.ok, false, 'préparation bloquée');
  assertContient(pre.blocages.join(' '), '[[SIGNATURES_DOCUMENSO]]', 'le marqueur est nommé');

  env.urlFetch.setRouteur(routeur({}));
  assertLeve(() => env.ctx.envoyerDemandeSignature(2, 'BAIL'),
    'SIGNATURES_DOCUMENSO', 'l\'envoi refuse aussi côté serveur');
  assertEgal(env.urlFetch.appels().length, 0, 'aucun appel API');
});

test('marqueur en dernier paragraphe : pris en charge sans erreur Docs', () => {
  // Google Docs refuse de supprimer le dernier paragraphe du corps : le code
  // doit le vider au lieu de le retirer.
  const env = harness.creerEnvironnement({
    templateBail: [
      'CONTRAT',
      'Locataire : {{Locataire_Nom}}',
      'Fait à Bordeaux',
      '[[SIGNATURES_DOCUMENSO]]'
    ]
  });
  env.urlFetch.setRouteur(routeur({}));

  const res = env.ctx.envoyerDemandeSignature(2, 'BAIL');
  assertEgal(res.envelopeId, 'env_test_1', 'envoi réussi');

  const corps = corpsCreate(env);
  assert(corps.indexOf('[[SIGNATURES_DOCUMENSO]]') === -1, 'marqueur retiré du PDF');
  assertContient(corps, '{{signature, r1}}', 'placeholder r1 présent');
  assertContient(corps, '{{signature, r2}}', 'placeholder r2 présent');
});

test('marqueur dans un tableau : refus explicite (le tableau serait supprimé)', () => {
  const env = harness.creerEnvironnement({
    templateBail: [
      'CONTRAT',
      'Locataire : {{Locataire_Nom}}',
      { text: 'Le bailleur | Le locataire | [[SIGNATURES_DOCUMENSO]]', type: 'TABLE' }
    ]
  });
  env.urlFetch.setRouteur(routeur({}));

  // Détecté dès la préparation, avant même de dupliquer le modèle
  const pre = env.ctx.webPreparerSignature(2, 'BAIL');
  assertEgal(pre.ok, false, 'préparation bloquée');
  assertContient(pre.blocages.join(' '), 'paragraphe autonome', 'motif expliqué');

  const err = assertLeve(() => env.ctx.envoyerDemandeSignature(2, 'BAIL'),
    'paragraphe autonome', 'placement dans un tableau refusé');
  assertContient(err.message, 'TABLE', 'type d\'élément fautif indiqué');
  assertEgal(env.urlFetch.appels().length, 0, 'aucun appel API');
});

test('validerPlaceholders détecte manquant, doublon et rang hors bornes', () => {
  const env = harness.creerEnvironnement();
  const ctx = env.ctx;
  const deux = [{ rang: 'r1' }, { rang: 'r2' }];

  const complet = '{{name, r1}}\n{{signature, r1}}\n{{date, r1}}\n' +
                  '{{name, r2}}\n{{signature, r2}}\n{{date, r2}}';
  assertEgal(ctx.validerPlaceholders(complet, deux).ok, true, 'jeu complet valide');

  const manquant = complet.replace('{{signature, r2}}', '');
  const r1 = ctx.validerPlaceholders(manquant, deux);
  assertEgal(r1.ok, false, 'placeholder manquant détecté');
  assertContient(r1.problemes.join(' '), 'Placeholder manquant : {{signature, r2}}', 'message explicite');

  const double = complet + '\n{{signature, r1}}';
  assertContient(ctx.validerPlaceholders(double, deux).problemes.join(' '),
    'en double', 'doublon détecté');

  const horsBornes = complet + '\n{{signature, r5}}';
  assertContient(ctx.validerPlaceholders(horsBornes, deux).problemes.join(' '),
    'ne correspond à aucun signataire', 'rang hors bornes détecté');

  const coupe = '{{signature,\nr1}}\n{{name, r1}}\n{{date, r1}}';
  assertContient(ctx.validerPlaceholders(coupe, [{ rang: 'r1' }]).problemes.join(' '),
    'coupé', 'placeholder coupé détecté');
});

test('EDL : les balises de sortie en blanc sont retirées de la copie signée', () => {
  const env = harness.creerEnvironnement();
  env.urlFetch.setRouteur(routeur({}));
  const res = env.ctx.envoyerDemandeSignature(2, 'EDL');

  const corps = corpsCreate(env);
  assert(corps.indexOf('{{Compteur_Eau_Sortie}}') === -1, 'balise de sortie retirée');
  assert(corps.indexOf('{{Locataire_Nouvelle_Adresse}}') === -1, 'balise nouvelle adresse retirée');
  assertContient(corps, '{{signature, r2}}', 'les placeholders Documenso subsistent');
  assertEgal(res.documents.length, 1, 'un document');

  // La chambre 2 est conservée, les autres supprimées (logique EDL existante)
  assertContient(corps, 'Mobilier chambre 2', 'chambre du locataire conservée');
  assert(corps.indexOf('Mobilier chambre 1') === -1, 'chambre 1 supprimée');
});

test('le modèle Google Docs source n\'est jamais modifié', () => {
  const env = harness.creerEnvironnement();
  env.urlFetch.setRouteur(routeur({}));
  env.ctx.envoyerDemandeSignature(2, 'BAIL_EDL');

  const modele = env.drive.fichiers.get(env.ids.bailTemplate);
  assertContient(modele.body.getText(), '{{Locataire_Nom}}', 'variables intactes dans le modèle');
  assertContient(modele.body.getText(), '[[SIGNATURES_DOCUMENSO]]', 'marqueur intact dans le modèle');
  assertEgal(modele.trashed, false, 'modèle non supprimé');
});

// ---------------------------------------------------------------------------
// TESTS — pré-contrôles
// ---------------------------------------------------------------------------

test('email invalide : envoi bloqué avant tout appel API', () => {
  const env = harness.creerEnvironnement({
    locataires: [{
      Locataire_Nom: 'DUPONT Marie', EMAIL: 'marie.dupont@@pas-un-email', Chambre: 2,
      ID_PDF_BAIL: 'pdf-bail', ID_PDF_EDL: 'pdf-edl'
    }]
  });
  const pre = env.ctx.webPreparerSignature(2, 'BAIL');
  assertEgal(pre.ok, false, 'préparation bloquée');
  assertContient(pre.blocages.join(' '), 'Email invalide', 'motif explicite');

  env.urlFetch.setRouteur(routeur({}));
  assertLeve(() => env.ctx.envoyerDemandeSignature(2, 'BAIL'), 'Email invalide', 'envoi refusé');
  assertEgal(env.urlFetch.appels().length, 0, 'aucun appel API');
});

test('document non généré : envoi bloqué', () => {
  const env = harness.creerEnvironnement({
    locataires: [{
      Locataire_Nom: 'DUPONT Marie', EMAIL: 'marie.dupont@example.com', Chambre: 2,
      ID_PDF_BAIL: '', ID_PDF_EDL: 'pdf-edl'
    }]
  });
  const pre = env.ctx.webPreparerSignature(2, 'BAIL');
  assertEgal(pre.ok, false, 'préparation bloquée');
  assertContient(pre.blocages.join(' '), 'ID_PDF_BAIL', 'colonne manquante nommée');
});

test('token absent : envoi bloqué, mais DRY_RUN autorisé', () => {
  const env = harness.creerEnvironnement({ proprietes: { DOCUMENSO_API_TOKEN: '' } });
  const pre = env.ctx.webPreparerSignature(2, 'BAIL');
  assertEgal(pre.ok, false, 'préparation bloquée');
  assertContient(pre.blocages.join(' '), 'DOCUMENSO_API_TOKEN', 'la propriété est nommée');

  const res = env.ctx.envoyerDemandeSignature(2, 'BAIL', { dryRun: true });
  assertEgal(res.dryRun, true, 'DRY_RUN possible sans token');
  assertEgal(env.urlFetch.appels().length, 0, 'aucun appel API');
});

test('doublon : une deuxième demande identique est refusée', () => {
  const env = harness.creerEnvironnement();
  env.urlFetch.setRouteur(routeur({}));

  const premier = env.ctx.envoyerDemandeSignature(2, 'BAIL');
  const pre = env.ctx.webPreparerSignature(2, 'BAIL');
  assertEgal(pre.ok, false, 'deuxième demande bloquée');
  assertContient(pre.blocages.join(' '), 'demande identique existe déjà', 'motif explicite');
  assertContient(pre.blocages.join(' '), premier.envelopeId, 'l\'enveloppe existante est citée');

  assertLeve(() => env.ctx.envoyerDemandeSignature(2, 'BAIL'),
    'demande identique', 'envoi refusé');
  assertEgal(
    env.urlFetch.appels().filter((a) => a.url.indexOf('/envelope/create') !== -1).length, 1,
    'une seule enveloppe créée au total');
});

test('identifiant externe déterministe et sensible au contenu', () => {
  const env = harness.creerEnvironnement();
  const ctx = env.ctx;
  const tenant = ctx.getTenantByRow(2);
  const config = ctx.getConfig();
  const chambre = ctx.getChambreData(tenant.Chambre);
  const sig = ctx.resoudreSignataires(tenant, config);

  const id1 = ctx.construireExternalId(tenant, config, chambre, 'BAIL', sig);
  const id2 = ctx.construireExternalId(tenant, config, chambre, 'BAIL', sig);
  assertEgal(id1, id2, 'même contenu → même identifiant');
  assertContient(id1, 'GL-ch2-dupont-marie-BAIL-', 'format lisible');

  const idAutreJeu = ctx.construireExternalId(tenant, config, chambre, 'BAIL_EDL', sig);
  assert(idAutreJeu !== id1, 'jeu différent → identifiant différent');

  const tenantModifie = ctx.getTenantByRow(2);
  tenantModifie['Locataire_Adresse'] = 'Nouvelle adresse';
  assert(ctx.construireExternalId(tenantModifie, config, chambre, 'BAIL', sig) !== id1,
    'contenu modifié → nouvel identifiant');
});

// ---------------------------------------------------------------------------
// TESTS — erreurs API
// ---------------------------------------------------------------------------

test('erreur API avant création : aucune enveloppe, reprise sûre', () => {
  const env = harness.creerEnvironnement();
  env.urlFetch.setRouteur(routeur({
    create: { code: 400, corps: { message: 'Invalid payload' } }
  }));

  const err = assertLeve(() => env.ctx.envoyerDemandeSignature(2, 'BAIL'),
    'création de l\'enveloppe', 'erreur remontée');
  assertContient(err.message, 'relancer l\'envoi sans risque de doublon', 'reprise annoncée sûre');

  const suivi = lignesSuivi(env);
  assertEgal(suivi.length, 1, 'une trace conservée');
  assertEgal(suivi[0]['Statut'], 'ERREUR', 'statut ERREUR');
  assertEgal(String(suivi[0]['Envelope_ID']), '', 'aucun identifiant d\'enveloppe');
});

test('token refusé par Documenso : message explicite, aucune enveloppe', () => {
  const env = harness.creerEnvironnement();
  env.urlFetch.setRouteur(routeur({ create: { code: 401, corps: { message: 'Unauthorized' } } }));

  const err = assertLeve(() => env.ctx.envoyerDemandeSignature(2, 'BAIL'), 'token', 'token signalé');
  assertContient(err.message, 'TOKEN_INVALIDE', 'code d\'erreur');
  assertContient(err.message, 'sans risque de doublon', 'reprise sûre');
});

test('quota atteint : message dédié, pas de reprise automatique', () => {
  const env = harness.creerEnvironnement();
  env.urlFetch.setRouteur(routeur({
    create: { code: 403, corps: { message: 'Document limit reached, please upgrade' } }
  }));

  const err = assertLeve(() => env.ctx.envoyerDemandeSignature(2, 'BAIL'), 'Quota', 'quota signalé');
  assertContient(err.message, '5 documents', 'limite du plan gratuit rappelée');
  assertEgal(
    env.urlFetch.appels().filter((a) => a.url.indexOf('/envelope/create') !== -1).length, 1,
    'aucune nouvelle tentative');
});

test('erreur après création mais avant distribution : enveloppe conservée', () => {
  const env = harness.creerEnvironnement();
  env.urlFetch.setRouteur(routeur({
    distribute: { code: 500, corps: { message: 'Internal error' } }
  }));

  const err = assertLeve(() => env.ctx.envoyerDemandeSignature(2, 'BAIL'),
    'envoi de l\'enveloppe', 'erreur de distribution');
  assertContient(err.message, 'env_test_1', 'identifiant Documenso cité');
  assertContient(err.message, 'Ne relancez pas', 'mise en garde contre le doublon');

  const suivi = lignesSuivi(env);
  assertEgal(suivi[0]['Statut'], 'ERREUR', 'statut ERREUR');
  assertEgal(suivi[0]['Envelope_ID'], 'env_test_1', 'identifiant conservé pour annulation');

  // Nouvelle tentative refusée tant que l'enveloppe existe
  const pre = env.ctx.webPreparerSignature(2, 'BAIL');
  assertEgal(pre.ok, false, 'relance bloquée');
  assertContient(pre.blocages.join(' '), 'annulez-la avant de relancer', 'consigne claire');
});

test('champ de signature non détecté : enveloppe non distribuée', () => {
  const env = harness.creerEnvironnement();
  env.urlFetch.setRouteur(routeur({
    get: () => ({
      code: 200,
      corps: enveloppe('DRAFT', { sansChamps: ['marie.dupont@example.com'] })
    })
  }));

  const err = assertLeve(() => env.ctx.envoyerDemandeSignature(2, 'BAIL'),
    'aucun champ de signature détecté', 'problème de champ signalé');
  assertContient(err.message, 'créée en BROUILLON mais non envoyée', 'état de l\'enveloppe précisé');
  assertEgal(
    env.urlFetch.appels().filter((a) => a.url.indexOf('/envelope/distribute') !== -1).length, 0,
    'aucune distribution');
});

test('erreur transitoire : une seule reprise réussit, une seule enveloppe', () => {
  const env = harness.creerEnvironnement();
  env.urlFetch.setRouteur(routeur({
    create: (n) => (n === 1
      ? { code: 429, corps: { message: 'Too many requests' } }
      : { code: 200, corps: { envelopeId: 'env_test_1' } })
  }));

  const res = env.ctx.envoyerDemandeSignature(2, 'BAIL');
  assertEgal(res.envelopeId, 'env_test_1', 'envoi finalement réussi');
  assertEgal(
    env.urlFetch.appels().filter((a) => a.url.indexOf('/envelope/create') !== -1).length, 2,
    'exactement une reprise');
});

test('réponse sans identifiant d\'enveloppe : reprise déclarée non sûre', () => {
  const env = harness.creerEnvironnement();
  env.urlFetch.setRouteur(routeur({ create: { code: 200, corps: { ok: true } } }));

  const err = assertLeve(() => env.ctx.envoyerDemandeSignature(2, 'BAIL'),
    'sans identifiant d\'enveloppe', 'réponse incomplète détectée');
  assertContient(err.message, 'vérifiez dans Documenso', 'consigne de vérification manuelle');
});

// ---------------------------------------------------------------------------
// TESTS — suivi, finalisation, archivage
// ---------------------------------------------------------------------------

test('suivi : PENDING partiellement signé puis COMPLETED avec archivage', () => {
  const env = harness.creerEnvironnement();
  env.urlFetch.setRouteur(routeur({}));
  env.ctx.envoyerDemandeSignature(2, 'BAIL_EDL');
  assertEgal(lignesSuivi(env)[0]['Statut'], 'EN_ATTENTE_SIGNATURE', 'statut après envoi');

  // 1) un seul signataire a signé
  env.urlFetch.setRouteur(routeur({
    get: () => ({ code: 200, corps: enveloppe('PENDING', { signes: ['bailleur@example.com'] }) })
  }));
  env.ctx.actualiserStatutsSignature();
  assertEgal(lignesSuivi(env)[0]['Statut'], 'PARTIELLEMENT_SIGNE', 'signature partielle détectée');

  // 2) enveloppe finalisée → téléchargement et archivage
  env.urlFetch.setRouteur(routeur({
    get: () => ({
      code: 200,
      corps: enveloppe('COMPLETED', {
        signes: ['bailleur@example.com', 'marie.dupont@example.com'],
        elements: [
          { envelopeItemId: 'item_1', title: 'Bail DUPONT Marie' },
          { envelopeItemId: 'item_2', title: 'Etat des lieux DUPONT Marie' }
        ]
      })
    })
  }));
  const rapport = env.ctx.actualiserStatutsSignature();

  const suivi = lignesSuivi(env)[0];
  assertEgal(suivi['Statut'], 'SIGNE', 'statut final');
  assert(String(suivi['Termine_Le']).length > 0, 'date de finalisation renseignée');
  assertContient(rapport.rapport, 'SIGNE', 'rapport lisible');

  const noms = fichiersDrive(env);
  assert(noms.some((n) => /_Bail_DUPONT_Signe\.pdf$/.test(n)), 'bail signé archivé : ' + noms);
  assert(noms.some((n) => /_Etat-des-lieux-entree_DUPONT_Signe\.pdf$/.test(n)),
    'EDL signé archivé : ' + noms);
  assert(noms.some((n) => /_Certificat-signature_DUPONT\.pdf$/.test(n)), 'certificat archivé');
  assert(noms.some((n) => /_Journal-signature_DUPONT\.pdf$/.test(n)), 'journal d\'audit archivé');
  assert(noms.some((n) => /_Bail_DUPONT_Original\.pdf$/.test(n)), 'PDF original conservé');
  assertContient(suivi['Fichiers_Signes'], '_Signe.pdf', 'fichiers listés dans le suivi');
});

test('suivi : archivage non rejoué pour une demande déjà finalisée', () => {
  const env = harness.creerEnvironnement();
  env.urlFetch.setRouteur(routeur({}));
  env.ctx.envoyerDemandeSignature(2, 'BAIL');

  env.urlFetch.setRouteur(routeur({
    get: () => ({ code: 200, corps: enveloppe('COMPLETED', {
      signes: ['bailleur@example.com', 'marie.dupont@example.com'] }) })
  }));
  env.ctx.actualiserStatutsSignature();
  const apresPremier = fichiersDrive(env).length;

  const res = env.ctx.actualiserStatutsSignature();
  assertEgal(res.traitees, 0, 'demande finalisée : plus suivie');
  assertEgal(fichiersDrive(env).length, apresPremier, 'aucun fichier dupliqué');
});

test('certificat indisponible : les documents signés sont quand même archivés', () => {
  const env = harness.creerEnvironnement();
  env.urlFetch.setRouteur(routeur({}));
  env.ctx.envoyerDemandeSignature(2, 'BAIL');

  env.urlFetch.setRouteur(routeur({
    get: () => ({ code: 200, corps: enveloppe('COMPLETED', {
      signes: ['bailleur@example.com', 'marie.dupont@example.com'] }) }),
    certificat: { code: 404, corps: { message: 'Not found' } },
    audit: { code: 404, corps: { message: 'Not found' } }
  }));
  env.ctx.actualiserStatutsSignature();

  const suivi = lignesSuivi(env)[0];
  assertEgal(suivi['Statut'], 'SIGNE', 'statut final atteint malgré le certificat manquant');
  assert(fichiersDrive(env).some((n) => /_Signe\.pdf$/.test(n)), 'document signé archivé');
  assertContient(suivi['Derniere_Erreur'], 'Certificat', 'avertissement conservé');
});

test('refus d\'un signataire : statut REFUSE, plus de suivi', () => {
  const env = harness.creerEnvironnement();
  env.urlFetch.setRouteur(routeur({}));
  env.ctx.envoyerDemandeSignature(2, 'BAIL');

  env.urlFetch.setRouteur(routeur({ get: () => ({ code: 200, corps: enveloppe('REJECTED') }) }));
  env.ctx.actualiserStatutsSignature();

  const suivi = lignesSuivi(env)[0];
  assertEgal(suivi['Statut'], 'REFUSE', 'statut REFUSE');
  assertEgal(env.ctx.actualiserStatutsSignature().traitees, 0, 'statut terminal : plus interrogé');
});

test('annulation : enveloppe annulée côté Documenso et suivi mis à jour', () => {
  const env = harness.creerEnvironnement();
  env.urlFetch.setRouteur(routeur({}));
  const res = env.ctx.envoyerDemandeSignature(2, 'BAIL');

  const annul = env.ctx.annulerDemandeSignature(res.externalId, 'Erreur de saisie');
  assertEgal(annul.ok, true, 'annulation réussie');
  assertEgal(lignesSuivi(env)[0]['Statut'], 'ANNULE', 'statut ANNULE');
  assertEgal(
    env.urlFetch.appels().filter((a) => a.url.indexOf('/envelope/delete') !== -1).length, 1,
    'appel d\'annulation émis');

  assertLeve(() => env.ctx.annulerDemandeSignature(res.externalId),
    'déjà finalisée', 'double annulation refusée');
});

test('après annulation, un nouvel envoi est possible avec un identifiant distinct', () => {
  const env = harness.creerEnvironnement();
  env.urlFetch.setRouteur(routeur({}));
  const premier = env.ctx.envoyerDemandeSignature(2, 'BAIL');
  env.ctx.annulerDemandeSignature(premier.externalId);

  const second = env.ctx.envoyerDemandeSignature(2, 'BAIL');
  assert(second.externalId !== premier.externalId, 'identifiant externe distinct');
  assertContient(second.externalId, '-t2', 'suffixe de tentative');
  assertEgal(lignesSuivi(env).length, 2, 'deux lignes de suivi');
});

// ---------------------------------------------------------------------------
// TESTS — DRY_RUN
// ---------------------------------------------------------------------------

test('DRY_RUN : PDF générés, payload construit, rien n\'est envoyé', () => {
  const env = harness.creerEnvironnement();
  env.urlFetch.setRouteur(routeur({}));

  const res = env.ctx.envoyerDemandeSignature(2, 'BAIL_EDL', { dryRun: true });
  assertEgal(res.dryRun, true, 'mode test');
  assertEgal(env.urlFetch.appels().length, 0, 'aucun appel HTTP');
  assertEgal(lignesSuivi(env).length, 0, 'aucune trace bloquante créée');
  assertEgal(res.payload.recipients.length, 2, 'signataires dans le payload');
  assertEgal(res.payload.files.length, 2, 'deux fichiers dans le payload');
  assertContient(res.payload.recipients[1].email, '***', 'email masqué dans le récapitulatif');
  assertEgal(res.documents[0].placeholders.length, 6, 'placeholders détectés (2 signataires × 3)');
  assert(fichiersDrive(env).some((n) => /_DRYRUN\.pdf$/.test(n)), 'PDF de test généré');

  // Un envoi réel reste possible après un test
  const reel = env.ctx.envoyerDemandeSignature(2, 'BAIL_EDL');
  assertEgal(reel.dryRun, false, 'envoi réel non bloqué par le test');
});

test('DRY_RUN forcé par propriété de script', () => {
  const env = harness.creerEnvironnement({ proprietes: { DOCUMENSO_DRY_RUN: 'true' } });
  env.urlFetch.setRouteur(routeur({}));

  const res = env.ctx.envoyerDemandeSignature(2, 'BAIL');
  assertEgal(res.dryRun, true, 'DRY_RUN global appliqué');
  assertEgal(env.urlFetch.appels().length, 0, 'aucun appel HTTP');
});

// ---------------------------------------------------------------------------
// TESTS — client HTTP
// ---------------------------------------------------------------------------

test('le token n\'apparaît jamais dans les messages d\'erreur', () => {
  const env = harness.creerEnvironnement({ proprietes: { DOCUMENSO_API_TOKEN: 'api_secret_xyz' } });
  env.urlFetch.setRouteur(routeur({
    create: { code: 400, corps: { message: 'Bad request for marie.dupont@example.com' } }
  }));

  const err = assertLeve(() => env.ctx.envoyerDemandeSignature(2, 'BAIL'), null, 'erreur levée');
  assert(err.message.indexOf('api_secret_xyz') === -1, 'token absent du message');
  assert(err.message.indexOf('marie.dupont@example.com') === -1, 'email complet masqué');
  assertContient(err.message, 'm***@example.com', 'email masqué mais lisible');

  const suivi = lignesSuivi(env)[0];
  assert(String(suivi['Derniere_Erreur']).indexOf('api_secret_xyz') === -1,
    'token absent du Sheet de suivi');
});

test('en-tête d\'authentification et URL de base configurables', () => {
  const env = harness.creerEnvironnement({
    proprietes: { DOCUMENSO_BASE_URL: 'https://documenso.interne.test/api/v2' }
  });
  env.urlFetch.setRouteur(routeur({}));
  env.ctx.envoyerDemandeSignature(2, 'BAIL');

  const appel = env.urlFetch.appels()[0];
  assertContient(appel.url, 'https://documenso.interne.test/api/v2/envelope/create', 'URL de base');
  assertEgal(appel.params.headers.Authorization, 'api_token_de_test', 'token brut, sans Bearer');

  const env2 = harness.creerEnvironnement({ proprietes: { DOCUMENSO_AUTH_SCHEME: 'bearer' } });
  env2.urlFetch.setRouteur(routeur({}));
  env2.ctx.envoyerDemandeSignature(2, 'BAIL');
  assertEgal(env2.urlFetch.appels()[0].params.headers.Authorization,
    'Bearer api_token_de_test', 'schéma bearer respecté');
});

test('endpoint surchargeable par propriété de script', () => {
  const env = harness.creerEnvironnement({
    proprietes: { DOCUMENSO_ENDPOINT_ENVELOPEDELETE: '/envelope/cancel' }
  });
  env.urlFetch.setRouteur((url) => {
    if (url.indexOf('/envelope/create') !== -1) return { code: 200, corps: { envelopeId: 'env_test_1' } };
    if (url.indexOf('/envelope/distribute') !== -1) return { code: 200, corps: {} };
    if (url.indexOf('/envelope/cancel') !== -1) return { code: 200, corps: { success: true } };
    if (url.indexOf('/envelope/delete') !== -1) throw new Error('chemin par défaut utilisé à tort');
    return { code: 200, corps: enveloppe('DRAFT') };
  });

  const res = env.ctx.envoyerDemandeSignature(2, 'BAIL');
  env.ctx.annulerDemandeSignature(res.externalId);
  assert(env.urlFetch.appels().some((a) => a.url.indexOf('/envelope/cancel') !== -1),
    'chemin surchargé utilisé');
});

test('téléchargement via URL signée (réponse JSON) pris en charge', () => {
  const env = harness.creerEnvironnement();
  env.urlFetch.setRouteur(routeur({}));
  env.ctx.envoyerDemandeSignature(2, 'BAIL');

  env.urlFetch.setRouteur((url, params) => {
    if (url.indexOf('/item/') !== -1 && url.indexOf('/download') !== -1) {
      return { code: 200, corps: { downloadUrl: 'https://stockage.test/signe.pdf' } };
    }
    if (url.indexOf('stockage.test') !== -1) {
      assertEgal(params.headers.Authorization, undefined, 'pas de token sur l\'URL signée');
      return { code: 200, corps: '%PDF-signe', headers: { 'Content-Type': 'application/pdf' } };
    }
    if (url.indexOf('/certificate/') !== -1 || url.indexOf('/audit-log/') !== -1) {
      return { code: 404, corps: {} };
    }
    return { code: 200, corps: enveloppe('COMPLETED', {
      signes: ['bailleur@example.com', 'marie.dupont@example.com'] }) };
  });
  env.ctx.actualiserStatutsSignature();

  assertEgal(lignesSuivi(env)[0]['Statut'], 'SIGNE', 'finalisation réussie');
  assert(fichiersDrive(env).some((n) => /_Signe\.pdf$/.test(n)), 'document signé archivé');
});

// ---------------------------------------------------------------------------
// TESTS — web app
// ---------------------------------------------------------------------------

test('web app : métadonnées sans divulgation du token', () => {
  const env = harness.creerEnvironnement();
  const meta = env.ctx.webGetSignatureMeta();
  assertEgal(meta.tokenConfigure, true, 'présence du token signalée');
  assertEgal(JSON.stringify(meta).indexOf('api_token_de_test'), -1, 'token non divulgué');
  assertEgal(meta.jeux.length, 3, 'trois jeux de documents proposés');
  assertEgal(meta.bailleurSigne, true, 'convention bailleur remontée');
});

test('web app : récapitulatif complet avant confirmation', () => {
  const env = harness.creerEnvironnement();
  const pre = env.ctx.webPreparerSignature(2, 'BAIL_EDL');

  assertEgal(pre.ok, true, 'aucun blocage');
  assertContient(pre.recap.logement, 'chambre n°2', 'logement');
  assertEgal(pre.recap.documents.length, 2, 'documents listés');
  assertEgal(pre.recap.enveloppeUnique, true, 'enveloppe unique signalée');
  assertEgal(pre.recap.signataires.length, 2, 'signataires listés');
  assertContient(pre.recap.signataires[1].libelle, 'marie.dupont@example.com', 'email affiché');
  assertContient(pre.recap.ordre, 'Parallèle', 'ordre de signature affiché');
  assertEgal(env.urlFetch.appels().length, 0, 'la préparation n\'appelle pas l\'API');
});

test('web app : envoi et statut du locataire mis à jour', () => {
  const env = harness.creerEnvironnement();
  env.urlFetch.setRouteur(routeur({}));

  const res = env.ctx.webEnvoyerSignature(2, 'BAIL', false);
  assertEgal(res.ok, true, 'envoi réussi');
  assertEgal(res.envelopeId, 'env_test_1', 'identifiant remonté à l\'UI');
  assertContient(res.message, 'Identifiant de suivi', 'lien/identifiant de suivi communiqué');

  const locataires = env.onglets.get('Locataires');
  const entetes = locataires.valeurs[0];
  const colStatut = entetes.indexOf('Signature_Statut');
  assertEgal(locataires.valeurs[1][colStatut], 'EN_ATTENTE_SIGNATURE', 'statut reflété sur la ligne');

  const historique = env.ctx.webGetSignaturesLocataire(2);
  assertEgal(historique.length, 1, 'historique disponible');
  assertEgal(historique[0].statut, 'EN_ATTENTE_SIGNATURE', 'statut dans l\'historique');
});

test('jeu de documents inconnu : erreur explicite', () => {
  const env = harness.creerEnvironnement();
  assertLeve(() => env.ctx.webPreparerSignature(2, 'CONTRAT'),
    'Jeu de documents inconnu', 'valeur refusée');
});

// ---------------------------------------------------------------------------
// TESTS — non-régression du code existant
// ---------------------------------------------------------------------------

test('non-régression : generateLeaseDoc inchangé après extraction', () => {
  const env = harness.creerEnvironnement();
  const ctx = env.ctx;
  const tenant = ctx.getTenantByRow(2);
  const res = ctx.generateLeaseDoc(tenant, ctx.getConfig(), ctx.getChambreData(2));

  const texte = res.pdfFile.getBlob().getDataAsString();
  assertContient(texte, 'DUPONT Marie', 'nom du locataire remplacé');
  assertContient(texte, '560,00 €', 'loyer CC formaté');
  assertContient(texte, 'Jean MARTIN', 'bailleur remplacé');
  assert(texte.indexOf('{{') === -1 || texte.indexOf('[[SIGNATURES') !== -1,
    'variables remplacées');
  assertContient(res.pdfFile.getName(), 'Bail_DUPONT_Marie_Chambre2', 'nom de fichier historique');
});

test('non-régression : generateEDL conserve la chambre du locataire', () => {
  const env = harness.creerEnvironnement();
  const ctx = env.ctx;
  const res = ctx.generateEDL(ctx.getTenantByRow(2), ctx.getConfig());

  const texte = res.pdfFile.getBlob().getDataAsString();
  assertContient(texte, 'Mobilier chambre 2', 'chambre conservée');
  assert(texte.indexOf('Mobilier chambre 1') === -1, 'chambre 1 supprimée');
  assert(texte.indexOf('Mobilier chambre 3') === -1, 'chambre 3 supprimée');
  assert(res.docId, 'le Google Doc EDL est conservé');
});

// ---------------------------------------------------------------------------
// Exécution
// ---------------------------------------------------------------------------

console.log('\n── Contrôle de syntaxe des fichiers .gs ──');
const erreursSyntaxe = harness.verifierSyntaxe();
if (erreursSyntaxe.length) {
  erreursSyntaxe.forEach((e) => console.log('  ✗ ' + e));
  console.log('\n✗ Syntaxe invalide — arrêt.\n');
  process.exit(1);
}
console.log('  ✓ ' + harness.TOUS_LES_GS.length + ' fichiers .gs syntaxiquement valides');

console.log('\n── Tests ──');
tests.forEach(({ nom, fn }) => {
  if (filtre && nom.toLowerCase().indexOf(filtre) === -1) return;
  try {
    fn();
    reussites++;
    console.log('  ✓ ' + nom);
  } catch (e) {
    echecs++;
    console.log('  ✗ ' + nom);
    console.log('      ' + String(e.message).split('\n').join('\n      '));
  }
});

console.log('\n' + (echecs === 0 ? '✓' : '✗') + ' ' + reussites + ' réussi(s), ' + echecs + ' échec(s)\n');
process.exit(echecs === 0 ? 0 : 1);
