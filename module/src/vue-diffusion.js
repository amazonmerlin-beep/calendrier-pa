// Vue Diffusion (administration) : abonnements de consultation. Chacun choisit ce qui part (agendas, dossiers, niveau
// de détail, annulés) ; le relais le publie à une adresse secrète que des personnes extérieures ajoutent à leur
// Google Agenda ou à Outlook. Un événement marqué « Interne » ne part jamais.
(function (L) {
  'use strict';
  const C = L.core, A = L.app, D = L.diffusion, Y = L.synchro, esc = C.esc, e = C.etat;
  const F_JOUR = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'short', year: 'numeric' });
  const jour = sec => F_JOUR.format(new Date(sec * 1000));
  const maintenant = () => Math.floor(Date.now() / 1000);
  const NIVEAUX_AIDE = {
    'Titres et horaires': 'le titre, les horaires et l’agenda d’origine',
    'Avec lieu et description': 'en plus : lieu, description, lien, dossier',
    'Avec notes internes': 'en plus : les notes internes de l’équipe',
  };
  // Saisie en cours, par abonnement : gardée pour survivre aux redessins (veille, écritures des autres)
  const brouillons = {};
  const abonnements = () => (e.doc.Abonnements || []).slice().sort((a, b) => a.id - b.id);
  const abo = id => abonnements().find(a => a.id === id);
  function brouillon(a) {
    if (!brouillons[a.id]) brouillons[a.id] = { Nom: a.Nom || '', Sources: [...(a.Sources || [])], Dossiers: [...(a.Dossiers || [])], Niveau: a.Niveau || D.NIVEAUX[0], Annules: !!a.Annules };
    return brouillons[a.id];
  }
  const modifie = a => { const b = brouillons[a.id]; if (!b) return false; const s = x => JSON.stringify([...x].sort()); return b.Nom !== (a.Nom || '') || s(b.Sources) !== s(a.Sources || []) || s(b.Dossiers) !== s(a.Dossiers || []) || b.Niveau !== (a.Niveau || D.NIVEAUX[0]) || b.Annules !== !!a.Annules; };
  const apercu = b => D.selectionner(e.doc.Evenements || [], b, maintenant());
  function texteApercu(b) {
    const evs = apercu(b);
    if (!evs.length) return 'Aucun événement ne serait diffusé avec ces choix.';
    const avenir = evs.filter(x => x.Debut >= maintenant()).length;
    return `${evs.length} événement${evs.length > 1 ? 's' : ''} diffusé${evs.length > 1 ? 's' : ''}, du ${jour(evs[0].Debut)} au ${jour(evs[evs.length - 1].Debut)}, dont ${avenir} à venir.`;
  }
  function etat(a) {
    if (/^⚠/.test(a.Resultat || '')) return ['À vérifier', 'statut-erreur', 'erreur'];
    if (!a.Actif) return [a.Gist ? 'Arrêt au prochain passage du relais' : 'Non publié', 'statut-non-commence', a.Gist ? 'arret' : 'brouillon'];
    if (!a.Adresse) return ['Publication au prochain passage du relais', 'statut-en-cours', 'attente'];
    return ['Publié', 'statut-valide', 'publie'];
  }

  function casesSources(a, b) {
    const groupes = new Map();
    for (const s of (e.doc.Sources || [])) {
      const n = (e.doc.Evenements || []).filter(x => x.Source === s.id).length;
      if (!n && !b.Sources.includes(s.id) && !s.Active) continue;   // agendas sans événement ni suivi : inutiles ici
      if (!groupes.has(s.Groupe)) groupes.set(s.Groupe, []);
      groupes.get(s.Groupe).push([s, n]);
    }
    if (!groupes.size) return '<p class="discret petit">Aucun agenda n’a encore d’événement.</p>';
    return [...groupes].map(([g, ls]) => `<fieldset class="ag-cases"><legend>${esc(g || 'Autres')}</legend>
      ${ls.map(([s, n]) => `<label class="ag-case"><input type="checkbox" data-change="abo-source" data-abo="${a.id}" value="${s.id}"${b.Sources.includes(s.id) ? ' checked' : ''}>
        <span class="ag-pastille" style="--c:${/^#[0-9a-f]{6}$/i.test(s.Couleur || '') ? s.Couleur : '#15803D'}" aria-hidden="true"></span> ${esc(s.Nom)} <span class="discret petit">(${n})</span></label>`).join('')}
    </fieldset>`).join('');
  }
  function casesDossiers(a, b) {
    const ds = e.doc.Dossiers || [];
    if (!ds.length) return '<p class="discret petit">Aucun dossier suivi.</p>';
    return `<fieldset class="ag-cases"><legend>Dossiers législatifs</legend>${ds.map(d => `<label class="ag-case"><input type="checkbox" data-change="abo-dossier" data-abo="${a.id}" value="${d.id}"${b.Dossiers.includes(d.id) ? ' checked' : ''}>
      ${esc(d.Titre || d.Lien)} <span class="discret petit">(${d.Nb_evenements || 0})</span></label>`).join('')}</fieldset>`;
  }

  function carte(a, ouvert) {
    const b = brouillon(a), [lib, cls, code] = etat(a);
    const nomId = `abo-nom-${a.id}`;
    return `<details class="accordeon" id="abo-${a.id}"${ouvert ? ' open' : ''}>
      <summary><span class="accordeon-titre">${esc(a.Nom || 'Abonnement sans nom')}</span> <span class="statut ${cls}" data-etat="${code}">${esc(lib)}</span>
        <span class="discret petit">${esc(a.Niveau || D.NIVEAUX[0])}</span></summary>
      <div class="accordeon-corps">
        ${a.Adresse && a.Actif ? `<div class="ag-adresse"><label for="abo-url-${a.id}">Adresse à donner aux personnes abonnées</label>
          <input id="abo-url-${a.id}" type="text" readonly value="${esc(a.Adresse)}" data-action="selectionner-adresse">
          <p class="petit">Google Agenda : « Autres agendas », +, « À partir de l’URL ». Outlook : « Ajouter un calendrier », « S’abonner à partir du web ». Toute personne qui a cette adresse voit ce qui est diffusé : ne la donnez qu’aux personnes concernées.</p></div>` : ''}
        ${a.Resultat ? `<p class="petit${/^⚠/.test(a.Resultat) ? ' texte-erreur' : ''}">${esc(a.Resultat)}${a.Publie_le ? ` (${esc(Y.depuis(a.Publie_le))})` : ''}</p>` : ''}
        <div class="ag-form">
          <div class="ag-champ"><label for="${nomId}">Nom de l’agenda chez les personnes abonnées</label><input id="${nomId}" type="text" maxlength="80" data-change="abo-nom" data-abo="${a.id}" value="${esc(b.Nom)}"></div>
          <div><h4>Agendas inclus</h4>${casesSources(a, b)}</div>
          <div><h4>Dossiers inclus</h4>${casesDossiers(a, b)}</div>
          <fieldset class="ag-niveaux"><legend>Niveau de détail</legend>
            ${D.NIVEAUX.map(n => `<label class="ag-case"><input type="radio" name="niveau-${a.id}" data-change="abo-niveau" data-abo="${a.id}" value="${esc(n)}"${b.Niveau === n ? ' checked' : ''}> <b>${esc(n)}</b> <span class="discret petit">: ${esc(NIVEAUX_AIDE[n])}</span></label>`).join('')}
          </fieldset>
          <label class="ag-case"><input type="checkbox" data-change="abo-annules" data-abo="${a.id}"${b.Annules ? ' checked' : ''}> Diffuser aussi les événements annulés (affichés « Annulé : … »)</label>
          <p class="note" id="apercu-${a.id}">${esc(texteApercu(b))}</p>
          <p class="ag-actions-dossier">
            <button type="button" class="btn${modifie(a) ? '' : ' secondaire'}" data-action="abo-enregistrer" data-abo="${a.id}">Enregistrer les choix</button>
            ${a.Actif ? `<button type="button" class="btn lien danger" data-action="abo-arreter" data-abo="${a.id}">Arrêter la publication</button>`
              : `<button type="button" class="btn secondaire" data-action="abo-publier" data-abo="${a.id}">Publier</button>`}
            ${!a.Actif && !a.Gist ? `<button type="button" class="btn lien danger" data-action="abo-supprimer" data-abo="${a.id}">Supprimer<span class="sr-only"> l’abonnement ${esc(a.Nom || '')}</span></button>` : ''}
          </p>
        </div>
      </div></details>`;
  }

  A.vues.diffusion = {
    visible: () => C.estAdmin(),
    rendre() {
      const as = abonnements();
      return `<div class="large"><h2 class="sr-only">Diffusion</h2>
        <p class="petit">Un abonnement publie une partie du Calendrier PA à une adresse secrète, que des personnes extérieures ajoutent à leur Google Agenda ou à Outlook (en lecture seule). Le relais la met à jour toutes les deux heures ; Google peut mettre jusqu’à 24 h à afficher un changement. Un événement marqué « Interne » n’est jamais diffusé.</p>
        <p><button type="button" class="btn" data-action="abo-nouveau">Nouvel abonnement</button></p>
        ${as.length ? as.map(a => carte(a, as.length === 1 || e.arg.abo === a.id)).join('') : '<p class="discret">Aucun abonnement pour l’instant.</p>'}
      </div>`;
    },
  };

  // ------------------------------------------------------------------ saisie (sans redessin : l'aperçu suit sur place)
  const idAbo = el => Number(el.dataset.abo);
  function majApercu(id) {
    const a = abo(id), z = document.getElementById(`apercu-${id}`);
    if (z && a) z.textContent = texteApercu(brouillon(a));
    const b = C.racine().querySelector(`[data-action="abo-enregistrer"][data-abo="${id}"]`);
    if (b && a) b.classList.toggle('secondaire', !modifie(a));
  }
  const basculer = (tab, v, oui) => (oui ? [...new Set([...tab, v])] : tab.filter(x => x !== v));
  A.actions['abo-nom'] = el => { const a = abo(idAbo(el)); if (a) { brouillon(a).Nom = el.value.trim(); majApercu(a.id); } };
  A.actions['abo-source'] = el => { const a = abo(idAbo(el)); if (a) { const b = brouillon(a); b.Sources = basculer(b.Sources, Number(el.value), el.checked); majApercu(a.id); } };
  A.actions['abo-dossier'] = el => { const a = abo(idAbo(el)); if (a) { const b = brouillon(a); b.Dossiers = basculer(b.Dossiers, Number(el.value), el.checked); majApercu(a.id); } };
  A.actions['abo-niveau'] = el => { const a = abo(idAbo(el)); if (a) { brouillon(a).Niveau = el.value; majApercu(a.id); } };
  A.actions['abo-annules'] = el => { const a = abo(idAbo(el)); if (a) { brouillon(a).Annules = el.checked; majApercu(a.id); } };
  A.actions['selectionner-adresse'] = el => el.select();

  const champs = b => ({ Nom: b.Nom || 'Abonnement', Sources: ['L', ...b.Sources], Dossiers: ['L', ...b.Dossiers], Niveau: b.Niveau, Annules: b.Annules });
  A.actions['abo-enregistrer'] = async el => {
    const a = abo(idAbo(el));
    if (!a) return;
    el.focus();
    await C.appliquer([['UpdateRecord', 'Abonnements', a.id, champs(brouillon(a))]]);
    delete brouillons[a.id];
    C.toast(a.Actif ? 'Choix enregistrés : l’agenda publié sera mis à jour au prochain passage du relais.' : 'Choix enregistrés.');
  };
  A.actions['abo-nouveau'] = async () => {
    const r = await C.appliquer([['AddRecord', 'Abonnements', null, { Nom: 'Nouvel abonnement', Actif: false, Niveau: D.NIVEAUX[0], Annules: false, Sources: ['L'], Dossiers: ['L'] }]]);
    A.aller('diffusion', { abo: r.retValues[0] });
    const x = document.getElementById(`abo-nom-${r.retValues[0]}`);
    if (x) { x.focus(); x.select(); }
  };
  // Publier : acte lourd (des personnes extérieures verront ces événements) : récapitulatif, puis une écriture
  A.actions['abo-publier'] = async el => {
    const a = abo(idAbo(el));
    if (!a) return;
    const b = brouillon(a), evs = apercu(b);
    if (!evs.length) return C.toast('Rien à publier : choisissez au moins un agenda ou un dossier qui a des événements.', 'erreur');
    const ok = await C.confirmer(`Publier « ${b.Nom || a.Nom} » ?`,
      `${esc(texteApercu(b))} Niveau de détail : ${esc(b.Niveau)}${b.Niveau === 'Avec notes internes' ? ' : <b>les notes internes de l’équipe seront visibles</b>' : ''}. Toute personne qui aura l’adresse les verra. L’adresse apparaîtra ici après le prochain passage du relais (dans les deux heures).`, 'Publier');
    if (!ok) return;
    await C.appliquer([['UpdateRecord', 'Abonnements', a.id, { ...champs(b), Actif: true }]]);
    delete brouillons[a.id];
    C.toast('Publication demandée : le relais la fera à son prochain passage.');
  };
  A.actions['abo-arreter'] = async el => {
    const a = abo(idAbo(el));
    if (!a || !(await C.confirmer(`Arrêter « ${a.Nom} » ?`, 'Au prochain passage du relais, l’adresse cessera de fonctionner et l’agenda disparaîtra chez les personnes abonnées. Une nouvelle publication donnera une nouvelle adresse.', 'Arrêter la publication'))) return;
    await C.appliquer([['UpdateRecord', 'Abonnements', a.id, { Actif: false }]]);
    C.toast('Arrêt demandé : il sera effectif au prochain passage du relais.');
  };
  A.actions['abo-supprimer'] = async el => {
    const a = abo(idAbo(el));
    if (!a || !(await C.confirmer(`Supprimer « ${a.Nom} » ?`, 'Cet abonnement n’a jamais été publié, ou sa publication est arrêtée.', 'Supprimer'))) return;
    await C.appliquer([['RemoveRecord', 'Abonnements', a.id]]);
    delete brouillons[a.id];
    C.toast('Abonnement supprimé.');
  };
})(globalThis.Formulaire = globalThis.Formulaire || {});
