'use strict';
// Accès gérés depuis le module, sur le Grist local :
//  - la page « Règles d'accès » de Grist n'affiche aucune erreur ;
//  - une personne connectée, hors annuaire, demande un accès ; l'administration l'accepte dans l'onglet Comptes ;
//    l'écran de la personne s'ouvre de lui-même ;
//  - l'administration ajoute un compte, change un rôle (confirmé), coupe un accès ; elle ne peut pas se retirer ses droits ;
//  - « Quoi de neuf » signale ce qu'un autre a ajouté depuis la dernière visite ; vue Liste.
// Usage : node --test --test-concurrency=1 tests-e2e/acces-comptes.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { client, docCourant, BASE } = require('../outils/lib/cles');
const { navigateur, ouvrir, cliquer, capturer } = require('./navigateur');
const config = require('../projet.config');

const DOC = docCourant().docId;
let proprio, nav;
const attendreLigne = async (table, filtre, delai = 20000) => {
  const fin = Date.now() + delai;
  while (Date.now() < fin) { const r = (await proprio.lignes(DOC, table)).find(filtre); if (r) return r; await new Promise(z => setTimeout(z, 300)); }
  return null;
};

test.before(async () => {
  proprio = await client();
  await proprio.upsert(DOC, 'Annuaire', config.comptesTest.map(([Email, Nom, Role]) => ({ require: { Email }, fields: { Nom, Role, Actif: true } })));
  for (const t of ['Demandes']) for (const r of await proprio.lignes(DOC, t)) await proprio.req('POST', `/api/docs/${DOC}/apply`, [['RemoveRecord', t, r.id]]);
  for (const r of (await proprio.lignes(DOC, 'Annuaire')).filter(x => /candidat|ajoute/.test(x.Email))) await proprio.req('POST', `/api/docs/${DOC}/apply`, [['RemoveRecord', 'Annuaire', r.id]]);
  nav = await navigateur({ largeur: 1440, hauteur: 960 });
});
test.after(async () => { if (nav) await nav.b.close(); });

