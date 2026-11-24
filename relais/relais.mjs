#!/usr/bin/env node
// Relais du Calendrier PA : lit ce qu'un navigateur ne peut pas lire, et le dépose dans Grist.
//  1. Assemblée nationale : réunions et séances des dossiers suivis (open data quotidien de l'Assemblée,
//     Agenda.json.zip), écrites en iCal dans la source « Assemblée nationale (dossiers suivis) ».
//  2. Agendas Google ou Outlook (sources de type « Flux via relais » avec une adresse) : contenu iCal relayé tel quel.
//  3. Abonnements de consultation (table Abonnements) : l'agenda choisi est publié dans un gist secret GitHub, dont
//     l'adresse est notée dans Grist ; un abonnement arrêté voit son gist supprimé.
// Le module Grist intègre les contenus relayés comme n'importe quel flux (synchro.js). Les journaux d'exécution
// (publics si le dépôt l'est) ne contiennent ni nom, ni adresse, ni identifiant : seulement des numéros et des nombres.
//
// Node 20 ou plus, sans dépendance ; `unzip` doit être installé (présent sur les machines de GitHub Actions).
// Variables : GRIST_URL (ex. https://docs.getgrist.com), GRIST_DOC (identifiant du document),
//   GRIST_API_KEY (clé d'un compte « robot » inscrit dans l'annuaire avec le rôle Administration),
//   GIST_TOKEN (jeton GitHub limité aux gists : publication des abonnements ; sans lui, rien n'est publié),
//   AN_AGENDA_ZIP (facultatif : fichier déjà téléchargé, pour les essais), RELAIS_SIMULATION=1 (n'écrit rien),
//   GIST_API, GIST_RAW (facultatifs : autre serveur que GitHub, pour les essais).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const GRIST_URL = (process.env.GRIST_URL || '').replace(/\/$/, '');
const DOC = process.env.GRIST_DOC;
const CLE = process.env.GRIST_API_KEY;
const SIMULATION = process.env.RELAIS_SIMULATION === '1';
const AN_AGENDA = 'https://data.assemblee-nationale.fr/static/openData/repository/17/vp/reunions/Agenda.json.zip';
const SOURCE_AN = 'Assemblée nationale (dossiers suivis)';
const UA = 'calendrier-pa-relais/1.0 (+https://github.com)';
const MAX_ICS = 2 * 1024 * 1024;   // un contenu relayé de plus de 2 Mo est refusé (cellule Grist raisonnable)
const GIST_TOKEN = process.env.GIST_TOKEN || '';
const GIST_API = (process.env.GIST_API || 'https://api.github.com').replace(/\/$/, '');
const GIST_RAW = (process.env.GIST_RAW || 'https://gist.githubusercontent.com').replace(/\/$/, '');
const GIST_FICHIER = 'calendrier-pa.ics';
// Sélection et agenda iCal des abonnements : le même code que l'aperçu du module
await import(new URL('../module/src/diffusion.js', import.meta.url));
const D = globalThis.Formulaire.diffusion;

if (!GRIST_URL || !DOC || !CLE) { console.error('GRIST_URL, GRIST_DOC et GRIST_API_KEY sont requis.'); process.exit(2); }

