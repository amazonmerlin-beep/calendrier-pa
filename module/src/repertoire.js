// Formulaire.repertoire — recherche dans le répertoire des dossiers législatifs en cours (publié chaque jour par le
// relais : relais/repertoire.mjs). Fonctions pures, testées (module/test/repertoire.test.js).
// Entrée du répertoire : { t: titre, t2: autre titre, ty: type, d: date de dépôt, e: état, s: chemin Sénat, a: chemin Assemblée,
// m: dernière étape, th: thèmes du Sénat }.
(function (L) {
  'use strict';
  const MOTS_VIDES = new Set(['a', 'au', 'aux', 'd', 'dans', 'de', 'des', 'du', 'en', 'et', 'l', 'la', 'le', 'les', 'par', 'pour', 'sur', 'un', 'une',
    'relatif', 'relative', 'relatifs', 'relatives', 'visant', 'tendant', 'portant', 'loi', 'projet', 'proposition']);
  // Abréviations courantes, remplacées par les mots des titres officiels
  const ABREVIATIONS = { plf: ['finances'], plfss: ['financement', 'securite', 'sociale'], plfr: ['finances', 'rectificative'], lfss: ['financement', 'securite', 'sociale'] };
  // Mots du langage courant : un dossier qui porte le terme officiel passe devant (« budget » : la loi de finances)
  const PROCHES = { budget: ' loi de finances ' };
  const normaliser = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/['’]/g, ' ').replace(/[^a-z0-9-]+/g, ' ').replace(/\s+/g, ' ').trim();

  /** Prépare le répertoire (texte de recherche normalisé, une fois). */
  function preparer(rep) {
    return ((rep && rep.dossiers) || []).map(e => Object.assign({}, e, {
      _txt: ` ${normaliser([e.t, e.t2, e.ty, e.th, e.s, e.a ? e.a.split('/').pop() : ''].filter(Boolean).join(' '))} `,
    }));
  }

  /**
   * Dossiers dont le texte contient tous les mots utiles de la requête (début de mot ou mot entier mieux classés),
   * puis les plus récents. o : { assemblee: '' | 'senat' | 'an', limite }.
   */
  function chercher(prep, requete, o = {}) {
    const mots = normaliser(requete).split(' ').filter(Boolean).flatMap(m => ABREVIATIONS[m] || [m]);
    let utiles = mots.filter(m => !MOTS_VIDES.has(m));
    if (!utiles.length) utiles = mots;
    if (!utiles.length || utiles.join('').length < 2) return { total: 0, resultats: [] };
    const phrase = ` ${utiles.join(' ')}`;
    const trouves = [];
    for (const e of prep) {
      if (o.assemblee === 'senat' && !e.s) continue;
      if (o.assemblee === 'an' && !e.a) continue;
      if (!utiles.every(m => e._txt.includes(m))) continue;
      let score = 0;
      for (const m of utiles) score += e._txt.includes(` ${m} `) ? 3 : e._txt.includes(` ${m}`) ? 2 : 1;
      if (utiles.length > 1 && e._txt.includes(phrase)) score += 4;
      for (const m of utiles) if (PROCHES[m] && e._txt.includes(PROCHES[m])) score += 2;
      trouves.push([score, e.m || e.d || '', e]);
    }
    trouves.sort((x, y) => y[0] - x[0] || y[1].localeCompare(x[1]));
    return { total: trouves.length, resultats: trouves.slice(0, o.limite || 30).map(x => x[2]) };
  }

  const lienSenat = e => (e && e.s ? `https://www.senat.fr/dossier-legislatif/${e.s}.html` : '');
  const lienAN = e => {
    if (!e || !e.a) return '';
    const i = e.a.indexOf('/');
    return `https://www.assemblee-nationale.fr/dyn/${e.a.slice(0, i)}/dossiers/${e.a.slice(i + 1)}`;
  };

  L.repertoire = { normaliser, preparer, chercher, lienSenat, lienAN };
})(globalThis.Formulaire = globalThis.Formulaire || {});
