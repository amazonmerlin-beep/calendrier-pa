'use strict';
// Moteur de synchronisation (module/src/sync.js) : vrais flux du Sénat, invitation Outlook, export Google.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

require('../src/sync.js');
const S = globalThis.Formulaire.sync;
const FIX = path.join(__dirname, '..', '..', 'tests', 'fixtures');
const lire = f => fs.readFileSync(path.join(FIX, f), 'utf8');
// Même version que celle chargée par le module (empreinte vérifiée dans synchro.js)
const ICAL_JS = path.join(__dirname, '..', '..', 'vendor', 'ical-2.1.0.min.mjs');
let ICAL;
test.before(async () => { ICAL = (await import(pathToFileURL(ICAL_JS).href)).default; });

const paris = (a, mo, j, h = 0, mi = 0) => S.versEpoch(a, mo, j, h, mi, 0);
const MAINTENANT = Date.UTC(2026, 10, 24, 20, 0) / 1000;   // 24/11/2026 21:00 à Paris

test('heure de Paris : hiver, été, heure inexistante', () => {
  assert.equal(paris(2026, 11, 24, 9), Date.UTC(2026, 10, 24, 8) / 1000);
  assert.equal(paris(2026, 7, 1, 9), Date.UTC(2026, 6, 1, 7) / 1000);
  // 29/03/2026 02:30 n'existe pas à Paris : on tombe sur une heure valide, sans erreur
  assert.ok(Number.isInteger(paris(2026, 3, 29, 2, 30)));
  assert.equal(S.debutJourParis(paris(2026, 11, 24, 15)), paris(2026, 11, 24));
});

test('flux de la commission des lois : heures flottantes lues à Paris, lien vers la fiche', () => {
  const { items, alertes } = S.lireIcs(ICAL, lire('senat-lois.ics'), { maintenant: MAINTENANT });
  assert.equal(alertes.length, 0);
  assert.equal(items.length, 12);
  const a = items.find(i => i.uid === 'Aglaé-561866@senat.fr');
  assert.match(a.titre, /Audition de Gérald Darmanin, garde des sceaux/);
  assert.equal(a.debut, paris(2026, 11, 24, 15));
  assert.equal(a.fin, paris(2026, 11, 24, 17));
  assert.equal(a.journee, false);
  assert.equal(a.lieu, 'Salle A216 - 2ème étage Est');
  const x = S.adapterSenat(a);
  assert.equal(x.url, 'https://agenda.senat.fr/2026/11/24/event/561866');
  assert.match(x.description, /Heure de fin non publiée par le Sénat/);
});

test('séance publique : horaire annoncé gardé, numéros de textes repérés', () => {
  const { items } = S.lireIcs(ICAL, lire('senat-seance.ics'), { maintenant: MAINTENANT });
  assert.equal(items.length, 59);
  const soir = items.find(i => /soir et la nuit/.test(i.horaireSenat));
  assert.ok(soir, 'un horaire « le soir et la nuit »');
  assert.match(S.adapterSenat(soir).description, /Horaire annoncé par le Sénat : .*le soir et la nuit/);
  const plf = items.filter(i => S.numerosSenat(i.titre + ' ' + i.description).includes('155/2026-2027'));
  assert.ok(plf.length >= 5, `séances du PLF 2027 retrouvées par leur numéro (${plf.length})`);
});

test('flux vide : aucun élément, aucune erreur', () => {
  assert.equal(S.lireIcs(ICAL, lire('senat-entr-vide.ics')).items.length, 0);
});

test('invitation Outlook : fuseau Windows, récurrence, date exclue, occurrence déplacée', () => {
  const { items, methode } = S.lireIcs(ICAL, lire('outlook-invitation.ics'), { maintenant: MAINTENANT });
  assert.equal(methode, 'REQUEST');
  assert.equal(items.length, 5, '6 mardis moins la date exclue du 8 décembre');
  const debuts = items.map(i => i.debut).sort((x, y) => x - y);
  assert.equal(debuts[0], paris(2026, 11, 24, 10));
  assert.ok(!debuts.includes(paris(2026, 12, 8, 10)), 'le 8 décembre est exclu');
  const deplace = items.find(i => i.debut === paris(2026, 12, 1, 14, 30));
  assert.ok(deplace, 'occurrence du 1er décembre déplacée à 14 h 30');
  assert.equal(deplace.titre, 'Point équipe (décalé)');
  assert.equal(deplace.lieu, 'Salle 5');
  assert.equal(new Set(items.map(i => i.uid)).size, 5, 'un identifiant par occurrence');
  assert.match(items[0].description, /pièce jointe\.\nLien Teams/);
});

