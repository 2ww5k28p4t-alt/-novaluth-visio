import { useState, useEffect } from "react";
import { useRoute } from "wouter";
import {
  useOpenAtelierSession,
  useGetAtelierDashboard,
  getGetAtelierDashboardQueryKey,
  useListAtelierProjects,
  getListAtelierProjectsQueryKey,
  useCreateAtelierAccessRequest,
  useCancelAtelierAccessRequest,
  useUseAtelierFollowupCredit,
  useListProtectedOrders,
  getListProtectedOrdersQueryKey,
  useCreateProtectedOrder,
  useCancelProtectedOrderByAtelier,
  AtelierDashboard,
  AtelierProject,
  AtelierAccessRequest,
  ProtectedOrder,
  ProtectedOrderInput,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardHeader, CardTitle, CardContent, CardFooter, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { 
  Loader2, 
  ShieldCheck, 
  Zap, 
  Briefcase, 
  Music, 
  Euro, 
  CalendarDays, 
  XCircle, 
  CheckCircle2, 
  RefreshCcw,
  PackageCheck,
  Link2,
  ExternalLink,
} from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { format, parseISO } from "date-fns";
import { fr } from "date-fns/locale";

const OFFRES = [
  { id: "essentiel", label: "Accès Essentiel", price: "9,99 €", desc: "Contact direct avec le musicien et accès aux détails de base." },
  { id: "atelier", label: "Accès Atelier", price: "15,99 €", desc: "Détails complets, contact prioritaire et 1 relance incluse." },
  { id: "signature", label: "Accès Signature", price: "24,99 €", desc: "Exclusivité temporaire de 48h sur le projet et 3 relances incluses." }
] as const;

export default function Atelier() {
  const [, params] = useRoute("/atelier/:slug");
  const slug = params?.slug || "";
  const queryClient = useQueryClient();

  const sessionKey = `novaluth_session_${slug}`;
  const [sessionToken, setSessionToken] = useState<string>(() => localStorage.getItem(sessionKey) || "");
  const [demoCode, setDemoCode] = useState("");

  const openSession = useOpenAtelierSession();

  const handleOpenSession = (e: React.FormEvent) => {
    e.preventDefault();
    openSession.mutate(
      { slug, data: { code_demo: demoCode || undefined } },
      {
        onSuccess: (data) => {
          localStorage.setItem(sessionKey, data.session);
          setSessionToken(data.session);
          toast.success("Session de démonstration ouverte avec succès.");
        },
        onError: () => {
          toast.error("Impossible d'ouvrir la session. Code invalide ou atelier non trouvé.");
        }
      }
    );
  };

  const handleLogout = () => {
    localStorage.removeItem(sessionKey);
    setSessionToken("");
    queryClient.removeQueries({ queryKey: getGetAtelierDashboardQueryKey(slug) });
    queryClient.removeQueries({ queryKey: getListAtelierProjectsQueryKey(slug) });
    queryClient.removeQueries({ queryKey: getListProtectedOrdersQueryKey(slug) });
  };

  // Only fetch if sessionToken exists
  const { data: dashboard, isLoading: isLoadingDashboard, isError: isErrorDashboard } = useGetAtelierDashboard(slug, {
    query: {
      enabled: !!sessionToken,
      queryKey: getGetAtelierDashboardQueryKey(slug),
      retry: false
    },
    request: { headers: { "X-NovaLuth-Atelier-Session": sessionToken } }
  });

  const { data: projects, isLoading: isLoadingProjects } = useListAtelierProjects(slug, {
    query: {
      enabled: !!sessionToken,
      queryKey: getListAtelierProjectsQueryKey(slug),
      retry: false
    },
    request: { headers: { "X-NovaLuth-Atelier-Session": sessionToken } }
  });

  const { data: orders = [], isLoading: isLoadingOrders } = useListProtectedOrders(slug, {
    query: {
      enabled: !!sessionToken,
      queryKey: getListProtectedOrdersQueryKey(slug),
      retry: false,
    },
    request: { headers: { "X-NovaLuth-Atelier-Session": sessionToken } },
  });

  useEffect(() => {
    if (isErrorDashboard) {
      toast.error("Session expirée ou invalide.");
      handleLogout();
    }
  }, [isErrorDashboard]);

  if (!sessionToken) {
    return (
      <div className="container max-w-lg mx-auto px-4 py-24">
        <Card className="border-primary/20 shadow-[0_0_40px_rgba(168,85,247,0.15)] bg-card/50 backdrop-blur-sm">
          <CardHeader className="text-center space-y-4">
            <div className="mx-auto w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-2">
              <Zap className="h-8 w-8 text-primary" />
            </div>
            <CardTitle className="text-3xl font-serif text-primary uppercase tracking-widest">Espace Artisan</CardTitle>
            <CardDescription className="text-base">
              Accédez à votre tableau de bord de démonstration pour l'atelier <span className="font-semibold text-foreground">{slug}</span>.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleOpenSession} className="space-y-6">
              <div className="space-y-2">
                <label htmlFor="code_demo" className="text-sm text-muted-foreground font-medium">Code de démonstration (optionnel)</label>
                <Input
                  id="code_demo"
                  placeholder="Laissez vide pour l'accès standard"
                  value={demoCode}
                  onChange={(e) => setDemoCode(e.target.value)}
                  className="h-12 bg-background border-border"
                />
              </div>
              <Button
                type="submit"
                className="w-full h-12 text-base font-semibold"
                disabled={openSession.isPending}
              >
                {openSession.isPending ? <Loader2 className="h-5 w-5 animate-spin mr-2" /> : <ShieldCheck className="h-5 w-5 mr-2" />}
                Ouvrir la session
              </Button>
            </form>
          </CardContent>
          <CardFooter className="text-xs text-muted-foreground text-center">
            Il s'agit d'un environnement de démonstration. Aucune donnée réelle de facturation n'est requise.
          </CardFooter>
        </Card>
      </div>
    );
  }

  if (isLoadingDashboard || isLoadingProjects || isLoadingOrders) {
    return (
      <div className="container mx-auto px-4 py-24 flex flex-col items-center justify-center gap-4">
        <Loader2 className="h-12 w-12 text-primary animate-spin" />
        <p className="text-muted-foreground animate-pulse">Chargement de votre espace sécurisé...</p>
      </div>
    );
  }

  if (!dashboard || !projects) return null;

  return (
    <div className="min-h-screen bg-background pb-24">
      <header className="bg-card border-b border-border/50 pt-12 pb-8 sticky top-0 z-40">
        <div className="container mx-auto px-4">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
            <div>
              <p className="text-sm text-muted-foreground uppercase tracking-wider font-semibold mb-1 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
                Session Active
              </p>
              <h1 className="text-3xl md:text-4xl font-serif text-primary">
                Atelier {dashboard.atelier_nom}
              </h1>
            </div>
            <div className="flex items-center gap-4">
              <div className="text-right">
                <p className="text-sm text-muted-foreground">Places restantes</p>
                <p className="text-2xl font-bold font-serif">{dashboard.places_restantes}</p>
              </div>
              <div className="h-10 w-px bg-border/50 mx-2"></div>
              <Button variant="outline" onClick={handleLogout} className="border-border hover:bg-muted">
                Déconnexion
              </Button>
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 mt-8">
        <Tabs defaultValue="projects" className="w-full">
             <TabsList className="grid w-full grid-cols-3 max-w-[780px] mb-8 bg-card border border-border">
            <TabsTrigger value="projects" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              Projets Compatibles
            </TabsTrigger>
            <TabsTrigger value="requests" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              Mes Demandes ({dashboard.demandes.length})
            </TabsTrigger>
            <TabsTrigger value="orders" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              Commandes ({orders.length})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="projects" className="space-y-6">
            <div className="mb-6">
              <h2 className="text-2xl font-serif mb-2">Projets de musiciens</h2>
              <p className="text-muted-foreground">Ces projets correspondent à votre profil sonore et à vos critères logistiques.</p>
            </div>

            {projects.length === 0 ? (
              <Card className="border-dashed border-border bg-card/30 p-12 text-center">
                <Music className="h-12 w-12 text-muted-foreground mx-auto mb-4 opacity-50" />
                <h3 className="text-lg font-medium text-foreground mb-2">Aucun projet compatible pour le moment</h3>
                <p className="text-muted-foreground text-sm max-w-md mx-auto">
                  De nouveaux projets sont régulièrement soumis. Les musiciens dont les critères correspondent à votre fiche apparaîtront ici.
                </p>
              </Card>
            ) : (
              <div className="grid lg:grid-cols-2 gap-6">
                {projects.map((project) => (
                  <ProjectCard 
                    key={project.reference} 
                    project={project} 
                    slug={slug} 
                    sessionToken={sessionToken} 
                    existingRequest={dashboard.demandes.find(d => d.reference_projet === project.reference)}
                  />
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="requests" className="space-y-6">
            <div className="mb-6">
              <h2 className="text-2xl font-serif mb-2">Suivi des demandes</h2>
              <p className="text-muted-foreground">Gérez vos demandes d'accès et vos relances.</p>
            </div>

            {dashboard.demandes.length === 0 && dashboard.carnets.length === 0 ? (
              <Card className="border-dashed border-border bg-card/30 p-12 text-center">
                <Briefcase className="h-12 w-12 text-muted-foreground mx-auto mb-4 opacity-50" />
                <h3 className="text-lg font-medium text-foreground mb-2">Aucune demande ou carnet en cours</h3>
                <p className="text-muted-foreground text-sm max-w-md mx-auto">
                  Parcourez l'onglet "Projets Compatibles" pour envoyer des offres d'accès aux musiciens.
                </p>
              </Card>
            ) : (
              <div className="space-y-4">
                {dashboard.demandes.map((demande) => (
                  <RequestRow 
                    key={demande.id} 
                    demande={demande} 
                    slug={slug} 
                    sessionToken={sessionToken} 
                  />
                ))}
                {dashboard.carnets.map((carnet) => (
                  <RequestRow
                    key={carnet.id}
                    demande={carnet}
                    slug={slug}
                    sessionToken={sessionToken}
                  />
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="orders" className="space-y-6">
            <ProtectedOrdersTab slug={slug} sessionToken={sessionToken} orders={orders} />
          </TabsContent>

        </Tabs>
      </main>
    </div>
  );
}

function ProtectedOrdersTab({
  slug,
  sessionToken,
  orders,
}: {
  slug: string;
  sessionToken: string;
  orders: ProtectedOrder[];
}) {
  const queryClient = useQueryClient();
  const createOrder = useCreateProtectedOrder();
  const cancelOrder = useCancelProtectedOrderByAtelier();
  const [form, setForm] = useState({
    email_musicien: "",
    email_atelier: "",
    prix_instrument_eur: "",
    acompte_eur: "",
    reference_devis: "",
    reference_projet: "",
    description: "",
    date_livraison_annoncee: "",
  });
  const [confirmationLink, setConfirmationLink] = useState("");

  const update = (key: keyof typeof form, value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  const handleCreate = (event: React.FormEvent) => {
    event.preventDefault();
    const data: ProtectedOrderInput = {
      session: sessionToken,
      email_musicien: form.email_musicien.trim(),
      email_atelier: form.email_atelier.trim(),
      prix_instrument_eur: Number(form.prix_instrument_eur),
      acompte_eur: form.acompte_eur ? Number(form.acompte_eur) : undefined,
      reference_devis: form.reference_devis.trim() || undefined,
      reference_projet: form.reference_projet.trim() || undefined,
      description: form.description.trim() || undefined,
      date_livraison_annoncee: form.date_livraison_annoncee || undefined,
    };
    createOrder.mutate(
      { slug, data },
      {
        onSuccess: (result) => {
          setConfirmationLink(result.lien_confirmation);
          setForm((current) => ({
            ...current,
            email_musicien: "",
            prix_instrument_eur: "",
            acompte_eur: "",
            reference_devis: "",
            reference_projet: "",
            description: "",
            date_livraison_annoncee: "",
          }));
          queryClient.invalidateQueries({ queryKey: getListProtectedOrdersQueryKey(slug) });
          toast.success("Commande déclarée. Le lien privé est prêt à transmettre.");
        },
        onError: () => toast.error("Impossible de déclarer cette commande. Vérifiez les données et les doublons."),
      },
    );
  };

  const handleCancel = (order: ProtectedOrder) => {
    if (!window.confirm(`Annuler la commande ${order.reference} ?`)) return;
    cancelOrder.mutate(
      { slug, orderId: order.id, data: { session: sessionToken } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListProtectedOrdersQueryKey(slug) });
          toast.success("Commande annulée.");
        },
        onError: () => toast.error("Cette commande ne peut plus être annulée."),
      },
    );
  };

  const publicPath = (path: string) =>
    `${import.meta.env.BASE_URL}${path.replace(/^\/+/, "")}`;

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
      <Card className="border-primary/20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 font-serif">
            <PackageCheck className="h-5 w-5 text-primary" /> Déclarer une commande
          </CardTitle>
          <CardDescription>
            La déclaration ne débite rien. Le musicien reçoit un lien privé valable 7 jours pour confirmer ou refuser.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="E-mail du musicien" type="email" required value={form.email_musicien} onChange={(value) => update("email_musicien", value)} />
              <Field label="Votre e-mail" type="email" required value={form.email_atelier} onChange={(value) => update("email_atelier", value)} />
              <Field label="Prix de l’instrument (€)" type="number" min="0.01" step="0.01" required value={form.prix_instrument_eur} onChange={(value) => update("prix_instrument_eur", value)} />
              <Field label="Acompte indicatif (€)" type="number" min="0" step="0.01" value={form.acompte_eur} onChange={(value) => update("acompte_eur", value)} />
              <Field label="Référence devis" value={form.reference_devis} onChange={(value) => update("reference_devis", value)} />
              <Field label="Référence projet (facultatif)" value={form.reference_projet} onChange={(value) => update("reference_projet", value)} />
              <Field label="Date de livraison annoncée" type="date" value={form.date_livraison_annoncee} onChange={(value) => update("date_livraison_annoncee", value)} />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Description</label>
              <Textarea value={form.description} onChange={(event) => update("description", event.target.value)} placeholder="Modèle, spécifications, engagements convenus…" rows={4} />
            </div>
            <Button type="submit" className="w-full" disabled={createOrder.isPending}>
              {createOrder.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Déclarer sans débit
            </Button>
          </form>
          {confirmationLink && (
            <div className="mt-5 rounded-lg border border-green-500/30 bg-green-500/5 p-4">
              <p className="mb-2 flex items-center gap-2 text-sm font-medium text-green-700 dark:text-green-400">
                <Link2 className="h-4 w-4" /> Lien privé de confirmation
              </p>
              <a className="break-all text-xs text-primary underline" href={publicPath(confirmationLink)}>
                {window.location.origin}{publicPath(confirmationLink)}
              </a>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => navigator.clipboard.writeText(`${window.location.origin}${publicPath(confirmationLink)}`)}>
                Copier le lien
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="space-y-4">
        <div>
          <h2 className="text-2xl font-serif">Commandes protégées</h2>
          <p className="text-muted-foreground">Suivez les confirmations, les délais de réception et les paiements simulés.</p>
        </div>
        {orders.length === 0 ? (
          <Card className="border-dashed border-border bg-card/30 p-10 text-center">
            <PackageCheck className="mx-auto mb-4 h-10 w-10 text-muted-foreground opacity-50" />
            <p className="font-medium">Aucune commande protégée</p>
            <p className="mt-1 text-sm text-muted-foreground">La première déclaration apparaîtra ici.</p>
          </Card>
        ) : (
          orders.map((order) => (
            <Card key={order.id} className="border-border">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle className="font-serif text-lg">{order.reference}</CardTitle>
                    <CardDescription>{order.email_musicien} · {order.prix_instrument_eur.toLocaleString("fr-FR")} €</CardDescription>
                  </div>
                  <Badge variant="outline">{order.statut.replaceAll("_", " ")}</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="grid gap-2 sm:grid-cols-2">
                  <span className="text-muted-foreground">Engagement : <strong className="text-foreground">{order.paiement_engagement}</strong></span>
                  <span className="text-muted-foreground">Commission : <strong className="text-foreground">{order.paiement_commission}</strong></span>
                  <span className="text-muted-foreground">Confirmation avant : <strong className="text-foreground">{format(parseISO(order.echeance_confirmation), "d MMM yyyy", { locale: fr })}</strong></span>
                  {order.date_livraison_annoncee && <span className="text-muted-foreground">Livraison : <strong className="text-foreground">{format(parseISO(order.date_livraison_annoncee), "d MMM yyyy", { locale: fr })}</strong></span>}
                </div>
                {order.peut_annuler_atelier && (
                  <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={() => handleCancel(order)} disabled={cancelOrder.isPending}>
                    Annuler la commande
                  </Button>
                )}
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  testId,
  required,
  type = "text",
  min,
  step,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  testId?: string;
  required?: boolean;
  type?: string;
  min?: string;
  step?: string;
}) {
  return (
    <div className="space-y-2">
      <label className="text-sm font-medium">{label}</label>
       <Input data-testid={testId} type={type} min={min} step={step} required={required} value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}

function ProjectCard({ project, slug, sessionToken, existingRequest }: { project: AtelierProject, slug: string, sessionToken: string, existingRequest?: AtelierAccessRequest }) {
  const [selectedOffer, setSelectedOffer] = useState<(typeof OFFRES)[number]["id"]>("essentiel");
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const queryClient = useQueryClient();
  const createRequest = useCreateAtelierAccessRequest();

  const handleSendRequest = () => {
    createRequest.mutate(
      { slug, data: { session: sessionToken, reference_projet: project.reference, offre: selectedOffer } },
      {
        onSuccess: () => {
          toast.success("Demande d'accès envoyée au musicien !");
          setIsDialogOpen(false);
          queryClient.invalidateQueries({ queryKey: getGetAtelierDashboardQueryKey(slug) });
          queryClient.invalidateQueries({ queryKey: getListAtelierProjectsQueryKey(slug) });
        },
        onError: () => {
          toast.error("Impossible d'envoyer la demande. Veuillez réessayer.");
        }
      }
    );
  };

  return (
    <Card className="overflow-hidden border-border bg-card flex flex-col transition-all hover:border-primary/30">
      <CardHeader className="bg-muted/30 border-b border-border/50">
        <div className="flex justify-between items-start gap-4">
          <div>
            <Badge variant="outline" className="mb-3 border-primary/20 text-primary bg-primary/5 uppercase tracking-widest text-[10px]">
              {project.type_instrument}
            </Badge>
            <CardTitle className="text-xl font-serif text-foreground">Projet {project.reference.substring(0, 8)}...</CardTitle>
          </div>
          <div className="text-right shrink-0">
            <span className="text-xs text-muted-foreground block mb-1">Budget</span>
            <span className="font-semibold text-accent">{project.budget_min_eur}€ - {project.budget_max_eur}€</span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex-1 p-6 space-y-6">
        <div>
          <h4 className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-2">Description du musicien</h4>
          <p className="text-sm text-foreground/80 leading-relaxed italic line-clamp-3">
            "{project.description || "Aucune description libre fournie pour ce projet."}"
          </p>
        </div>

        <div>
          <h4 className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-2">Styles de prédilection</h4>
          <div className="flex flex-wrap gap-1.5">
            {project.styles.map((style) => (
              <Badge key={style} variant="secondary" className="bg-secondary/50 text-secondary-foreground text-xs font-normal">
                {style}
              </Badge>
            ))}
          </div>
        </div>
        
        <div className="text-xs text-muted-foreground flex items-center gap-1.5 pt-4 border-t border-border/50">
          <CalendarDays className="h-3.5 w-3.5" /> Soumis le {format(parseISO(project.cree_le), "d MMMM yyyy", { locale: fr })}
        </div>
      </CardContent>
      <CardFooter className="p-6 pt-0 mt-auto border-t border-border/10 bg-muted/10">
        {existingRequest ? (
          <div className="w-full flex items-center justify-between p-3 bg-secondary/30 rounded border border-border">
            <div className="flex items-center gap-2">
              <StatusIcon statut={existingRequest.statut} />
              <span className="text-sm font-medium capitalize">{existingRequest.statut.replace('_', ' ')}</span>
            </div>
            <Badge variant="outline" className="text-xs">{existingRequest.offre}</Badge>
          </div>
        ) : (
          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogTrigger asChild>
              <Button className="w-full bg-primary hover:bg-primary/90 text-primary-foreground">
                Demander l'accès à ce projet
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl bg-card border-border">
              <DialogHeader>
                <DialogTitle className="text-2xl font-serif text-primary">Proposer un accès</DialogTitle>
                <DialogDescription>
                  Sélectionnez une offre pour contacter ce musicien. 
                  <br />
                  <strong className="text-foreground mt-2 block">
                    Important : Cette autorisation est une simulation de pré-autorisation. Aucun montant ne sera débité tant que le musicien n'aura pas formellement accepté votre demande d'accès.
                  </strong>
                </DialogDescription>
              </DialogHeader>

              <div className="grid gap-4 py-4">
                {OFFRES.map((offre) => (
                  <div 
                    key={offre.id}
                    className={`relative flex items-start space-x-4 border rounded-lg p-4 cursor-pointer transition-all ${selectedOffer === offre.id ? 'border-primary bg-primary/5 shadow-[0_0_15px_rgba(168,85,247,0.1)]' : 'border-border bg-background hover:border-primary/50'}`}
                    onClick={() => setSelectedOffer(offre.id)}
                  >
                    <div className="mt-1 flex-shrink-0">
                      <div className={`w-5 h-5 rounded-full border flex items-center justify-center ${selectedOffer === offre.id ? 'border-primary' : 'border-muted-foreground'}`}>
                        {selectedOffer === offre.id && <div className="w-2.5 h-2.5 rounded-full bg-primary" />}
                      </div>
                    </div>
                    <div className="flex-1">
                      <div className="flex justify-between items-center mb-1">
                        <h4 className="font-semibold text-foreground text-lg">{offre.label}</h4>
                        <span className="font-bold text-accent">{offre.price}</span>
                      </div>
                      <p className="text-sm text-muted-foreground">{offre.desc}</p>
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex justify-end gap-3 mt-4 pt-4 border-t border-border">
                <Button variant="outline" onClick={() => setIsDialogOpen(false)}>Annuler</Button>
                <Button 
                  onClick={handleSendRequest}
                  disabled={createRequest.isPending}
                  className="bg-primary"
                >
                  {createRequest.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Confirmer la pré-autorisation
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        )}
      </CardFooter>
    </Card>
  );
}

function RequestRow({ demande, slug, sessionToken }: { demande: AtelierAccessRequest, slug: string, sessionToken: string }) {
  const queryClient = useQueryClient();
  const cancelReq = useCancelAtelierAccessRequest();
  const followupReq = useUseAtelierFollowupCredit();

  const handleCancel = () => {
    if (confirm("Êtes-vous sûr de vouloir annuler cette demande d'accès ? La pré-autorisation sera levée.")) {
      cancelReq.mutate(
        { slug, requestId: demande.id, data: { session: sessionToken } },
        {
          onSuccess: () => {
            toast.success("Demande annulée avec succès.");
            queryClient.invalidateQueries({ queryKey: getGetAtelierDashboardQueryKey(slug) });
                queryClient.invalidateQueries({ queryKey: getListAtelierProjectsQueryKey(slug) });
          }
        }
      );
    }
  };

  const handleFollowup = () => {
    followupReq.mutate(
      { slug, requestId: demande.id, data: { session: sessionToken } },
      {
        onSuccess: () => {
          toast.success("Relance envoyée au musicien.");
          queryClient.invalidateQueries({ queryKey: getGetAtelierDashboardQueryKey(slug) });
        }
      }
    );
  };

  return (
    <div className="flex flex-col md:flex-row items-center justify-between gap-4 p-4 border border-border/50 bg-card hover:bg-muted/10 transition-colors">
      <div className="flex items-center gap-6 flex-1 w-full">
        <div className="flex flex-col items-center justify-center p-3 bg-background border border-border rounded w-20 shrink-0">
          <span className="text-xs text-muted-foreground mb-1 block">Offre</span>
          <span className="font-semibold text-accent capitalize">{demande.offre}</span>
        </div>
        
        <div className="space-y-1 flex-1">
          <div className="flex items-center gap-3">
            <span className="font-serif text-lg text-foreground">Projet {demande.reference_projet.substring(0, 8)}</span>
            <Badge variant="outline" className="text-[10px] bg-background">
              {demande.montant_eur}€
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground flex items-center gap-1.5">
            <CalendarDays className="h-3 w-3" /> Créée le {format(parseISO(demande.cree_le), "dd/MM/yyyy")}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap md:flex-nowrap items-center gap-4 md:w-auto w-full justify-between md:justify-end">
        <div className="flex flex-col items-end mr-4">
          <div className="flex items-center gap-2 mb-1">
            <StatusIcon statut={demande.statut} />
            <span className="text-sm font-medium capitalize">{demande.statut.replace('_', ' ')}</span>
          </div>
          <span className="text-xs text-muted-foreground">Paiement : <span className="capitalize">{demande.statut_paiement}</span></span>
          {demande.expire_le && (
            <span className="text-xs text-muted-foreground">
              {demande.statut === "expiree" ? "Expiré" : "Accès jusqu’au"} {format(parseISO(demande.expire_le), "dd/MM/yyyy")}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {demande.statut === 'en_attente' && (
            <>
              <Button 
                variant="ghost" 
                size="sm" 
                onClick={handleCancel}
                disabled={cancelReq.isPending}
                className="h-9 text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                {cancelReq.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
              </Button>
            </>
          )}
          
          {demande.statut === 'acceptee' && demande.credits_relance > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleFollowup}
              disabled={followupReq.isPending}
              className="h-9 border-primary text-primary hover:bg-primary/10"
            >
              {followupReq.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4 mr-2" />}
              Relancer ({demande.credits_relance})
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusIcon({ statut }: { statut: string }) {
  switch (statut) {
    case 'en_attente':
      return <span className="relative flex h-2.5 w-2.5"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-yellow-400 opacity-75"></span><span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-yellow-500"></span></span>;
    case 'acceptee':
      return <CheckCircle2 className="h-4 w-4 text-green-500" />;
    case 'refusee':
    case 'annulee':
    case 'expiree':
      return <XCircle className="h-4 w-4 text-muted-foreground" />;
    default:
      return <div className="h-2 w-2 rounded-full bg-muted-foreground" />;
  }
}
