// =============================================================================
// DOCUMENSO — Client de l'API V2 (couche HTTP dédiée)
// =============================================================================
//
// Ce fichier ne contient QUE du transport HTTP : aucune lecture du Sheet,
// aucune règle métier, aucun accès Drive. La logique de signature vit dans
// Signature.gs.
//
// CONFIGURATION (PropertiesService.getScriptProperties() — jamais le Sheet) :
//   DOCUMENSO_API_TOKEN     (obligatoire) Token API Documenso ("api_...").
//   DOCUMENSO_BASE_URL      (optionnel)   Défaut : https://app.documenso.com/api/v2
//   DOCUMENSO_AUTH_SCHEME   (optionnel)   'raw' (défaut) ou 'bearer'.
//   DOCUMENSO_TIMEOUT_MS    (optionnel)   Budget total d'un appel, retries inclus.
//   DOCUMENSO_MAX_TENTATIVES(optionnel)   Défaut : 3 (1 appel + 2 reprises).
//   DOCUMENSO_ENDPOINT_<CLE>(optionnel)   Surcharge d'un chemin (cf. DOCUMENSO_ENDPOINTS).
//
// ÉTAT DE VÉRIFICATION DES ENDPOINTS
// Les chemins, noms de champs et formes de réponse ci-dessous ont été relevés
// dans le SDK officiel @documenso/sdk-typescript v0.9.0 (généré depuis
// l'OpenAPI Documenso), et non devinés :
//
//   POST /envelope/create      multipart : champ « payload » (JSON) + champs
//                              « files[] » (un par PDF). Réponse : { id }.
//   POST /envelope/distribute  { envelopeId, meta? } → { success, id,
//                              recipients: [{ id, name, email, token, role,
//                              signingOrder, signingUrl }] }
//   GET  /envelope/{envelopeId}  → { status, externalId, recipients[], fields[],
//                              envelopeItems[], ... }
//                              recipients[] : { id, email, name, token, role,
//                                signingStatus, sendStatus, signedAt,
//                                signingOrder, rejectionReason }
//                              fields[]     : { id, envelopeItemId, type,
//                                recipientId, page, inserted }
//                              envelopeItems[] : { id, title, order }
//   GET  /envelope/item/{envelopeItemId}/download?version=signed|original|pending
//   GET  /envelope/{envelopeId}/certificate/download
//   GET  /envelope/{envelopeId}/audit-log/download
//   POST /envelope/cancel      { envelopeId, reason? } → { success }
//   Authorization: api_xxxxxxxx        (apiKey brut, pas de préfixe "Bearer")
//   Statuts d'enveloppe : DRAFT | PENDING | COMPLETED | REJECTED | CANCELLED
//   signingStatus        : NOT_SIGNED | SIGNED | REJECTED
//
// Tous les chemins restent surchargeables sans toucher au code, via une
// propriété de script DOCUMENSO_ENDPOINT_<CLE> (ex.
// DOCUMENSO_ENDPOINT_ENVELOPECANCEL). Les réponses sont lues de façon
// tolérante (plusieurs noms de champs admis) pour absorber une évolution de
// nommage sans casse.
// =============================================================================


// ---------------------------------------------------------------------------
// 1. CONSTANTES
// ---------------------------------------------------------------------------

var DOCUMENSO_BASE_URL_DEFAUT = 'https://app.documenso.com/api/v2';
var DOCUMENSO_TIMEOUT_MS_DEFAUT = 60000;
var DOCUMENSO_MAX_TENTATIVES_DEFAUT = 3;
var DOCUMENSO_BACKOFF_MS = 1500;      // 1re reprise ; doublé à chaque tentative

/** Chemins relatifs à la base URL. Surchargeables par propriété de script. */
var DOCUMENSO_ENDPOINTS = {
  envelopeCreate:      { method: 'post', path: '/envelope/create' },
  envelopeGet:         { method: 'get',  path: '/envelope/{envelopeId}' },
  envelopeDistribute:  { method: 'post', path: '/envelope/distribute' },
  envelopeCancel:      { method: 'post', path: '/envelope/cancel' },
  itemDownload:        { method: 'get',  path: '/envelope/item/{envelopeItemId}/download' },
  certificateDownload: { method: 'get',  path: '/envelope/{envelopeId}/certificate/download' },
  auditLogDownload:    { method: 'get',  path: '/envelope/{envelopeId}/audit-log/download' }
};

/**
 * Nom du champ multipart portant les fichiers. Le SDK officiel envoie
 * « files[] » ; un tableau HTTP se répète sous le même nom, ce qu'UrlFetchApp
 * ne sait pas faire seul (d'où documensoBuildMultipart).
 */
var DOCUMENSO_CHAMP_FICHIERS = 'files[]';

/** Rôle Documenso des deux parties. Le projet n'utilise que SIGNER. */
var DOCUMENSO_ROLE_SIGNATAIRE = 'SIGNER';

/** Codes d'erreur exposés au métier (Signature.gs les traduit pour l'UI). */
var DOCUMENSO_ERREURS = {
  TOKEN_MANQUANT: 'TOKEN_MANQUANT',
  TOKEN_INVALIDE: 'TOKEN_INVALIDE',
  QUOTA: 'QUOTA',
  INTROUVABLE: 'INTROUVABLE',
  CONFLIT: 'CONFLIT',
  REQUETE_INVALIDE: 'REQUETE_INVALIDE',
  REPONSE_INVALIDE: 'REPONSE_INVALIDE',
  INDISPONIBLE: 'INDISPONIBLE',
  RESEAU: 'RESEAU',
  TIMEOUT: 'TIMEOUT'
};

/** Codes HTTP considérés comme transitoires (seuls cas de reprise). */
var DOCUMENSO_CODES_TRANSITOIRES = [408, 425, 429, 500, 502, 503, 504];


// ---------------------------------------------------------------------------
// 2. ERREUR TYPÉE
// ---------------------------------------------------------------------------

/**
 * Erreur Documenso enrichie : code métier, phase, et indication de sûreté
 * de reprise. Hérite d'Error pour rester utilisable avec throw/catch.
 *
 * @param {string} message — Message lisible (déjà expurgé des données perso).
 * @param {Object} [opts] — { code, httpStatus, stage, envelopeId, safeToRetry }.
 * @constructor
 */
