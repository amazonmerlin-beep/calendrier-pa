// Répertoire des dossiers législatifs EN COURS (Sénat et Assemblée nationale), publié par le relais une fois par jour ;
// le module y cherche un dossier sans quitter Grist. Fonctions pures, testées (module/test/repertoire.test.js).
// Sources : data.senat.fr (dossiers-legislatifs.csv, quotidien) et data.assemblee-nationale.fr (Dossiers_Legislatifs.json.zip).
export const OUVERT_SENAT = /lecture|commission mixte|congr/i;   // états du Sénat d'un dossier encore en navette
const PROCEDURES_AN = new Map([
  ['Proposition de loi ordinaire', 'Proposition de loi'], ['Projet de loi ordinaire', 'Projet de loi'],
  ['Projet ou proposition de loi constitutionnelle', 'Loi constitutionnelle'], ['Projet ou proposition de loi organique', 'Loi organique'],
  ['Projet de ratification des traités et conventions', 'Ratification'], ['Résolution', 'Résolution'], ['Résolution Article 34-1', 'Résolution'],
  // Lois financières (budget, sécurité sociale, fin de gestion, approbation des comptes) et référendum d'initiative partagée
  ['Projet de loi de finances de l’année', 'Loi de finances'], ["Projet de loi de finances de l'année", 'Loi de finances'],
  ['Projet de loi de finances rectificative', 'Loi de finances'], ['Projet de loi de financement de la sécurité sociale', 'Financement de la sécurité sociale'],
  ['Projet de loi relative aux résultats de la gestion et portant approbation des comptes', 'Approbation des comptes'],
  ["Proposition de loi présentée en application de l'article 11 de la Constitution", 'Proposition de loi'],
]);
// Écartés : rapports et missions d'information, commissions d'enquête, engagement de responsabilité du Gouvernement,
// pétitions, allocutions : ce ne sont pas des dossiers législatifs.
function typeSenat(t, titre) {
  const s = String(t || '').toLowerCase().replace(/\s+/g, ' '), ti = String(titre || '').toLowerCase();
  if (/financement de la sécurité sociale/.test(ti)) return 'Financement de la sécurité sociale';
  if (/projet/.test(s) && /loi de finances/.test(ti)) return 'Loi de finances';
  if (/constitutionnelle/.test(s)) return 'Loi constitutionnelle';
  if (/organique/.test(s)) return 'Loi organique';
  if (/résolution/.test(s)) return 'Résolution';
  if (/projet/.test(s)) return 'Projet de loi';
  return 'Proposition de loi';
}
/** CSV séparé par des points-virgules, champs entre guillemets possibles. */
export function lireCsv(texte) {
  const lignesCsv = [];
  let champ = '', ligne = [], guillemets = false;
  for (let i = 0; i < texte.length; i++) {
    const c = texte[i];
    if (guillemets) {
      if (c === '"' && texte[i + 1] === '"') { champ += '"'; i++; }
      else if (c === '"') guillemets = false;
      else champ += c;
    } else if (c === '"') guillemets = true;
    else if (c === ';') { ligne.push(champ); champ = ''; }
    else if (c === '\n') { ligne.push(champ.replace(/\r$/, '')); lignesCsv.push(ligne); ligne = []; champ = ''; }
    else champ += c;
  }
  if (champ || ligne.length) { ligne.push(champ); lignesCsv.push(ligne); }
  return lignesCsv;
}
const isoFr = d => { const m = /(\d\d)\/(\d\d)\/(\d{4})/.exec(d || ''); return m ? `${m[3]}-${m[2]}-${m[1]}` : ''; };
const cheminSenat = u => (/\/dossier-legislatif\/([^/]+)\.html/.exec(u || '') || [])[1] || '';

/**
 * Dossiers en cours, des deux assemblées, fusionnés quand un dossier existe des deux côtés.
 * Entrée : { t: titre, t2: autre titre, ty: type, d: date de dépôt, e: état, s: chemin Sénat, a: chemin Assemblée, m: dernière étape,
 *   th: thèmes du Sénat (« Budget », « Santé »… : on cherche aussi par thème) }.
 * Exclus : clos (promulgué, adopté, caduc, retiré, rejeté, résolution votée…), anciennes législatures, et ce qui n'est
 * pas un dossier législatif (rapports, missions, commissions d'enquête).
 */
export function construireRepertoire(csvSenat, dossiersAN) {
  const lignesSenat = lireCsv(csvSenat).slice(1).filter(l => l.length >= 5);
  const etatSenat = new Map(lignesSenat.map(l => [cheminSenat(l[3]), l[4]]));
  const entrees = new Map();   // clé : chemin Sénat, sinon chemin Assemblée
  for (const l of lignesSenat) {
    const s = cheminSenat(l[3]), d = isoFr(l[2]);
    if (!s || !OUVERT_SENAT.test(l[4] || '') || d < '2017-10-01') continue;
    entrees.set('S:' + s, { t: l[0].trim(), ty: typeSenat(l[1], l[0]), d, e: l[4], s, ...(l[9] ? { th: l[9].trim() } : {}) });
  }
  let exclusAN = 0;
  for (const x of dossiersAN) {
    const td = x.titreDossier || {}, type = PROCEDURES_AN.get(x.procedureParlementaire?.libelle);
    const s = cheminSenat(td.senatChemin), actes = JSON.stringify(x.actesLegislatifs || '');
    const ouvertSenat = s && OUVERT_SENAT.test(etatSenat.get(s) || '');
    if (!type || (s && etatSenat.has(s) && !ouvertSenat) || actes.includes('"PROM-PUB"') || actes.includes('RTRINI')
      || actes.includes('"ANLUNI-DEBATS-DEC"') || (x.legislature !== '17' && !ouvertSenat)) { exclusAN++; continue; }
    const dates = [...actes.matchAll(/"dateActe":"(\d{4}-\d\d-\d\d)/g)].map(m => m[1]).sort();
    const a = `${x.legislature || '17'}/${td.titreChemin}`;
    const ex = s && entrees.get('S:' + s);
    if (ex) { ex.a = a; ex.m = dates[dates.length - 1] || ''; if (td.titre && td.titre !== ex.t) ex.t2 = td.titre; continue; }
    entrees.set('A:' + a, { t: td.titre || '', ty: type, d: dates[0] || '', e: ouvertSenat ? etatSenat.get(s) : '', a, m: dates[dates.length - 1] || '', ...(s ? { s } : {}) });
  }
  const dossiers = [...entrees.values()].sort((p, q) => (q.m || q.d).localeCompare(p.m || p.d));
  return { dossiers, exclusAN };
}

