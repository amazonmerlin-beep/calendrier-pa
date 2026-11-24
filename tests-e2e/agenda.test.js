'use strict';
// Parcours dans le navigateur (Grist local) : synchronisation réelle des flux du Sénat, semaine et mois, fiche,
// création, dossier suivi, import d'une invitation Outlook, compte non reconnu. Captures dans tests-e2e/captures/.
// Usage : node --test --test-concurrency=1 tests-e2e/agenda.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { client, docCourant } = require('../outils/lib/cles');
const { navigateur, ouvrir, capturer, cliquer } = require('./navigateur');
const config = require('../projet.config');

const DOC = docCourant().docId;
const FIX = path.join(__dirname, '..', 'tests', 'fixtures');
let nav, ctx, page, m, proprio;

const attendre = (f, cond, delai = 90000) => f.waitForFunction(cond, null, { timeout: delai, polling: 500 });

test.before(async () => {
  proprio = await client();
  await proprio.upsert(DOC, 'Annuaire', config.comptesTest.map(([Email, Nom, Role]) => ({ require: { Email }, fields: { Nom, Role, Actif: true } })));
  nav = await navigateur({ largeur: 1440, hauteur: 960 });
  ctx = await nav.nouveau();
  ({ page, module: m } = await ouvrir(ctx, 'membre@projet.test', 'Membre'));
});
test.after(async () => { if (nav) await nav.b.close(); });

test('ouverture : agenda de la semaine, synchronisation automatique des flux du Sénat', async () => {
  assert.equal(await m.evaluate(() => Formulaire.core.etat.vue), 'agenda');
  assert.equal(await m.evaluate(() => Formulaire.core.etat.moi.role), 'membre');
  await attendre(m, () => (Formulaire.core.etat.doc.Evenements || []).length > 0 && !Formulaire.synchro.etat.enCours);
  const bilan = await m.evaluate(() => Formulaire.core.etat.doc.Sources.filter(s => s.Active).map(s => [s.Nom, s.Resultat_synchro]));
  for (const [nom, res] of bilan) assert.doesNotMatch(res || '', /^⚠/, `${nom} : ${res}`);
  await page.waitForTimeout(800);
  await capturer(page, '01-semaine');
  assert.ok(await m.$('.ag-semaine .ag-evt'), 'des événements dans la semaine');
});

test('mois, puis retour à la semaine par un jour', async () => {
  await cliquer(m, '[data-action="ag-mode"][data-mode="mois"]');
  await m.waitForSelector('.ag-mois');
  await capturer(page, '02-mois');
  await cliquer(m, '.ag-mois td:not(.hors) [data-action="ag-jour"]');
  await m.waitForSelector('.ag-semaine');
});

test('fiche d’un événement du Sénat : lien vers sa fiche, mention de l’heure de fin', async () => {
  await cliquer(m, '[data-action="ag-auj"]');
  await cliquer(m, '.ag-semaine .ag-evt');
  await m.waitForSelector('.voile .fenetre');
  const lien = await m.$eval('.voile .fenetre', f => (f.querySelector('a[href*="agenda.senat.fr"]') || {}).href || '');
  assert.match(lien, /^https:\/\/agenda\.senat\.fr\/\d{4}\/\d{2}\/\d{2}\/event\/\d+$/);
  await capturer(page, '03-fiche');
  await m.$eval('.voile .actions .btn.secondaire', b => b.click());
});

test('création d’un événement : erreurs sous les champs, puis enregistrement au nom du compte', async () => {
  await cliquer(m, '.ag-outils [data-action="ag-nouveau"]');
  await m.waitForSelector('#f-titre');
  await m.$eval('.voile .actions .btn:not(.secondaire)', b => b.click());
  assert.equal(await m.$eval('#f-titre', el => el.getAttribute('aria-invalid')), 'true', 'titre manquant signalé');
  await m.fill('#f-titre', 'Rendez-vous cabinet');
  await m.fill('#f-lieu', 'Ministère');
  await m.fill('#f-hd', '14:00');
  await m.fill('#f-hf', '15:30');
  await capturer(page, '04-nouveau');
  await m.$eval('.voile .actions .btn:not(.secondaire)', b => b.click());
  const ev = await (async () => { for (let i = 0; i < 40; i++) { const r = (await proprio.lignes(DOC, 'Evenements')).find(x => x.Titre === 'Rendez-vous cabinet'); if (r) return r; await new Promise(z => setTimeout(z, 250)); } return null; })();
  assert.ok(ev, 'événement créé');
  assert.equal(ev.Cree_par, 'membre@projet.test');
  assert.equal(ev.Lieu, 'Ministère');
});

test('dossier suivi : lien du Sénat analysé, séances rattachées', async () => {
  await cliquer(m, '.onglets [data-vue="dossiers"]');
  await m.fill('#lien-dossier', 'https://www.senat.fr/dossier-legislatif/pjlf2027.html');
  await m.click('[data-action="suivre-dossier"]');
  await attendre(m, () => (Formulaire.core.etat.doc.Dossiers || []).some(d => d.Etat === 'Suivi actif' && d.Nb_evenements > 0) && !Formulaire.synchro.etat.enCours);
  const d = (await proprio.lignes(DOC, 'Dossiers'))[0];
  assert.equal(d.Titre, 'Budget 2027');
  assert.match(d.Numeros, /n° 155 \(2026-2027\)/);
  assert.equal(d.Ajoute_par, 'membre@projet.test');
  await page.waitForTimeout(500);
  await capturer(page, '05-dossiers');
  await cliquer(m, `[data-action="dossier-agenda"][data-id="${d.id}"]`);
  await m.waitForSelector('.ag-semaine');
  await capturer(page, '06-agenda-dossier');
});

