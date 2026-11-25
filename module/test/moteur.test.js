'use strict';
// Moteur de synchronisation commun (module/src/moteur.js) : faux Grist en mémoire, vrais fichiers du Sénat.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

require('../src/sync.js');
require('../src/moteur.js');
const { sync: S, moteur: M } = globalThis.Formulaire;
const FIX = path.join(__dirname, '..', '..', 'tests', 'fixtures');
const lire = f => fs.readFileSync(path.join(FIX, f), 'utf8');
let ICAL;
test.before(async () => { ICAL = (await import(pathToFileURL(path.join(__dirname, '..', '..', 'vendor', 'ical-2.1.0.min.mjs')).href)).default; });

const T = S.versEpoch(2026, 11, 24, 21, 0, 0);
const PAGES = {
  'https://www.senat.fr/aglae/Instance-0-LOIS/ical.ics': lire('senat-lois.ics'),
  'https://www.senat.fr/aglae/Seance/ical.ics': lire('senat-seance.ics'),
  'https://www.senat.fr/aglae/Instance-0-FINC/ical.ics': lire('senat-entr-vide.ics'),
  'https://www.senat.fr/dossier-legislatif/pjlf2027.html': lire('senat-dossier-pjlf2027.html'),
};

// Faux document : quelques tables, et les actions Grist qu'utilise le moteur
function document() {
  const d = {
    Sources: [
      { id: 1, Nom: 'Saisie manuelle', Type: 'Saisie manuelle', Active: false },
      { id: 2, Nom: 'Commission des lois', Type: 'Flux iCal', Active: true, URL: 'https://www.senat.fr/aglae/Instance-0-LOIS/ical.ics' },
      { id: 3, Nom: 'Séance publique', Type: 'Flux iCal', Active: false, URL: 'https://www.senat.fr/aglae/Seance/ical.ics' },
      { id: 4, Nom: 'Commission des finances', Type: 'Flux iCal', Active: false, URL: 'https://www.senat.fr/aglae/Instance-0-FINC/ical.ics' },
      { id: 5, Nom: 'Agenda équipe', Type: 'Flux via relais', Active: true, Contenu_relaye: '' },
    ],
    Dossiers: [{ id: 1, Lien: 'https://www.senat.fr/dossier-legislatif/pjlf2027.html', Assemblee: 'Sénat', Etat: 'À analyser' }],
    Evenements: [],
  };
  let suivant = 100;
  const lots = [];
  const appliquer = async actions => {
    lots.push(actions);
    for (const [a, t, ids, cols] of actions) {
      const tab = d[t];
      if (a === 'BulkAddRecord') ids.forEach((_, i) => tab.push({ id: ++suivant, ...Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, v[i]])) }));
      else if (a === 'UpdateRecord') Object.assign(tab.find(r => r.id === ids), cols);
      else if (a === 'BulkUpdateRecord') ids.forEach((id, i) => Object.assign(tab.find(r => r.id === id), Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, v[i]]))));
      else if (a === 'BulkRemoveRecord') d[t] = tab.filter(r => !ids.includes(r.id));
      else throw new Error('action inattendue ' + a);
    }
  };
  const io = { lireTexte: async u => { if (!(u in PAGES)) throw new Error('page inconnue ' + u); return PAGES[u]; }, appliquer };
  return { d, io, lots };
}

test('première synchronisation : dossier analysé, flux suivis et flux du Sénat filtrés par dossier, deux écritures seulement', async () => {
  const { d, io, lots } = document();
  const r = await M.synchroniser(io, d, { ICAL, maintenant: T });
  assert.equal(r.statut, 'fait');
  assert.equal(lots.length, 2, 'le verrou, puis un seul lot');
  assert.deepEqual(lots[0], [['BulkUpdateRecord', 'Sources', [2, 3, 4], { Synchro_en_cours: [T, T, T] }]], 'lois (suivie), séance et finances (dossier du Sénat suivi) ; pas le relais vide');
  const dossier = d.Dossiers[0];
  assert.equal(dossier.Etat, 'Suivi actif');
  assert.match(dossier.Numeros, /n° 155 \(2026-2027\)/);
  const lois = d.Evenements.filter(e => e.Source === 2), seance = d.Evenements.filter(e => e.Source === 3);
  assert.equal(lois.length, 12, 'agenda suivi : tout');
  assert.ok(seance.length > 0 && seance.every(e => e.Dossier === 1), 'séance non suivie : seulement les séances du dossier');
  assert.ok(d.Sources.filter(s => [2, 3, 4].includes(s.id)).every(s => s.Synchro_en_cours === null && s.Derniere_synchro === T), 'verrous levés, date notée');
  assert.match(d.Sources.find(s => s.id === 3).Resultat_synchro, /\(seulement les dossiers suivis\)$/);
});

test('deuxième passage sans changement : aucun événement réécrit', async () => {
  const { d, io, lots } = document();
  await M.synchroniser(io, d, { ICAL, maintenant: T });
  const avant = JSON.stringify(d.Evenements);
  const r = await M.synchroniser(io, d, { ICAL, maintenant: T + 7200 });
  assert.equal(r.changements, 0);
  assert.equal(JSON.stringify(d.Evenements), avant);
  assert.ok(lots[3].every(a => a[1] !== 'Evenements'), 'le second lot ne touche que les sources');
});

test('contenu relayé tout frais (relais) : lu sans relire Grist, et les actions du relais partent dans le même lot', async () => {
  const { d, io, lots } = document();
  const contenus = new Map([[5, lire('google-journee.ics')]]);
  const avant = [['UpdateRecord', 'Sources', 5, { Contenu_relaye: 'x', Relaye_le: T }]];
  await M.synchroniser(io, d, { ICAL, maintenant: T, contenus, actionsAvant: avant });
  assert.equal(d.Evenements.filter(e => e.Source === 5).length, 2);
  assert.deepEqual(lots[1][0], avant[0], 'action du relais en tête du lot final');
  assert.equal(lots.length, 2);
});

test('verrou d’un autre poste : rien n’est lu ; compte en lecture seule : refus ; échec du lot : verrous levés', async () => {
  const a = document();
  a.d.Sources[1].Synchro_en_cours = T - 60;
  assert.equal((await M.synchroniser(a.io, a.d, { ICAL, maintenant: T })).statut, 'occupe');
  assert.equal(a.d.Evenements.length, 0);
  const b = document();
  b.io.appliquer = async x => { if (x[0][0] === 'BulkUpdateRecord') throw new Error('accès refusé'); };
  b.d.Dossiers = [];
  assert.equal((await M.synchroniser(b.io, b.d, { ICAL, maintenant: T })).statut, 'refuse');
  const c = document();
  const ap = c.io.appliquer;
  let n = 0;
  c.io.appliquer = async x => { if (++n === 2) throw new Error('quota'); return ap(x); };
  await assert.rejects(M.synchroniser(c.io, c.d, { ICAL, maintenant: T }), /quota/);
  assert.ok(c.d.Sources.filter(s => [2, 3, 4].includes(s.id)).every(s => s.Synchro_en_cours === null), 'verrous levés après l’échec');
});

test('périmée : selon le délai, ou un dossier à analyser', () => {
  const { d } = document();
  d.Dossiers = [];
  d.Sources.forEach(s => { s.Derniere_synchro = T - 600; });
  assert.equal(M.perimee(d, T, 1800), false);
  assert.equal(M.perimee(d, T, 300), true);
  d.Dossiers = [{ id: 9, Etat: 'À analyser', Assemblee: 'Sénat' }];
  assert.equal(M.perimee(d, T, 1800), true);
});
