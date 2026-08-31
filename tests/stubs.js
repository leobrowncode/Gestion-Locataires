// =============================================================================
// Stubs Google Apps Script pour les tests Node
// =============================================================================
//
// Reproduit en mémoire les services Apps Script utilisés par le projet
// (Sheets, Drive, Docs, UrlFetch, Utilities, Properties…) afin d'exécuter le
// VRAI code de Code.gs / Documenso.gs / Signature.gs sans Google.
//
// Volontairement minimal : seules les méthodes réellement appelées par le code
// testé sont implémentées. Toute méthode manquante lève une erreur explicite
// plutôt que de renvoyer silencieusement undefined.
// =============================================================================

'use strict';

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Blob
// ---------------------------------------------------------------------------

class FakeBlob {
  constructor(data, contentType, name) {
    this._bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    this._type = contentType || 'text/plain';
    this._name = name || '';
  }
  getBytes() { return Array.from(this._bytes); }
  getDataAsString() { return this._bytes.toString('utf8'); }
  getName() { return this._name; }
  setName(n) { this._name = n; return this; }
  getContentType() { return this._type; }
  copyBlob() { return new FakeBlob(this._bytes, this._type, this._name); }
}

// ---------------------------------------------------------------------------
// Google Docs — corps de document modélisé en paragraphes
// ---------------------------------------------------------------------------

class FakeText {
  constructor(paragraph) { this._p = paragraph; }
  setFontFamily() { return this; }
  setFontSize() { return this; }
  setForegroundColor() { return this; }
  setBold() { return this; }
  setItalic() { return this; }
}

class FakeParagraph {
  constructor(text, type) { this.text = String(text); this.type = type || 'PARAGRAPH'; }
  getText() { return this.text; }
  getType() { return this.type; }
  editAsText() { return new FakeText(this); }
  asParagraph() { return this; }
  setText(t) { this.text = String(t); return this; }
  clear() { this.text = ''; return this; }
  setAlignment() { return this; }
}

class FakeBody {
  // Un paragraphe peut être décrit par une chaîne, ou par { text, type } pour
  // simuler un élément non-paragraphe (TABLE, par exemple).
  constructor(paragraphes) {
    this.paragraphes = paragraphes.map((p) => (typeof p === 'string'
      ? new FakeParagraph(p)
      : new FakeParagraph(p.text, p.type)));
  }
  getText() { return this.paragraphes.map((p) => p.text).join('\n'); }
  replaceText(pattern, replacement) {
    const re = new RegExp(pattern, 'g');
    this.paragraphes.forEach((p) => { p.text = p.text.replace(re, replacement); });
    return this;
  }
  // findText n'est utilisé que par setTextColor / insertSignatureImage :
  // renvoyer null équivaut à « aucune occurrence », ce qui est inoffensif ici.
  findText() { return null; }
  getNumChildren() { return this.paragraphes.length; }
  getChild(i) { return this.paragraphes[i]; }
  removeChild(child) {
    const i = this.paragraphes.indexOf(child);
    if (i === -1) throw new Error('removeChild: élément absent du corps');
    this.paragraphes.splice(i, 1);
    return this;
  }
  insertParagraph(index, text) {
    const p = new FakeParagraph(text);
    this.paragraphes.splice(index, 0, p);
    return p;
  }
  appendParagraph(text) {
    const p = new FakeParagraph(text);
    this.paragraphes.push(p);
    return p;
  }
  clone() { return new FakeBody(this.paragraphes.map((p) => ({ text: p.text, type: p.type }))); }
}

// ---------------------------------------------------------------------------
// Drive en mémoire
// ---------------------------------------------------------------------------

class FakeDrive {
  constructor() {
    this.fichiers = new Map();   // id → {id, name, type, body?, blob?, parent, trashed}
    this.dossiers = new Map();   // id → {id, name, parent}
    this.compteur = 0;
    this.creerDossier('root', 'ROOT', null);
  }
  nouvelId(prefixe) { return prefixe + '-' + (++this.compteur); }

  creerDossier(id, name, parent) {
    const f = { id: id || this.nouvelId('folder'), name, parent };
    this.dossiers.set(f.id, f);
    return f;
  }
  creerDoc(name, paragraphes, parent) {
    const f = {
      id: this.nouvelId('doc'),
      name,
      type: 'document',
      body: new FakeBody(paragraphes),
      parent: parent || 'root',
      trashed: false
    };
    this.fichiers.set(f.id, f);
    return f;
  }
  creerFichierBlob(name, blob, parent) {
    const f = {
      id: this.nouvelId('file'),
      name,
      type: 'blob',
      blob,
      parent: parent || 'root',
      trashed: false
    };
    this.fichiers.set(f.id, f);
    return f;
  }
  fichiersDuDossier(folderId) {
    return [...this.fichiers.values()].filter((f) => f.parent === folderId && !f.trashed);
  }
}