test('page « Règles d’accès » de Grist : aucune erreur', async () => {
  const ctx = await nav.nouveau();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/test/login?username=proprietaire@projet.test&next=${encodeURIComponent(`${BASE}/o/docs/doc/${DOC}/p/acl`)}`);
  await page.waitForSelector('.test-rule-set', { timeout: 60000 });
  await page.waitForTimeout(1500);
  const texte = await page.evaluate(() => document.body.innerText);
  assert.doesNotMatch(texte, /condition ne peut pas être vide|condition cannot be blank/i);
  await ctx.close();
});

test('demande d’accès : la personne la dépose, l’administration l’accepte, l’écran s’ouvre de lui-même', async () => {
  const ctxC = await nav.nouveau();
  const { page: pC, module: mC } = await ouvrir(ctxC, 'candidat@ailleurs.test', 'Camille Candidat');
  assert.equal(await mC.evaluate(() => Formulaire.core.etat.vue), 'inconnu');
  await mC.fill('#demande-message', 'Équipe affaires publiques');
  await cliquer(mC, '[data-action="demander-acces"]');
  await mC.waitForSelector('[data-etat="demande-en-attente"]', { timeout: 20000 });
  const d = await attendreLigne('Demandes', x => x.Email === 'candidat@ailleurs.test');
  assert.deepEqual([d.Statut, d.Nom, d.Message], ['En attente', 'Camille Candidat', 'Équipe affaires publiques']);
  await capturer(pC, '14-demande-acces');
  // Une demande au nom d'un autre est refusée par les règles
  const autre = await client('intrus@ailleurs.test', 'Intrus');
  await assert.rejects(autre.ajouter(DOC, 'Demandes', [{ Email: 'quelquun@ailleurs.test', Statut: 'Acceptée' }]));

  const ctxA = await nav.nouveau();
  const { page: pA, module: mA } = await ouvrir(ctxA, 'admin@projet.test', 'Admin projet');
  await cliquer(mA, '.onglets [data-vue="comptes"]');
  await mA.waitForSelector(`[data-action="accepter-demande"][data-id="${d.id}"][data-role="membre"]`);
  await capturer(pA, '15-comptes');
  await cliquer(mA, `[data-action="accepter-demande"][data-id="${d.id}"][data-role="membre"]`);
  const compte = await attendreLigne('Annuaire', x => x.Email === 'candidat@ailleurs.test');
  assert.deepEqual([compte.Role, compte.Actif], ['membre', true]);
  assert.equal((await proprio.lignes(DOC, 'Demandes')).find(x => x.id === d.id).Statut, 'Acceptée');
  // L'écran de la personne passe à l'agenda sans rechargement (veille)
  await mC.waitForFunction(() => Formulaire.core.etat.vue === 'agenda', null, { timeout: 70000 });
  await ctxC.close();

  // Ajout d'un compte, erreurs sous le champ ; changement de rôle confirmé ; ses propres droits intouchables
  await mA.fill('#compte-email', 'pas-une-adresse');
  await mA.click('[data-action="ajouter-compte"]');
  await mA.waitForSelector('#compte-email[aria-invalid="true"]');
  await mA.fill('#compte-email', 'ajoute@projet.test');
  await mA.fill('#compte-nom', 'Compte ajouté');
  await mA.click('[data-action="ajouter-compte"]');
  const ajoute = await attendreLigne('Annuaire', x => x.Email === 'ajoute@projet.test');
  assert.deepEqual([ajoute.Role, ajoute.Actif], ['membre', true]);
  await mA.waitForSelector(`#role-${ajoute.id}`);
  await mA.selectOption(`#role-${ajoute.id}`, 'admin');
  await mA.waitForSelector('.voile .fenetre');
  await mA.$eval('.voile .actions .btn:not(.secondaire)', b => b.click());
  assert.equal((await attendreLigne('Annuaire', x => x.Email === 'ajoute@projet.test' && x.Role === 'admin')).Role, 'admin');
  const moi = (await proprio.lignes(DOC, 'Annuaire')).find(x => x.Email === 'admin@projet.test');
  assert.equal(await mA.$eval(`#role-${moi.id}`, el => el.disabled), true, 'son propre rôle n’est pas modifiable');
  assert.match(await mA.$eval('#lien-document', el => el.value), /\/doc\//, 'lien du document à envoyer');
  await ctxA.close();
});

test('paramètres techniques du répertoire : lus par les inscrits, pas par un compte non inscrit', async () => {
  const p = (await proprio.lignes(DOC, 'Parametres')).find(x => x.Cle === 'repertoire_gist');
  if (!p) await proprio.ajouter(DOC, 'Parametres', [{ Cle: 'repertoire_gist', Valeur: 'essai', Libelle: 'essai' }]);
  const intrus = await client('intrus@ailleurs.test', 'Intrus');
  const vus = (await intrus.lignes(DOC, 'Parametres')).map(x => x.Cle);
  assert.ok(vus.includes('contact_email'), 'le contact reste lisible');
  assert.ok(!vus.some(c => /^repertoire_/.test(c)), vus.join(', '));
  const membre = await client('membre@projet.test', 'Membre');
  assert.ok((await membre.lignes(DOC, 'Parametres')).some(x => x.Cle === 'repertoire_gist'));
});

test('un membre ne lit ni l’annuaire ni les demandes', async () => {
  const membre = await client('membre@projet.test', 'Membre');
  assert.deepEqual(await membre.lignes(DOC, 'Annuaire').catch(() => []), []);
  assert.deepEqual(await membre.lignes(DOC, 'Demandes').catch(() => []), []);
  await assert.rejects(membre.ajouter(DOC, 'Annuaire', [{ Email: 'moi-aussi@projet.test', Role: 'admin', Actif: true }]));
});

test('« Quoi de neuf » : ce qu’un autre a ajouté depuis la dernière visite ; vue Liste', async () => {
  // Une première visite du membre, puis un ajout par un autre membre
  const ctx1 = await nav.nouveau();
  await ouvrir(ctx1, 'membre@projet.test', 'Membre');
  await ctx1.close();
  await new Promise(z => setTimeout(z, 1200));
  const m2 = await client('membre2@projet.test', 'Membre 2');
  const t = Math.floor(Date.now() / 1000) + 2 * 86400;
  await m2.ajouter(DOC, 'Evenements', [{ Titre: 'Réunion ajoutée par un collègue', Debut: t, Fin: t + 3600 }]);
  const ctx2 = await nav.nouveau();
  const { page, module: m } = await ouvrir(ctx2, 'membre@projet.test', 'Membre');
  await m.waitForSelector('#nouveautes');
  assert.match(await m.$eval('#nouveautes summary', el => el.textContent), /nouveau/);
  await m.$eval('#nouveautes', d => { d.open = true; });
  assert.match(await m.$eval('#nouveautes [data-groupe="nouveaux"]', el => el.textContent), /Réunion ajoutée par un collègue/);
  await capturer(page, '16-quoi-de-neuf');
  await cliquer(m, '[data-action="ag-mode"][data-mode="liste"]');
  await m.waitForSelector('.ag-vliste .ag-ligne-evt');
  await capturer(page, '17-liste');
  await cliquer(m, '[data-action="ag-mode"][data-mode="semaine"]');
  await m.waitForSelector('.ag-semaine');
  await capturer(page, '18-semaine');
  await ctx2.close();
});
