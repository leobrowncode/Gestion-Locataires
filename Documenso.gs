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
// ⚠️ ÉTAT DE VÉRIFICATION DES ENDPOINTS
// L'environnement de développement de ce dépôt n'a pas accès au réseau vers
// docs.documenso.com / app.documenso.com / openapi.documenso.com (bloqués par
// la politique de sortie). Les chemins ci-dessous proviennent de la
// documentation publique telle qu'indexée par les moteurs de recherche :
//
//   VÉRIFIÉ (documentation publique concordante) :
//     POST /envelope/create              (multipart/form-data : payload + files)
//     POST /envelope/distribute          ({ envelopeId, meta? })
//     GET  /envelope/{envelopeId}
//     GET  /envelope/item/{envelopeItemId}/download
//     Authorization: api_xxxxxxxx        (pas de préfixe "Bearer")
//
//   À CONFIRMER avant la première utilisation réelle (OpenAPI officielle) :
//     POST /envelope/delete              (annulation / suppression)
//     GET  /envelope/{id}/certificate/download
//     GET  /envelope/{id}/audit-log/download
//
// Tous les chemins sont surchargeables sans toucher au code, via une propriété
// de script DOCUMENSO_ENDPOINT_<CLE> (ex. DOCUMENSO_ENDPOINT_ENVELOPEDELETE).
// Les réponses sont lues de façon tolérante (plusieurs noms de champs admis)
// pour absorber les écarts de nommage.
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
  envelopeDelete:      { method: 'post', path: '/envelope/delete' },
  itemDownload:        { method: 'get',  path: '/envelope/item/{envelopeItemId}/download' },
  certificateDownload: { method: 'get',  path: '/envelope/{envelopeId}/certificate/download' },
  auditLogDownload:    { method: 'get',  path: '/envelope/{envelopeId}/audit-log/download' }
};

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
 * tronque et masque les adresses email (données personnelles).
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
  if (s.length > max) s = s.substring(0, max) + '…';
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
 * @return {{method:string, url:string}}
 */