// ------------------------------------------------------------------ Grist (API REST)
async function grist(methode, chemin, corps) {
  const r = await fetch(`${GRIST_URL}/api/docs/${DOC}${chemin}`, {
    method: methode,
    headers: { Authorization: `Bearer ${CLE}`, 'Content-Type': 'application/json' },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  if (!r.ok) throw new Error(`Grist ${methode} ${chemin} : ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r.status === 200 ? r.json() : null;
}
const lignes = async table => (await grist('GET', `/tables/${table}/records`)).records.map(r => ({ id: r.id, ...r.fields }));
async function modifier(table, records) {
  if (!records.length) return;
  if (SIMULATION) { console.log(`[simulation] ${table} :`, JSON.stringify(records).slice(0, 400)); return; }
  await grist('PATCH', `/tables/${table}/records`, { records });
}

// ------------------------------------------------------------------ iCal
const echapper = s => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const utc = iso => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
function plier(ligne) {   // lignes de 75 octets au plus (RFC 5545)
  const out = [];
  let reste = Buffer.from(ligne, 'utf8');
  while (reste.length > 75) {
    let n = 75;
    while (n > 0 && (reste[n] & 0xC0) === 0x80) n--;   // ne pas couper un caractère UTF-8
    out.push(reste.subarray(0, n).toString('utf8'));
    reste = Buffer.concat([Buffer.from(' '), reste.subarray(n)]);
  }
  out.push(reste.toString('utf8'));
  return out.join('\r\n');
}
function ics(nom, evenements) {
  const l = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Calendrier PA//Relais//FR', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${echapper(nom)}`];
  const maintenant = utc(new Date().toISOString());
  for (const e of evenements) {
    l.push('BEGIN:VEVENT', `UID:${e.uid}`, `DTSTAMP:${maintenant}`, `DTSTART:${utc(e.debut)}`, `DTEND:${utc(e.fin || e.debut)}`,
      `SUMMARY:${echapper(e.titre)}`);
    if (e.lieu) l.push(`LOCATION:${echapper(e.lieu)}`);
    if (e.description) l.push(`DESCRIPTION:${echapper(e.description)}`);
    if (e.url) l.push(`URL:${e.url}`);
    if (e.annule) l.push('STATUS:CANCELLED');
    if (e.dossier) l.push(`X-CALPA-DOSSIER:${e.dossier}`);
    l.push('END:VEVENT');
  }
  l.push('END:VCALENDAR');
  return l.map(plier).join('\r\n') + '\r\n';
}

// ------------------------------------------------------------------ Assemblée nationale
const estLienAN = u => /^https:\/\/www\.assemblee-nationale\.fr\/dyn\/\d+\/dossiers\//i.test(String(u || ''));
const liste = x => (Array.isArray(x) ? x : x ? [x] : []);

/** Identifiant open data (DLR5L17N54629) et titre d'un dossier, lus sur sa page. */
async function identifierDossierAN(lien) {
  const r = await fetch(lien, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`page du dossier : erreur ${r.status}`);
  const html = await r.text();
  const compte = {};
  for (const m of html.matchAll(/DLR5L\d+N\d+/g)) compte[m[0]] = (compte[m[0]] || 0) + 1;
  const uid = Object.entries(compte).sort((a, b) => b[1] - a[1])[0]?.[0];
  // « Titre - Dossiers législatifs - 17e législature - Assemblée nationale » -> « Titre »
  const titre = (/<title>([^<]*)<\/title>/i.exec(html)?.[1] || '').replace(/\s+-\s+(Dossiers législatifs\b.*|Assemblée nationale)$/i, '').trim();
  if (!uid) throw new Error('identifiant du dossier introuvable sur la page');
  return { uid, titre };
}

function lireAgendaAN() {
  const dossier = mkdtempSync(path.join(tmpdir(), 'an-agenda-'));
  try {
    let zip = process.env.AN_AGENDA_ZIP;
    if (!zip) {
      zip = path.join(dossier, 'Agenda.json.zip');
      execFileSync('curl', ['-sSfL', '--max-time', '300', '-A', UA, '-o', zip, AN_AGENDA]);
    }
    execFileSync('unzip', ['-q', '-o', zip, '-d', dossier]);
    const rep = path.join(dossier, 'json', 'reunion');
    return readdirSync(rep).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(path.join(rep, f), 'utf8')).reunion);
  } finally { rmSync(dossier, { recursive: true, force: true }); }
}

function titreReunion(r) {
  const points = liste(r.ODJ?.pointsODJ?.pointODJ);
  const objet = points.map(p => p.objet).find(Boolean);
  const seance = r['@xsi:type'] === 'seance_type';
  const base = seance ? 'Séance publique (AN)' : 'Commission (AN)';
  return objet ? `${base} – ${objet}` : base;
}

/**
 * Réunions de l'agenda qui citent l'un des dossiers suivis (uidOpenData -> { id de la ligne Dossiers, lien }).
 * Renvoie { evts : celles d'après `depuis`, à relayer ; bilan : id du dossier -> { total, derniere, prochaine } sur
 * tout l'historique, pour dire où en est le dossier même sans réunion récente }.
 */
