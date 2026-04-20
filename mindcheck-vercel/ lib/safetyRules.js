// lib/safetyRules.js
// Classification des messages entrants et filtrage des sorties du modele.
//
// Principe : on detecte par patterns lexicaux + contexte. C'est une premiere
// ligne, pas une garantie. Combinee au prompt systeme server-side et au
// filtrage de sortie, elle couvre la grande majorite des cas a risque.
//
// 5 categories :
//   normal        -> on envoie au modele
//   sensible      -> on envoie, mais on logue (suivi)
//   critique      -> on n'envoie PAS, on repond avec le protocole crise
//   hors_perimetre-> on n'envoie PAS, on recadre
//   abusif        -> on n'envoie PAS, on pose une limite
//   vide          -> on demande a reformuler

// ---------- Patterns critiques (priorite absolue) ----------
// Suicide, homicide, automutilation, violence actuelle, urgence psy.
// Ces patterns supportent les accents français — on matche avec "u" flag
// et on accepte les variantes avec/sans accents.
const CRITICAL_PATTERNS = [
  // Suicide explicite — "je veux me tuer / mourir / en finir / me suicider"
  /\bje\s+(vais|veux|voudrais|pense\s+[aà])\s+(me\s+)?(tuer|suicider|mourir|en\s+finir)\b/i,
  // Variantes "j'ai envie de" / "j'ai pense a en finir" / "je pense a mourir"
  /\bj'?(ai|aurais)?\s*envie\s+de\s+(mourir|en\s+finir|me\s+tuer)\b/i,
  /\bje\s+pense\s+[aà]\s+(en\s+finir|mourir|me\s+tuer|me\s+suicider)\b/i,
  /\b(plus\s+envie\s+de\s+vivre|(ne\s+)?vaut\s+plus\s+la\s+peine\s+de\s+vivre)\b/i,
  /\bmettre\s+fin\s+[aà]\s+(mes|ma)\s+(jours?|vie)\b/i,
  /\bpassage\s+[aà]\s+l'?acte\b/i,

  // Automutilation / scarification
  /\b(me\s+)?(faire\s+du\s+mal|automutil|scarifi|me\s+blesser|me\s+taillader|me\s+couper)\b/i,

  // Homicide / violence exercee
  /\bje\s+(vais|veux|voudrais)\s+(le|la|les|lui|leur|te|vous)\s+(tuer|frapper|detruire|massacrer|buter)\b/i,
  /\b(tuer|buter|massacrer)\s+(mon|ma|mes)\s+(pere|mere|parent|enfant|conjoint|mari|femme)\b/i,

  // Violence subie actuelle
  /\b(il|elle|mon\s+pere|ma\s+mere|mon\s+mari|ma\s+femme|mon\s+conjoint)\s+me\s+(bat|frappe|tape|viole|agresse)\b/i,
  /\bje\s+suis\s+(battu|frappe|violee?|agressee?)\b/i,

  // Detresse aigue
  /\bj'?en\s+peux\s+plus\b.{0,40}\b(vivre|continuer|tenir)\b/i,
  /\b(je\s+craque|je\s+peux\s+plus\s+rien\s+faire)\b.{0,80}\b(mort|fin|en\s+finir)\b/i,
];

// ---------- Patterns hors perimetre ----------
// Demandes de diagnostic, de prescription, d'orientation medicale precise.
const OUT_OF_SCOPE_PATTERNS = [
  /\b(suis[\-\s]?je|est[\-\s]?ce\s+que\s+je\s+suis)\s+(bipolaire|depressif|depressive|schizo|borderline|narcissique|autiste|tdah)\b/i,
  /\b(j'?ai|est[\-\s]?ce\s+que\s+j'?ai)\s+(un|une)\s+(depression|burn[\-\s]?out|tdah|toc|bipolarite|psychose)\b/i,
  /\bquel\s+(medicament|médicament|traitement|antidepresseur|antidépresseur|anxiolytique|neuroleptique)\s+(prendre|me\s+conseill|dois[\-\s]?je|est[\-\s]?ce\s+que)/i,
  /\b(prescri|conseill)[a-z]*\s+(moi\s+)?(un|une|des)\s+(medicament|traitement)\b/i,
  /\bdois[\-\s]?je\s+(prendre|arreter|changer)\s+(mon|le|la|mes)\s+(traitement|medicament)\b/i,
  /\bpose\s+moi\s+un\s+diagnostic\b/i,
];