function DocumensoError(message, opts) {
  opts = opts || {};
  this.name = 'DocumensoError';
  this.message = message;
  this.code = opts.code || DOCUMENSO_ERREURS.RESEAU;
  this.httpStatus = opts.httpStatus || null;
  this.stage = opts.stage || null;            // 'create' | 'distribute' | ...
  this.envelopeId = opts.envelopeId || null;
  // safeToRetry : true = relancer la même action ne crée pas de doublon.
  this.safeToRetry = (opts.safeToRetry === undefined) ? false : !!opts.safeToRetry;
  this.stack = (new Error(message)).stack;
}
DocumensoError.prototype = Object.create(Error.prototype);
DocumensoError.prototype.constructor = DocumensoError;


// ---------------------------------------------------------------------------
// 3. UTILITAIRES (secrets, masquage, multipart)
// ---------------------------------------------------------------------------

/**
 * Lit une propriété de script, avec valeur par défaut.
 * @param {string} cle — Nom de la propriété.
 * @param {*} [defaut] — Valeur si absente/vide.
 * @return {*}
 */
function documensoProp(cle, defaut) {
  var props = PropertiesService.getScriptProperties();
  var val = props ? props.getProperty(cle) : null;
  if (val === null || val === undefined || val.toString().trim() === '') return defaut;
  return val.toString().trim();
}

/**
 * Token API. Jamais journalisé, jamais renvoyé au client web.
 * @return {string}
 * @throws {DocumensoError} TOKEN_MANQUANT si la propriété n'est pas définie.
 */
function documensoToken() {
  var token = documensoProp('DOCUMENSO_API_TOKEN', '');
  if (!token) {
    throw new DocumensoError(
      'Token Documenso absent. Ajoutez la propriété de script DOCUMENSO_API_TOKEN ' +
      '(Apps Script > Paramètres du projet > Propriétés du script). Aucune demande n\'a été créée.',
      { code: DOCUMENSO_ERREURS.TOKEN_MANQUANT, safeToRetry: true, stage: 'config' }
    );
  }
  return token;
}

/** true si un token Documenso est configuré (sans jamais le divulguer). */
function documensoTokenConfigure() {
  return !!documensoProp('DOCUMENSO_API_TOKEN', '');
}

/**
 * Masque une adresse email pour les logs et les messages d'erreur.
 * "marie.dupont@example.com" → "m***@example.com"
 * @param {string} email
 * @return {string}
 */
function documensoMaskEmail(email) {
  var s = (email || '').toString();
  var at = s.indexOf('@');
  if (at < 1) return '***';
  return s.charAt(0) + '***' + s.substring(at);
}

/**
 * Nettoie un extrait de réponse API avant de l'inclure dans un message :
 * tronque, masque les adresses email (données personnelles) et expurge tout
 * ce qui ressemble à un token.
 *
 * Le masquage du token n'est pas théorique : une API qui renvoie la requête
 * fautive dans son message d'erreur y inclut l'en-tête Authorization, et cet
 * extrait finit dans la colonne lastErrorMessage du Sheet.
 *
 * @param {string} texte
 * @param {number} [max] — Longueur maximale conservée (défaut 300).
 * @return {string}
 */
function documensoExtraitSur(texte, max) {
  max = max || 300;
  var s = (texte || '').toString().replace(/\s+/g, ' ').trim();
  s = s.replace(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g, function(m) {
    return documensoMaskEmail(m);
  });
  s = documensoExpurgerSecrets(s);
  if (s.length > max) s = s.substring(0, max) + '…';
  return s;
}

/**
 * Remplace par « *** » tout ce qui ressemble à un secret : un token Documenso
 * (api_…), une valeur d'en-tête Authorization, ou le token réellement
 * configuré s'il apparaît tel quel.
 *
 * @param {string} texte
 * @return {string}
 */
function documensoExpurgerSecrets(texte) {
  var s = (texte || '').toString();

  // Le token configuré, quelle que soit sa forme.
  var token = documensoProp('DOCUMENSO_API_TOKEN', '');
  if (token && token.length >= 8) {
    while (s.indexOf(token) !== -1) s = s.replace(token, '***');
  }

  // Toute chaîne ayant la forme d'un token d'API Documenso.
  s = s.replace(/\bapi_[A-Za-z0-9_\-]{8,}/g, 'api_***');
  // Un en-tête Authorization recopié dans le message.
  s = s.replace(/(authorization\s*[:=]\s*)(bearer\s+)?\S+/gi, '$1***');

  return s;
}

/**
 * Construit un corps multipart/form-data.
 * UrlFetchApp sait le faire seul, mais uniquement à partir d'un objet — donc
 * impossible d'envoyer DEUX fichiers sous le même nom de champ ("files"), ce
 * dont l'API Documenso a besoin pour une enveloppe à plusieurs documents.
 *
 * @param {Array<Object>} parts — { name, value } ou { name, filename, blob, contentType }.
 * @return {{contentType: string, payload: number[]}}
 */
function documensoBuildMultipart(parts) {
  var boundary = '----GestionLocataires' + Utilities.getUuid().replace(/-/g, '');
  var chunks = [];

  function pushTexte(s) {
    chunks.push(Utilities.newBlob(s).getBytes());
  }

  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    pushTexte('--' + boundary + '\r\n');
    if (p.blob) {
      pushTexte('Content-Disposition: form-data; name="' + p.name + '"; filename="' +
                (p.filename || 'document.pdf') + '"\r\n');
      pushTexte('Content-Type: ' + (p.contentType || 'application/octet-stream') + '\r\n\r\n');
      chunks.push(p.blob.getBytes());
    } else {
      pushTexte('Content-Disposition: form-data; name="' + p.name + '"\r\n\r\n');
      pushTexte(p.value === undefined || p.value === null ? '' : p.value.toString());
    }
    pushTexte('\r\n');
  }
  pushTexte('--' + boundary + '--\r\n');

  // Aplatissement en une passe (concat successifs = recopies quadratiques).
  var total = 0;
  for (var c = 0; c < chunks.length; c++) total += chunks[c].length;
  var out = new Array(total);
  var k = 0;
  for (var c2 = 0; c2 < chunks.length; c2++) {
    var chunk = chunks[c2];
    for (var j = 0; j < chunk.length; j++) out[k++] = chunk[j];
  }

  return { contentType: 'multipart/form-data; boundary=' + boundary, payload: out };
}

