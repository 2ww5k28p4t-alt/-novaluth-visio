const personalDataPatterns: readonly [RegExp, string][] = [
  [/\b(?:api[_-]?key|access[_-]?token|token|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, "[secret retiré]"],
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[courriel retiré]"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[adresse IP retirée]"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "[identifiant retiré]"],
  [/(?:\+?\d[\d .()/-]{7,}\d)/g, "[téléphone retiré]"],
  [/\b\d{10,}\b/g, "[numéro retiré]"],
  [/\b\d{1,4}\s+(?:rue|avenue|boulevard|chemin|route|place)\s+[^,;\n]{2,80}/gi, "[adresse retirée]"],
  [/\b(?:nom|prénom|prenom|adresse|contact)\s*:\s*[^,;\n]{2,100}/gi, "[identité retirée]"],
];

export function anonymize(text: string): { text: string; removed: number } {
  let clean = text;
  let removed = 0;
  for (const [pattern, replacement] of personalDataPatterns) {
    clean = clean.replace(pattern, () => {
      removed += 1;
      return replacement;
    });
  }
  return { text: clean, removed };
}