// ---------- Patterns abusifs ----------
// Insultes explicites, harcelement du chatbot.
const ABUSIVE_PATTERNS = [
  /\b(connard|connasse|salope|pute|enculé|encule|va\s+te\s+faire\s+(foutre|enculer)|ferme\s+ta\s+gueule|ta\s+gueule|nique\s+ta\s+mere|fils\s+de\s+pute)\b/i,
  /\b(t'?es|tu\s+es)\s+(nul|nulle|con|conne|stupide|debile|pourri|merdique)\b.{0,30}$/i,
];

// ---------- Patterns sensibles (a loguer, mais on continue) ----------
// Themes difficiles sans signal critique. On les laisse passer au modele
// qui saura les traiter (le prompt couvre ces cas), mais on les note.
const SENSITIVE_PATTERNS = [
  /\b(deuil|mort\s+de|deces|décès|est\s+(décédé|decede|morte?|decedee?)|j'?ai\s+perdu|elle\s+est\s+(morte|decedee|décédée)|il\s+est\s+(mort|decede|décédé))\b/i,
  /\b(viol|agress|harcel|abus\s+sexuel|inceste)\b/i,
  /\btrouble\s+(alimentaire|de\s+l'?alimentation)\b|\b(anorexi|boulimi|hyperphag)/i,
  /\b(addiction|alcoolique|drogue|cocaine|cocaïne|heroine|héroïne|dependanc|dépendanc)/i,
  /\bid[ée]es?\s+(noires|suicidaires|sombres|de\s+mort)\b/i,
];

/**
 * Classifie un message utilisateur.
 * @param {string} text
 * @returns {'critical'|'out_of_scope'|'abusive'|'sensitive'|'empty'|'normal'}
 */
export function classifyInput(text) {
  if (typeof text !== 'string') return 'empty';
  const trimmed = text.trim();
  if (trimmed.length < 3) return 'empty';

  // Ordre : critique > hors perimetre > abusif > sensible > normal
  for (const pat of CRITICAL_PATTERNS) {
    if (pat.test(trimmed)) return 'critical';
  }
  for (const pat of OUT_OF_SCOPE_PATTERNS) {
    if (pat.test(trimmed)) return 'out_of_scope';
  }
  for (const pat of ABUSIVE_PATTERNS) {
    if (pat.test(trimmed)) return 'abusive';
  }
  for (const pat of SENSITIVE_PATTERNS) {
    if (pat.test(trimmed)) return 'sensitive';
  }
  return 'normal';
}


// ---------- Filtrage de sortie ----------
// Patterns qui doivent NE JAMAIS sortir du modele vers l'utilisateur.
// Si detectes, on substitue un message neutre de recadrage.
const UNSAFE_OUTPUT_PATTERNS = [
  // Diagnostic affirmatif
  /\bvous\s+(etes|êtes)\s+(bipolaire|depressif|depressive|dépressif|dépressive|schizophr|borderline|narcissique|pervers|autiste|tdah)\b/i,
  /\bvous\s+(souffrez|avez)\s+(d'?une?|de\s+la|de)\s+(depression|dépression|bipolarite|bipolarité|schizophr|psychose|toc|tdah)\b/i,

  // Prescription / conseil medicamenteux
  /\bprenez\s+(du|de\s+la|des|un|une)\s+(lexomil|xanax|prozac|seresta|tercian|zyprexa|lithium|stilnox|valium|imipramine|anafranil|effexor|seroplex|deroxat|cymbalta|risperdal|abilify)\b/i,
  /\b(je\s+vous\s+)?(prescri|recommande|conseill)[a-zéè]*\s+(de\s+prendre|un\s+traitement|des\s+medicaments?|des\s+médicaments?|un\s+antidepresseur|un\s+antidépresseur|un\s+anxiolytique)\b/i,
  /\b(arretez|arrêtez)\s+(votre|le|la)\s+(traitement|medicament|médicament)\b/i,
  /\bchangez\s+(de|votre)\s+(medecin|médecin|psychiatre|traitement)\b/i,

  // Pronostic
  /\bvous\s+(allez|irez)\s+(mieux|guerir|guérir)\b/i,
  /\bca\s+va\s+(s'?aggrav|empir)/i,

  // Validation d'interpretation delirante
  /\bvous\s+avez\s+raison\s+de\s+(penser|croire)\s+que.{0,60}(vous\s+surveill|vous\s+veul|complot)/i,
];

/**
 * Verifie si une reponse du modele contient des formulations interdites.
 * @param {string} text
 * @returns {boolean}
 */
export function isUnsafeOutput(text) {
  if (typeof text !== 'string') return false;
  return UNSAFE_OUTPUT_PATTERNS.some(p => p.test(text));
}