test('lien qui n’est pas un dossier : refusé avec un message sous le champ', async () => {
  await cliquer(m, '.onglets [data-vue="dossiers"]');
  await m.fill('#lien-dossier', 'https://www.senat.fr/agenda/');
  await cliquer(m, '[data-action="suivre-dossier"]');
  await m.waitForSelector('#lien-dossier-err:not([hidden])');
  assert.equal((await proprio.lignes(DOC, 'Dossiers')).length, 1);
});

test('import d’une invitation Outlook récurrente', async () => {
  await cliquer(m, '.onglets [data-vue="sources"]');
  await m.setInputFiles('[data-action-fichier="lire-ics"]', path.join(FIX, 'outlook-invitation.ics'));
  await m.waitForSelector('[data-action="ics-importer"]');
  await capturer(page, '07-import');
  await cliquer(m, '[data-action="ics-importer"]');
  for (let i = 0; i < 40 && !(await proprio.lignes(DOC, 'Evenements')).some(x => /Point équipe/.test(x.Titre)); i++) await page.waitForTimeout(250);
  const evs = (await proprio.lignes(DOC, 'Evenements')).filter(x => /Point équipe/.test(x.Titre));
  assert.equal(evs.length, 5);
  assert.ok(evs.every(x => x.Cree_par === 'membre@projet.test'));
  await page.waitForTimeout(500);
  await capturer(page, '08-sources');
});

test('droits : un membre ne change pas les sources suivies ; un inconnu ne voit rien', async () => {
  const membre = await client('membre@projet.test', 'Membre');
  const [s] = await proprio.lignes(DOC, 'Sources', { filtre: { Nom: ['Commission des finances'] } });
  await assert.rejects(membre.modifier(DOC, 'Sources', [{ id: s.id, Active: true }]));
  await assert.rejects(membre.ajouter(DOC, 'Evenements', [{ Titre: 'Usurpé', Cree_par: 'autre@projet.test' }]));
  const inconnu = await client('inconnu@ailleurs.test', 'Inconnu');
  const lus = await inconnu.lignes(DOC, 'Evenements').catch(() => []);
  assert.equal(lus.length, 0);
  const ctx2 = await nav.nouveau();
  const { page: p2, module: m2 } = await ouvrir(ctx2, 'inconnu@ailleurs.test', 'Inconnu');
  assert.equal(await m2.evaluate(() => Formulaire.core.etat.vue), 'inconnu');
  await capturer(p2, '09-inconnu');
  await ctx2.close();
});

test('administration : abonnement à un agenda Google ; son adresse secrète reste illisible pour un membre', async () => {
  const SECRET = 'https://calendar.google.com/calendar/ical/equipe%40example.org/private-0123456789abcdef/basic.ics';
  const ctx3 = await nav.nouveau();
  const { page: p3, module: m3 } = await ouvrir(ctx3, 'admin@projet.test', 'Admin projet');
  await cliquer(m3, '.onglets [data-vue="sources"]');
  await m3.waitForSelector('[data-action="ajouter-agenda"]');
  await m3.$eval('[data-action="ajouter-agenda"]', b => b.click());
  await m3.waitForSelector('#ag-nom[aria-invalid="true"]');
  await m3.fill('#ag-nom', 'Agenda équipe');
  await m3.fill('#ag-url', 'http://pas-sur.example.org/agenda.ics');
  await m3.click('[data-action="ajouter-agenda"]');
  await m3.waitForSelector('#ag-url[aria-invalid="true"]');
  await m3.fill('#ag-url', SECRET);
  await m3.click('[data-action="ajouter-agenda"]');
  let s = null;
  for (let i = 0; i < 40 && !s; i++) { s = (await proprio.lignes(DOC, 'Sources')).find(x => x.Nom === 'Agenda équipe'); if (!s) await p3.waitForTimeout(250); }
  assert.ok(s, 'source créée');
  assert.deepEqual([s.Type, s.Groupe, s.Active, s.URL], ['Flux via relais', 'Agenda externe', true, SECRET]);
  // Après l'ajout, le formulaire est vidé et l'erreur précédente effacée
  await m3.waitForFunction(() => { const u = document.getElementById('ag-url'); return u && u.value === '' && !u.getAttribute('aria-invalid'); }, null, { timeout: 10000 });
  await capturer(p3, '10-abonnement');
  await ctx3.close();
  const membre = await client('membre@projet.test', 'Membre');
  const vu = (await membre.lignes(DOC, 'Sources')).find(x => x.id === s.id);
  assert.ok(vu, 'le membre voit la source');
  assert.notEqual(vu.URL, SECRET, 'mais pas son adresse secrète');
  assert.equal(await m.$('[data-action="ajouter-agenda"]'), null, 'pas de formulaire pour un membre');
});