/**
 * Lit la première valeur définie parmi plusieurs chemins d'un objet.
 * Absorbe les écarts de nommage entre versions de l'API.
 * @param {Object} obj — Objet source.
 * @param {string[]} chemins — Chemins pointés, ex. ['id', 'envelope.id'].
 * @return {*} Valeur trouvée, ou null.
 */
function documensoPick(obj, chemins) {
  for (var i = 0; i < chemins.length; i++) {
    var parts = chemins[i].split('.');
    var cur = obj;
    var ok = true;
    for (var j = 0; j < parts.length; j++) {
      if (cur === null || cur === undefined || typeof cur !== 'object' || !(parts[j] in cur)) {
        ok = false;
        break;
      }
      cur = cur[parts[j]];
    }
    if (ok && cur !== null && cur !== undefined && cur !== '') return cur;
  }
  return null;
}


// ---------------------------------------------------------------------------
// 4. CLIENT
// ---------------------------------------------------------------------------

/**
 * Client de l'API Documenso V2.
 *
 *   DocumensoClient
 *   ├── createEnvelope()
 *   ├── addOrMapRecipients()
 *   ├── validateDetectedFields()
 *   ├── distributeEnvelope()
 *   ├── getEnvelopeStatus()
 *   ├── downloadCompletedDocuments()
 *   └── cancelEnvelope()
 *
 * @param {Object} [options] — { baseUrl, token, timeoutMs, maxTentatives }.
 *   Tous optionnels : les valeurs viennent sinon des propriétés de script.
 *   `token` n'est là que pour les tests ; en production il n'est jamais passé
 *   explicitement (il est lu à la demande, jamais stocké dans une cellule).
 * @constructor
 */
function DocumensoClient(options) {
  options = options || {};
  this.baseUrl = (options.baseUrl || documensoProp('DOCUMENSO_BASE_URL', DOCUMENSO_BASE_URL_DEFAUT))
                   .toString().replace(/\/+$/, '');
  this._token = options.token || null;
  this.timeoutMs = parseInt(options.timeoutMs || documensoProp('DOCUMENSO_TIMEOUT_MS', DOCUMENSO_TIMEOUT_MS_DEFAUT), 10);
  this.maxTentatives = parseInt(options.maxTentatives || documensoProp('DOCUMENSO_MAX_TENTATIVES', DOCUMENSO_MAX_TENTATIVES_DEFAUT), 10);
  this.authScheme = (options.authScheme || documensoProp('DOCUMENSO_AUTH_SCHEME', 'raw')).toLowerCase();
}

/** Valeur de l'en-tête Authorization. Jamais journalisée. */
DocumensoClient.prototype._authHeader = function() {
  var token = this._token || documensoToken();
  return this.authScheme === 'bearer' ? 'Bearer ' + token : token;
};

/**
 * Résout un endpoint (chemin + méthode), surcharge de script prioritaire.
 * @param {string} cle — Clé de DOCUMENSO_ENDPOINTS.
 * @param {Object} [params] — Valeurs des segments {xxx} du chemin.
 * @param {Object} [query] — Paramètres de requête à ajouter (valeurs vides ignorées).
 * @return {{method:string, url:string}}
 */
DocumensoClient.prototype._endpoint = function(cle, params, query) {
  var def = DOCUMENSO_ENDPOINTS[cle];
  if (!def) throw new DocumensoError('Endpoint inconnu : ' + cle, { code: DOCUMENSO_ERREURS.REQUETE_INVALIDE });

  var chemin = documensoProp('DOCUMENSO_ENDPOINT_' + cle.toUpperCase(), def.path);
  params = params || {};
  chemin = chemin.replace(/\{(\w+)\}/g, function(_, nom) {
    var v = params[nom];
    if (v === undefined || v === null || v === '') {
      throw new DocumensoError('Paramètre "' + nom + '" manquant pour l\'endpoint ' + cle,
        { code: DOCUMENSO_ERREURS.REQUETE_INVALIDE });
    }
    return encodeURIComponent(v.toString());
  });

  var url = this.baseUrl + chemin;
  if (query) {
    var morceaux = [];
    for (var cleQ in query) {
      var val = query[cleQ];
      if (val === undefined || val === null || val === '') continue;
      morceaux.push(encodeURIComponent(cleQ) + '=' + encodeURIComponent(val.toString()));
    }
    if (morceaux.length) url += (url.indexOf('?') === -1 ? '?' : '&') + morceaux.join('&');
  }
  return { method: def.method, url: url };
};

/** true si le code HTTP justifie une reprise automatique. */
DocumensoClient.prototype._estTransitoire = function(code) {
  return DOCUMENSO_CODES_TRANSITOIRES.indexOf(code) !== -1;
};

/**
 * Traduit une réponse HTTP en erreur typée.
 * @param {number} code — Statut HTTP.
 * @param {string} corps — Corps brut de la réponse.
 * @param {string} stage — Étape en cours ('create', 'distribute'…).
 * @return {DocumensoError}
 */
