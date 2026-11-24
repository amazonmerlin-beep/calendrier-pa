'use strict';
// Diffusion de bout en bout sur le Grist local : l'administration crée et publie un abonnement (écran Diffusion),
// le relais le publie (faux serveur de gists, local : rien n'est écrit chez GitHub), l'adresse revient dans
// l'écran, un événement « Interne » ne part pas, l'arrêt supprime la publication.
// Usage : node --test --test-concurrency=1 tests-e2e/diffusion.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { client, cle, docCourant, BASE } = require('../outils/lib/cles');
const { navigateur, ouvrir, cliquer, capturer } = require('./navigateur');
const config = require('../projet.config');

const DOC = docCourant().docId;
let serveur, gists = {}, appels = [], RAW, API;

// Faux service de gists : création, mise à jour, suppression
function demarrerFauxGitHub() {
  return new Promise(res => {
    serveur = http.createServer((req, rep) => {
      let corps = '';
      req.on('data', c => { corps += c; });
      req.on('end', () => {
        appels.push(`${req.method} ${req.url} ${req.headers.authorization || ''}`);
        const m = /^\/gists(?:\/(\w+))?$/.exec(req.url);
        const repondre = (code, o) => { rep.writeHead(code, { 'Content-Type': 'application/json' }); rep.end(o ? JSON.stringify(o) : ''); };
        if (!m) return repondre(404);
        if (req.method === 'POST') { const id = 'g' + (Object.keys(gists).length + 1); gists[id] = JSON.parse(corps); return repondre(201, { id, owner: { login: 'essai' } }); }
        if (!gists[m[1]]) return repondre(404);
        if (req.method === 'PATCH') { Object.assign(gists[m[1]].files, JSON.parse(corps).files); return repondre(200, { id: m[1], owner: { login: 'essai' } }); }
        if (req.method === 'DELETE') { delete gists[m[1]]; return repondre(204); }
        repondre(405);
      });
    }).listen(0, '127.0.0.1', () => { API = `http://127.0.0.1:${serveur.address().port}`; RAW = `${API}/raw`; res(); });
  });
}
// Relais lancé en asynchrone : le faux serveur tourne dans ce processus et doit pouvoir répondre pendant ce temps
async function relais(env = {}) {
  const { stdout } = await promisify(execFile)(process.execPath, [path.join(__dirname, '..', 'relais', 'relais.mjs')], {
    env: { ...process.env, GRIST_URL: BASE, GRIST_DOC: DOC, GRIST_API_KEY: await cle('admin@projet.test', 'Admin projet'), GIST_API: API, GIST_RAW: RAW, GIST_TOKEN: 'jeton-essai', ...env },
    encoding: 'utf8', timeout: 300000,
  });
  return stdout;
}

let proprio, nav, idSaisie, idPublic, idInterne;
// Nombre attendu, calculé sur les données (d'autres parcours ont pu ajouter des saisies) : même règle que diffusion.js
async function attendus() {
  const depuis = Math.floor(Date.now() / 1000) - 60 * 86400;
  return (await proprio.lignes(DOC, 'Evenements')).filter(e => e.Source === idSaisie && e.Diffusion !== 'Interne' && !e.Statut
    && Math.max(e.Fin || e.Debut, e.Debut) >= depuis).length;
}
const pluriel = (n, s) => `${n} ${s}${n > 1 ? 's' : ''}`;
test.before(async () => {
  await demarrerFauxGitHub();
  proprio = await client();
  await proprio.upsert(DOC, 'Annuaire', config.comptesTest.map(([Email, Nom, Role]) => ({ require: { Email }, fields: { Nom, Role, Actif: true } })));
  // Deux événements saisis par un membre, dont un « Interne »
  const membre = await client('membre@projet.test', 'Membre');
  const t = Math.floor(Date.now() / 1000) + 86400;
  [idPublic, idInterne] = await membre.ajouter(DOC, 'Evenements', [
    { Titre: 'Point presse diffusable', Debut: t, Fin: t + 3600, Lieu: 'Salle 2', Notes: 'secret de l’équipe' },
    { Titre: 'Réunion strictement interne', Debut: t, Fin: t + 3600, Diffusion: 'Interne' },
  ]);
  idSaisie = (await proprio.lignes(DOC, 'Sources', { filtre: { Type: ['Saisie manuelle'] } }))[0].id;
  for (const a of await proprio.lignes(DOC, 'Abonnements')) await proprio.req('POST', `/api/docs/${DOC}/apply`, [['RemoveRecord', 'Abonnements', a.id]]);
  nav = await navigateur({ largeur: 1440, hauteur: 960 });
});
test.after(async () => { if (nav) await nav.b.close(); if (serveur) serveur.close(); });

test('onglet Diffusion : administration seulement ; un membre ne lit pas les abonnements', async () => {
  const membre = await client('membre@projet.test', 'Membre');
  assert.deepEqual(await membre.lignes(DOC, 'Abonnements').catch(() => []), []);
  assert.ok(!config.onglets.membre.some(([v]) => v === 'diffusion'));
  await assert.rejects(membre.ajouter(DOC, 'Abonnements', [{ Nom: 'pirate', Actif: true }]));
});

