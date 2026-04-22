// lib/responsePolicies.js
// Messages de reponse predefinie par categorie.
// Le wording est aligne sur le ton Psee : sobre, direct, respectueux,
// non therapeutique.

export const POLICIES = {

  critical:
    "Ce que vous partagez depasse le cadre de ce check-up.\n\n" +
    "Si vous traversez une detresse importante, le 3114 est disponible 24h/24, gratuit et confidentiel.\n\n" +
    "Le check-up Psee n'est pas adapte a votre situation en ce moment.",

  out_of_scope:
    "Je ne suis pas en mesure de repondre a ca — c'est le role d'un professionnel de sante.\n\n" +
    "Ce check-up peut vous aider a y voir plus clair sur votre fonctionnement psychique, " +
    "mais pas a poser un diagnostic ni a proposer un traitement.\n\n" +
    "Souhaitez-vous poursuivre sur votre vecu ?",

  abusive:
    "Je ne peux pas poursuivre dans ce ton.\n\n" +
    "Si vous souhaitez continuer le check-up, reformulez ce que vous vouliez exprimer.",

  empty:
    "Je n'ai pas assez d'elements pour continuer. Pouvez-vous reformuler, " +
    "ou preciser ce que vous vouliez dire ?",

  // Quand la reponse du modele est filtree par le filtre de sortie
  output_filtered:
    "Je reformule : pouvez-vous me decrire concretement comment vous vous sentez en ce moment, " +
    "et depuis quand ?",

  // Erreur technique
  fallback:
    "Une difficulte technique est survenue. Reprenons dans un instant."
};
