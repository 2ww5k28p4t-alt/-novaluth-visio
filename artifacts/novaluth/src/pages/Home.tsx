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
      <section className="relative w-full py-24 md:py-32 lg:py-48 overflow-hidden bg-background">
        <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-accent/10 via-background to-background" />
        
        <div className="container mx-auto px-4 relative z-10">
          <div className="max-w-4xl mx-auto text-center space-y-8">
            <Badge variant="outline" className="rounded-full px-4 py-1.5 border-primary/20 text-primary bg-primary/5 uppercase tracking-widest text-xs">
              L'Alternative Instrumentale
            </Badge>
            <h1 className="text-5xl md:text-7xl font-serif text-primary leading-[1.1]">
              Découvrez les artisans <br/> de demain.
            </h1>
            <p className="text-xl md:text-2xl text-muted-foreground font-light max-w-2xl mx-auto leading-relaxed">
              Rencontrez des luthiers indépendants et des marques émergentes qui repensent la création d'instruments, en toute transparence.
            </p>
            
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4 pt-8">
              <Button size="lg" className="rounded-none bg-primary hover:bg-primary/90 text-primary-foreground h-14 px-8 text-base w-full sm:w-auto" asChild>
                <Link href="/brief">
                  Confier votre projet <ArrowRight className="ml-2 h-5 w-5" />
                </Link>
              </Button>
              <Button size="lg" variant="outline" className="rounded-none border-primary/20 text-primary hover:bg-primary/5 h-14 px-8 text-base w-full sm:w-auto" asChild>
                <Link href="/annuaire">
                  Explorer l'annuaire
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* Philosophy Section */}
      <section className="py-24 bg-card border-y border-border/50">
        <div className="container mx-auto px-4">
          <div className="grid md:grid-cols-3 gap-12 max-w-5xl mx-auto">
            <div className="space-y-4 text-center md:text-left">
              <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center mx-auto md:mx-0 text-primary">
                <TreePine className="h-6 w-6" />
              </div>
              <h3 className="text-xl font-serif text-primary">Artisanat Radical</h3>
              <p className="text-muted-foreground leading-relaxed">
                Au-delà des standards établis. Des essences locales, des matériaux alternatifs et des designs qui repoussent les limites.
              </p>
            </div>
            
            <div className="space-y-4 text-center md:text-left">
              <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center mx-auto md:mx-0 text-primary">
                <ShieldCheck className="h-6 w-6" />
              </div>
              <h3 className="text-xl font-serif text-primary">Indépendance Totale</h3>
              <p className="text-muted-foreground leading-relaxed">
                NovaLuth n'est pas un vendeur. Nous ne prenons aucune commission, nous n'intervenons dans aucune transaction.
              </p>
            </div>
            
            <div className="space-y-4 text-center md:text-left">
              <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center mx-auto md:mx-0 text-primary">
                <Sparkles className="h-6 w-6" />
              </div>
              <h3 className="text-xl font-serif text-primary">Mise en Relation IA</h3>
              <p className="text-muted-foreground leading-relaxed">
                Notre algorithme analyse votre cahier des charges pour vous suggérer les artisans les plus pertinents pour votre son.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Recent Makers Section */}
      <section className="py-24 bg-background">
        <div className="container mx-auto px-4">
          <div className="flex justify-between items-end mb-12">
            <div>
              <h2 className="text-3xl font-serif text-primary mb-2">Artisans Récents</h2>
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