// Vue Agenda : semaine (par défaut) ou mois ; fiche d'un événement ; création et modification.
(function (L) {
  'use strict';
  const C = L.core, A = L.app, S = L.sync, Y = L.synchro, esc = C.esc, e = C.etat;
  const TZ = S.PARIS;
  const JOUR_MS = 86400000;

  // ------------------------------------------------------------------ dates (calcul sur les jours civils)
  const f2 = n => String(n).padStart(2, '0');
  const cleJour = (a, m, j) => `${a}-${f2(m)}-${f2(j)}`;
  const cleDepuisEpoch = sec => { const p = S.partiesParis(sec); return cleJour(p.annee, p.mois, p.jour); };
  const aujourdhui = () => cleDepuisEpoch(Math.floor(Date.now() / 1000));
  const versUtc = k => { const [a, m, j] = k.split('-').map(Number); return Date.UTC(a, m - 1, j); };
  const depuisUtc = ms => { const d = new Date(ms); return cleJour(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()); };
  const ajouterJours = (k, n) => depuisUtc(versUtc(k) + n * JOUR_MS);
  const lundi = k => { const ms = versUtc(k); return depuisUtc(ms - ((new Date(ms).getUTCDay() + 6) % 7) * JOUR_MS); };
  const premierDuMois = k => k.slice(0, 8) + '01';
  const moisSuivant = (k, n) => { const [a, m] = k.split('-').map(Number); const d = new Date(Date.UTC(a, m - 1 + n, 1)); return cleJour(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); };
  const debutJour = k => { const [a, m, j] = k.split('-').map(Number); return S.versEpoch(a, m, j, 0, 0, 0); };
  const valide = k => typeof k === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(k);

  const majuscule = s => s.charAt(0).toUpperCase() + s.slice(1);
  const fmt = o => new Intl.DateTimeFormat('fr-FR', Object.assign({ timeZone: 'UTC' }, o));
  const F_JOUR_COURT = fmt({ weekday: 'short', day: 'numeric', month: 'short' });
  const F_JOUR_LONG = fmt({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const F_MOIS = fmt({ month: 'long', year: 'numeric' });
  const F_HEURE = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  const F_DATE_EVT = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const jourCourt = k => majuscule(F_JOUR_COURT.format(new Date(versUtc(k))));
  const jourLong = k => F_JOUR_LONG.format(new Date(versUtc(k)));
  const heure = sec => F_HEURE.format(new Date(sec * 1000));

  function titrePeriode(mode, ancre) {
    if (mode === 'mois') return majuscule(F_MOIS.format(new Date(versUtc(ancre))));
    const l = lundi(ancre), d = ajouterJours(l, 6);
    const [, ml, jl] = l.split('-').map(Number), [ad, md, jd] = d.split('-').map(Number);
    const moisNom = k => fmt({ month: 'long' }).format(new Date(versUtc(k)));
    return ml === md ? `Semaine du ${jl} au ${jd} ${moisNom(d)} ${ad}` : `Semaine du ${jl} ${moisNom(l)} au ${jd} ${moisNom(d)} ${ad}`;
  }

  // ------------------------------------------------------------------ données
  const sources = () => e.doc.Sources || [];
  const source = id => sources().find(s => s.id === id) || null;
  const couleur = ev => { const c = (source(ev.Source) || {}).Couleur; return /^#[0-9a-f]{6}$/i.test(c || '') ? c : '#15803D'; };
  const nomSource = ev => (source(ev.Source) || {}).Nom || 'Saisie manuelle';
  const dossier = id => (e.doc.Dossiers || []).find(d => d.id === id) || null;
  const estAnnule = ev => !!ev.Statut;
  const arg = () => {
    const a = e.arg || {};
    return { mode: a.mode === 'mois' ? 'mois' : 'semaine', date: valide(a.date) ? a.date : aujourdhui(), masques: a.masques || [], annules: a.annules !== false, dossier: a.dossier || null };
  };
  function evenementsEntre(debut, fin, a) {
    return (e.doc.Evenements || []).filter(ev => typeof ev.Debut === 'number'
      && ev.Debut < fin && Math.max(ev.Fin || ev.Debut, ev.Debut + 1) > debut
      && !a.masques.includes(ev.Source) && (a.annules || !estAnnule(ev)) && (!a.dossier || ev.Dossier === a.dossier))
      .sort((x, y) => (y.Journee_entiere ? 1 : 0) - (x.Journee_entiere ? 1 : 0) || x.Debut - y.Debut || String(x.Titre).localeCompare(String(y.Titre), 'fr'));
  }
  const duJour = (evs, k) => { const d = debutJour(k), f = debutJour(ajouterJours(k, 1)); return evs.filter(ev => ev.Debut < f && Math.max(ev.Fin || ev.Debut, ev.Debut + 1) > d); };

  // ------------------------------------------------------------------ rendu
  function puce(ev, k, compact) {
    const suite = ev.Debut < debutJour(k);
    const quand = ev.Journee_entiere ? 'Journée' : suite ? 'Suite' : heure(ev.Debut);
    const etat = ev.Statut ? `<span class="sr-only"> (${esc(ev.Statut)})</span>` : '';
    return `<li><button type="button" class="ag-evt${estAnnule(ev) ? ' ag-annule' : ''}${compact ? ' compact' : ''}" style="--c:${couleur(ev)}" data-action="ag-voir" data-id="${ev.id}">
      <span class="ag-heure">${esc(quand)}</span> <span class="ag-evt-titre">${esc(ev.Titre || '(Sans titre)')}</span>${etat}
      ${compact ? '' : `<span class="ag-evt-src">${esc(nomSource(ev))}${ev.Lieu ? ' · ' + esc(ev.Lieu) : ''}</span>`}</button></li>`;
  }

  function vueSemaine(a) {
    const l = lundi(a.date), jours = [...Array(7)].map((_, i) => ajouterJours(l, i));
    const evs = evenementsEntre(debutJour(l), debutJour(ajouterJours(l, 7)), a);
    const auj = aujourdhui();
    return { evs, html: `<div class="ag-semaine">${jours.map((k, i) => {
      const liste = duJour(evs, k);
      const we = i >= 5;
      return `<section class="ag-jour${k === auj ? ' aujourdhui' : ''}${we ? ' weekend' : ''}${we && !liste.length ? ' vide' : ''}" aria-labelledby="j-${k}">
        <h3 id="j-${k}"><span>${esc(jourCourt(k))}</span>${k === auj ? '<span class="ag-auj">Aujourd’hui</span>' : ''}</h3>
        ${liste.length ? `<ul class="ag-liste">${liste.map(ev => puce(ev, k)).join('')}</ul>` : '<p class="ag-rien">Rien de prévu</p>'}
        <button type="button" class="ag-ajout" data-action="ag-nouveau" data-date="${k}">Ajouter<span class="sr-only"> un événement le ${esc(jourLong(k))}</span></button>
      </section>`;
    }).join('')}</div>` };
  }

  function vueMois(a) {
    const p = premierDuMois(a.date), l = lundi(p), suiv = moisSuivant(p, 1);
    const n = Math.ceil((versUtc(suiv) - versUtc(l)) / JOUR_MS / 7);
    const evs = evenementsEntre(debutJour(l), debutJour(ajouterJours(l, n * 7)), a);
    const auj = aujourdhui();
    const entetes = [...Array(7)].map((_, i) => fmt({ weekday: 'short' }).format(new Date(versUtc(ajouterJours(l, i)))));
    let corps = '';
    for (let s = 0; s < n; s++) {
      corps += '<tr>' + [...Array(7)].map((_, i) => {
        const k = ajouterJours(l, s * 7 + i), liste = duJour(evs, k), hors = k.slice(0, 7) !== p.slice(0, 7);
        const j = Number(k.slice(8));
        return `<td class="${hors ? 'hors' : ''}${k === auj ? ' aujourdhui' : ''}">
          <button type="button" class="ag-num" data-action="ag-jour" data-date="${k}"><span aria-hidden="true">${j}</span><span class="sr-only">${esc(jourLong(k))} : voir la semaine</span></button>
          ${liste.length ? `<ul class="ag-liste">${liste.slice(0, 3).map(ev => puce(ev, k, true)).join('')}</ul>` : ''}
          ${liste.length > 3 ? `<button type="button" class="btn lien petit" data-action="ag-jour" data-date="${k}">+ ${liste.length - 3} autre${liste.length > 4 ? 's' : ''}<span class="sr-only"> le ${esc(jourLong(k))}</span></button>` : ''}
        </td>`;
      }).join('') + '</tr>';
    }
    return { evs, html: `<div class="defil"><table class="ag-mois"><caption class="sr-only">${esc(titrePeriode('mois', a.date))}</caption>
      <thead><tr>${entetes.map(x => `<th scope="col">${esc(x)}</th>`).join('')}</tr></thead><tbody>${corps}</tbody></table></div>` };
  }

  A.vues.agenda = {
    rendre() {
      const a = arg();
      const { evs, html } = a.mode === 'mois' ? vueMois(a) : vueSemaine(a);
      // Agendas présents sur la période (et ceux masqués, pour pouvoir les réafficher)
      const tous = evenementsEntre(-Infinity, Infinity, { ...a, masques: [], dossier: a.dossier });
      const ids = [...new Set([...tous.map(ev => ev.Source), ...a.masques])].filter(Boolean);
      const visibles = ids.map(source).filter(Boolean).sort((x, y) => x.Nom.localeCompare(y.Nom, 'fr'));
      const d = a.dossier && dossier(a.dossier);
      const unite = a.mode === 'mois' ? 'Mois' : 'Semaine';
      return `<div class="ag">
        <h2 class="sr-only">Agenda</h2>
        <div class="ag-barre">
          <div class="ag-nav">
            <button type="button" class="btn secondaire petit" data-action="ag-decaler" data-pas="-1"><span aria-hidden="true">‹</span><span class="sr-only">${unite} précédent${a.mode === 'mois' ? '' : 'e'}</span></button>
            <button type="button" class="btn secondaire petit" data-action="ag-auj">Aujourd’hui</button>
            <button type="button" class="btn secondaire petit" data-action="ag-decaler" data-pas="1"><span aria-hidden="true">›</span><span class="sr-only">${unite} suivant${a.mode === 'mois' ? '' : 'e'}</span></button>
            <p class="ag-titre" aria-live="polite">${esc(titrePeriode(a.mode, a.date))}</p>
          </div>
          <div class="ag-outils">
            <div class="ag-modes" role="group" aria-label="Affichage">
              <button type="button" data-action="ag-mode" data-mode="semaine" aria-pressed="${a.mode === 'semaine'}">Semaine</button>
              <button type="button" data-action="ag-mode" data-mode="mois" aria-pressed="${a.mode === 'mois'}">Mois</button>
            </div>
            <button type="button" class="btn" data-action="ag-nouveau">Nouvel événement</button>
          </div>
        </div>
        ${d ? `<p class="note">Seuls les événements du dossier « ${esc(d.Titre || d.Lien)} » sont affichés. <button type="button" class="btn lien" data-action="ag-sans-dossier">Afficher tout l’agenda</button></p>` : ''}
        <div class="ag-filtres">
          ${visibles.length ? `<div class="ag-agendas" role="group" aria-label="Agendas affichés">${visibles.map(s => `<button type="button" class="ag-chip" data-action="ag-filtre" data-cle="${s.id}" aria-pressed="${!a.masques.includes(s.id)}" style="--c:${/^#[0-9a-f]{6}$/i.test(s.Couleur || '') ? s.Couleur : '#15803D'}"><span class="ag-pastille" aria-hidden="true"></span>${esc(s.Nom)}</button>`).join('')}</div>` : ''}
          <label class="ag-case"><input type="checkbox" data-change="ag-annules"${a.annules ? ' checked' : ''}> Afficher les événements annulés</label>
        </div>
        <p class="ag-synchro petit" data-etat-synchro>${Y.htmlEtat()}</p>
        ${html}
        <p class="discret petit">${evs.length} événement${evs.length > 1 ? 's' : ''} sur la période.</p>
      </div>`;
    },
    apres() { Y.demarrerAuto(); },
  };

  // ------------------------------------------------------------------ navigation et filtres
  const allerAgenda = maj => A.aller('agenda', Object.assign({}, arg(), maj));
  A.actions['ag-decaler'] = el => {
    const a = arg(), pas = Number(el.dataset.pas);
    allerAgenda({ date: a.mode === 'mois' ? moisSuivant(premierDuMois(a.date), pas) : ajouterJours(lundi(a.date), 7 * pas) });
  };
  A.actions['ag-auj'] = () => allerAgenda({ date: aujourdhui() });
  A.actions['ag-mode'] = el => allerAgenda({ mode: el.dataset.mode });
  A.actions['ag-jour'] = el => allerAgenda({ mode: 'semaine', date: el.dataset.date });
  A.actions['ag-sans-dossier'] = () => allerAgenda({ dossier: null });
  function surPlace(maj, focus) {
    e.arg = Object.assign({}, arg(), maj);
    A.memoriser();
    A.rendre();
    const x = focus && C.racine().querySelector(focus);
    if (x) x.focus();
  }
  A.actions['ag-filtre'] = el => {
    const id = Number(el.dataset.cle), m = arg().masques;
    surPlace({ masques: m.includes(id) ? m.filter(x => x !== id) : [...m, id] }, `[data-action="ag-filtre"][data-cle="${id}"]`);
  };
  A.actions['ag-annules'] = el => surPlace({ annules: el.checked }, '[data-change="ag-annules"]');
  A.actions.synchroniser = () => Y.synchroniser({ manuel: true });

  // ------------------------------------------------------------------ fiche d'un événement
  function quand(ev) {
    const j1 = cleDepuisEpoch(ev.Debut), j2 = cleDepuisEpoch(ev.Fin || ev.Debut);
    const date = sec => majuscule(F_DATE_EVT.format(new Date(sec * 1000)));
    if (ev.Journee_entiere) return j1 === j2 ? `${date(ev.Debut)}, journée entière` : `Du ${date(ev.Debut)} au ${date(ev.Fin)}`;
    if (j1 === j2) return `${date(ev.Debut)}, ${heure(ev.Debut)}${ev.Fin && ev.Fin !== ev.Debut ? ' – ' + heure(ev.Fin) : ''}`;
    return `Du ${date(ev.Debut)}, ${heure(ev.Debut)} au ${date(ev.Fin)}, ${heure(ev.Fin)}`;
  }
  const venuDUneSource = ev => !!ev.UID;
  const texteMultiligne = s => esc(s).replace(/\n/g, '<br>');

  A.actions['ag-voir'] = async el => {
    const ev = (e.doc.Evenements || []).find(x => x.id === Number(el.dataset.id));
    if (!ev) return;
    const d = ev.Dossier && dossier(ev.Dossier);
    const s = source(ev.Source);
    const lien = S.urlSure(ev.Lien);
    const contenu = `<p class="ag-fiche-quand"><b>${esc(quand(ev))}</b></p>
      <p><span class="ag-chip statique" style="--c:${couleur(ev)}"><span class="ag-pastille" aria-hidden="true"></span>${esc(nomSource(ev))}</span>
        ${ev.Statut ? ` <span class="statut" data-etat="${esc(ev.Statut)}">${esc(ev.Statut)}</span>` : ''}</p>
      ${ev.Lieu ? `<p><span class="discret">Lieu :</span> ${esc(ev.Lieu)}</p>` : ''}
      ${d ? `<p><span class="discret">Dossier :</span> ${esc(d.Titre || d.Lien)}</p>` : ''}
      ${ev.Description ? `<div class="ag-fiche-desc">${texteMultiligne(ev.Description)}</div>` : ''}
      ${lien ? `<p><a href="${esc(lien)}" target="_blank" rel="noopener noreferrer">${/senat\.fr/.test(lien) ? 'Voir sur le site du Sénat' : 'Ouvrir le lien'}</a></p>` : ''}
      ${ev.Notes ? `<div class="note"><b>Notes internes</b><br>${texteMultiligne(ev.Notes)}</div>` : ''}
      <p class="discret petit">${venuDUneSource(ev) ? `Venu de « ${esc(s ? s.Nom : 'source inconnue')} ».` : `Ajouté par ${esc(ev.Cree_par || 'inconnu')}.`}
        ${ev.Modifie_le ? ` Modifié par ${esc(ev.Modifie_par || '')} le ${esc(new Date(ev.Modifie_le * 1000).toLocaleString('fr-FR', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' }))}.` : ''}</p>`;
    const choix = await C.fenetre(ev.Titre || '(Sans titre)', contenu, {
      large: true,
      boutons: [{ libelle: 'Supprimer', valeur: 'supprimer', classe: 'lien danger' }, { libelle: 'Fermer', valeur: null, classe: 'secondaire' }, { libelle: 'Modifier', valeur: 'modifier' }],
    });
    if (choix === 'modifier') return editer(ev);
    if (choix === 'supprimer') return supprimer(ev);
  };

  async function supprimer(ev) {
    const txt = venuDUneSource(ev)
      ? 'Cet événement vient d’une source : il reviendra à la prochaine synchronisation s’il y est toujours publié. Pour le garder visible mais barré, modifiez-le et cochez « Annulé ».'
      : 'L’événement sera supprimé pour tout le monde. Vous pouvez annuler aussitôt avec Ctrl+Z dans Grist.';
    if (!(await C.confirmer(`Supprimer « ${ev.Titre || 'cet événement'} » ?`, esc(txt), 'Supprimer'))) return;
    await C.appliquer([['RemoveRecord', 'Evenements', ev.id]]);
    C.toast('Événement supprimé.');
  }

  // ------------------------------------------------------------------ création et modification
  const champ = (id, lib, html, o = {}) => `<div class="ag-champ${o.large ? ' large' : ''}"><label for="${id}">${esc(lib)}${o.requis ? ' <span class="repere">obligatoire</span>' : ''}</label>${html}<p class="erreur-champ" id="${id}-err" hidden></p></div>`;
  function formulaire(ev, k) {
    const debut = ev ? ev.Debut : debutJour(k) + 9 * 3600, fin = ev ? (ev.Fin || ev.Debut) : debut + 3600;
    const jd = cleDepuisEpoch(debut), jf = cleDepuisEpoch(fin);
    const hh = sec => heure(sec).replace(/\s/g, '');
    const j = ev ? !!ev.Journee_entiere : false;
    const dossiers = (e.doc.Dossiers || []).slice().sort((x, y) => String(x.Titre || x.Lien).localeCompare(String(y.Titre || y.Lien), 'fr'));
    const avertissement = ev && venuDUneSource(ev)
      ? '<p class="note">Cet événement vient d’une source : vos changements sont gardés tant qu’elle ne le modifie pas. Les notes internes ne sont jamais remplacées.</p>' : '';
    return `${avertissement}<div class="ag-form">
      ${champ('f-titre', 'Titre', `<input id="f-titre" type="text" maxlength="300" value="${esc(ev ? ev.Titre : '')}">`, { requis: true, large: true })}
      <div class="ag-ligne">
        ${champ('f-jd', 'Date de début', `<input id="f-jd" type="date" value="${jd}">`, { requis: true })}
        ${champ('f-hd', 'Heure de début', `<input id="f-hd" type="time" value="${hh(debut)}"${j ? ' disabled' : ''}>`)}
        ${champ('f-jf', 'Date de fin', `<input id="f-jf" type="date" value="${jf}">`, { requis: true })}
        ${champ('f-hf', 'Heure de fin', `<input id="f-hf" type="time" value="${hh(fin)}"${j ? ' disabled' : ''}>`)}
      </div>
      <label class="ag-case"><input id="f-journee" type="checkbox"${j ? ' checked' : ''}> Journée entière</label>
      ${champ('f-lieu', 'Lieu', `<input id="f-lieu" type="text" maxlength="300" value="${esc(ev ? ev.Lieu : '')}">`, { large: true })}
      ${champ('f-desc', 'Description', `<textarea id="f-desc" rows="4">${esc(ev ? ev.Description : '')}</textarea>`, { large: true })}
      ${champ('f-lien', 'Lien', `<input id="f-lien" type="url" placeholder="https://…" value="${esc(ev ? ev.Lien : '')}">`, { large: true })}
      ${champ('f-dossier', 'Dossier législatif', `<select id="f-dossier"><option value="">Aucun</option>${dossiers.map(d => `<option value="${d.id}"${ev && ev.Dossier === d.id ? ' selected' : ''}>${esc(d.Titre || d.Lien)}</option>`).join('')}</select>`, { large: true })}
      ${champ('f-notes', 'Notes internes', `<textarea id="f-notes" rows="3">${esc(ev ? ev.Notes : '')}</textarea>`, { large: true })}
      <label class="ag-case"><input id="f-annule" type="checkbox"${ev && ev.Statut === 'Annulé' ? ' checked' : ''}> Annulé (reste visible, barré)</label>
    </div>`;
  }
  function erreur(id, texte) {
    const el = document.getElementById(id), z = document.getElementById(id + '-err');
    if (!el || !z) return;
    z.textContent = texte || ''; z.hidden = !texte;
    if (texte) { el.setAttribute('aria-invalid', 'true'); el.setAttribute('aria-describedby', id + '-err'); }
    else { el.removeAttribute('aria-invalid'); el.removeAttribute('aria-describedby'); }
  }
  /** Lit et vérifie le formulaire ; renvoie les champs à écrire, ou null (erreurs affichées, focus sur la première). */
  function lireFormulaire(ev) {
    const v = id => (document.getElementById(id) || {}).value || '';
    const coche = id => !!(document.getElementById(id) || {}).checked;
    ['f-titre', 'f-jd', 'f-jf', 'f-hd', 'f-hf', 'f-lien'].forEach(id => erreur(id, ''));
    const fautes = [];
    const titre = v('f-titre').trim();
    if (!titre) fautes.push(['f-titre', 'Indiquez un titre.']);
    const journee = coche('f-journee');
    const jd = v('f-jd'), jf = v('f-jf') || jd;
    if (!valide(jd)) fautes.push(['f-jd', 'Indiquez la date de début.']);
    if (!valide(jf)) fautes.push(['f-jf', 'Indiquez la date de fin.']);
    const hm = (s, def) => { const m = /^(\d{1,2}):(\d{2})/.exec(s || def); return m ? [+m[1], +m[2]] : null; };
    let Debut = null, Fin = null;
    if (valide(jd) && valide(jf)) {
      const [a1, m1, d1] = jd.split('-').map(Number), [a2, m2, d2] = jf.split('-').map(Number);
      if (journee) { Debut = S.versEpoch(a1, m1, d1, 0, 0, 0); Fin = S.versEpoch(a2, m2, d2, 23, 59, 0); }
      else {
        const h1 = hm(v('f-hd')), h2 = hm(v('f-hf'));
        if (!h1) fautes.push(['f-hd', 'Indiquez l’heure de début, ou cochez « Journée entière ».']);
        if (!h2) fautes.push(['f-hf', 'Indiquez l’heure de fin.']);
        if (h1 && h2) { Debut = S.versEpoch(a1, m1, d1, h1[0], h1[1], 0); Fin = S.versEpoch(a2, m2, d2, h2[0], h2[1], 0); }
      }
      if (Debut !== null && Fin !== null && Fin < Debut) fautes.push(['f-jf', 'La fin est avant le début.']);
    }
    const lienSaisi = v('f-lien').trim(), Lien = S.urlSure(lienSaisi);
    if (lienSaisi && !Lien) fautes.push(['f-lien', 'Indiquez une adresse qui commence par https://']);
    if (fautes.length) {
      fautes.forEach(([id, t]) => erreur(id, t));
      const x = document.getElementById(fautes[0][0]);
      if (x) x.focus();
      return null;
    }
    const statut = coche('f-annule') ? 'Annulé' : (ev && ev.Statut === S.STATUT_RETIRE ? ev.Statut : null);
    return {
      Titre: titre, Debut, Fin, Journee_entiere: journee, Lieu: v('f-lieu').trim(), Description: v('f-desc').trim(), Lien,
      Dossier: Number(v('f-dossier')) || null, Notes: v('f-notes').trim(), Statut: statut,
    };
  }
  async function editer(ev, k) {
    let champs = null;
    // La case « Journée entière » désactive les heures (écouteur posé dès l'ouverture de la fenêtre)
    // et une erreur affichée sous un champ s'efface dès qu'on le corrige
    setTimeout(() => {
      const c = document.getElementById('f-journee');
      if (c) c.addEventListener('change', () => ['f-hd', 'f-hf'].forEach(id => { const x = document.getElementById(id); if (x) x.disabled = c.checked; }));
      const f = document.querySelector('.voile .ag-form');
      if (f) f.addEventListener('input', ev => { if (ev.target.id && ev.target.getAttribute('aria-invalid')) erreur(ev.target.id, ''); });
    }, 0);
    const choix = await C.fenetre(ev ? 'Modifier l’événement' : 'Nouvel événement', formulaire(ev, k || arg().date), {
      large: true,
      boutons: [{ libelle: 'Annuler', valeur: null, classe: 'secondaire' }, { libelle: 'Enregistrer', valeur: 'ok' }],
      avant: val => { if (val !== 'ok') return true; champs = lireFormulaire(ev); return !!champs; },
    });
    if (choix !== 'ok' || !champs) return;
    if (ev) {
      await C.appliquer([['UpdateRecord', 'Evenements', ev.id, champs]]);
      C.toast('Événement enregistré.');
    } else {
      await C.appliquer([['AddRecord', 'Evenements', null, champs]]);
      C.toast('Événement ajouté.');
      const k2 = cleDepuisEpoch(champs.Debut), a = arg();
      const memePeriode = a.mode === 'mois' ? k2.slice(0, 7) === a.date.slice(0, 7) : lundi(k2) === lundi(a.date);
      if (!memePeriode) allerAgenda({ date: k2 });
    }
  }
  A.actions['ag-nouveau'] = el => editer(null, el.dataset.date || null);
})(globalThis.Formulaire = globalThis.Formulaire || {});
