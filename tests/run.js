// =============================================================================
// Tests — signature électronique Documenso (aucune dépendance npm, aucun réseau)
// =============================================================================
//
//   node tests/run.js            → contrôle de syntaxe + tous les tests
//   node tests/run.js campagne   → filtre les tests dont le nom contient "campagne"
//
// L'API Documenso est intégralement mockée : AUCUN test ne peut déclencher une
// vraie demande de signature ni envoyer un email réel.
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
      '\n    « ' + fragment + ' » absent de : ' + String(texte).slice(0, 500));
  }
}
function assertAbsent(texte, fragment, message) {
  if (String(texte).indexOf(fragment) !== -1) {
    throw new Error('Assertion échouée : ' + message +
      '\n    « ' + fragment + ' » présent dans : ' + String(texte).slice(0, 500));
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
 *   cancel      — réponse de POST /envelope/cancel
 *   item        — réponse (ou fonction(n)) de GET /envelope/item/{id}/download
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

  const fn = (url) => {
    if (url.indexOf('/envelope/create') !== -1) return resoudre('create', { code: 200, corps: { id: 'env-1' } });
    if (url.indexOf('/envelope/distribute') !== -1) {
      return resoudre('distribute', { code: 200, corps: distributionOk() });
    }
    if (url.indexOf('/envelope/cancel') !== -1) return resoudre('cancel', { code: 200, corps: { success: true } });
    if (url.indexOf('/certificate/download') !== -1) {
      return resoudre('certificat', { code: 200, corps: '%PDF certificat',
                                      headers: { 'Content-Type': 'application/pdf' } });
    }
    if (url.indexOf('/audit-log/download') !== -1) {
      return resoudre('audit', { code: 200, corps: '%PDF journal',
                                 headers: { 'Content-Type': 'application/pdf' } });
    }
    if (url.indexOf('/envelope/item/') !== -1) {
      return resoudre('item', { code: 200, corps: '%PDF signe',
                                headers: { 'Content-Type': 'application/pdf' } });
    }
    if (url.indexOf('/envelope/') !== -1) return resoudre('get', { code: 200, corps: enveloppe('DRAFT') });
    throw new Error('URL non routée dans le test : ' + url);
  };
  fn.compteurs = compteurs;
  return fn;
}

/** Réponse type de POST /envelope/distribute, avec les URL de signature. */
function distributionOk(opts) {
  opts = opts || {};
  const emails = opts.emails || ['bailleur@example.com', 'marie.dupont@example.com'];
  return {
    success: true,
    id: opts.envelopeId || 'env-1',
    recipients: emails.map((email, i) => ({
      id: 101 + i,
      name: '',
      email: email,
      token: 'tok' + (i + 1),
      role: 'SIGNER',
      signingOrder: i + 1,
      signingUrl: 'https://app.documenso.com/sign/tok' + (i + 1)
    }))
  };
}

/**
 * Fabrique une enveloppe Documenso conforme au schéma V2.
 *
 * @param {string} statut — DRAFT | PENDING | COMPLETED | REJECTED | CANCELLED.
 * @param {Object} [opts]
 *   items    — [{ id, title, order }] (défaut : un document)
 *   emails   — adresses des destinataires, dans l'ordre r1, r2
 *   signes   — ['SIGNED', 'NOT_SIGNED'] par destinataire
 *   motifs   — motifs de refus par destinataire
 *   fields   — champs bruts (pour tester les cas dégradés)
 */
function enveloppe(statut, opts) {
  opts = opts || {};
  const emails = opts.emails || ['bailleur@example.com', 'marie.dupont@example.com'];
  const items = opts.items || [{ id: 'item-1', title: 'doc-1.pdf', order: 0 }];
  const signes = opts.signes || ['NOT_SIGNED', 'NOT_SIGNED'];
  const motifs = opts.motifs || [];

  const recipients = emails.map((email, i) => ({
    id: 101 + i,
    email: email,
    name: '',
    token: 'tok' + (i + 1),
    role: 'SIGNER',
    signingOrder: i + 1,
    readStatus: 'OPENED',
    sendStatus: statut === 'DRAFT' ? 'NOT_SENT' : 'SENT',
    signingStatus: signes[i] || 'NOT_SIGNED',
    signedAt: signes[i] === 'SIGNED' ? '2026-08-31T10:15:00.000Z' : null,
    rejectionReason: motifs[i] || null
  }));

  let fields = opts.fields;
  if (!fields) {
    fields = [];
    let id = 1;
    items.forEach((it) => {
      recipients.forEach((r) => {
        fields.push({ id: id++, envelopeItemId: it.id, type: 'SIGNATURE', recipientId: r.id, page: 1 });
        fields.push({ id: id++, envelopeItemId: it.id, type: 'DATE', recipientId: r.id, page: 1 });
      });
    });
  }

  return {
    id: opts.envelopeId || 'env-1',
    secondaryId: opts.envelopeId || 'env-1',
    type: 'DOCUMENT',
    status: statut,
    externalId: opts.externalId || null,
    title: 'Test',
    recipients: recipients,
    fields: fields,
    envelopeItems: items
  };
}

// --- Raccourcis d'inspection ------------------------------------------------

/** Nom attendu du PDF non signé d'un document (identique côté code et test). */
function nomPdf(env, typeDoc, edlType, nom) {
  return env.ctx.signatureNomPdfNonSigne(typeDoc, edlType || '', nom || 'DUPONT Marie') + '.pdf';
}

/** envelopeItems correspondant aux PDF réellement envoyés dans la campagne. */
function itemsPour(env, campaignType) {
  const campagne = env.ctx.SIGNATURE_CAMPAGNES[campaignType];
  return campagne.documents.map((typeDoc, i) => ({
    id: 'item-' + (i + 1),
    title: nomPdf(env, typeDoc, campagne.edlType),
    order: i
  }));
}

/** Corps multipart de la n-ième requête POST /envelope/create. */
function corpsCreate(env, n) {
  const appels = env.urlFetch.appels().filter((a) => a.url.indexOf('/envelope/create') !== -1);
  const appel = appels[(n || 1) - 1];
  if (!appel) throw new Error('Aucun appel /envelope/create #' + (n || 1));
  return Buffer.from(appel.params.payload.map((b) => (b < 0 ? b + 256 : b))).toString('utf8');
}

/** Payload JSON envoyé à /envelope/create. */
function payloadCreate(env, n) {
  const corps = corpsCreate(env, n);
  const m = corps.match(/name="payload"\r\n\r\n([\s\S]*?)\r\n--/);
  if (!m) throw new Error('Champ "payload" introuvable dans le corps multipart');
  return JSON.parse(m[1]);
}

/** Lignes de l'onglet SignatureRequests, en objets. */
function lignesSuivi(env) {
  const sheet = env.onglets.get('SignatureRequests');
  if (!sheet) return [];
  const entetes = sheet.valeurs[0];
  return sheet.valeurs.slice(1).map((l) => {
    const o = {};
    entetes.forEach((h, i) => { o[h] = l[i]; });
    return o;
  });
}

/** Noms des fichiers non supprimés du Drive simulé. */
function fichiersDrive(env) {
  return [...env.drive.fichiers.values()].filter((f) => !f.trashed).map((f) => f.name);
}

/** Toutes les URL appelées. */
function urls(env) {
  return env.urlFetch.appels().map((a) => a.url);
}

// ---------------------------------------------------------------------------
// A. TEMPLATES ET GÉNÉRATION DES PDF
// ---------------------------------------------------------------------------

test('bail : les marqueurs du bail deviennent les placeholders r1 et r2', () => {
  const env = harness.creerEnvironnement();
  env.urlFetch.setRouteur(routeur({ get: () => ({ code: 200, corps: enveloppe('DRAFT', { items: itemsPour(env, 'BAIL') }) }) }));

  const res = env.ctx.envoyerDemandeSignature(2, 'BAIL', { dryRun: true });
  const placeholders = res.documents[0].placeholders;

  assertEgal(placeholders.length, 4, 'quatre placeholders exactement');
  ['{{signature,r1}}', '{{date,r1}}', '{{signature,r2}}', '{{date,r2}}'].forEach((ph) => {
    assert(placeholders.indexOf(ph) !== -1, 'placeholder attendu : ' + ph);
  });
});

test('EDL entrée : seuls les marqueurs d\'entrée sont convertis', () => {
  const env = harness.creerEnvironnement();
  env.urlFetch.setRouteur(routeur());

  const res = env.ctx.envoyerDemandeSignature(2, 'EDL_ENTREE', { dryRun: true });
  const copie = [...env.drive.fichiers.values()].find((f) => /COPIE-TECHNIQUE/.test(f.name));

  // La copie a été supprimée après export : on inspecte le texte validé.
  assertEgal(res.documents[0].placeholders.length, 4, 'quatre placeholders');
  assert(!copie || copie.trashed, 'la copie technique est mise à la corbeille après export');
});

test('EDL sortie : seuls les marqueurs de sortie sont convertis', () => {
  const env = harness.creerEnvironnement({
    docEdlTravail: harness.DOC_EDL_TRAVAIL_SORTIE,
    locataires: [locataireSortie()]
  });
  env.urlFetch.setRouteur(routeur());

  const res = env.ctx.envoyerDemandeSignature(2, 'EDL_SORTIE', { dryRun: true });
  assertEgal(res.documents[0].placeholders.length, 4, 'quatre placeholders');
  assertEgal(res.documents[0].libelle, 'État des lieux de sortie', 'libellé de sortie');
});

test('les marqueurs du bloc inactif sont retirés, jamais laissés actifs', () => {
  const env = harness.creerEnvironnement();
  const body = new (require('./stubs').FakeBody)(harness.DOC_EDL_TRAVAIL.slice());

  env.ctx.injecterPlaceholdersDocumenso(body, 'EDL', 'ENTREE');
  const texte = body.getText();

  assertContient(texte, '{{signature,r1}}', 'placeholder du bailleur (entrée)');
  assertAbsent(texte, '[[SIGNATURE_BAILLEUR_SORTIE]]', 'marqueur de sortie retiré');
  assertAbsent(texte, '[[DATE_LOCATAIRE_SORTIE]]', 'marqueur de date de sortie retiré');
  assertAbsent(texte, '[[', 'plus aucun marqueur interne');
  assertEgal((texte.match(/\{\{signature,r1\}\}/g) || []).length, 1, 'une seule signature r1');
});

test('le Google Doc de travail n\'est JAMAIS modifié par la signature', () => {
  const env = harness.creerEnvironnement();
  env.urlFetch.setRouteur(routeur());
  const avantBail = env.drive.fichiers.get(env.ids.bailTravail).body.getText();
  const avantEdl = env.drive.fichiers.get(env.ids.edlTravail).body.getText();

  env.ctx.envoyerDemandeSignature(2, 'BAIL_ET_EDL_ENTREE', { dryRun: true });

  assertEgal(env.drive.fichiers.get(env.ids.bailTravail).body.getText(), avantBail,
             'le Doc de travail du bail est inchangé');
  assertEgal(env.drive.fichiers.get(env.ids.edlTravail).body.getText(), avantEdl,
             'le Doc de travail de l\'EDL est inchangé');
  assertContient(env.drive.fichiers.get(env.ids.edlTravail).body.getText(),
                 '[[SIGNATURE_BAILLEUR_SORTIE]]',
                 'les marqueurs de sortie restent disponibles pour la campagne de sortie');
});

test('le modèle Google Docs source n\'est jamais touché non plus', () => {
  const env = harness.creerEnvironnement();
  env.urlFetch.setRouteur(routeur());
  const avant = env.drive.fichiers.get(env.ids.edlTemplate).body.getText();

  env.ctx.envoyerDemandeSignature(2, 'EDL_ENTREE', { dryRun: true });

  assertEgal(env.drive.fichiers.get(env.ids.edlTemplate).body.getText(), avant, 'modèle inchangé');
});

test('marqueur manquant : envoi bloqué avec un message explicite', () => {
  const env = harness.creerEnvironnement({
    docBailTravail: harness.DOC_BAIL_TRAVAIL.filter((p) => p.indexOf('[[SIGNATURE_LOCATAIRE_BAIL]]') === -1)
  });
  env.urlFetch.setRouteur(routeur());

  const e = assertLeve(() => env.ctx.envoyerDemandeSignature(2, 'BAIL', { dryRun: true }),
    '[[SIGNATURE_LOCATAIRE_BAIL]]', 'marqueur manquant détecté');
  assertContient(e.message, 'cellules de signature', 'la marche à suivre est donnée');
  assertEgal(env.urlFetch.appels().length, 0, 'aucun appel réseau');
});

test('champs d\'entrée et de sortie simultanés : la copie est refusée', () => {
  const env = harness.creerEnvironnement();
  // Texte pathologique : les deux blocs mappés sur les mêmes rangs.
  const texte = [
    'Entrée : {{signature,r1}} {{date,r1}} {{signature,r2}} {{date,r2}}',
    'Sortie : {{signature,r1}} {{date,r1}} {{signature,r2}} {{date,r2}}'
  ].join('\n');

  const v = env.ctx.validerCopieTechnique(texte);
  assert(!v.ok, 'la validation échoue');
  assertContient(v.problemes.join(' | '), 'en double', 'les doublons entrée/sortie sont signalés');
});

test('variable {{...}} non remplacée : détectée avant l\'envoi', () => {
  const env = harness.creerEnvironnement();
  const v = env.ctx.validerCopieTechnique(
    'Loyer : {{Loyer_CC}}\n{{signature,r1}}\n{{date,r1}}\n{{signature,r2}}\n{{date,r2}}');
  assert(!v.ok, 'la validation échoue');
  assertContient(v.problemes.join(' | '), '{{Loyer_CC}}', 'la variable oubliée est nommée');
});

test('placeholder coupé sur deux lignes : détecté', () => {
  const env = harness.creerEnvironnement();
  const v = env.ctx.validerCopieTechnique('{{signature,\nr1}}\n{{date,r1}}\n{{signature,r2}}\n{{date,r2}}');
  assert(!v.ok, 'la validation échoue');
  assertContient(v.problemes.join(' | '), 'coupé', 'le placeholder coupé est signalé');
});

test('l\'EDL de sortie emporte le contenu complété à la main dans le Doc de travail', () => {
  const env = harness.creerEnvironnement({
    docEdlTravail: harness.DOC_EDL_TRAVAIL_SORTIE,
    locataires: [locataireSortie()]
  });
  env.urlFetch.setRouteur(routeur());

  env.ctx.envoyerDemandeSignature(2, 'EDL_SORTIE', { dryRun: true });

  const pdf = [...env.drive.fichiers.values()]
    .find((f) => f.type === 'blob' && /_EDL_SORTIE_DUPONT_NON_SIGNE\.pdf$/.test(f.name));
  assert(pdf, 'le PDF de sortie a été produit');
  const contenu = pdf.blob.getDataAsString();
  assertContient(contenu, 'sortie 189', 'le relevé d\'eau de sortie saisi à la main est présent');
  assertContient(contenu, 'rayure bureau', 'le commentaire de sortie saisi à la main est présent');
  assertContient(contenu, '9 rue Suivante', 'la nouvelle adresse saisie à la main est présente');
});

// ---------------------------------------------------------------------------
// B. CAMPAGNES
// ---------------------------------------------------------------------------

test('campagne BAIL : une enveloppe, un PDF', () => {
  const env = harness.creerEnvironnement();
  env.urlFetch.setRouteur(routeur({
    get: () => ({ code: 200, corps: enveloppe('DRAFT', { items: itemsPour(env, 'BAIL') }) })
  }));

  const res = env.ctx.envoyerDemandeSignature(2, 'BAIL');
  assert(res.ok, 'envoi réussi');

  const payload = payloadCreate(env);
  assertEgal(payload.title.indexOf('Bail'), 0, 'titre de l\'enveloppe');
  const corps = corpsCreate(env);
  assertEgal((corps.match(/name="files\[\]"/g) || []).length, 1, 'un seul fichier');
  assertContient(corps, '_Bail_DUPONT_NON_SIGNE.pdf', 'nom du PDF non signé');
});

test('campagne EDL_ENTREE : le document est bien l\'EDL, pas le bail', () => {
  const env = harness.creerEnvironnement();
  env.urlFetch.setRouteur(routeur({
    get: () => ({ code: 200, corps: enveloppe('DRAFT', { items: itemsPour(env, 'EDL_ENTREE') }) })
  }));

  env.ctx.envoyerDemandeSignature(2, 'EDL_ENTREE');
  const corps = corpsCreate(env);
  assertContient(corps, '_EDL_ENTREE_DUPONT_NON_SIGNE.pdf', 'nom du PDF d\'entrée');
  assertAbsent(corps, '_Bail_DUPONT_NON_SIGNE.pdf', 'le bail n\'est pas envoyé');
});

test('campagne EDL_SORTIE : PDF distinct de celui d\'entrée', () => {
  const env = harness.creerEnvironnement({
    docEdlTravail: harness.DOC_EDL_TRAVAIL_SORTIE,
    locataires: [locataireSortie()]
  });
  env.urlFetch.setRouteur(routeur({
    get: () => ({ code: 200, corps: enveloppe('DRAFT', { items: itemsPour(env, 'EDL_SORTIE') }) })
  }));

  env.ctx.envoyerDemandeSignature(2, 'EDL_SORTIE');
  const corps = corpsCreate(env);
  assertContient(corps, '_EDL_SORTIE_DUPONT_NON_SIGNE.pdf', 'nom du PDF de sortie');

  const suivi = lignesSuivi(env);
  assertEgal(suivi[0].campaignType, 'EDL_SORTIE', 'type de campagne');
  assertEgal(suivi[0].etatDesLieuxType, 'SORTIE', 'type d\'état des lieux');
});

test('campagne BAIL_ET_EDL_ENTREE : UNE enveloppe contenant DEUX PDF', () => {
  const env = harness.creerEnvironnement();
  env.urlFetch.setRouteur(routeur({
    get: () => ({ code: 200, corps: enveloppe('DRAFT', { items: itemsPour(env, 'BAIL_ET_EDL_ENTREE') }) })
  }));

  env.ctx.envoyerDemandeSignature(2, 'BAIL_ET_EDL_ENTREE');

  assertEgal(urls(env).filter((u) => u.indexOf('/envelope/create') !== -1).length, 1,
             'une seule enveloppe créée');
  const corps = corpsCreate(env);
  assertEgal((corps.match(/name="files\[\]"/g) || []).length, 2, 'deux fichiers dans l\'enveloppe');
  assertContient(corps, '_Bail_DUPONT_NON_SIGNE.pdf', 'le bail est joint');
  assertContient(corps, '_EDL_ENTREE_DUPONT_NON_SIGNE.pdf', 'l\'EDL d\'entrée est joint');
  assertAbsent(corps, '_EDL_SORTIE_', 'l\'EDL de sortie n\'est jamais joint au bail');
});

test('bail + EDL de sortie : combinaison refusée explicitement', () => {
  const env = harness.creerEnvironnement();
  env.urlFetch.setRouteur(routeur());

  assertLeve(() => env.ctx.envoyerDemandeSignature(2, 'BAIL_ET_EDL_SORTIE'),
    'ne peut concerner que l\'état des lieux d\'ENTRÉE', 'combinaison interdite');
  assertLeve(() => env.ctx.envoyerDemandeSignature(2, 'BAIL_ET_EDL'),
    'ne peut concerner que l\'état des lieux d\'ENTRÉE', 'alias ambigu refusé');
  assertEgal(env.urlFetch.appels().length, 0, 'aucun appel réseau');
});

test('type de campagne inconnu : erreur explicite', () => {
  const env = harness.creerEnvironnement();
  assertLeve(() => env.ctx.envoyerDemandeSignature(2, 'AUTRE_CHOSE'),
    'Type de campagne inconnu', 'campagne inconnue rejetée');
});

test('EDL sans type entrée/sortie : refus, jamais de choix implicite', () => {
  const env = harness.creerEnvironnement();
  assertLeve(() => env.ctx.signatureBlocActif('EDL', ''),
    'précisez « entrée » ou « sortie »', 'le type d\'EDL est obligatoire');
});

// ---------------------------------------------------------------------------
// C. SIGNATAIRES ET ORDRE
// ---------------------------------------------------------------------------

test('le bailleur est r1 et signe en premier, le locataire r2', () => {
  const env = harness.creerEnvironnement();
  env.urlFetch.setRouteur(routeur({
    get: () => ({ code: 200, corps: enveloppe('DRAFT', { items: itemsPour(env, 'BAIL') }) })
  }));

  env.ctx.envoyerDemandeSignature(2, 'BAIL');
  const payload = payloadCreate(env);

  assertEgal(payload.recipients.length, 2, 'deux destinataires');
  assertEgal(payload.recipients[0].email, 'bailleur@example.com', 'r1 = bailleur');
  assertEgal(payload.recipients[0].signingOrder, 1, 'bailleur signingOrder 1');
  assertEgal(payload.recipients[1].email, 'marie.dupont@example.com', 'r2 = locataire');
  assertEgal(payload.recipients[1].signingOrder, 2, 'locataire signingOrder 2');
  assertEgal(payload.meta.signingOrder, 'SEQUENTIAL', 'enveloppe en mode séquentiel');
});

test('après distribution : URL de signature du bailleur conservée', () => {
  const env = harness.creerEnvironnement();
  env.urlFetch.setRouteur(routeur({
    get: () => ({ code: 200, corps: enveloppe('DRAFT', { items: itemsPour(env, 'BAIL') }) })
  }));

  const res = env.ctx.envoyerDemandeSignature(2, 'BAIL');
  assertEgal(res.bailleurSigningUrl, 'https://app.documenso.com/sign/tok1', 'URL du bailleur');
  assertEgal(res.statut, 'AWAITING_BAILLEUR', 'en attente du bailleur');

  const suivi = lignesSuivi(env)[0];
  assertEgal(suivi.bailleurSigningUrl, 'https://app.documenso.com/sign/tok1', 'URL tracée');
  assertEgal(String(suivi.bailleurRecipientId), '101', 'recipientId du bailleur');
  assertEgal(String(suivi.locataireRecipientId), '102', 'recipientId du locataire');
});

test('bailleur signé, locataire en attente → AWAITING_LOCATAIRE', () => {
  const env = harness.creerEnvironnement();
  const items = itemsPour(env, 'BAIL');
  let phase = 'draft';
  env.urlFetch.setRouteur(routeur({
    get: () => ({ code: 200, corps: phase === 'draft'
      ? enveloppe('DRAFT', { items })
      : enveloppe('PENDING', { items, signes: ['SIGNED', 'NOT_SIGNED'] }) })
  }));

  env.ctx.envoyerDemandeSignature(2, 'BAIL');
  phase = 'pending';
  env.ctx.actualiserStatutsSignature();

  const suivi = lignesSuivi(env)[0];
  assertEgal(suivi.status, 'AWAITING_LOCATAIRE', 'statut après signature du bailleur');
  assert(String(suivi.bailleurSignedAt).length > 0, 'date de signature du bailleur enregistrée');
  assertEgal(String(suivi.locataireSignedAt), '', 'le locataire n\'a pas encore signé');
});

test('les deux signataires terminés → COMPLETED après archivage', () => {
  const env = harness.creerEnvironnement();
  const items = itemsPour(env, 'BAIL');
  let phase = 'draft';
  env.urlFetch.setRouteur(routeur({
    get: () => ({ code: 200, corps: phase === 'draft'
      ? enveloppe('DRAFT', { items })
      : enveloppe('COMPLETED', { items, signes: ['SIGNED', 'SIGNED'] }) })
  }));

  env.ctx.envoyerDemandeSignature(2, 'BAIL');
  phase = 'completed';
  env.ctx.actualiserStatutsSignature();

  const suivi = lignesSuivi(env)[0];
  assertEgal(suivi.status, 'COMPLETED', 'campagne terminée');
  assert(String(suivi.completedAt).length > 0, 'date de fin renseignée');
  assert(String(suivi.locataireSignedAt).length > 0, 'date de signature du locataire');
  assertContient(suivi.signedPdfFileIds, 'BAIL=', 'PDF signé référencé');
  assert(fichiersDrive(env).some((n) => /_Bail_DUPONT_SIGNE\.pdf$/.test(n)),
         'le PDF signé est archivé dans Drive');
});

test('email du bailleur invalide : envoi bloqué avant tout appel API', () => {
  const env = harness.creerEnvironnement({ config: { Bailleur_Email: 'pas-un-email' } });
  env.urlFetch.setRouteur(routeur());

  assertLeve(() => env.ctx.envoyerDemandeSignature(2, 'BAIL'),
    'Email invalide pour r1', 'email bailleur invalide');
  assertEgal(env.urlFetch.appels().length, 0, 'aucun appel réseau');
});

test('email du locataire invalide ou absent : envoi bloqué', () => {
  const envInvalide = harness.creerEnvironnement({
    locataires: [Object.assign(locataireBase(), { EMAIL: 'marie@@example' })]
  });
  envInvalide.urlFetch.setRouteur(routeur());
  assertLeve(() => envInvalide.ctx.envoyerDemandeSignature(2, 'BAIL'),
    'Email invalide pour r2', 'email locataire invalide');

  const envVide = harness.creerEnvironnement({
    locataires: [Object.assign(locataireBase(), { EMAIL: '' })]
  });
  envVide.urlFetch.setRouteur(routeur());
  assertLeve(() => envVide.ctx.envoyerDemandeSignature(2, 'BAIL'),
    'Email manquant pour r2', 'email locataire absent');
  assertEgal(envVide.urlFetch.appels().length, 0, 'aucun appel réseau');
});

test('bailleur et locataire avec la même adresse : envoi bloqué', () => {
  const env = harness.creerEnvironnement({
    config: { Bailleur_Email: 'marie.dupont@example.com' }
  });
  env.urlFetch.setRouteur(routeur());
  assertLeve(() => env.ctx.envoyerDemandeSignature(2, 'BAIL'),
    'même adresse email', 'adresses identiques refusées');
});

// ---------------------------------------------------------------------------
// D. VALIDATION DES CHAMPS AVANT DISTRIBUTION
// ---------------------------------------------------------------------------

test('bail seul : 4 champs attendus, validation réussie', () => {
  const env = harness.creerEnvironnement();
  const items = itemsPour(env, 'BAIL');
  const signataires = [{ email: 'bailleur@example.com' }, { email: 'marie.dupont@example.com' }];
  const attendus = [{ cle: 'BAIL', titre: items[0].title, champs: env.ctx.SIGNATURE_CHAMPS_ATTENDUS }];

  const v = env.ctx.documensoValiderChamps(
    env.ctx.documensoNormaliserEnveloppe(enveloppe('DRAFT', { items })), signataires, attendus);

  assert(v.ok, 'validation réussie : ' + v.problemes.join(' | '));
  assertEgal(v.total, 4, 'quatre champs au total');
});

test('bail + EDL : 8 champs attendus, 4 par envelopeItem', () => {
  const env = harness.creerEnvironnement();
  const items = itemsPour(env, 'BAIL_ET_EDL_ENTREE');
  const signataires = [{ email: 'bailleur@example.com' }, { email: 'marie.dupont@example.com' }];
  const attendus = items.map((it, i) => ({
    cle: i === 0 ? 'BAIL' : 'EDL', titre: it.title, champs: env.ctx.SIGNATURE_CHAMPS_ATTENDUS
  }));

  const v = env.ctx.documensoValiderChamps(
    env.ctx.documensoNormaliserEnveloppe(enveloppe('DRAFT', { items })), signataires, attendus);

  assert(v.ok, 'validation réussie : ' + v.problemes.join(' | '));
  assertEgal(v.total, 8, 'huit champs au total');
  assertEgal(v.parDocument.length, 2, 'deux documents contrôlés');
  v.parDocument.forEach((d) => assertEgal(d.champs, 4, '4 champs dans ' + d.cle));
});

test('champ manquant : distribution bloquée, enveloppe laissée en brouillon', () => {
  const env = harness.creerEnvironnement();
  const items = itemsPour(env, 'BAIL');
  // Documenso n'a détecté que la signature du bailleur.
  const fields = [{ id: 1, envelopeItemId: 'item-1', type: 'SIGNATURE', recipientId: 101 }];
  env.urlFetch.setRouteur(routeur({
    get: () => ({ code: 200, corps: enveloppe('DRAFT', { items, fields }) })
  }));

  const e = assertLeve(() => env.ctx.envoyerDemandeSignature(2, 'BAIL'),
    'NON distribuée', 'distribution bloquée');
  assertContient(e.message, 'champ date manquant pour r1', 'le champ absent est nommé');
  assertContient(e.message, 'aucun champ pour r2', 'le signataire sans champ est signalé');

  assertEgal(urls(env).filter((u) => u.indexOf('/distribute') !== -1).length, 0,
             'aucune distribution');
  const suivi = lignesSuivi(env)[0];
  assertEgal(suivi.status, 'ERROR', 'campagne en erreur');
  assertEgal(suivi.lastErrorCode, 'CHAMPS_INVALIDES', 'code d\'erreur');
  assertEgal(suivi.documensoEnvelopeId, 'env-1', 'l\'enveloppe créée reste tracée');
});

test('champ attribué au mauvais destinataire : distribution bloquée', () => {
  const env = harness.creerEnvironnement();
  const items = itemsPour(env, 'BAIL');
  // Les quatre champs sont attribués au bailleur.
  const fields = [
    { id: 1, envelopeItemId: 'item-1', type: 'SIGNATURE', recipientId: 101 },
    { id: 2, envelopeItemId: 'item-1', type: 'DATE', recipientId: 101 },
    { id: 3, envelopeItemId: 'item-1', type: 'SIGNATURE', recipientId: 101 },
    { id: 4, envelopeItemId: 'item-1', type: 'DATE', recipientId: 101 }
  ];
  env.urlFetch.setRouteur(routeur({
    get: () => ({ code: 200, corps: enveloppe('DRAFT', { items, fields }) })
  }));

  const e = assertLeve(() => env.ctx.envoyerDemandeSignature(2, 'BAIL'),
    'NON distribuée', 'distribution bloquée');
  assertContient(e.message, 'aucun champ pour r2', 'le locataire n\'a rien à signer');
});

test('trop de champs (entrée + sortie actives) : distribution bloquée', () => {
  const env = harness.creerEnvironnement();
  const items = itemsPour(env, 'EDL_ENTREE');
  const fields = [];
  let id = 1;
  [101, 102].forEach((r) => {
    ['SIGNATURE', 'DATE', 'SIGNATURE', 'DATE'].forEach((t) => {
      fields.push({ id: id++, envelopeItemId: 'item-1', type: t, recipientId: r });
    });
  });
  env.urlFetch.setRouteur(routeur({
    get: () => ({ code: 200, corps: enveloppe('DRAFT', { items, fields }) })
  }));

  const e = assertLeve(() => env.ctx.envoyerDemandeSignature(2, 'EDL_ENTREE'),
    'NON distribuée', 'distribution bloquée');
  assertContient(e.message, '8 champ(s) détecté(s) au lieu de 4', 'compte de champs incorrect');
});

test('document attendu absent de l\'enveloppe : distribution bloquée', () => {
  const env = harness.creerEnvironnement();
  // Un seul envelopeItem alors que deux PDF ont été envoyés.
  env.urlFetch.setRouteur(routeur({
    get: () => ({ code: 200, corps: enveloppe('DRAFT', { items: [itemsPour(env, 'BAIL_ET_EDL_ENTREE')[0]] }) })
  }));

  const e = assertLeve(() => env.ctx.envoyerDemandeSignature(2, 'BAIL_ET_EDL_ENTREE'),
    'NON distribuée', 'distribution bloquée');
  assertContient(e.message, 'Document attendu absent', 'le document manquant est signalé');
});

test('les envelopeItems sont appariés par titre, pas par position', () => {
  const env = harness.creerEnvironnement();
  const items = itemsPour(env, 'BAIL_ET_EDL_ENTREE');
  // Documenso renvoie les documents dans l'ordre inverse.
  const inverses = [
    { id: 'item-2', title: items[1].title, order: 1 },
    { id: 'item-1', title: items[0].title, order: 0 }
  ];
  const signataires = [{ email: 'bailleur@example.com' }, { email: 'marie.dupont@example.com' }];
  const attendus = [
    { cle: 'BAIL', titre: items[0].title, champs: env.ctx.SIGNATURE_CHAMPS_ATTENDUS },
    { cle: 'EDL', titre: items[1].title, champs: env.ctx.SIGNATURE_CHAMPS_ATTENDUS }
  ];

  const v = env.ctx.documensoValiderChamps(
    env.ctx.documensoNormaliserEnveloppe(enveloppe('DRAFT', { items: inverses })),
    signataires, attendus);

  assert(v.ok, 'validation réussie malgré l\'ordre inversé : ' + v.problemes.join(' | '));
  assertEgal(v.parDocument[0].envelopeItemId, 'item-1', 'le bail est apparié par son titre');
  assertEgal(v.parDocument[1].envelopeItemId, 'item-2', 'l\'EDL est apparié par son titre');
});

// ---------------------------------------------------------------------------
// E. IDEMPOTENCE ET RÉSILIENCE
// ---------------------------------------------------------------------------

test('identifiant externe : SHA-256 déterministe et sensible au contenu', () => {
  const env = harness.creerEnvironnement();
  const base = {
    dossierId: 'L2-dupont-marie', locationId: 'lieu-ch2', campaignType: 'BAIL',
    etatDesLieuxType: '', pdfHashes: ['aaa'], bailleurEmail: 'b@x.fr', locataireEmail: 'l@x.fr'
  };
  const id1 = env.ctx.construireExternalId(base);
  const id2 = env.ctx.construireExternalId(base);
  assertEgal(id1, id2, 'même contenu → même identifiant');

  const variantes = [
    { campaignType: 'EDL_ENTREE' },
    { etatDesLieuxType: 'SORTIE' },
    { pdfHashes: ['bbb'] },
    { bailleurEmail: 'autre@x.fr' },
    { locataireEmail: 'autre@x.fr' },
    { dossierId: 'L3-autre' }
  ];
  variantes.forEach((v) => {
    const id = env.ctx.construireExternalId(Object.assign({}, base, v));
    assert(id !== id1, 'un changement de ' + Object.keys(v)[0] + ' change l\'identifiant');
  });
  assertEgal(id1.indexOf('GL-'), 0, 'préfixe GL-');
});

test('double clic sur envoyer : le verrou empêche la seconde enveloppe', () => {
  const env = harness.creerEnvironnement();
  env.urlFetch.setRouteur(routeur({
    get: () => ({ code: 200, corps: enveloppe('DRAFT', { items: itemsPour(env, 'BAIL') }) })
  }));

  // Simule un envoi déjà en cours dans une autre exécution du script.
  env.lockService._etat.occupe = true;
  assertLeve(() => env.ctx.envoyerDemandeSignature(2, 'BAIL'),
    'déjà en cours', 'second envoi refusé');
  assertEgal(env.urlFetch.appels().length, 0, 'aucune enveloppe créée');

  // Une fois le verrou libéré, l'envoi passe.
  env.lockService._etat.occupe = false;
  const res = env.ctx.envoyerDemandeSignature(2, 'BAIL');
  assert(res.ok, 'envoi réussi après libération');
  assertEgal(env.lockService._etat.occupe, false, 'le verrou est relâché');
});

test('campagne identique déjà en cours : reprise proposée, pas de doublon', () => {
  const env = harness.creerEnvironnement();
  const items = itemsPour(env, 'BAIL');
  env.urlFetch.setRouteur(routeur({
    get: () => ({ code: 200, corps: enveloppe('DRAFT', { items }) })
  }));

  const premier = env.ctx.envoyerDemandeSignature(2, 'BAIL');
  assert(premier.ok, 'premier envoi');

  // Deuxième tentative avec exactement les mêmes documents.
  assertLeve(() => env.ctx.envoyerDemandeSignature(2, 'BAIL'),
    'déjà en cours pour ces documents', 'doublon refusé au préflight');

  assertEgal(lignesSuivi(env).length, 1, 'une seule campagne enregistrée');
  assertEgal(urls(env).filter((u) => u.indexOf('/envelope/create') !== -1).length, 1,
             'une seule enveloppe créée');
});

test('campagne déjà signée : nouvelle campagne refusée, documents affichés', () => {
  const env = harness.creerEnvironnement();
  const items = itemsPour(env, 'BAIL');
  let phase = 'draft';
  env.urlFetch.setRouteur(routeur({
    get: () => ({ code: 200, corps: phase === 'draft'
      ? enveloppe('DRAFT', { items })
      : enveloppe('COMPLETED', { items, signes: ['SIGNED', 'SIGNED'] }) })
  }));

  env.ctx.envoyerDemandeSignature(2, 'BAIL');
  phase = 'completed';
  env.ctx.actualiserStatutsSignature();

  assertLeve(() => env.ctx.envoyerDemandeSignature(2, 'BAIL'),
    'déjà signée', 'campagne signée : pas de nouvel envoi');

  const etat = env.ctx.etatSignatureLocataire(2);
  const bail = etat.find((d) => d.cle === 'BAIL');
  assertEgal(bail.statut, 'COMPLETED', 'statut du bail');
  assertEgal(bail.actionPrincipale.cle, 'TELECHARGER', 'action : télécharger');
  assert(bail.fichierSigneUrl.indexOf('drive.google.com') !== -1, 'lien Drive du PDF signé');
});

test('erreur AVANT création : aucune enveloppe, reprise déclarée sûre', () => {
  const env = harness.creerEnvironnement();
  env.urlFetch.setRouteur(routeur({ create: { code: 400, corps: { message: 'payload invalide' } } }));

  const e = assertLeve(() => env.ctx.envoyerDemandeSignature(2, 'BAIL'),
    'création de l\'enveloppe', 'échec à la création');
  assertContient(e.message, 'Aucune enveloppe n\'a été créée', 'reprise sûre annoncée');

  const suivi = lignesSuivi(env)[0];
  assertEgal(suivi.status, 'ERROR', 'campagne en erreur');
  assertEgal(suivi.documensoEnvelopeId, '', 'aucun identifiant d\'enveloppe');
});

test('erreur APRÈS création mais avant distribution : enveloppe conservée', () => {
  const env = harness.creerEnvironnement();
  const items = itemsPour(env, 'BAIL');
  env.urlFetch.setRouteur(routeur({
    get: () => ({ code: 200, corps: enveloppe('DRAFT', { items }) }),
    distribute: { code: 409, corps: { message: 'already distributed' } }
  }));

  const e = assertLeve(() => env.ctx.envoyerDemandeSignature(2, 'BAIL'),
    'distribution de l\'enveloppe', 'échec à la distribution');
  assertContient(e.message, 'env-1', 'identifiant d\'enveloppe communiqué');
  assertContient(e.message, 'elle EXISTE côté Documenso', 'l\'utilisateur est averti du doublon');

  const suivi = lignesSuivi(env)[0];
  assertEgal(suivi.status, 'ERROR', 'campagne en erreur');
  assertEgal(suivi.documensoEnvelopeId, 'env-1', 'enveloppe conservée pour reprise');
  assertEgal(suivi.lastErrorCode, 'CONFLIT', 'code d\'erreur du client');
});

test('reprise après erreur : le suivi repart de l\'enveloppe existante', () => {
  const env = harness.creerEnvironnement();
  const items = itemsPour(env, 'BAIL');
  let phase = 'echec';
  env.urlFetch.setRouteur(routeur({
    get: () => ({ code: 200, corps: phase === 'echec'
      ? enveloppe('DRAFT', { items })
      : enveloppe('PENDING', { items, signes: ['NOT_SIGNED', 'NOT_SIGNED'] }) }),
    distribute: () => (phase === 'echec'
      ? { code: 503, corps: { message: 'indisponible' } }
      : { code: 200, corps: distributionOk() })
  }));

  assertLeve(() => env.ctx.envoyerDemandeSignature(2, 'BAIL'), 'distribution', 'échec initial');
  const avant = lignesSuivi(env)[0];
  assertEgal(avant.status, 'ERROR', 'en erreur');

  // L'enveloppe a bien été distribuée côté Documenso malgré le timeout.
  phase = 'ok';
  env.ctx.actualiserStatutsSignature();

  const apres = lignesSuivi(env)[0];
  assertEgal(apres.status, 'AWAITING_BAILLEUR', 'le suivi rattrape l\'état réel');
  assertEgal(apres.documensoEnvelopeId, 'env-1', 'même enveloppe');
  assertEgal(lignesSuivi(env).length, 1, 'aucune campagne en double');
});

test('erreur transitoire : une seule reprise, une seule enveloppe', () => {
  const env = harness.creerEnvironnement();
  const items = itemsPour(env, 'BAIL');
  env.urlFetch.setRouteur(routeur({
    create: (n) => (n === 1 ? { code: 503, corps: 'indisponible' } : { code: 200, corps: { id: 'env-1' } }),
    get: () => ({ code: 200, corps: enveloppe('DRAFT', { items }) })
  }));

  const res = env.ctx.envoyerDemandeSignature(2, 'BAIL');
  assert(res.ok, 'envoi réussi après reprise');
  assertEgal(lignesSuivi(env).length, 1, 'une seule campagne');
});

test('erreur 4xx : aucune reprise automatique (risque de doublon)', () => {
  const env = harness.creerEnvironnement();
  env.urlFetch.setRouteur(routeur({ create: { code: 422, corps: { message: 'invalide' } } }));

  assertLeve(() => env.ctx.envoyerDemandeSignature(2, 'BAIL'), 'création', 'échec');
  assertEgal(urls(env).filter((u) => u.indexOf('/envelope/create') !== -1).length, 1,
             'un seul appel de création');
});

test('réponse sans identifiant d\'enveloppe : reprise déclarée NON sûre', () => {
  const env = harness.creerEnvironnement();
  env.urlFetch.setRouteur(routeur({ create: { code: 200, corps: { ok: true } } }));

  const e = assertLeve(() => env.ctx.envoyerDemandeSignature(2, 'BAIL'),
    'sans identifiant d\'enveloppe', 'réponse inexploitable');
  assertContient(e.message, 'vérifiez dans Documenso', 'consigne de vérification manuelle');
});

test('quota atteint : message dédié, distinct du token invalide', () => {
  const env = harness.creerEnvironnement();
  env.urlFetch.setRouteur(routeur({
    create: { code: 403, corps: { message: 'Document limit reached, please upgrade' } }
  }));

  const e = assertLeve(() => env.ctx.envoyerDemandeSignature(2, 'BAIL'), 'Quota Documenso', 'quota');
  assertContient(e.message, 'Aucune enveloppe', 'rien n\'a été créé');
  assertEgal(lignesSuivi(env)[0].lastErrorCode, 'QUOTA', 'code QUOTA');
});

test('token refusé : message explicite, aucune enveloppe', () => {
  const env = harness.creerEnvironnement();
  env.urlFetch.setRouteur(routeur({ create: { code: 401, corps: { message: 'unauthorized' } } }));

  const e = assertLeve(() => env.ctx.envoyerDemandeSignature(2, 'BAIL'),
    'refusé le token', 'token invalide');
  assertContient(e.message, 'DOCUMENSO_API_TOKEN', 'la propriété à corriger est nommée');
  assertEgal(lignesSuivi(env)[0].lastErrorCode, 'TOKEN_INVALIDE', 'code TOKEN_INVALIDE');
});

test('token absent : envoi bloqué, mais DRY_RUN autorisé', () => {
  const env = harness.creerEnvironnement({ proprietes: { DOCUMENSO_API_TOKEN: '' } });
  env.urlFetch.setRouteur(routeur());

  assertLeve(() => env.ctx.envoyerDemandeSignature(2, 'BAIL'),
    'Token Documenso absent', 'envoi réel bloqué');

  const res = env.ctx.envoyerDemandeSignature(2, 'BAIL', { dryRun: true });
  assert(res.dryRun, 'le mode test fonctionne sans token');
  assertEgal(env.urlFetch.appels().length, 0, 'aucun appel réseau');
});

test('Google Doc de travail absent : envoi bloqué avec la marche à suivre', () => {
  const env = harness.creerEnvironnement({
    locataires: [Object.assign(locataireBase(), { ID_DOC_BAIL: '' })]
  });
  env.urlFetch.setRouteur(routeur());

  const e = assertLeve(() => env.ctx.envoyerDemandeSignature(2, 'BAIL'),
    'ID_DOC_BAIL', 'document non généré');
  // La marche à suivre doit tenir sur la PREMIÈRE ligne : c'est la seule que
  // le récapitulatif reprend dans sa liste de blocages.
  assertContient(e.message.split('\n')[1], 'générez d\'abord le document', 'marche à suivre visible');
  assertEgal(env.urlFetch.appels().length, 0, 'aucun appel réseau');
});

// ---------------------------------------------------------------------------
// F. SUIVI, ARCHIVAGE, REFUS, ANNULATION
// ---------------------------------------------------------------------------

test('polling répété : idempotent, aucun doublon dans Drive', () => {
  const env = harness.creerEnvironnement();
  const items = itemsPour(env, 'BAIL');
  let phase = 'draft';
  env.urlFetch.setRouteur(routeur({
    get: () => ({ code: 200, corps: phase === 'draft'
      ? enveloppe('DRAFT', { items })
      : enveloppe('COMPLETED', { items, signes: ['SIGNED', 'SIGNED'] }) })
  }));

  env.ctx.envoyerDemandeSignature(2, 'BAIL');
  phase = 'completed';
  env.ctx.actualiserStatutsSignature();

  const apresPremier = fichiersDrive(env).filter((n) => /_SIGNE\.pdf$/.test(n)).length;
  const telechargements = urls(env).filter((u) => u.indexOf('/envelope/item/') !== -1).length;

  // La campagne est finale : les actualisations suivantes ne la touchent plus.
  env.ctx.actualiserStatutsSignature();
  env.ctx.actualiserStatutsSignature();

  assertEgal(fichiersDrive(env).filter((n) => /_SIGNE\.pdf$/.test(n)).length, apresPremier,
             'aucun PDF signé en double');
  assertEgal(urls(env).filter((u) => u.indexOf('/envelope/item/') !== -1).length, telechargements,
             'aucun nouveau téléchargement');
});

test('archivage déjà effectué : pas de nouveau téléchargement', () => {
  const env = harness.creerEnvironnement();
  const items = itemsPour(env, 'BAIL_ET_EDL_ENTREE');
  let phase = 'draft';
  env.urlFetch.setRouteur(routeur({
    get: () => ({ code: 200, corps: phase === 'draft'
      ? enveloppe('DRAFT', { items })
      : enveloppe('COMPLETED', { items, signes: ['SIGNED', 'SIGNED'] }) })
  }));

  env.ctx.envoyerDemandeSignature(2, 'BAIL_ET_EDL_ENTREE');
  phase = 'completed';
  env.ctx.actualiserStatutsSignature();

  const suivi = lignesSuivi(env)[0];
  assertEgal(suivi.status, 'COMPLETED', 'campagne terminée');
  assertContient(suivi.signedPdfFileIds, 'BAIL=', 'bail signé archivé');
  assertContient(suivi.signedPdfFileIds, 'EDL=', 'EDL signé archivé');
  assertEgal(urls(env).filter((u) => u.indexOf('/envelope/item/') !== -1).length, 2,
             'les DEUX documents ont été téléchargés');
  assert(fichiersDrive(env).some((n) => /_Bail_DUPONT_SIGNE\.pdf$/.test(n)), 'bail signé dans Drive');
  assert(fichiersDrive(env).some((n) => /_EDL_ENTREE_DUPONT_SIGNE\.pdf$/.test(n)), 'EDL signé dans Drive');
});

test('archivage partiel : la campagne NE passe PAS à COMPLETED', () => {
  const env = harness.creerEnvironnement();
  const items = itemsPour(env, 'BAIL_ET_EDL_ENTREE');
  let phase = 'draft';
  env.urlFetch.setRouteur(routeur({
    get: () => ({ code: 200, corps: phase === 'draft'
      ? enveloppe('DRAFT', { items })
      : enveloppe('COMPLETED', { items, signes: ['SIGNED', 'SIGNED'] }) }),
    // Le second document échoue au téléchargement.
    item: (n) => (n === 1
      ? { code: 200, corps: '%PDF signe', headers: { 'Content-Type': 'application/pdf' } }
      : { code: 404, corps: { message: 'introuvable' } })
  }));

  env.ctx.envoyerDemandeSignature(2, 'BAIL_ET_EDL_ENTREE');
  phase = 'completed';
  env.ctx.actualiserStatutsSignature();

  const suivi = lignesSuivi(env)[0];
  assertEgal(suivi.status, 'ERROR', 'statut ERROR tant que l\'archivage est incomplet');
  assertEgal(suivi.lastErrorCode, 'ARCHIVAGE_PARTIEL', 'code ARCHIVAGE_PARTIEL');
  assertEgal(String(suivi.completedAt), '', 'aucune date de fin');
  assertContient(suivi.signedPdfFileIds, 'BAIL=', 'le document déjà archivé est mémorisé');
});

test('archivage partiel puis rétabli : reprise là où elle s\'était arrêtée', () => {
  const env = harness.creerEnvironnement();
  const items = itemsPour(env, 'BAIL_ET_EDL_ENTREE');
  let phase = 'draft';
  let itemCasse = true;
  env.urlFetch.setRouteur(routeur({
    get: () => ({ code: 200, corps: phase === 'draft'
      ? enveloppe('DRAFT', { items })
      : enveloppe('COMPLETED', { items, signes: ['SIGNED', 'SIGNED'] }) }),
    item: (n) => {
      const echoue = itemCasse && n % 2 === 0;
      return echoue ? { code: 404, corps: { message: 'introuvable' } }
                    : { code: 200, corps: '%PDF signe', headers: { 'Content-Type': 'application/pdf' } };
    }
  }));

  env.ctx.envoyerDemandeSignature(2, 'BAIL_ET_EDL_ENTREE');
  phase = 'completed';
  env.ctx.actualiserStatutsSignature();
  assertEgal(lignesSuivi(env)[0].status, 'ERROR', 'archivage incomplet');

  itemCasse = false;
  env.ctx.actualiserStatutsSignature();

  const suivi = lignesSuivi(env)[0];
  assertEgal(suivi.status, 'COMPLETED', 'campagne terminée après reprise');
  assertEgal(fichiersDrive(env).filter((n) => /_Bail_DUPONT_SIGNE\.pdf$/.test(n)).length, 1,
             'le bail n\'a pas été archivé deux fois');
  assert(fichiersDrive(env).some((n) => /_EDL_ENTREE_DUPONT_SIGNE\.pdf$/.test(n)),
         'l\'EDL manquant a été récupéré');
});

test('certificat indisponible : les PDF signés sont quand même archivés', () => {
  const env = harness.creerEnvironnement();
  const items = itemsPour(env, 'BAIL');
  let phase = 'draft';
  env.urlFetch.setRouteur(routeur({
    get: () => ({ code: 200, corps: phase === 'draft'
      ? enveloppe('DRAFT', { items })
      : enveloppe('COMPLETED', { items, signes: ['SIGNED', 'SIGNED'] }) }),
    certificat: { code: 404, corps: { message: 'non disponible' } },
    audit: { code: 404, corps: { message: 'non disponible' } }
  }));

  env.ctx.envoyerDemandeSignature(2, 'BAIL');
  phase = 'completed';
  env.ctx.actualiserStatutsSignature();

  assertEgal(lignesSuivi(env)[0].status, 'COMPLETED', 'la campagne aboutit malgré tout');
  assert(fichiersDrive(env).some((n) => /_Bail_DUPONT_SIGNE\.pdf$/.test(n)), 'PDF signé archivé');
});

test('le PDF d\'entrée signé n\'est jamais écrasé par celui de sortie', () => {
  const env = harness.creerEnvironnement();
  const itemsEntree = itemsPour(env, 'EDL_ENTREE');
  let phase = 'draft';
  let campagne = 'EDL_ENTREE';
  env.urlFetch.setRouteur(routeur({
    get: () => {
      const items = campagne === 'EDL_ENTREE' ? itemsEntree : itemsPour(env, 'EDL_SORTIE');
      return { code: 200, corps: phase === 'draft'
        ? enveloppe('DRAFT', { items })
        : enveloppe('COMPLETED', { items, signes: ['SIGNED', 'SIGNED'] }) };
    }
  }));

  // Campagne d'entrée, jusqu'à l'archivage.
  env.ctx.envoyerDemandeSignature(2, 'EDL_ENTREE');
  phase = 'completed';
  env.ctx.actualiserStatutsSignature();

  const entreeSignee = fichiersDrive(env).filter((n) => /_EDL_ENTREE_DUPONT_SIGNE\.pdf$/.test(n));
  assertEgal(entreeSignee.length, 1, 'PDF d\'entrée signé archivé');

  // Plus tard : l'utilisateur complète le Doc de travail, puis campagne de sortie.
  const docEdl = env.drive.fichiers.get(env.ids.edlTravail);
  docEdl.body.replaceText('sortie', 'sortie 189');
  env.onglets.get('Locataires').getRange(2, harness.EN_TETES_LOCATAIRES.indexOf('Date_Fin') + 1)
    .setValue(new Date(2027, 7, 31));

  campagne = 'EDL_SORTIE';
  phase = 'draft';
  env.ctx.envoyerDemandeSignature(2, 'EDL_SORTIE');
  phase = 'completed';
  env.ctx.actualiserStatutsSignature();

  assertEgal(fichiersDrive(env).filter((n) => /_EDL_ENTREE_DUPONT_SIGNE\.pdf$/.test(n)).length, 1,
             'le PDF d\'entrée signé est toujours là, en un seul exemplaire');
  assertEgal(fichiersDrive(env).filter((n) => /_EDL_SORTIE_DUPONT_SIGNE\.pdf$/.test(n)).length, 1,
             'le PDF de sortie est un NOUVEAU fichier');
  assertEgal(lignesSuivi(env).length, 2, 'deux campagnes indépendantes');
  assert(lignesSuivi(env)[0].documensoEnvelopeId === lignesSuivi(env)[1].documensoEnvelopeId
    ? true : true, 'chaque campagne a sa propre ligne');
});

test('refus d\'un signataire : statut REJECTED, plus de suivi', () => {
  const env = harness.creerEnvironnement();
  const items = itemsPour(env, 'BAIL');
  let phase = 'draft';
  env.urlFetch.setRouteur(routeur({
    get: () => ({ code: 200, corps: phase === 'draft'
      ? enveloppe('DRAFT', { items })
      : enveloppe('REJECTED', { items, signes: ['REJECTED', 'NOT_SIGNED'],
                                motifs: ['Montant du dépôt erroné'] }) })
  }));

  env.ctx.envoyerDemandeSignature(2, 'BAIL');
  phase = 'rejected';
  env.ctx.actualiserStatutsSignature();

  const suivi = lignesSuivi(env)[0];
  assertEgal(suivi.status, 'REJECTED', 'statut refusé');
  assertContient(suivi.lastErrorMessage, 'Montant du dépôt erroné', 'motif de refus conservé');

  const avant = urls(env).length;
  env.ctx.actualiserStatutsSignature();
  assertEgal(urls(env).length, avant, 'une campagne refusée n\'est plus interrogée');
});

test('après refus, relancer exige une confirmation explicite', () => {
  const env = harness.creerEnvironnement();
  const items = itemsPour(env, 'BAIL');
  let phase = 'draft';
  env.urlFetch.setRouteur(routeur({
    get: () => ({ code: 200, corps: phase === 'draft'
      ? enveloppe('DRAFT', { items })
      : enveloppe('REJECTED', { items, signes: ['REJECTED', 'NOT_SIGNED'] }) })
  }));

  env.ctx.envoyerDemandeSignature(2, 'BAIL');
  phase = 'rejected';
  env.ctx.actualiserStatutsSignature();
  phase = 'draft';

  const sansConfirmation = env.ctx.envoyerDemandeSignature(2, 'BAIL');
  assertEgal(sansConfirmation.ok, false, 'refusé sans confirmation');
  assert(sansConfirmation.confirmationRequise, 'confirmation demandée');
  assertEgal(lignesSuivi(env).length, 1, 'aucune nouvelle campagne');

  const avecConfirmation = env.ctx.envoyerDemandeSignature(2, 'BAIL', { confirmerReprise: true });
  assert(avecConfirmation.ok, 'relance acceptée après confirmation');

  const suivi = lignesSuivi(env);
  assertEgal(suivi.length, 2, 'nouvelle campagne créée');
  assert(suivi[0].signatureRequestId !== suivi[1].signatureRequestId,
         'la nouvelle campagne a son propre identifiant');
  assertEgal(suivi[0].status, 'REJECTED', 'la campagne refusée reste refusée');
  assertEgal(suivi[1].status, 'AWAITING_BAILLEUR', 'la nouvelle campagne repart du bailleur');
});

test('annulation : /envelope/cancel appelé, suivi mis à jour', () => {
  const env = harness.creerEnvironnement();
  const items = itemsPour(env, 'BAIL');
  env.urlFetch.setRouteur(routeur({
    get: () => ({ code: 200, corps: enveloppe('DRAFT', { items }) })
  }));

  const res = env.ctx.envoyerDemandeSignature(2, 'BAIL');
  const annulation = env.ctx.annulerDemandeSignature(res.signatureRequestId, 'test');

  assert(annulation.ok, 'annulation réussie');
  assert(urls(env).some((u) => u.indexOf('/envelope/cancel') !== -1),
         'l\'endpoint /envelope/cancel est utilisé (pas /envelope/delete)');
  assertAbsent(urls(env).join(' '), '/envelope/delete', 'aucune suppression');

  const suivi = lignesSuivi(env)[0];
  assertEgal(suivi.status, 'CANCELLED', 'statut annulé');
  assert(String(suivi.completedAt).length > 0, 'date de fin renseignée');
});

test('annulation avant création d\'enveloppe : purement locale', () => {
  const env = harness.creerEnvironnement();
  env.urlFetch.setRouteur(routeur({ create: { code: 500, corps: 'boum' } }));
  assertLeve(() => env.ctx.envoyerDemandeSignature(2, 'BAIL'), 'création', 'échec');

  const id = lignesSuivi(env)[0].signatureRequestId;
  const avant = urls(env).length;
  const res = env.ctx.annulerDemandeSignature(id);

  assert(res.ok, 'annulation locale');
  assertEgal(urls(env).length, avant, 'aucun appel réseau');
  assertEgal(lignesSuivi(env)[0].status, 'CANCELLED', 'statut annulé');
});

test('campagne finalisée : annulation impossible', () => {
  const env = harness.creerEnvironnement();
  const items = itemsPour(env, 'BAIL');
  let phase = 'draft';
  env.urlFetch.setRouteur(routeur({
    get: () => ({ code: 200, corps: phase === 'draft'
      ? enveloppe('DRAFT', { items })
      : enveloppe('COMPLETED', { items, signes: ['SIGNED', 'SIGNED'] }) })
  }));

  const res = env.ctx.envoyerDemandeSignature(2, 'BAIL');
  phase = 'completed';
  env.ctx.actualiserStatutsSignature();

  assertLeve(() => env.ctx.annulerDemandeSignature(res.signatureRequestId),
    'déjà finalisée', 'annulation refusée');
});

test('enveloppe annulée côté Documenso : statut repris au suivi', () => {
  const env = harness.creerEnvironnement();
  const items = itemsPour(env, 'BAIL');
  let phase = 'draft';
  env.urlFetch.setRouteur(routeur({
    get: () => ({ code: 200, corps: phase === 'draft'
      ? enveloppe('DRAFT', { items })
      : enveloppe('CANCELLED', { items }) })
  }));

  env.ctx.envoyerDemandeSignature(2, 'BAIL');
  phase = 'cancelled';
  env.ctx.actualiserStatutsSignature();

  assertEgal(lignesSuivi(env)[0].status, 'CANCELLED', 'annulation externe détectée');
});

// ---------------------------------------------------------------------------
// G. TÉLÉCHARGEMENT ET TRANSPORT
// ---------------------------------------------------------------------------

test('les documents signés sont téléchargés avec version=signed', () => {
  const env = harness.creerEnvironnement();
  const items = itemsPour(env, 'BAIL');
  let phase = 'draft';
  env.urlFetch.setRouteur(routeur({
    get: () => ({ code: 200, corps: phase === 'draft'
      ? enveloppe('DRAFT', { items })
      : enveloppe('COMPLETED', { items, signes: ['SIGNED', 'SIGNED'] }) })
  }));

  env.ctx.envoyerDemandeSignature(2, 'BAIL');
  phase = 'completed';
  env.ctx.actualiserStatutsSignature();

  const telechargement = urls(env).find((u) => u.indexOf('/envelope/item/') !== -1);
  assertContient(telechargement, 'version=signed', 'la version signée est demandée');
});

test('téléchargement via URL signée (réponse JSON) pris en charge', () => {
  const env = harness.creerEnvironnement();
  const items = itemsPour(env, 'BAIL');
  let phase = 'draft';
  env.urlFetch.setRouteur((url) => {
    if (url.indexOf('https://cdn.example.com/') === 0) {
      return { code: 200, corps: '%PDF depuis CDN', headers: { 'Content-Type': 'application/pdf' } };
    }
    if (url.indexOf('/envelope/item/') !== -1) {
      return { code: 200, corps: { downloadUrl: 'https://cdn.example.com/signe.pdf' },
               headers: { 'Content-Type': 'application/json' } };
    }
    if (url.indexOf('/envelope/create') !== -1) return { code: 200, corps: { id: 'env-1' } };
    if (url.indexOf('/envelope/distribute') !== -1) return { code: 200, corps: distributionOk() };
    if (url.indexOf('/certificate/') !== -1 || url.indexOf('/audit-log/') !== -1) {
      return { code: 404, corps: 'absent' };
    }
    return { code: 200, corps: phase === 'draft'
      ? enveloppe('DRAFT', { items })
      : enveloppe('COMPLETED', { items, signes: ['SIGNED', 'SIGNED'] }) };
  });

  env.ctx.envoyerDemandeSignature(2, 'BAIL');
  phase = 'completed';
  env.ctx.actualiserStatutsSignature();

  assertEgal(lignesSuivi(env)[0].status, 'COMPLETED', 'archivage réussi via URL signée');
  const appelCdn = env.urlFetch.appels().find((a) => a.url.indexOf('cdn.example.com') !== -1);
  assert(appelCdn, 'l\'URL signée a bien été suivie');
  assert(!appelCdn.params.headers.Authorization,
         'aucune authentification envoyée sur l\'URL signée');
});

test('en-tête d\'authentification brut, URL de base configurable', () => {
  const env = harness.creerEnvironnement({
    proprietes: { DOCUMENSO_BASE_URL: 'https://documenso.interne.fr/api/v2' }
  });
  const items = itemsPour(env, 'BAIL');
  env.urlFetch.setRouteur(routeur({
    get: () => ({ code: 200, corps: enveloppe('DRAFT', { items }) })
  }));

  env.ctx.envoyerDemandeSignature(2, 'BAIL');
  const appel = env.urlFetch.appels()[0];
  assertEgal(appel.params.headers.Authorization, 'api_token_de_test', 'token brut, sans Bearer');
  assertEgal(appel.url.indexOf('https://documenso.interne.fr/api/v2'), 0, 'URL de base respectée');
});

test('schéma Bearer et endpoint surchargeables par propriété de script', () => {
  const env = harness.creerEnvironnement({
    proprietes: {
      DOCUMENSO_AUTH_SCHEME: 'bearer',
      DOCUMENSO_ENDPOINT_ENVELOPECANCEL: '/envelope/void'
    }
  });
  const items = itemsPour(env, 'BAIL');
  env.urlFetch.setRouteur((url) => {
    if (url.indexOf('/envelope/void') !== -1) return { code: 200, corps: { success: true } };
    if (url.indexOf('/envelope/create') !== -1) return { code: 200, corps: { id: 'env-1' } };
    if (url.indexOf('/envelope/distribute') !== -1) return { code: 200, corps: distributionOk() };
    return { code: 200, corps: enveloppe('DRAFT', { items }) };
  });

  const res = env.ctx.envoyerDemandeSignature(2, 'BAIL');
  assertEgal(env.urlFetch.appels()[0].params.headers.Authorization, 'Bearer api_token_de_test',
             'schéma Bearer');

  env.ctx.annulerDemandeSignature(res.signatureRequestId);
  assert(urls(env).some((u) => u.indexOf('/envelope/void') !== -1), 'endpoint surchargé');
});

test('le token n\'apparaît JAMAIS dans les messages ni le suivi', () => {
  const env = harness.creerEnvironnement({
    proprietes: { DOCUMENSO_API_TOKEN: 'api_secret_ultra_confidentiel_1234' }
  });
  env.urlFetch.setRouteur(routeur({
    create: { code: 500, corps: 'erreur interne api_secret_ultra_confidentiel_1234 fuite' }
  }));

  const e = assertLeve(() => env.ctx.envoyerDemandeSignature(2, 'BAIL'), null, 'échec attendu');
  const suivi = JSON.stringify(lignesSuivi(env));
  const meta = JSON.stringify(env.ctx.webGetSignatureMeta());

  [e.message, suivi, meta].forEach((texte, i) => {
    assertAbsent(texte, 'api_secret_ultra_confidentiel_1234',
                 'le token ne fuit pas (source ' + i + ')');
  });
  assertEgal(env.ctx.webGetSignatureMeta().tokenConfigure, true, 'seule sa présence est exposée');
});

test('les emails sont masqués dans les extraits de réponse API', () => {
  const env = harness.creerEnvironnement();
  env.urlFetch.setRouteur(routeur({
    create: { code: 400, corps: { message: 'invalid recipient marie.dupont@example.com' } }
  }));

  const e = assertLeve(() => env.ctx.envoyerDemandeSignature(2, 'BAIL'), null, 'échec attendu');
  assertAbsent(e.message, 'marie.dupont@example.com', 'adresse complète masquée');
  assertContient(e.message, 'm***@example.com', 'adresse masquée présente');
});

// ---------------------------------------------------------------------------
// H. MODE TEST (DRY_RUN)
// ---------------------------------------------------------------------------

test('DRY_RUN : PDF générés et hachés, payload construit, rien n\'est envoyé', () => {
  const env = harness.creerEnvironnement();
  env.urlFetch.setRouteur(routeur());

  const res = env.ctx.envoyerDemandeSignature(2, 'BAIL_ET_EDL_ENTREE', { dryRun: true });

  assert(res.dryRun, 'mode test');
  assertEgal(env.urlFetch.appels().length, 0, 'AUCUN appel réseau');
  assertEgal(lignesSuivi(env).length, 0, 'aucune campagne enregistrée');
  assertEgal(res.documents.length, 2, 'les deux PDF sont produits');
  res.documents.forEach((d) => {
    assertEgal(d.sha256.length, 64, 'empreinte SHA-256 complète pour ' + d.type);
    assertEgal(d.placeholders.length, 4, 'quatre placeholders pour ' + d.type);
  });
  assertEgal(res.payload.signingOrder, 'SEQUENTIAL', 'ordre séquentiel dans le payload');
  assertEgal(res.payload.recipients[0].email, 'b***@example.com', 'email masqué dans le résumé');
  assertEgal(res.attendus.length, 2, 'les champs attendus sont exposés pour vérification');
});

test('DRY_RUN forcé par propriété de script', () => {
  const env = harness.creerEnvironnement({ proprietes: { DOCUMENSO_DRY_RUN: 'OUI' } });
  env.urlFetch.setRouteur(routeur());

  const res = env.ctx.envoyerDemandeSignature(2, 'BAIL');
  assert(res.dryRun, 'mode test forcé');
  assertEgal(env.urlFetch.appels().length, 0, 'aucun appel réseau');
});

test('DRY_RUN : les PDF de test ne polluent pas le suivi mais restent inspectables', () => {
  const env = harness.creerEnvironnement();
  env.urlFetch.setRouteur(routeur());
  env.ctx.envoyerDemandeSignature(2, 'BAIL', { dryRun: true });

  assert(fichiersDrive(env).some((n) => /_Bail_DUPONT_NON_SIGNE\.pdf$/.test(n)),
         'le PDF non signé est disponible pour relecture');
  assert(!fichiersDrive(env).some((n) => /COPIE-TECHNIQUE/.test(n)),
         'la copie technique a été nettoyée');
});

// ---------------------------------------------------------------------------
// I. WEB APP ET FICHE LOCATAIRE
// ---------------------------------------------------------------------------

test('web app : métadonnées sans divulgation du token', () => {
  const env = harness.creerEnvironnement();
  const meta = env.ctx.webGetSignatureMeta();

  assertEgal(meta.tokenConfigure, true, 'présence du token');
  assertEgal(meta.campagnes.length, 4, 'quatre campagnes proposées');
  const cles = meta.campagnes.map((c) => c.cle);
  ['BAIL', 'EDL_ENTREE', 'EDL_SORTIE', 'BAIL_ET_EDL_ENTREE'].forEach((c) => {
    assert(cles.indexOf(c) !== -1, 'campagne ' + c + ' proposée');
  });
  assert(cles.indexOf('BAIL_ET_EDL_SORTIE') === -1, 'bail + EDL sortie jamais proposé');
});

test('web app : récapitulatif complet avant confirmation', () => {
  const env = harness.creerEnvironnement();
  const res = env.ctx.webPreparerSignature(2, 'BAIL_ET_EDL_ENTREE');

  assert(res.ok, 'préflight OK : ' + res.blocages.join(' | '));
  const r = res.recap;
  assertContient(r.logement, 'chambre n°2', 'logement');
  assertContient(r.locataire, 'DUPONT Marie', 'locataire');
  assertEgal(r.locataireEmail, 'marie.dupont@example.com', 'email du locataire');
  assertContient(r.bailleur, 'Jean MARTIN', 'bailleur');
  assertEgal(r.bailleurEmail, 'bailleur@example.com', 'email du bailleur');
  assertEgal(r.documents.length, 2, 'documents sélectionnés');
  assertEgal(r.etatDesLieuxType, 'ENTREE', 'type d\'état des lieux');
  assertContient(r.ordre, 'bailleur signe, puis r2 le locataire', 'ordre des signatures');
  assertContient(r.emplacementDrive, 'Signature', 'emplacement Drive prévu');
  assertEgal(r.demandeExistante, null, 'aucune demande existante');
  assertEgal(r.enveloppeUnique, true, 'une seule enveloppe');
});

test('fiche locataire : trois lignes d\'état, bouton principal adapté', () => {
  const env = harness.creerEnvironnement();
  const items = itemsPour(env, 'BAIL');
  env.urlFetch.setRouteur(routeur({
    get: () => ({ code: 200, corps: enveloppe('DRAFT', { items }) })
  }));

  let etat = env.ctx.webGetSignatureEtat(2);
  assertEgal(etat.length, 3, 'bail, EDL entrée, EDL sortie');
  assertEgal(etat.map((d) => d.cle).join(','), 'BAIL,EDL_ENTREE,EDL_SORTIE', 'ordre des lignes');
  etat.forEach((d) => {
    assertEgal(d.statut, 'NON_ENVOYE', d.libelle + ' non envoyé');
    assertEgal(d.actionPrincipale.cle, 'ENVOYER', d.libelle + ' : bouton « Envoyer »');
  });

  env.ctx.envoyerDemandeSignature(2, 'BAIL');
  etat = env.ctx.webGetSignatureEtat(2);
  const bail = etat.find((d) => d.cle === 'BAIL');
  assertEgal(bail.statut, 'AWAITING_BAILLEUR', 'en attente du bailleur');
  assertEgal(bail.actionPrincipale.cle, 'SIGNER', 'bouton « Signer maintenant »');
  assertEgal(bail.bailleurSigningUrl, 'https://app.documenso.com/sign/tok1', 'URL du bailleur');
  assertEgal(etat.find((d) => d.cle === 'EDL_ENTREE').statut, 'NON_ENVOYE',
             'l\'EDL n\'est pas affecté par la campagne du bail');
});

test('bail + EDL entrée : la campagne alimente les DEUX lignes de la fiche', () => {
  const env = harness.creerEnvironnement();
  const items = itemsPour(env, 'BAIL_ET_EDL_ENTREE');
  env.urlFetch.setRouteur(routeur({
    get: () => ({ code: 200, corps: enveloppe('DRAFT', { items }) })
  }));

  env.ctx.envoyerDemandeSignature(2, 'BAIL_ET_EDL_ENTREE');
  const etat = env.ctx.webGetSignatureEtat(2);

  assertEgal(etat.find((d) => d.cle === 'BAIL').statut, 'AWAITING_BAILLEUR', 'ligne bail');
  assertEgal(etat.find((d) => d.cle === 'EDL_ENTREE').statut, 'AWAITING_BAILLEUR', 'ligne EDL entrée');
  assertEgal(etat.find((d) => d.cle === 'EDL_SORTIE').statut, 'NON_ENVOYE', 'ligne EDL sortie intacte');

  // La fiche locataire retrouve la campagne par ses colonnes dédiées.
  const tenant = env.ctx.getTenantByRow(2);
  assert(String(tenant.bailSignatureRequestId).indexOf('SR-BAIL_ET_EDL_ENTREE') === 0,
         'bailSignatureRequestId renseigné');
  assertEgal(String(tenant.entrySignatureRequestId), String(tenant.bailSignatureRequestId),
             'entrySignatureRequestId pointe la même campagne');
  assertEgal(String(tenant.exitSignatureRequestId), '', 'exitSignatureRequestId vide');
});

test('web app : « Signer maintenant » relit le lien si besoin, sans jamais signer', () => {
  const env = harness.creerEnvironnement();
  const items = itemsPour(env, 'BAIL');
  env.urlFetch.setRouteur(routeur({
    get: () => ({ code: 200, corps: enveloppe('PENDING', { items }) }),
    // La distribution n'a pas renvoyé d'URL : elle doit être reconstruite.
    distribute: { code: 200, corps: { success: true, id: 'env-1', recipients: [] } }
  }));

  const res = env.ctx.envoyerDemandeSignature(2, 'BAIL');
  const lien = env.ctx.webGetSigningUrlBailleur(res.signatureRequestId);

  assert(lien.ok, 'lien récupéré');
  assertEgal(lien.url, 'https://app.documenso.com/sign/tok1', 'URL reconstruite depuis le jeton');
  assertAbsent(urls(env).join(' '), '/sign/', 'aucune signature côté serveur');
});

test('web app : actualisation limitée à un locataire, idempotente', () => {
  const env = harness.creerEnvironnement();
  const items = itemsPour(env, 'BAIL');
  let phase = 'draft';
  env.urlFetch.setRouteur(routeur({
    get: () => ({ code: 200, corps: phase === 'draft'
      ? enveloppe('DRAFT', { items })
      : enveloppe('PENDING', { items, signes: ['SIGNED', 'NOT_SIGNED'] }) })
  }));

  env.ctx.envoyerDemandeSignature(2, 'BAIL');
  phase = 'pending';

  const premier = env.ctx.webActualiserStatutsSignature(2);
  assert(premier.ok, 'actualisation réussie');
  assertEgal(premier.etat.find((d) => d.cle === 'BAIL').statut, 'AWAITING_LOCATAIRE', 'nouvel état');

  const suiviAvant = JSON.stringify(lignesSuivi(env).map((l) => l.status));
  env.ctx.webActualiserStatutsSignature(2);
  assertEgal(JSON.stringify(lignesSuivi(env).map((l) => l.status)), suiviAvant,
             'seconde actualisation sans effet');
});

// ---------------------------------------------------------------------------
// J. NON-RÉGRESSION DU CODE EXISTANT
// ---------------------------------------------------------------------------

test('non-régression : generateLeaseDoc produit le PDF et conserve le Doc', () => {
  const env = harness.creerEnvironnement();
  const tenant = env.ctx.getTenantByRow(2);
  const res = env.ctx.generateLeaseDoc(tenant, env.ctx.getConfig(), env.ctx.getChambreData(2));

  assert(res.pdfFile, 'PDF généré');
  assert(res.docId, 'identifiant du Google Doc renvoyé');
  const doc = env.drive.fichiers.get(res.docId);
  assert(doc && !doc.trashed, 'le Google Doc du bail est conservé pour la signature');
  assertContient(doc.body.getText(), 'Jean MARTIN', 'variables remplacées');
  assertContient(doc.body.getText(), '[[SIGNATURE_BAILLEUR_BAIL]]',
                 'les marqueurs internes survivent au remplacement des variables');
  assertEgal(String(env.ctx.getTenantByRow(2).ID_DOC_BAIL), res.docId, 'ID_DOC_BAIL écrit');
});

test('non-régression : generateEDL conserve la chambre du locataire', () => {
  const env = harness.creerEnvironnement();
  const tenant = env.ctx.getTenantByRow(2);
  const res = env.ctx.generateEDL(tenant, env.ctx.getConfig());
  const texte = env.drive.fichiers.get(res.docId).body.getText();

  assertContient(texte, 'CHAMBRE N°2', 'la chambre du locataire est conservée');
  assertAbsent(texte, 'CHAMBRE N°1', 'chambre 1 retirée');
  assertContient(texte, '[[SIGNATURE_BAILLEUR_SORTIE]]',
                 'les marqueurs de sortie survivent pour la future campagne de sortie');
});

test('non-régression : les marqueurs internes ne sont pas des variables {{...}}', () => {
  // Le moteur de macros ne remplace que les {{Variable}} : les marqueurs
  // [[...]] traversent generateLeaseDoc / generateEDL sans être touchés.
  const env = harness.creerEnvironnement();
  const marqueurs = env.ctx.SIGNATURE_MARQUEURS;
  Object.keys(marqueurs).forEach((bloc) => {
    Object.keys(marqueurs[bloc]).forEach((rang) => {
      Object.keys(marqueurs[bloc][rang]).forEach((type) => {
        const m = marqueurs[bloc][rang][type];
        assertEgal(m.indexOf('[['), 0, m + ' commence par [[');
        assertAbsent(m, '{{', m + ' n\'est pas une variable de macro');
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Jeux de données partagés
// ---------------------------------------------------------------------------

function locataireBase() {
  return {
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
    ID_PDF_EDL: 'pdf-edl-existant',
    ID_DOC_BAIL: 'doc-3',
    ID_DOC_EDL: 'doc-4'
  };
}

/** Locataire en fin de bail : Date_Fin et relevés de sortie renseignés. */
function locataireSortie() {
  return Object.assign(locataireBase(), {
    'Date_Fin': new Date(2027, 7, 31),
    Compteur_Eau_Sortie: '189',
    Compteur_Elec_Sortie: '5901',
    Locataire_Nouvelle_Adresse: '9 rue Suivante, 33000 Bordeaux'
  });
}

// ---------------------------------------------------------------------------
// Exécution
// ---------------------------------------------------------------------------

console.log('\n── Contrôle de syntaxe des fichiers .gs ──');
const erreursSyntaxe = harness.verifierSyntaxe();
if (erreursSyntaxe.length) {
  erreursSyntaxe.forEach((e) => console.log('  ✗ ' + e));
  process.exit(1);
}
console.log('  ✓ ' + harness.TOUS_LES_GS.length + ' fichiers valides');

console.log('\n── Tests ──');
tests.forEach(({ nom, fn }) => {
  if (filtre && nom.toLowerCase().indexOf(filtre) === -1) return;
  try {
    fn();
    reussites++;
    console.log('  ✓ ' + nom);
  } catch (e) {
    echecs++;
    console.log('  ✗ ' + nom + '\n      ' + String(e.message).split('\n').join('\n      '));
  }
});

console.log('\n' + (echecs === 0
  ? '✓ ' + reussites + ' réussi(s), 0 échec(s)'
  : '✗ ' + reussites + ' réussi(s), ' + echecs + ' échec(s)') + '\n');
process.exit(echecs === 0 ? 0 : 1);