function reunionsDesDossiers(reunions, suivis, depuis) {
  const out = [], bilan = new Map(), maintenantIso = new Date().toISOString();
  for (const r of reunions) {
    if (!r?.timeStampDebut) continue;
    const points = liste(r.ODJ?.pointsODJ?.pointODJ);
    const refs = new Set(points.flatMap(p => liste(p.dossiersLegislatifsRefs?.dossierRef)));
    const suivi = [...refs].map(x => suivis.get(x)).find(Boolean);
    if (!suivi) continue;
    const b = bilan.get(suivi.id) || { total: 0, derniere: null, prochaine: null };
    b.total++;
    if (r.timeStampDebut < maintenantIso) { if (!b.derniere || r.timeStampDebut > b.derniere) b.derniere = r.timeStampDebut; }
    else if (!b.prochaine || r.timeStampDebut < b.prochaine) b.prochaine = r.timeStampDebut;
    bilan.set(suivi.id, b);
    if (r.timeStampDebut < depuis) continue;
    const convocation = liste(r.ODJ?.convocationODJ?.item).join('\n');
    out.push({
      uid: `${r.uid}@assemblee-nationale.fr`, debut: r.timeStampDebut, fin: r.timeStampFin || r.timeStampDebut,
      titre: titreReunion(r), lieu: r.lieu?.libelleLong || '', description: convocation,
      url: suivi.lien, annule: /annul/i.test(r.cycleDeVie?.etat || ''), dossier: suivi.id,
    });
  }
  return { evts: out.sort((a, b) => a.debut.localeCompare(b.debut)), bilan };
}

const jourFr = iso => new Date(iso).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'long', year: 'numeric' });
function resultatDossier(uid, n, b) {
  const pl = (k, s, p = s + 's') => `${k} ${k > 1 ? p : s}`;
  if (!b || !b.total) return `Relais : aucune réunion ni séance de l’Assemblée ne cite encore ce dossier (${uid}).`;
  const avenir = b.prochaine ? `prochaine le ${jourFr(b.prochaine)}` : 'aucune à venir';
  const passe = b.derniere ? `, la dernière le ${jourFr(b.derniere)}` : '';
  return `Relais : ${pl(b.total, 'réunion ou séance', 'réunions ou séances')} de l’Assemblée sur ce dossier${passe} ; ${avenir}. ${pl(n, 'événement')} dans l’agenda (le mois écoulé et la suite) (${uid}).`;
}

// ------------------------------------------------------------------ déroulé
const maintenant = () => Math.floor(Date.now() / 1000);

async function relayerAN(sources, dossiers) {
  const cible = sources.find(s => s.Nom === SOURCE_AN && s.Type === 'Flux via relais');
  if (!cible) { console.log(`Source « ${SOURCE_AN} » absente : Assemblée nationale ignorée.`); return; }
  const aSuivre = dossiers.map(d => ({ d, lien: estLienAN(d.Lien) ? d.Lien : estLienAN(d.Lien_autre) ? d.Lien_autre : null })).filter(x => x.lien);
  if (!aSuivre.length) { console.log('Aucun dossier de l’Assemblée nationale à suivre.'); return; }
  const suivis = new Map(), notes = [];
  for (const { d, lien } of aSuivre) {
    try {
      const { uid, titre } = await identifierDossierAN(lien);
      suivis.set(uid, { id: d.id, lien });
      notes.push({ d, uid, titre });
    } catch (e) {
      if (estLienAN(d.Lien)) await modifier('Dossiers', [{ id: d.id, fields: { Etat: 'Erreur', Derniere_verif: maintenant(), Resultat: 'Relais : ' + e.message } }]);
      console.error(`Dossier ${d.id} : ${e.message}`);
    }
  }
  if (!suivis.size) return;
  const reunions = lireAgendaAN();
  const depuis = new Date(Date.now() - 31 * 86400000).toISOString();
  const { evts, bilan } = reunionsDesDossiers(reunions, suivis, depuis);
  const contenu = ics(SOURCE_AN, evts);
  console.log(`Assemblée nationale : ${reunions.length} réunions lues, ${evts.length} rattachées à ${suivis.size} dossier(s).`);
  await modifier('Sources', [{ id: cible.id, fields: { Contenu_relaye: contenu, Relaye_le: maintenant() } }]);
  // État des dossiers propres à l'Assemblée (les dossiers du Sénat gardent l'état noté par le module)
  await modifier('Dossiers', notes.filter(n => estLienAN(n.d.Lien)).map(({ d, uid, titre }) => {
    const n = evts.filter(e => e.dossier === d.id).length;
    const f = { Etat: 'Suivi actif', Derniere_verif: maintenant(), Resultat: resultatDossier(uid, n, bilan.get(d.id)) };
    // Titre vide, ou encore celui de la page avec son suffixe (version précédente du relais)
    if (titre && (!d.Titre || /\s-\s+Dossiers législatifs\b/i.test(d.Titre))) f.Titre = titre;
    return { id: d.id, fields: f };
  }));
}

