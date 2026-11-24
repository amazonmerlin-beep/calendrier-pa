// Vue Sources et imports : état de la synchronisation, import d'un fichier .ics (invitation Outlook ou Google,
// bouton « Ajouter à mon agenda » d'un site), choix des agendas du Sénat suivis (administration).
(function (L) {
  'use strict';
  const C = L.core, A = L.app, S = L.sync, Y = L.synchro, esc = C.esc, e = C.etat;
  const F_DATE = new Intl.DateTimeFormat('fr-FR', { timeZone: S.PARIS, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const F_HEURE = new Intl.DateTimeFormat('fr-FR', { timeZone: S.PARIS, hour: '2-digit', minute: '2-digit' });
  const quand = it => `${F_DATE.format(new Date(it.debut * 1000))}${it.journee ? '' : ', ' + F_HEURE.format(new Date(it.debut * 1000))}`;
  const couleur = s => (/^#[0-9a-f]{6}$/i.test(s.Couleur || '') ? s.Couleur : '#15803D');
  // Fichier lu, en attente d'import : gardé dans la vue pour survivre aux redessins
  let lu = null;   // { nom, items, alertes, coches: Set(uid), erreur }

  function blocImport() {
    const cibles = (e.doc.Sources || []).filter(s => s.Type === 'Import de fichier');
    if (!lu) {
      return `<p class="petit">Invitation reçue par courriel (pièce jointe <b>invite.ics</b>), événement enregistré depuis Outlook, bouton « Ajouter à mon agenda » d’un site : importez le fichier .ics.</p>
        <label class="btn secondaire">Choisir un fichier .ics<input type="file" accept=".ics,text/calendar" class="sr-only" data-action-fichier="lire-ics"></label>`;
    }
    if (lu.erreur) {
      return `<div class="note erreur">« ${esc(lu.nom)} » : ${esc(lu.erreur)}</div>
        <button type="button" class="btn secondaire" data-action="ics-annuler">Choisir un autre fichier</button>`;
    }
    const n = lu.coches.size;
    return `<p><b>${esc(lu.nom)}</b> : ${lu.items.length} événement${lu.items.length > 1 ? 's' : ''} trouvé${lu.items.length > 1 ? 's' : ''}.</p>
      ${lu.alertes.length ? `<div class="note alerte">${lu.alertes.map(esc).join('<br>')}</div>` : ''}
      ${lu.items.length ? `<div class="defil"><table class="tableau"><caption class="sr-only">Événements du fichier</caption>
        <thead><tr><th scope="col"><span class="sr-only">Importer</span></th><th scope="col">Date</th><th scope="col">Titre</th><th scope="col">Lieu</th><th scope="col">État</th></tr></thead>
        <tbody>${lu.items.map((it, i) => `<tr>
          <td><input type="checkbox" id="ics-${i}" data-change="ics-coche" data-cle="${i}"${lu.coches.has(it.uid) ? ' checked' : ''}><label for="ics-${i}" class="sr-only">Importer : ${esc(it.titre)}</label></td>
          <td>${esc(quand(it))}</td><td>${esc(it.titre)}${it.recurrent ? ' <span class="discret petit">(série)</span>' : ''}</td><td>${esc(it.lieu)}</td>
          <td>${it.annule ? 'Annulé' : it.dejaPresent ? 'Déjà dans l’agenda : sera mis à jour' : 'Nouveau'}</td></tr>`).join('')}</tbody></table></div>` : ''}
      <div class="ag-ligne-saisie">
        <label for="ics-cible">Agenda</label>
        <select id="ics-cible">${cibles.map(s => `<option value="${s.id}">${esc(s.Nom)}</option>`).join('')}</select>
        <button type="button" class="btn" data-action="ics-importer"${n ? '' : ' disabled'}>Importer ${n} événement${n > 1 ? 's' : ''}</button>
        <button type="button" class="btn lien" data-action="ics-annuler">Annuler</button>
      </div>`;
  }

  A.vues.sources = {
    rendre() {
      const admin = C.estAdmin();
      const toutes = e.doc.Sources || [];
      const flux = toutes.filter(s => s.Type === 'Flux iCal' || s.Type === 'Flux via relais');
      const suivies = flux.filter(s => s.Active || s.Derniere_synchro);
      const groupes = [...new Set(flux.map(s => s.Groupe))];
      return `<div class="large"><h2 class="sr-only">Sources et imports</h2>
        <section class="bloc"><h3>Synchronisation</h3>
          <p class="ag-synchro" data-etat-synchro>${Y.htmlEtat()}</p>
          ${suivies.length ? `<div class="defil"><table class="tableau"><caption class="sr-only">Agendas synchronisés</caption>
            <thead><tr><th scope="col">Agenda</th><th scope="col">Dernière lecture</th><th scope="col">Résultat</th><th scope="col">Événements</th></tr></thead>
            <tbody>${suivies.map(s => `<tr><td><span class="ag-pastille" style="--c:${couleur(s)}" aria-hidden="true"></span> ${esc(s.Nom)}${s.Active ? '' : ' <span class="discret petit">(dossiers suivis seulement)</span>'}</td>
              <td>${s.Derniere_synchro ? esc(Y.depuis(s.Derniere_synchro)) : '—'}</td>
              <td class="${/^⚠/.test(s.Resultat_synchro || '') ? 'texte-erreur' : ''}">${esc(s.Resultat_synchro || '')}</td><td class="num">${esc(s.Nb_evenements ?? '')}</td></tr>`).join('')}</tbody></table></div>` : ''}
        </section>
        <section class="bloc"><h3>Importer un fichier .ics</h3>${blocImport()}</section>
        <section class="bloc"><h3>Agendas du Sénat</h3>
          ${admin ? '' : '<p class="discret petit">Le choix des agendas suivis revient à l’administration.</p>'}
          ${groupes.map(g => `<h4>${esc(g)}</h4><ul class="ag-sources">${flux.filter(s => s.Groupe === g).map(s => `<li>
            ${admin ? `<label class="interrupteur"><input type="checkbox" role="switch" data-change="source-suivie" data-id="${s.id}"${s.Active ? ' checked' : ''}> <span class="ag-pastille" style="--c:${couleur(s)}" aria-hidden="true"></span> ${esc(s.Nom)}</label>`
              : `<span class="ag-pastille" style="--c:${couleur(s)}" aria-hidden="true"></span> ${esc(s.Nom)} : <span data-etat="${s.Active ? 'suivi' : 'non'}">${s.Active ? 'suivi' : 'non suivi'}</span>`}
          </li>`).join('')}</ul>`).join('')}
        </section>
        <section class="bloc"><h3>Agendas Google ou Outlook, Assemblée nationale</h3>
          <p class="petit">Google, Microsoft et l’Assemblée nationale ne laissent pas un navigateur lire leurs agendas. L’abonnement automatique passera par un relais (GitHub), à installer : voir l’onglet Aide. En attendant, importez les fichiers .ics ci-dessus.</p>
        </section>
      </div>`;
    },
  };

  A.actions['lire-ics'] = async el => {
    const f = el.files && el.files[0];
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) { lu = { nom: f.name, erreur: 'fichier trop gros (5 Mo au plus).' }; return A.rendre(); }
    try {
      const r = await Y.lireFichier(await f.text());
      lu = { nom: f.name, items: r.items, alertes: r.alertes, coches: new Set(r.items.map(x => x.uid)) };
      if (!r.items.length) lu.erreur = 'aucun événement à importer (les événements de plus d’un mois sont ignorés).';
    } catch (x) { lu = { nom: f.name, erreur: x.message }; }
    A.rendre();
    const h = C.racine().querySelector('#ics-cible, [data-action="ics-annuler"]');
    if (h) h.focus();
  };
  A.actions['ics-coche'] = el => {
    const it = lu && lu.items[Number(el.dataset.cle)];
    if (!it) return;
    if (el.checked) lu.coches.add(it.uid); else lu.coches.delete(it.uid);
    const b = C.racine().querySelector('[data-action="ics-importer"]');
    const n = lu.coches.size;
    if (b) { b.textContent = `Importer ${n} événement${n > 1 ? 's' : ''}`; b.disabled = !n; }
  };
  A.actions['ics-annuler'] = () => { lu = null; A.rendre(); const x = C.racine().querySelector('[data-action-fichier="lire-ics"]'); if (x) x.focus(); };
  A.actions['ics-importer'] = async () => {
    const cible = Number((document.getElementById('ics-cible') || {}).value);
    const choisis = lu.items.filter(it => lu.coches.has(it.uid));
    if (!cible || !choisis.length) return;
    const st = await Y.importer(choisis, cible);
    lu = null;
    C.toast(`Import terminé : ${S.resumer(st)}.`);
  };
  A.actions['source-suivie'] = async el => {
    await C.maj('Sources', Number(el.dataset.id), { Active: el.checked }, { rendre: false });
    C.signalerEnregistre(el);
    if (el.checked) Y.synchroniser({ manuel: false });
  };
})(globalThis.Formulaire = globalThis.Formulaire || {});
