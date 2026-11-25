'use strict';
// Réglages du projet : le premier fichier à adapter. Le reste du kit les lit ici.
// Réglages propres à ce poste, hors dépôt (projet.local.json, ignoré par git) : adresses réelles, à ne pas publier.
const local = (() => { try { return require('./projet.local.json'); } catch (e) { return {}; } })();
module.exports = {
  nom: 'Calendrier PA',              // nom du document Grist
  urlId: 'calendrier-pa',            // adresse fixe : /o/docs/doc/<urlId>
  espace: 'Calendrier',              // espace de travail Grist
  titre: 'Calendrier PA',            // titre de la page et du module
  contactEmail: local.contactEmail || 'contact@example.org',
  // Rôles de l'annuaire. Membre : consulte et alimente l'agenda (événements, dossiers suivis, imports).
  // Administration : en plus, choisit les sources suivies et gère les comptes.
  roles: {
    membre: { libelle: 'Membre', entite: false },
    admin: { libelle: 'Administration', entite: false },
  },
  // Onglets du module par rôle : [identifiant de vue, libellé] ; le premier s'ouvre par défaut
  onglets: {
    membre: [['agenda', 'Agenda'], ['dossiers', 'Dossiers suivis'], ['sources', 'Sources et imports'], ['aide', 'Aide']],
    admin: [['agenda', 'Agenda'], ['dossiers', 'Dossiers suivis'], ['sources', 'Sources et imports'], ['diffusion', 'Diffusion'], ['comptes', 'Comptes'], ['aide', 'Aide']],
  },
  guidesEnFin: ['confidentialite'],
  // Veille : les événements ajoutés par les autres (ou par la synchronisation d'un autre poste) apparaissent
  // sans recharger la page.
  veille: {
    secondes: 30,
    tables: {
      inconnu: ['Connexions', 'Demandes'],
      membre: ['Evenements', 'Sources', 'Dossiers'],
      admin: ['Evenements', 'Sources', 'Dossiers', 'Demandes'],
    },
  },
  // Tables que le module lit (une table fermée par les règles est lue comme vide)
  tablesModule: ['Parametres', 'Connexions', 'Guides', 'Sources', 'Evenements', 'Dossiers', 'Abonnements', 'Annuaire', 'Demandes'],
  // Après une écriture dans une table, le module relit aussi celles dont les formules en dépendent
  dependances: { Evenements: ['Dossiers', 'Sources'], Dossiers: ['Evenements'] },
  // Comptes de test du Grist local : [adresse, nom, rôle, entité]
  comptesTest: [
    ['admin@projet.test', 'Admin projet', 'admin', ''],
    ['membre@projet.test', 'Membre', 'membre', ''],
    ['membre2@projet.test', 'Membre 2', 'membre', ''],
  ],
};
