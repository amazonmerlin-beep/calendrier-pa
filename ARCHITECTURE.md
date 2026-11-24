# Calendrier PA : architecture (version 0.1, maquette)

Agenda collaboratif dans Grist : l'équipe consulte la semaine ou le mois, ajoute et modifie ses événements, et
l'agenda se remplit seul avec l'activité du Sénat (séance publique, commission des lois, délégation aux
entreprises…), les dates des dossiers législatifs suivis (Sénat et Assemblée nationale) et des invitations
Google ou Outlook.

Construit avec la méthode et le kit du plugin `grist-builder` : document construit par script, une page et un
module (widget) dont le code est stocké dans le document, rôles tenus par un annuaire, règles d'accès, tests
dans un navigateur sur un Grist local.

## Vue d'ensemble

```
                    navigateur d'un membre (module Grist)                      GitHub Actions (toutes les 2 h)
 ┌────────────────────────────────────────────────────────────────┐    ┌──────────────────────────────────┐
 │ Agenda (semaine, mois) · Dossiers suivis · Sources et imports  │    │ relais/relais.mjs                │
 │                                                                │    │  · open data de l'Assemblée      │
 │ synchro.js : à l'ouverture si > 30 min, ou sur demande         │    │    (Agenda.json.zip, quotidien)  │
 │  · flux iCal du Sénat (CORS ouvert) ──────────► www.senat.fr   │    │  · agendas Google / Outlook      │
 │  · pages des dossiers du Sénat (CORS ouvert)                   │    │    (adresses iCal secrètes)      │
 │  · contenus déposés par le relais ◄──────────┐                 │    └───────────────┬──────────────────┘
 │  · fichiers .ics importés (invitations)      │                 │                    │ écrit Contenu_relaye
 │ sync.js : lecture iCal (ical.js), plan pur   │                 │                    ▼
 └──────────────┬───────────────────────────────┼─────────────────┘        ┌──────────────────────┐
                │ actions Grist, droits du membre                          │  Document Grist      │
                └───────────────────────────────┴────────────────────────► │  Sources, Dossiers,  │
                                                                           │  Evenements, …       │
                                                                           └──────────────────────┘
```

Une seule logique de synchronisation, dans le module : le relais ne fait que **déposer** ce qu'un navigateur
n'a pas le droit de lire. Tout ce qui est lisible depuis un navigateur se fait sans serveur.

## Les sources, et pourquoi elles passent par où elles passent

| Source | Lecture | Constat vérifié |
|---|---|---|
| Agenda du Sénat, par instance | Module, directement | `https://www.senat.fr/aglae/<instance>/ical.ics` répond avec `Access-Control-Allow-Origin: *`. Liste des instances : `https://www.senat.fr/api/v1/agenda/instances/ics`. Flux glissant (à partir du jour même) ; heures « flottantes » à lire à Paris ; **heure de fin non publiée** (toujours début + 2 h) ; horaire réel de la séance dans `X-AGLAE-STARTTYPE` (« À 14 h 30, le soir et la nuit »). L'identifiant `Aglaé-<n>@senat.fr` donne la fiche `agenda.senat.fr/<a>/<m>/<j>/event/<n>` |
| Dossiers législatifs du Sénat | Module, directement | Pages en CORS ouvert. Le module y lit le titre, les numéros des textes et rapports (« n° 155 (2026-2027) », liens `/leg/pjl26-155`, `/rap/l26-156`), le calendrier annoncé (« discussion en séance publique les … ») et le lien du dossier à l'Assemblée. Les réunions et séances sont retrouvées dans **tous** les flux du Sénat par ces numéros, même dans un agenda que l'équipe ne suit pas |
| Assemblée nationale | Relais GitHub | Aucun site de l'Assemblée n'autorise la lecture depuis un navigateur (pas d'en-tête CORS). L'open data quotidien `Agenda.json.zip` (≈ 8 500 réunions, 9 Mo) relie chaque point d'ordre du jour à son dossier (`dossiersLegislatifsRefs`) et donne les **heures de fin réelles**, le lieu et l'état (confirmé, annulé). L'identifiant du dossier (`DLR5L17N…`) se lit sur sa page |
| Google Agenda, Outlook | Relais GitHub, ou import de fichier | Leurs adresses iCal ne sont pas lisibles depuis un navigateur. Abonnement : adresse secrète iCal (Google) ou calendrier publié (Outlook), relayée. Ponctuel : import d'un `.ics` (pièce jointe d'invitation, glisser-déposer Outlook, bouton « Ajouter à mon agenda » d'un site) |
| API JSON de l'agenda du Sénat | Non utilisée | `www.senat.fr/api/v1/agenda/events` est plus riche (délais limites d'amendements, liens), mais réservée à `agenda.senat.fr` (CORS fermé) et non documentée : piste pour le relais (v2) |

