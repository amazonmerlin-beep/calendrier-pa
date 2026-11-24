'use strict';
// Règles d'accès. Pour chaque permission, la première règle qui s'applique décide : l'ordre compte.
// user.Moi = la ligne de l'annuaire dont l'adresse est user.Email (attribut posé sur la table par défaut).
// Un rôle vide (compte inconnu ou désactivé) ne voit rien, sauf Parametres, ses connexions et les guides « inconnu ».
// Une création se contrôle par la règle de TABLE (newRec) : les règles de colonne ne décident que R et U.
// La synchronisation s'exécute dans le navigateur des membres : elle écrit avec leurs droits. Les membres
// peuvent donc créer et modifier les événements et noter le résultat d'une synchronisation, mais pas
// changer les sources suivies (administration).
const PROPRIO = 'user.Access in [OWNER]';
const ROLE = 'user.Moi.Role_effectif';
const CONNU = `${ROLE} in ["membre", "admin"]`;
const ADMIN = `${ROLE} == "admin"`;
const { SYNC_AUTEUR, STATUTS_EVT, ETATS_DOSSIER } = require('./modele');
const ATTRIBUT_MOI = { name: 'Moi', tableId: 'Annuaire', lookupColId: 'Email', charId: 'Email' };

function jeux() {
  return [
    {
      table: '*', colonnes: '*', attribut: ATTRIBUT_MOI,
      regles: [
        [PROPRIO, '+CRUDS', 'Propriétaires : tout'],
        ['', '-CRUDS', 'Tous les autres : rien par défaut (chaque table ouvre ce qu’il faut)'],
      ],
    },
    {
      table: 'Parametres', colonnes: '*',
      regles: [
        [PROPRIO, '+CRUD'],
        [ADMIN, '+CRUD', 'Admin : paramètres'],
        ['', '+R-CUD', 'Tous, même inconnus : lecture (le widget est rattaché à cette table)'],
      ],
    },
    {
      table: 'Annuaire', colonnes: '*',
      regles: [
        [PROPRIO, '+CRUD'],
        [ADMIN, '+CRUD', 'Admin : gère les comptes'],
        ['', '-CRUD'],
      ],
    },
    {
      table: 'Connexions', colonnes: '*',
      regles: [
        [PROPRIO, '+CRUD'],
        ['newRec.Nom != user.Name', '-C', 'Le nom vient de la session, pas de la saisie'],
        [ADMIN, '+R-UD', 'Admin : lit toutes les connexions'],
        ['rec.Email == user.Email', '+CR-UD', 'Chacun crée et lit ses propres connexions (identité du module)'],
        ['', '-CRUD'],
      ],
    },
    // Sources : l'adresse d'un flux relayé (agenda Google ou Outlook) est secrète ; seule l'administration la lit.
    {
      table: 'Sources', colonnes: 'URL',
      regles: [
        [PROPRIO, '+RU'],
        [ADMIN, '+RU'],
        ['rec.Type == "Flux via relais"', '-RU', 'Adresse secrète d’un agenda relayé : administration seulement'],
        [CONNU, '+R-U', 'Membres : lisent l’adresse des flux publics (la synchronisation la lit)'],
        ['', '-RU'],
      ],
    },
    {
      table: 'Sources', colonnes: 'Derniere_synchro,Resultat_synchro,Synchro_en_cours',
      regles: [
        [PROPRIO, '+RU'],
        [CONNU, '+RU', 'Membres : la synchronisation, lancée depuis leur poste, note son résultat'],
        ['', '-RU'],
      ],
    },
    {
      table: 'Sources', colonnes: '*',
      regles: [
        [PROPRIO, '+CRUD'],
        [ADMIN, '+CRUD', 'Admin : choisit les sources suivies'],
        [CONNU, '+R-CUD', 'Membres : lecture'],
        ['', '-CRUD'],
      ],
    },
    {
      table: 'Dossiers', colonnes: 'Ajoute_par,Ajoute_le',
      regles: [[PROPRIO, '+RU'], ['', '-U', 'Colonnes système : jamais modifiées à la main']],
    },
    {
      table: 'Dossiers', colonnes: '*',
      regles: [
        [PROPRIO, '+CRUD'],
        [`${CONNU} and newRec.Etat not in [None, "", ${ETATS_DOSSIER.map(x => `"${x}"`).join(', ')}]`, '-CU', 'État : valeurs de la liste seulement'],
        [`${CONNU} and newRec.Ajoute_par == user.Email`, '+C', 'Membres : ajoutent un dossier en leur nom'],
        [CONNU, '+RUD', 'Membres : suivent, analysent et retirent des dossiers'],
        ['', '-CRUD'],
      ],
    },
    {
      table: 'Evenements', colonnes: 'Cree_par,Cree_le',
      regles: [[PROPRIO, '+RU'], ['', '-U', 'Colonnes système : jamais modifiées à la main']],
    },
    {
      table: 'Evenements', colonnes: 'Modifie_par',
      regles: [
        [PROPRIO, '+RU'],
        [`newRec.Modifie_par != user.Email and newRec.Modifie_par != "${SYNC_AUTEUR}"`, '-U', 'Auteur d’une modification : le compte connecté, ou la synchronisation'],
      ],
    },
    {
      table: 'Evenements', colonnes: '*',
      regles: [
        [PROPRIO, '+CRUD'],
        [`${CONNU} and newRec.Statut not in [None, "", ${STATUTS_EVT.map(x => `"${x}"`).join(', ')}]`, '-CU', 'Statut : valeurs de la liste seulement'],
        [`${CONNU} and (newRec.Cree_par == user.Email or (newRec.Cree_par == "${SYNC_AUTEUR}" and newRec.UID))`, '+C',
          'Membres : créent un événement en leur nom ; la synchronisation, un événement venu d’une source'],
        [CONNU, '+RUD', 'Membres : alimentent l’agenda'],
        ['', '-CRUD'],
      ],
    },
    {
      table: 'Guides', colonnes: '*',
      regles: [
        [PROPRIO, '+CRUD'],
        [ADMIN, '+CRUD', 'Admin : lit et modifie tous les guides'],
        [`${CONNU} and ${ROLE} in rec.Public`, '+R-CUD', 'Chaque rôle lit les guides de son public'],
        [`not (${CONNU}) and "inconnu" in rec.Public`, '+R-CUD', 'Comptes non reconnus : guide « obtenir un accès »'],
        ['', '-CRUD'],
      ],
    },
  ];
}

