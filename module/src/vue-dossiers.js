// Vue Dossiers suivis : on cherche un dossier en cours dans le répertoire (publié chaque jour par le relais), ou on
// colle son lien (Sénat ou Assemblée nationale) ; la synchronisation repère ses textes et rattache ses réunions et
// séances.
(function (L) {
  'use strict';
  const C = L.core, A = L.app, S = L.sync, Y = L.synchro, esc = C.esc, e = C.etat;
  const F_DATE = new Intl.DateTimeFormat('fr-FR', { timeZone: S.PARIS, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const date = sec => (sec ? F_DATE.format(new Date(sec * 1000)) : '');
  const ETATS = {
    'À analyser': ['En attente d’analyse', 'statut-en-cours'],
    'Suivi actif': ['Suivi actif', 'statut-valide'],
    'En attente du relais': ['Lecture au prochain passage du relais', 'statut-non-commence'],
    Erreur: ['À vérifier', 'statut-erreur'],
  };
  const badge = s => `<span class="statut ${(ETATS[s] || [])[1] || ''}" data-etat="${esc(s)}">${esc((ETATS[s] || [])[0] || s || '—')}</span>`;
  const evenementsDe = d => (e.doc.Evenements || []).filter(ev => ev.Dossier === d.id).sort((x, y) => x.Debut - y.Debut);
  let saisie = '', erreurSaisie = '';

  // ------------------------------------------------------------------ recherche dans le répertoire
  const R = L.repertoire;
  const F_JOUR = new Intl.DateTimeFormat('fr-FR', { timeZone: S.PARIS, day: 'numeric', month: 'long', year: 'numeric' });
  const jourIso = d => (/^\d{4}-\d\d-\d\d$/.test(d || '') ? F_JOUR.format(new Date(d + 'T12:00:00Z')).replace(/^1 /, '1er ') : '');
  // Chargé une fois par session, à la première recherche ; gardé dans la vue pour survivre aux redessins
  let rep = null, repEtat = 'vide', repErreur = '', recherche = '', assemblee = '', trouves = { total: 0, resultats: [] };
  async function chargerRepertoire() {
    if (rep || repEtat === 'chargement') return;
    const url = S.urlSure(C.param('repertoire_url'));
    if (!url) { repEtat = 'absent'; return majRecherche(); }
    repEtat = 'chargement'; majRecherche();
    try {
      const r = await fetch(url, { credentials: 'omit' });
      if (!r.ok) throw new Error(`erreur ${r.status}`);
      const j = await r.json();
      rep = { genere: j.genere, dossiers: R.preparer(j) };
      repEtat = 'pret';
      calculer();
    } catch (x) { repEtat = 'erreur'; repErreur = x.message; }
    majRecherche();
  }
  function calculer() { trouves = rep ? R.chercher(rep.dossiers, recherche, { assemblee, limite: 30 }) : { total: 0, resultats: [] }; }
  const dejaSuivis = () => new Set((e.doc.Dossiers || []).flatMap(d => [d.Lien, d.Lien_autre]).filter(Boolean)
    .map(l => (S.typeLienDossier(l) === 'senat' ? S.lienDossierCanonique(l) : l)));
  function texteEtat() {
    if (repEtat === 'absent') return 'Le répertoire des dossiers en cours n’est pas encore publié (le relais le publie chaque matin) : collez le lien du dossier ci-dessous.';
    if (repEtat === 'chargement') return 'Chargement du répertoire…';
    if (repEtat === 'erreur') return `Répertoire indisponible (${repErreur}) : collez le lien du dossier ci-dessous.`;
    if (repEtat !== 'pret') return 'Tapez quelques mots du titre, ou un numéro.';
    const base = `Répertoire du ${F_JOUR.format(new Date(rep.genere))} : ${rep.dossiers.length.toLocaleString('fr-FR')} dossiers en cours au Sénat et à l’Assemblée nationale.`;
    if (R.normaliser(recherche).length < 2) return base;
    if (!trouves.total) return 'Aucun dossier en cours ne correspond. Essayez d’autres mots, ou collez le lien ci-dessous.';
    return `${trouves.total} dossier${trouves.total > 1 ? 's' : ''} en cours trouvé${trouves.total > 1 ? 's' : ''}${trouves.total > trouves.resultats.length ? `, les ${trouves.resultats.length} plus pertinents affichés` : ''}.`;
  }
  function htmlResultats() {
    if (repEtat !== 'pret' || R.normaliser(recherche).length < 2) return '';
    const suivis = dejaSuivis();
    return trouves.resultats.map((x, i) => {
      const ls = R.lienSenat(x), la = R.lienAN(x), suivi = suivis.has(ls) || suivis.has(la);
      const meta = [x.ty, x.d ? `déposé le ${jourIso(x.d)}` : '', x.e || 'en cours', x.m && x.m !== x.d ? `dernière étape le ${jourIso(x.m)}` : ''].filter(Boolean).join(' · ');
      return `<li class="ag-resultat"><p class="ag-resultat-titre">${esc(x.t)}</p>
        ${x.t2 ? `<p class="petit discret">À l’Assemblée : ${esc(x.t2)}</p>` : ''}
        <p class="petit discret">${esc(meta)}</p>
        <p class="ag-actions-dossier">
          ${suivi ? '<span class="statut statut-valide" data-etat="suivi">Déjà suivi</span>'
            : `<button type="button" class="btn secondaire petit" data-action="suivre-repertoire" data-cle="${i}">Suivre<span class="sr-only"> : ${esc(x.t)}</span></button>`}
          ${ls ? `<a href="${esc(ls)}" target="_blank" rel="noopener noreferrer">Sénat<span class="sr-only"> : ${esc(x.t)}</span></a>` : ''}
          ${la ? `<a href="${esc(la)}" target="_blank" rel="noopener noreferrer">Assemblée nationale<span class="sr-only"> : ${esc(x.t)}</span></a>` : ''}
        </p></li>`;
    }).join('');
  }
  /** Mise à jour sur place (le focus reste dans le champ de recherche) */
  function majRecherche() {
    const st = document.getElementById('rech-etat'), z = document.getElementById('rech-resultats');
    if (st) st.textContent = texteEtat();
    if (z) { z.innerHTML = htmlResultats(); C.signalerNouvellesFenetres(z); }
  }
  let minuterie = null;
  document.addEventListener('input', ev => {
    if (!ev.target || ev.target.id !== 'rech-dossier') return;
    recherche = ev.target.value;
    clearTimeout(minuterie);
    minuterie = setTimeout(() => { calculer(); majRecherche(); }, 200);
  });
  document.addEventListener('focusin', ev => { if (ev.target && ev.target.id === 'rech-dossier') chargerRepertoire(); });
  A.actions['rech-assemblee'] = el => { assemblee = el.value; calculer(); majRecherche(); };
  A.actions['suivre-repertoire'] = async el => {
    const x = trouves.resultats[Number(el.dataset.cle)];
    if (!x) return;
    const ls = R.lienSenat(x), la = R.lienAN(x);
    el.focus();
    await C.appliquer([['AddRecord', 'Dossiers', null, { Lien: ls || la, Lien_autre: ls ? la : '', Titre: x.t, Etat: 'À analyser' }]]);
    C.toast(`Dossier suivi : ${x.t.length > 80 ? x.t.slice(0, 79) + '…' : x.t}. Recherche de ses dates en cours.`);
    Y.synchroniser({ manuel: false });
  };

  A.vues.dossiers = {
    rendre() {
      const ds = (e.doc.Dossiers || []).slice().sort((x, y) => (x.Prochaine_date || Infinity) - (y.Prochaine_date || Infinity) || String(x.Titre || '').localeCompare(String(y.Titre || ''), 'fr'));
      const t = Math.floor(Date.now() / 1000);
      return `<div class="large"><h2 class="sr-only">Dossiers suivis</h2>
        <section class="ag-recherche" aria-labelledby="rech-titre">
          <h3 id="rech-titre">Chercher un dossier en cours</h3>
          <div class="ag-ligne-saisie">
            <label for="rech-dossier" class="sr-only">Mots du titre, ou numéro du texte</label>
            <input id="rech-dossier" type="search" autocomplete="off" placeholder="Ex. : fin de vie, budget 2027, ppl25-123" value="${esc(recherche)}">
            <select data-change="rech-assemblee" aria-label="Assemblée"><option value=""${assemblee ? '' : ' selected'}>Sénat et Assemblée</option><option value="senat"${assemblee === 'senat' ? ' selected' : ''}>Sénat</option><option value="an"${assemblee === 'an' ? ' selected' : ''}>Assemblée nationale</option></select>
          </div>
          <p class="petit discret" id="rech-etat" role="status">${esc(texteEtat())}</p>
          <ul class="ag-resultats" id="rech-resultats">${htmlResultats()}</ul>
        </section>
        <div class="ag-ajout-dossier">
          <label for="lien-dossier">Ou collez le lien d’un dossier législatif (Sénat ou Assemblée nationale)</label>
          <div class="ag-ligne-saisie">
            <input id="lien-dossier" type="url" inputmode="url" placeholder="https://www.senat.fr/dossier-legislatif/…" value="${esc(saisie)}"${erreurSaisie ? ' aria-invalid="true" aria-describedby="lien-dossier-err"' : ''}>
            <button type="button" class="btn secondaire" data-action="suivre-dossier">Suivre ce dossier</button>
          </div>
          <p class="erreur-champ" id="lien-dossier-err"${erreurSaisie ? '' : ' hidden'}>${esc(erreurSaisie)}</p>
        </div>
        <p class="ag-synchro petit" data-etat-synchro>${Y.htmlEtat()}</p>
        ${ds.length ? `<p class="discret petit">${ds.length} dossier${ds.length > 1 ? 's' : ''} suivi${ds.length > 1 ? 's' : ''}.</p>` : '<p class="discret">Aucun dossier suivi pour l’instant.</p>'}
        ${ds.map(d => {
          const evs = evenementsDe(d), venir = evs.filter(ev => ev.Debut >= t - 3600 && !ev.Statut);
          return `<details class="accordeon" id="dossier-${d.id}"${ds.length <= 3 ? ' open' : ''}>
            <summary><span class="accordeon-titre">${esc(d.Titre || d.Lien)}</span> ${badge(d.Etat)}
              <span class="discret petit">${esc(d.Assemblee || '')}${d.Prochaine_date ? ` · prochaine date : ${esc(date(d.Prochaine_date))}` : ''}</span></summary>
            <div class="accordeon-corps">
              ${d.Resultat ? `<p class="petit">${esc(d.Resultat)}</p>` : ''}
              ${d.Calendrier_annonce ? `<p><span class="discret">Calendrier annoncé :</span> ${esc(d.Calendrier_annonce)}</p>` : ''}
              ${d.Numeros ? `<p class="petit"><span class="discret">Textes suivis :</span> ${esc(d.Numeros)}</p>` : ''}
              ${venir.length ? `<h3 class="petit-titre">À venir</h3><ul class="ag-liste-dossier">${venir.slice(0, 8).map(ev => `<li><button type="button" class="btn lien" data-action="ag-voir" data-id="${ev.id}">${esc(date(ev.Debut))} — ${esc(ev.Titre)}</button></li>`).join('')}</ul>${venir.length > 8 ? `<p class="discret petit">et ${venir.length - 8} autre${venir.length > 9 ? 's' : ''}.</p>` : ''}`
                : `<p class="discret petit">Aucune date à venir trouvée dans l’agenda${d.Assemblee === 'Sénat' ? ' du Sénat' : ''} pour l’instant.</p>`}
              <p class="ag-actions-dossier">
                ${evs.length ? `<button type="button" class="btn secondaire petit" data-action="dossier-agenda" data-id="${d.id}">Voir dans l’agenda<span class="sr-only"> : ${esc(d.Titre || '')}</span></button>` : ''}
                <a class="btn secondaire petit" href="${esc(S.urlSure(d.Lien))}" target="_blank" rel="noopener noreferrer">Ouvrir le dossier<span class="sr-only"> ${esc(d.Titre || '')}</span></a>
                ${S.urlSure(d.Lien_autre) ? `<a class="btn secondaire petit" href="${esc(S.urlSure(d.Lien_autre))}" target="_blank" rel="noopener noreferrer">Dossier à l’Assemblée nationale</a>` : ''}
                <button type="button" class="btn lien danger" data-action="oublier-dossier" data-id="${d.id}">Ne plus suivre<span class="sr-only"> : ${esc(d.Titre || '')}</span></button>
              </p>
              <p class="discret petit">Ajouté par ${esc(d.Ajoute_par || '—')}${d.Derniere_verif ? ` · vérifié ${esc(Y.depuis(d.Derniere_verif))}` : ''}.</p>
            </div></details>`;
        }).join('')}
      </div>`;
    },
  };

  A.actions['suivre-dossier'] = async () => {
    const el = document.getElementById('lien-dossier');
    saisie = el ? el.value.trim() : '';
    const type = S.typeLienDossier(saisie);
    erreurSaisie = !saisie ? 'Collez le lien du dossier.'
      : !type ? 'Ce lien n’est pas celui d’un dossier législatif. Exemples : https://www.senat.fr/dossier-legislatif/pjlf2027.html, https://www.assemblee-nationale.fr/dyn/17/dossiers/PLF_2027'
        : '';
    const lien = type === 'senat' ? S.lienDossierCanonique(saisie) : saisie;
    if (!erreurSaisie && (e.doc.Dossiers || []).some(d => d.Lien === lien)) erreurSaisie = 'Ce dossier est déjà suivi.';
    if (erreurSaisie) {
      A.rendre();
      const x = document.getElementById('lien-dossier'); if (x) x.focus();
      return;
    }
    // Le focus quitte le champ : sans cela, le module ne redessine pas l'écran (saisie supposée en cours) et le
    // résultat de l'analyse n'apparaîtrait pas
    const b = C.racine().querySelector('[data-action="suivre-dossier"]');
    if (b) b.focus();
    saisie = ''; erreurSaisie = '';
    await C.appliquer([['AddRecord', 'Dossiers', null, { Lien: lien, Etat: 'À analyser' }]]);
    C.toast('Dossier ajouté : analyse en cours.');
    Y.synchroniser({ manuel: false });
  };
  A.actions['oublier-dossier'] = async el => {
    const d = (e.doc.Dossiers || []).find(x => x.id === Number(el.dataset.id));
    if (!d || !(await C.confirmer('Ne plus suivre ce dossier ?', `« ${esc(d.Titre || d.Lien)} » : ses événements restent dans l’agenda s’ils viennent d’un agenda suivi ; les autres disparaîtront à la prochaine synchronisation.`, 'Ne plus suivre'))) return;
    const lies = evenementsDeId(d.id);
    await C.appliquer([
      ...(lies.length ? [['BulkUpdateRecord', 'Evenements', lies, { Dossier: lies.map(() => null) }]] : []),
      ['RemoveRecord', 'Dossiers', d.id],
    ]);
    C.toast('Dossier retiré du suivi.');
  };
  const evenementsDeId = id => (e.doc.Evenements || []).filter(ev => ev.Dossier === id).map(ev => ev.id);
  A.actions['dossier-agenda'] = el => {
    const d = (e.doc.Dossiers || []).find(x => x.id === Number(el.dataset.id));
    const t = Math.floor(Date.now() / 1000);
    const evs = evenementsDe(d), cible = evs.find(ev => ev.Debut >= t - 3600) || evs[evs.length - 1];
    const p = S.partiesParis(cible.Debut);
    A.aller('agenda', { mode: 'semaine', date: `${p.annee}-${String(p.mois).padStart(2, '0')}-${String(p.jour).padStart(2, '0')}`, dossier: d.id });
  };
  // Saisie : Entrée dans le champ vaut « Suivre ce dossier »
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && ev.target && ev.target.id === 'lien-dossier') { ev.preventDefault(); A.actions['suivre-dossier'](); }
  });

  A.pastilles.dossiers = {
    compter: () => (e.doc.Dossiers || []).filter(d => d.Etat === 'Erreur').length,
    annonce: k => (k > 1 ? `${k} dossiers à vérifier.` : 'Un dossier à vérifier.'),
  };
})(globalThis.Formulaire = globalThis.Formulaire || {});
