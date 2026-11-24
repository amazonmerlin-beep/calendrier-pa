// Formulaire.diffusion — ce qu'un abonnement de consultation diffuse, et son agenda iCal. Fonctions pures, partagées :
// le module s'en sert pour l'aperçu (ce qui partira), le relais pour la publication (relais/relais.mjs). Ce qui est
// annoncé à l'écran est donc exactement ce qui est publié.
(function (L) {
  'use strict';

  const NIVEAUX = ['Titres et horaires', 'Avec lieu et description', 'Avec notes internes'];
  const JOURS_PASSES = 60;   // un abonnement montre aussi les deux derniers mois

  // Les listes arrivent ['L', 1, 2] par l'API REST, [1, 2] par le module (déjà décodées)
  const liste = v => (Array.isArray(v) ? (v[0] === 'L' ? v.slice(1) : v) : []);
  const niveau = a => Math.max(0, NIVEAUX.indexOf(a.Niveau));

  /** Événements qu'un abonnement diffuse, par date. */
  function selectionner(evenements, abonnement, maintenant) {
    const sources = new Set(liste(abonnement.Sources)), dossiers = new Set(liste(abonnement.Dossiers));
    const depuis = maintenant - JOURS_PASSES * 86400;
    return evenements.filter(e => typeof e.Debut === 'number'
      && Math.max(e.Fin || e.Debut, e.Debut) >= depuis
      && e.Diffusion !== 'Interne'
      && (abonnement.Annules || !e.Statut)
      && (sources.has(e.Source) || (e.Dossier && dossiers.has(e.Dossier))))
      .sort((a, b) => a.Debut - b.Debut || a.id - b.id);
  }

  // ------------------------------------------------------------------ iCal (RFC 5545)
  const echapper = s => String(s === null || s === undefined ? '' : s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const deux = n => String(n).padStart(2, '0');
  function utc(sec) {
    const d = new Date(sec * 1000);
    return `${d.getUTCFullYear()}${deux(d.getUTCMonth() + 1)}${deux(d.getUTCDate())}T${deux(d.getUTCHours())}${deux(d.getUTCMinutes())}${deux(d.getUTCSeconds())}Z`;
  }
  const fmtParis = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' });
  const jourParis = sec => fmtParis.format(new Date(sec * 1000)).replace(/-/g, '');   // AAAAMMJJ
  function lendemain(aaaammjj) {
    const d = new Date(Date.UTC(+aaaammjj.slice(0, 4), +aaaammjj.slice(4, 6) - 1, +aaaammjj.slice(6, 8) + 1));
    return `${d.getUTCFullYear()}${deux(d.getUTCMonth() + 1)}${deux(d.getUTCDate())}`;
  }
  // Lignes de 75 octets au plus, sans couper un caractère (UTF-8)
  function plier(ligne) {
    const octets = s => new TextEncoder().encode(s).length;
    if (octets(ligne) <= 75) return ligne;
    const out = [];
    let cour = '', max = 75;
    for (const c of ligne) {
      if (octets(cour + c) > max) { out.push(cour); cour = ''; max = 74; }
      cour += c;
    }
    out.push(cour);
    return out.join('\r\n ');
  }
  const surSite = url => /^https?:\/\//i.test(String(url || ''));

  /**
   * Agenda iCal d'un abonnement. noms : { sources: Map(id -> nom), dossiers: Map(id -> titre) }.
   * Niveau 0 : titre, horaires, agenda. 1 : + lieu, description, lien, dossier. 2 : + notes internes.
   */
  function versIcs(abonnement, evenements, noms = {}) {
    const n = niveau(abonnement);
    const nomSource = id => (noms.sources && noms.sources.get(id)) || '';
    const nomDossier = id => (noms.dossiers && noms.dossiers.get(id)) || '';
    const l = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Calendrier PA//Diffusion//FR', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      // Propriété non standard : tous les clients ne décodent pas « \, » ; le nom part brut, sur une ligne
      `X-WR-CALNAME:${String(abonnement.Nom || 'Calendrier PA').replace(/[\r\n\\]+/g, ' ').trim()}`, 'X-WR-TIMEZONE:Europe/Paris',
      'REFRESH-INTERVAL;VALUE=DURATION:PT2H', 'X-PUBLISHED-TTL:PT2H'];
    for (const e of evenements) {
      const annule = !!e.Statut;
      l.push('BEGIN:VEVENT', `UID:calpa-${e.id}@calendrier-pa`, `DTSTAMP:${utc(e.Modifie_le || e.Cree_le || e.Debut)}`);
      if (e.Journee_entiere) {
        const d = jourParis(e.Debut), f = jourParis(Math.max(e.Fin || e.Debut, e.Debut));
        l.push(`DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${lendemain(f)}`);
      } else {
        l.push(`DTSTART:${utc(e.Debut)}`, `DTEND:${utc(Math.max(e.Fin || e.Debut, e.Debut))}`);
      }
      l.push(`SUMMARY:${echapper((annule ? 'Annulé : ' : '') + (e.Titre || '(Sans titre)'))}`);
      if (nomSource(e.Source)) l.push(`CATEGORIES:${echapper(nomSource(e.Source))}`);
      if (annule) l.push('STATUS:CANCELLED');
      if (n >= 1) {
        if (e.Lieu) l.push(`LOCATION:${echapper(e.Lieu)}`);
        const desc = [e.Description, e.Dossier && nomDossier(e.Dossier) ? `Dossier : ${nomDossier(e.Dossier)}` : '',
          n >= 2 && e.Notes ? `Notes internes : ${e.Notes}` : ''].filter(Boolean).join('\n\n');
        if (desc) l.push(`DESCRIPTION:${echapper(desc)}`);
        if (surSite(e.Lien)) l.push(`URL:${String(e.Lien).trim()}`);
      }
      l.push('END:VEVENT');
    }
    l.push('END:VCALENDAR');
    return l.map(plier).join('\r\n') + '\r\n';
  }

  L.diffusion = { NIVEAUX, JOURS_PASSES, selectionner, versIcs, liste };
})(globalThis.Formulaire = globalThis.Formulaire || {});