DocumensoClient.prototype._erreurHttp = function(code, corps, stage) {
  var extrait = documensoExtraitSur(corps);
  var bas = extrait.toLowerCase();

  // Le quota est testé AVANT le token : Documenso renvoie un 403 aussi bien
  // pour un token invalide que pour une limite de plan atteinte, et les deux
  // situations n'appellent pas du tout la même action de l'utilisateur.
  var evoqueQuota = bas.indexOf('quota') !== -1 || bas.indexOf('upgrade') !== -1 ||
                    bas.indexOf('document limit') !== -1 || /limit (reached|exceeded)/.test(bas);
  if (code === 402 || ((code === 400 || code === 403) && evoqueQuota)) {
    return new DocumensoError(
      'Quota Documenso atteint (HTTP ' + code + '). Le plan gratuit est limité à 5 documents ' +
      'par mois. Réessayez au prochain cycle ou passez à un plan supérieur. Aucune enveloppe ' +
      'n\'a été créée. Détail : ' + extrait,
      { code: DOCUMENSO_ERREURS.QUOTA, httpStatus: code, stage: stage, safeToRetry: true });
  }
  if (code === 401 || code === 403) {
    return new DocumensoError(
      'Documenso a refusé le token (HTTP ' + code + '). Vérifiez DOCUMENSO_API_TOKEN ' +
      'et les droits associés. Aucune donnée n\'a été modifiée côté Documenso.',
      { code: DOCUMENSO_ERREURS.TOKEN_INVALIDE, httpStatus: code, stage: stage, safeToRetry: true });
  }
  if (code === 404) {
    return new DocumensoError(
      'Ressource Documenso introuvable (HTTP 404). L\'enveloppe a peut-être été supprimée ' +
      'côté Documenso. Détail : ' + extrait,
      { code: DOCUMENSO_ERREURS.INTROUVABLE, httpStatus: code, stage: stage, safeToRetry: false });
  }
  if (code === 409) {
    return new DocumensoError(
      'Conflit Documenso (HTTP 409) : l\'enveloppe est probablement déjà distribuée ou dans un ' +
      'état incompatible avec cette action. Ne relancez pas l\'envoi sans vérifier son statut. ' +
      'Détail : ' + extrait,
      { code: DOCUMENSO_ERREURS.CONFLIT, httpStatus: code, stage: stage, safeToRetry: false });
  }
  if (code >= 500) {
    return new DocumensoError(
      'Documenso est temporairement indisponible (HTTP ' + code + '). Détail : ' + extrait,
      { code: DOCUMENSO_ERREURS.INDISPONIBLE, httpStatus: code, stage: stage, safeToRetry: false });
  }
  // 400 / 422 : la requête a été REJETÉE, donc rien n'a été créé côté
  // Documenso — corriger puis relancer ne peut pas produire de doublon.
  var rejetValidation = (code === 400 || code === 422);
  return new DocumensoError(
    'Documenso a rejeté la requête (HTTP ' + code + '). Détail : ' + extrait,
    { code: DOCUMENSO_ERREURS.REQUETE_INVALIDE, httpStatus: code, stage: stage,
      safeToRetry: rejetValidation });
};

/**
 * Appel HTTP unique avec reprises limitées.
 *
 * Reprise UNIQUEMENT sur erreur transitoire (réseau, 429, 5xx) et dans la
 * limite du budget temps. Aucune reprise sur une réponse métier (4xx) : une
 * enveloppe a pu être créée, relancer créerait un doublon.
 *
 * @param {string} method — 'get' | 'post'.
 * @param {string} url — URL absolue.
 * @param {Object} [opts] — { payload, contentType, stage, accept, envelopeId, avecAuth }.
 * @return {HTTPResponse}
 */
DocumensoClient.prototype._fetch = function(method, url, opts) {
  opts = opts || {};
  var stage = opts.stage || null;
  var limite = Date.now() + this.timeoutMs;
  var tentative = 0;
  var derniere = null;

  while (true) {
    tentative++;

    var params = {
      method: method,
      muteHttpExceptions: true,
      followRedirects: true,
      headers: {}
    };
    if (opts.avecAuth !== false) params.headers['Authorization'] = this._authHeader();
    if (opts.accept) params.headers['Accept'] = opts.accept;
    if (opts.payload !== undefined && opts.payload !== null) {
      params.payload = opts.payload;
      if (opts.contentType) params.contentType = opts.contentType;
    }

    var reponse = null;
    var erreurReseau = null;
    try {
      reponse = UrlFetchApp.fetch(url, params);
    } catch (e) {
      erreurReseau = e;
    }

    if (!erreurReseau) {
      var code = reponse.getResponseCode();
      if (code >= 200 && code < 300) return reponse;

      derniere = this._erreurHttp(code, reponse.getContentText(), stage);
      derniere.envelopeId = opts.envelopeId || null;
      if (!this._estTransitoire(code)) throw derniere;
    } else {
      derniere = new DocumensoError(
        'Appel Documenso impossible (réseau ou délai dépassé) : ' +
        documensoExtraitSur(erreurReseau && erreurReseau.message, 150),
        { code: DOCUMENSO_ERREURS.RESEAU, stage: stage, envelopeId: opts.envelopeId || null,
          safeToRetry: (stage === 'create' || stage === 'get' || stage === 'download') });
    }

    // Transitoire : reprise si budget et tentatives restants.
    var attente = DOCUMENSO_BACKOFF_MS * Math.pow(2, tentative - 1);
    if (tentative >= this.maxTentatives || Date.now() + attente >= limite) {
      if (derniere.code === DOCUMENSO_ERREURS.RESEAU || derniere.httpStatus >= 500) {
        derniere.message += ' (' + tentative + ' tentative(s), abandon)';
      }
      throw derniere;
    }
    Utilities.sleep(attente);
  }
};

/**
 * Parse une réponse JSON en tolérant un corps vide.
 * @param {HTTPResponse} reponse
 * @param {string} stage
 * @return {Object}
 */
DocumensoClient.prototype._json = function(reponse, stage) {
  var texte = reponse.getContentText();
  if (!texte || !texte.trim()) return {};
  try {
    return JSON.parse(texte);
  } catch (e) {
    throw new DocumensoError(
      'Réponse Documenso illisible (JSON invalide) à l\'étape "' + stage + '". ' +
      'Extrait : ' + documensoExtraitSur(texte, 150),
      { code: DOCUMENSO_ERREURS.REPONSE_INVALIDE, stage: stage });
  }
};


// --- 4.1 Destinataires ------------------------------------------------------

/**
 * Projette les signataires métier en destinataires Documenso.
 *
 * L'ordre du tableau détermine le rang : le premier élément est r1 (le
 * bailleur), le second r2 (le locataire). C'est ce rang que visent les
 * placeholders {{signature,rN}} analysés par Documenso à l'upload du PDF.
 *
 * Projection pure — aucun appel HTTP — mais point unique où la correspondance
 * rN ↔ personne est décidée.
 *
 * @param {Array<Object>} signataires — [{ email, nom }] dans l'ordre r1, r2, …
 * @return {Array<Object>} Destinataires prêts pour le payload, avec signingOrder.
 */
