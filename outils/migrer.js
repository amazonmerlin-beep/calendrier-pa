'use strict';
// Met un document EXISTANT au niveau du schéma, sans rien perdre : tables et colonnes manquantes (types, formules,
// déclencheurs, descriptions), données de base des tables créées, puis règles d'accès (schema/acces.js).
// Ne supprime ni ne modifie aucune table, colonne ou donnée existante ; les colonnes en trop sont seulement signalées.
// À utiliser quand le document contient des données réelles (construire.js, lui, repart de zéro).
// Usage : node outils/migrer.js [--simulation]
//   Sur une instance réelle : GRIST_URL=… GRIST_API_KEY=… DOC_COURANT=grist-local/doc-<instance>.json node outils/migrer.js
const { client, docCourant } = require('./lib/cles');
const { TABLES, DONNEES = {} } = require('../schema/modele');
const { appliquerRegles } = require('../schema/acces');

const SIMULATION = process.argv.includes('--simulation');
const estFormule = c => !!c.formule;
const cibleRef = c => (/^Ref(List)?:(.+)$/.exec(c.type) || [])[2];
function infoColonne(c) {
  const info = { type: c.type, label: c.label || c.id };
  if (c.options) info.widgetOptions = JSON.stringify(c.options);
  return info;
}

(async () => {
  const doc = (docCourant() || {}).docId;
  if (!doc) throw new Error('Document inconnu : DOC_COURANT doit désigner le fichier du document à migrer.');
  const g = await client();
  const lireMeta = () => g.sql(doc, 'select c.id, c.colId, t.tableId from _grist_Tables_column c join _grist_Tables t on t.id = c.parentId');
  let meta = await lireMeta();
  const existe = (t, col) => meta.some(m => m.tableId === t && (col === undefined || m.colId === col));
  const vuesAvant = new Set((await g.sql(doc, 'select id from _grist_Views')).map(v => v.id));

  const nouvellesTables = TABLES.filter(t => !existe(t.id));
  const nouvellesColonnes = TABLES.filter(t => existe(t.id)).flatMap(t => t.colonnes.filter(c => !existe(t.id, c.id)).map(c => [t, c]));
  const enTrop = [...new Set(meta.filter(m => !m.tableId.startsWith('_grist') && !m.colId.startsWith('gristHelper') && m.colId !== 'manualSort'
    && TABLES.some(t => t.id === m.tableId) && !TABLES.find(t => t.id === m.tableId).colonnes.some(c => c.id === m.colId)).map(m => `${m.tableId}.${m.colId}`))];
  console.log(`Tables à créer : ${nouvellesTables.map(t => t.id).join(', ') || 'aucune'}`);
  console.log(`Colonnes à ajouter : ${nouvellesColonnes.map(([t, c]) => `${t.id}.${c.id}`).join(', ') || 'aucune'}`);
  if (enTrop.length) console.log(`Colonnes absentes du schéma (gardées) : ${enTrop.join(', ')}`);
  if (SIMULATION) { console.log('Simulation : rien n’est écrit.'); return; }

  // 1. Tables manquantes, avec leurs colonnes de données (formules ensuite, comme construire.js)
  for (const t of nouvellesTables) {
    const cols = t.colonnes.filter(c => (!estFormule(c) || c.declencheur) && (!cibleRef(c) || existe(cibleRef(c)) || cibleRef(c) === t.id));
    await g.appliquer(doc, [['AddTable', t.id, cols.map(c => ({ id: c.id, isFormula: false, ...infoColonne(c) }))]]);
    meta = await lireMeta();
    if ((DONNEES[t.id] || []).length) await g.ajouter(doc, t.id, DONNEES[t.id]);
  }
  // 2. Colonnes manquantes : celles des nouvelles tables restées de côté, et celles des tables existantes
  const aAjouter = [
    ...nouvellesTables.flatMap(t => t.colonnes.filter(c => !existe(t.id, c.id)).map(c => [t, c])),
    ...nouvellesColonnes,
  ];
  const ordre = [...aAjouter.filter(([, c]) => !c.tard), ...aAjouter.filter(([, c]) => c.tard)];
  for (const [t, c] of ordre) {
    const formule = estFormule(c) && !c.declencheur;
    await g.appliquer(doc, [['AddColumn', t.id, c.id, { ...infoColonne(c), isFormula: formule, ...(formule ? { formula: c.formule } : {}) }]]);
  }
  meta = await lireMeta();
  // 3. Déclencheurs et descriptions des colonnes ajoutées
  const ref = (table, col) => (meta.find(m => m.tableId === table && m.colId === col) || {}).id;
  const reglages = [];
  for (const [t, c] of aAjouter.concat(nouvellesTables.flatMap(t => t.colonnes.filter(c => !aAjouter.some(([, x]) => x === c)).map(c => [t, c])))) {
    const modif = { untieColIdFromLabel: true };
    if (c.description) modif.description = c.description;
    if (c.declencheur) modif.formula = c.formule;
    if (c.declencheur === 'modif') Object.assign(modif, { recalcWhen: 2, recalcDeps: null });
    else if (c.declencheur === 'ajout') Object.assign(modif, { recalcWhen: 0, recalcDeps: null });
    else if (Array.isArray(c.declencheur)) Object.assign(modif, { recalcWhen: 0, recalcDeps: ['L', ...c.declencheur.map(d => ref(t.id, d))] });
    reglages.push(['ModifyColumn', t.id, c.id, modif]);
  }
  if (reglages.length) await g.appliquer(doc, reglages);
  // 4. Pages créées par Grist avec les nouvelles tables : retirées (le module est la seule page)
  const vuesNouvelles = (await g.sql(doc, 'select id from _grist_Views')).filter(v => !vuesAvant.has(v.id));
  if (vuesNouvelles.length) await g.appliquer(doc, vuesNouvelles.map(v => ['RemoveView', v.id]));
  // 5. Règles d'accès du schéma (remplacent celles du document)
  const acl = await appliquerRegles(g, doc);
  console.log(`Migration faite : ${nouvellesTables.length} table(s), ${aAjouter.length} colonne(s) ; règles : ${acl.ressources} ressources, ${acl.regles} règles, toutes compilées.`);
})().catch(e => { console.error('ÉCHEC :', e.message); if (e.corps) console.error(JSON.stringify(e.corps).slice(0, 2000)); process.exit(1); });
