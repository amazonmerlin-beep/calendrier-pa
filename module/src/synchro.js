// Formulaire.synchro — la synchronisation vue du navigateur : état affiché, chargement d'ical.js, déclenchement à
// l'ouverture de l'agenda, import de fichiers .ics. Le déroulé est celui du moteur commun (moteur.js), le même que
// celui du relais GitHub, qui synchronise aussi seul toutes les deux heures. Écrit avec les droits de la personne
// connectée (règles d'accès).
(function (L) {
  'use strict';
  const C = L.core, S = L.sync;

  // ical.js : version figée, empreinte vérifiée avant exécution (équivalent d'un attribut integrity)
  const ICAL_URL = 'https://cdn.jsdelivr.net/npm/ical.js@2.1.0/dist/ical.min.js';
  const ICAL_SHA256 = 'SoyhZHtbk+X89f7lnErRxZcTjRCMwsfoiFT2iPcRQ20=';
  const maintenant = () => Math.floor(Date.now() / 1000);

  let icalPromesse = null;
  function chargerIcal() {
    if (!icalPromesse) {
      icalPromesse = (async () => {
        const r = await fetch(ICAL_URL, { credentials: 'omit' });
        if (!r.ok) throw new Error(`bibliothèque iCal indisponible (${r.status})`);
        const octets = await r.arrayBuffer();
        const h = new Uint8Array(await crypto.subtle.digest('SHA-256', octets));
        if (btoa(String.fromCharCode(...h)) !== ICAL_SHA256) throw new Error('bibliothèque iCal altérée : empreinte inattendue, chargement refusé');
        const url = URL.createObjectURL(new Blob([octets], { type: 'text/javascript' }));
        try { return (await import(url)).default; } finally { URL.revokeObjectURL(url); }
      })().catch(e => { icalPromesse = null; throw e; });
    }
    return icalPromesse;
  }

  async function lireTexte(url) {
    let r;
    try { r = await fetch(url, { credentials: 'omit', cache: 'no-store' }); }
    catch (e) { throw new Error('lecture refusée par le site (il n’autorise pas la lecture depuis un navigateur) ou réseau indisponible'); }
    if (!r.ok) throw new Error(`le site répond « erreur ${r.status} »`);
    return r.text();
  }

  // ------------------------------------------------------------------ état affiché
  const etat = { enCours: false, etape: '', message: '', erreur: false, lectureSeule: false };
  function htmlEtat() {
    const sources = (C.etat.doc.Sources || []).filter(s => s.Type === 'Flux iCal' && s.Active);
    const derniere = Math.max(0, ...sources.map(s => s.Derniere_synchro || 0));
    const enErreur = sources.filter(s => /^⚠/.test(s.Resultat_synchro || ''));
    let txt, cls = '';
    if (etat.enCours) { txt = etat.etape || 'Synchronisation en cours…'; cls = 'en-cours'; }
    else if (etat.lectureSeule) { txt = 'Votre compte ne peut pas synchroniser : l’agenda sera mis à jour par un membre.'; }
    else if (etat.erreur) { txt = etat.message; cls = 'erreur'; }
    else if (!derniere) txt = 'Flux pas encore synchronisés.';
    else txt = `Flux synchronisés ${depuis(derniere)}${enErreur.length ? ` · ${enErreur.length} en erreur` : ''}.`;
    if (enErreur.length && !etat.enCours) cls = 'erreur';
    return `<span class="ag-synchro-texte ${cls}">${C.esc(txt)}</span>${etat.enCours ? '' : ' <button type="button" class="btn lien" data-action="synchroniser">Synchroniser maintenant</button>'}`;
  }
  function depuis(sec) {
    const m = Math.round((Date.now() / 1000 - sec) / 60);
    if (m < 1) return 'à l’instant';
    if (m < 60) return `il y a ${m} min`;
    const h = Math.round(m / 60);
    if (h < 24) return `il y a ${h} h`;
    return `le ${new Date(sec * 1000).toLocaleDateString('fr-FR', { timeZone: S.PARIS, day: 'numeric', month: 'long' })}`;
  }
  function majEtat(etape) {
    if (etape !== undefined) etat.etape = etape;
    document.querySelectorAll('[data-etat-synchro]').forEach(el => { el.innerHTML = htmlEtat(); });
  }

  // ------------------------------------------------------------------ synchronisation (moteur commun : moteur.js)
  const M = L.moteur;
  function perimee(t = maintenant()) {
    return M.perimee(C.etat.doc, t, (Number(C.param('synchro_minutes', '30')) || 30) * 60);
  }
  async function synchroniser({ manuel = false } = {}) {
    if (etat.enCours || !C.etat.moi || !C.etat.moi.connu) return;
    etat.enCours = true; etat.erreur = false; etat.message = '';
    majEtat('Synchronisation en cours…');
    let r = null;
    try {
      const [Sources, Dossiers, Evenements] = await Promise.all(['Sources', 'Dossiers', 'Evenements'].map(C.lireTable));
      const ICAL = await chargerIcal();
      r = await M.synchroniser(
        { lireTexte, appliquer: actions => grist.docApi.applyUserActions(actions), etape: majEtat },
        { Sources, Dossiers, Evenements },
        { ICAL, maintenant: maintenant(), manuel });
      if (r.statut === 'refuse') etat.lectureSeule = true;
    } catch (e) {
      etat.erreur = true;
      etat.message = 'Synchronisation interrompue : ' + (e && e.message ? e.message : e);
    } finally {
      etat.enCours = false;
      etat.etape = '';
      if (L.app && L.app.rafraichir) L.app.rafraichir(0, { tables: ['Sources', 'Dossiers', 'Evenements'] });
      majEtat();
      if (manuel && r && r.bilan) C.toast(r.bilan);
    }
  }

  // Ouverture de l'agenda : synchronisation si les flux sont anciens ; puis contrôle toutes les 5 minutes
  let auto = null;
  function demarrerAuto() {
    if (auto) return;
    const verifier = () => { if (!document.hidden && !etat.enCours && !etat.lectureSeule && perimee()) synchroniser(); };
    auto = setInterval(verifier, 5 * 60 * 1000);
    setTimeout(verifier, 1500);
  }

  // ------------------------------------------------------------------ import de fichiers .ics
  /** Lit un fichier .ics ; chaque élément est marqué « nouveau » ou « déjà présent » (même identifiant). */
  async function lireFichier(texte) {
    const ICAL = await chargerIcal();
    const r = S.lireIcs(ICAL, texte, { maintenant: maintenant() });
    const connus = new Set((C.etat.doc.Evenements || []).map(e => e.UID).filter(Boolean));
    r.items.forEach(x => { x.dejaPresent = connus.has(x.uid); });
    r.items.sort((a, b) => a.debut - b.debut);
    return r;
  }
  /** Importe les éléments choisis dans la source d'import ; un élément déjà présent est mis à jour. */
  async function importer(items, sourceId) {
    const evts = await C.lireTable('Evenements');
    const plan = S.planifier({ sourceId, items, existants: evts.filter(e => e.Source === sourceId), maintenant: maintenant(), mode: 'import' });
    const actions = S.actionsDuPlan('Evenements', plan);
    if (actions.length) await C.appliquer(actions, { tables: ['Evenements', 'Sources', 'Dossiers'] });
    return plan.stats;
  }

  L.synchro = { etat, htmlEtat, majEtat, synchroniser, demarrerAuto, perimee, lireFichier, importer, chargerIcal, depuis };
})(globalThis.Formulaire = globalThis.Formulaire || {});