DocumensoClient.prototype.mapRecipients = function(signataires) {
  if (!signataires || !signataires.length) {
    throw new DocumensoError('Aucun signataire fourni pour l\'enveloppe.',
      { code: DOCUMENSO_ERREURS.REQUETE_INVALIDE, stage: 'recipients', safeToRetry: true });
  }

  return signataires.map(function(s, i) {
    if (!s.email) {
      throw new DocumensoError('Signataire r' + (i + 1) + ' sans adresse email.',
        { code: DOCUMENSO_ERREURS.REQUETE_INVALIDE, stage: 'recipients', safeToRetry: true });
    }
    return {
      email: s.email,
      name: s.nom || '',
      role: DOCUMENSO_ROLE_SIGNATAIRE,
      // Signature séquentielle systématique : le bailleur (1) puis le
      // locataire (2). Documenso ne sollicite r2 qu'une fois r1 signé.
      signingOrder: i + 1
    };
  });
};


// --- 4.2 Création de l'enveloppe (brouillon) --------------------------------

/**
 * Crée une enveloppe EN BROUILLON avec ses PDF et ses destinataires.
 * Les placeholders {{signature,rN}} / {{date,rN}} présents dans les PDF sont
 * détectés par Documenso à l'upload et transformés en champs — d'où la
 * vérification obligatoire par validateDetectedFields avant distribution.
 *
 * @param {Object} spec — {
 *     titre: string,
 *     externalId: string,
 *     fichiers: Array<{nom: string, blob: Blob}>,
 *     signataires: Array<{email, nom}>,          // ordre = r1, r2
 *     meta?: Object                              // subject / message / timezone
 *   }
 * @return {{envelopeId: string, brut: Object, payload: Object}}
 */
DocumensoClient.prototype.createEnvelope = function(spec) {
  if (!spec || !spec.fichiers || !spec.fichiers.length) {
    throw new DocumensoError('Aucun fichier PDF à envoyer en signature.',
      { code: DOCUMENSO_ERREURS.REQUETE_INVALIDE, stage: 'create', safeToRetry: true });
  }

  var payload = {
    type: 'DOCUMENT',
    title: spec.titre,
    externalId: spec.externalId,
    recipients: this.mapRecipients(spec.signataires),
    // Mode séquentiel : c'est la convention métier du projet (le bailleur
    // signe, puis Documenso sollicite le locataire).
    meta: { signingOrder: 'SEQUENTIAL' }
  };
  if (spec.meta) {
    for (var k in spec.meta) payload.meta[k] = spec.meta[k];
  }

  var parts = [{ name: 'payload', value: JSON.stringify(payload) }];
  for (var i = 0; i < spec.fichiers.length; i++) {
    parts.push({
      name: DOCUMENSO_CHAMP_FICHIERS,
      filename: spec.fichiers[i].nom,
      blob: spec.fichiers[i].blob,
      contentType: 'application/pdf'
    });
  }

  var corps = documensoBuildMultipart(parts);
  var ep = this._endpoint('envelopeCreate');
  var reponse = this._fetch(ep.method, ep.url, {
    payload: corps.payload,
    contentType: corps.contentType,
    accept: 'application/json',
    stage: 'create'
  });

  var json = this._json(reponse, 'create');
  var envelopeId = documensoExtraireEnvelopeId(json);
  if (!envelopeId) {
    // Cas ambigu : l'enveloppe existe peut-être côté Documenso mais on n'a
    // pas son identifiant. On ne rejoue JAMAIS automatiquement.
    throw new DocumensoError(
      'Documenso a répondu sans identifiant d\'enveloppe exploitable. Une enveloppe a ' +
      'peut-être été créée : vérifiez dans Documenso avant de relancer l\'envoi.',
      { code: DOCUMENSO_ERREURS.REPONSE_INVALIDE, stage: 'create', safeToRetry: false });
  }

  return { envelopeId: envelopeId, brut: json, payload: payload };
};

/**
 * Extrait l'identifiant d'enveloppe d'une réponse, quel que soit le nommage.
 * @param {Object} json — Réponse API.
 * @return {string|null}
 */
function documensoExtraireEnvelopeId(json) {
  var id = documensoPick(json || {}, [
    'id', 'envelope.id', 'data.id',
    'envelopeId', 'envelope.envelopeId', 'data.envelopeId',
    'secondaryId', 'envelope.secondaryId', 'data.secondaryId'
  ]);
  return id === null ? null : id.toString();
}


// --- 4.3 Lecture d'une enveloppe -------------------------------------------

/**
 * Lit une enveloppe et la normalise.
 *
 * @param {string} envelopeId
 * @return {Object} Enveloppe normalisée (cf. documensoNormaliserEnveloppe).
 */
DocumensoClient.prototype.getEnvelope = function(envelopeId) {
  var ep = this._endpoint('envelopeGet', { envelopeId: envelopeId });
  var reponse = this._fetch(ep.method, ep.url, {
    accept: 'application/json',
    stage: 'get',
    envelopeId: envelopeId
  });
  return documensoNormaliserEnveloppe(this._json(reponse, 'get'));
};

/**
 * Alias historique de getEnvelope, conservé pour la lisibilité des appels de
 * suivi (« quel est le statut de cette enveloppe ? »).
 * @param {string} envelopeId
 * @return {Object}
 */
DocumensoClient.prototype.getEnvelopeStatus = function(envelopeId) {
  return this.getEnvelope(envelopeId);
};

/**
 * Normalise la représentation d'une enveloppe (tolérante au nommage).
 *
 * @param {Object} json — Réponse brute de GET /envelope/{id}.
 * @return {{
 *   statut: string, externalId: string,
 *   destinataires: Array<{id, email, nom, statutSignature, signeLe, ordre, jeton, motifRefus}>,
 *   champs: Array<{id, envelopeItemId, type, recipientId}>,
 *   elements: Array<{id, titre, ordre}>,
 *   brut: Object
 * }}
 */
