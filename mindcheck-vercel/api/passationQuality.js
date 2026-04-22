// lib/passationQuality.js

export function computePassationQuality(metrics = {}) {
  let score = 100;
  const warnings = [];

  const avgCharsPerAnswer = number(metrics.avgCharsPerAnswer);
  const fastAnswerRatio = number(metrics.fastAnswerRatio);
  const inconsistencyCount = number(metrics.inconsistencyCount);
  const emptyAnswerRatio = number(metrics.emptyAnswerRatio);
  const lowElaborationRatio = number(metrics.lowElaborationRatio);
  const skippedQuestionRatio = number(metrics.skippedQuestionRatio);
  const attentionCheckFailed = Boolean(metrics.attentionCheckFailed);

  if (avgCharsPerAnswer > 0 && avgCharsPerAnswer < 25) {
    score -= 20;
    warnings.push("Réponses très brèves");
  }

  if (fastAnswerRatio > 0.4) {
    score -= 20;
    warnings.push("Temps de réponse très rapides");
  }

  if (inconsistencyCount >= 2) {
    score -= 25;
    warnings.push("Incohérences internes détectées");
  }

  if (emptyAnswerRatio > 0.2) {
    score -= 15;
    warnings.push("Trop de réponses peu informatives");
  }

  if (lowElaborationRatio > 0.5) {
    score -= 10;
    warnings.push("Élaboration clinique limitée");
  }

  if (skippedQuestionRatio > 0.2) {
    score -= 10;
    warnings.push("Trop de questions laissées sans réponse");
  }

  if (attentionCheckFailed) {
    score -= 20;
    warnings.push("Contrôle d’attention non validé");
  }

  score = clamp(score, 0, 100);

  return {
    score,
    level: getQualityLevel(score),
    warnings,
    interpretable: score >= 60,
    confidenceLabel: getConfidenceLabel(score)
  };
}

export function buildPassationMetrics({
  messages = [],
  answers = [],
  responseTimes = [],
  inconsistencies = [],
  attentionCheckFailed = false
} = {}) {
  const textualAnswers = answers.length
    ? answers
    : messages
        .filter(m => m?.role === "user")
        .map(m => String(m.content || "").trim());

  const avgCharsPerAnswer = average(textualAnswers.map(a => a.length));
  const emptyAnswerRatio = ratio(
    textualAnswers.filter(a => !a || a.length < 3).length,
    textualAnswers.length
  );

  const lowElaborationRatio = ratio(
    textualAnswers.filter(a => a.length > 0 && a.length < 20).length,
    textualAnswers.length
  );

  const fastAnswerRatio = ratio(
    responseTimes.filter(ms => number(ms) > 0 && number(ms) < 2500).length,
    responseTimes.length
  );

  const skippedQuestionRatio = ratio(
    textualAnswers.filter(a => !a).length,
    textualAnswers.length
  );

  return {
    avgCharsPerAnswer,
    fastAnswerRatio,
    inconsistencyCount: inconsistencies.length,
    emptyAnswerRatio,
    lowElaborationRatio,
    skippedQuestionRatio,
    attentionCheckFailed
  };
}

function getQualityLevel(score) {
  if (score >= 80) return "bonne";
  if (score >= 60) return "prudente";
  return "limitée";
}

function getConfidenceLabel(score) {
  if (score >= 80) return "bonne confiance interprétative";
  if (score >= 60) return "confiance interprétative modérée";
  return "faible confiance interprétative";
}

function average(values = []) {
  if (!values.length) return 0;
  return values.reduce((sum, v) => sum + number(v), 0) / values.length;
}

function ratio(part, total) {
  if (!total) return 0;
  return part / total;
}

function number(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}
