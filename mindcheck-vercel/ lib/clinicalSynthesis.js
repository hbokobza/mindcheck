// lib/clinicalSynthesis.js

export function buildClinicalSynthesis({
  axes = {},
  psychometrics = [],
  passationQuality = null,
  clinicalFlags = {},
  safety = {}
} = {}) {
  const summary = [];
  const recommendations = [];
  const alerts = [];

  if (passationQuality) {
    if (passationQuality.level === "bonne") {
      summary.push("La qualité de passation est bonne.");
    } else if (passationQuality.level === "prudente") {
      summary.push(
        "La qualité de passation autorise une lecture clinique, avec prudence d’interprétation."
      );
    } else {
      summary.push(
        "La qualité de passation est limitée et réduit la confiance interprétative."
      );
    }

    if (passationQuality.warnings?.length) {
      summary.push(
        `Points de vigilance de passation : ${passationQuality.warnings.join(", ")}.`
      );
    }
  }

  const psychometricText = buildPsychometricText(psychometrics);
  if (psychometricText) summary.push(psychometricText);

  const axesText = buildAxesText(axes);
  if (axesText) summary.push(axesText);

  if (clinicalFlags.suicidalIdeation) {
    alerts.push(
      "Des éléments évoquent un risque psychique nécessitant une évaluation clinique rapide."
    );
    recommendations.push(
      "Recommander une prise de contact rapide avec un professionnel de santé mentale."
    );
  }

  if (hasModerateOrHigherPsychometricSignal(psychometrics)) {
    recommendations.push(
      "Une évaluation clinique approfondie est recommandée afin de préciser la nature et l’intensité des difficultés repérées."
    );
  }

  if (!recommendations.length) {
    recommendations.push(
      "Les éléments recueillis peuvent être repris dans un entretien clinique si la personne souhaite approfondir certains points."
    );
  }

  return {
    headline: buildHeadline(psychometrics, passationQuality),
    summary,
    alerts,
    recommendations,
    disclaimer:
      "Ce bilan constitue un outil de repérage clinique structuré. Il ne pose pas de diagnostic médical ou psychiatrique à lui seul."
  };
}

function buildHeadline(psychometrics = [], passationQuality = null) {
  const strongSignal = psychometrics.some(result => {
    if (!result) return false;
    if (result.moduleId === "PHQ9" && result.score >= 10) return true;
    if (result.moduleId === "GAD7" && result.score >= 10) return true;
    if (result.moduleId === "PSS10" && result.score >= 27) return true;
    return false;
  });

  if (strongSignal) {
    return "Des signaux cliniques significatifs ont été repérés";
  }

  if (passationQuality?.level === "limitée") {
    return "Les résultats sont à interpréter avec prudence";
  }

  return "Le bilan met en évidence des éléments cliniques à contextualiser";
}

function buildPsychometricText(psychometrics = []) {
  if (!psychometrics.length) return "";

  const fragments = psychometrics.map(result => {
    return `${result.title} : score ${result.score}, ${result.interpretation}`;
  });

  return `Modules complémentaires : ${fragments.join(" ; ")}.`;
}

function buildAxesText(axes = {}) {
  const entries = Object.entries(axes).filter(([, value]) => value !== null && value !== undefined);
  if (!entries.length) return "";

  const fragments = entries.map(([key, value]) => {
    const label = AXIS_LABELS[key] || key;
    return `${label} : ${formatAxisValue(value)}`;
  });

  return `Lecture par axes : ${fragments.join(" ; ")}.`;
}

function formatAxisValue(value) {
  if (typeof value === "number") return `${value}/4`;
  if (typeof value === "string") return value;
  if (typeof value === "object" && value.label) return value.label;
  return String(value);
}

function hasModerateOrHigherPsychometricSignal(psychometrics = []) {
  return psychometrics.some(result => {
    if (!result) return false;
    if (result.moduleId === "PHQ9" && result.score >= 10) return true;
    if (result.moduleId === "GAD7" && result.score >= 10) return true;
    if (result.moduleId === "PSS10" && result.score >= 27) return true;
    return false;
  });
}

const AXIS_LABELS = {
  axis1: "Processus et mécanismes psychiques",
  axis2: "Ressources psychiques",
  axis3: "Prévalence des comportements",
  axis4: "Expression des affects",
  axis5: "Risque somatique",
  axis6: "Environnement"
};