/**
 * Remplace toutes les règles du document par celles de jeux().
 * Deux lots : les ressources (tables × colonnes), puis les règles qui s'y rattachent.
 */
async function appliquerRegles(g, docId) {
  const js = jeux();
  const anciennes = await g.sql(docId, 'select id from _grist_ACLRules');
  const anciennesRes = await g.sql(docId, 'select id from _grist_ACLResources');
  const nettoyage = [];
  if (anciennes.length) nettoyage.push(['BulkRemoveRecord', '_grist_ACLRules', anciennes.map(r => r.id)]);
  if (anciennesRes.length) nettoyage.push(['BulkRemoveRecord', '_grist_ACLResources', anciennesRes.map(r => r.id)]);
  if (nettoyage.length) await g.appliquer(docId, nettoyage);

  const r = await g.appliquer(docId, [['BulkAddRecord', '_grist_ACLResources', js.map(() => null), {
    tableId: js.map(j => j.table), colIds: js.map(j => j.colonnes),
  }]]);
  const idsRes = r.retValues[0];
  const regles = { resource: [], aclFormula: [], permissionsText: [], rulePos: [], memo: [], userAttributes: [] };
  let pos = 0;
  js.forEach((j, i) => {
    if (j.attribut) {
      regles.resource.push(idsRes[i]); regles.aclFormula.push(''); regles.permissionsText.push('');
      regles.rulePos.push(++pos); regles.memo.push(''); regles.userAttributes.push(JSON.stringify(j.attribut));
    }
    for (const [formule, perms, memo] of j.regles) {
      regles.resource.push(idsRes[i]); regles.aclFormula.push(formule); regles.permissionsText.push(perms);
      regles.rulePos.push(++pos); regles.memo.push(memo || ''); regles.userAttributes.push('');
    }
  });
  await g.appliquer(docId, [['BulkAddRecord', '_grist_ACLRules', regles.resource.map(() => null), regles]]);
  // Contrôle : le moteur doit avoir compilé chaque formule
  const ko = await g.sql(docId, "select id, aclFormula from _grist_ACLRules where aclFormula != '' and (aclFormulaParsed is null or aclFormulaParsed = '')");
  if (ko.length) throw new Error('Règles non compilées : ' + JSON.stringify(ko));
  return { ressources: idsRes.length, regles: regles.resource.length };
}

module.exports = { jeux, appliquerRegles, ATTRIBUT_MOI };