test('export Google : journée entière sur deux jours, lien dangereux écarté, heure UTC', () => {
  const { items, nomAgenda } = S.lireIcs(ICAL, lire('google-journee.ics'), { maintenant: MAINTENANT });
  assert.equal(nomAgenda, 'Agenda PA partagé');
  const salon = items.find(i => i.uid === 'abc123@google.com');
  assert.equal(salon.journee, true);
  assert.equal(salon.debut, paris(2026, 12, 3));
  assert.equal(salon.fin, paris(2026, 12, 4, 23, 59));
  assert.equal(salon.url, '', 'javascript: refusé');
  const presse = items.find(i => i.uid === 'def456@google.com');
  assert.equal(presse.debut, Date.UTC(2026, 10, 30, 8, 30) / 1000);
  assert.equal(presse.url, 'https://example.org/evenement');
});

test('annulation Outlook (METHOD:CANCEL) : élément marqué annulé', () => {
  const { items } = S.lireIcs(ICAL, lire('outlook-annulation.ics'), { maintenant: MAINTENANT });
  assert.equal(items.length, 1);
  assert.equal(items[0].annule, true);
});

test('contenu qui n’est pas de l’iCal : message clair', () => {
  assert.throws(() => S.lireIcs(ICAL, '<html>403</html>'), /pas un fichier iCal/);
});

test('page d’un dossier du Sénat : titre, numéros, calendrier annoncé, lien Assemblée nationale', () => {
  const d = S.analyserDossierSenat(lire('senat-dossier-pjlf2027.html'));
  assert.equal(d.titre, 'Budget 2027');
  assert.ok(d.numeros.includes('155/2026-2027'), d.numeros.join(', '));
  assert.ok(d.numeros.includes('156/2026-2027'), 'rapport général repéré par son lien');
  assert.ok(d.calendrier.some(c => /^discussion en séance publique les 25, 26, 27, 28/.test(c) && /décembre 2026$/.test(c)), d.calendrier.join(' | '));
  assert.equal(d.lienAN, 'https://www.assemblee-nationale.fr/dyn/17/dossiers/PLF_2027');
});

test('liens de dossiers : Sénat, Assemblée nationale, autres refusés', () => {
  assert.equal(S.typeLienDossier('https://www.senat.fr/dossier-legislatif/pjlf2027.html'), 'senat');
  assert.equal(S.typeLienDossier('http://senat.fr/dossierleg/ppl25-123.html#x'), 'senat');
  assert.equal(S.typeLienDossier('https://www.assemblee-nationale.fr/dyn/17/dossiers/PLF_2027'), 'an');
  assert.equal(S.typeLienDossier('https://www.senat.fr/agenda/'), null);
  assert.equal(S.typeLienDossier('javascript:alert(1)'), null);
  assert.equal(S.typeLienDossier('pas un lien'), null);
  assert.equal(S.lienDossierCanonique('http://senat.fr/dossierleg/ppl25-123.html#x'), 'https://www.senat.fr/dossier-legislatif/ppl25-123.html');
});

// ------------------------------------------------------------------ plan de synchronisation
const it = (uid, j, titre = 'Réunion ' + uid, o = {}) => Object.assign({ uid, titre, debut: paris(2026, 11, j, 9), fin: paris(2026, 11, j, 11), journee: false, lieu: '', description: '', url: '', annule: false }, o);
// Applique un plan à une « table » en mémoire, comme le ferait Grist
function appliquer(table, plan, sourceId) {
  let id = Math.max(0, ...table.map(r => r.id));
  for (const c of plan.ajouts) table.push({ id: ++id, Notes: '', ...c });
  for (const m of plan.modifs) Object.assign(table.find(r => r.id === m.id), m.champs);
  const sup = new Set(plan.suppressions);
  return table.filter(r => !sup.has(r.id) && (sourceId === undefined || true));
}

test('plan : ajout, rien si inchangé, retouches locales gardées, source qui fait foi quand elle change', () => {
  let t = [];
  const flux = items => ({ nombre: items.length, horizon: Math.max(...items.map(i => i.debut)) });
  let items = [it('a', 25), it('b', 26), it('c', 27)];
  let p = S.planifier({ sourceId: 3, items, existants: t, maintenant: MAINTENANT, mode: 'flux', flux: flux(items) });
  assert.equal(p.stats.ajoutes, 3);
  assert.equal(p.ajouts[0].Cree_par, S.SYNC_AUTEUR);
  t = appliquer(t, p);
  p = S.planifier({ sourceId: 3, items, existants: t, maintenant: MAINTENANT, mode: 'flux', flux: flux(items) });
  assert.deepEqual([p.stats.ajoutes, p.stats.modifies, p.stats.inchanges], [0, 0, 3]);
  // Un membre corrige l'heure de fin (inconnue du Sénat) : gardée tant que la source ne change pas
  t.find(r => r.UID === 'a').Fin = paris(2026, 11, 25, 13);
  p = S.planifier({ sourceId: 3, items, existants: t, maintenant: MAINTENANT, mode: 'flux', flux: flux(items) });
  assert.equal(p.modifs.length, 0);
  // La source change le titre : elle fait foi, les notes ne sont pas touchées
  t.find(r => r.UID === 'a').Notes = 'Y aller';
  items = [it('a', 25, 'Réunion a (modifiée)'), it('b', 26), it('c', 27)];
  p = S.planifier({ sourceId: 3, items, existants: t, maintenant: MAINTENANT, mode: 'flux', flux: flux(items) });
  assert.equal(p.stats.modifies, 1);
  assert.equal(p.modifs[0].champs.Titre, 'Réunion a (modifiée)');
  assert.ok(!('Notes' in p.modifs[0].champs));
});

