import { Link } from "wouter";
import { ArrowRight, Sparkles, ShieldCheck, TreePine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useListFiches } from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";

export default function Home() {
  const { data: fiches, isLoading } = useListFiches({ statut: 'publiee' });
  const recentFiches = fiches?.slice(0, 3) || [];

  return (
    <div className="flex flex-col w-full">
      {/* Hero Section */}
      <section className="nv-hero nv-halo nv-meridiens relative w-full overflow-hidden bg-background">
        <img className="nv-globe-art" src="/novaluth-globe.png" alt="" aria-hidden="true" />
        <div className="container mx-auto px-4 relative z-10">
          <div className="max-w-4xl mx-auto space-y-7">
            <p className="nv-baseline">L'avenir de l'instrument</p>
            <h1 className="text-4xl md:text-6xl text-foreground leading-[1.1]">
              Les luthiers et les marques qui sortent des <em>sentiers battus</em>.
            </h1>
            <p className="text-lg md:text-xl text-muted-foreground font-light max-w-2xl leading-relaxed">
              NovaLuth cartographie les artisans innovants et les jeunes marques
              d'instruments. Décrivez votre projet, puis découvrez les ateliers qui
              correspondent réellement à vos critères.
            </p>
            
            <div className="flex flex-col sm:flex-row items-start gap-3 pt-3">
              <Button size="lg" className="nv-bouton w-full sm:w-auto" asChild>
                <Link href="/brief">
                  Confier votre projet <ArrowRight className="ml-2 h-5 w-5" />
                </Link>
              </Button>
              <Button size="lg" variant="outline" className="nv-bouton nv-bouton-secondaire w-full sm:w-auto" asChild>
                <Link href="/annuaire">
                  Explorer l'annuaire
                </Link>
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">
              Gratuit pour les musiciens. Aucun compte requis pour obtenir une correspondance.
            </p>
          </div>
        </div>
      </section>

      {/* Philosophy Section */}
      <hr className="nv-corde container mx-auto" />
      <section className="py-16 bg-background">
        <div className="container mx-auto px-4">
          <div className="grid md:grid-cols-3 gap-4 max-w-5xl mx-auto">
            <div className="nv-carte p-6 space-y-4">
              <span className="nv-numero" aria-hidden="true">1</span>
              <h3 className="text-lg text-foreground">Vous décrivez</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Budget, instrument, style de jeu, essences, délai et zone de livraison.
                Rien d'autre.
              </p>
            </div>
            <div className="nv-carte p-6 space-y-4">
              <span className="nv-numero" aria-hidden="true">2</span>
              <h3 className="text-lg text-foreground">Nous rapprochons</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Un calcul explicable compare vos critères aux informations publiées de chaque fiche.
              </p>
            </div>
            <div className="nv-carte p-6 space-y-4">
              <span className="nv-numero" aria-hidden="true">3</span>
              <h3 className="text-lg text-foreground">Vous décidez</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Vous contactez l'artisan directement, sans commission et sans transmission
                de votre demande sans accord.
              </p>
            </div>
            <div className="hidden">
              <TreePine />
              <ShieldCheck />
              <Sparkles />
            </div>
          </div>
        </div>
      </section>

      {/* Recent Makers Section */}
      <hr className="nv-corde container mx-auto" />
      <section className="py-16 bg-background">
        <div className="container mx-auto px-4">
          <div className="flex justify-between items-end mb-12">
            <div>
              <h2 className="text-2xl text-foreground mb-2">Dernières fiches publiées</h2>
              <p className="text-muted-foreground">Les dernières découvertes de notre équipe.</p>
            </div>
            <Button variant="ghost" asChild className="hidden sm:flex text-primary hover:bg-primary/5">
              <Link href="/annuaire">Voir tout <ArrowRight className="ml-2 h-4 w-4" /></Link>
            </Button>
          </div>

          {isLoading ? (
            <div className="grid md:grid-cols-3 gap-8">
              {[1, 2, 3].map((i) => (
                <div key={i} className="space-y-4">
                  <Skeleton className="h-64 w-full rounded-none" />
                  <Skeleton className="h-6 w-2/3" />
                  <Skeleton className="h-4 w-1/2" />
                </div>
              ))}
            </div>
          ) : (
            <div className="grid md:grid-cols-3 gap-8">
              {recentFiches.map((fiche) => (
                <Link key={fiche.slug} href={`/fiche/${fiche.slug}`} className="group block group">
                  <div className="bg-card border border-border/50 p-6 h-full transition-all duration-300 hover:border-primary/30 hover:shadow-lg hover:-translate-y-1">
                    <div className="flex justify-between items-start mb-6">
                      <Badge variant="secondary" className="rounded-none bg-secondary/50 text-secondary-foreground">
                        {fiche.type === 'luthier' ? 'Luthier' : 'Marque Émergente'}
                      </Badge>
                      <span className="text-xs text-muted-foreground">{fiche.ville || fiche.pays}</span>
                    </div>
                    
                    <h3 className="text-2xl font-serif text-primary mb-3 group-hover:text-accent transition-colors">
                      {fiche.nom}
                    </h3>
                    
                    <p className="text-muted-foreground text-sm line-clamp-3 mb-6">
                      {fiche.ia.resume_ia || "Aucun résumé disponible pour cet artisan."}
                    </p>
                    
                    <div className="flex flex-wrap gap-2 mt-auto">
                      {fiche.ia.tags?.slice(0, 3).map((tag) => (
                        <span key={tag} className="text-xs px-2 py-1 bg-muted/50 text-muted-foreground border border-border/50">
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
          
          <div className="mt-8 text-center sm:hidden">
            <Button variant="outline" asChild className="w-full">
              <Link href="/annuaire">Voir tout l'annuaire</Link>
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}