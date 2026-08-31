// =============================================================================
// Lint — contrôles statiques adaptés à un projet Apps Script sans dépendances
// =============================================================================
//
//   node tests/lint.js
//
// Trois contrôles :
//   1. syntaxe de tous les fichiers .gs ;
//   2. syntaxe du JavaScript embarqué dans les fichiers .html ;
//   3. absence de secret ressemblant à un token Documenso dans les fichiers
//      versionnés (le token doit vivre dans les propriétés de script).
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const harness = require('./harness');

const RACINE = path.join(__dirname, '..');
const FICHIERS_HTML = ['Mobile.html', 'Compta_Form.html', 'Compta_CSV.html', 'Compta_Amort.html'];

/** Motifs de secrets qui ne doivent jamais être versionnés. */
const MOTIFS_SECRETS = [
  { nom: 'token API Documenso', regex: /\bapi_[A-Za-z0-9]{16,}\b/ }
];

let erreurs = 0;

function ko(message) { erreurs++; console.log('  ✗ ' + message); }
function ok(message) { console.log('  ✓ ' + message); }

// --- 1. Fichiers .gs --------------------------------------------------------

console.log('\n── Syntaxe des fichiers .gs ──');
const erreursGs = harness.verifierSyntaxe();
if (erreursGs.length) erreursGs.forEach(ko);
else ok(harness.TOUS_LES_GS.length + ' fichiers valides');

// --- 2. JavaScript embarqué dans les .html ---------------------------------

console.log('\n── Syntaxe du JavaScript des fichiers .html ──');
FICHIERS_HTML.forEach((nom) => {
  const chemin = path.join(RACINE, nom);
  if (!fs.existsSync(chemin)) { ko(nom + ' : fichier absent'); return; }

  const html = fs.readFileSync(chemin, 'utf8');
  const blocs = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  if (!blocs.length) { ok(nom + ' : aucun script inline'); return; }

  let souci = false;
  blocs.forEach((bloc, i) => {
    try {
      new vm.Script(bloc[1], { filename: nom + ' <script #' + (i + 1) + '>' });
    } catch (e) {
      souci = true;
      ko(nom + ' <script #' + (i + 1) + '> : ' + e.message);
    }
  });
  if (!souci) ok(nom + ' : ' + blocs.length + ' bloc(s) script valide(s)');
});

// --- 3. Absence de secrets versionnés --------------------------------------

console.log('\n── Secrets ──');
function fichiersVersionnes(dossier, acc) {
  acc = acc || [];
  fs.readdirSync(dossier, { withFileTypes: true }).forEach((entree) => {
    if (entree.name === '.git' || entree.name === 'node_modules') return;
    const complet = path.join(dossier, entree.name);
    if (entree.isDirectory()) fichiersVersionnes(complet, acc);
    else if (/\.(gs|js|html|md|json)$/.test(entree.name)) acc.push(complet);
  });
  return acc;
}

let secretTrouve = false;
fichiersVersionnes(RACINE).forEach((chemin) => {
  const contenu = fs.readFileSync(chemin, 'utf8');
  MOTIFS_SECRETS.forEach((motif) => {
    const m = contenu.match(motif.regex);
    if (m) {
      secretTrouve = true;
      ko(path.relative(RACINE, chemin) + ' : ' + motif.nom + ' potentiellement versionné (' +
         m[0].slice(0, 8) + '…)');
    }
  });
});
if (!secretTrouve) ok('aucun secret détecté dans les fichiers versionnés');

console.log('\n' + (erreurs === 0 ? '✓ Lint OK' : '✗ ' + erreurs + ' problème(s)') + '\n');
process.exit(erreurs === 0 ? 0 : 1);
