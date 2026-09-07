import { useState, useEffect } from "react";
import { useGetAdminSummary, useGetSn13PurgeIncidents, useRunAccessMaintenance, useUpdateFicheStatus, StatusUpdateStatut, getGetAdminSummaryQueryKey, getGetSn13PurgeIncidentsQueryKey, useListMeetAccounts, useCreateMeetAccount, useUpdateMeetAccount, useResetMeetAccountPassword, getListMeetAccountsQueryKey, CreateMeetAccountRole, useListProspectionDossiers, useGetProspectionDossier, useCorrectProspectionDossier, useValidateProspectionProposal, useWithdrawProspectionProposal, useMarkProspectionDossier, getListProspectionDossiersQueryKey, getGetProspectionDossierQueryKey, ProspectionManualMarkState, useLoginMeetAccount, ProspectionCorrectionHookOrigin } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { 
  Table, 
  TableBody, 
  TableCell, 
  TableHead, 
  TableHeader, 
  TableRow 
} from "@/components/ui/table";
import { ShieldAlert, RefreshCw, Check, X, AlertCircle, CircleCheck, TriangleAlert } from "lucide-react";
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
  const [newAccountLogin, setNewAccountLogin] = useState("");
  const [newAccountName, setNewAccountName] = useState("");
  const [newAccountRole, setNewAccountRole] = useState<CreateMeetAccountRole>(CreateMeetAccountRole.musicien);
  const [newAccountAtelier, setNewAccountAtelier] = useState("");
  const [temporaryPassword, setTemporaryPassword] = useState("");
  
  const { data: summary, isLoading, error, refetch } = useGetAdminSummary({
    request: { headers: { 'X-Admin-Token': token } },
    query: {
      retry: false,
      queryKey: getGetAdminSummaryQueryKey()
    }
  });
  const { data: purgeHistory, refetch: refetchPurgeHistory } = useGetSn13PurgeIncidents({
    request: { headers: { "X-Admin-Token": token } },
    query: { retry: false, queryKey: getGetSn13PurgeIncidentsQueryKey() },
  });

  const updateStatus = useUpdateFicheStatus({
    request: { headers: { 'X-Admin-Token': token } }
  });
  const maintenance = useRunAccessMaintenance({
    request: { headers: { 'X-Admin-Token': token } }
  });
  const meetAccounts = useListMeetAccounts({
    request: { headers: { "X-Admin-Token": token } },
    query: { retry: false, queryKey: getListMeetAccountsQueryKey() },
  });
  const createMeetAccount = useCreateMeetAccount({
    request: { headers: { "X-Admin-Token": token } },
  });
  const updateMeetAccount = useUpdateMeetAccount({
    request: { headers: { "X-Admin-Token": token } },
  });
  const resetMeetAccountPassword = useResetMeetAccountPassword({
    request: { headers: { "X-Admin-Token": token } },
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

  const handleCreateMeetAccount = (event: React.FormEvent) => {
    event.preventDefault();
    createMeetAccount.mutate(
      {
        data: {
          login: newAccountLogin,
          displayName: newAccountName,
          role: newAccountRole,
          atelierSlug: newAccountAtelier.trim() || null,
        },
      },
      {
        onSuccess: (result) => {
          setNewAccountLogin("");
          setNewAccountName("");
          setNewAccountAtelier("");
          setTemporaryPassword(result.temporaryPassword);
          queryClient.invalidateQueries({ queryKey: getListMeetAccountsQueryKey() });
          toast({
            title: "Accès Meet créé",
            description: "Copiez le mot de passe temporaire et transmettez-le au titulaire.",
          });
        },
        onError: () => toast({
          variant: "destructive",
          title: "Création impossible",
          description: "Vérifiez l’identifiant, le rôle et le lien atelier.",
        }),
      },
    );
  };

  const handleToggleMeetAccount = (accountId: number, active: boolean) => {
    updateMeetAccount.mutate(
      { accountId, data: { active: !active } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListMeetAccountsQueryKey() });
          toast({ title: active ? "Accès désactivé" : "Accès réactivé" });
        },
        onError: () => toast({
          variant: "destructive",
          title: "Modification impossible",
          description: "L’état du compte n’a pas été modifié.",
        }),
      },
    );
  };

  const handleResetMeetAccount = (accountId: number) => {
    resetMeetAccountPassword.mutate(
      { accountId },
      {
        onSuccess: (result) => {
          setTemporaryPassword(result.temporaryPassword);
          toast({
            title: "Mot de passe réinitialisé",
            description: "Le nouveau mot de passe est affiché une seule fois.",
          });
        },
        onError: () => toast({
          variant: "destructive",
          title: "Réinitialisation impossible",
          description: "Le compte Meet est introuvable ou inaccessible.",
        }),
      },
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
        queryClient.invalidateQueries({ queryKey: getGetSn13PurgeIncidentsQueryKey() });
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
  const purgeStatus = summary.purge_sn13.statut === "erreur"
    ? {
        label: "Purge en échec",
        className: "text-destructive border-destructive/40",
        panelClassName: "border-destructive/40 bg-destructive/5",
        Icon: TriangleAlert,
      }
    : {
        label: "Purge opérationnelle",
        className: "text-green-700 border-green-700/40",
        panelClassName: "border-green-700/30 bg-green-700/5",
        Icon: CircleCheck,
      };
  const PurgeStatusIcon = purgeStatus.Icon;
  const formatDuration = (seconds: number) => {
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes < 60) {
      return remainingSeconds ? `${minutes} min ${remainingSeconds} s` : `${minutes} min`;
    }
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return remainingMinutes ? `${hours} h ${remainingMinutes} min` : `${hours} h`;
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
          <Button variant="outline" size="sm" onClick={() => { refetch(); refetchPurgeHistory(); }} className="rounded-none">
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

      <ProspectionReview />

      <section className="bg-card border border-border/50 p-6 mb-12">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-5 mb-6">
          <div>
            <h2 className="text-xl font-serif text-primary">Accès NovaLuth Meet</h2>
            <p className="text-sm text-muted-foreground">
              Comptes persistants liés aux rôles NovaLuth. Les mots de passe sont hachés et ne sont jamais conservés en clair.
            </p>
          </div>
          <Badge variant="outline" className="rounded-none self-start">
            {meetAccounts.data?.accounts.length ?? 0} compte(s)
          </Badge>
        </div>

        <form onSubmit={handleCreateMeetAccount} className="grid gap-3 border border-border/50 bg-background/40 p-4 md:grid-cols-5 md:items-end">
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Identifiant</span>
            <Input value={newAccountLogin} onChange={(event) => setNewAccountLogin(event.target.value)} placeholder="prenom.nom" required maxLength={80} className="rounded-none" />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Nom affiché</span>
            <Input value={newAccountName} onChange={(event) => setNewAccountName(event.target.value)} placeholder="Prénom Nom" required maxLength={80} className="rounded-none" />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Rôle</span>
            <select value={newAccountRole} onChange={(event) => setNewAccountRole(event.target.value as CreateMeetAccountRole)} className="h-10 w-full rounded-none border border-input bg-background px-3 text-sm">
              <option value={CreateMeetAccountRole.musicien}>Musicien</option>
              <option value={CreateMeetAccountRole.artisan}>Artisan</option>
              <option value={CreateMeetAccountRole.admin}>Administrateur</option>
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Atelier lié <span className="text-xs">(facultatif)</span></span>
            <Input value={newAccountAtelier} onChange={(event) => setNewAccountAtelier(event.target.value)} placeholder="slug-de-l-atelier" maxLength={120} className="rounded-none" />
          </label>
          <Button type="submit" disabled={createMeetAccount.isPending} className="rounded-none">
            {createMeetAccount.isPending ? "Création…" : "Créer l’accès"}
          </Button>
        </form>

        {temporaryPassword && (
          <div className="mt-4 flex flex-col gap-3 border border-amber-500/40 bg-amber-500/10 p-4 text-sm md:flex-row md:items-center md:justify-between">
            <div>
              <p className="font-medium text-amber-800 dark:text-amber-200">Mot de passe temporaire — à transmettre maintenant</p>
              <code className="mt-1 block select-all font-mono text-base text-foreground">{temporaryPassword}</code>
              <p className="mt-1 text-xs text-muted-foreground">Il ne sera plus affiché après fermeture ou actualisation de cette page.</p>
            </div>
            <Button type="button" variant="outline" className="rounded-none" onClick={() => void navigator.clipboard?.writeText(temporaryPassword)}>
              Copier
            </Button>
          </div>
        )}

        {meetAccounts.isLoading ? (
          <p className="py-6 text-sm text-muted-foreground">Chargement des comptes Meet…</p>
        ) : meetAccounts.isError ? (
          <p className="py-6 text-sm text-destructive">La liste des comptes Meet est indisponible.</p>
        ) : (meetAccounts.data?.accounts.length ?? 0) === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">Aucun accès Meet n’a encore été créé.</p>
        ) : (
          <div className="mt-6 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-border/50 hover:bg-transparent">
                  <TableHead>Compte</TableHead>
                  <TableHead>Rôle</TableHead>
                  <TableHead>Atelier</TableHead>
                  <TableHead>État</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {meetAccounts.data?.accounts.map((account) => (
                  <TableRow key={account.id} className="border-border/50">
                    <TableCell>
                      <p className="font-medium text-primary">{account.displayName}</p>
                      <p className="text-xs text-muted-foreground">{account.login}</p>
                    </TableCell>
                    <TableCell className="text-sm capitalize">{account.role}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{account.atelierSlug || "—"}</TableCell>
                    <TableCell>
                      <Badge variant="secondary" className={`rounded-none ${account.active ? "bg-green-700/10 text-green-700" : "bg-muted text-muted-foreground"}`}>
                        {account.active ? "Actif" : "Désactivé"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button type="button" size="sm" variant="outline" className="h-8 rounded-none" disabled={updateMeetAccount.isPending} onClick={() => handleToggleMeetAccount(account.id, account.active)}>
                          {account.active ? "Désactiver" : "Réactiver"}
                        </Button>
                        <Button type="button" size="sm" variant="outline" className="h-8 rounded-none" disabled={resetMeetAccountPassword.isPending || !account.active} onClick={() => handleResetMeetAccount(account.id)}>
                          Réinitialiser
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

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
        <div className="mb-6">
          <h2 className="text-xl font-serif text-primary">Commandes protégées</h2>
          <p className="text-sm text-muted-foreground">
            Suivi des transitions et des encaissements simulés, sans exposition des jetons privés.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
          {[
            ["Déclarées", summary.commandes.declarees],
            ["Confirmées", summary.commandes.confirmees],
            ["Livrées", summary.commandes.livrees],
            ["Annulées/refusées", summary.commandes.annulees],
            ["Non confirmées", summary.commandes.non_confirmees],
            ["Engagements", summary.commandes.engagements],
            ["Commissions", summary.commandes.commissions],
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

      <section className={`bg-card border p-6 mb-12 ${purgeStatus.panelClassName}`}>
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4 mb-5">
          <div className="flex items-start gap-3">
            <PurgeStatusIcon className={`h-5 w-5 mt-0.5 ${purgeStatus.className.split(" ")[0]}`} aria-hidden="true" />
            <div>
              <h2 className="text-xl font-serif text-primary">Purge SN13</h2>
              <p className="text-sm text-muted-foreground">
                Rétention des événements de collecte, sans détail sensible.
              </p>
            </div>
          </div>
          <Badge variant="outline" className={`rounded-none ${purgeStatus.className}`}>
            {purgeStatus.label}
          </Badge>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
          <div className="border border-border/50 bg-background p-3">
            <span className="block text-xs uppercase tracking-wider text-muted-foreground mb-1">
              Épisode actuel
            </span>
            <span className={summary.purge_sn13.episode_actif ? "text-destructive" : "text-green-700"}>
              {summary.purge_sn13.episode_actif ? "Incident en cours" : "Aucun incident"}
            </span>
          </div>
          <div className="border border-border/50 bg-background p-3">
            <span className="block text-xs uppercase tracking-wider text-muted-foreground mb-1">
              Début de l’épisode
            </span>
            <span>
              {summary.purge_sn13.episode_commence_le
                ? new Date(summary.purge_sn13.episode_commence_le).toLocaleString("fr-FR")
                : "—"}
            </span>
          </div>
          <div className="border border-border/50 bg-background p-3">
            <span className="block text-xs uppercase tracking-wider text-muted-foreground mb-1">
              Rétabli le
            </span>
            <span>
              {summary.purge_sn13.retabli_le
                ? new Date(summary.purge_sn13.retabli_le).toLocaleString("fr-FR")
                : "—"}
            </span>
          </div>
        </div>
        <div className="mt-5 border border-border/50 bg-background p-4">
          <div className="flex items-center justify-between gap-3 mb-3">
            <div>
              <h3 className="text-sm font-medium text-primary">Historique récent</h3>
              <p className="text-xs text-muted-foreground">
                Les dix derniers épisodes de panne et de rétablissement.
              </p>
            </div>
            {purgeHistory ? (
              <Badge variant="outline" className="rounded-none">
                {purgeHistory.incidents.length} épisode{purgeHistory.incidents.length === 1 ? "" : "s"}
              </Badge>
            ) : null}
          </div>
          {!purgeHistory || purgeHistory.incidents.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucun incident enregistré.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-border/50 hover:bg-transparent">
                    <TableHead>Statut</TableHead>
                    <TableHead>Début</TableHead>
                    <TableHead>Rétablissement</TableHead>
                    <TableHead className="text-right">Durée</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {purgeHistory.incidents.map((incident) => (
                    <TableRow key={`${incident.commence_le}-${incident.retabli_le ?? "actif"}`} className="border-border/50">
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={`rounded-none ${
                            incident.statut === "en_cours"
                              ? "text-destructive border-destructive/40"
                              : "text-green-700 border-green-700/40"
                          }`}
                        >
                          {incident.statut === "en_cours" ? "En cours" : "Rétabli"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm">
                        {new Date(incident.commence_le).toLocaleString("fr-FR")}
                      </TableCell>
                      <TableCell className="text-sm">
                        {incident.retabli_le
                          ? new Date(incident.retabli_le).toLocaleString("fr-FR")
                          : "—"}
                      </TableCell>
                      <TableCell className="text-right text-sm">
                        {formatDuration(incident.duree_secondes)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
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

function ProspectionReview() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const request = { credentials: "include" as const };
  const dossiers = useListProspectionDossiers({
    request,
    query: { queryKey: getListProspectionDossiersQueryKey(), retry: false, refetchOnMount: "always", staleTime: 15_000 },
  });
  const [selectedId, setSelectedId] = useState("");
  const detail = useGetProspectionDossier(selectedId, {
    request,
    query: { queryKey: getGetProspectionDossierQueryKey(selectedId), enabled: Boolean(selectedId), retry: false },
  });
  const correct = useCorrectProspectionDossier({ request });
  const validate = useValidateProspectionProposal({ request });
  const withdraw = useWithdrawProspectionProposal({ request });
  const mark = useMarkProspectionDossier({ request });
  const login = useLoginMeetAccount({ request });
  const [accountLogin, setAccountLogin] = useState("");
  const [accountPassword, setAccountPassword] = useState("");
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [hook, setHook] = useState("");
  const [hookOrigin, setHookOrigin] = useState<ProspectionCorrectionHookOrigin>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [markState, setMarkState] = useState<ProspectionManualMarkState>(ProspectionManualMarkState.sent);

  useEffect(() => {
    if (!detail.data) return;
    setEmail(detail.data.contact_email ?? "");
    setFirstName(detail.data.contact_first_name ?? "");
    setHook(detail.data.hook ?? "");
    setHookOrigin((detail.data.hook_origin as ProspectionCorrectionHookOrigin) ?? null);
    setSubject(detail.data.proposal?.subject ?? "");
    setBody(detail.data.proposal?.body ?? "");
  }, [detail.data]);

  const refresh = async (id: string) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getListProspectionDossiersQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getGetProspectionDossierQueryKey(id) }),
    ]);
  };
  const fail = () => toast({
    variant: "destructive",
    title: "Action impossible",
    description: "Le dossier a peut-être changé. Rechargez-le avant de recommencer.",
  });
  const save = () => {
    if (!detail.data) return;
    correct.mutate({
      dossierId: detail.data.id,
      data: {
        revision: detail.data.revision,
        contact_email: email || null,
        contact_first_name: firstName || null,
        hook: hook || null,
        hook_origin: hook ? hookOrigin : null,
        ...(detail.data.proposal ? { subject, body } : {}),
      },
    }, {
      onSuccess: (saved) => {
        void refresh(saved.id);
        toast({ title: "Corrections enregistrées" });
      },
      onError: fail,
    });
  };
  const approve = () => {
    if (!detail.data || !window.confirm("Valider cette proposition au nom de votre compte administrateur ? Aucun courriel ne sera envoyé.")) return;
    validate.mutate({
      dossierId: detail.data.id,
      data: { revision: detail.data.revision, subject, body },
    }, {
      onSuccess: (saved) => {
        void refresh(saved.id);
        toast({ title: "Proposition validée", description: "La livraison reste désactivée." });
      },
      onError: fail,
    });
  };
  const remove = () => {
    if (!detail.data || !window.confirm("Retirer définitivement cette proposition active de la file de relecture ?")) return;
    withdraw.mutate({
      dossierId: detail.data.id,
      data: { revision: detail.data.revision, confirmed: true },
    }, {
      onSuccess: (saved) => {
        void refresh(saved.id);
        toast({ title: "Proposition retirée" });
      },
      onError: fail,
    });
  };
  const manuallyMark = () => {
    if (!detail.data || !window.confirm(`Confirmer le passage manuel du dossier à « ${markState.replace(/_/g, " ")} » ? Cette action n’envoie aucun message.`)) return;
    mark.mutate({
      dossierId: detail.data.id,
      data: { revision: detail.data.revision, confirmed: true, state: markState },
    }, {
      onSuccess: (saved) => {
        void refresh(saved.id);
        toast({ title: "État manuel enregistré" });
      },
      onError: fail,
    });
  };

  return (
    <section className="bg-card border border-border/50 p-6 mb-12">
      <div className="flex flex-col gap-2 mb-6 md:flex-row md:items-start md:justify-between">
        <div>
          <h2 className="text-xl font-serif text-primary">Relecture des propositions</h2>
          <p className="text-sm text-muted-foreground">
            Consultation et validation humaines uniquement. Aucune action de cet écran ne déclenche un envoi.
          </p>
        </div>
        <Badge variant="outline" className="rounded-none self-start">Livraison désactivée</Badge>
      </div>
      {dossiers.isError ? (
        <form
          className="grid gap-3 border border-amber-500/40 bg-amber-500/10 p-4 md:grid-cols-[1fr_1fr_auto] md:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            login.mutate({ data: { login: accountLogin, password: accountPassword } }, {
              onSuccess: () => {
                setAccountPassword("");
                void dossiers.refetch();
                toast({ title: "Session administrateur ouverte" });
              },
              onError: () => toast({ variant: "destructive", title: "Connexion refusée", description: "Utilisez un compte NovaLuth actif ayant le rôle administrateur." }),
            });
          }}
        >
          <label className="space-y-1 text-sm"><span>Compte NovaLuth administrateur</span><Input value={accountLogin} onChange={(event) => setAccountLogin(event.target.value)} autoComplete="username" required className="rounded-none bg-background" /></label>
          <label className="space-y-1 text-sm"><span>Mot de passe</span><Input type="password" value={accountPassword} onChange={(event) => setAccountPassword(event.target.value)} autoComplete="current-password" required className="rounded-none bg-background" /></label>
          <Button type="submit" className="rounded-none" disabled={login.isPending}>{login.isPending ? "Connexion…" : "Ouvrir la session"}</Button>
        </form>
      ) : dossiers.isLoading ? (
        <p className="text-sm text-muted-foreground">Chargement des dossiers…</p>
      ) : dossiers.data?.dossiers.length === 0 ? (
        <p className="text-sm text-muted-foreground">Aucun dossier de prospection à relire.</p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(240px,0.7fr)_minmax(0,1.3fr)]">
          <div className="space-y-2">
            {dossiers.data?.dossiers.map((dossier) => (
              <button
                key={dossier.id}
                type="button"
                onClick={() => setSelectedId(dossier.id)}
                className={`w-full border p-3 text-left transition-colors ${selectedId === dossier.id ? "border-primary bg-primary/5" : "border-border/50 hover:bg-muted/40"}`}
              >
                <span className="block font-medium text-primary">{dossier.workshop_name}</span>
                <span className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                  <span>{dossier.state.replace(/_/g, " ")}</span>
                  <span>{dossier.has_active_proposal ? "Proposition active" : "Sans proposition"}</span>
                </span>
              </button>
            ))}
          </div>
          {!selectedId ? (
            <div className="border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              Sélectionnez un dossier pour relire son contenu.
            </div>
          ) : detail.isLoading || !detail.data ? (
            <p className="text-sm text-muted-foreground">Chargement du détail…</p>
          ) : (
            <div className="space-y-4 border border-border/50 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="font-serif text-lg text-primary">{detail.data.workshop_name}</h3>
                  <p className="text-xs text-muted-foreground">{detail.data.slug} · révision {detail.data.revision}</p>
                </div>
                <Badge variant="secondary" className="rounded-none">{detail.data.state.replace(/_/g, " ")}</Badge>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-sm"><span className="text-muted-foreground">Prénom du contact</span><Input value={firstName} onChange={(event) => setFirstName(event.target.value)} className="rounded-none" /></label>
                <label className="space-y-1 text-sm"><span className="text-muted-foreground">Courriel</span><Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} disabled={Boolean(detail.data.proposal)} className="rounded-none" /></label>
              </div>
              <label className="block space-y-1 text-sm"><span className="text-muted-foreground">Accroche vérifiée</span><Textarea value={hook} onChange={(event) => { setHook(event.target.value); setHookOrigin(ProspectionCorrectionHookOrigin.human); }} disabled={Boolean(detail.data.proposal)} className="min-h-24 rounded-none" /></label>
              {detail.data.proposal ? <p className="text-xs text-muted-foreground">Retirez d’abord la proposition pour modifier son destinataire ou son accroche.</p> : null}
              <label className="block space-y-1 text-sm"><span className="text-muted-foreground">Objet</span><Input value={subject} onChange={(event) => setSubject(event.target.value)} className="rounded-none" /></label>
              <label className="block space-y-1 text-sm"><span className="text-muted-foreground">Message</span><Textarea value={body} onChange={(event) => setBody(event.target.value)} className="min-h-52 rounded-none" /></label>
              <p className="text-xs text-muted-foreground">Le contenu affiché ici n’est jamais écrit dans les journaux techniques.</p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" className="rounded-none" onClick={save} disabled={correct.isPending}>Enregistrer les corrections</Button>
                {!detail.data.proposal ? (
                  <Button type="button" className="rounded-none" onClick={approve} disabled={validate.isPending || subject.trim().length < 10 || body.trim().length < 200}>Valider la proposition</Button>
                ) : (
                  <Button type="button" variant="destructive" className="rounded-none" onClick={remove} disabled={withdraw.isPending}>Retirer la proposition</Button>
                )}
              </div>
              <div className="border-t border-border/50 pt-4">
                <p className="mb-2 text-sm font-medium">Marquage manuel</p>
                <div className="flex flex-wrap gap-2">
                  <select value={markState} onChange={(event) => setMarkState(event.target.value as ProspectionManualMarkState)} className="h-10 border border-input bg-background px-3 text-sm">
                    {Object.values(ProspectionManualMarkState).map((state) => <option key={state} value={state}>{state.replace(/_/g, " ")}</option>)}
                  </select>
                  <Button type="button" variant="outline" className="rounded-none" onClick={manuallyMark} disabled={mark.isPending}>Confirmer le marquage</Button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}