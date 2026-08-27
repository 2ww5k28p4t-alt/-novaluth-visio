import { Link, useRoute } from "wouter";
import { useGetFiche, getGetFicheQueryKey } from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { 
  MapPin, 
  Globe, 
  Clock, 
  Euro, 
  Package, 
  Zap, 
  Music,
  CheckCircle2,
  AlertCircle
} from "lucide-react";
import { Separator } from "@/components/ui/separator";

export default function Fiche() {
  const [, params] = useRoute("/fiche/:slug");
  const slug = params?.slug || "";
  
  const { data: fiche, isLoading, isError } = useGetFiche(slug, {
    query: { enabled: !!slug, queryKey: getGetFicheQueryKey(slug) }
  });

  if (isLoading) {
    return (
      <div className="container mx-auto px-4 py-12 space-y-8">
        <Skeleton className="h-32 w-full max-w-3xl" />
        <Skeleton className="h-12 w-1/3" />
        <div className="grid md:grid-cols-3 gap-8">
          <Skeleton className="h-64 col-span-2" />
          <Skeleton className="h-64" />
        </div>
      </div>
    );
  }

  if (isError || !fiche) {
    return (
      <div className="container mx-auto px-4 py-24 text-center">
        <h1 className="text-3xl font-serif text-primary mb-4">Artisan introuvable</h1>
        <p className="text-muted-foreground">La fiche que vous recherchez n'existe pas ou n'est plus disponible.</p>
      </div>
    );
  }

  return (
    <div className="bg-background min-h-screen pb-24">
      {/* Header */}
      <header className="bg-card border-b border-border/50 py-16">
        <div className="container mx-auto px-4">
          <div className="max-w-4xl">
            <div className="flex items-center gap-4 mb-6">
              <Badge variant="outline" className="rounded-none border-primary/20 text-primary bg-primary/5">
                {fiche.type === 'luthier' ? 'Luthier' : 'Marque Émergente'}
              </Badge>
              {fiche.valide_par_artisan && (
                <Badge variant="secondary" className="rounded-none bg-green-900/10 text-green-700 border border-green-900/20 flex items-center gap-1">
                  <CheckCircle2 className="h-3 w-3" /> Fiche vérifiée
                </Badge>
              )}
            </div>
            
            <h1 className="text-5xl md:text-6xl font-serif text-primary mb-6">
              {fiche.nom}
            </h1>
            
            <div className="flex flex-wrap items-center gap-6 text-muted-foreground">
              <div className="flex items-center gap-2">
                <MapPin className="h-4 w-4" />
                <span>{fiche.ville ? `${fiche.ville}, ` : ''}{fiche.pays}</span>
              </div>
              
              {fiche.site_web && (
                <a href={fiche.site_web} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 hover:text-primary transition-colors">
                  <Globe className="h-4 w-4" />
                  <span>Site web officiel</span>
                </a>
              )}
              
              {fiche.annee_creation && (
                <div className="flex items-center gap-2">
                  <Clock className="h-4 w-4" />
                  <span>Depuis {fiche.annee_creation}</span>
                </div>
              )}
            </div>

            {fiche.demonstration && (
              <div className="mt-8">
                <Link href={`/atelier/${fiche.slug}`} className="nv-bouton nv-bouton-secondaire border-primary text-primary hover:bg-primary/10">
                  <Zap className="h-4 w-4 mr-2" />
                  Espace Artisan (Démo)
                </Link>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="container mx-auto px-4 mt-12">
        <div className="grid lg:grid-cols-3 gap-12">
          
          {/* Main Content */}
          <div className="lg:col-span-2 space-y-16">
            
            {/* IA Summary */}
            {fiche.ia.resume_ia && (
              <section>
                <h2 className="text-2xl font-serif text-primary mb-6 flex items-center gap-2">
                  <SparklesIcon className="h-5 w-5 text-accent" />
                  L'avis NovaLuth
                </h2>
                <div className="bg-secondary/20 p-8 border-l-2 border-accent text-lg text-foreground font-light leading-relaxed">
                  {fiche.ia.resume_ia}
                </div>
                <div className="flex gap-2 mt-4 flex-wrap">
                  {fiche.ia.tags?.map(tag => (
                    <span key={tag} className="text-sm px-3 py-1 bg-muted/50 text-muted-foreground">#{tag}</span>
                  ))}
                </div>
              </section>
            )}

            {/* Approach */}
            {fiche.approche_artisanale && (
              <section>
                <h2 className="text-2xl font-serif text-primary mb-6">Approche & Philosophie</h2>
                <p className="text-muted-foreground leading-relaxed whitespace-pre-wrap">
                  {fiche.approche_artisanale}
                </p>
              </section>
            )}

            {/* Models */}
            <section>
              <h2 className="text-2xl font-serif text-primary mb-6 flex items-center gap-2">
                <Music className="h-5 w-5" />
                Modèles Proposés
              </h2>
              {fiche.modeles && fiche.modeles.length > 0 ? (
                <div className="space-y-8">
                  {fiche.modeles.map((modele, i) => (
                    <div key={i} className="border border-border/50 bg-card p-6">
                      <div className="flex justify-between items-start mb-4">
                        <div>
                          <h3 className="text-xl font-serif text-primary">{modele.nom}</h3>
                          <span className="text-sm text-muted-foreground capitalize">{modele.type}</span>
                        </div>
                        {modele.prix_base_eur && (
                          <div className="text-right">
                            <span className="block text-sm text-muted-foreground">À partir de</span>
                            <span className="font-medium text-lg">{modele.prix_base_eur}€</span>
                          </div>
                        )}
                      </div>
                      
                      <Separator className="my-4" />
                      
                      <div className="grid sm:grid-cols-2 gap-4 text-sm">
                        {modele.specifications.bois_corps && (
                          <div><span className="text-muted-foreground block">Corps</span>{modele.specifications.bois_corps}</div>
                        )}
                        {modele.specifications.bois_manche && (
                          <div><span className="text-muted-foreground block">Manche</span>{modele.specifications.bois_manche}</div>
                        )}
                        {modele.specifications.touche && (
                          <div><span className="text-muted-foreground block">Touche</span>{modele.specifications.touche}</div>
                        )}
                        {modele.specifications.type_micros && (
                          <div><span className="text-muted-foreground block">Électronique</span>{modele.specifications.type_micros} ({modele.specifications.configuration_micros})</div>
                        )}
                      </div>
                      
                      {modele.personnalisable && (
                        <div className="mt-4 inline-flex items-center gap-1 text-xs px-2 py-1 bg-primary/10 text-primary">
                          <CheckCircle2 className="h-3 w-3" /> Fortement personnalisable
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-muted-foreground">Aucun modèle spécifié. Fabrication sur-mesure intégrale probable.</p>
              )}
            </section>

          </div>

          {/* Sidebar */}
          <div className="space-y-8">
            
            {/* Sound Profile */}
            <div className="bg-card border border-border/50 p-6 space-y-6">
              <h3 className="font-serif text-lg text-primary border-b border-border/50 pb-4">Profil Sonore</h3>
              
              {fiche.profil_sonore.styles && fiche.profil_sonore.styles.length > 0 && (
                <div>
                  <span className="text-sm text-muted-foreground block mb-2">Styles de prédilection</span>
                  <div className="flex flex-wrap gap-2">
                    {fiche.profil_sonore.styles.map(s => (
                      <Badge key={s} variant="secondary" className="rounded-none bg-secondary/30 text-secondary-foreground">{s}</Badge>
                    ))}
                  </div>
                </div>
              )}
              
              <div className="space-y-3 pt-2">
                {fiche.profil_sonore.chaleur !== undefined && fiche.profil_sonore.chaleur !== null && (
                  <div>
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-muted-foreground">Chaleur</span>
                      <span>{fiche.profil_sonore.chaleur}/10</span>
                    </div>
                    <div className="h-1.5 w-full bg-muted overflow-hidden">
                      <div className="h-full bg-accent" style={{ width: `${fiche.profil_sonore.chaleur * 10}%` }} />
                    </div>
                  </div>
                )}
                {fiche.profil_sonore.brillance !== undefined && fiche.profil_sonore.brillance !== null && (
                  <div>
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-muted-foreground">Brillance</span>
                      <span>{fiche.profil_sonore.brillance}/10</span>
                    </div>
                    <div className="h-1.5 w-full bg-muted overflow-hidden">
                      <div className="h-full bg-accent" style={{ width: `${fiche.profil_sonore.brillance * 10}%` }} />
                    </div>
                  </div>
                )}
              </div>
              
              {fiche.profil_sonore.description && (
                <p className="text-sm text-muted-foreground italic mt-4">
                  "{fiche.profil_sonore.description}"
                </p>
              )}
            </div>

            {/* Innovation */}
            <div className="bg-card border border-border/50 p-6 space-y-4">
              <h3 className="font-serif text-lg text-primary border-b border-border/50 pb-4 flex items-center gap-2">
                <Zap className="h-4 w-4" /> Innovation
              </h3>
              
              {fiche.innovation.niveau !== undefined && fiche.innovation.niveau !== null && (
                <div className="flex items-center gap-3">
                  <div className="flex-1">
                    <span className="text-sm text-muted-foreground block">Indice de radicalité</span>
                  </div>
                  <div className="text-xl font-serif text-primary">{fiche.innovation.niveau}/10</div>
                </div>
              )}
              
              {fiche.innovation.marqueurs && fiche.innovation.marqueurs.length > 0 && (
                <ul className="space-y-2 text-sm mt-4">
                  {fiche.innovation.marqueurs.map((m, i) => (
                    <li key={i} className="flex items-start gap-2 text-muted-foreground">
                      <span className="text-accent mt-0.5">•</span>
                      <span>{m}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Logistics */}
            <div className="bg-card border border-border/50 p-6 space-y-4">
              <h3 className="font-serif text-lg text-primary border-b border-border/50 pb-4 flex items-center gap-2">
                <Package className="h-4 w-4" /> Pratique
              </h3>
              
              <div className="space-y-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground flex items-center gap-2"><Euro className="h-3 w-3"/> Budget moyen</span>
                  <span className="font-medium text-right">
                    {fiche.prix_min_eur && fiche.prix_max_eur 
                      ? `${fiche.prix_min_eur}€ - ${fiche.prix_max_eur}€` 
                      : (fiche.prix_min_eur ? `Dès ${fiche.prix_min_eur}€` : 'Sur devis')}
                  </span>
                </div>
                
                {fiche.delai_moyen_mois && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground flex items-center gap-2"><Clock className="h-3 w-3"/> Délai de fabrication</span>
                    <span className="font-medium">{fiche.delai_moyen_mois} mois</span>
                  </div>
                )}
                
                <Separator className="my-2" />
                
                <div>
                  <span className="text-muted-foreground block mb-1">Expédition</span>
                  <div className="flex flex-wrap gap-2 text-xs">
                    {fiche.logistique.expedie_france && <Badge variant="outline" className="rounded-none bg-background">France</Badge>}
                    {fiche.logistique.expedie_europe && <Badge variant="outline" className="rounded-none bg-background">Europe</Badge>}
                    {fiche.logistique.expedie_monde && <Badge variant="outline" className="rounded-none bg-background">Monde</Badge>}
                  </div>
                </div>
              </div>
            </div>

            {!fiche.valide_par_artisan && (
              <div className="bg-muted/50 p-4 border border-border flex gap-3 text-sm text-muted-foreground">
                <AlertCircle className="h-5 w-5 shrink-0 text-muted-foreground" />
                <p>Cette fiche a été compilée par notre équipe à partir de données publiques. Elle n'a pas encore été revendiquée par l'artisan.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SparklesIcon(props: React.ComponentProps<"svg">) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
      <path d="M5 3v4" />
      <path d="M19 17v4" />
      <path d="M3 5h4" />
      <path d="M17 19h4" />
    </svg>
  );
}