async function relayerAgendas(sources) {
  for (const s of sources.filter(x => x.Type === 'Flux via relais' && x.Active && x.Nom !== SOURCE_AN && x.URL)) {
    try {
      const u = new URL(s.URL);
      if (u.protocol !== 'https:') throw new Error('adresse https:// attendue');
      const r = await fetch(u, { headers: { 'User-Agent': UA } });
      if (!r.ok) throw new Error(`erreur ${r.status}`);
      const texte = await r.text();
      if (!/BEGIN:VCALENDAR/.test(texte)) throw new Error('ce n’est pas un agenda iCal');
      if (texte.length > MAX_ICS) throw new Error('agenda trop gros (plus de 2 Mo) : utilisez un agenda dédié');
      await modifier('Sources', [{ id: s.id, fields: { Contenu_relaye: texte, Relaye_le: maintenant() } }]);
      console.log(`Source n° ${s.id} : ${(texte.match(/BEGIN:VEVENT/g) || []).length} événements relayés.`);
    } catch (e) {
      // L'adresse n'est jamais écrite dans le journal : c'est souvent un lien secret
      await modifier('Sources', [{ id: s.id, fields: { Resultat_synchro: '⚠ Relais : ' + e.message, Relaye_le: maintenant() } }]);
      console.error(`Source n° ${s.id} : ${e.message}`);
    }
  }
}

// ------------------------------------------------------------------ abonnements de consultation (gists secrets)
async function gist(methode, chemin, corps) {
  const r = await fetch(`${GIST_API}${chemin}`, {
    method: methode,
    headers: { Authorization: `Bearer ${GIST_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': UA, 'Content-Type': 'application/json' },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub ${methode} : erreur ${r.status}`);
  return r.status === 204 ? {} : r.json();
}
const adresseGist = g => `${GIST_RAW}/${g.owner.login}/${g.id}/raw/${GIST_FICHIER}`;

async function publierAbonnements(sources, dossiers) {
  let abonnements;
  try { abonnements = await lignes('Abonnements'); } catch (e) { console.log('Pas de table Abonnements : diffusion ignorée.'); return; }
  if (!abonnements.length) return;
  const evts = await lignes('Evenements');
  const noms = { sources: new Map(sources.map(x => [x.id, x.Nom])), dossiers: new Map(dossiers.map(x => [x.id, x.Titre || x.Lien])) };
  for (const a of abonnements) {
    try {
      if (!a.Actif) {
        if (!a.Gist) continue;
        if (!GIST_TOKEN) throw new Error('jeton GitHub GIST_TOKEN absent : l’adresse n’a pas pu être supprimée');
        if (!SIMULATION) await gist('DELETE', `/gists/${a.Gist}`);
        await modifier('Abonnements', [{ id: a.id, fields: { Gist: '', Adresse: '', Publie_le: maintenant(), Resultat: 'Publication arrêtée : l’adresse ne fonctionne plus.' } }]);
        console.log(`Abonnement n° ${a.id} : publication arrêtée.`);
        continue;
      }
      if (!GIST_TOKEN) throw new Error('publication impossible : le jeton GitHub GIST_TOKEN n’est pas configuré dans le dépôt du relais');
      const choisis = D.selectionner(evts, a, maintenant());
      const contenu = D.versIcs(a, choisis, noms);
      const fichiers = { [GIST_FICHIER]: { content: contenu } };
      let g = null;
      if (!SIMULATION) {
        if (a.Gist) g = await gist('PATCH', `/gists/${a.Gist}`, { files: fichiers });
        if (!g) g = await gist('POST', '/gists', { description: 'Calendrier PA (abonnement)', public: false, files: fichiers });
      }
      const f = { Publie_le: maintenant(), Resultat: `${choisis.length} événement${choisis.length > 1 ? 's' : ''} publié${choisis.length > 1 ? 's' : ''}.` };
      if (g) { f.Gist = g.id; f.Adresse = adresseGist(g); }
      await modifier('Abonnements', [{ id: a.id, fields: f }]);
      console.log(`Abonnement n° ${a.id} : ${choisis.length} événements publiés.`);
    } catch (e) {
      await modifier('Abonnements', [{ id: a.id, fields: { Publie_le: maintenant(), Resultat: '⚠ ' + e.message } }]);
      console.error(`Abonnement n° ${a.id} : ${e.message}`);
    }
  }
}

const sources = await lignes('Sources');
const dossiers = await lignes('Dossiers');
await relayerAgendas(sources);
await relayerAN(sources, dossiers);
// Les abonnements publient l'état du document après les dépôts ci-dessus ; les événements relayés n'y entrent
// qu'une fois intégrés par le module (passage suivant)
await publierAbonnements(sources, dossiers);
console.log('Relais terminé.');
