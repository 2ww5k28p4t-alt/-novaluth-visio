export const SOUND_AXES = [
  {
    key: "couleur",
    title: "Couleur du son",
    values: [
      { key: "chaud", label: "Plutôt chaud et rond", help: "Graves présents, aigus adoucis." },
      { key: "equilibre", label: "Plutôt équilibré", help: "Aucun registre ne domine." },
      { key: "clair", label: "Plutôt clair et brillant", help: "Aigus en avant, définition nette." },
    ],
  },
  {
    key: "attaque",
    title: "Réponse à l’attaque",
    values: [
      { key: "douce", label: "Douce et progressive", help: "Le son s’installe, agréable en accompagnement." },
      { key: "franche", label: "Franche", help: "Le son répond sans traîner ni claquer." },
      { key: "percussive", label: "Percussive et immédiate", help: "L’attaque est marquée et très lisible." },
    ],
  },
  {
    key: "tenue",
    title: "Tenue des notes",
    values: [
      { key: "courte", label: "Courte et nette", help: "La note s’arrête vite, l’articulation ressort." },
      { key: "moyenne", label: "Moyenne", help: "Tenue habituelle, sans caractère particulier." },
      { key: "longue", label: "Longue et chantante", help: "La note se prolonge, utile pour les solos tenus." },
    ],
  },
] as const;

export type SoundAxisKey = (typeof SOUND_AXES)[number]["key"];
export type SoundValueKey = "chaud" | "equilibre" | "clair" | "douce" | "franche" | "percussive" | "courte" | "moyenne" | "longue";
export type SoundProfile = {
  styles?: string[];
  niveau_sortie?: string | null;
  type_grain?: string | null;
  description?: string | null;
  couleur?: string | null;
  attaque?: string | null;
  tenue?: string | null;
};

function validValue(axis: SoundAxisKey, value: unknown) {
  return typeof value === "string" && SOUND_AXES.find((item) => item.key === axis)?.values.some((choice) => choice.key === value)
    ? value
    : undefined;
}

export function soundFromLegacy(profile: Record<string, unknown>): SoundProfile {
  const couleur = validValue("couleur", profile.couleur);
  const attaque = validValue("attaque", profile.attaque);
  const tenue = validValue("tenue", profile.tenue);
  if (couleur || attaque || tenue) {
    return { ...profile, couleur, attaque, tenue } as SoundProfile;
  }

  const chaleur = typeof profile.chaleur === "number" ? profile.chaleur : undefined;
  const brillance = typeof profile.brillance === "number" ? profile.brillance : undefined;
  const dynamique = typeof profile.dynamique === "number" ? profile.dynamique : undefined;
  let legacyColour: string | undefined;
  if (chaleur != null && brillance != null) {
    const difference = chaleur - brillance;
    legacyColour = difference >= 2 ? "chaud" : difference <= -2 ? "clair" : "equilibre";
  } else if (chaleur != null) {
    legacyColour = chaleur >= 7 ? "chaud" : "equilibre";
  } else if (brillance != null) {
    legacyColour = brillance >= 7 ? "clair" : "equilibre";
  }
  const legacyAttack = dynamique == null ? undefined : dynamique >= 7 ? "percussive" : dynamique <= 4 ? "douce" : "franche";
  return { ...profile, couleur: legacyColour, attaque: legacyAttack, tenue: undefined } as SoundProfile;
}

export function soundLabel(axis: string, value: string | null | undefined) {
  return SOUND_AXES.find((item) => item.key === axis)?.values.find((choice) => choice.key === value)?.label ?? value ?? "";
}

export function availableSoundColours(profiles: Array<{ profil_sonore: SoundProfile }>) {
  const present = new Set(profiles.map((profile) => profile.profil_sonore.couleur).filter(Boolean));
  return SOUND_AXES[0].values.filter((value) => present.has(value.key)).map((value) => ({ cle: value.key, libelle: value.label }));
}

export function compareSound(profile: SoundProfile, desired: Partial<Record<SoundAxisKey, string | null>>) {
  const points: string[] = [];
  const warnings: string[] = [];
  const scores: number[] = [];
  for (const axis of SOUND_AXES) {
    const wanted = validValue(axis.key, desired[axis.key]);
    if (!wanted) continue;
    const obtained = validValue(axis.key, profile[axis.key]);
    if (!obtained) {
      warnings.push(`${axis.title} non renseignée par cet atelier.`);
      continue;
    }
    const wantedIndex = axis.values.findIndex((value) => value.key === wanted);
    const obtainedIndex = axis.values.findIndex((value) => value.key === obtained);
    const distance = Math.abs(wantedIndex - obtainedIndex);
    scores.push(distance === 0 ? 1 : distance === 1 ? 0.5 : 0);
    const wantedLabel = soundLabel(axis.key, wanted).toLocaleLowerCase("fr");
    const obtainedLabel = soundLabel(axis.key, obtained).toLocaleLowerCase("fr");
    if (distance === 0) points.push(`${axis.title} annoncée « ${obtainedLabel} », comme vous le cherchez.`);
    else if (distance === 1) points.push(`${axis.title} annoncée « ${obtainedLabel} », proche de « ${wantedLabel} ».`);
    else warnings.push(`${axis.title} annoncée « ${obtainedLabel} » alors que vous cherchez « ${wantedLabel} ».`);
  }
  return {
    proximity: scores.length ? scores.reduce((total, score) => total + score, 0) / scores.length : null,
    points,
    warnings,
  };
}