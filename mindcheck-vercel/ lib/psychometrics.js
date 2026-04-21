// lib/psychometrics.js

export const RESPONSE_OPTIONS = [
  { value: 0, label: "Jamais" },
  { value: 1, label: "Quelques jours" },
  { value: 2, label: "Plus de la moitié des jours" },
  { value: 3, label: "Presque tous les jours" }
];

export const PHQ9 = {
  id: "PHQ9",
  title: "Évaluation complémentaire de l’humeur",
  timeframe: "Au cours des 14 derniers jours",
  description:
    "Quelques questions complémentaires permettent d’objectiver certains symptômes dépressifs. Ce module ne constitue pas un diagnostic.",
  items: [
    "Peu d’intérêt ou de plaisir à faire les choses",
    "Tristesse, abattement ou sentiment de désespoir",
    "Difficultés d’endormissement, réveils nocturnes ou sommeil excessif",
    "Fatigue ou manque d’énergie",
    "Perte d’appétit ou appétit excessif",
    "Mauvaise estime de soi, culpabilité ou sentiment d’échec",
    "Difficultés de concentration",
    "Ralentissement inhabituel ou agitation",
    "Pensées qu’il vaudrait mieux disparaître ou se faire du mal"
  ]
};

export const GAD7 = {
  id: "GAD7",
  title: "Évaluation complémentaire de l’anxiété",
  timeframe: "Au cours des 14 derniers jours",
  description:
    "Quelques questions complémentaires permettent d’objectiver certains symptômes anxieux. Ce module ne constitue pas un diagnostic.",
  items: [
    "Sentiment de nervosité, d’anxiété ou de tension",
    "Difficulté à arrêter ou à contrôler les inquiétudes",
    "Inquiétudes excessives à propos de différents sujets",
    "Difficulté à se détendre",
    "Agitation ou difficulté à rester tranquille",
    "Irritabilité ou facilité à s’agacer",
    "Peur qu’un événement grave puisse se produire"
  ]
};

export const PSS10 = {
  id: "PSS10",
  title: "Évaluation complémentaire du stress perçu",
  timeframe: "Au cours du dernier mois",
  description:
    "Ce module permet d’objectiver le niveau de stress perçu. Il ne constitue pas un diagnostic.",
  items: [
    "Vous êtes-vous senti bouleversé par un événement inattendu ?",
    "Vous êtes-vous senti incapable de contrôler les choses importantes de votre vie ?",
    "Vous êtes-vous senti nerveux ou stressé ?",
    "Avez-vous eu le sentiment de bien gérer vos difficultés personnelles ?",
    "Avez-vous senti que les choses allaient dans votre sens ?",
    "Avez-vous constaté que vous ne pouviez pas faire face à tout ce que vous aviez à faire ?",
    "Avez-vous réussi à maîtriser les irritations de votre vie quotidienne ?",
    "Avez-vous eu le sentiment de dominer la situation ?",
    "Avez-vous été irrité par des événements échappant à votre contrôle ?",
    "Avez-vous eu le sentiment que les difficultés s’accumulaient au point de ne pouvoir les surmonter ?"
  ],
  reverseScoredIndexes: [3, 4, 6, 7]
};

export const PSYCHOMETRIC_MODULES = {
  PHQ9,
  GAD7,
  PSS10
};

export function getPsychometricModule(moduleId) {
  return PSYCHOMETRIC_MODULES[moduleId] || null;
}

export function scorePHQ9(values = []) {
  return values.reduce((sum, v) => sum + normalizeAnswer(v), 0);
}

export function interpretPHQ9(score) {
  if (score >= 20) return "symptômes dépressifs sévères";
  if (score >= 15) return "symptômes dépressifs modérément sévères";
  if (score >= 10) return "symptômes dépressifs modérés";
  if (score >= 5) return "symptômes dépressifs légers";
  return "pas de signal dépressif significatif";
}

export function scoreGAD7(values = []) {
  return values.reduce((sum, v) => sum + normalizeAnswer(v), 0);
}

export function interpretGAD7(score) {
  if (score >= 15) return "symptômes anxieux sévères";
  if (score >= 10) return "symptômes anxieux modérés";
  if (score >= 5) return "symptômes anxieux légers";
  return "pas de signal anxieux significatif";
}

export function scorePSS10(values = []) {
  const reverse = new Set(PSS10.reverseScoredIndexes || []);
  return values.reduce((sum, rawValue, index) => {
    const value = normalizeAnswer(rawValue);
    return sum + (reverse.has(index) ? 4 - value : value);
  }, 0);
}

export function interpretPSS10(score) {
  if (score >= 27) return "stress perçu élevé";
  if (score >= 14) return "stress perçu modéré";
  return "stress perçu faible";
}

export function scoreModule(moduleId, values = []) {
  switch (moduleId) {
    case "PHQ9":
      return scorePHQ9(values);
    case "GAD7":
      return scoreGAD7(values);
    case "PSS10":
      return scorePSS10(values);
    default:
      return null;
  }
}

export function interpretModule(moduleId, score) {
  switch (moduleId) {
    case "PHQ9":
      return interpretPHQ9(score);
    case "GAD7":
      return interpretGAD7(score);
    case "PSS10":
      return interpretPSS10(score);
    default:
      return "interprétation indisponible";
  }
}

export function buildPsychometricResult(moduleId, values = []) {
  const module = getPsychometricModule(moduleId);
  if (!module) return null;

  const score = scoreModule(moduleId, values);
  const interpretation = interpretModule(moduleId, score);

  return {
    moduleId,
    title: module.title,
    timeframe: module.timeframe,
    score,
    interpretation,
    rawAnswers: values.map(normalizeAnswer),
    caution:
      "Ce résultat constitue un repérage clinique complémentaire. Il ne vaut pas diagnostic et doit être interprété dans un cadre clinique."
  };
}

function normalizeAnswer(value) {
  const n = Number(value);
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 3) return 3;
  return n;
}