function documensoNormaliserEnveloppe(json) {
  json = json || {};
  var racine = (json.envelope && typeof json.envelope === 'object') ? json.envelope :
               (json.data && typeof json.data === 'object' && json.data.status) ? json.data : json;

  var statut = documensoPick(racine, ['status', 'envelopeStatus', 'state']);
  statut = statut ? statut.toString().toUpperCase() : '';

  var destBruts = racine.recipients || racine.envelopeRecipients || [];
  var destinataires = [];
  for (var i = 0; i < destBruts.length; i++) {
    var d = destBruts[i] || {};
    destinataires.push({
      id: (d.id === undefined || d.id === null) ? null : d.id.toString(),
      email: (d.email || '').toString(),
      nom: (d.name || '').toString(),
      statutSignature: (d.signingStatus || d.status || '').toString().toUpperCase(),
      statutEnvoi: (d.sendStatus || '').toString().toUpperCase(),
      signeLe: d.signedAt || null,
      ordre: (d.signingOrder === undefined || d.signingOrder === null) ? null : d.signingOrder,
      jeton: (d.token || '').toString(),
      motifRefus: (d.rejectionReason || '').toString()
    });
  }

  // Les champs sont soit portés par l'enveloppe (format V2), soit rattachés à
  // chaque destinataire : on accepte les deux.
  var champsBruts = (racine.fields || []).slice(0);
  for (var r = 0; r < destBruts.length; r++) {
    var sousChamps = (destBruts[r] && destBruts[r].fields) || [];
    for (var s = 0; s < sousChamps.length; s++) {
      var copie = {};
      for (var k in sousChamps[s]) copie[k] = sousChamps[s][k];
      if (copie.recipientId === undefined) copie.recipientId = destBruts[r].id;
      champsBruts.push(copie);
    }
  }

  var champs = [];
  for (var f = 0; f < champsBruts.length; f++) {
    var c = champsBruts[f] || {};
    champs.push({
      id: (c.id === undefined || c.id === null) ? null : c.id.toString(),
      envelopeItemId: (c.envelopeItemId === undefined || c.envelopeItemId === null)
        ? null : c.envelopeItemId.toString(),
      type: (c.type || '').toString().toUpperCase(),
      recipientId: (c.recipientId === undefined || c.recipientId === null)
        ? null : c.recipientId.toString()
    });
  }

  var elemBruts = racine.envelopeItems || racine.items || racine.documents || [];
  var elements = [];
  for (var j = 0; j < elemBruts.length; j++) {
    var e = elemBruts[j] || {};
    var id = documensoPick(e, ['id', 'envelopeItemId', 'secondaryId']);
    elements.push({
      id: id === null ? null : id.toString(),
      titre: (e.title || e.name || '').toString(),
      ordre: (e.order === undefined || e.order === null) ? j : e.order
    });
  }
  elements.sort(function(a, b) { return a.ordre - b.ordre; });

  return {
    statut: statut,
    externalId: (racine.externalId || '').toString(),
    destinataires: destinataires,
    champs: champs,
    elements: elements,
    brut: json
  };
}


// --- 4.4 Vérification des champs détectés -----------------------------------

/**
 * Vérifie que Documenso a créé EXACTEMENT les champs attendus à partir des
 * placeholders des PDF, avant toute distribution.
 *
 * Fonction PURE : elle prend une enveloppe déjà normalisée, n'émet aucun appel
 * HTTP, et est donc directement testable.
 *
 * Contrôles (cf. exigences métier) :
 *   • chaque document attendu est présent dans l'enveloppe ;
 *   • aucun document en trop ;
 *   • pour chaque document : le nombre exact de champs attendus, ni plus ni moins ;
 *   • chaque champ attendu (type × destinataire) est présent une seule fois ;
 *   • aucun champ attribué à un destinataire inconnu ou au mauvais rang ;
 *   • chaque signataire possède au moins un champ dans chaque document.
 *
 * @param {Object} enveloppe — Enveloppe normalisée (getEnvelope).
 * @param {Array<Object>} signataires — [{ email }] dans l'ordre r1, r2.
 * @param {Array<Object>} attendus — Un élément par PDF envoyé, dans l'ordre :
 *   { cle: string, titre: string, champs: [{ type: 'SIGNATURE'|'DATE', rang: 'r1' }] }
 * @return {{ok:boolean, problemes:string[], parDocument:Array<Object>, total:number}}
 */
DocumensoClient.prototype.validateDetectedFields = function(enveloppe, signataires, attendus) {
  return documensoValiderChamps(enveloppe, signataires, attendus);
};

/**
 * Implémentation de la vérification des champs (hors prototype pour rester
 * appelable sans instancier de client — notamment depuis les tests).
 * @see DocumensoClient.prototype.validateDetectedFields
 */
