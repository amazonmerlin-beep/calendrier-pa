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

  // Le relais (GitHub Actions) passe toutes les deux heures, de 6 h à 22 h : au-delà de 10 h sans passage, il est
  // sans doute arrêté (nuit comprise)
  const RELAIS_ALERTE_S = 10 * 3600;
  function etatRelais(toutes) {
    const relais = toutes.filter(s => s.Type === 'Flux via relais');
    const dernier = Math.max(0, ...relais.map(s => s.Relaye_le || 0));
    const quoi = 'Le relais synchronise tout l’agenda toutes les deux heures, de 6 h à 22 h, même si personne ne l’ouvre : Sénat, dossiers suivis, Assemblée nationale, agendas Google ou Outlook abonnés, puis agendas diffusés.';
    if (!dernier) return `${quoi} <b>Il n’est pas encore passé.</b>`;
    const age = Date.now() / 1000 - dernier;
    if (age > RELAIS_ALERTE_S) return `${quoi} <span class="texte-erreur"><b>Dernier passage ${esc(Y.depuis(dernier))}</b> : il semble arrêté.</span>`;
    return `${quoi} Dernier passage ${esc(Y.depuis(dernier))}.`;
  }

  const COULEURS = [['#C2410C', 'Orange'], ['#0E7490', 'Bleu canard'], ['#4D7C0F', 'Vert olive'], ['#9D174D', 'Framboise'], ['#5B21B6', 'Violet']];
  let agenda = { nom: '', url: '', couleur: COULEURS[0][0] }, erreursAgenda = {};
  const champAgenda = (id, lib, html) => `<div class="ag-champ"><label for="${id}">${esc(lib)} <span class="repere">obligatoire</span></label>${html}
    <p class="erreur-champ" id="${id}-err"${erreursAgenda[id] ? '' : ' hidden'}>${esc(erreursAgenda[id] || '')}</p></div>`;
  const invalide = id => (erreursAgenda[id] ? ` aria-invalid="true" aria-describedby="${id}-err"` : '');
  function formulaireAgenda() {
    return `<h4>S’abonner à un agenda Google ou Outlook</h4>
      <p class="petit">Google Agenda : paramètres de l’agenda, « Intégrer l’agenda », <b>adresse secrète au format iCal</b>. Outlook : paramètres du calendrier, « Calendriers partagés », <b>publier un calendrier</b>, lien ICS. De préférence un agenda dédié à l’équipe : tout son contenu entre dans le Calendrier PA. L’adresse n’est lisible que par l’administration.</p>
      <div class="ag-form ag-form-agenda">
        <div class="ag-ligne">
          ${champAgenda('ag-nom', 'Nom affiché', `<input id="ag-nom" type="text" maxlength="80" value="${esc(agenda.nom)}"${invalide('ag-nom')}>`)}
          <div class="ag-champ"><label for="ag-couleur">Couleur</label><select id="ag-couleur">${COULEURS.map(([c, l]) => `<option value="${c}"${c === agenda.couleur ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
        </div>
        ${champAgenda('ag-url', 'Adresse iCal', `<input id="ag-url" type="url" placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" value="${esc(agenda.url)}"${invalide('ag-url')}>`)}
        <p><button type="button" class="btn" data-action="ajouter-agenda">Ajouter l’agenda</button></p>
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
        <section class="bloc"><h3>Agendas suivis</h3>
          ${admin ? '' : '<p class="discret petit">Le choix des agendas suivis revient à l’administration.</p>'}
          ${groupes.map(g => `<h4>${esc(g)}</h4><ul class="ag-sources">${flux.filter(s => s.Groupe === g).map(s => `<li>
            ${admin ? `<label class="interrupteur"><input type="checkbox" role="switch" data-change="source-suivie" data-id="${s.id}"${s.Active ? ' checked' : ''}> <span class="ag-pastille" style="--c:${couleur(s)}" aria-hidden="true"></span> ${esc(s.Nom)}</label>`
              : `<span class="ag-pastille" style="--c:${couleur(s)}" aria-hidden="true"></span> ${esc(s.Nom)} : <span data-etat="${s.Active ? 'suivi' : 'non'}">${s.Active ? 'suivi' : 'non suivi'}</span>`}
          </li>`).join('')}</ul>`).join('')}
        </section>
        <section class="bloc"><h3>Relais : Assemblée nationale, agendas Google et Outlook</h3>
          <p class="petit">${etatRelais(toutes)}</p>
          ${admin ? formulaireAgenda() : '<p class="discret petit">L’abonnement à un agenda Google ou Outlook se demande à l’administration ; pour un événement isolé, importez son fichier .ics ci-dessus.</p>'}
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
  A.actions['ajouter-agenda'] = async () => {
    const v = id => ((document.getElementById(id) || {}).value || '').trim();
    agenda = { nom: v('ag-nom'), url: v('ag-url'), couleur: v('ag-couleur') || COULEURS[0][0] };
    erreursAgenda = {};
    if (!agenda.nom) erreursAgenda['ag-nom'] = 'Indiquez le nom affiché dans l’agenda.';
    else if ((e.doc.Sources || []).some(x => String(x.Nom).toLowerCase() === agenda.nom.toLowerCase())) erreursAgenda['ag-nom'] = 'Ce nom est déjà pris.';
    const url = S.urlSure(agenda.url);
    if (!agenda.url) erreursAgenda['ag-url'] = 'Collez l’adresse iCal de l’agenda.';
    else if (!/^https:\/\//.test(url)) erreursAgenda['ag-url'] = 'Indiquez une adresse qui commence par https://';
    else if ((e.doc.Sources || []).some(x => x.URL === url)) erreursAgenda['ag-url'] = 'Cet agenda est déjà abonné.';
    const premiere = Object.keys(erreursAgenda)[0];
    if (premiere) {
      A.rendre();
      const x = document.getElementById(premiere); if (x) x.focus();
      return;
    }
    const b = C.racine().querySelector('[data-action="ajouter-agenda"]'); if (b) b.focus();
    await C.appliquer([['AddRecord', 'Sources', null, { Nom: agenda.nom, Groupe: 'Agenda externe', Type: 'Flux via relais', Active: true, URL: url, Couleur: agenda.couleur }]]);
    agenda = { nom: '', url: '', couleur: COULEURS[0][0] };
    C.toast('Agenda ajouté : il sera lu au prochain passage du relais, dans les deux heures.');
  };
  A.actions['source-suivie'] = async el => {
    await C.maj('Sources', Number(el.dataset.id), { Active: el.checked }, { rendre: false });
    C.signalerEnregistre(el);
    if (el.checked) Y.synchroniser({ manuel: false });
  };
})(globalThis.Formulaire = globalThis.Formulaire || {});
