import { useState, useEffect } from "react";
import { useGetAdminSummary, useRunAccessMaintenance, useUpdateFicheStatus, StatusUpdateStatut, getGetAdminSummaryQueryKey } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { 
  Table, 
  TableBody, 
  TableCell, 
  TableHead, 
  TableHeader, 
  TableRow 
} from "@/components/ui/table";
import { ShieldAlert, RefreshCw, Check, X, AlertCircle } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

export default function Admin() {
  const [token, setToken] = useState("");
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  
  // Try to load token from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem("novaluth_admin_token");
    if (saved) {
      setToken(saved);
      setIsAuthenticated(true);
    }
  }, []);

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (token.trim()) {
      localStorage.setItem("novaluth_admin_token", token);
      setIsAuthenticated(true);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem("novaluth_admin_token");
    setToken("");
    setIsAuthenticated(false);
  };

  if (!isAuthenticated) {
    return (
      <div className="min-h-[70vh] flex flex-col items-center justify-center container mx-auto px-4">
        <div className="bg-card border border-border/50 p-8 max-w-md w-full text-center space-y-6">
          <ShieldAlert className="h-12 w-12 text-primary mx-auto" />
          <h1 className="text-2xl font-serif text-primary">Accès Restreint</h1>
          <p className="text-muted-foreground text-sm">
            Espace d'administration NovaLuth. Entrez votre jeton d'accès pour continuer (essayez <strong>demo-admin</strong>).
          </p>
          <form onSubmit={handleLogin} className="space-y-4">
            <Input 
              type="password" 
              placeholder="Jeton d'administration..." 
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="rounded-none text-center bg-background"
            />
            <Button type="submit" className="w-full rounded-none">Accéder</Button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <AdminDashboard token={token} onLogout={handleLogout} />
  );
}

