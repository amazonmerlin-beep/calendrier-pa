#!/usr/bin/env node
// Relais du Calendrier PA, lancé toutes les deux heures par GitHub Actions. À chaque passage :
//  1. relaie ce qu'un navigateur ne peut pas lire : agendas Google ou Outlook abonnés, réunions et séances de
//     l'Assemblée nationale des dossiers suivis (open data quotidien Agenda.json.zip) ;
//  2. synchronise tout l'agenda avec le moteur du module (module/src/moteur.js) : flux du Sénat, dossiers suivis,
//     contenus relayés. Même logique que la synchronisation lancée depuis un navigateur ;
//  3. publie les abonnements de consultation (gists secrets GitHub ; arrêt = gist supprimé) ;
//  4. une fois par jour, publie le répertoire des dossiers législatifs EN COURS (Sénat et Assemblée), où le module
//     cherche un dossier sans quitter Grist.
// Appels à l'API Grist par passage : 4 lectures, 2 écritures (le verrou, puis un lot unique), et 1 lecture de plus
// s'il y a des abonnements ; une écriture de plus seulement quand un abonnement change, et une fois par jour pour le
// répertoire. Les journaux (publics si le dépôt l'est) ne contiennent ni nom, ni adresse, ni identifiant.
//
// Node 20 ou plus, sans dépendance ; `unzip` doit être installé (présent sur les machines de GitHub Actions).
// Variables : GRIST_URL (ex. https://docs.getgrist.com), GRIST_DOC (identifiant du document),
//   GRIST_API_KEY (clé d'un compte « robot » inscrit dans l'annuaire avec le rôle Administration),
//   GIST_TOKEN (jeton GitHub limité aux gists : abonnements et répertoire ; sans lui, rien n'est publié),
//   FORCER_REPERTOIRE=true (répertoire refait à ce passage), RELAIS_SIMULATION=1 (n'écrit rien),
//   pour les essais : AN_AGENDA_ZIP, AN_DOSSIERS_ZIP, SENAT_DOSSIERS_CSV (fichiers déjà téléchargés), GIST_API, GIST_RAW.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const GRIST_URL = (process.env.GRIST_URL || '').replace(/\/$/, '');
const DOC = process.env.GRIST_DOC;
const CLE = process.env.GRIST_API_KEY;
const SIMULATION = process.env.RELAIS_SIMULATION === '1';
const AN_AGENDA = 'https://data.assemblee-nationale.fr/static/openData/repository/17/vp/reunions/Agenda.json.zip';
const AN_DOSSIERS = 'https://data.assemblee-nationale.fr/static/openData/repository/17/loi/dossiers_legislatifs/Dossiers_Legislatifs.json.zip';
const SENAT_DOSSIERS = 'https://data.senat.fr/data/dosleg/dossiers-legislatifs.csv';
const SOURCE_AN = 'Assemblée nationale (dossiers suivis)';
const SOURCE_DELAIS = 'Délais limites du Sénat';
const API_SENAT = 'https://www.senat.fr/api/v1/agenda';
const UA = 'calendrier-pa-relais/1.0 (+https://github.com)';
const MAX_ICS = 2 * 1024 * 1024;   // un contenu relayé de plus de 2 Mo est refusé (cellule Grist raisonnable)
const GIST_TOKEN = process.env.GIST_TOKEN || '';
const GIST_API = (process.env.GIST_API || 'https://api.github.com').replace(/\/$/, '');
const GIST_RAW = (process.env.GIST_RAW || 'https://gist.githubusercontent.com').replace(/\/$/, '');
const GIST_FICHIER = 'calendrier-pa.ics';
const REPERTOIRE_FICHIER = 'repertoire.json';
const REPERTOIRE_HEURE_UTC = 5;    // le premier passage du jour refait le répertoire

// Le code du module, partagé : lecture iCal et plan (sync.js), déroulé (moteur.js), diffusion (diffusion.js) ;
// ical.js : la même version que celle chargée par le module (même empreinte)
for (const f of ['sync.js', 'moteur.js', 'diffusion.js']) await import(new URL(`../module/src/${f}`, import.meta.url));
const { sync: S, moteur: M, diffusion: D } = globalThis.Formulaire;
const ICAL = (await import(new URL('../vendor/ical-2.1.0.min.mjs', import.meta.url))).default;
const { construireRepertoire } = await import(new URL('./repertoire.mjs', import.meta.url));

