# Relais GitHub du Calendrier PA

Le module Grist lit lui-même ce qu'un navigateur a le droit de lire : les flux iCal du Sénat et les pages de ses
dossiers législatifs. Il ne peut pas lire :

- l'**Assemblée nationale** (aucun de ses sites n'autorise la lecture depuis un navigateur) ;
- les agendas **Google** et **Outlook** (même chose).

Le relais est un script (`relais.mjs`, Node 20+, sans dépendance) lancé par **GitHub Actions** toutes les deux
heures de 6 h à 22 h (`.github/workflows/relais.yml`). Il fait **toute la synchronisation**, même si personne n'ouvre
le document, avec le **même moteur** que le module (`module/src/moteur.js`, `sync.js`) : une seule logique, que la
synchronisation parte d'un navigateur ou du relais.

Appels à l'API Grist par passage : 4 lectures et 2 écritures (le verrou, puis un lot unique), une lecture de plus s'il
y a des abonnements ; une écriture de plus seulement quand un abonnement change, et une par jour pour le répertoire.
Soit environ 60 appels par jour.

## Ce qu'il fait

1. **Assemblée nationale** : pour chaque dossier suivi dont le lien (ou le lien « autre assemblée » repéré sur la
   page du Sénat) pointe vers l'Assemblée, il lit l'identifiant du dossier sur sa page (`DLR5L17N…`), télécharge
   l'agenda en données ouvertes (`Agenda.json.zip`, environ 9 Mo, mis à jour chaque jour), retient les réunions
   et séances dont l'ordre du jour cite ce dossier, et les dépose en iCal dans la source « Assemblée nationale
   (dossiers suivis) ». Chaque réunion porte l'identifiant du dossier (`X-CALPA-DOSSIER`) : le module la rattache.
   Contrairement au Sénat, l'Assemblée publie l'heure de fin réelle.
2. **Agendas Google ou Outlook** : pour chaque source de type « Flux via relais », suivie, avec une adresse
   iCal, il télécharge l'agenda et le dépose tel quel. L'adresse n'apparaît jamais dans le journal.
3. **Synchronisation** : flux du Sénat, pages des dossiers suivis, contenus relayés, comme depuis un navigateur.
4. **Répertoire des dossiers en cours** (premier passage du matin, ou *Run workflow* avec « Refaire aussi le
   répertoire ») : `relais/repertoire.mjs` croise l'open data du Sénat (`dossiers-legislatifs.csv`) et de
   l'Assemblée (`Dossiers_Legislatifs.json.zip`), ne garde que les dossiers **en cours** (exclus : promulgués,
   adoptés, caducs, retirés, rejetés, résolutions votées, anciennes législatures ; et ce qui n'est pas un dossier
   législatif : rapports, missions, commissions d'enquête), fusionne un dossier présent dans les deux assemblées, et
   publie le tout (≈ 3 000 dossiers) dans un gist ; son adresse est notée dans `Parametres` (`repertoire_url`). Le
   module y cherche sans quitter Grist. Ces données sont publiques.
5. **Abonnements de consultation** (onglet Diffusion, table `Abonnements`) : il sélectionne les événements choisis
   (même code que l'aperçu du module, `module/src/diffusion.js`), écrit l'agenda iCal et le publie dans un **gist
   secret** GitHub (non répertorié : seule l'adresse y donne accès), dont l'adresse est notée dans l'abonnement. Un
   abonnement arrêté voit son gist supprimé. Le dépôt et ses pages ne servent pas : public, il exposerait tout.

Le journal d'exécution (public si le dépôt l'est) ne contient ni nom, ni adresse, ni identifiant : des numéros et
des nombres seulement.

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
   - secret `GIST_TOKEN` (pour la diffusion) : un jeton GitHub **à grain fin** (*Settings → Developer settings →
     Fine-grained tokens*), sans accès aux dépôts, avec la seule permission de compte **Gists : lecture et
     écriture**, et une date d'expiration. Sans lui, les abonnements restent « à vérifier ».
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
