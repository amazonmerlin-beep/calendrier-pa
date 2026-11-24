---
titre: Utiliser l’agenda
public: membre, admin
ordre: 10
resume: Consulter la semaine ou le mois, ajouter et modifier un événement, suivre un dossier législatif, importer une invitation.
---
## Consulter

L’agenda s’ouvre sur la semaine en cours. **Mois** affiche le mois entier ; un clic sur un jour revient à sa semaine. Les flèches changent de période, **Aujourd’hui** y revient.

Chaque couleur correspond à un agenda : séance publique, commission des lois, délégation aux entreprises, saisies de l’équipe, imports. Les boutons au-dessus de l’agenda masquent ou réaffichent un agenda.

Un clic sur un événement ouvre sa fiche : date, lieu, description, lien vers la fiche du Sénat, notes internes.

## Ajouter ou modifier un événement

- **Nouvel événement**, ou **Ajouter** dans la colonne d’un jour.
- Dans la fiche d’un événement : **Modifier** ou **Supprimer**.
- **Notes internes** : vos remarques (qui y va, quoi préparer). La synchronisation ne les touche jamais.
- **Interne : ne jamais diffuser** : l’événement n’apparaît dans aucun agenda extérieur abonné (voir « Diffusion »), quels que soient les choix de l’abonnement.

Les événements du Sénat arrivent seuls. Vous pouvez les corriger (le Sénat ne publie pas l’heure de fin, par exemple) : votre correction est gardée tant que le Sénat ne modifie pas l’événement.

## Synchronisation

L’agenda se met à jour à l’ouverture si la dernière lecture des flux date de plus de 30 minutes. **Synchroniser maintenant** relance la lecture. Un événement retiré par le Sénat disparaît ; s’il porte des notes, il reste, barré, avec le statut « Retiré de la source ».

## Suivre un dossier législatif

Onglet **Dossiers suivis** : collez le lien d’un dossier du Sénat (par exemple `https://www.senat.fr/dossier-legislatif/pjlf2027.html`) puis **Suivre ce dossier**.

La synchronisation lit la page du dossier, repère les numéros de ses textes et rattache au dossier toutes les réunions et séances du Sénat qui les citent, même dans un agenda que l’équipe ne suit pas. Le calendrier annoncé sur la page du dossier est affiché à côté. **Voir dans l’agenda** affiche seulement les événements du dossier.

Une réunion qui ne cite pas le numéro du texte n’est pas trouvée : rattachez-la à la main (champ **Dossier législatif** de l’événement).

Un dossier de l’Assemblée nationale (par exemple `https://www.assemblee-nationale.fr/dyn/17/dossiers/PLF_2027`) est lu par le **relais**, toutes les deux heures de 6 h à 22 h : il y retrouve toutes les réunions de commission et séances qui citent le dossier, avec leurs vraies heures de fin. Un dossier du Sénat dont la page renvoie vers l’Assemblée est suivi des deux côtés. La fiche du dossier indique le nombre de réunions, la dernière et la prochaine date.

## Importer une invitation Outlook ou Google

Onglet **Sources et imports**, **Choisir un fichier .ics** :

- invitation reçue par courriel : enregistrez la pièce jointe `invite.ics` ;
- Outlook (application) : faites glisser l’événement sur le bureau ;
- site qui propose « Ajouter à mon agenda » : choisissez iCal ou Outlook.

Vérifiez la liste, décochez ce qui ne doit pas entrer, puis **Importer**. Un événement déjà importé est mis à jour, sans doublon ; une annulation reçue par courriel le marque « Annulé ».

## S’abonner à un agenda Google ou Outlook (administration)

Onglet **Sources et imports**, **S’abonner à un agenda Google ou Outlook** : un nom, l’adresse iCal, une couleur.

- Google Agenda : paramètres de l’agenda, « Intégrer l’agenda », **adresse secrète au format iCal**.
- Outlook : paramètres du calendrier, « Calendriers partagés », **publier un calendrier**, lien ICS.

Prenez de préférence un agenda dédié à l’équipe : tout son contenu entre dans le Calendrier PA. L’adresse n’est lisible que par l’administration. Le relais lit l’agenda à son passage suivant, puis toutes les deux heures. Pour arrêter, décochez l’agenda dans **Agendas suivis**.

## Diffuser vers des agendas extérieurs (administration)

Onglet **Diffusion** : un abonnement publie une partie du Calendrier PA à une adresse secrète, que des personnes extérieures ajoutent à leur Google Agenda (« Autres agendas », +, « À partir de l’URL ») ou à Outlook (« Ajouter un calendrier », « S’abonner à partir du web »). Elles le voient en lecture seule.

Pour chaque abonnement, on choisit :

- les **agendas inclus** (séance publique, commission des lois, saisies de l’équipe…) et les **dossiers inclus** (tous leurs événements, quel que soit l’agenda) ;
- le **niveau de détail** : titres et horaires ; avec lieu, description et lien ; ou avec les notes internes de l’équipe ;
- la diffusion des événements annulés.

L’aperçu dit aussitôt combien d’événements partiraient. **Publier** demande confirmation ; le relais publie à son passage suivant (dans les deux heures) et l’adresse apparaît alors dans l’abonnement. Ensuite, chaque passage met l’agenda publié à jour ; Google peut mettre jusqu’à 24 h à afficher un changement. **Arrêter la publication** rend l’adresse inutilisable au passage suivant ; une nouvelle publication donne une nouvelle adresse.

Toute personne qui a l’adresse voit ce qui est diffusé : ne la donnez qu’aux personnes concernées, et marquez « Interne » ce qui ne doit jamais sortir.