test('l’administration crée un abonnement, voit l’aperçu, publie après confirmation', async () => {
  const ctx = await nav.nouveau();
  const { page, module: m } = await ouvrir(ctx, 'admin@projet.test', 'Admin projet');
  await cliquer(m, '.onglets [data-vue="diffusion"]');
  await cliquer(m, '[data-action="abo-nouveau"]');
  const id = (await proprio.lignes(DOC, 'Abonnements'))[0].id;
  await m.waitForSelector(`#abo-nom-${id}`);
  await m.fill(`#abo-nom-${id}`, 'Agenda de l’équipe PA');
  await m.$eval(`#abo-nom-${id}`, el => el.dispatchEvent(new Event('change', { bubbles: true })));
  await m.click(`[data-change="abo-source"][data-abo="${id}"][value="${idSaisie}"]`);
  const apercu = await m.$eval(`#apercu-${id}`, el => el.textContent);
  const n = await attendus();
  assert.ok(n >= 1);
  assert.ok(apercu.startsWith(`${pluriel(n, 'événement')} ${n > 1 ? 'diffusés' : 'diffusé'}`), `aperçu : ${apercu} (attendu : ${n}, l’événement interne exclu)`);
  await capturer(page, '11-diffusion');
  await m.click(`[data-action="abo-publier"][data-abo="${id}"]`);
  await m.waitForSelector('.voile .fenetre');
  assert.match(await m.$eval('.voile .fenetre', f => f.textContent), /Toute personne qui aura l’adresse/);
  await m.$eval('.voile .actions .btn:not(.secondaire)', b => b.click());
  let a;
  for (let i = 0; i < 40; i++) { a = (await proprio.lignes(DOC, 'Abonnements'))[0]; if (a.Actif) break; await page.waitForTimeout(250); }
  assert.equal(a.Actif, true);
  assert.equal(a.Nom, 'Agenda de l’équipe PA');
  assert.deepEqual(a.Sources, ['L', idSaisie]);
  assert.equal(a.Niveau, 'Titres et horaires');
  await ctx.close();
});

test('le relais publie : adresse notée, contenu choisi, rien d’interne ni de détail, journal sans nom', async () => {
  const sortie = await relais();
  const n = await attendus();
  assert.match(sortie, new RegExp(`Abonnement n° \\d+ : ${n} événements publiés\\.`));
  assert.doesNotMatch(sortie, /Agenda de l’équipe PA|essai\/g1/, 'journal public : ni nom ni adresse');
  const a = (await proprio.lignes(DOC, 'Abonnements'))[0];
  assert.equal(a.Gist, 'g1');
  assert.equal(a.Adresse, `${RAW}/essai/g1/raw/calendrier-pa.ics`);
  assert.equal(a.Resultat, `${pluriel(n, 'événement')} ${n > 1 ? 'publiés' : 'publié'}.`);
  assert.equal((gists.g1.files['calendrier-pa.ics'].content.match(/BEGIN:VEVENT/g) || []).length, n);
  assert.ok(appels.some(x => /^POST \/gists Bearer jeton-essai$/.test(x)));
  const ics = gists.g1.files['calendrier-pa.ics'].content;
  assert.match(ics, /SUMMARY:Point presse diffusable/);
  assert.doesNotMatch(ics, /strictement interne/);
  assert.doesNotMatch(ics, /Salle 2|secret de l’équipe/, 'niveau « Titres et horaires »');
  assert.equal(gists.g1.public, false, 'gist secret');
  // Deuxième passage : même gist, mis à jour
  await relais();
  assert.ok(appels.some(x => /^PATCH \/gists\/g1 /.test(x)));
  assert.equal(Object.keys(gists).length, 1);
});

test('l’adresse s’affiche dans l’écran Diffusion', async () => {
  const ctx = await nav.nouveau();
  const { page, module: m } = await ouvrir(ctx, 'admin@projet.test', 'Admin projet');
  await cliquer(m, '.onglets [data-vue="diffusion"]');
  const id = (await proprio.lignes(DOC, 'Abonnements'))[0].id;
  await m.waitForSelector(`#abo-url-${id}`);
  assert.equal(await m.$eval(`#abo-url-${id}`, el => el.value), `${RAW}/essai/g1/raw/calendrier-pa.ics`);
  assert.equal(await m.$eval(`#abo-${id} [data-etat]`, el => el.dataset.etat), 'publie');
  await capturer(page, '12-diffusion-publiee');
  await ctx.close();
});

test('arrêt : le relais supprime la publication ; sans jeton GitHub, l’échec est signalé', async () => {
  const a = (await proprio.lignes(DOC, 'Abonnements'))[0];
  await proprio.modifier(DOC, 'Abonnements', [{ id: a.id, Actif: false }]);
  await relais();
  assert.ok(appels.some(x => /^DELETE \/gists\/g1 /.test(x)));
  const b = (await proprio.lignes(DOC, 'Abonnements'))[0];
  assert.deepEqual([b.Gist, b.Adresse], ['', '']);
  await proprio.modifier(DOC, 'Abonnements', [{ id: a.id, Actif: true }]);
  await relais({ GIST_TOKEN: '' });
  assert.match((await proprio.lignes(DOC, 'Abonnements'))[0].Resultat, /^⚠ publication impossible : le jeton GitHub GIST_TOKEN/);
  await proprio.modifier(DOC, 'Abonnements', [{ id: a.id, Actif: false }]);
});
