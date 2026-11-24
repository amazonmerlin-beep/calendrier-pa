'use strict';
// Modèle du document. Socle du kit, à garder : Parametres, Annuaire, Connexions, Guides.
// Projet : Sources (flux et origines des événements), Dossiers (dossiers législatifs suivis), Evenements.
// Colonne : { id, type, label, formule?, declencheur? ('ajout' | 'modif' | [colonnes]), options?, description? }
const { roles, titre, contactEmail } = require('../projet.config');
const SOURCES = require('./sources.json');

const ROLES = Object.keys(roles);
const TZ = 'DateTime:Europe/Paris';
const DATETIME = { dateFormat: 'DD/MM/YYYY', isCustomDateFormat: true, timeFormat: 'HH:mm', isCustomTimeFormat: true };
const DATETIME_JOUR = { dateFormat: 'ddd DD/MM/YYYY', isCustomDateFormat: true, timeFormat: 'HH:mm', isCustomTimeFormat: true };

const TYPES_SOURCE = ['Flux iCal', 'Flux via relais', 'Import de fichier', 'Saisie manuelle'];
const GROUPES = ['Sénat – Séance publique', 'Sénat – Commissions', 'Sénat – Délégations', 'Sénat – Structures temporaires',
  'Sénat – Autres', 'Assemblée nationale', 'Agenda externe', 'Interne'];
const STATUTS_EVT = ['Annulé', 'Retiré de la source'];
const ETATS_DOSSIER = ['À analyser', 'Suivi actif', 'En attente du relais', 'Erreur'];
const SYNC_AUTEUR = 'Synchronisation automatique';