DocumensoClient.prototype._endpoint = function(cle, params) {
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

  return { method: def.method, url: this.baseUrl + chemin };
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


// --- 4.1 Création de l'enveloppe -------------------------------------------

/**
 * Normalise les signataires métier en destinataires Documenso.
 *
 * L'API V2 accepte les destinataires directement à la création de
 * l'enveloppe : l'ordre du tableau détermine r1, r2, r3… (le placeholder
 * {{signature, r1}} vise le PREMIER destinataire créé). Cette méthode est donc
 * une projection pure — elle n'émet aucun appel HTTP — mais reste le point
 * unique où la correspondance rN ↔ personne est décidée.
 *
 * @param {Array<Object>} signataires — [{ email, nom, role?, ordre? }] dans l'ordre r1, r2, …
 * @param {Object} [options] — { sequentiel: boolean }.
 * @return {Array<Object>} Destinataires prêts pour le payload.
 */
DocumensoClient.prototype.addOrMapRecipients = function(signataires, options) {
  options = options || {};
  if (!signataires || !signataires.length) {
    throw new DocumensoError('Aucun signataire fourni pour l\'enveloppe.',
      { code: DOCUMENSO_ERREURS.REQUETE_INVALIDE, stage: 'recipients', safeToRetry: true });
  }

  return signataires.map(function(s, i) {
    if (!s.email) {
      throw new DocumensoError('Signataire r' + (i + 1) + ' sans adresse email.',
        { code: DOCUMENSO_ERREURS.REQUETE_INVALIDE, stage: 'recipients', safeToRetry: true });
    }
    var dest = {
      email: s.email,
      name: s.nom || '',
      role: s.role || 'SIGNER'
    };
    // signingOrder n'est envoyé QUE si une signature séquentielle est demandée :
    // en mode parallèle (défaut), on garde le payload minimal.
    if (options.sequentiel) dest.signingOrder = (s.ordre || (i + 1));
    return dest;
  });
};

/**
 * Crée une enveloppe en brouillon avec ses fichiers PDF et ses destinataires.
 * Les placeholders {{signature, rN}} présents dans les PDF sont détectés par
 * Documenso au moment de l'upload et transformés en champs.
 *
 * @param {Object} spec — {
 *     titre: string,
 *     externalId: string,
 *     fichiers: Array<{nom: string, blob: Blob}>,
 *     signataires: Array<{email, nom, role?}>,   // ordre = r1, r2, …
 *     sequentiel?: boolean,
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
    recipients: this.addOrMapRecipients(spec.signataires, { sequentiel: !!spec.sequentiel })
  };
  if (spec.sequentiel) payload.meta = { signingOrder: 'SEQUENTIAL' };
  if (spec.meta) {
    payload.meta = payload.meta || {};
    for (var k in spec.meta) payload.meta[k] = spec.meta[k];
  }

  var parts = [{ name: 'payload', value: JSON.stringify(payload) }];
  for (var i = 0; i < spec.fichiers.length; i++) {
    parts.push({
      name: 'files',
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
    'envelopeId', 'envelope.envelopeId', 'data.envelopeId',
    'secondaryId', 'envelope.secondaryId', 'data.secondaryId',
    'id', 'envelope.id', 'data.id'
  ]);
  return id === null ? null : id.toString();
}


// --- 4.2 Vérification des champs détectés ----------------------------------

/**
 * Vérifie que Documenso a bien créé, pour CHAQUE signataire attendu, au moins
 * un champ de signature à partir des placeholders du PDF.
 *
 * @param {string} envelopeId — Identifiant de l'enveloppe.
 * @param {Array<Object>} signataires — Signataires attendus (ordre r1, r2, …).
 * @return {{ok: boolean, problemes: string[], parSignataire: Object[]}}
 */
DocumensoClient.prototype.validateDetectedFields = function(envelopeId, signataires) {
  var enveloppe = this.getEnvelopeStatus(envelopeId);
  var destinataires = enveloppe.destinataires || [];
  var problemes = [];
  var parSignataire = [];

  for (var i = 0; i < signataires.length; i++) {
    var attendu = signataires[i];
    var trouve = null;
    for (var j = 0; j < destinataires.length; j++) {
      if ((destinataires[j].email || '').toLowerCase() === (attendu.email || '').toLowerCase()) {
        trouve = destinataires[j];
        break;
      }
    }

    var rang = 'r' + (i + 1);
    if (!trouve) {
      problemes.push(rang + ' (' + documensoMaskEmail(attendu.email) +
                     ') : destinataire absent de l\'enveloppe créée.');
      parSignataire.push({ rang: rang, email: attendu.email, champs: 0, signature: false });
      continue;
    }

    var champs = trouve.champs || [];
    var aSignature = false;
    for (var f = 0; f < champs.length; f++) {
      var type = (champs[f].type || '').toString().toUpperCase();
      if (type.indexOf('SIGNATURE') !== -1) { aSignature = true; break; }
    }
    if (!aSignature) {
      problemes.push(rang + ' (' + documensoMaskEmail(attendu.email) +
                     ') : aucun champ de signature détecté. Vérifiez le placeholder ' +
                     '{{signature, ' + rang + '}} dans le PDF (police standard, une seule ligne).');
    }
    parSignataire.push({ rang: rang, email: attendu.email, champs: champs.length, signature: aSignature });
  }

  return { ok: problemes.length === 0, problemes: problemes, parSignataire: parSignataire };
};


// --- 4.3 Distribution -------------------------------------------------------

/**
 * Distribue (envoie) l'enveloppe à ses destinataires.
 * @param {string} envelopeId
 * @param {Object} [meta] — { subject, message, timezone } — optionnel.
 * @return {Object} Réponse brute.
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
  return this._json(reponse, 'distribute');
};


// --- 4.4 Statut -------------------------------------------------------------

/**
 * Lit l'état d'une enveloppe et le normalise.
 *
 * @param {string} envelopeId
 * @return {{statut:string, destinataires:Array, elements:Array, brut:Object}}
 *   statut — valeur Documenso brute en majuscules (DRAFT, PENDING, COMPLETED, REJECTED…).
 *   destinataires — [{ email, nom, statutSignature, champs: [{type}] }]
 *   elements — [{ id, titre }] (documents de l'enveloppe, pour le téléchargement)
 */
DocumensoClient.prototype.getEnvelopeStatus = function(envelopeId) {
  var ep = this._endpoint('envelopeGet', { envelopeId: envelopeId });
  var reponse = this._fetch(ep.method, ep.url, {
    accept: 'application/json',
    stage: 'get',
    envelopeId: envelopeId
  });
  var json = this._json(reponse, 'get');
  return documensoNormaliserEnveloppe(json);
};

/**
 * Normalise la représentation d'une enveloppe (tolérante au nommage).
 * @param {Object} json — Réponse brute.
 * @return {{statut:string, destinataires:Array, elements:Array, brut:Object}}
 */
function documensoNormaliserEnveloppe(json) {
  json = json || {};
  var racine = (json.envelope && typeof json.envelope === 'object') ? json.envelope :
               (json.data && typeof json.data === 'object' && json.data.status) ? json.data : json;

  var statut = documensoPick(racine, ['status', 'envelopeStatus', 'state']);
  statut = statut ? statut.toString().toUpperCase() : '';

  var destBruts = racine.recipients || racine.envelopeRecipients || [];
  var champsGlobaux = racine.fields || [];

  var destinataires = [];
  for (var i = 0; i < destBruts.length; i++) {
    var d = destBruts[i] || {};
    var champs = d.fields || [];
    if (!champs.length && champsGlobaux.length) {
      // Certains formats rattachent les champs à l'enveloppe, pas au destinataire.
      champs = champsGlobaux.filter(function(f) {
        return f && (f.recipientId === d.id || f.recipientEmail === d.email);
      });
    }
    destinataires.push({
      id: d.id !== undefined ? d.id : null,
      email: d.email || '',
      nom: d.name || '',
      statutSignature: (d.signingStatus || d.status || '').toString().toUpperCase(),
      champs: champs.map(function(f) { return { type: (f && f.type) ? f.type : '' }; })
    });
  }

  var elemBruts = racine.envelopeItems || racine.items || racine.documents || [];
  var elements = [];
  for (var j = 0; j < elemBruts.length; j++) {
    var e = elemBruts[j] || {};
    var id = documensoPick(e, ['envelopeItemId', 'id', 'secondaryId']);
    elements.push({
      id: id === null ? null : id.toString(),
      titre: (e.title || e.name || '').toString()
    });
  }

  return { statut: statut, destinataires: destinataires, elements: elements, brut: json };
}


// --- 4.5 Téléchargement -----------------------------------------------------

/**
 * Télécharge les documents signés d'une enveloppe finalisée, plus, si
 * disponibles, le certificat de signature et le journal d'audit.
 *
 * Le certificat et le journal sont « best effort » : leurs endpoints n'ont pas
 * pu être vérifiés contre l'OpenAPI officielle depuis cet environnement. Leur
 * absence ne fait jamais échouer la récupération des documents signés — elle
 * est remontée dans `avertissements`.
 *
 * @param {string} envelopeId
 * @return {{documents: Array<{titre, blob}>, certificat: Blob|null, journal: Blob|null, avertissements: string[]}}
 */
DocumensoClient.prototype.downloadCompletedDocuments = function(envelopeId) {
  var enveloppe = this.getEnvelopeStatus(envelopeId);
  var avertissements = [];
  var documents = [];

  if (!enveloppe.elements.length) {
    avertissements.push('Aucun document listé dans l\'enveloppe ' + envelopeId + '.');
  }

  for (var i = 0; i < enveloppe.elements.length; i++) {
    var el = enveloppe.elements[i];
    if (!el.id) {
      avertissements.push('Document sans identifiant dans l\'enveloppe (position ' + (i + 1) + ').');
      continue;
    }
    try {
      documents.push({ titre: el.titre || ('Document ' + (i + 1)), blob: this._telechargerElement(el.id) });
    } catch (e) {
      avertissements.push('Téléchargement impossible pour « ' + (el.titre || el.id) + ' » : ' + e.message);
    }
  }

  var certificat = null;
  try {
    certificat = this._telechargerPdf('certificateDownload', { envelopeId: envelopeId }, 'certificate');
  } catch (e) {
    avertissements.push('Certificat de signature non récupéré : ' + e.message);
  }

  var journal = null;
  try {
    journal = this._telechargerPdf('auditLogDownload', { envelopeId: envelopeId }, 'auditlog');
  } catch (e) {
    avertissements.push('Journal d\'audit non récupéré : ' + e.message);
  }

  return { documents: documents, certificat: certificat, journal: journal, avertissements: avertissements };
};

/**
 * Télécharge un document de l'enveloppe.
 * @param {string} envelopeItemId
 * @return {Blob}
 */
DocumensoClient.prototype._telechargerElement = function(envelopeItemId) {
  return this._telechargerPdf('itemDownload', { envelopeItemId: envelopeItemId }, 'download');
};

/**
 * Télécharge un PDF depuis un endpoint, en gérant les deux conventions
 * possibles : flux PDF direct, ou JSON contenant une URL de téléchargement.
 * @param {string} cleEndpoint — Clé DOCUMENSO_ENDPOINTS.
 * @param {Object} params — Paramètres du chemin.
 * @param {string} stage — Étape (messages d'erreur).
 * @return {Blob}
 */
DocumensoClient.prototype._telechargerPdf = function(cleEndpoint, params, stage) {
  var ep = this._endpoint(cleEndpoint, params);
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


// --- 4.6 Annulation ---------------------------------------------------------

/**
 * Annule (supprime) une enveloppe côté Documenso.
 * @param {string} envelopeId
 * @param {string} [motif] — Motif transmis à l'API si elle l'accepte.
 * @return {Object} Réponse brute.
 */
DocumensoClient.prototype.cancelEnvelope = function(envelopeId, motif) {
  var corps = { envelopeId: envelopeId };
  if (motif) corps.reason = motif;

  var ep = this._endpoint('envelopeDelete');
  var reponse = this._fetch(ep.method, ep.url, {
    payload: JSON.stringify(corps),
    contentType: 'application/json',
    accept: 'application/json',
    stage: 'cancel',
    envelopeId: envelopeId
  });
  return this._json(reponse, 'cancel');
};
