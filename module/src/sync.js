// Formulaire.sync — moteur de synchronisation iCal -> Grist, sans accès à Grist ni au réseau (fonctions pures).
// Testé sous Node (module/test/sync.test.js) avec les vrais flux du Sénat (tests/fixtures).
// Dépend d'ical.js (passé en paramètre) et de l'API Intl.
(function (L) {
  'use strict';

  const PARIS = 'Europe/Paris';
  const SYNC_AUTEUR = 'Synchronisation automatique';
  const STATUT_RETIRE = 'Retiré de la source';
  const STATUT_ANNULE = 'Annulé';
  const LIMITES = { titre: 300, lieu: 300, description: 6000, url: 2000 };
  const RECUR = { joursAvant: 31, joursApres: 400, maxOccurrences: 500, maxIterations: 20000 };

  // Fuseaux Windows (Outlook, Exchange) -> IANA. Les fichiers Outlook fournissent en général aussi un VTIMEZONE.
  const WINDOWS_TZ = {
    'romance standard time': 'Europe/Paris', 'w. europe standard time': 'Europe/Berlin',
    'central europe standard time': 'Europe/Budapest', 'central european standard time': 'Europe/Warsaw',
    'gmt standard time': 'Europe/London', 'greenwich standard time': 'Atlantic/Reykjavik', utc: 'UTC',
    'coordinated universal time': 'UTC', 'e. europe standard time': 'Europe/Chisinau', 'fle standard time': 'Europe/Kiev',
    'gtb standard time': 'Europe/Bucharest', 'morocco standard time': 'Africa/Casablanca',
    'eastern standard time': 'America/New_York', 'central standard time': 'America/Chicago',
    'mountain standard time': 'America/Denver', 'pacific standard time': 'America/Los_Angeles',
    'sa western standard time': 'America/La_Paz', 'arabian standard time': 'Asia/Dubai',
  };

  // ------------------------------------------------------------------ fuseaux horaires
  const formats = new Map();
  function fmt(tz) {
    let f = formats.get(tz);
    if (!f) {
      f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      formats.set(tz, f);
    }
    return f;
  }
  function estIana(tz) {
    if (!tz || typeof tz !== 'string') return false;
    try { fmt(tz); return true; } catch (e) { return false; }
  }
  /** Nom de fuseau exploitable (IANA), ou null. */
  function resoudreFuseau(tzid) {
    if (!tzid) return null;
    const brut = String(tzid).trim().replace(/^"|"$/g, '');
    if (estIana(brut)) return brut;
    const m = brut.match(/([A-Za-z_]+\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?)$/);   // "/mozilla.org/…/Europe/Paris"
    if (m && estIana(m[1])) return m[1];
    return WINDOWS_TZ[brut.toLowerCase()] || null;
  }
  function parties(ms, tz) {
    const p = {};
    for (const { type, value } of fmt(tz).formatToParts(new Date(ms))) p[type] = value;
    return { annee: +p.year, mois: +p.month, jour: +p.day, heure: +p.hour % 24, minute: +p.minute, seconde: +p.second };
  }
  function decalage(ms, tz) {
    const p = parties(ms, tz);
    return Date.UTC(p.annee, p.mois - 1, p.jour, p.heure, p.minute, p.seconde) - Math.floor(ms / 1000) * 1000;
  }
  /** Heure « murale » dans un fuseau -> secondes Unix (changements d'heure compris). */
  function versEpoch(a, mo, j, h, mi, s, tz = PARIS) {
    const essai = Date.UTC(a, mo - 1, j, h, mi, s);
    const d1 = decalage(essai, tz);
    let t = essai - d1;
    const d2 = decalage(t, tz);
    if (d2 !== d1) t = essai - d2;
    return Math.round(t / 1000);
  }
  const partiesParis = sec => parties(sec * 1000, PARIS);
  function debutJourParis(sec) { const p = partiesParis(sec); return versEpoch(p.annee, p.mois, p.jour, 0, 0, 0); }

  // ------------------------------------------------------------------ petites aides
  function nettoyer(v, max) {
    if (v === null || v === undefined) return '';
    let s = String(v).replace(/\r\n?/g, '\n').replace(/ /g, ' ');
    s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (max && s.length > max) s = s.slice(0, max - 1).trimEnd() + '…';
    return s;
  }
  /** Liens http(s) seulement : jamais javascript:, data:… */
  function urlSure(v) {
    const s = nettoyer(v, LIMITES.url);
    if (!s) return '';
    try { const u = new URL(s); return (u.protocol === 'https:' || u.protocol === 'http:') ? u.href : ''; } catch (e) { return ''; }
  }
  /** Empreinte 53 bits (cyrb53) : sert seulement à voir qu'une source a changé. */
  function empreinte(obj) {
    const str = JSON.stringify(obj);
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 'v1-' + (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }
  const vide = v => v === null || v === undefined || String(v).trim() === '';

  // ------------------------------------------------------------------ lecture d'un fichier iCal
  /**
   * Lit un texte iCal ; renvoie { items, methode, nomAgenda, alertes }.
   * Chaque item : { uid, titre, debut, fin, journee, lieu, description, url, annule, categories, horaireSenat, recurrent }.
   * Options : maintenant (secondes Unix), fuseauParDefaut (heures « flottantes », Europe/Paris).
   */
  function lireIcs(ICAL, texte, opts) {
    const o = Object.assign({ maintenant: Math.floor(Date.now() / 1000), fuseauParDefaut: PARIS }, opts || {});
    if (typeof texte !== 'string' || !/BEGIN:VCALENDAR/i.test(texte)) throw new Error("Ce contenu n'est pas un fichier iCal (BEGIN:VCALENDAR absent).");
    let jcal;
    try { jcal = ICAL.parse(texte.replace(/^﻿/, '').trim()); }
    catch (e) { throw new Error('Fichier iCal illisible : ' + (e && e.message ? e.message : e)); }
    const agendas = (Array.isArray(jcal) && Array.isArray(jcal[0])) ? jcal : [jcal];
    const alertes = [], items = [];
    let methode = '', nomAgenda = '';
    const fenetreDebut = o.maintenant - RECUR.joursAvant * 86400;
    const fenetreFin = o.maintenant + RECUR.joursApres * 86400;

    for (const cal of agendas) {
      const vcal = new ICAL.Component(cal);
      methode = methode || String(vcal.getFirstPropertyValue('method') || '').toUpperCase();
      nomAgenda = nomAgenda || nettoyer(vcal.getFirstPropertyValue('x-wr-calname'), 200);
      ICAL.TimezoneService.reset();
      for (const vtz of vcal.getAllSubcomponents('vtimezone')) {
        try { ICAL.TimezoneService.register(vtz); } catch (e) { /* bloc invalide : ignoré */ }
      }
      try {
        const series = new Map(), exceptions = new Map();
        for (const ve of vcal.getAllSubcomponents('vevent')) {
          const uid = nettoyer(ve.getFirstPropertyValue('uid'), 500);
          if (!uid) { alertes.push('Un événement sans identifiant (UID) a été ignoré.'); continue; }
          if (ve.hasProperty('recurrence-id')) {
            if (!exceptions.has(uid)) exceptions.set(uid, []);
            exceptions.get(uid).push(ve);
          } else if (series.has(uid)) alertes.push('Identifiant en double ignoré : ' + uid);
          else series.set(uid, ve);
        }
        for (const [uid, ve] of series) {
          const exc = exceptions.get(uid) || [];
          exceptions.delete(uid);
          let ev;
          try { ev = new ICAL.Event(ve, { exceptions: exc, strictExceptions: true }); }
          catch (e) { alertes.push(`Événement illisible ignoré (${uid}) : ${e.message}`); continue; }
          if (!ev.startDate) { alertes.push('Événement sans date ignoré : ' + uid); continue; }
          if (ev.isRecurring()) deplier(ev, uid, methode, o, fenetreDebut, fenetreFin, items, alertes);
          else { const it = item(ev, ev.startDate, ev.endDate, uid, methode, o); if (it) items.push(it); }
        }
        // Occurrences modifiées sans leur série (invitation Outlook pour une seule occurrence)
        for (const [uid, liste] of exceptions) {
          for (const ve of liste) {
            try {
              const ev = new ICAL.Event(ve);
              const rp = ve.getFirstProperty('recurrence-id');
              const cle = uid + '#' + (ev.recurrenceId ? enEpoch(ev.recurrenceId, rp && rp.getParameter('tzid'), o).epoch : 'x');
              const it = item(ev, ev.startDate, ev.endDate, cle, methode, o);
              if (it) items.push(it);
            } catch (e) { alertes.push(`Occurrence illisible ignorée (${uid}) : ${e.message}`); }
          }
        }
      } finally { ICAL.TimezoneService.reset(); }
    }
    return { items, methode, nomAgenda, alertes };
  }

  function deplier(ev, uid, methode, o, fenetreDebut, fenetreFin, items, alertes) {
    const it = ev.iterator();
    const tzid = ev.component.getFirstProperty('dtstart').getParameter('tzid');
    let produits = 0, pas = 0, suivant;
    while ((suivant = it.next())) {
      if (++pas > RECUR.maxIterations) { alertes.push('Récurrence trop longue, tronquée : ' + ev.summary); break; }
      const debut = enEpoch(suivant, tzid, o).epoch;
      if (debut > fenetreFin) break;
      const d = ev.getOccurrenceDetails(suivant);
      const x = item(d.item || ev, d.startDate, d.endDate, uid + '#' + debut, methode, o);
      if (!x || (x.fin < fenetreDebut && x.debut < fenetreDebut)) continue;
      x.recurrent = true;
      items.push(x);
      if (++produits >= RECUR.maxOccurrences) { alertes.push(`Récurrence limitée à ${RECUR.maxOccurrences} occurrences : ${ev.summary}`); break; }
    }
  }

  /** ICAL.Time -> { epoch, journee } en tenant compte du fuseau. */
  function enEpoch(t, tzidParam, o) {
    if (t.isDate) return { epoch: versEpoch(t.year, t.month, t.day, 0, 0, 0), journee: true };
    const zone = t.zone && t.zone.tzid;
    if (zone === 'UTC' || zone === 'Z') return { epoch: t.toUnixTime(), journee: false };
    const tzid = tzidParam || (zone && zone !== 'floating' ? zone : null);
    if (estIana(tzid)) return { epoch: versEpoch(t.year, t.month, t.day, t.hour, t.minute, t.second, tzid), journee: false };
    // Fuseau défini par un bloc VTIMEZONE du fichier
    if (tzid && t.zone && t.zone.component && zone === tzid) return { epoch: t.toUnixTime(), journee: false };
    const tz = resoudreFuseau(tzid) || o.fuseauParDefaut || PARIS;
    return { epoch: versEpoch(t.year, t.month, t.day, t.hour, t.minute, t.second, tz), journee: false };
  }

  function item(ev, debutT, finT, uid, methode, o) {
    const comp = ev.component;
    const pd = comp.getFirstProperty('dtstart'), pf = comp.getFirstProperty('dtend');
    const tzD = pd && pd.getParameter('tzid');
    const d = enEpoch(debutT, tzD, o);
    const f = finT ? enEpoch(finT, (pf && pf.getParameter('tzid')) || tzD, o) : null;
    const debut = d.epoch;
    let fin = f ? f.epoch : debut;
    // Journée entière : DTEND est exclusif (lendemain à minuit) ; on garde le dernier jour inclus à 23:59
    if (d.journee) fin = (f && f.epoch > debut) ? f.epoch - 60 : debut + 86400 - 60;
    if (fin < debut) fin = debut;
    const statut = String(comp.getFirstPropertyValue('status') || '').toUpperCase();
    const horaire = comp.getFirstPropertyValue('x-aglae-starttype');
    return {
      uid, titre: nettoyer(ev.summary, LIMITES.titre) || '(Sans titre)', debut, fin, journee: d.journee,
      lieu: nettoyer(ev.location, LIMITES.lieu), description: nettoyer(ev.description, LIMITES.description),
      url: urlSure(comp.getFirstPropertyValue('url')), annule: statut === 'CANCELLED' || methode === 'CANCEL',
      categories: nettoyer(comp.getFirstPropertyValue('categories'), 200), horaireSenat: horaire ? nettoyer(horaire, 200) : '',
      // Posé par le relais GitHub : identifiant du dossier suivi (ligne Dossiers) auquel la réunion se rattache
      dossierRelais: Number(comp.getFirstPropertyValue('x-calpa-dossier')) || null,
      recurrent: false,
    };
  }

  // ------------------------------------------------------------------ Sénat
  const estFluxSenat = url => /^https:\/\/www\.senat\.fr\/aglae\//i.test(String(url || ''));
  const deux = n => String(n).padStart(2, '0');
  /** Complète un événement d'un flux Aglaé : lien vers sa fiche, horaire annoncé, avertissement sur la fin. */
  function adapterSenat(it) {
    const x = Object.assign({}, it);
    const m = String(it.uid).match(/-(\d+)@senat\.fr$/i);
    if (m) { const p = partiesParis(it.debut); x.url = `https://agenda.senat.fr/${p.annee}/${deux(p.mois)}/${deux(p.jour)}/event/${m[1]}`; }
    else if (/^https?:\/\/www\.senat\.fr\/?$/i.test(it.url)) x.url = 'https://agenda.senat.fr/';
    const plus = [];
    if (it.horaireSenat && !/^\d{1,2}h\d{2}$/i.test(it.horaireSenat.replace(/\s/g, ''))) plus.push('Horaire annoncé par le Sénat : ' + it.horaireSenat);
    if (!it.journee) plus.push('Heure de fin non publiée par le Sénat : la durée affichée (2 h) est indicative.');
    if (plus.length) x.description = nettoyer([it.description, plus.join('\n')].filter(Boolean).join('\n\n'), LIMITES.description);
    return x;
  }

  // Numéro de texte du Sénat : « n° 155 (2026-2027) », « n° 155, 2026-2027 », « n°953 rect. (2025-2026) »
  const RE_NUMERO = /n[°o]\s*(\d{1,4})\s*(?:rect\.?\s*(?:bis|ter)?\s*)?(?:\(|,)\s*(\d{4})\s*[-‑–]\s*(\d{4})/gi;
  /** Numéros de textes du Sénat cités dans un texte libre : ['155/2026-2027', …]. */
  function numerosSenat(texte) {
    const s = new Set();
    for (const m of String(texte || '').matchAll(RE_NUMERO)) if (+m[3] === +m[2] + 1) s.add(`${+m[1]}/${m[2]}-${m[3]}`);
    return [...s];
  }
  const libelleNumero = k => { const [n, sess] = k.split('/'); return `n° ${n} (${sess})`; };

  const entites = s => String(s || '').replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&(amp|lt|gt|quot|apos|rsquo|lsquo|laquo|raquo|eacute|egrave|agrave|ccedil);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", rsquo: '’', lsquo: '‘', laquo: '«', raquo: '»', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç' }[e]));
  const sansBalises = html => entites(String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

  /**
   * Analyse la page d'un dossier législatif du Sénat (www.senat.fr/dossier-legislatif/…).
   * Renvoie { titre, numeros: ['155/2026-2027'], calendrier: ['discussion en séance publique les …'], lienAN }.
   */
  function analyserDossierSenat(html) {
    const h1 = (/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html) || [])[1];
    const titrePage = (/<title>([\s\S]*?)<\/title>/i.exec(html) || [])[1];
    const titre = nettoyer(sansBalises(h1) || sansBalises(titrePage).replace(/\s*-\s*Sénat\s*$/i, ''), 300);
    const texte = sansBalises(html);
    const numeros = new Set(numerosSenat(texte));
    // Liens des textes et rapports : /leg/pjl26-155.html, /rap/l26-156-1/ → session 2026-2027
    for (const m of String(html).matchAll(/href="[^"]*\/(?:leg\/(?:pjl|ppl|tas|ppr)|rap\/[alr])(\d{2})-(\d{1,4})/gi)) {
      const a = 2000 + +m[1];
      numeros.add(`${+m[2]}/${a}-${a + 1}`);
    }
    const calendrier = [];
    for (const m of texte.matchAll(/(?:discussion|examen)\s+en\s+(?:séance publique|commission)[^.;]{0,300}?\b(?:19|20)\d{2}\b/gi)) {
      const p = nettoyer(m[0].replace(/\s+([,.])/g, '$1'), 400);
      if (!calendrier.includes(p)) calendrier.push(p);
    }
    const an = /href="(https:\/\/www\.assemblee-nationale\.fr\/dyn\/\d+\/dossiers\/[^"#?]+)/i.exec(html);
    return { titre, numeros: [...numeros].sort(), calendrier, lienAN: an ? an[1] : '' };
  }

  /** Type d'un lien de dossier législatif : 'senat', 'an' ou null. */
  function typeLienDossier(lien) {
    let u;
    try { u = new URL(String(lien || '').trim()); } catch (e) { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (/(^|\.)senat\.fr$/i.test(u.hostname) && /\/(dossier-legislatif|dossierleg)\//i.test(u.pathname)) return 'senat';
    if (/(^|\.)assemblee-nationale\.fr$/i.test(u.hostname) && /\/dossiers\//i.test(u.pathname)) return 'an';
    return null;
  }
  /** Adresse canonique d'un dossier du Sénat (https, www, dossier-legislatif, sans ancre). */
  function lienDossierCanonique(lien) {
    const u = new URL(String(lien).trim());
    u.hash = ''; u.search = '';
    if (/senat\.fr$/i.test(u.hostname)) { u.protocol = 'https:'; u.hostname = 'www.senat.fr'; u.pathname = u.pathname.replace('/dossierleg/', '/dossier-legislatif/'); }
    return u.href;
  }

  // ------------------------------------------------------------------ plan de synchronisation
  const empreinteItem = it => empreinte([it.titre, it.debut, it.fin, it.journee, it.lieu, it.description, it.url, it.annule, it.dossier || null]);

  /**
   * Compare les éléments d'une source avec les lignes déjà dans Grist. Fonction pure.
   *  sourceId    ligne Sources
   *  items       éléments retenus (déjà adaptés ; it.dossier = id du dossier rapproché, facultatif)
   *  existants   lignes Evenements de CETTE source
   *  maintenant  secondes Unix
   *  mode        'flux' (peut retirer) ou 'import' (fichier : ne retire jamais rien)
   *  flux        { nombre, horizon } : taille et dernière date du flux COMPLET (avant filtrage) ; un flux vide ne
   *              retire rien (protection contre une panne côté source)
   * Règles : UID nouveau -> ajout ; UID connu et source inchangée -> rien (les retouches faites dans l'agenda
   * sont gardées) ; source changée -> elle fait foi sur ses champs, jamais sur les notes ; flux seulement : un
   * événement à venir (entre aujourd'hui et l'horizon du flux) absent des éléments retenus est supprimé, ou marqué
   * « Retiré de la source » s'il porte des notes.
   */
  function planifier({ sourceId, items, existants, maintenant, mode, flux }) {
    const estFlux = mode === 'flux';
    const st = { recus: items.length, ajoutes: 0, modifies: 0, inchanges: 0, supprimes: 0, marques: 0, retablis: 0, doublons: 0 };
    const ajouts = [], modifs = [], suppressions = [];

    // Doublons (deux synchronisations simultanées) : on garde la plus ancienne, ou celle qui a des notes
    const parUid = new Map();
    for (const r of existants.slice().sort((a, b) => a.id - b.id)) {
      if (vide(r.UID)) continue;
      const gardee = parUid.get(r.UID);
      if (!gardee) { parUid.set(r.UID, r); continue; }
      if (vide(gardee.Notes) && !vide(r.Notes)) { parUid.set(r.UID, r); suppressions.push(gardee.id); st.doublons++; }
      else if (vide(r.Notes)) { suppressions.push(r.id); st.doublons++; }
    }

    const vus = new Set();
    for (const it of items) {
      if (vus.has(it.uid)) continue;
      vus.add(it.uid);
      const fp = empreinteItem(it);
      const r = parUid.get(it.uid);
      const base = { Titre: it.titre, Debut: it.debut, Fin: it.fin, Journee_entiere: !!it.journee, Lieu: it.lieu, Description: it.description, Empreinte: fp };
      if (!r) {
        const c = Object.assign({}, base, { Lien: it.url, Source: sourceId, UID: it.uid, Statut: it.annule ? STATUT_ANNULE : null, Dossier: it.dossier || null });
        if (estFlux) { c.Cree_par = SYNC_AUTEUR; c.Modifie_par = SYNC_AUTEUR; }
        ajouts.push(c); st.ajoutes++;
        continue;
      }
      if (r.Empreinte === fp) {
        const c = {};
        if (r.Statut === STATUT_RETIRE) { c.Statut = it.annule ? STATUT_ANNULE : null; st.retablis++; }
        // Rattachement perdu (dossier retiré puis suivi de nouveau) : la source le redonne ; un rattachement posé à la
        // main sur un événement que la source ne rattache pas n'est jamais effacé
        if (it.dossier && it.dossier !== r.Dossier) c.Dossier = it.dossier;
        if (Object.keys(c).length) {
          if (estFlux) c.Modifie_par = SYNC_AUTEUR;
          modifs.push({ id: r.id, champs: c });
        } else st.inchanges++;
        continue;
      }
      const c = Object.assign({}, base);
      if (it.url || estFlux) c.Lien = it.url || r.Lien || '';
      if (it.dossier && it.dossier !== r.Dossier) c.Dossier = it.dossier;
      if (it.annule) c.Statut = STATUT_ANNULE;
      else if (r.Statut === STATUT_RETIRE || r.Statut === STATUT_ANNULE) c.Statut = null;   // de nouveau maintenu
      if (estFlux) c.Modifie_par = SYNC_AUTEUR;
      modifs.push({ id: r.id, champs: c }); st.modifies++;
    }

    if (estFlux && flux && flux.nombre > 0) {
      const aujourdhui = debutJourParis(maintenant);
      for (const r of parUid.values()) {
        if (vus.has(r.UID)) continue;
        const d = typeof r.Debut === 'number' ? r.Debut : null;
        if (d === null || d < aujourdhui || d > flux.horizon) continue;
        if (vide(r.Notes)) { suppressions.push(r.id); st.supprimes++; }
        else if (r.Statut !== STATUT_RETIRE) { modifs.push({ id: r.id, champs: { Statut: STATUT_RETIRE, Modifie_par: SYNC_AUTEUR } }); st.marques++; }
      }
    }
    return { ajouts, modifs, suppressions, stats: st };
  }

  /** Plan -> actions Grist, à envoyer en un seul lot (une seule annulation possible). */
  function actionsDuPlan(table, plan) {
    const a = [];
    if (plan.ajouts.length) {
      const cles = [...new Set(plan.ajouts.flatMap(c => Object.keys(c)))];
      a.push(['BulkAddRecord', table, plan.ajouts.map(() => null), Object.fromEntries(cles.map(k => [k, plan.ajouts.map(c => (k in c ? c[k] : null))]))]);
    }
    for (const m of plan.modifs) a.push(['UpdateRecord', table, m.id, m.champs]);
    if (plan.suppressions.length) a.push(['BulkRemoveRecord', table, [...new Set(plan.suppressions)]]);
    return a;
  }

  const pl = (n, s, p) => `${n} ${n > 1 ? (p || s + 's') : s}`;
  function resumer(st) {
    const x = [pl(st.recus, 'événement retenu', 'événements retenus')];
    if (st.ajoutes) x.push(pl(st.ajoutes, 'ajouté'));
    if (st.modifies) x.push(`${st.modifies} mis à jour`);
    if (st.supprimes) x.push(`${pl(st.supprimes, 'supprimé')} (retiré${st.supprimes > 1 ? 's' : ''} par la source)`);
    if (st.marques) x.push(`${pl(st.marques, 'marqué')} « retiré de la source » (annoté${st.marques > 1 ? 's' : ''}, donc gardé${st.marques > 1 ? 's' : ''})`);
    if (st.retablis) x.push(pl(st.retablis, 'rétabli'));
    if (st.doublons) x.push(pl(st.doublons, 'doublon supprimé', 'doublons supprimés'));
    if (!st.ajoutes && !st.modifies && !st.supprimes && !st.marques && !st.retablis) x.push('aucun changement');
    return x.join(' · ');
  }

  L.sync = {
    PARIS, SYNC_AUTEUR, STATUT_RETIRE, STATUT_ANNULE, LIMITES, RECUR,
    resoudreFuseau, versEpoch, partiesParis, debutJourParis, nettoyer, urlSure, empreinte, empreinteItem,
    lireIcs, estFluxSenat, adapterSenat, numerosSenat, libelleNumero, analyserDossierSenat, typeLienDossier,
    lienDossierCanonique, planifier, actionsDuPlan, resumer, sansBalises,
  };
})(globalThis.Formulaire = globalThis.Formulaire || {});