function AdminDashboard({ token, onLogout }: { token: string, onLogout: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const { data: summary, isLoading, error, refetch } = useGetAdminSummary({
    request: { headers: { 'X-Admin-Token': token } },
    query: {
      retry: false,
      queryKey: getGetAdminSummaryQueryKey()
    }
  });

  const updateStatus = useUpdateFicheStatus({
    request: { headers: { 'X-Admin-Token': token } }
  });
  const maintenance = useRunAccessMaintenance({
    request: { headers: { 'X-Admin-Token': token } }
  });

  // Handle auth error (401/403)
  useEffect(() => {
    if (error) {
      toast({
        variant: "destructive",
        title: "Erreur d'authentification",
        description: "Votre jeton est invalide ou expiré."
      });
      onLogout();
    }
  }, [error, onLogout, toast]);

  const handleStatusChange = (slug: string, newStatus: StatusUpdateStatut) => {
    updateStatus.mutate(
      { slug, data: { statut: newStatus } },
      {
        onSuccess: () => {
          toast({
            title: "Statut mis à jour",
            description: `La fiche a été passée en ${newStatus}.`,
          });
          refetch();
          queryClient.invalidateQueries({ queryKey: getGetAdminSummaryQueryKey() });
        },
        onError: () => {
          toast({
            variant: "destructive",
            title: "Erreur",
            description: "Impossible de mettre à jour le statut.",
          });
        }
      }
    );
  };

  const handleMaintenance = () => {
    maintenance.mutate(undefined, {
      onSuccess: (result) => {
        toast({
          title: "Entretien terminé",
          description: `${result.annulations} annulation(s), ${result.expirations} expiration(s) et ${result.relances} relance(s) traitées.`,
        });
        queryClient.invalidateQueries({ queryKey: getGetAdminSummaryQueryKey() });
        refetch();
      },
      onError: () => {
        toast({
          variant: "destructive",
          title: "Entretien indisponible",
          description: "Impossible d'exécuter l'entretien des accès pour le moment.",
        });
      },
    });
  };

  if (isLoading) {
    return <div className="container mx-auto px-4 py-16 text-center">Chargement des données administrateur...</div>;
  }

  if (!summary) return null;

  const sn13Status = {
    jamais: { label: "Aucun appel", className: "text-muted-foreground" },
    succes: { label: "Données reçues", className: "text-green-700" },
    vide: { label: "Réponse vide", className: "text-amber-700" },
    incomplet: { label: "Réponse incomplète", className: "text-orange-700" },
    erreur: { label: "Erreur SN13", className: "text-destructive" },
  }[summary.collecte_sn13.statut] ?? {
    label: summary.collecte_sn13.statut,
    className: "text-muted-foreground",
  };

  return (
    <div className="container mx-auto px-4 py-12">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-12 gap-4">
        <div>
          <h1 className="text-4xl font-serif text-primary mb-2">Administration</h1>
          <p className="text-muted-foreground flex items-center gap-2">
            Connecté via passerelle : <Badge variant="outline">{summary.passerelle}</Badge>
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => refetch()} className="rounded-none">
            <RefreshCw className="h-4 w-4 mr-2" /> Actualiser
          </Button>
          <Button variant="ghost" size="sm" onClick={onLogout} className="text-destructive hover:bg-destructive/10">
            Déconnexion
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-12">
        {Object.entries(summary.compteurs).map(([status, count]) => (
          <div key={status} className="bg-card border border-border/50 p-6 flex flex-col items-center justify-center text-center">
            <span className="text-3xl font-serif text-primary mb-1">{count}</span>
            <span className="text-xs uppercase tracking-wider text-muted-foreground">{status.replace(/_/g, ' ')}</span>
          </div>
        ))}
      </div>

        <section className="bg-card border border-border/50 p-6 mb-12">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-5 mb-6">
            <div>
              <h2 className="text-xl font-serif text-primary">Accès ateliers</h2>
              <p className="text-sm text-muted-foreground">
                Préautorisations simulées, carnets actifs et entretien quotidien.
              </p>
            </div>
            <Button variant="outline" onClick={handleMaintenance} disabled={maintenance.isPending}>
              <RefreshCw className={`h-4 w-4 mr-2 ${maintenance.isPending ? "animate-spin" : ""}`} />
              Exécuter l'entretien
            </Button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {[
              ["En attente", summary.acces.en_attente],
              ["Carnets actifs", summary.acces.acceptees],
              ["Expirés", summary.acces.expirees],
              ["Préautorisés", summary.acces.preautorisations],
              ["Encaissements", summary.acces.encaissements],
            ].map(([label, count]) => (
              <div key={String(label)} className="border border-border/50 bg-background p-3">
                <span className="block text-2xl font-serif text-primary">{count}</span>
                <span className="text-[0.68rem] uppercase tracking-wider text-muted-foreground">{label}</span>
              </div>
            ))}
          </div>
        </section>

      <section className="bg-card border border-border/50 p-6 mb-12">
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4 mb-5">
          <div>
            <h2 className="text-xl font-serif text-primary">Collecte SN13</h2>
            <p className="text-sm text-muted-foreground">
              Dernier appel distant ; le secours local reste non publiant.
            </p>
          </div>
          <Badge variant="outline" className={`rounded-none ${sn13Status.className}`}>
            {sn13Status.label}
          </Badge>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
          <div className="border border-border/50 bg-background p-3">
            <span className="block text-xs uppercase tracking-wider text-muted-foreground mb-1">
              Identifiant de requête
            </span>
            <span className="font-mono text-xs break-all">
              {summary.collecte_sn13.requete_id ?? "—"}
            </span>
          </div>
          <div className="border border-border/50 bg-background p-3">
            <span className="block text-xs uppercase tracking-wider text-muted-foreground mb-1">
              Appelé le
            </span>
            <span>
              {summary.collecte_sn13.appele_le
                ? new Date(summary.collecte_sn13.appele_le).toLocaleString("fr-FR")
                : "—"}
            </span>
          </div>
          <div className="border border-border/50 bg-background p-3">
            <span className="block text-xs uppercase tracking-wider text-muted-foreground mb-1">
              Publications
            </span>
            <span>{summary.collecte_sn13.nombre ?? "—"}</span>
          </div>
        </div>
        <div className="mt-4 border border-border/50 bg-background p-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-3">
            <span className="text-xs uppercase tracking-wider text-muted-foreground">
              Suivi des {summary.collecte_sn13.recents.fenetre_heures} dernières heures
            </span>
            <Badge
              variant="outline"
              className={`rounded-none ${
                summary.collecte_sn13.recents.alerte ? "text-orange-700" : "text-green-700"
              }`}
            >
              {summary.collecte_sn13.recents.alerte ? "Surveillance requise" : "Suivi normal"}
            </Badge>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
            {[
              ["Appels", summary.collecte_sn13.recents.total],
              ["Données", summary.collecte_sn13.recents.succes],
              ["Vides", summary.collecte_sn13.recents.vide],
              ["Incomplètes", summary.collecte_sn13.recents.incomplet],
              ["Erreurs", summary.collecte_sn13.recents.erreur],
            ].map(([label, count]) => (
              <div key={String(label)} className="border border-border/50 p-3">
                <span className="block text-2xl font-serif text-primary">{count}</span>
                <span className="text-[0.68rem] uppercase tracking-wider text-muted-foreground">{label}</span>
              </div>
            ))}
          </div>
        </div>
        {summary.collecte_sn13.corps_erreur ? (
          <div className="mt-4 border border-destructive/30 bg-destructive/5 p-4">
            <span className="block text-xs uppercase tracking-wider text-destructive mb-2">
              Corps d’erreur (secret masqué)
            </span>
            <pre className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
              {summary.collecte_sn13.corps_erreur}
            </pre>
          </div>
        ) : null}
      </section>

      <div className="bg-card border border-border/50">
        <div className="p-6 border-b border-border/50 flex justify-between items-center">
          <h2 className="text-xl font-serif text-primary flex items-center gap-2">
            <AlertCircle className="h-5 w-5" />
            File d'attente
          </h2>
          <Badge className="rounded-none">{summary.fiches.length} profils</Badge>
        </div>
        
        {summary.fiches.length === 0 ? (
          <div className="p-12 text-center text-muted-foreground">
            Aucun profil en attente de modération.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="border-border/50 hover:bg-transparent">
                <TableHead>Artisan</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Localisation</TableHead>
                <TableHead>Statut Actuel</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {summary.fiches.map((fiche) => (
                <TableRow key={fiche.slug} className="border-border/50">
                  <TableCell className="font-medium text-primary">{fiche.nom}</TableCell>
                  <TableCell className="text-muted-foreground text-sm capitalize">{fiche.type.replace('_', ' ')}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {fiche.ville ? `${fiche.ville}, ` : ''}{fiche.pays}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary" className="rounded-none bg-secondary/30">
                      {fiche.statut.replace(/_/g, ' ')}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button 
                        size="sm" 
                        variant="outline" 
                        className="h-8 rounded-none border-green-700 text-green-700 hover:bg-green-700/10"
                        onClick={() => handleStatusChange(fiche.slug, StatusUpdateStatut.publiee)}
                        disabled={updateStatus.isPending}
                      >
                        <Check className="h-4 w-4 mr-1" /> Publier
                      </Button>
                      <Button 
                        size="sm" 
                        variant="outline" 
                        className="h-8 rounded-none border-destructive text-destructive hover:bg-destructive/10"
                        onClick={() => handleStatusChange(fiche.slug, StatusUpdateStatut.rejetee)}
                        disabled={updateStatus.isPending}
                      >
                        <X className="h-4 w-4 mr-1" /> Rejeter
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}