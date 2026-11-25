'use strict';
// Relais GitHub contre le Grist local : un dossier de l'Assemblée nationale suivi, le relais dépose les réunions
// (open data de l'Assemblée), le module les intègre et les rattache au dossier.
// Usage : AN_AGENDA_ZIP=/chemin/Agenda.json.zip node --test tests-e2e/relais.test.js
//   (sans AN_AGENDA_ZIP, le relais télécharge le fichier du jour, 9 Mo environ)
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');
const { client, cle, docCourant, BASE } = require('../outils/lib/cles');
const { navigateur, ouvrir, cliquer } = require('./navigateur');
const config = require('../projet.config');

const DOC = docCourant().docId;
const LIEN_AN = 'https://www.assemblee-nationale.fr/dyn/17/dossiers/PLF_2027';

test('relais : dossier de l’Assemblée nationale suivi, réunions déposées puis intégrées par le module', async () => {
  const proprio = await client();
  await proprio.upsert(DOC, 'Annuaire', config.comptesTest.map(([Email, Nom, Role]) => ({ require: { Email }, fields: { Nom, Role, Actif: true } })));
  const membre = await client('membre@projet.test', 'Membre');
  const existants = await proprio.lignes(DOC, 'Dossiers');
  if (!existants.some(d => d.Lien === LIEN_AN)) await membre.ajouter(DOC, 'Dossiers', [{ Lien: LIEN_AN, Etat: 'À analyser' }]);

  // Le relais tourne sous le compte d'administration (rôle « admin » de l'annuaire), comme le compte robot
  const sortie = execFileSync(process.execPath, [path.join(__dirname, '..', 'relais', 'relais.mjs')], {
    env: { ...process.env, GRIST_URL: BASE, GRIST_DOC: DOC, GRIST_API_KEY: await cle('admin@projet.test', 'Admin projet') },
    encoding: 'utf8', timeout: 300000,
  });
  assert.match(sortie, /Assemblée nationale : \d+ réunions lues, [1-9]\d* rattachées/, sortie);
  const [an] = await proprio.lignes(DOC, 'Sources', { filtre: { Nom: ['Assemblée nationale (dossiers suivis)'] } });
  assert.match(an.Contenu_relaye, /^BEGIN:VCALENDAR/);
  const d = (await proprio.lignes(DOC, 'Dossiers')).find(x => x.Lien === LIEN_AN);
  assert.equal(d.Etat, 'Suivi actif');
  assert.match(d.Resultat, /DLR5L17N54629/);
  assert.match(d.Resultat, /\d+ réunions ou séances de l’Assemblée sur ce dossier, la dernière le \d{1,2} \S+ \d{4}/, d.Resultat);
  assert.ok(d.Titre && !/Dossiers législatifs|Assemblée nationale$/.test(d.Titre), `titre nettoyé : ${d.Titre}`);

  // Un membre ouvre l'agenda et synchronise : les réunions de l'Assemblée arrivent, rattachées au dossier
  const nav = await navigateur();
  try {
    const ctx = await nav.nouveau();
    const { module: m } = await ouvrir(ctx, 'membre@projet.test', 'Membre');
    await m.waitForFunction(() => !Formulaire.synchro.etat.enCours, null, { timeout: 90000 });
    await cliquer(m, '[data-action="synchroniser"]');
    await m.waitForFunction(id => (Formulaire.core.etat.doc.Evenements || []).some(e => e.Source === id && e.Dossier) && !Formulaire.synchro.etat.enCours, an.id, { timeout: 90000 });
  } finally { await nav.b.close(); }
  const evs = (await proprio.lignes(DOC, 'Evenements')).filter(e => e.Source === an.id);
  assert.ok(evs.length > 0);
  assert.ok(evs.every(e => e.Dossier === d.id || e.Dossier), 'chaque réunion rattachée à un dossier');
  assert.ok(evs.some(e => e.Fin - e.Debut !== 7200), 'heures de fin réelles (pas la durée fixe du Sénat)');
});

test('robustesse : une panne de l’Assemblée n’empêche ni la synchronisation du Sénat ni le reste ; le passage finit en échec', async () => {
  const proprio = await client();
  const lois = (await proprio.lignes(DOC, 'Sources', { filtre: { Nom: ['Commission des lois'] } }))[0];
  const avant = lois.Derniere_synchro || 0;
  let code = 0, sortie = '';
  try {
    execFileSync(process.execPath, [path.join(__dirname, '..', 'relais', 'relais.mjs')], {
      env: { ...process.env, GRIST_URL: BASE, GRIST_DOC: DOC, GRIST_API_KEY: await cle('admin@projet.test', 'Admin projet'), AN_AGENDA_ZIP: '/inexistant/Agenda.json.zip' },
      encoding: 'utf8', timeout: 300000, stdio: 'pipe',
    });
  } catch (e) { code = e.status; sortie = String(e.stdout) + String(e.stderr); }
  assert.equal(code, 1, 'passage en échec, visible dans GitHub Actions');
  assert.match(sortie, /Synchronisation : \d+ flux lus/, 'la synchronisation a eu lieu');
  assert.match(sortie, /Relais terminé avec des erreurs/);
  const apres = (await proprio.lignes(DOC, 'Sources', { filtre: { Nom: ['Commission des lois'] } }))[0];
  assert.ok(apres.Derniere_synchro > avant, 'commission des lois relue malgré la panne');
  const an = (await proprio.lignes(DOC, 'Sources', { filtre: { Nom: ['Assemblée nationale (dossiers suivis)'] } }))[0];
  assert.match(an.Resultat_synchro, /^⚠ Relais : agenda de l’Assemblée nationale illisible/);
  assert.ok((await proprio.lignes(DOC, 'Evenements')).some(e => e.Source === an.id), 'événements de l’Assemblée gardés');
});
