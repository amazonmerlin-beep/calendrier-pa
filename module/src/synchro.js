// Formulaire.synchro — la synchronisation, lancée depuis le navigateur des membres : flux iCal du Sénat
// (lisibles par tout navigateur), contenus déposés par le relais GitHub, dossiers législatifs suivis ; import de
// fichiers .ics. Écrit avec les droits de la personne connectée (règles d'accès).
(function (L) {
  'use strict';
  const C = L.core, S = L.sync;

  // ical.js : version figée, empreinte vérifiée avant exécution (équivalent d'un attribut integrity)
  const ICAL_URL = 'https://cdn.jsdelivr.net/npm/ical.js@2.1.0/dist/ical.min.js';
  const ICAL_SHA256 = 'SoyhZHtbk+X89f7lnErRxZcTjRCMwsfoiFT2iPcRQ20=';
  const VERROU_S = 180;            // un poste qui synchronise bloque les autres 3 minutes au plus
  const REVERIF_DOSSIER_S = 6 * 3600;
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

  // ------------------------------------------------------------------ choix des sources
  const dossiersSenat = dossiers => dossiers.filter(d => d.Assemblee === 'Sénat' && d.Etat !== 'Erreur');
  /** Flux à lire : suivis, ou du Sénat quand un dossier est suivi, ou ayant encore des événements à venir (nettoyage). */
  function cibles(sources, dossiers, evts, t) {
    const toutSenat = dossiersSenat(dossiers).length > 0;
    const aVenir = new Set(evts.filter(e => e.Debut >= S.debutJourParis(t) && e.UID).map(e => e.Source));
    return sources.filter(s => {
      if (s.Type === 'Flux via relais') return s.Active && !!s.Contenu_relaye;
      if (s.Type !== 'Flux iCal' || !s.URL) return false;
      return s.Active || (toutSenat && S.estFluxSenat(s.URL)) || aVenir.has(s.id);
    });
  }
  function perimee(t = maintenant()) {
    const doc = C.etat.doc, min = (Number(C.param('synchro_minutes', '30')) || 30) * 60;
    const cs = cibles(doc.Sources || [], doc.Dossiers || [], doc.Evenements || [], t);
    return cs.some(s => !s.Derniere_synchro || t - s.Derniere_synchro > min)
      || (doc.Dossiers || []).some(d => d.Etat === 'À analyser');
  }

  // ------------------------------------------------------------------ dossiers législatifs
  async function analyserDossiers(dossiers, t, forcer) {
    const actions = [];
    for (const d of dossiers) {
      if (!forcer && d.Etat !== 'À analyser' && d.Derniere_verif && t - d.Derniere_verif < REVERIF_DOSSIER_S) continue;
      const type = S.typeLienDossier(d.Lien);
      if (type === 'an') {
        // Lu par le relais GitHub (l'Assemblée nationale ne se lit pas depuis un navigateur), qui note lui-même l'état
        if (d.Etat === 'À analyser') actions.push(['UpdateRecord', 'Dossiers', d.id, { Etat: 'En attente du relais', Derniere_verif: t,
          Resultat: 'Lecture par le relais GitHub, à son prochain passage (s’il est installé).' }]);
        continue;
      }
      if (type !== 'senat') {
        actions.push(['UpdateRecord', 'Dossiers', d.id, { Etat: 'Erreur', Derniere_verif: t, Resultat: 'Lien non reconnu : coller l’adresse d’un dossier législatif du Sénat ou de l’Assemblée nationale.' }]);
        continue;
      }
      majEtat(`Analyse du dossier « ${d.Titre || d.Lien} »…`);
      try {
        const a = S.analyserDossierSenat(await lireTexte(S.lienDossierCanonique(d.Lien)));
        const ch = {
          Etat: 'Suivi actif', Derniere_verif: t,
          Numeros: a.numeros.map(S.libelleNumero).join(' · '),
          Calendrier_annonce: a.calendrier.join('\n'),
          Resultat: a.numeros.length ? `${a.numeros.length} texte${a.numeros.length > 1 ? 's' : ''} repéré${a.numeros.length > 1 ? 's' : ''} : leurs réunions et séances sont cherchées dans l’agenda du Sénat.`
            : 'Aucun numéro de texte repéré sur la page : rattachez les événements à la main.',
        };
        if (!d.Titre && a.titre) ch.Titre = a.titre;
        if (a.lienAN && !d.Lien_autre) ch.Lien_autre = a.lienAN;
        actions.push(['UpdateRecord', 'Dossiers', d.id, ch]);
      } catch (e) {
        actions.push(['UpdateRecord', 'Dossiers', d.id, { Etat: 'Erreur', Derniere_verif: t, Resultat: 'Page du dossier illisible : ' + e.message }]);
      }
    }
    if (actions.length) await grist.docApi.applyUserActions(actions);
    return actions.length;
  }
  /** numéro de texte ('155/2026-2027') -> id du dossier suivi */
  function indexNumeros(dossiers) {
    const m = new Map();
    for (const d of dossiersSenat(dossiers)) for (const k of S.numerosSenat(d.Numeros)) if (!m.has(k)) m.set(k, d.id);
    return m;
  }

  // ------------------------------------------------------------------ synchronisation
  async function synchroniser({ manuel = false } = {}) {
    if (etat.enCours || !C.etat.moi || !C.etat.moi.connu) return;
    etat.enCours = true; etat.erreur = false; etat.message = '';
    majEtat('Synchronisation en cours…');
    let bilan = null;
    try {
      const t = maintenant();
      let [sources, dossiers, evts] = await Promise.all(['Sources', 'Dossiers', 'Evenements'].map(C.lireTable));
      if (await analyserDossiers(dossiers, t, manuel)) dossiers = await C.lireTable('Dossiers');
      const cs = cibles(sources, dossiers, evts, t);
      if (!cs.length) { bilan = 'Aucun flux à synchroniser.'; return; }
      const occupees = cs.filter(s => s.Synchro_en_cours && t - s.Synchro_en_cours < VERROU_S);
      if (occupees.length && !manuel) { bilan = 'Synchronisation déjà en cours sur un autre poste.'; return; }
      try {
        await grist.docApi.applyUserActions([['BulkUpdateRecord', 'Sources', cs.map(s => s.id), { Synchro_en_cours: cs.map(() => t) }]]);
      } catch (e) { etat.lectureSeule = true; return; }
      const ICAL = await chargerIcal();
      const numeros = indexNumeros(dossiers);
      const ids = new Set(dossiers.map(d => d.id));
      const dossierDe = it => {
        if (it.dossierRelais && ids.has(it.dossierRelais)) return it.dossierRelais;
        for (const k of S.numerosSenat(it.titre + ' ' + it.description)) if (numeros.has(k)) return numeros.get(k);
        return null;
      };
      let total = 0, erreurs = 0;
      for (const [i, s] of cs.entries()) {
        majEtat(`Synchronisation : ${s.Nom} (${i + 1} sur ${cs.length})…`);
        let resultat;
        try {
          const texte = s.Type === 'Flux via relais' ? s.Contenu_relaye : await lireTexte(s.URL);
          const { items } = S.lireIcs(ICAL, texte, { maintenant: t });
          const its = (S.estFluxSenat(s.URL) ? items.map(S.adapterSenat) : items).map(x => Object.assign(x, { dossier: dossierDe(x) }));
          const retenus = s.Active ? its : its.filter(x => x.dossier);
          const plan = S.planifier({ sourceId: s.id, items: retenus, existants: evts.filter(e => e.Source === s.id), maintenant: t, mode: 'flux',
            flux: { nombre: its.length, horizon: its.length ? Math.max(...its.map(x => x.debut)) : 0 } });
          const actions = S.actionsDuPlan('Evenements', plan);
          if (actions.length) await grist.docApi.applyUserActions(actions);
          total += plan.stats.ajoutes + plan.stats.modifies + plan.stats.supprimes + plan.stats.marques;
          resultat = S.resumer(plan.stats) + (s.Active ? '' : ' (seulement les dossiers suivis)');
        } catch (e) {
          erreurs++;
          resultat = '⚠ ' + (e && e.message ? e.message : String(e));
        }
        await grist.docApi.applyUserActions([['UpdateRecord', 'Sources', s.id, { Derniere_synchro: t, Resultat_synchro: resultat, Synchro_en_cours: null }]]);
      }
      bilan = `${cs.length} flux lus, ${total} changement${total > 1 ? 's' : ''}${erreurs ? `, ${erreurs} en erreur` : ''}.`;
    } catch (e) {
      etat.erreur = true;
      etat.message = 'Synchronisation interrompue : ' + (e && e.message ? e.message : e);
    } finally {
      etat.enCours = false;
      etat.etape = '';
      if (L.app && L.app.rafraichir) L.app.rafraichir(0, { tables: ['Sources', 'Dossiers', 'Evenements'] });
      majEtat();
      if (manuel && bilan) C.toast(bilan);
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