function construireDriveApp(drive) {
  function wrapFile(brut) {
    if (!brut) throw new Error('Fichier Drive introuvable');
    return {
      getId: () => brut.id,
      getName: () => brut.name,
      setName: (n) => { brut.name = n; return wrapFile(brut); },
      getLastUpdated: () => new Date(),
      setTrashed: (v) => { brut.trashed = !!v; return wrapFile(brut); },
      isTrashed: () => !!brut.trashed,
      makeCopy: (nom, dossier) => {
        if (brut.type !== 'document') throw new Error('makeCopy non simulé pour ce type');
        const copie = {
          id: drive.nouvelId('doc'),
          name: nom,
          type: 'document',
          body: brut.body.clone(),
          parent: dossier ? dossier.getId() : 'root',
          trashed: false
        };
        drive.fichiers.set(copie.id, copie);
        return wrapFile(copie);
      },
      getBlob: () => (brut.type === 'document'
        ? new FakeBlob(brut.body.getText(), 'application/pdf', brut.name)
        : brut.blob.copyBlob()),
      getAs: (mime) => (brut.type === 'document'
        ? new FakeBlob(brut.body.getText(), mime, brut.name)
        : brut.blob.copyBlob())
    };
  }

  function wrapFolder(brut) {
    if (!brut) throw new Error('Dossier Drive introuvable');
    return {
      getId: () => brut.id,
      getName: () => brut.name,
      getFoldersByName: (nom) => {
        const trouves = [...drive.dossiers.values()]
          .filter((d) => d.parent === brut.id && d.name === nom);
        let i = 0;
        return { hasNext: () => i < trouves.length, next: () => wrapFolder(trouves[i++]) };
      },
      createFolder: (nom) => wrapFolder(drive.creerDossier(null, nom, brut.id)),
      createFile: (blob) => wrapFile(drive.creerFichierBlob(blob.getName() || 'sans-nom', blob, brut.id)),
      getFiles: () => {
        const liste = drive.fichiersDuDossier(brut.id);
        let i = 0;
        return { hasNext: () => i < liste.length, next: () => wrapFile(liste[i++]) };
      },
      getFilesByType: (type) => {
        const cible = type === 'application/vnd.google-apps.document' ? 'document' : 'blob';
        const liste = drive.fichiersDuDossier(brut.id).filter((f) => f.type === cible);
        let i = 0;
        return { hasNext: () => i < liste.length, next: () => wrapFile(liste[i++]) };
      },
      moveTo: () => {}
    };
  }

  return {
    _drive: drive,
    _wrapFolder: wrapFolder,
    getFileById: (id) => {
      const f = drive.fichiers.get(id);
      if (!f) throw new Error('Fichier introuvable : ' + id);
      return wrapFile(f);
    },
    getFolderById: (id) => {
      const d = drive.dossiers.get(id);
      if (!d) throw new Error('Dossier introuvable : ' + id);
      return wrapFolder(d);
    }
  };
}

