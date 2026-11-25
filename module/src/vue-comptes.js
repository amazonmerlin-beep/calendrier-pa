// Gestion des accès depuis le module : le document est partagé par lien (toute personne connectée qui a le lien peut
// l'ouvrir) ; l'annuaire décide de ce que chacun voit. Onglet Comptes (administration) : demandes d'accès, comptes,
// rôles, lien à envoyer. Écran des comptes non reconnus : se connecter, ou demander un accès.
(function (L) {
  'use strict';
  const C = L.core, A = L.app, esc = C.esc, e = C.etat;
  const F_DATE = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const date = sec => (sec ? F_DATE.format(new Date(sec * 1000)) : '');
  const ROLES = [['membre', 'Membre'], ['admin', 'Administration']];
  const libRole = r => (ROLES.find(x => x[0] === r) || [, r || '—'])[1];
  const RE_EMAIL = /^[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}$/i;
  const maintenant = () => Math.floor(Date.now() / 1000);

  // ------------------------------------------------------------------ adresse du document (connexion, lien à envoyer)
  // Tirée du jeton du widget : l'adresse du document ouvert, pas un paramètre recopié d'un autre document
  let adresse = null;
  async function adresseDocument() {
    if (adresse) return adresse;
    try {
      const t = await grist.docApi.getAccessToken({ readOnly: true });
      const u = new URL(t.baseUrl);
      const m = /^(.*)\/api\/docs\/([^/]+)/.exec(u.pathname);
      adresse = { origine: u.origin, chemin: m ? `${m[1]}/doc/${m[2]}` : '/' };
    } catch (x) { adresse = null; }
    return adresse;
  }
  // Connexion : « next » est un chemin relatif (une adresse complète casse le retour sur certaines instances)
  const lienConnexion = a => (a ? `${a.origine}/login?next=${encodeURIComponent(a.chemin)}` : '');

  // ------------------------------------------------------------------ écran des comptes non reconnus
  const estAnonyme = m => !m.email || m.email === 'anon@getgrist.com';
  const mesDemandes = () => (e.doc.Demandes || []).filter(d => d.Email === e.moi.email).sort((a, b) => (b.Le || 0) - (a.Le || 0));
  A.vues.inconnu = {
    rendre() {
      const m = e.moi, contact = C.param('contact_email', L.CONFIG.contactEmail);
      if (estAnonyme(m)) {
        return `<div class="colonne ag-accueil-inconnu"><h2>Connectez-vous pour ouvrir le Calendrier PA</h2>
          <p class="intro">Le calendrier n’est visible que des personnes inscrites. Connectez-vous avec votre compte Grist ; si votre adresse n’est pas encore inscrite, vous pourrez demander un accès.</p>
          <p><a class="btn" id="lien-connexion" href="${esc(lienConnexion(adresse) || '#')}" target="_top">Se connecter</a></p></div>`;
      }
      const d = mesDemandes()[0];
      let suite;
      if (d && d.Statut === 'En attente') {
        suite = `<div class="note succes" data-etat="demande-en-attente">Demande d’accès envoyée le ${esc(date(d.Le))}. L’administration va la traiter : cette page s’ouvrira d’elle-même dès que l’accès sera accordé.</div>`;
      } else {
        suite = `${d && d.Statut === 'Refusée' ? `<div class="note alerte" data-etat="demande-refusee">Votre demande du ${esc(date(d.Le))} n’a pas été acceptée. Vous pouvez en envoyer une autre, en précisant votre besoin.</div>` : ''}
          <div class="ag-champ"><label for="demande-message">Message à l’administration (facultatif)</label>
          <textarea id="demande-message" rows="3" maxlength="500" placeholder="Ex. : équipe affaires publiques, suivi du budget"></textarea></div>
          <p><button type="button" class="btn" data-action="demander-acces">Demander l’accès</button></p>`;
      }
      return `<div class="colonne ag-accueil-inconnu"><h2>Votre compte n’a pas encore accès au Calendrier PA</h2>
        <p class="intro">Vous êtes connecté avec l’adresse <b>${esc(m.email)}</b>.</p>
        ${suite}
        <p class="petit discret">Une question : ${esc(C.param('contact_nom', 'l’équipe'))}, <b>${esc(contact)}</b>. Mauvaise adresse ? Déconnectez-vous de Grist et reconnectez-vous avec la bonne.</p></div>`;
    },
    async apres(racine) {
      const a = racine.querySelector('#lien-connexion');
      if (a) { const l = lienConnexion(await adresseDocument()); if (l) a.href = l; }
    },
  };
  // L'adresse est demandée dès le chargement : le lien « Se connecter » est prêt au premier affichage
  adresseDocument();
  A.actions['demander-acces'] = async el => {
    const msg = ((document.getElementById('demande-message') || {}).value || '').trim();
    // Le focus quitte la zone de texte : sans cela, le module ne redessine pas l'écran (saisie supposée en cours)
    el.focus();
    el.disabled = true;
    try {
      await C.appliquer([['AddRecord', 'Demandes', null, { Message: msg, Statut: 'En attente' }]], { tables: ['Demandes'] });
      C.toast('Demande envoyée.');
    } finally { el.disabled = false; }
  };

  // ------------------------------------------------------------------ onglet Comptes (administration)
  let nouveau = { Email: '', Nom: '', Role: 'membre' }, erreurs = {};
  const derniereConnexion = () => {
    const m = new Map();
    for (const c of e.doc.Connexions || []) if (c.Email && (!m.has(c.Email) || c.Le > m.get(c.Email))) m.set(c.Email, c.Le);
    return m;
  };
  const enAttente = () => (e.doc.Demandes || []).filter(d => d.Statut === 'En attente').sort((a, b) => (a.Le || 0) - (b.Le || 0));
  const champ = (id, lib, html, requis) => `<div class="ag-champ"><label for="${id}">${esc(lib)}${requis ? ' <span class="repere">obligatoire</span>' : ''}</label>${html}
    <p class="erreur-champ" id="${id}-err"${erreurs[id] ? '' : ' hidden'}>${esc(erreurs[id] || '')}</p></div>`;
  const invalide = id => (erreurs[id] ? ` aria-invalid="true" aria-describedby="${id}-err"` : '');

  A.vues.comptes = {
    visible: () => C.estAdmin(),
    rendre() {
      const comptes = (e.doc.Annuaire || []).slice().sort((a, b) => (b.Actif - a.Actif) || String(a.Nom || a.Email).localeCompare(String(b.Nom || b.Email), 'fr'));
      const vu = derniereConnexion(), demandes = enAttente();
      return `<div class="large"><h2 class="sr-only">Comptes</h2>
        <section class="bloc"><h3>Lien à envoyer</h3>
          <p class="petit">Le document est ouvert à toute personne connectée à Grist qui a ce lien ; seules les adresses actives de la liste ci-dessous voient le calendrier. Les autres peuvent demander un accès, qui apparaît ici.</p>
          <div class="ag-adresse"><label for="lien-document" class="sr-only">Lien du document</label>
            <input id="lien-document" type="text" readonly value="" data-action="selectionner-lien"></div>
        </section>
        ${demandes.length ? `<section class="bloc"><h3>Demandes d’accès <span class="discret">(${demandes.length})</span></h3>
          <ul class="ag-resultats">${demandes.map(d => `<li class="ag-resultat" data-demande="${d.id}">
            <p class="ag-resultat-titre">${esc(d.Nom || d.Email)} <span class="discret petit">${esc(d.Email)}</span></p>
            <p class="petit discret">Demandé le ${esc(date(d.Le))}</p>
            ${d.Message ? `<p class="petit">« ${esc(d.Message)} »</p>` : ''}
            <p class="ag-actions-dossier">
              <button type="button" class="btn secondaire petit" data-action="accepter-demande" data-id="${d.id}" data-role="membre">Accepter comme membre<span class="sr-only"> : ${esc(d.Email)}</span></button>
              <button type="button" class="btn secondaire petit" data-action="accepter-demande" data-id="${d.id}" data-role="admin">Accepter comme administrateur<span class="sr-only"> : ${esc(d.Email)}</span></button>
              <button type="button" class="btn lien danger" data-action="refuser-demande" data-id="${d.id}">Refuser<span class="sr-only"> : ${esc(d.Email)}</span></button>
            </p></li>`).join('')}</ul></section>` : ''}
        <section class="bloc"><h3>Ajouter un compte</h3>
          <div class="ag-ligne">
            ${champ('compte-email', 'Adresse', `<input id="compte-email" type="email" autocomplete="off" value="${esc(nouveau.Email)}"${invalide('compte-email')}>`, true)}
            ${champ('compte-nom', 'Nom', `<input id="compte-nom" type="text" maxlength="120" value="${esc(nouveau.Nom)}">`)}
            ${champ('compte-role', 'Rôle', `<select id="compte-role">${ROLES.map(([v, l]) => `<option value="${v}"${nouveau.Role === v ? ' selected' : ''}>${l}</option>`).join('')}</select>`)}
          </div>
          <p><button type="button" class="btn" data-action="ajouter-compte">Ajouter le compte</button></p>
          <p class="petit discret">La personne ouvre ensuite le lien ci-dessus avec cette adresse : aucune invitation n’est envoyée par Grist.</p>
        </section>
        <section class="bloc"><h3>Comptes <span class="discret">(${comptes.filter(c => c.Actif).length} actifs sur ${comptes.length})</span></h3>
          <div class="defil"><table class="tableau"><caption class="sr-only">Comptes qui ont accès au calendrier</caption>
            <thead><tr><th scope="col">Nom</th><th scope="col">Adresse</th><th scope="col">Rôle</th><th scope="col">Actif</th><th scope="col">Dernière connexion</th></tr></thead>
            <tbody>${comptes.map(c => {
              const moi = c.Email === e.moi.email;
              return `<tr data-compte="${c.id}"${c.Actif ? '' : ' class="inactif"'}><td>${esc(c.Nom || '—')}${moi ? ' <span class="discret petit">(vous)</span>' : ''}</td><td>${esc(c.Email)}</td>
                <td><label class="sr-only" for="role-${c.id}">Rôle de ${esc(c.Email)}</label><select id="role-${c.id}" data-change="changer-role" data-id="${c.id}"${moi ? ' disabled title="Vous ne pouvez pas modifier votre propre rôle"' : ''}>${ROLES.map(([v, l]) => `<option value="${v}"${c.Role === v ? ' selected' : ''}>${l}</option>`).join('')}</select></td>
                <td><label class="interrupteur"><input type="checkbox" role="switch" data-change="changer-actif" data-id="${c.id}"${c.Actif ? ' checked' : ''}${moi ? ' disabled' : ''}><span class="sr-only"> Accès actif : ${esc(c.Email)}</span></label></td>
                <td>${esc(date(vu.get(c.Email)) || 'jamais')}</td></tr>`;
            }).join('')}</tbody></table></div>
        </section>
      </div>`;
    },
    async apres(racine) {
      const i = racine.querySelector('#lien-document');
      if (i) { const a = await adresseDocument(); i.value = a ? a.origine + a.chemin : ''; }
    },
  };
  A.actions['selectionner-lien'] = el => el.select();

  function erreur(id, texte) { erreurs[id] = texte; }
  A.actions['ajouter-compte'] = async () => {
    const v = id => ((document.getElementById(id) || {}).value || '').trim();
    nouveau = { Email: v('compte-email').toLowerCase(), Nom: v('compte-nom'), Role: v('compte-role') || 'membre' };
    erreurs = {};
    if (!nouveau.Email) erreur('compte-email', 'Indiquez l’adresse de connexion à Grist de la personne.');
    else if (!RE_EMAIL.test(nouveau.Email)) erreur('compte-email', 'Cette adresse n’est pas valide.');
    else if ((e.doc.Annuaire || []).some(c => c.Email === nouveau.Email)) erreur('compte-email', 'Cette adresse est déjà dans la liste : réactivez-la ou changez son rôle ci-dessous.');
    if (Object.keys(erreurs).length) {
      A.rendre();
      const x = document.getElementById('compte-email'); if (x) x.focus();
      return;
    }
    const b = C.racine().querySelector('[data-action="ajouter-compte"]'); if (b) b.focus();
    const ajout = nouveau;
    await C.appliquer([['AddRecord', 'Annuaire', null, { Email: ajout.Email, Nom: ajout.Nom, Role: ajout.Role, Actif: true }]]);
    nouveau = { Email: '', Nom: '', Role: 'membre' };
    C.toast(`Compte ajouté : ${ajout.Email}. Envoyez-lui le lien du document.`);
  };

  // Changer un rôle ou couper un accès : confirmé (acte lourd), et l'ancienne valeur revient si l'on annule
  A.actions['changer-role'] = async el => {
    const c = (e.doc.Annuaire || []).find(x => x.id === Number(el.dataset.id));
    if (!c) return;
    const ok = await C.confirmer(`Changer le rôle de ${c.Nom || c.Email} ?`, `${esc(libRole(c.Role))} → <b>${esc(libRole(el.value))}</b>. ${el.value === 'admin' ? 'L’administration gère les comptes, les sources suivies et la diffusion.' : 'Un membre consulte et alimente le calendrier, sans gérer les comptes.'}`, 'Changer le rôle');
    if (!ok) { el.value = c.Role; return; }
    await C.maj('Annuaire', c.id, { Role: el.value });
    C.toast('Rôle modifié.');
  };
  A.actions['changer-actif'] = async el => {
    const c = (e.doc.Annuaire || []).find(x => x.id === Number(el.dataset.id));
    if (!c) return;
    if (!el.checked) {
      const ok = await C.confirmer(`Couper l’accès de ${c.Nom || c.Email} ?`, 'La personne ne verra plus le calendrier, aussitôt. Ses ajouts restent. Vous pourrez réactiver le compte.', 'Couper l’accès');
      if (!ok) { el.checked = true; return; }
    }
    await C.maj('Annuaire', c.id, { Actif: el.checked });
    C.toast(el.checked ? 'Accès rétabli.' : 'Accès coupé.');
  };

  // Demandes : une seule écriture (compte + demande traitée)
  async function traiter(el, role) {
    const d = (e.doc.Demandes || []).find(x => x.id === Number(el.dataset.id));
    if (!d) return;
    if (role === 'admin' && !(await C.confirmer(`Accorder l’administration à ${d.Email} ?`, 'L’administration gère les comptes, les sources suivies et la diffusion.', 'Accorder'))) return;
    const existant = (e.doc.Annuaire || []).find(c => c.Email === d.Email);
    const actions = [];
    if (role) actions.push(existant ? ['UpdateRecord', 'Annuaire', existant.id, { Role: role, Actif: true }] : ['AddRecord', 'Annuaire', null, { Email: d.Email, Nom: d.Nom || '', Role: role, Actif: true }]);
    actions.push(['UpdateRecord', 'Demandes', d.id, { Statut: role ? 'Acceptée' : 'Refusée', Traite_par: e.moi.email, Traite_le: maintenant() }]);
    await C.appliquer(actions, { tables: ['Annuaire', 'Demandes'] });
    C.toast(role ? `Accès accordé à ${d.Email}.` : 'Demande refusée.');
  }
  A.actions['accepter-demande'] = el => traiter(el, el.dataset.role);
  A.actions['refuser-demande'] = async el => {
    const d = (e.doc.Demandes || []).find(x => x.id === Number(el.dataset.id));
    if (d && await C.confirmer(`Refuser la demande de ${d.Email} ?`, 'La personne le verra en ouvrant le lien ; elle pourra faire une nouvelle demande.', 'Refuser')) return traiter(el, null);
  };

  A.pastilles.comptes = {
    compter: () => enAttente().length,
    annonce: k => (k > 1 ? `${k} demandes d’accès en attente.` : 'Nouvelle demande d’accès.'),
  };
})(globalThis.Formulaire = globalThis.Formulaire || {});
