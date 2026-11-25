// Formulaire.moteur — le déroulé d'une synchronisation, commun au navigateur (synchro.js) et au relais (relais.mjs) :
// une seule logique, quel que soit l'endroit d'où elle part. Les accès au réseau et à Grist sont fournis par
// l'appelant (io) ; les écritures partent en deux lots seulement (le verrou, puis tout le reste), pour ménager le
// quota d'appels de l'API Grist et pour que la synchronisation s'applique d'un bloc.
(function (L) {
  'use strict';
  const S = L.sync;
  const VERROU_S = 180;                 // une synchronisation bloque les autres 3 minutes au plus
  const REVERIF_DOSSIER_S = 6 * 3600;   // une page de dossier est relue toutes les 6 heures

  const dossiersSenat = dossiers => dossiers.filter(d => d.Assemblee === 'Sénat' && d.Etat !== 'Erreur');

  /**
   * Flux à lire : suivis ; ceux du Sénat quand un dossier du Sénat est suivi (ses réunions peuvent être dans n'importe
   * quelle instance) ; ceux qui ont encore des événements à venir (nettoyage après un arrêt de suivi) ; les flux
   * relayés qui ont un contenu, suivis ou dès qu'un dossier est suivi (seuls ses événements sont alors gardés).
   */
  function cibles(sources, dossiers, evts, t, contenus) {
    const toutSenat = dossiersSenat(dossiers).length > 0;
    const suivis = dossiers.some(d => d.Etat !== 'Erreur');
    const aVenir = new Set(evts.filter(e => e.Debut >= S.debutJourParis(t) && e.UID).map(e => e.Source));
    return sources.filter(s => {
      // Flux relayé non suivi : lu quand même s'il y a des dossiers suivis (il n'en garde que leurs événements :
      // délais limites des dossiers suivis), ou pour retirer ses événements à venir
      if (s.Type === 'Flux via relais') return !!((contenus && contenus.get(s.id)) || s.Contenu_relaye) && (s.Active || suivis || aVenir.has(s.id));
      if (s.Type !== 'Flux iCal' || !s.URL) return false;
      return s.Active || (toutSenat && S.estFluxSenat(s.URL)) || aVenir.has(s.id);
    });
  }
  /** Une synchronisation est-elle due ? (délai en secondes depuis la dernière lecture) */
  function perimee(donnees, t, delai) {
    const cs = cibles(donnees.Sources || [], donnees.Dossiers || [], donnees.Evenements || [], t);
    return cs.some(s => !s.Derniere_synchro || t - s.Derniere_synchro > delai)
      || (donnees.Dossiers || []).some(d => d.Etat === 'À analyser');
  }

  /** Analyse des dossiers suivis du Sénat (page du dossier) ; renvoie les champs à écrire, par dossier. */
  async function analyserDossiers(io, dossiers, t, forcer) {
    const maj = new Map();
    for (const d of dossiers) {
      if (!forcer && d.Etat !== 'À analyser' && d.Derniere_verif && t - d.Derniere_verif < REVERIF_DOSSIER_S) continue;
      const type = S.typeLienDossier(d.Lien);
      if (type === 'an') {
        // Lu par le relais (l'Assemblée nationale ne se lit pas depuis un navigateur), qui note lui-même l'état
        if (d.Etat === 'À analyser') maj.set(d.id, { Etat: 'En attente du relais', Derniere_verif: t, Resultat: 'Lu par le relais à son prochain passage (toutes les deux heures, de 6 h à 22 h).' });
        continue;
      }
      if (type !== 'senat') {
        maj.set(d.id, { Etat: 'Erreur', Derniere_verif: t, Resultat: 'Lien non reconnu : coller l’adresse d’un dossier législatif du Sénat ou de l’Assemblée nationale.' });
        continue;
      }
      if (io.etape) io.etape(`Analyse du dossier « ${d.Titre || d.Lien} »…`);
      try {
        const a = S.analyserDossierSenat(await io.lireTexte(S.lienDossierCanonique(d.Lien)));
        const ch = {
          Etat: 'Suivi actif', Derniere_verif: t,
          Numeros: a.numeros.map(S.libelleNumero).join(' · '),
          Calendrier_annonce: a.calendrier.join('\n'),
          Resultat: a.numeros.length ? `${a.numeros.length} texte${a.numeros.length > 1 ? 's' : ''} repéré${a.numeros.length > 1 ? 's' : ''} : leurs réunions et séances sont cherchées dans l’agenda du Sénat.`
            : 'Aucun numéro de texte repéré sur la page : rattachez les événements à la main.',
        };
        if (!d.Titre && a.titre) ch.Titre = a.titre;
        if (a.lienAN && !d.Lien_autre) ch.Lien_autre = a.lienAN;
        maj.set(d.id, ch);
      } catch (e) {
        maj.set(d.id, { Etat: 'Erreur', Derniere_verif: t, Resultat: 'Page du dossier illisible : ' + e.message });
      }
    }
    return maj;
  }

  /**
   * Une synchronisation complète.
   *  io       { lireTexte(url) -> texte, appliquer(actions) -> promesse, etape?(texte) }
   *  donnees  { Sources, Dossiers, Evenements } déjà lues (listes décodées)
   *  o        { ICAL, maintenant, manuel, contenus: Map(id de source -> contenu relayé tout frais),
   *             echecs: Map(id de source -> raison) (relais qui n'a pas pu lire l'agenda : ses événements sont gardés),
   *             actionsAvant: [] (écritures de l'appelant, envoyées dans le même lot) }
   * Renvoie { statut: 'fait' | 'rien' | 'occupe' | 'refuse', bilan, changements, erreurs, flux }.
   */
  async function synchroniser(io, donnees, o) {
    const t = o.maintenant;
    const sources = donnees.Sources || [], evts = donnees.Evenements || [];
    const actions = [...(o.actionsAvant || [])];
    // 1. Dossiers : analysés d'abord (leurs numéros servent au rapprochement), écrits avec le reste
    const majDossiers = await analyserDossiers(io, donnees.Dossiers || [], t, o.manuel);
    const dossiers = (donnees.Dossiers || []).map(d => (majDossiers.has(d.id) ? { ...d, ...majDossiers.get(d.id) } : d));
    for (const [id, ch] of majDossiers) actions.push(['UpdateRecord', 'Dossiers', id, ch]);
    // 2. Flux à lire, verrou
    const cs = cibles(sources, dossiers, evts, t, o.contenus);
    if (!cs.length) {
      if (actions.length) await io.appliquer(actions);
      return { statut: 'rien', bilan: 'Aucun flux à synchroniser.', changements: 0, erreurs: 0, flux: 0 };
    }
    if (!o.manuel && cs.some(s => s.Synchro_en_cours && t - s.Synchro_en_cours < VERROU_S)) {
      if (actions.length) await io.appliquer(actions);
      return { statut: 'occupe', bilan: 'Synchronisation déjà en cours ailleurs.', changements: 0, erreurs: 0, flux: cs.length };
    }
    try { await io.appliquer([['BulkUpdateRecord', 'Sources', cs.map(s => s.id), { Synchro_en_cours: cs.map(() => t) }]]); }
    catch (e) { return { statut: 'refuse', bilan: 'Ce compte ne peut pas écrire dans l’agenda.', changements: 0, erreurs: 0, flux: cs.length }; }
    // 3. Lecture et plan de chaque flux
    const numeros = new Map();
    for (const d of dossiersSenat(dossiers)) for (const k of S.numerosSenat(d.Numeros)) if (!numeros.has(k)) numeros.set(k, d.id);
    const ids = new Set(dossiers.map(d => d.id));
    const dossierDe = it => {
      if (it.dossierRelais && ids.has(it.dossierRelais)) return it.dossierRelais;
      for (const k of S.numerosSenat(it.titre + ' ' + it.description)) if (numeros.has(k)) return numeros.get(k);
      return null;
    };
    let changements = 0, erreurs = 0;
    for (const [i, s] of cs.entries()) {
      if (io.etape) io.etape(`Synchronisation : ${s.Nom} (${i + 1} sur ${cs.length})…`);
      let resultat;
      if (o.echecs && o.echecs.has(s.id)) {
        erreurs++;
        actions.push(['UpdateRecord', 'Sources', s.id, { Derniere_synchro: t, Resultat_synchro: '⚠ Relais : ' + o.echecs.get(s.id), Synchro_en_cours: null }]);
        continue;
      }
      try {
        const texte = s.Type === 'Flux via relais' ? ((o.contenus && o.contenus.get(s.id)) || s.Contenu_relaye) : await io.lireTexte(s.URL);
        const { items } = S.lireIcs(o.ICAL, texte, { maintenant: t });
        const its = (S.estFluxSenat(s.URL) ? items.map(S.adapterSenat) : items).map(x => Object.assign(x, { dossier: dossierDe(x) }));
        const retenus = s.Active ? its : its.filter(x => x.dossier);
        const plan = S.planifier({ sourceId: s.id, items: retenus, existants: evts.filter(e => e.Source === s.id), maintenant: t, mode: 'flux',
          flux: { nombre: its.length, horizon: its.length ? Math.max(...its.map(x => x.debut)) : 0 } });
        actions.push(...S.actionsDuPlan('Evenements', plan));
        changements += plan.stats.ajoutes + plan.stats.modifies + plan.stats.supprimes + plan.stats.marques;
        resultat = S.resumer(plan.stats) + (s.Active ? '' : ' (seulement les dossiers suivis)');
      } catch (e) {
        erreurs++;
        resultat = '⚠ ' + (e && e.message ? e.message : String(e));
      }
      actions.push(['UpdateRecord', 'Sources', s.id, { Derniere_synchro: t, Resultat_synchro: resultat, Synchro_en_cours: null }]);
    }
    // 4. Un seul lot : événements, résultats, dossiers, verrous levés. En cas d'échec, les verrous sont levés à part.
    try { await io.appliquer(actions); }
    catch (e) {
      try { await io.appliquer([['BulkUpdateRecord', 'Sources', cs.map(s => s.id), { Synchro_en_cours: cs.map(() => null) }]]); } catch (x) { /* verrou libéré seul après 3 minutes */ }
      throw e;
    }
    return { statut: 'fait', bilan: `${cs.length} flux lus, ${changements} changement${changements > 1 ? 's' : ''}${erreurs ? `, ${erreurs} en erreur` : ''}.`, changements, erreurs, flux: cs.length };
  }

  L.moteur = { VERROU_S, REVERIF_DOSSIER_S, cibles, perimee, analyserDossiers, synchroniser };
})(globalThis.Formulaire = globalThis.Formulaire || {});