function documensoValiderChamps(enveloppe, signataires, attendus) {
  enveloppe = enveloppe || {};
  signataires = signataires || [];
  attendus = attendus || [];

  var problemes = [];
  var destinataires = enveloppe.destinataires || [];
  var elements = enveloppe.elements || [];
  var champs = enveloppe.champs || [];

  // --- 1. Correspondance rang ↔ recipientId --------------------------------
  var rangParRecipientId = {};   // recipientId → 'r1' | 'r2'
  var recipientIdParRang = {};
  for (var i = 0; i < signataires.length; i++) {
    var rang = 'r' + (i + 1);
    var attenduEmail = (signataires[i].email || '').toLowerCase();
    var trouve = null;
    for (var j = 0; j < destinataires.length; j++) {
      if ((destinataires[j].email || '').toLowerCase() === attenduEmail) {
        trouve = destinataires[j];
        break;
      }
    }
    if (!trouve) {
      problemes.push(rang + ' (' + documensoMaskEmail(signataires[i].email) +
                     ') : destinataire absent de l\'enveloppe créée.');
      continue;
    }
    if (trouve.id === null) {
      problemes.push(rang + ' (' + documensoMaskEmail(signataires[i].email) +
                     ') : destinataire sans identifiant, impossible de rattacher ses champs.');
      continue;
    }
    rangParRecipientId[trouve.id] = rang;
    recipientIdParRang[rang] = trouve.id;
  }

  // --- 2. Correspondance document attendu ↔ envelopeItem -------------------
  // Priorité au titre (le nom de fichier envoyé), repli sur l'ordre d'envoi :
  // les deux sont déterministes, jamais « envelopeItems[0] ».
  var itemParCle = {};
  var itemsUtilises = {};
  for (var a = 0; a < attendus.length; a++) {
    var att = attendus[a];
    var item = null;
    for (var e = 0; e < elements.length; e++) {
      if (itemsUtilises[elements[e].id]) continue;
      if (elements[e].titre && att.titre &&
          documensoNormaliserTitre(elements[e].titre) === documensoNormaliserTitre(att.titre)) {
        item = elements[e];
        break;
      }
    }
    if (!item && elements[a] && !itemsUtilises[elements[a].id]) item = elements[a];
    if (!item) {
      problemes.push('Document attendu absent de l\'enveloppe : « ' + (att.titre || att.cle) + ' ».');
      continue;
    }
    itemsUtilises[item.id] = true;
    itemParCle[att.cle] = item;
  }

  var enTrop = elements.filter(function(el) { return !itemsUtilises[el.id]; });
  for (var t = 0; t < enTrop.length; t++) {
    problemes.push('Document inattendu dans l\'enveloppe : « ' +
                   (enTrop[t].titre || enTrop[t].id) + ' ».');
  }

  // --- 3. Champs par document ----------------------------------------------
  var parDocument = [];
  var total = 0;

  for (var d = 0; d < attendus.length; d++) {
    var attendu = attendus[d];
    var element = itemParCle[attendu.cle];
    var detail = { cle: attendu.cle, titre: attendu.titre, envelopeItemId: element ? element.id : null,
                   champs: 0, attendus: attendu.champs.length };
    if (!element) { parDocument.push(detail); continue; }

    var champsDoc = champs.filter(function(c) { return c.envelopeItemId === element.id; });
    detail.champs = champsDoc.length;
    total += champsDoc.length;

    // Chaque champ attendu doit exister exactement une fois.
    var consommes = {};
    for (var x = 0; x < attendu.champs.length; x++) {
      var ch = attendu.champs[x];
      var idAttendu = recipientIdParRang[ch.rang];
      var occurrences = [];
      for (var y = 0; y < champsDoc.length; y++) {
        if (champsDoc[y].type === ch.type && champsDoc[y].recipientId === idAttendu) {
          occurrences.push(y);
        }
      }
      if (!idAttendu) continue;   // problème déjà signalé au niveau destinataire
      if (occurrences.length === 0) {
        problemes.push('« ' + (attendu.titre || attendu.cle) + ' » : champ ' + ch.type.toLowerCase() +
                       ' manquant pour ' + ch.rang + '. Vérifiez le placeholder {{' +
                       ch.type.toLowerCase() + ',' + ch.rang + '}} dans le PDF (une seule ligne, ' +
                       'police standard).');
      } else if (occurrences.length > 1) {
        problemes.push('« ' + (attendu.titre || attendu.cle) + ' » : ' + occurrences.length +
                       ' champs ' + ch.type.toLowerCase() + ' pour ' + ch.rang +
                       ' au lieu d\'un seul (marqueur laissé en double dans le modèle ?).');
      }
      for (var o = 0; o < occurrences.length; o++) consommes[occurrences[o]] = true;
    }

    // Tout champ non consommé est en trop : mauvais type, ou mauvais destinataire.
    for (var z = 0; z < champsDoc.length; z++) {
      if (consommes[z]) continue;
      var rangReel = rangParRecipientId[champsDoc[z].recipientId];
      problemes.push('« ' + (attendu.titre || attendu.cle) + ' » : champ ' +
                     (champsDoc[z].type || '(sans type)') + ' inattendu' +
                     (rangReel ? ' attribué à ' + rangReel
                               : ' attribué à un destinataire inconnu (id ' +
                                 champsDoc[z].recipientId + ')') + '.');
    }

    if (champsDoc.length !== attendu.champs.length) {
      problemes.push('« ' + (attendu.titre || attendu.cle) + ' » : ' + champsDoc.length +
                     ' champ(s) détecté(s) au lieu de ' + attendu.champs.length + '.');
    }

    // Chaque signataire doit avoir au moins un champ dans CE document.
    for (var rr = 0; rr < signataires.length; rr++) {
      var rangAttendu = 'r' + (rr + 1);
      var idDest = recipientIdParRang[rangAttendu];
      if (!idDest) continue;
      var aUnChamp = champsDoc.some(function(c) { return c.recipientId === idDest; });
      if (!aUnChamp) {
        problemes.push('« ' + (attendu.titre || attendu.cle) + ' » : aucun champ pour ' +
                       rangAttendu + ' — ce signataire n\'aurait rien à signer.');
      }
    }

    parDocument.push(detail);
  }

  // --- 4. Champs rattachés à un document hors périmètre --------------------
  var idsAttendus = {};
  for (var q in itemParCle) idsAttendus[itemParCle[q].id] = true;
  var orphelins = champs.filter(function(c) { return !idsAttendus[c.envelopeItemId]; });
  if (orphelins.length) {
    problemes.push(orphelins.length + ' champ(s) rattaché(s) à un document non attendu — ' +
                   'l\'enveloppe ne correspond pas à ce qui a été envoyé.');
  }

  return { ok: problemes.length === 0, problemes: problemes, parDocument: parDocument, total: total };
}

/** Normalise un titre de document pour la comparaison (casse, extension, espaces). */
function documensoNormaliserTitre(titre) {
  return (titre || '').toString().trim().toLowerCase().replace(/\.pdf$/, '');
}


// --- 4.5 Distribution -------------------------------------------------------

/**
 * Distribue (envoie) l'enveloppe à ses destinataires.
 *
 * La réponse porte l'URL de signature de chaque destinataire : c'est elle qui
 * alimente le bouton « Signer maintenant » du bailleur. En mode séquentiel,
 * seul r1 est réellement sollicité par email ; l'URL de r2 n'est utilisable
 * qu'une fois r1 signé, et n'est donc jamais présentée à l'utilisateur.
 *
 * @param {string} envelopeId
 * @param {Object} [meta] — { subject, message, timezone } — optionnel.
 * @return {{succes:boolean, envelopeId:string, destinataires:Array<{id,email,nom,jeton,url,ordre}>, brut:Object}}
 */
