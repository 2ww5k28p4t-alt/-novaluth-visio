import { useState } from "react";
import { Link, useRoute } from "wouter";
import {
  useGetMusicianProject,
  getGetMusicianProjectQueryKey,
  useDecideMusicianAccessRequest,
  AtelierAccessRequest,
  MusicianProject
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Loader2, Music, Check, X, ShieldAlert, CalendarDays, Euro, HelpCircle } from "lucide-react";
import { toast } from "sonner";
import { format, parseISO } from "date-fns";
import { fr } from "date-fns/locale";

export default function Portail() {
  const [, params] = useRoute("/projets/:reference/portail/:token");
  const reference = params?.reference || "";
  const token = params?.token || "";
  
  const { data: project, isLoading, isError } = useGetMusicianProject(reference, token, {
    query: {
      enabled: !!reference && !!token,
      retry: false,
      queryKey: getGetMusicianProjectQueryKey(reference, token)
    }
  });

  if (isLoading) {
    return (
      <div className="container mx-auto px-4 py-24 flex flex-col items-center justify-center gap-4">
        <Loader2 className="h-12 w-12 text-primary animate-spin" />
        <p className="text-muted-foreground animate-pulse">Ouverture de votre portail personnel...</p>
      </div>
    );
  }

  if (isError || !project) {
    return (
      <div className="container mx-auto px-4 py-24 text-center">
        <ShieldAlert className="h-16 w-16 text-destructive mx-auto mb-6" />
        <h1 className="text-3xl font-serif text-destructive mb-4">Accès Refusé</h1>
        <p className="text-muted-foreground max-w-md mx-auto">
          Ce lien de portail est invalide ou expiré. Assurez-vous d'avoir utilisé le lien exact qui vous a été fourni lors de la création de votre projet.
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-24">
      <header className="bg-card border-b border-border/50 py-12">
        <div className="container max-w-4xl mx-auto px-4">
          <Badge variant="outline" className="mb-4 border-primary/20 text-primary bg-primary/5 uppercase tracking-widest">
            Portail Privé
          </Badge>
          <h1 className="text-4xl md:text-5xl font-serif text-primary mb-4">
            Projet {project.reference.substring(0, 8)}
          </h1>
          <p className="text-lg text-muted-foreground">
            Bienvenue dans votre espace personnel. Vous pouvez ici consulter les détails de votre projet et gérer les demandes d'accès envoyées par les artisans.
          </p>
        </div>
      </header>

      <main className="container max-w-4xl mx-auto px-4 mt-12 space-y-12">
        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="py-4 text-sm text-muted-foreground">
            {project.courriel_confirmation} Les demandes restent sans débit jusqu’à votre acceptation.
          </CardContent>
        </Card>
        <div className="grid md:grid-cols-3 gap-8">
          
          <div className="md:col-span-2 space-y-8">
            <section>
              <h2 className="text-2xl font-serif mb-6 flex items-center gap-2">
                <Music className="h-6 w-6 text-accent" />
                Demandes des Artisans
              </h2>
              
              {project.demandes.length === 0 ? (
                <Card className="border-dashed border-border bg-card/30 p-12 text-center">
                  <HelpCircle className="h-12 w-12 text-muted-foreground mx-auto mb-4 opacity-50" />
                  <h3 className="text-lg font-medium text-foreground mb-2">Aucune demande pour l'instant</h3>
                  <p className="text-muted-foreground text-sm max-w-md mx-auto">
                    Votre projet est actif et visible (de façon anonyme) par nos artisans partenaires. Vous serez notifié ici lorsqu'un artisan souhaitera vous contacter.
                  </p>
                </Card>
              ) : (
                <div className="space-y-4">
                  {project.demandes.map(demande => (
                    <DemandeCard 
                      key={demande.id} 
                      demande={demande} 
                      reference={reference} 
                      token={token} 
                    />
                  ))}
                </div>
              )}
            </section>
          </div>

          <div className="space-y-6">
            <Card className="bg-card border-border sticky top-24">
              <CardHeader className="pb-4 border-b border-border/50">
                <CardTitle className="text-lg font-serif">Détails du projet</CardTitle>
                <div className="flex items-center gap-2 mt-2">
                  <div className={`w-2 h-2 rounded-full ${project.statut === 'actif' ? 'bg-green-500' : 'bg-yellow-500'}`}></div>
                  <span className="text-xs text-muted-foreground uppercase tracking-wider">{project.statut}</span>
                </div>
              </CardHeader>
              <CardContent className="pt-6 space-y-4">
                <div>
                  <span className="text-xs text-muted-foreground block mb-1">Type</span>
                  <span className="font-medium capitalize">{project.type_instrument}</span>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground block mb-1 flex items-center gap-1"><Euro className="h-3 w-3" /> Budget</span>
                  <span className="font-medium text-accent">{project.budget_min_eur}€ - {project.budget_max_eur}€</span>
                </div>
                {project.styles.length > 0 && (
                  <div>
                    <span className="text-xs text-muted-foreground block mb-2">Styles</span>
                    <div className="flex flex-wrap gap-1.5">
                      {project.styles.map(s => (
                        <Badge key={s} variant="secondary" className="bg-secondary/50 text-xs font-normal">{s}</Badge>
                      ))}
                    </div>
                  </div>
                )}
                <Separator className="bg-border/50" />
                <div className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <CalendarDays className="h-3.5 w-3.5" /> Créé le {format(parseISO(project.cree_le), "d MMMM yyyy", { locale: fr })}
                </div>
              </CardContent>
            </Card>
          </div>

        </div>
      </main>
    </div>
  );
}

function DemandeCard({ demande, reference, token }: { demande: AtelierAccessRequest, reference: string, token: string }) {
  const queryClient = useQueryClient();
  const decide = useDecideMusicianAccessRequest();

  const handleDecision = (decision: 'accepter' | 'refuser') => {
    const isAccept = decision === 'accepter';
    if (isAccept) {
      if (!confirm("En acceptant, vous autorisez cet artisan à voir vos coordonnées complètes et vous vous engagez à échanger avec lui. Confirmer ?")) return;
    }

    decide.mutate(
      { reference, token, requestId: demande.id, data: { decision } },
      {
        onSuccess: () => {
          toast.success(`Demande ${isAccept ? 'acceptée' : 'refusée'}.`);
          queryClient.invalidateQueries({ queryKey: getGetMusicianProjectQueryKey(reference, token) });
        },
        onError: () => {
          toast.error("Erreur lors du traitement de la décision.");
        }
      }
    );
  };

  return (
    <Card className={`border-border bg-card overflow-hidden transition-all ${demande.statut === 'en_attente' ? 'border-l-4 border-l-yellow-500' : ''}`}>
      <div className="p-6">
        <div className="flex justify-between items-start mb-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h3 className="text-xl font-serif text-primary">{demande.atelier_nom}</h3>
              <Badge variant="outline" className="text-[10px] bg-background">Offre {demande.offre}</Badge>
            </div>
            <Link href={`/fiche/${demande.atelier_slug}`} className="text-sm text-muted-foreground hover:text-accent underline underline-offset-2">
              Voir la fiche de l'artisan
            </Link>
          </div>
          
          <StatusBadge statut={demande.statut} />
        </div>

        {demande.statut === 'en_attente' && (
          <div className="mt-6 flex flex-col sm:flex-row gap-3 pt-4 border-t border-border/50">
            <Button 
              className="flex-1 bg-green-600 hover:bg-green-700 text-white" 
              onClick={() => handleDecision('accepter')}
              disabled={decide.isPending}
            >
              {decide.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}
              Accepter la mise en relation
            </Button>
            <Button 
              variant="outline" 
              className="flex-1 text-destructive hover:bg-destructive/10 hover:text-destructive border-border" 
              onClick={() => handleDecision('refuser')}
              disabled={decide.isPending}
            >
              {decide.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="mr-2 h-4 w-4" />}
              Décliner courtoisement
            </Button>
          </div>
        )}
        
        {demande.statut === 'acceptee' && (
          <div className="mt-4 pt-4 border-t border-border/50 bg-green-900/5 -mx-6 -mb-6 px-6 py-4">
            <p className="text-sm text-green-500 flex items-center gap-2">
              <Check className="h-4 w-4" /> 
              Vous avez accepté cette mise en relation. L'artisan prendra contact avec vous prochainement.
            </p>
          </div>
        )}
        
        {demande.statut === 'refusee' && (
          <div className="mt-4 pt-4 border-t border-border/50">
            <p className="text-sm text-muted-foreground italic">
              Vous avez décliné cette proposition. L'artisan en a été informé anonymement.
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}

function StatusBadge({ statut }: { statut: string }) {
  switch (statut) {
    case 'en_attente':
      return <Badge className="bg-yellow-500/10 text-yellow-500 hover:bg-yellow-500/20 border-0">En attente de votre réponse</Badge>;
    case 'acceptee':
      return <Badge className="bg-green-500/10 text-green-500 hover:bg-green-500/20 border-0">Mise en relation acceptée</Badge>;
    case 'refusee':
      return <Badge variant="outline" className="text-muted-foreground bg-muted/30">Déclinée</Badge>;
    case 'annulee':
      return <Badge variant="outline" className="text-muted-foreground bg-muted/30">Annulée par l'artisan</Badge>;
    case 'expiree':
      return <Badge variant="outline" className="text-muted-foreground bg-muted/30">Expirée</Badge>;
    default:
      return <Badge variant="outline">{statut}</Badge>;
  }
}