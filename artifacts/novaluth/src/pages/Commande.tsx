import { useState, type ReactNode } from "react";
import { useRoute } from "wouter";
import {
  useCancelProtectedOrderByMusician,
  useConfirmProtectedDelivery,
  useDecideProtectedOrder,
  getGetProtectedDeliveryQueryKey,
  getGetProtectedOrderQueryKey,
  useGetProtectedDelivery,
  useGetProtectedOrder,
  ProtectedOrder,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Clock3,
  Euro,
  Loader2,
  PackageCheck,
  ShieldAlert,
  X,
} from "lucide-react";
import { toast } from "sonner";

function dateLabel(value?: string | null) {
  if (!value) return "Non précisée";
  return new Intl.DateTimeFormat("fr-FR", { dateStyle: "long" }).format(new Date(value));
}

function money(value: number) {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(value);
}

function statusLabel(status: string) {
  return {
    declaree: "À confirmer",
    confirmee: "Confirmée",
    expiree: "Expirée",
    refusee: "Refusée",
    annulee_client: "Annulée par le musicien",
    annulee_atelier: "Annulée par l’atelier",
    livree: "Réception confirmée",
    non_confirmee: "Réception non confirmée",
  }[status] ?? status;
}

export default function Commande() {
  const [, confirmationParams] = useRoute("/commandes/:reference/confirmation/:token");
  const [, deliveryParams] = useRoute("/commandes/:reference/livraison/:token");
  const isDelivery = Boolean(deliveryParams);
  const reference = (confirmationParams ?? deliveryParams)?.reference ?? "";
  const token = (confirmationParams ?? deliveryParams)?.token ?? "";
  const queryClient = useQueryClient();
  const [completed, setCompleted] = useState<ProtectedOrder | null>(null);

  const confirmationQuery = useGetProtectedOrder(reference, token, {
    query: {
      enabled: Boolean(reference && token && !isDelivery),
      retry: false,
      queryKey: getGetProtectedOrderQueryKey(reference, token),
    },
  });
  const deliveryQuery = useGetProtectedDelivery(reference, token, {
    query: {
      enabled: Boolean(reference && token && isDelivery),
      retry: false,
      queryKey: getGetProtectedDeliveryQueryKey(reference, token),
    },
  });
  const decide = useDecideProtectedOrder();
  const cancel = useCancelProtectedOrderByMusician();
  const confirmDelivery = useConfirmProtectedDelivery();
  const order = completed ?? (isDelivery ? deliveryQuery.data : confirmationQuery.data);
  const isLoading = isDelivery ? deliveryQuery.isLoading : confirmationQuery.isLoading;
  const isError = isDelivery ? deliveryQuery.isError : confirmationQuery.isError;

  const refresh = () => {
    queryClient.invalidateQueries({
      queryKey: isDelivery
        ? getGetProtectedDeliveryQueryKey(reference, token)
        : getGetProtectedOrderQueryKey(reference, token),
    });
  };

  const handleDecision = (decision: "confirmer" | "refuser") => {
    if (decision === "confirmer" && !window.confirm("Confirmer cette commande protégée ? Les frais d’engagement de 29 € seront alors dus par l’atelier.")) return;
    decide.mutate(
      { reference, token, data: { decision } },
      {
        onSuccess: (result) => {
          setCompleted(result.commande);
          refresh();
          toast.success(decision === "confirmer" ? "Commande confirmée." : "Commande refusée.");
        },
        onError: () => toast.error("Cette commande ne peut plus être modifiée."),
      },
    );
  };

  const handleCancel = () => {
    if (!window.confirm("Annuler cette commande ? Les frais d’engagement seront convertis en crédit pour l’atelier.")) return;
    cancel.mutate(
      { reference, token },
      {
        onSuccess: (result) => {
          setCompleted(result);
          refresh();
          toast.success("Commande annulée. Un crédit de 29 € a été créé pour l’atelier.");
        },
        onError: () => toast.error("Cette commande ne peut plus être annulée."),
      },
    );
  };

  const handleDelivery = () => {
    if (!window.confirm("Confirmer la réception de l’instrument ? La commission de 2 %, plafonnée à 149 €, sera alors encaissée auprès de l’atelier.")) return;
    confirmDelivery.mutate(
      { reference, token },
      {
        onSuccess: (result) => {
          setCompleted(result);
          refresh();
          toast.success("Réception confirmée.");
        },
        onError: () => toast.error("La réception ne peut plus être confirmée."),
      },
    );
  };

  if (isLoading) {
    return (
      <div className="container mx-auto flex min-h-[60vh] flex-col items-center justify-center gap-4 px-4">
        <Loader2 className="h-12 w-12 animate-spin text-primary" />
        <p className="text-muted-foreground">Ouverture de votre lien privé…</p>
      </div>
    );
  }

  if (isError || !order) {
    return (
      <div className="container mx-auto flex min-h-[60vh] flex-col items-center justify-center px-4 text-center">
        <ShieldAlert className="mb-6 h-16 w-16 text-destructive" />
        <h1 className="mb-3 font-serif text-3xl text-destructive">Lien indisponible</h1>
        <p className="max-w-lg text-muted-foreground">
          Ce lien privé est invalide, expiré ou ne correspond plus à cette commande.
        </p>
      </div>
    );
  }

  const isActionPending = decide.isPending || cancel.isPending || confirmDelivery.isPending;

  return (
    <div className="min-h-screen bg-background pb-24">
      <header className="border-b border-border/50 bg-card py-12">
        <div className="container mx-auto max-w-4xl px-4">
          <Badge variant="outline" className="mb-4 border-primary/20 bg-primary/5 uppercase tracking-widest text-primary">
            Commande protégée · lien privé
          </Badge>
          <h1 className="mb-4 font-serif text-4xl text-primary md:text-5xl">
            Commande {order.reference}
          </h1>
          <div className="flex flex-wrap items-center gap-3">
            <Badge className="bg-primary/10 text-primary hover:bg-primary/10">{statusLabel(order.statut)}</Badge>
            <span className="text-sm text-muted-foreground">Atelier {order.atelier_nom}</span>
          </div>
        </div>
      </header>

      <main className="container mx-auto mt-10 grid max-w-4xl gap-8 px-4 md:grid-cols-[1fr_300px]">
        <div className="space-y-6">
          <Card className="border-primary/20 bg-primary/5">
            <CardContent className="flex gap-3 py-5 text-sm text-muted-foreground">
              <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
              <p>
                Aucun débit n’a lieu à la déclaration. La confirmation déclenche uniquement les frais d’engagement simulés de 29 € ; la commission intervient seulement après votre confirmation de réception.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="font-serif">Détails de la commande</CardTitle>
              <CardDescription>{order.description || "Aucune description complémentaire."}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-5 sm:grid-cols-2">
              <Detail label="Prix de l’instrument" value={money(order.prix_instrument_eur)} icon={<Euro className="h-4 w-4" />} />
              <Detail label="Frais d’engagement" value={money(order.frais_engagement_eur)} icon={<ShieldAlert className="h-4 w-4" />} />
              <Detail label="Commission maximale" value={money(order.commission_eur)} icon={<Euro className="h-4 w-4" />} />
              <Detail label="Livraison annoncée" value={dateLabel(order.date_livraison_annoncee)} icon={<PackageCheck className="h-4 w-4" />} />
              {order.reference_devis && <Detail label="Référence devis" value={order.reference_devis} />}
            </CardContent>
          </Card>

          {!isDelivery && order.peut_confirmer && order.peut_refuser && (
            <Card className="border-primary/30">
              <CardHeader>
                <CardTitle className="font-serif">Votre décision</CardTitle>
                <CardDescription>
                  Répondez avant le {dateLabel(order.echeance_confirmation)}. Vous pouvez confirmer ou refuser sans frais.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 sm:flex-row">
                <Button className="flex-1 bg-green-600 text-white hover:bg-green-700" onClick={() => handleDecision("confirmer")} disabled={isActionPending}>
                  {decide.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}
                  Confirmer la commande
                </Button>
                <Button variant="outline" className="flex-1 text-destructive hover:text-destructive" onClick={() => handleDecision("refuser")} disabled={isActionPending}>
                  <X className="mr-2 h-4 w-4" /> Refuser
                </Button>
              </CardContent>
            </Card>
          )}

          {!isDelivery && order.peut_annuler_musicien && (
            <Card>
              <CardHeader>
                <CardTitle className="font-serif">Besoin d’annuler ?</CardTitle>
                <CardDescription>Les frais d’engagement de 29 € seront transformés en crédit pour cet atelier.</CardDescription>
              </CardHeader>
              <CardContent>
                <Button variant="outline" className="text-destructive hover:text-destructive" onClick={handleCancel} disabled={isActionPending}>
                  {cancel.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Annuler la commande
                </Button>
              </CardContent>
            </Card>
          )}

          {isDelivery && order.peut_confirmer_reception && (
            <Card className="border-green-500/30">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 font-serif"><PackageCheck className="h-5 w-5 text-green-600" /> Confirmer la réception</CardTitle>
                <CardDescription>Cette action clôture la commande et déclenche la commission annoncée.</CardDescription>
              </CardHeader>
              <CardContent>
                <Button className="bg-green-600 text-white hover:bg-green-700" onClick={handleDelivery} disabled={isActionPending}>
                  {confirmDelivery.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
                  Confirmer que l’instrument est reçu
                </Button>
              </CardContent>
            </Card>
          )}
        </div>

        <Card className="h-fit md:sticky md:top-24">
          <CardHeader>
            <CardTitle className="font-serif">Chronologie</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <TimelineItem label="Commande déclarée" value={dateLabel(order.declaree_le)} active />
            <Separator />
            <TimelineItem label="Confirmation attendue avant" value={dateLabel(order.echeance_confirmation)} active={order.statut === "declaree"} />
            {order.confirmee_le && <><Separator /><TimelineItem label="Commande confirmée" value={dateLabel(order.confirmee_le)} active /></>}
            {order.echeance_reception && <><Separator /><TimelineItem label="Réception à confirmer avant" value={dateLabel(order.echeance_reception)} active={order.peut_confirmer_reception} /></>}
            {order.livree_le && <><Separator /><TimelineItem label="Réception confirmée" value={dateLabel(order.livree_le)} active /></>}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

function Detail({ label, value, icon }: { label: string; value: string; icon?: ReactNode }) {
  return (
    <div>
      <span className="mb-1 flex items-center gap-1 text-xs text-muted-foreground">{icon}{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function TimelineItem({ label, value, active }: { label: string; value: string; active: boolean }) {
  return (
    <div className="flex items-start gap-3">
      {active ? <CheckCircle2 className="mt-0.5 h-4 w-4 text-green-600" /> : <Clock3 className="mt-0.5 h-4 w-4 text-muted-foreground" />}
      <div>
        <p className="font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{value}</p>
      </div>
    </div>
  );
}