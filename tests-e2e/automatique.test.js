'use strict';
// Synchronisation automatique et recherche de dossiers, sur le Grist local :
//  - le relais seul (aucun navigateur ouvert) synchronise l'agenda du Sénat, en peu d'appels à l'API Grist ;
//  - il publie le répertoire des dossiers en cours (faux service de gists local, qui le sert aussi comme GitHub) ;
//  - un membre cherche « budget 2027 » dans l'onglet Dossiers et suit le dossier d'un clic.
// Usage : SENAT_DOSSIERS_CSV=… AN_DOSSIERS_ZIP=… AN_AGENDA_ZIP=… node --test --test-concurrency=1 tests-e2e/automatique.test.js
//   (sans ces variables, le relais télécharge les fichiers du jour : une vingtaine de Mo)
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
let serveur, API, RAW;
const gists = {};
function demarrerFauxGitHub() {
  return new Promise(res => {
    serveur = http.createServer((req, rep) => {
      let corps = '';
      req.on('data', c => { corps += c; });
      req.on('end', () => {
        const json = (code, o) => { rep.writeHead(code, { 'Content-Type': 'application/json' }); rep.end(o ? JSON.stringify(o) : ''); };
        // Lecture publique d'un fichier, comme gist.githubusercontent.com (CORS ouvert)
        const brut = /^\/raw\/essai\/(\w+)\/raw\/(.+)$/.exec(req.url);
        if (req.method === 'GET' && brut) {
          const f = gists[brut[1]] && gists[brut[1]].files[decodeURIComponent(brut[2])];
          rep.writeHead(f ? 200 : 404, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
          return rep.end(f ? f.content : '');
        }
        const m = /^\/gists(?:\/(\w+))?$/.exec(req.url);
        if (!m) return json(404);
        if (req.method === 'POST') { const id = 'g' + (Object.keys(gists).length + 1); gists[id] = JSON.parse(corps); return json(201, { id, owner: { login: 'essai' } }); }
        if (!gists[m[1]]) return json(404);
        if (req.method === 'PATCH') { Object.assign(gists[m[1]].files, JSON.parse(corps).files); return json(200, { id: m[1], owner: { login: 'essai' } }); }
        if (req.method === 'DELETE') { delete gists[m[1]]; return json(204); }
        json(405);
      });
    }).listen(0, '127.0.0.1', () => { API = `http://127.0.0.1:${serveur.address().port}`; RAW = `${API}/raw`; res(); });
  });
}
async function relais(env = {}) {
  const { stdout } = await promisify(execFile)(process.execPath, [path.join(__dirname, '..', 'relais', 'relais.mjs')], {
    env: { ...process.env, GRIST_URL: BASE, GRIST_DOC: DOC, GRIST_API_KEY: await cle('admin@projet.test', 'Admin projet'), GIST_API: API, GIST_RAW: RAW, GIST_TOKEN: 'jeton-essai', ...env },
    encoding: 'utf8', timeout: 600000, maxBuffer: 1 << 24,
  });
  return stdout;
}

let proprio;
test.before(async () => {
  await demarrerFauxGitHub();
  proprio = await client();
  await proprio.upsert(DOC, 'Annuaire', config.comptesTest.map(([Email, Nom, Role]) => ({ require: { Email }, fields: { Nom, Role, Actif: true } })));
});
test.after(() => { if (serveur) serveur.close(); });

test('le relais seul synchronise l’agenda du Sénat et publie le répertoire, en peu d’appels à l’API Grist', async () => {
  const sortie = await relais({ FORCER_REPERTOIRE: 'true' });
  assert.match(sortie, /Synchronisation : \d+ flux lus/);
  const appels = Number((/Relais terminé \((\d+) appels/.exec(sortie) || [])[1]);
  assert.ok(appels > 0 && appels <= 10, `appels à l’API Grist : ${appels} (dont ${'1 répertoire'})`);
  const lois = (await proprio.lignes(DOC, 'Sources', { filtre: { Nom: ['Commission des lois'] } }))[0];
  assert.ok(lois.Derniere_synchro, 'commission des lois synchronisée par le relais');
  assert.equal(lois.Synchro_en_cours, null, 'verrou levé');
  assert.ok((await proprio.lignes(DOC, 'Evenements')).some(e => e.Source === lois.id && e.Cree_par === 'Synchronisation automatique'));
  const params = await proprio.lignes(DOC, 'Parametres');
  const url = (params.find(p => p.Cle === 'repertoire_url') || {}).Valeur;
  assert.equal(url, `${RAW}/essai/g1/raw/repertoire.json`);
  const rep = JSON.parse(gists.g1.files['repertoire.json'].content);
  assert.ok(rep.dossiers.length > 1000, `${rep.dossiers.length} dossiers en cours`);
  assert.ok(rep.dossiers.every(d => !/^(promulgué|caduc|adopté|retiré)$/i.test(d.e || '')), 'aucun dossier clos');
  assert.match(sortie, /Répertoire : \d+ dossiers en cours publiés/);
  // Second passage : pas de nouveau gist, pas de répertoire hors du premier passage du matin
  const sortie2 = await relais();
  assert.doesNotMatch(sortie2, /Répertoire :/);
  assert.equal(Object.keys(gists).length, 1);
});

test('un membre cherche « budget 2027 » sans quitter Grist et suit le dossier d’un clic', async () => {
  // Le budget 2027 a pu être suivi par un autre parcours, par son lien Sénat ou Assemblée : la recherche dirait « Déjà suivi »
  for (const d of await proprio.lignes(DOC, 'Dossiers')) if (/pjlf2027|PLF_2027/.test(`${d.Lien} ${d.Lien_autre}`)) await proprio.req('POST', `/api/docs/${DOC}/apply`, [['RemoveRecord', 'Dossiers', d.id]]);
  const nav = await navigateur({ largeur: 1440, hauteur: 960 });
  try {
    const ctx = await nav.nouveau();
    const { page, module: m } = await ouvrir(ctx, 'membre@projet.test', 'Membre');
    await cliquer(m, '.onglets [data-vue="dossiers"]');
    await m.click('#rech-dossier');
    await m.waitForFunction(() => /dossiers en cours/.test(document.getElementById('rech-etat').textContent), null, { timeout: 30000 });
    await m.type('#rech-dossier', 'budget 2027', { delay: 30 });
    await m.waitForSelector('#rech-resultats .ag-resultat');
    assert.equal(await m.evaluate(() => document.activeElement.id), 'rech-dossier', 'le focus reste dans le champ');
    const premier = await m.$eval('#rech-resultats .ag-resultat .ag-resultat-titre', el => el.textContent);
    assert.match(premier, /loi de finances pour 2027/i);
    await capturer(page, '13-recherche-dossier');
    await m.click('#rech-resultats [data-action="suivre-repertoire"][data-cle="0"]');
    let d;
    for (let i = 0; i < 60 && !(d && d.Etat === 'Suivi actif'); i++) { d = (await proprio.lignes(DOC, 'Dossiers')).find(x => /pjlf2027/.test(x.Lien)); await page.waitForTimeout(500); }
    assert.ok(d, 'dossier suivi');
    assert.equal(d.Lien, 'https://www.senat.fr/dossier-legislatif/pjlf2027.html');
    assert.match(d.Lien_autre, /^https:\/\/www\.assemblee-nationale\.fr\/dyn\/17\/dossiers\//, 'avec son dossier à l’Assemblée');
    assert.equal(d.Ajoute_par, 'membre@projet.test');
    assert.equal(d.Etat, 'Suivi actif', 'analysé aussitôt (page du Sénat)');
    await m.waitForSelector('#rech-resultats [data-etat="suivi"]');
  } finally { await nav.b.close(); }
});
