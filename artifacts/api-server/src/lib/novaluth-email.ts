import { logger } from "./logger";

export type NovaLuthEmailEvent =
  | "portal_created"
  | "access_request"
  | "decision_accepted"
  | "decision_refused"
  | "request_cancelled"
  | "request_expired"
  | "pending_reminder"
  | "access_expiring_soon"
  | "followup"
  | "sn13_degradation"
  | "sn13_purge_failure";

export type Sn13AlertDetails = {
  provider: string;
  windowHours: number;
  total: number;
  success: number;
  empty: number;
  incomplete: number;
  error: number;
};

export type Sn13PurgeAlertDetails = {
  provider: string;
  windowHours: number;
};

export type EmailDetails = {
  event: NovaLuthEmailEvent;
  reference: string;
  portalUrl: string;
  atelierName?: string;
  plan?: string;
  accessEndsAt?: Date | null;
  sn13?: Sn13AlertDetails;
  sn13Purge?: Sn13PurgeAlertDetails;
};

export type EmailDeliveryResult =
  | { sent: true; providerMessageId?: string }
  | { sent: false; reason: "not_configured" | "no_recipient" };

export class NovaLuthEmailError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = "NovaLuthEmailError";
  }
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value: Date | null | undefined) {
  return value
    ? new Intl.DateTimeFormat("fr-FR", {
        dateStyle: "long",
        timeZone: "Europe/Paris",
      }).format(value)
    : "prochainement";
}

function contentFor(details: EmailDetails) {
  if (details.event === "sn13_degradation") {
    const alert = details.sn13;
    if (!alert) {
      throw new Error("Les détails de l’alerte SN13 sont requis.");
    }
    return {
      subject: `Alerte SN13 · ${alert.provider}`,
      title: "Collecte SN13 à surveiller",
      intro: `Fournisseur : ${alert.provider}`,
      body: [
        `Fenêtre : ${alert.windowHours} heures.`,
        `Compteurs : total ${alert.total}, succès ${alert.success}, vides ${alert.empty}, incomplètes ${alert.incomplete}, erreurs ${alert.error}.`,
      ].join(" "),
    };
  }
  if (details.event === "sn13_purge_failure") {
    const alert = details.sn13Purge;
    if (!alert) {
      throw new Error("Les détails de l’échec de purge SN13 sont requis.");
    }
    return {
      subject: `Échec de purge SN13 · ${alert.provider}`,
      title: "Purge SN13 en échec",
      intro: `Fournisseur : ${alert.provider}`,
      body: `La purge planifiée de l’historique SN13 a échoué. L’entretien des accès continue ; une nouvelle alerte sera envoyée uniquement après un rétablissement puis un nouvel échec.`,
    };
  }

  const atelier = details.atelierName ?? "un atelier partenaire";
  const plan = details.plan ? ` Offre ${details.plan}.` : "";
  const date = formatDate(details.accessEndsAt);

  switch (details.event) {
    case "portal_created":
      return {
        subject: `Votre portail privé NovaLuth · ${details.reference}`,
        title: "Votre projet est enregistré",
        intro:
          "Vous avez autorisé NovaLuth à conserver votre brief et à vous transmettre les propositions compatibles.",
        body: `Votre portail privé est prêt. Vous pourrez y consulter les demandes des artisans et décider librement de chaque mise en relation.`,
      };
    case "access_request":
      return {
        subject: `Nouvelle proposition pour votre projet · ${details.reference}`,
        title: "Une proposition vous attend",
        intro: `${atelier} souhaite entrer en relation avec vous.${plan}`,
        body: "Ouvrez votre portail privé pour consulter la proposition et l’accepter ou la refuser. Aucun débit n’est effectué avant votre acceptation.",
      };
    case "decision_accepted":
      return {
        subject: `Mise en relation acceptée · ${details.reference}`,
        title: "Mise en relation acceptée",
        intro: `Vous avez accepté la proposition de ${atelier}.${plan}`,
        body: "L’artisan peut maintenant accéder aux informations nécessaires et prendre contact avec vous.",
      };
    case "decision_refused":
      return {
        subject: `Décision enregistrée · ${details.reference}`,
        title: "Proposition déclinée",
        intro: `Votre refus de la proposition de ${atelier} a bien été enregistré.${plan}`,
        body: "Aucun débit ne sera effectué pour cette demande.",
      };
    case "request_cancelled":
      return {
        subject: `Proposition annulée · ${details.reference}`,
        title: "Proposition annulée",
        intro: `La proposition de ${atelier} n’est plus active.${plan}`,
        body: "Vous n’avez aucune action à effectuer. Votre portail reste disponible pour les autres propositions.",
      };
    case "request_expired":
      return {
        subject: `Accès arrivé à échéance · ${details.reference}`,
        title: "Une mise en relation est arrivée à échéance",
        intro: `La période d’accès de ${atelier} est terminée le ${date}.`,
        body: "Votre portail reste disponible pour consulter l’historique et les prochaines propositions.",
      };
    case "pending_reminder":
      return {
        subject: `Rappel : une proposition attend votre réponse · ${details.reference}`,
        title: "Votre réponse est attendue",
        intro: `La proposition de ${atelier} est toujours en attente.${plan}`,
        body: "Connectez-vous à votre portail privé pour accepter ou décliner cette demande avant son annulation automatique.",
      };
    case "access_expiring_soon":
      return {
        subject: `Rappel : votre accès arrive bientôt à échéance · ${details.reference}`,
        title: "Votre mise en relation arrive bientôt à échéance",
        intro: `L’accès accordé à ${atelier} se termine le ${date}.`,
        body: "Vous pouvez continuer vos échanges pendant cette période. Votre portail restera ensuite disponible pour l’historique.",
      };
    case "followup":
      return {
        subject: `Relance envoyée à votre artisan · ${details.reference}`,
        title: "Une relance a été envoyée",
        intro: `${atelier} vient d’utiliser un crédit de relance pour votre projet.${plan}`,
        body: "Vous n’avez rien à faire. Ce message vous informe simplement qu’une nouvelle relance a été enregistrée dans votre suivi.",
      };
  }
}

