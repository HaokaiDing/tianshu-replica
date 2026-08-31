const PERSON_NAME = /^[A-Z][A-Za-z'-]+\s+[A-Z][A-Za-z'-]+$/;
const NON_PERSON_LAST_NAMES = new Set([
  "Arena", "Council", "County", "Crisis", "Holdings", "Logistics", "Mechanical",
  "Pack", "Partners", "Room", "Row", "Solicitors", "Store", "Trust", "Valley",
]);

const escaped = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function canonicalPersonNames(charactersMarkdown, canonicalNames = []) {
  return canonicalNames.filter((name) => {
    if (!PERSON_NAME.test(name) || NON_PERSON_LAST_NAMES.has(name.split(/\s+/)[1])) return false;
    return new RegExp(`${escaped(name)}\\s*(?:\\(|,\\s*\\d{2}\\b)`).test(String(charactersMarkdown));
  });
}

export function fixedEntityErrors(markdown, canonicalNames = []) {
  const byFirstName = new Map();
  for (const name of canonicalNames.filter((value) => PERSON_NAME.test(value) && !NON_PERSON_LAST_NAMES.has(value.split(/\s+/)[1]))) {
    const firstName = name.split(/\s+/)[0];
    byFirstName.set(firstName, [...(byFirstName.get(firstName) || []), name]);
  }
  const errors = [];
  for (const [firstName, allowed] of byFirstName) {
    const pattern = new RegExp(`\\b${firstName}\\s+([A-Z][A-Za-z'-]+)\\b`, "g");
    for (const match of String(markdown).matchAll(pattern)) {
      const candidate = `${firstName} ${match[1].replace(/'s$/, "")}`;
      if (!allowed.includes(candidate)) errors.push(`固定人物姓名漂移：${candidate}；应为 ${allowed.join(" / ")}`);
    }
  }
  return [...new Set(errors)];
}
