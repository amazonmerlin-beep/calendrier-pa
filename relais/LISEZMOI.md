# Relais GitHub du Calendrier PA

Le module Grist lit lui-même ce qu'un navigateur a le droit de lire : les flux iCal du Sénat et les pages de ses
dossiers législatifs. Il ne peut pas lire :

- l'**Assemblée nationale** (aucun de ses sites n'autorise la lecture depuis un navigateur) ;
- les agendas **Google** et **Outlook** (même chose).

Le relais est un script (`relais.mjs`, Node 20+, sans dépendance) lancé par **GitHub Actions** toutes les deux
heures (`.github/workflows/relais.yml`). Il dépose ce qu'il lit dans la table `Sources` du document
(`Contenu_relaye`) ; le module l'intègre ensuite comme n'importe quel flux. Le relais n'écrit jamais d'événement
lui-même : une seule logique de synchronisation, celle du module.

## Ce qu'il fait

1. **Assemblée nationale** : pour chaque dossier suivi dont le lien (ou le lien « autre assemblée » repéré sur la
   page du Sénat) pointe vers l'Assemblée, il lit l'identifiant du dossier sur sa page (`DLR5L17N…`), télécharge
   l'agenda en données ouvertes (`Agenda.json.zip`, environ 9 Mo, mis à jour chaque jour), retient les réunions
   et séances dont l'ordre du jour cite ce dossier, et les dépose en iCal dans la source « Assemblée nationale
   (dossiers suivis) ». Chaque réunion porte l'identifiant du dossier (`X-CALPA-DOSSIER`) : le module la rattache.
   Contrairement au Sénat, l'Assemblée publie l'heure de fin réelle.
2. **Agendas Google ou Outlook** : pour chaque source de type « Flux via relais », suivie, avec une adresse
   iCal, il télécharge l'agenda et le dépose tel quel. L'adresse n'apparaît jamais dans le journal.

## Installer (une fois)

1. **Compte robot** : créer un compte Grist dédié (par exemple `robot-agenda@…`), l'inviter sur le document, et
   l'inscrire dans la table `Annuaire` avec le rôle **admin** (il doit lire les adresses secrètes des agendas
   relayés et écrire `Contenu_relaye`). Ne pas utiliser la clé d'un compte personnel : une clé d'API Grist donne
   tous les droits du compte, sur tous ses documents.
2. **Clé d'API** du compte robot : profil Grist → « Clé API ».
3. **Dépôt GitHub** (privé de préférence) contenant ce dossier `calendrier-pa`, puis dans
   *Settings → Secrets and variables → Actions* :
   - secret `GRIST_API_KEY` : la clé du robot ;
   - variable `GRIST_URL` : `https://docs.getgrist.com` ;
   - secret `GRIST_DOC` : l'identifiant du document (*Paramètres du document* → identifiant) ; en secret pour
     qu'il soit masqué dans les journaux, publics si le dépôt l'est.
4. *Actions → Relais Calendrier PA → Run workflow* pour un premier passage ; ensuite, il tourne seul.

## Ajouter un agenda Google ou Outlook

Créer de préférence un **agenda dédié** (« À partager avec l'équipe ») : tout son contenu entre dans le calendrier.

- **Google Agenda** : Paramètres de l'agenda → « Intégrer l'agenda » → **Adresse secrète au format iCal**.
- **Outlook** : Paramètres → Calendrier → Calendriers partagés → **Publier un calendrier** → lien **ICS**.

Puis, en administration, ajouter une ligne dans `Sources` : Type « Flux via relais », Groupe « Agenda externe »,
Suivie cochée, l'adresse dans « Adresse du flux », une couleur. Cette adresse n'est lisible que par
l'administration (règles d'accès). Le module intègre l'agenda au passage suivant du relais.

## Essai local

```
AN_AGENDA_ZIP=/chemin/Agenda.json.zip node --test tests-e2e/relais.test.js
```

`RELAIS_SIMULATION=1` fait tourner le relais sans rien écrire.
