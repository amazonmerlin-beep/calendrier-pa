'use strict';
// Diffusion (module/src/diffusion.js) : ce qu'un abonnement diffuse, et l'agenda iCal produit, relu par ical.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

require('../src/sync.js');
require('../src/diffusion.js');
const D = globalThis.Formulaire.diffusion, S = globalThis.Formulaire.sync;
let ICAL;
test.before(async () => { ICAL = (await import(pathToFileURL(path.join(__dirname, '..', '..', 'tests', 'vendor', 'ical-2.1.0.min.mjs')).href)).default; });

const paris = (a, mo, j, h = 0, mi = 0) => S.versEpoch(a, mo, j, h, mi, 0);
const MAINTENANT = paris(2026, 11, 24, 21);
const SEANCE = 3, LOIS = 10, SAISIE = 1, BUDGET = 7;
const ev = (id, o) => Object.assign({ id, Titre: 'Réunion ' + id, Debut: paris(2026, 11, 25, 9), Fin: paris(2026, 11, 25, 11), Journee_entiere: false,
  Lieu: 'Salle A216, 2e étage', Description: 'Audition, puis vote', Lien: 'https://agenda.senat.fr/2026/11/25/event/1', Notes: 'Y aller avec Camille',
  Statut: null, Diffusion: null, Source: LOIS, Dossier: null, Modifie_le: paris(2026, 11, 24, 10) }, o);
const EVTS = [
  ev(1),
  ev(2, { Source: SEANCE, Dossier: BUDGET, Titre: 'PLF 2027 (suite)' }),
  ev(3, { Source: SAISIE, Titre: 'Point interne', Diffusion: 'Interne' }),
  ev(4, { Source: SAISIE, Dossier: BUDGET, Titre: 'Rendez-vous rapporteur' }),
  ev(5, { Statut: 'Annulé', Titre: 'Audition reportée' }),
  ev(6, { Debut: paris(2026, 8, 1, 9), Fin: paris(2026, 8, 1, 10), Titre: 'Trop ancien' }),
  ev(7, { Source: SAISIE, Titre: 'Colloque', Journee_entiere: true, Debut: paris(2026, 12, 3), Fin: paris(2026, 12, 4, 23, 59) }),
];
const ABO = { Nom: 'Calendrier PA, commission des lois', Sources: ['L', LOIS], Dossiers: ['L', BUDGET], Niveau: 'Titres et horaires', Annules: false };
const ids = l => l.map(e => e.id);

test('sélection : agendas et dossiers choisis, « Interne » jamais, annulés sur option, deux mois en arrière', () => {
  assert.deepEqual(ids(D.selectionner(EVTS, ABO, MAINTENANT)), [1, 2, 4], 'lois + dossier budget (même hors agenda choisi) ; ni interne, ni annulé, ni trop ancien');
  assert.deepEqual(ids(D.selectionner(EVTS, { ...ABO, Annules: true }, MAINTENANT)), [1, 2, 4, 5]);
  assert.deepEqual(ids(D.selectionner(EVTS, { ...ABO, Sources: [SAISIE], Dossiers: [] }, MAINTENANT)), [4, 7], 'listes déjà décodées (module) ; l’interne reste exclu');
  assert.deepEqual(D.selectionner(EVTS, { ...ABO, Sources: ['L'], Dossiers: ['L'] }, MAINTENANT), []);
});

function relire(ics) {
  const cal = new ICAL.Component(ICAL.parse(ics));
  return { cal, evts: cal.getAllSubcomponents('vevent').map(v => new ICAL.Event(v)) };
}
const noms = { sources: new Map([[LOIS, 'Commission des lois'], [SEANCE, 'Séance publique'], [SAISIE, 'Saisie manuelle']]), dossiers: new Map([[BUDGET, 'Budget 2027']]) };

test('iCal, niveau « Titres et horaires » : ni lieu, ni description, ni notes ; relisible par un agenda', () => {
  const ics = D.versIcs(ABO, D.selectionner(EVTS, { ...ABO, Annules: true }, MAINTENANT), noms);
  assert.ok(ics.split('\r\n').every(l => new TextEncoder().encode(l).length <= 75), 'lignes de 75 octets au plus');
  const { cal, evts } = relire(ics);
  assert.equal(cal.getFirstPropertyValue('x-wr-calname'), 'Calendrier PA, commission des lois');
  assert.equal(evts.length, 4);
  const e1 = evts.find(e => e.uid === 'calpa-1@calendrier-pa');
  assert.equal(e1.summary, 'Réunion 1');
  assert.equal(e1.startDate.toUnixTime(), paris(2026, 11, 25, 9));
  assert.equal(e1.endDate.toUnixTime(), paris(2026, 11, 25, 11));
  assert.equal(e1.location, null);
  assert.equal(e1.description, null);
  assert.doesNotMatch(ics, /Camille|Salle A216|agenda\.senat\.fr/);
  const annule = evts.find(e => e.uid === 'calpa-5@calendrier-pa');
  assert.equal(annule.summary, 'Annulé : Audition reportée');
  assert.equal(annule.component.getFirstPropertyValue('status'), 'CANCELLED');
  assert.equal(e1.component.getFirstPropertyValue('categories'), 'Commission des lois');
});

test('iCal, niveaux supérieurs : lieu, description, dossier, lien ; notes seulement au dernier niveau', () => {
  const n1 = relire(D.versIcs({ ...ABO, Niveau: 'Avec lieu et description' }, D.selectionner(EVTS, ABO, MAINTENANT), noms)).evts;
  const e2 = n1.find(e => e.uid === 'calpa-2@calendrier-pa');
  assert.equal(e2.location, 'Salle A216, 2e étage', 'virgule échappée puis relue');
  assert.equal(e2.description, 'Audition, puis vote\n\nDossier : Budget 2027');
  assert.equal(e2.component.getFirstPropertyValue('url'), 'https://agenda.senat.fr/2026/11/25/event/1');
  assert.ok(n1.every(e => !/Camille/.test(e.description || '')));
  const n2 = relire(D.versIcs({ ...ABO, Niveau: 'Avec notes internes' }, D.selectionner(EVTS, ABO, MAINTENANT), noms)).evts;
  assert.match(n2[0].description, /Notes internes : Y aller avec Camille$/);
});

test('iCal : journée entière en dates (fin exclusive), heures en UTC', () => {
  const ics = D.versIcs({ ...ABO, Sources: [SAISIE] }, D.selectionner(EVTS, { ...ABO, Sources: [SAISIE] }, MAINTENANT), noms);
  assert.match(ics, /DTSTART;VALUE=DATE:20261203\r\nDTEND;VALUE=DATE:20261205/);
  const { evts } = relire(ics);
  const c = evts.find(e => e.uid === 'calpa-7@calendrier-pa');
  assert.equal(c.startDate.isDate, true);
  assert.match(ics, /DTSTART:20261125T080000Z/, '9 h à Paris = 8 h UTC en hiver');
});

test('iCal stable d’un passage à l’autre (pas de nouvelle version du gist sans changement)', () => {
  const sel = D.selectionner(EVTS, ABO, MAINTENANT);
  assert.equal(D.versIcs(ABO, sel, noms), D.versIcs(ABO, sel, noms));
});
