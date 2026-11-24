// Vue Dossiers suivis : on colle le lien d'un dossier législatif (Sénat ou Assemblée nationale) ; la
// synchronisation repère ses textes et rattache les réunions et séances de l'agenda du Sénat.
(function (L) {
  'use strict';
  const C = L.core, A = L.app, S = L.sync, Y = L.synchro, esc = C.esc, e = C.etat;
  const F_DATE = new Intl.DateTimeFormat('fr-FR', { timeZone: S.PARIS, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const date = sec => (sec ? F_DATE.format(new Date(sec * 1000)) : '');
  const ETATS = {
    'À analyser': ['En attente d’analyse', 'statut-en-cours'],
    'Suivi actif': ['Suivi actif', 'statut-valide'],
    'En attente du relais': ['Relais à installer', 'statut-non-commence'],
    Erreur: ['À vérifier', 'statut-erreur'],
  };
  const badge = s => `<span class="statut ${(ETATS[s] || [])[1] || ''}" data-etat="${esc(s)}">${esc((ETATS[s] || [])[0] || s || '—')}</span>`;
  const evenementsDe = d => (e.doc.Evenements || []).filter(ev => ev.Dossier === d.id).sort((x, y) => x.Debut - y.Debut);
  let saisie = '', erreurSaisie = '';

  A.vues.dossiers = {
    rendre() {
      const ds = (e.doc.Dossiers || []).slice().sort((x, y) => (x.Prochaine_date || Infinity) - (y.Prochaine_date || Infinity) || String(x.Titre || '').localeCompare(String(y.Titre || ''), 'fr'));
      const t = Math.floor(Date.now() / 1000);
      return `<div class="large"><h2 class="sr-only">Dossiers suivis</h2>
        <div class="ag-ajout-dossier">
          <label for="lien-dossier">Lien d’un dossier législatif (Sénat ou Assemblée nationale)</label>
          <div class="ag-ligne-saisie">
            <input id="lien-dossier" type="url" inputmode="url" placeholder="https://www.senat.fr/dossier-legislatif/…" value="${esc(saisie)}"${erreurSaisie ? ' aria-invalid="true" aria-describedby="lien-dossier-err"' : ''}>
            <button type="button" class="btn" data-action="suivre-dossier">Suivre ce dossier</button>
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
