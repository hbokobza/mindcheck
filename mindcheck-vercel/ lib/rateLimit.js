// lib/rateLimit.js
// Rate limit simple en memoire (par instance serverless).
// Non persistant, reinitialise a chaque cold start. Suffisant pour une
// premiere ligne de defense contre l'abus d'appels.
// Pour un vrai rate limit persistant, il faudra passer a Upstash Redis
// ou equivalent quand le trafic le justifiera.

const WINDOW_MS = 60 * 1000;      // fenetre de 60 secondes
const MAX_REQUESTS = 30;          // 30 messages max par minute par IP

const buckets = new Map();

/**
 * Retourne true si la requete est autorisee, false si rate-limitee.
 * @param {string} ip
 * @returns {boolean}
 */
export function allowRequest(ip) {
  const now = Date.now();
  const bucket = buckets.get(ip);

  if (!bucket) {
    buckets.set(ip, { count: 1, windowStart: now });
    return true;
  }

  if (now - bucket.windowStart > WINDOW_MS) {
    // Nouvelle fenetre
    bucket.count = 1;
    bucket.windowStart = now;
    return true;
  }

  bucket.count += 1;
  return bucket.count <= MAX_REQUESTS;
}

// Nettoyage occasionnel pour eviter la croissance infinie de la map
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of buckets.entries()) {
    if (now - bucket.windowStart > WINDOW_MS * 2) {
      buckets.delete(ip);
    }
  }
}, WINDOW_MS).unref?.();
