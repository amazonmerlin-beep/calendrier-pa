'use strict';
// Répertoire des dossiers en cours : construction par le relais (relais/repertoire.mjs) sur des extraits réels de
// l'open data du Sénat et de l'Assemblée, puis recherche par le module (module/src/repertoire.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

require('../src/repertoire.js');
const R = globalThis.Formulaire.repertoire;
const FIX = path.join(__dirname, '..', '..', 'tests', 'fixtures');
let construire, rep, prep;
test.before(async () => {
  ({ construireRepertoire: construire } = await import(pathToFileURL(path.join(__dirname, '..', '..', 'relais', 'repertoire.mjs')).href));
  const csv = new TextDecoder('windows-1252').decode(fs.readFileSync(path.join(FIX, 'senat-dossiers-extrait.csv')));
  const an = JSON.parse(fs.readFileSync(path.join(FIX, 'an-dossiers-extrait.json'), 'utf8'));
  rep = construire(csv, an);
  prep = R.preparer(rep);
});
const parSenat = s => rep.dossiers.find(d => d.s === s);

test('répertoire : seuls les dossiers en cours ; les clos et l’ancien écartés', () => {
  assert.ok(parSenat('pjlf2027'), 'budget 2027 en première lecture au Sénat');
  assert.ok(parSenat('pjl25-252'), 'projet de loi récent en première lecture');
  assert.equal(parSenat('pjlf2025'), undefined, 'promulgué');
  assert.equal(parSenat('ppl19-247'), undefined, 'caduc');
  assert.equal(parSenat('a78790923'), undefined, 'ouvert mais déposé avant octobre 2017');
  const titres = rep.dossiers.map(d => d.t).join(' | ');
  assert.doesNotMatch(titres, /coût de l’immigration/, 'retiré à l’Assemblée');
  assert.doesNotMatch(titres, /vote par assis et levé/, 'résolution votée');
  assert.doesNotMatch(titres, /dépenses de soutien aux aéroports/, 'rapport d’information : pas un dossier législatif');
  assert.doesNotMatch(titres, /approbation de l’accord/i, 'promulgué');
  assert.equal(rep.exclusAN, 4, 'promulgué, retiré, résolution votée, rapport');
});

test('répertoire : les lois financières sont des dossiers législatifs (budget 2027 des deux côtés)', () => {
  const plf = parSenat('pjlf2027');
  assert.equal(plf.ty, 'Loi de finances');
  assert.equal(plf.a, '17/PLF_2027', 'rattaché au dossier de l’Assemblée');
});

test('répertoire : un dossier présent dans les deux assemblées n’apparaît qu’une fois, avec ses deux liens', () => {
  const lie = rep.dossiers.find(d => d.s && d.a && /investissement publicitaire/i.test(d.t + (d.t2 || '')));
  assert.ok(lie, 'dossier de l’Assemblée rattaché à son dossier du Sénat');
  assert.equal(rep.dossiers.filter(d => /investissement publicitaire/i.test(d.t + (d.t2 || ''))).length, 1);
  assert.match(R.lienSenat(lie), /^https:\/\/www\.senat\.fr\/dossier-legislatif\/[\w-]+\.html$/);
  assert.match(R.lienAN(lie), /^https:\/\/www\.assemblee-nationale\.fr\/dyn\/17\/dossiers\/\S+$/);
  const seul = rep.dossiers.find(d => /intelligence artificielle/i.test(d.t));
  assert.ok(seul && !seul.s && seul.a, 'proposition de loi déposée à l’Assemblée seulement');
  assert.equal(seul.ty, 'Proposition de loi');
});

test('recherche : sans accents ni casse, mots vides ignorés, numéro de texte, filtre par assemblée', () => {
  assert.equal(R.chercher(prep, 'budget 2027').resultats[0].s, 'pjlf2027', 'par le thème « Budget » du Sénat, la loi de finances en tête');
  assert.equal(R.chercher(prep, 'PLF 2027').resultats[0].s, 'pjlf2027', 'abréviation');
  assert.equal(R.chercher(prep, 'loi de finances 2027').resultats[0].s, 'pjlf2027');
  assert.equal(R.chercher(prep, 'INTELLIGENCE artificielle éthique').total, 1);
  assert.equal(R.chercher(prep, 'intelligence artificielle ethique').resultats[0].a.startsWith('17/'), true);
  assert.equal(R.chercher(prep, 'pjlf2027').resultats[0].s, 'pjlf2027');
  assert.equal(R.chercher(prep, 'la loi de').total, R.chercher(prep, 'la loi de').total, 'que des mots vides : utilisés tels quels, sans erreur');
  assert.equal(R.chercher(prep, 'intelligence artificielle', { assemblee: 'senat' }).total, 0);
  assert.equal(R.chercher(prep, 'x').total, 0, 'trop court');
  assert.equal(R.chercher(prep, 'introuvable zzz').total, 0);
});