function construireDocumentApp(drive) {
  return {
    HorizontalAlignment: { RIGHT: 'RIGHT', LEFT: 'LEFT', CENTER: 'CENTER' },
    ElementType: { PARAGRAPH: 'PARAGRAPH', TABLE: 'TABLE', LIST_ITEM: 'LIST_ITEM' },
    openById: (id) => {
      const f = drive.fichiers.get(id);
      if (!f || f.type !== 'document') throw new Error('Google Doc introuvable : ' + id);
      return {
        getId: () => f.id,
        getBody: () => f.body,
        saveAndClose: () => {}
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Spreadsheet en mémoire
// ---------------------------------------------------------------------------

class FakeSheet {
  constructor(nom, valeurs) {
    this.nom = nom;
    this.valeurs = valeurs.map((l) => l.slice());
  }
  getName() { return this.nom; }
  _assurerTaille(row, col) {
    while (this.valeurs.length < row) this.valeurs.push([]);
    for (const ligne of this.valeurs) {
      while (ligne.length < col) ligne.push('');
    }
  }
  getLastRow() { return this.valeurs.length; }
  getLastColumn() {
    return this.valeurs.reduce((max, l) => Math.max(max, l.length), 0);
  }
  setFrozenRows() { return this; }
  appendRow(ligne) {
    this.valeurs.push(ligne.slice());
    return this;
  }
  getDataRange() {
    const nbCol = this.getLastColumn();
    const données = this.valeurs.map((l) => {
      const copie = l.slice();
      while (copie.length < nbCol) copie.push('');
      return copie;
    });
    return this._range(1, 1, données.length, nbCol, données);
  }
  getRange(row, col, nbLignes, nbCols) {
    if (typeof row === 'string') throw new Error('getRange(A1) non simulé');
    nbLignes = nbLignes || 1;
    nbCols = nbCols || 1;
    this._assurerTaille(row + nbLignes - 1, col + nbCols - 1);
    const données = [];
    for (let r = 0; r < nbLignes; r++) {
      const ligne = [];
      for (let c = 0; c < nbCols; c++) {
        const v = this.valeurs[row - 1 + r][col - 1 + c];
        ligne.push(v === undefined ? '' : v);
      }
      données.push(ligne);
    }
    return this._range(row, col, nbLignes, nbCols, données);
  }
  _range(row, col, nbLignes, nbCols, données) {
    const sheet = this;
    return {
      getValues: () => données,
      getValue: () => données[0][0],
      setValue(v) {
        sheet._assurerTaille(row, col);
        sheet.valeurs[row - 1][col - 1] = v;
        return this;
      },
      setValues(v) {
        for (let r = 0; r < v.length; r++) {
          for (let c = 0; c < v[r].length; c++) {
            sheet._assurerTaille(row + r, col + c);
            sheet.valeurs[row - 1 + r][col - 1 + c] = v[r][c];
          }
        }
        return this;
      },
      setFormula(f) {
        sheet._assurerTaille(row, col);
        sheet.valeurs[row - 1][col - 1] = f;
        return this;
      },
      setFontWeight() { return this; },
      setNumberFormat() { return this; },
      setFontColor() { return this; },
      clearContent() {
        for (let r = 0; r < nbLignes; r++) {
          for (let c = 0; c < nbCols; c++) {
            sheet._assurerTaille(row + r, col + c);
            sheet.valeurs[row - 1 + r][col - 1 + c] = '';
          }
        }
        return this;
      }
    };
  }
}

function construireSpreadsheetApp(onglets) {
  const ss = {
    getSheetByName: (nom) => onglets.get(nom) || null,
    insertSheet: (nom) => {
      const s = new FakeSheet(nom, []);
      onglets.set(nom, s);
      return s;
    }
  };
  return {
    _onglets: onglets,
    getActiveSpreadsheet: () => ss,
    getUi: () => { throw new Error('SpreadsheetApp.getUi() ne doit pas être appelé hors menu'); }
  };
}

// ---------------------------------------------------------------------------
// Utilities / Session / Properties / UrlFetch
// ---------------------------------------------------------------------------

const MOIS_FORMAT = {
  'dd/MM/yyyy': (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`,
  'yyyy-MM-dd': (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
  yyyyMMdd: (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`,
  'dd/MM/yyyy HH:mm': (d) =>
    `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
};
function pad(n) { return (n < 10 ? '0' : '') + n; }

function construireUtilities() {
  let uuid = 0;
  return {
    DigestAlgorithm: { MD5: 'MD5', SHA_256: 'SHA_256' },
    formatDate: (date, tz, format) => {
      const f = MOIS_FORMAT[format];
      if (!f) throw new Error('Format de date non simulé : ' + format);
      return f(date);
    },
    getUuid: () => 'uuid-' + (++uuid).toString().padStart(8, '0'),
    newBlob: (data, contentType, name) => new FakeBlob(data, contentType, name),
    computeDigest: (algo, texte) => {
      const nom = algo === 'MD5' ? 'md5' : 'sha256';
      const buf = crypto.createHash(nom).update(String(texte), 'utf8').digest();
      // Apps Script renvoie des octets signés (-128..127)
      return Array.from(buf).map((b) => (b > 127 ? b - 256 : b));
    },
    sleep: () => {}   // pas d'attente réelle en test
  };
}

/**
 * Mock d'UrlFetchApp. `routeur(url, params)` renvoie
 * { code, corps, headers } ou lève une erreur (panne réseau simulée).
 * Toutes les requêtes sont enregistrées dans `appels`.
 */
function construireUrlFetchApp() {
  const etat = { routeur: null, appels: [] };
  const app = {
    _etat: etat,
    setRouteur(fn) { etat.routeur = fn; etat.appels = []; },
    appels: () => etat.appels,
    fetch(url, params) {
      etat.appels.push({ url, params });
      if (!etat.routeur) throw new Error('Aucun routeur HTTP configuré pour ce test : ' + url);
      const res = etat.routeur(url, params, etat.appels.length);
      if (res instanceof Error) throw res;
      const corps = res.corps === undefined ? '' : res.corps;
      const headers = res.headers || { 'Content-Type': 'application/json' };
      return {
        getResponseCode: () => res.code,
        getContentText: () => (typeof corps === 'string' ? corps : JSON.stringify(corps)),
        getHeaders: () => headers,
        getBlob: () => new FakeBlob(
          typeof corps === 'string' ? corps : JSON.stringify(corps),
          headers['Content-Type'] || 'application/pdf',
          'reponse'
        )
      };
    }
  };
  return app;
}

function construirePropertiesService(initial) {
  const store = new Map(Object.entries(initial || {}));
  const props = {
    getProperty: (k) => (store.has(k) ? store.get(k) : null),
    setProperty: (k, v) => { store.set(k, String(v)); return props; },
    deleteProperty: (k) => { store.delete(k); return props; },
    getProperties: () => Object.fromEntries(store)
  };
  return { getScriptProperties: () => props, _store: store };
}

module.exports = {
  FakeBlob,
  FakeBody,
  FakeSheet,
  FakeDrive,
  construireDriveApp,
  construireDocumentApp,
  construireSpreadsheetApp,
  construireUtilities,
  construireUrlFetchApp,
  construirePropertiesService
};