export function getNovaLuthPublicUrl() {
  const rawUrl = process.env.NOVALUTH_PUBLIC_URL;
  if (!rawUrl) return null;

  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || !url.hostname) return null;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function isNovaLuthEmailConfigured() {
  return Boolean(
    process.env.RESEND_API_KEY &&
    process.env.NOVALUTH_EMAIL_FROM &&
    getNovaLuthPublicUrl(),
  );
}

export async function sendNovaLuthEmail(
  recipient: string | null | undefined,
  details: EmailDetails,
  options: { idempotencyKey?: string } = {},
): Promise<EmailDeliveryResult> {
  if (!recipient) {
    return { sent: false, reason: "no_recipient" };
  }

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.NOVALUTH_EMAIL_FROM;
  if (!apiKey || !from) {
    throw new NovaLuthEmailError("Resend is not configured.", false);
  }

  const content = contentFor(details);
  const safePortalUrl = escapeHtml(details.portalUrl);
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#202124;max-width:620px">
      <p style="color:#6d4c41;font-weight:700;letter-spacing:.08em;text-transform:uppercase">NovaLuth</p>
      <h1 style="font-size:26px;font-weight:500">${escapeHtml(content.title)}</h1>
      <p>${escapeHtml(content.intro)}</p>
      <p>${escapeHtml(content.body)}</p>
      ${
        details.event === "sn13_degradation" ||
        details.event === "sn13_purge_failure"
          ? ""
          : `<p style="margin:28px 0">
        <a href="${safePortalUrl}" style="display:inline-block;background:#6d4c41;color:#fff;padding:12px 20px;text-decoration:none">
          Ouvrir mon portail privé
        </a>
      </p>
      <p style="font-size:12px;color:#6b7280">Référence : ${escapeHtml(details.reference)}</p>`
      }
    </div>
  `;
  const text =
    details.event === "sn13_degradation" ||
    details.event === "sn13_purge_failure"
      ? ["NovaLuth", "", content.title, content.intro, content.body].join("\n")
      : [
          "NovaLuth",
          "",
          content.title,
          content.intro,
          content.body,
          "",
          `Ouvrir votre portail privé : ${details.portalUrl}`,
          `Référence : ${details.reference}`,
        ].join("\n");

  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(options.idempotencyKey
          ? { "Idempotency-Key": options.idempotencyKey }
          : {}),
      },
      body: JSON.stringify({
        from,
        to: [recipient],
        subject: content.subject,
        html,
        text,
        tags: [{ name: "novaluth_event", value: details.event }],
      }),
    });
  } catch (error) {
    throw new NovaLuthEmailError(
      error instanceof Error ? error.message : "Resend request failed.",
      true,
    );
  }

  if (!response.ok) {
    throw new NovaLuthEmailError(
      `Resend rejected the email with status ${response.status}.`,
      response.status === 408 ||
        response.status === 429 ||
        response.status >= 500,
      response.status,
    );
  }

  let providerMessageId: string | undefined;
  try {
    const body = (await response.json()) as { id?: unknown };
    providerMessageId = typeof body.id === "string" ? body.id : undefined;
  } catch {
    // A successful provider response may have no JSON body.
  }
  logger.info(
    { event: details.event, reference: details.reference, providerMessageId },
    "NovaLuth email sent",
  );
  return { sent: true, providerMessageId };
}