if (!GRIST_URL || !DOC || !CLE) { console.error('GRIST_URL, GRIST_DOC et GRIST_API_KEY sont requis.'); process.exit(2); }
const maintenant = () => Math.floor(Date.now() / 1000);
const liste = x => (Array.isArray(x) ? x : x ? [x] : []);

// ------------------------------------------------------------------ Grist (API REST)
let appels = 0;
async function grist(methode, chemin, corps) {
  appels++;
  const r = await fetch(`${GRIST_URL}/api/docs/${DOC}${chemin}`, {
    method: methode,
    headers: { Authorization: `Bearer ${CLE}`, 'Content-Type': 'application/json' },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  if (!r.ok) throw new Error(`Grist ${methode} ${chemin.split('?')[0]} : ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r.status === 200 ? r.json() : null;
}
// Listes décodées comme dans le module (['L', 1, 2] -> [1, 2])
const decoder = v => (Array.isArray(v) && v[0] === 'L' ? v.slice(1) : v);
const lignes = async table => (await grist('GET', `/tables/${table}/records`)).records
  .map(r => ({ id: r.id, ...Object.fromEntries(Object.entries(r.fields).map(([k, v]) => [k, decoder(v)])) }));
async function appliquer(actions) {
  if (!actions.length) return { retValues: [] };
  if (SIMULATION) { console.log(`[simulation] ${actions.length} action(s) : ${[...new Set(actions.map(a => `${a[0]} ${a[1]}`))].join(', ')}`); return { retValues: [] }; }
  return grist('POST', '/apply', actions);
}
async function lireTexte(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`le site répond « erreur ${r.status} »`);
  return r.text();
}
function telecharger(url, fichier, local) {
  if (local) return local;
  execFileSync('curl', ['-sSfL', '--max-time', '300', '-A', UA, '-o', fichier, url]);
  return fichier;
}
/** Lit les fichiers JSON d'un dossier d'une archive (zip) ; rend fn(objet) pour chacun. */
function parcourirZip(zip, sousDossier, fn) {
  const rep = mkdtempSync(path.join(tmpdir(), 'zip-'));
  try {
    execFileSync('unzip', ['-q', '-o', zip, '-d', rep]);
    const d = path.join(rep, sousDossier);
    for (const f of readdirSync(d)) if (f.endsWith('.json')) fn(JSON.parse(readFileSync(path.join(d, f), 'utf8')));
  } finally { rmSync(rep, { recursive: true, force: true }); }
}

// ------------------------------------------------------------------ iCal de l'Assemblée nationale
const echapper = s => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const utc = iso => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
function plier(ligne) {   // lignes de 75 octets au plus (RFC 5545), sans couper un caractère
  const out = [];
  let reste = Buffer.from(ligne, 'utf8');
  while (reste.length > 75) {
    let n = 75;
    while (n > 0 && (reste[n] & 0xC0) === 0x80) n--;
    out.push(reste.subarray(0, n).toString('utf8'));
    reste = Buffer.concat([Buffer.from(' '), reste.subarray(n)]);
  }
  out.push(reste.toString('utf8'));
  return out.join('\r\n');
}
// Contenu stable d'un passage à l'autre (horodatage tiré des données) : rien n'est réécrit si rien n'a changé
function ics(nom, evenements) {
  const l = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Calendrier PA//Relais//FR', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${nom}`];
  for (const e of evenements) {
    l.push('BEGIN:VEVENT', `UID:${e.uid}`, `DTSTAMP:${utc(e.cree || e.debut)}`, `DTSTART:${utc(e.debut)}`, `DTEND:${utc(e.fin || e.debut)}`,
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

// ------------------------------------------------------------------ délais limites (séance publique du Sénat)
const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
/** « Jeudi 26 novembre 2026 11h00 » (heure de Paris) -> date ISO, ou null */
function dateSenat(texte) {
  const m = /(\d{1,2})(?:er)?\s+([a-zéû]+)\s+(\d{4})(?:\s+(?:à\s+)?(\d{1,2})\s*h\s*(\d{2})?)?/i.exec(String(texte || '').replace(/\u00a0/g, ' '));
  const mo = m ? MOIS.indexOf(m[2].toLowerCase()) + 1 : 0;
  if (!m || !mo) return null;
  return new Date(S.versEpoch(+m[3], mo, +m[1], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, 0) * 1000).toISOString();
}
const empreinte = s => { let h = 5381; for (const c of s) h = ((h << 5) + h + c.codePointAt(0)) >>> 0; return h.toString(36); };
function libelleDelai(titre) {
  const [quoi, objet] = String(titre).split(/<br\s*\/?>/i).map(x => S.sansBalises(x));
  const court = /sous-amendement/i.test(quoi) ? 'Sous-amendements' : /dépôt des amendements/i.test(quoi) ? 'Dépôt des amendements'
    : /signataire/i.test(quoi) ? 'Ajout de signataires' : quoi.replace(/^délai limite pour (?:le |la |les |l’|l')?/i, '');
  return { court: court.charAt(0).toUpperCase() + court.slice(1), objet: objet || '', complet: [quoi, objet].filter(Boolean).join(' : ') };
}
async function jsonSenat(chemin) {
  const r = await fetch(`${API_SENAT}${chemin}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`API de l’agenda du Sénat : erreur ${r.status}`);
  return r.json();
}
/**
 * Délais limites liés aux amendements (dépôt, sous-amendements, signataires) des séances publiques des cinq semaines
 * à venir, chacun rattaché au dossier suivi dont la séance parle (lien du dossier ou numéro de texte).
 */
async function delaisSenat(dossiers) {
  const jour = sec => { const p = S.partiesParis(sec); return `${p.annee}-${String(p.mois).padStart(2, '0')}-${String(p.jour).padStart(2, '0')}`; };
  const t = maintenant(), aujourdhui = jour(t);
  const seances = new Map();
  for (let k = 0; k < 5; k++) {
    const semaine = await jsonSenat(`/events?date=${jour(t + k * 7 * 86400)}&week=1`);
    for (const j of Object.values(semaine || {})) for (const e of j.events || []) {
      if (j.day >= aujourdhui && (e.instances || []).includes('Séance publique')) seances.set(e.id, e);
    }
  }
  // Dossiers suivis du Sénat : par chemin (pjlf2027) et par numéro de texte
  const parChemin = new Map(), parNumero = new Map();
  for (const d of dossiers.filter(x => x.Etat !== 'Erreur')) {
    for (const l of [d.Lien, d.Lien_autre]) { const c = (/\/dossier-legislatif\/([^/"#?]+)\.html/.exec(l || '') || [])[1]; if (c) parChemin.set(c, d.id); }
    for (const k of S.numerosSenat(d.Numeros)) parNumero.set(k, d.id);
  }
  const delais = new Map();
  for (const [id, e] of seances) {
    const detail = await jsonSenat(`/events/${id}`);
    const contenu = String(detail.content || '');
    const dossier = [...contenu.matchAll(/\/dossier-legislatif\/([^/"#?]+)\.html/g)].map(m => parChemin.get(m[1])).find(Boolean)
      || S.numerosSenat(S.sansBalises(contenu)).map(k => parNumero.get(k)).find(Boolean) || null;
    for (const dl of detail.deadlines || []) {
      if (!/amendement|signataire/i.test(dl.title || '')) continue;
      const debut = dateSenat(dl.date);
      if (!debut || debut < new Date((t - 86400) * 1000).toISOString()) continue;
      const { court, objet, complet } = libelleDelai(dl.title);
      const cle = `${court}|${objet}|${debut}`;
      if (delais.has(cle)) { if (!delais.get(cle).dossier && dossier) delais.get(cle).dossier = dossier; continue; }
      const p = S.partiesParis(Date.parse(e.date + 'T12:00:00Z') / 1000);
      delais.set(cle, {
        uid: `delai-${empreinte(cle)}@calendrier-pa`, debut, fin: debut, titre: `Délai : ${court}${objet ? ' – ' + objet : ''}`,
        description: `${complet}\nSéance concernée : ${S.sansBalises(e.title)} (${e.date})`,
        url: `https://agenda.senat.fr/${p.annee}/${String(p.mois).padStart(2, '0')}/${String(p.jour).padStart(2, '0')}/event/${id}`, dossier,
      });
    }
  }
  return { seances: seances.size, delais: [...delais.values()].sort((a, b) => a.debut.localeCompare(b.debut) || a.uid.localeCompare(b.uid)) };
}

// ------------------------------------------------------------------ 1. relais
const estLienAN = u => /^https:\/\/www\.assemblee-nationale\.fr\/dyn\/\d+\/dossiers\//i.test(String(u || ''));
/** Identifiant open data (DLR5L17N54629) et titre d'un dossier de l'Assemblée, lus sur sa page. */
async function identifierDossierAN(lien) {
  const html = await lireTexte(lien);
  const compte = {};
  for (const m of html.matchAll(/DLR5L\d+N\d+/g)) compte[m[0]] = (compte[m[0]] || 0) + 1;
  const uid = Object.entries(compte).sort((a, b) => b[1] - a[1])[0]?.[0];
  // « Titre - Dossiers législatifs - 17e législature - Assemblée nationale » -> « Titre »
  const titre = (/<title>([^<]*)<\/title>/i.exec(html)?.[1] || '').replace(/\s+-\s+(Dossiers législatifs\b.*|Assemblée nationale)$/i, '').trim();
  if (!uid) throw new Error('identifiant du dossier introuvable sur la page');
  return { uid, titre };
}
function titreReunion(r) {
  const objet = liste(r.ODJ?.pointsODJ?.pointODJ).map(p => p.objet).find(Boolean);
  const base = r['@xsi:type'] === 'seance_type' ? 'Séance publique (AN)' : 'Commission (AN)';
  return objet ? `${base} – ${objet}` : base;
}
/** Réunions qui citent un dossier suivi : { evts (le mois écoulé et la suite), bilan par dossier sur tout l'historique } */
function reunionsDesDossiers(reunions, suivis, depuis) {
  const evts = [], bilan = new Map(), maintenantIso = new Date().toISOString();
  for (const r of reunions) {
    if (!r?.timeStampDebut) continue;
    const refs = new Set(liste(r.ODJ?.pointsODJ?.pointODJ).flatMap(p => liste(p.dossiersLegislatifsRefs?.dossierRef)));
    const suivi = [...refs].map(x => suivis.get(x)).find(Boolean);
    if (!suivi) continue;
    const b = bilan.get(suivi.id) || { total: 0, derniere: null, prochaine: null };
    b.total++;
    if (r.timeStampDebut < maintenantIso) { if (!b.derniere || r.timeStampDebut > b.derniere) b.derniere = r.timeStampDebut; }
    else if (!b.prochaine || r.timeStampDebut < b.prochaine) b.prochaine = r.timeStampDebut;
    bilan.set(suivi.id, b);
    if (r.timeStampDebut < depuis) continue;
    evts.push({
      uid: `${r.uid}@assemblee-nationale.fr`, debut: r.timeStampDebut, fin: r.timeStampFin || r.timeStampDebut, cree: r.cycleDeVie?.chrono?.creation,
      titre: titreReunion(r), lieu: r.lieu?.libelleLong || '', description: liste(r.ODJ?.convocationODJ?.item).join('\n'),
      url: suivi.lien, annule: /annul/i.test(r.cycleDeVie?.etat || ''), dossier: suivi.id,
    });
  }
  return { evts: evts.sort((a, b) => a.debut.localeCompare(b.debut) || a.uid.localeCompare(b.uid)), bilan };
}
const jourFr = iso => new Date(iso).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'long', year: 'numeric' });
function resultatDossier(uid, n, b) {
  const pl = (k, s, p = s + 's') => `${k} ${k > 1 ? p : s}`;
  if (!b || !b.total) return `Relais : aucune réunion ni séance de l’Assemblée ne cite encore ce dossier (${uid}).`;
  const avenir = b.prochaine ? `prochaine le ${jourFr(b.prochaine)}` : 'aucune à venir';
  const passe = b.derniere ? `, la dernière le ${jourFr(b.derniere)}` : '';
  return `Relais : ${pl(b.total, 'réunion ou séance', 'réunions ou séances')} de l’Assemblée sur ce dossier${passe} ; ${avenir}. ${pl(n, 'événement')} dans l’agenda (le mois écoulé et la suite) (${uid}).`;
}

/**
 * Relais : rien n'est écrit ici. Renvoie { contenus: Map(id -> iCal frais), echecs: Map(id -> raison), actions (écritures
 * à joindre au lot de la synchronisation), dossiers (dossiers mis à jour en mémoire) }.
 */
async function relayer(sources, dossiers) {
  const contenus = new Map(), echecs = new Map(), actions = [];
  const t = maintenant();
  const noter = (s, texte) => {
    contenus.set(s.id, texte);
    actions.push(['UpdateRecord', 'Sources', s.id, texte !== s.Contenu_relaye ? { Contenu_relaye: texte, Relaye_le: t } : { Relaye_le: t }]);
  };
  // Agendas Google ou Outlook
  for (const s of sources.filter(x => x.Type === 'Flux via relais' && x.Active && x.Nom !== SOURCE_AN && x.URL)) {
    try {
      const u = new URL(s.URL);
      if (u.protocol !== 'https:') throw new Error('adresse https:// attendue');
      const texte = await lireTexte(u);
      if (!/BEGIN:VCALENDAR/.test(texte)) throw new Error('ce n’est pas un agenda iCal');
      if (texte.length > MAX_ICS) throw new Error('agenda trop gros (plus de 2 Mo) : utilisez un agenda dédié');
      noter(s, texte);
      console.log(`Source n° ${s.id} : ${(texte.match(/BEGIN:VEVENT/g) || []).length} événements relayés.`);
    } catch (e) {
      // L'adresse n'est jamais écrite dans le journal : c'est souvent un lien secret
      echecs.set(s.id, e.message);
      actions.push(['UpdateRecord', 'Sources', s.id, { Resultat_synchro: '⚠ Relais : ' + e.message, Relaye_le: t }]);
      console.error(`Source n° ${s.id} : ${e.message}`);
    }
  }
  // Assemblée nationale
  const cible = sources.find(s => s.Nom === SOURCE_AN && s.Type === 'Flux via relais');
  const aSuivre = dossiers.map(d => ({ d, lien: estLienAN(d.Lien) ? d.Lien : estLienAN(d.Lien_autre) ? d.Lien_autre : null })).filter(x => x.lien);
  const majDossiers = new Map();
  if (cible && aSuivre.length) {
    const suivis = new Map(), notes = [];
    for (const { d, lien } of aSuivre) {
      try {
        const { uid, titre } = await identifierDossierAN(lien);
        suivis.set(uid, { id: d.id, lien });
        notes.push({ d, uid, titre });
      } catch (e) {
        if (estLienAN(d.Lien)) majDossiers.set(d.id, { Etat: 'Erreur', Derniere_verif: t, Resultat: 'Relais : ' + e.message });
        console.error(`Dossier n° ${d.id} : ${e.message}`);
      }
    }
    if (suivis.size) {
      const rep = mkdtempSync(path.join(tmpdir(), 'an-'));
      try {
        // Une panne de l'Assemblée (téléchargement, archive) ne bloque pas le reste : notée sur sa source, ses
        // événements gardés
        const reunions = [];
        parcourirZip(telecharger(AN_AGENDA, path.join(rep, 'Agenda.json.zip'), process.env.AN_AGENDA_ZIP), path.join('json', 'reunion'), o => reunions.push(o.reunion));
        const { evts, bilan } = reunionsDesDossiers(reunions, suivis, new Date(Date.now() - 31 * 86400000).toISOString());
        noter(cible, ics(SOURCE_AN, evts));
        console.log(`Assemblée nationale : ${reunions.length} réunions lues, ${evts.length} rattachées à ${suivis.size} dossier(s).`);
        for (const { d, uid, titre } of notes) {
          if (!estLienAN(d.Lien)) continue;   // dossier du Sénat suivi aussi à l'Assemblée : son état reste celui du module
          const f = { Etat: 'Suivi actif', Derniere_verif: t, Resultat: resultatDossier(uid, evts.filter(e => e.dossier === d.id).length, bilan.get(d.id)) };
          if (titre && (!d.Titre || /\s-\s+Dossiers législatifs\b/i.test(d.Titre))) f.Titre = titre;
          majDossiers.set(d.id, f);
        }
      } catch (e) {
        echecs.set(cible.id, 'agenda de l’Assemblée nationale illisible : ' + (e.message || e).split('\n')[0]);
        actions.push(['UpdateRecord', 'Sources', cible.id, { Resultat_synchro: '⚠ Relais : ' + echecs.get(cible.id), Relaye_le: t }]);
        console.error('Assemblée nationale : ' + echecs.get(cible.id));
        enEchec = true;
      } finally { rmSync(rep, { recursive: true, force: true }); }
    }
  } else if (!aSuivre.length) console.log('Aucun dossier de l’Assemblée nationale à suivre.');
  for (const [id, f] of majDossiers) actions.push(['UpdateRecord', 'Dossiers', id, f]);
  // Délais limites de la séance publique : tous si la source est suivie, sinon seulement ceux des dossiers suivis
  const cibleDelais = sources.find(s => s.Nom === SOURCE_DELAIS && s.Type === 'Flux via relais');
  if (cibleDelais && (cibleDelais.Active || dossiers.some(d => d.Etat !== 'Erreur'))) {
    try {
      const { seances, delais } = await delaisSenat(dossiers.map(d => (majDossiers.has(d.id) ? { ...d, ...majDossiers.get(d.id) } : d)));
      noter(cibleDelais, ics(SOURCE_DELAIS, delais));
      console.log(`Délais limites : ${delais.length} (amendements) dans ${seances} séances publiques, dont ${delais.filter(x => x.dossier).length} de dossiers suivis.`);
    } catch (e) {
      echecs.set(cibleDelais.id, e.message);
      actions.push(['UpdateRecord', 'Sources', cibleDelais.id, { Resultat_synchro: '⚠ Relais : ' + e.message, Relaye_le: t }]);
      console.error('Délais limites : ' + e.message);
      enEchec = true;
    }
  }
  return { contenus, echecs, actions, dossiers: dossiers.map(d => (majDossiers.has(d.id) ? { ...d, ...majDossiers.get(d.id) } : d)) };
}

// ------------------------------------------------------------------ gists (abonnements, répertoire)
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
const adresseGist = (g, fichier) => `${GIST_RAW}/${g.owner.login}/${g.id}/raw/${fichier}`;
/** Crée ou met à jour un gist secret d'un seul fichier ; renvoie le gist, ou null en simulation. */
async function deposer(id, fichier, contenu, description) {
  if (SIMULATION) return null;
  const files = { [fichier]: { content: contenu } };
  let g = id ? await gist('PATCH', `/gists/${id}`, { files }) : null;
  if (!g) g = await gist('POST', '/gists', { description, public: false, files });
  return g;
}

// ------------------------------------------------------------------ 3. abonnements de consultation
async function publierAbonnements(sources, dossiers) {
  let abonnements;
  try { abonnements = await lignes('Abonnements'); } catch (e) { console.log('Pas de table Abonnements : diffusion ignorée.'); return; }
  if (!abonnements.some(a => a.Actif || a.Gist)) return;
  const evts = await lignes('Evenements');
  const noms = { sources: new Map(sources.map(x => [x.id, x.Nom])), dossiers: new Map(dossiers.map(x => [x.id, x.Titre || x.Lien])) };
  const actions = [];
  // N'écrire dans Grist que ce qui change (la date de publication suit le contenu)
  const si = (a, f) => { if (Object.entries(f).some(([k, v]) => k !== 'Publie_le' && (a[k] ?? '') !== (v ?? ''))) actions.push(['UpdateRecord', 'Abonnements', a.id, f]); };
  for (const a of abonnements) {
    try {
      if (!a.Actif) {
        if (!a.Gist) continue;
        if (!GIST_TOKEN) throw new Error('jeton GitHub GIST_TOKEN absent : l’adresse n’a pas pu être supprimée');
        if (!SIMULATION) await gist('DELETE', `/gists/${a.Gist}`);
        si(a, { Gist: '', Adresse: '', Publie_le: maintenant(), Resultat: 'Publication arrêtée : l’adresse ne fonctionne plus.' });
        console.log(`Abonnement n° ${a.id} : publication arrêtée.`);
        continue;
      }
      if (!GIST_TOKEN) throw new Error('publication impossible : le jeton GitHub GIST_TOKEN n’est pas configuré dans le dépôt du relais');
      const choisis = D.selectionner(evts, a, maintenant());
      const g = await deposer(a.Gist, GIST_FICHIER, D.versIcs(a, choisis, noms), 'Calendrier PA (abonnement)');
      const f = { Publie_le: maintenant(), Resultat: `${choisis.length} événement${choisis.length > 1 ? 's' : ''} publié${choisis.length > 1 ? 's' : ''}.` };
      if (g) { f.Gist = g.id; f.Adresse = adresseGist(g, GIST_FICHIER); }
      si(a, f);
      console.log(`Abonnement n° ${a.id} : ${choisis.length} événements publiés.`);
    } catch (e) {
      si(a, { Publie_le: maintenant(), Resultat: '⚠ ' + e.message });
      console.error(`Abonnement n° ${a.id} : ${e.message}`);
    }
  }
  await appliquer(actions);
}

// ------------------------------------------------------------------ 4. répertoire des dossiers en cours
async function publierRepertoire() {
  const force = /^(1|true)$/i.test(process.env.FORCER_REPERTOIRE || '');
  if (!force && new Date().getUTCHours() !== REPERTOIRE_HEURE_UTC) return;
  if (!GIST_TOKEN) { console.error('Répertoire : jeton GitHub GIST_TOKEN absent, non publié.'); return; }
  const rep = mkdtempSync(path.join(tmpdir(), 'rep-'));
  try {
    const csv = new TextDecoder('windows-1252').decode(readFileSync(telecharger(SENAT_DOSSIERS, path.join(rep, 'senat.csv'), process.env.SENAT_DOSSIERS_CSV)));
    const an = [];
    parcourirZip(telecharger(AN_DOSSIERS, path.join(rep, 'an.zip'), process.env.AN_DOSSIERS_ZIP), path.join('json', 'dossierParlementaire'), o => an.push(o.dossierParlementaire));
    const { dossiers, exclusAN } = construireRepertoire(csv, an);
    if (dossiers.length < 100) throw new Error(`répertoire anormalement court (${dossiers.length}) : non publié`);
    const params = await lignes('Parametres');
    const p = k => params.find(x => x.Cle === k);
    const contenu = JSON.stringify({ genere: new Date().toISOString(), dossiers });
    const g = await deposer(p('repertoire_gist')?.Valeur, REPERTOIRE_FICHIER, contenu, 'Calendrier PA (répertoire des dossiers législatifs en cours)');
    const valeurs = [['repertoire_maj', String(maintenant()), 'Date du répertoire des dossiers en cours (écrite par le relais)']];
    if (g) valeurs.push(['repertoire_gist', g.id, 'Publication du répertoire (écrite par le relais)'], ['repertoire_url', adresseGist(g, REPERTOIRE_FICHIER), 'Adresse du répertoire des dossiers en cours (écrite par le relais)']);
    await appliquer(valeurs.map(([Cle, Valeur, Libelle]) => (p(Cle) ? ['UpdateRecord', 'Parametres', p(Cle).id, { Valeur }] : ['AddRecord', 'Parametres', null, { Cle, Valeur, Libelle }])));
    console.log(`Répertoire : ${dossiers.length} dossiers en cours publiés (${Math.round(contenu.length / 1024)} Ko), ${exclusAN} dossiers de l’Assemblée écartés (clos ou hors procédure législative).`);
  } finally { rmSync(rep, { recursive: true, force: true }); }
}

// ------------------------------------------------------------------ déroulé
// Chaque étape est cloisonnée : une panne n'empêche pas les suivantes ; le passage finit alors en échec, visible
// dans GitHub Actions (et signalé par courriel si le compte l'a demandé).
let enEchec = false;
const etape = async (nom, fn) => {
  try { return await fn(); } catch (e) { enEchec = true; console.error(`${nom} : ${(e && e.message ? e.message : String(e)).split('\n')[0]}`); return null; }
};
const [sources, dossiers, evenements] = await Promise.all(['Sources', 'Dossiers', 'Evenements'].map(lignes));
const relais = (await etape('Relais', () => relayer(sources, dossiers))) || { contenus: new Map(), echecs: new Map(), actions: [], dossiers };
const r = await etape('Synchronisation', () => M.synchroniser(
  { lireTexte, appliquer },
  { Sources: sources, Dossiers: relais.dossiers, Evenements: evenements },
  { ICAL, maintenant: maintenant(), contenus: relais.contenus, echecs: relais.echecs, actionsAvant: relais.actions }));
if (r) console.log(`Synchronisation : ${r.statut === 'fait' ? `${r.flux} flux lus, ${r.changements} changement(s)${r.erreurs ? `, ${r.erreurs} en erreur` : ''}` : r.bilan}`);
await etape('Diffusion', () => publierAbonnements(sources, relais.dossiers));
await etape('Répertoire', () => publierRepertoire());
console.log(`Relais terminé${enEchec ? ' avec des erreurs' : ''} (${appels} appels à l’API Grist).`);
if (enEchec) process.exitCode = 1;