const TABLES = [
  {
    id: 'Parametres',
    colonnes: [
      { id: 'Cle', type: 'Text', label: 'Clé' },
      { id: 'Valeur', type: 'Text', label: 'Valeur', options: { wrap: true } },
      { id: 'Libelle', type: 'Text', label: 'À quoi ça sert', options: { wrap: true } },
    ],
  },
  {
    id: 'Annuaire',
    colonnes: [
      // Grist compare user.Email en minuscules : l'adresse est ramenée en minuscules à la saisie
      { id: 'Email', type: 'Text', label: 'Adresse', formule: 'value.strip().lower() if value else value', declencheur: ['Email'] },
      { id: 'Nom', type: 'Text', label: 'Nom' },
      { id: 'Role', type: 'Choice', label: 'Rôle', options: { choices: ROLES } },
      { id: 'Actif', type: 'Bool', label: 'Actif', options: { widget: 'Switch' } },
      // Lu par les règles d'accès. Aucune formule de l'annuaire ne doit dépendre de Connexions.
      { id: 'Role_effectif', type: 'Text', label: 'Rôle effectif', formule: '$Role if $Actif and $Email else ""' },
    ],
  },
  {
    // Identité dans le widget : le module ajoute une ligne à l'ouverture, Grist y inscrit user.Email
    id: 'Connexions',
    colonnes: [
      { id: 'Email', type: 'Text', label: 'Adresse', formule: 'user.Email', declencheur: 'ajout' },
      { id: 'Nom', type: 'Text', label: 'Nom', formule: 'user.Name', declencheur: 'ajout' },
      { id: 'Le', type: TZ, label: 'Le', formule: 'NOW()', declencheur: 'ajout', options: DATETIME },
      { id: 'Version', type: 'Text', label: 'Version du module' },
      { id: 'Compte', type: 'Ref:Annuaire', label: 'Compte', formule: 'Annuaire.lookupOne(Email=$Email) if $Email else None' },
      { id: 'Role', type: 'Text', label: 'Rôle', formule: '$Compte.Role_effectif if $Compte else ""' },
      { id: 'Entite', type: 'Text', label: 'Entité', formule: '""' },
      { id: 'Connu', type: 'Bool', label: 'Compte reconnu', formule: 'bool($Compte and $Compte.Role_effectif)' },
    ],
  },
  {
    // D'où viennent les événements : flux iCal (Sénat), flux relayés (Google, Outlook, Assemblée nationale),
    // imports de fichiers .ics, saisie dans l'agenda.
    id: 'Sources',
    colonnes: [
      { id: 'Nom', type: 'Text', label: 'Nom' },
      { id: 'Groupe', type: 'Choice', label: 'Groupe', options: { choices: GROUPES } },
      { id: 'Type', type: 'Choice', label: 'Type', options: { choices: TYPES_SOURCE } },
      { id: 'Active', type: 'Bool', label: 'Suivie', options: { widget: 'Switch' },
        description: 'Flux iCal : ses événements sont importés à chaque synchronisation.' },
      { id: 'URL', type: 'Text', label: 'Adresse du flux', options: { widget: 'HyperLink' } },
      { id: 'Couleur', type: 'Text', label: 'Couleur', description: 'Couleur des événements dans l’agenda (#RRGGBB, texte blanc lisible).' },
      { id: 'Derniere_synchro', type: TZ, label: 'Dernière synchronisation', options: DATETIME },
      { id: 'Resultat_synchro', type: 'Text', label: 'Résultat', options: { wrap: true } },
      { id: 'Synchro_en_cours', type: TZ, label: 'Synchronisation en cours depuis', options: DATETIME,
        description: 'Verrou posé pendant une synchronisation, pour que deux postes ne synchronisent pas en même temps. Libéré seul après 3 minutes.' },
      { id: 'Contenu_relaye', type: 'Text', label: 'Contenu relayé', description: 'Flux via relais : dernier contenu iCal déposé par le relais GitHub.' },
      { id: 'Relaye_le', type: TZ, label: 'Relayé le', options: DATETIME },
      { id: 'Nb_evenements', type: 'Int', label: 'Événements', formule: 'len(Evenements.lookupRecords(Source=$id))', tard: true },
    ],
  },
  {
    // Dossiers législatifs suivis : on colle le lien, la synchronisation trouve les dates.
    id: 'Dossiers',
    colonnes: [
      { id: 'Lien', type: 'Text', label: 'Lien du dossier', options: { widget: 'HyperLink' } },
      { id: 'Assemblee', type: 'Choice', label: 'Assemblée', options: { choices: ['Sénat', 'Assemblée nationale', 'Inconnue'] },
        formule: '"Sénat" if "senat.fr/" in ($Lien or "") else ("Assemblée nationale" if "assemblee-nationale.fr/" in ($Lien or "") else "Inconnue")' },
      { id: 'Titre', type: 'Text', label: 'Titre', options: { wrap: true } },
      { id: 'Etat', type: 'Choice', label: 'État du suivi', options: { choices: ETATS_DOSSIER } },
      { id: 'Numeros', type: 'Text', label: 'Textes repérés', options: { wrap: true },
        description: 'Numéros des textes et rapports du dossier, cherchés dans l’agenda (ex. « 155 (2026-2027) »).' },
      { id: 'Calendrier_annonce', type: 'Text', label: 'Calendrier annoncé', options: { wrap: true } },
      { id: 'Lien_autre', type: 'Text', label: 'Dossier dans l’autre assemblée', options: { widget: 'HyperLink' } },
      { id: 'Derniere_verif', type: TZ, label: 'Dernière vérification', options: DATETIME },
      { id: 'Resultat', type: 'Text', label: 'Résultat', options: { wrap: true } },
      { id: 'Notes', type: 'Text', label: 'Notes', options: { wrap: true } },
      { id: 'Ajoute_par', type: 'Text', label: 'Ajouté par', formule: 'user.Email', declencheur: 'ajout' },
      { id: 'Ajoute_le', type: TZ, label: 'Ajouté le', formule: 'NOW()', declencheur: 'ajout', options: DATETIME },
      { id: 'Nb_evenements', type: 'Int', label: 'Événements liés', formule: 'len(Evenements.lookupRecords(Dossier=$id))', tard: true },
      { id: 'Prochaine_date', type: TZ, label: 'Prochaine date', options: DATETIME, tard: true,
        formule: 'dates = [e.Debut for e in Evenements.lookupRecords(Dossier=$id) if e.Debut and e.Debut >= NOW() and not e.Statut]\nreturn min(dates) if dates else None' },
    ],
  },
  {
    id: 'Evenements',
    colonnes: [
      { id: 'Titre', type: 'Text', label: 'Titre', options: { wrap: true } },
      { id: 'Debut', type: TZ, label: 'Début', options: DATETIME_JOUR },
      { id: 'Fin', type: TZ, label: 'Fin', options: DATETIME_JOUR },
      { id: 'Journee_entiere', type: 'Bool', label: 'Journée entière', options: { widget: 'Switch' } },
      { id: 'Lieu', type: 'Text', label: 'Lieu', options: { wrap: true } },
      { id: 'Description', type: 'Text', label: 'Description', options: { wrap: true } },
      { id: 'Lien', type: 'Text', label: 'Lien', options: { widget: 'HyperLink' } },
      { id: 'Notes', type: 'Text', label: 'Notes internes', options: { wrap: true },
        description: 'Jamais modifiées par la synchronisation.' },
      { id: 'Statut', type: 'Choice', label: 'Statut', options: { choices: STATUTS_EVT },
        description: 'Vide : événement normal. « Retiré de la source » : disparu du flux d’origine alors qu’il porte des notes.' },
      // Origine par défaut : saisie dans l'agenda (la synchronisation et l'import fournissent la leur)
      { id: 'Source', type: 'Ref:Sources', label: 'Source', formule: 'Sources.lookupOne(Type="Saisie manuelle")', declencheur: 'ajout' },
      { id: 'Dossier', type: 'Ref:Dossiers', label: 'Dossier législatif' },
      { id: 'UID', type: 'Text', label: 'Identifiant externe',
        description: 'Identifiant de l’événement dans sa source (UID iCal) : évite les doublons.' },
      { id: 'Empreinte', type: 'Text', label: 'Empreinte de la source',
        description: 'Tant que la source ne change pas, les retouches faites dans l’agenda sont gardées.' },
      { id: 'Cree_par', type: 'Text', label: 'Créé par', formule: 'user.Email', declencheur: 'ajout' },
      { id: 'Cree_le', type: TZ, label: 'Créé le', formule: 'NOW()', declencheur: 'ajout', options: DATETIME },
      { id: 'Modifie_par', type: 'Text', label: 'Modifié par', formule: 'user.Email', declencheur: 'modif' },
      { id: 'Modifie_le', type: TZ, label: 'Modifié le', formule: 'NOW()', declencheur: 'modif', options: DATETIME },
    ],
  },
  {
    // Guides de l'onglet Aide : chaque rôle ne lit que ceux de son public (règles d'accès)
    id: 'Guides',
    colonnes: [
      { id: 'Cle', type: 'Text', label: 'Clé' },
      { id: 'Titre', type: 'Text', label: 'Titre' },
      { id: 'Public', type: 'ChoiceList', label: 'Public', options: { choices: [...ROLES, 'inconnu'] } },
      { id: 'Ordre', type: 'Numeric', label: 'Ordre' },
      { id: 'Resume', type: 'Text', label: 'En une phrase', options: { wrap: true } },
      { id: 'Contenu', type: 'Text', label: 'Contenu (Markdown)', options: { wrap: true } },
      { id: 'Images', type: 'Attachments', label: 'Captures' },
      { id: 'Modifie_le', type: TZ, label: 'Modifié le', formule: 'NOW()', declencheur: 'modif', options: DATETIME },
    ],
  },
];

const PARAMETRES = [
  ['titre', titre, 'Titre affiché en haut du module'],
  ['sous_titre', 'Agenda collaboratif', 'Ligne au-dessus du titre'],
  ['contact_nom', 'L’équipe', 'Nom du contact affiché aux comptes non reconnus'],
  ['contact_email', contactEmail, 'Adresse de contact affichée aux comptes non reconnus'],
  ['synchro_minutes', '30', 'Délai (minutes) au-delà duquel l’ouverture de l’agenda relance la synchronisation des flux'],
];

// Données de base, posées à la construction (avant les déclencheurs)
const DONNEES = { Sources: SOURCES };

module.exports = { TABLES, PARAMETRES, DONNEES, ROLES, TYPES_SOURCE, STATUTS_EVT, ETATS_DOSSIER, SYNC_AUTEUR };