test('plan : disparu du flux -> supprimé, ou marqué s’il porte des notes ; passé et flux vide intouchés', () => {
  const t = [
    { id: 1, UID: 'passe', Debut: paris(2026, 11, 20, 9), Notes: '', Empreinte: 'x' },
    { id: 2, UID: 'annote', Debut: paris(2026, 11, 26, 9), Notes: 'important', Empreinte: 'x' },
    { id: 3, UID: 'nu', Debut: paris(2026, 11, 27, 9), Notes: '', Empreinte: 'x' },
    { id: 4, UID: 'loin', Debut: paris(2027, 3, 1, 9), Notes: '', Empreinte: 'x' },
  ];
  const items = [it('autre', 30)];
  const p = S.planifier({ sourceId: 3, items, existants: t, maintenant: MAINTENANT, mode: 'flux', flux: { nombre: 1, horizon: paris(2026, 12, 15) } });
  assert.deepEqual(p.suppressions, [3]);
  assert.deepEqual(p.modifs.map(m => [m.id, m.champs.Statut]), [[2, S.STATUT_RETIRE]]);
  const vide = S.planifier({ sourceId: 3, items: [], existants: t, maintenant: MAINTENANT, mode: 'flux', flux: { nombre: 0, horizon: 0 } });
  assert.equal(vide.suppressions.length + vide.modifs.length, 0, 'flux vide : rien n’est retiré');
  const imp = S.planifier({ sourceId: 2, items, existants: t, maintenant: MAINTENANT, mode: 'import' });
  assert.equal(imp.suppressions.length + imp.modifs.length, 0, 'un import ne retire jamais rien');
  assert.equal(imp.ajouts[0].Cree_par, undefined, 'import : l’auteur est le compte connecté (déclencheur)');
});

test('plan : événement revenu dans le flux rétabli ; doublons nettoyés ; annulation', () => {
  const a = it('a', 25);
  const fp = S.empreinteItem(a);
  const t = [
    { id: 1, UID: 'a', Debut: a.debut, Notes: 'n', Empreinte: fp, Statut: S.STATUT_RETIRE },
    { id: 2, UID: 'b', Debut: a.debut, Notes: '', Empreinte: 'x' },
    { id: 3, UID: 'b', Debut: a.debut, Notes: '', Empreinte: 'x' },
  ];
  const p = S.planifier({ sourceId: 3, items: [a, it('b', 25, 'B', { annule: true })], existants: t, maintenant: MAINTENANT, mode: 'flux', flux: { nombre: 2, horizon: a.debut } });
  assert.equal(p.stats.retablis, 1);
  assert.equal(p.modifs.find(m => m.id === 1).champs.Statut, null);
  assert.deepEqual(p.suppressions, [3]);
  assert.equal(p.modifs.find(m => m.id === 2).champs.Statut, S.STATUT_ANNULE);
});

test('plan -> actions Grist en un lot', () => {
  const p = S.planifier({ sourceId: 3, items: [it('a', 25), it('b', 26, 'B', { dossier: 7 })], existants: [], maintenant: MAINTENANT, mode: 'flux', flux: { nombre: 2, horizon: paris(2026, 11, 26) } });
  const [ajout] = S.actionsDuPlan('Evenements', p);
  assert.equal(ajout[0], 'BulkAddRecord');
  assert.deepEqual(ajout[2], [null, null]);
  assert.deepEqual(ajout[3].Dossier, [null, 7]);
  assert.deepEqual(ajout[3].Source, [3, 3]);
  assert.match(S.resumer(p.stats), /^2 événements retenus · 2 ajoutés$/);
});

test('plan : rattachement à un dossier rendu par la source, jamais effacé s’il a été posé à la main', () => {
  const a = it('a', 25, 'A', { dossier: 7 }), b = it('b', 26, 'B');
  const t = [
    { id: 1, UID: 'a', Debut: a.debut, Notes: '', Empreinte: S.empreinteItem(a), Dossier: 0 },
    { id: 2, UID: 'b', Debut: b.debut, Notes: '', Empreinte: S.empreinteItem(b), Dossier: 9 },
  ];
  const p = S.planifier({ sourceId: 3, items: [a, b], existants: t, maintenant: MAINTENANT, mode: 'flux', flux: { nombre: 2, horizon: b.debut } });
  assert.deepEqual(p.modifs.map(m => [m.id, m.champs.Dossier]), [[1, 7]], 'lien rétabli pour a ; b garde son rattachement manuel');
});