## Données

| Table | Rôle |
|---|---|
| `Evenements` | Titre, début, fin, journée entière, lieu, description, lien, **notes internes** (jamais touchées par la synchronisation), statut (annulé, retiré de la source), source, dossier, `UID` (identifiant iCal : pas de doublon), `Empreinte` (état de la source à la dernière lecture), créé et modifié par / le (déclencheurs `user.Email`) |
| `Sources` | 25 instances du Sénat, la source « Assemblée nationale (dossiers suivis) », les imports, la saisie ; suivie ou non, couleur, résultat et verrou de la synchronisation, contenu relayé |
| `Dossiers` | Lien collé, assemblée (calculée), titre, état du suivi, textes repérés, calendrier annoncé, lien vers l'autre assemblée, prochaine date et nombre d'événements (calculés) |
| `Parametres`, `Annuaire`, `Connexions`, `Guides` | Socle du kit : réglages, comptes et rôles, identité dans le module, onglet Aide |

## Règles de synchronisation (`module/src/sync.js`, fonctions pures testées)

- **Idempotente** : un événement est reconnu par son `UID` ; relancer ne crée jamais de doublon. Deux postes qui
  synchronisent en même temps : verrou de 3 minutes par source, et les doublons éventuels sont nettoyés.
- **Les retouches de l'équipe sont gardées** tant que la source ne change pas l'événement (comparaison
  d'empreinte) : on peut corriger l'heure de fin d'une réunion du Sénat. Si la source change, elle fait foi sur
  ses champs ; les notes internes ne sont jamais écrites.
- **Retraits prudents** : un événement à venir qui disparaît du flux est supprimé, ou marqué « Retiré de la
  source » s'il porte des notes ; jamais le passé, jamais au-delà du dernier événement du flux, jamais sur un
  flux vide (une panne côté source ne vide pas l'agenda).
- **Fuseaux** : heures flottantes lues à Paris ; fuseaux IANA et Windows (Outlook), blocs `VTIMEZONE`,
  récurrences avec exceptions (ical.js) ; journées entières stockées du premier jour 00:00 au dernier 23:59.
- Une annulation reçue (`STATUS:CANCELLED`, `METHOD:CANCEL`) marque l'événement « Annulé », barré.

## Droits et sécurité

- **Rôles** dans l'`Annuaire` : *membre* (consulte, crée, modifie, suit des dossiers, importe) et
  *admin* (en plus : choisit les agendas suivis, gère les comptes). Une adresse absente de l'annuaire ne voit
  rien (écran « compte non reconnu »). Les propriétaires du document (deux ou trois personnes) passent outre.
- **Règles d'accès** (`schema/acces.js`, 47 règles) : chacun crée en son nom (`newRec.Cree_par == user.Email`,
  sauf la synchronisation pour un événement venu d'une source), statuts bornés, colonnes système en lecture
  seule, sources modifiables par l'administration seulement, **adresses secrètes des agendas relayés lisibles par
  l'administration seulement**. Personne d'autre que les propriétaires ne modifie la structure ni le module.
- La synchronisation tourne dans le navigateur des membres, **avec leurs droits** : aucune clé côté navigateur.
- `ical.js` 2.1.0 chargé depuis jsDelivr, **empreinte SHA-256 vérifiée avant exécution** ; liens limités à
  `http(s)` (un `javascript:` venu d'un fichier est écarté) ; tout texte échappé avant affichage.
- Relais : compte Grist **robot** dédié (rôle admin), clé en secret GitHub, action épinglée par empreinte de
  commit, adresses secrètes jamais écrites dans le journal.

## Vérifié

| Contrôle | Résultat |
|---|---|
| Tests unitaires (`npm test`) : moteur de synchronisation sur les vrais flux du Sénat, invitation Outlook récurrente (fuseau Windows, date exclue, occurrence déplacée), export Google, annulation, page de dossier, plan de synchronisation ; règles d'accès (relecture) ; kit | 46 réussis, 1 sans objet |
| Parcours dans le navigateur sur Grist local (`npm run test:parcours`) : synchronisation réelle, semaine, mois, fiche, création, dossier suivi, lien refusé, import Outlook, droits (membre, inconnu, usurpation d'auteur) | 8 sur 8 |
| Relais (`npm run test:relais`) : dossier de l'Assemblée suivi, réunions relayées, intégrées et rattachées avec leurs heures réelles | réussi |
| Accessibilité (`npm run test:rgaa`, axe-core) et zoom à 200 % (`npm run test:zoom`) | 0 violation, 0 débordement |
| Livraison (`npm run livrer`) : `.grist` réimporté et contrôlé | réussi |

## Limites connues et suite

1. **Heure de fin** des réunions du Sénat : non publiée ; affichée 2 h, mention dans la fiche, corrigeable.
2. **Rapprochement des dossiers du Sénat par numéro de texte** : une réunion qui ne cite pas le numéro (« PLF pour
   2027 – Examen des amendements ») n'est pas rattachée seule ; rattachement à la main dans la fiche. Piste :
   l'API JSON du Sénat, par le relais.
3. **Délais limites de dépôt des amendements** : publiés par l'API JSON du Sénat (fermée au navigateur) : à
   ajouter au relais.
4. **Noms des commissions de l'Assemblée** : le relais écrit « Commission (AN) – objet » ; la correspondance
   `organeReuniRef` → nom passe par l'open data des organes (à ajouter).
5. **Synchronisation à l'ouverture** : sans visite, l'agenda du Sénat n'est pas relu (le relais, lui, tourne
   seul). Piste : faire aussi lire le Sénat par le relais si l'équipe veut un agenda à jour sans visite.
6. **Abonnement sortant** (voir le Calendrier PA dans son Google ou son Outlook) : un flux iCal publié par le
   relais (GitHub Pages ou dépôt privé) ; à cadrer (confidentialité des notes).

## Fichiers

| Où | Quoi |
|---|---|
| `projet.config.js`, `schema/` | Réglages, modèle, sources de départ, règles d'accès |
| `module/src/` | Module : socle du kit (`core`, `app`, `fiche`, `markdown`, `vue-aide`, `ui.css`) + `sync.js` (moteur), `synchro.js` (orchestration), `vue-agenda.js`, `vue-dossiers.js`, `vue-sources.js`, `agenda.css` |
| `relais/` | Relais GitHub (`relais.mjs`, `LISEZMOI.md`) ; `.github/workflows/relais.yml` |
| `guides/` | Onglet Aide |
| `tests/fixtures/` | Flux réels du Sénat, invitation Outlook, export Google, page de dossier |
| `tests-e2e/` | Parcours, relais, accessibilité, zoom, captures |

Commandes : `npm ci`, `npm run grist:demarrer` (Docker), `npm run construire`, `npm run deployer`, puis les
tests ci-dessus ; `npm run livrer` pour le `.grist`.