DocumensoClient.prototype.distributeEnvelope = function(envelopeId, meta) {
  var corps = { envelopeId: envelopeId };
  if (meta) corps.meta = meta;

  var ep = this._endpoint('envelopeDistribute');
  var reponse = this._fetch(ep.method, ep.url, {
    payload: JSON.stringify(corps),
    contentType: 'application/json',
    accept: 'application/json',
    stage: 'distribute',
    envelopeId: envelopeId
  });

  var json = this._json(reponse, 'distribute');
  var destBruts = (json && json.recipients) || (json && json.data && json.data.recipients) || [];
  var destinataires = [];
  for (var i = 0; i < destBruts.length; i++) {
    var d = destBruts[i] || {};
    destinataires.push({
      id: (d.id === undefined || d.id === null) ? null : d.id.toString(),
      email: (d.email || '').toString(),
      nom: (d.name || '').toString(),
      jeton: (d.token || '').toString(),
      url: (d.signingUrl || '').toString(),
      ordre: (d.signingOrder === undefined || d.signingOrder === null) ? null : d.signingOrder
    });
  }

  return {
    succes: json && json.success !== undefined ? !!json.success : true,
    envelopeId: envelopeId,
    destinataires: destinataires,
    brut: json
  };
};

/**
 * URL de signature de chaque destinataire d'une enveloppe déjà distribuée.
 *
 * Sert de repli quand la réponse de distribution n'a pas pu être conservée
 * (erreur après distribution, reprise d'une campagne, autre session) : l'URL
 * est reconstruite depuis le jeton du destinataire, comme le fait Documenso.
 *
 * @param {string|Object} enveloppe — Identifiant, ou enveloppe déjà normalisée.
 * @return {Object} { emailEnMinuscules: url }
 */
DocumensoClient.prototype.getSigningLinks = function(enveloppe) {
  var env = (typeof enveloppe === 'string') ? this.getEnvelope(enveloppe) : enveloppe;
  var base = documensoUrlApplication(this.baseUrl);
  var liens = {};
  var dest = (env && env.destinataires) || [];
  for (var i = 0; i < dest.length; i++) {
    if (!dest[i].jeton || !dest[i].email) continue;
    liens[dest[i].email.toLowerCase()] = base + '/sign/' + encodeURIComponent(dest[i].jeton);
  }
  return liens;
};

/**
 * URL publique de l'application Documenso, déduite de l'URL de l'API.
 * https://app.documenso.com/api/v2 → https://app.documenso.com
 * @param {string} baseUrl
 * @return {string}
 */
function documensoUrlApplication(baseUrl) {
  return (baseUrl || DOCUMENSO_BASE_URL_DEFAUT).toString().replace(/\/api\/v\d+\/?$/, '');
}


// --- 4.6 Téléchargement -----------------------------------------------------

/**
 * Télécharge UN document de l'enveloppe.
 *
 * @param {string} envelopeItemId
 * @param {string} [version] — 'signed' (défaut), 'original' ou 'pending'.
 * @return {Blob}
 */
DocumensoClient.prototype.downloadEnvelopeItem = function(envelopeItemId, version) {
  return this._telechargerPdf(
    'itemDownload',
    { envelopeItemId: envelopeItemId },
    'download',
    { version: version || 'signed' }
  );
};

/**
 * Télécharge le certificat de signature de l'enveloppe.
 * @param {string} envelopeId
 * @return {Blob}
 */
DocumensoClient.prototype.downloadCertificate = function(envelopeId) {
  return this._telechargerPdf('certificateDownload', { envelopeId: envelopeId }, 'certificate');
};

/**
 * Télécharge le journal d'audit de l'enveloppe.
 * @param {string} envelopeId
 * @return {Blob}
 */
DocumensoClient.prototype.downloadAuditLog = function(envelopeId) {
  return this._telechargerPdf('auditLogDownload', { envelopeId: envelopeId }, 'auditlog');
};

/**
 * Télécharge un PDF depuis un endpoint, en gérant les deux conventions
 * possibles : flux PDF direct, ou JSON contenant une URL de téléchargement.
 * @param {string} cleEndpoint — Clé DOCUMENSO_ENDPOINTS.
 * @param {Object} params — Paramètres du chemin.
 * @param {string} stage — Étape (messages d'erreur).
 * @param {Object} [query] — Paramètres de requête.
 * @return {Blob}
 */
DocumensoClient.prototype._telechargerPdf = function(cleEndpoint, params, stage, query) {
  var ep = this._endpoint(cleEndpoint, params, query);
  var reponse = this._fetch(ep.method, ep.url, { stage: stage, accept: 'application/pdf, application/json' });

  var type = (reponse.getHeaders && reponse.getHeaders()['Content-Type']) || '';
  type = type.toString().toLowerCase();

  if (type.indexOf('json') !== -1) {
    var json = this._json(reponse, stage);
    var url = documensoPick(json, ['downloadUrl', 'url', 'data.downloadUrl', 'data.url']);
    if (!url) {
      throw new DocumensoError('Réponse de téléchargement sans URL exploitable (étape ' + stage + ').',
        { code: DOCUMENSO_ERREURS.REPONSE_INVALIDE, stage: stage });
    }
    // URL signée : pas d'en-tête d'authentification (elle porte déjà sa signature).
    var fichier = this._fetch('get', url.toString(), { stage: stage, avecAuth: false });
    return fichier.getBlob();
  }

  return reponse.getBlob();
};


// --- 4.7 Annulation ---------------------------------------------------------

/**
 * Annule une enveloppe côté Documenso (les destinataires ne peuvent plus
 * signer). L'enveloppe reste consultable — ce n'est pas une suppression.
 *
 * @param {string} envelopeId
 * @param {string} [motif] — Motif transmis à l'API.
 * @return {Object} Réponse brute.
 */
DocumensoClient.prototype.cancelEnvelope = function(envelopeId, motif) {
  var corps = { envelopeId: envelopeId };
  if (motif) corps.reason = motif;

  var ep = this._endpoint('envelopeCancel');
  var reponse = this._fetch(ep.method, ep.url, {
    payload: JSON.stringify(corps),
    contentType: 'application/json',
    accept: 'application/json',
    stage: 'cancel',
    envelopeId: envelopeId
  });
  return this._json(reponse, 'cancel');
};
