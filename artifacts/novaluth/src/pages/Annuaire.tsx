import { useState } from "react";
import { Link } from "wouter";
import { useListFiches, useGetFichesMeta, ListFichesStatut, ListFichesType } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Search, MapPin, Sparkles } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

export default function Annuaire() {
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedType, setSelectedType] = useState<string>("all");
  const [selectedCountry, setSelectedCountry] = useState<string>("all");
  const [minInnovation, setMinInnovation] = useState<number[]>([0]);

  const { data: meta } = useGetFichesMeta();
  
  // Build params
  const params: any = { statut: ListFichesStatut.publiee };
  if (selectedType !== "all") params.type = selectedType as ListFichesType;
  if (selectedCountry !== "all") params.pays = selectedCountry;
  if (minInnovation[0] > 0) params.innovation_min = minInnovation[0];

  const { data: fiches, isLoading } = useListFiches(params);

  const filteredFiches = fiches?.filter(fiche => 
    fiche.nom.toLowerCase().includes(searchTerm.toLowerCase()) || 
    fiche.ia.mots_cles?.some(kw => kw.toLowerCase().includes(searchTerm.toLowerCase()))
  ) || [];

  return (
    <div className="container mx-auto px-4 py-12">
      <div className="mb-12">
        <h1 className="text-4xl md:text-5xl font-serif text-primary mb-4">Annuaire des Artisans</h1>
        <p className="text-xl text-muted-foreground max-w-2xl font-light">
          Explorez notre sélection de luthiers et marques émergentes qui repensent la facture instrumentale.
        </p>
      </div>

      <div className="flex flex-col lg:flex-row gap-8">
        {/* Filters Sidebar */}
        <aside className="w-full lg:w-1/4 space-y-8">
          <div className="bg-card border border-border/50 p-6 space-y-6 sticky top-24">
            <h2 className="font-serif text-xl text-primary border-b border-border/50 pb-4">Filtres</h2>
            
            <div className="space-y-3">
              <label className="text-sm font-medium text-foreground flex items-center gap-2">
                <Search className="h-4 w-4" />
                Recherche
              </label>
              <Input 
                placeholder="Nom, mot-clé..." 
                className="rounded-none border-border/50 bg-background focus-visible:ring-primary"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>

            <div className="space-y-3">
              <label className="text-sm font-medium text-foreground">Type d'artisan</label>
              <Select value={selectedType} onValueChange={setSelectedType}>
                <SelectTrigger className="rounded-none border-border/50 bg-background">
                  <SelectValue placeholder="Tous les types" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Tous les types</SelectItem>
                  <SelectItem value="luthier">Luthier</SelectItem>
                  <SelectItem value="marque_emergente">Marque émergente</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-3">
              <label className="text-sm font-medium text-foreground flex items-center gap-2">
                <MapPin className="h-4 w-4" />
                Pays
              </label>
              <Select value={selectedCountry} onValueChange={setSelectedCountry}>
                <SelectTrigger className="rounded-none border-border/50 bg-background">
                  <SelectValue placeholder="Tous les pays" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Tous les pays</SelectItem>
                  {meta?.pays?.map(pays => (
                    <SelectItem key={pays} value={pays}>{pays}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-4 pt-2">
              <div className="flex justify-between items-center">
                <label className="text-sm font-medium text-foreground flex items-center gap-2">
                  <Sparkles className="h-4 w-4" />
                  Niveau d'innovation min.
                </label>
                <span className="text-sm text-muted-foreground">{minInnovation[0]}/10</span>
              </div>
              <Slider
                value={minInnovation}
                onValueChange={setMinInnovation}
                max={10}
                step={1}
                className="[&_[role=slider]]:border-primary [&_[role=slider]]:bg-primary"
              />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Traditionnel</span>
                <span>Radical</span>
              </div>
            </div>
          </div>
        </aside>

        {/* Results Grid */}
        <main className="w-full lg:w-3/4">
          <div className="mb-6 flex justify-between items-center">
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
              {isLoading ? "Chargement..." : `${filteredFiches.length} résultat${filteredFiches.length !== 1 ? 's' : ''}`}
            </h2>
          </div>

          {isLoading ? (
            <div className="grid md:grid-cols-2 gap-6">
              {[1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-80 w-full rounded-none" />
              ))}
            </div>
          ) : filteredFiches.length === 0 ? (
            <div className="bg-card border border-border/50 p-12 text-center">
              <p className="text-muted-foreground text-lg">Aucun artisan ne correspond à vos critères.</p>
              <button 
                onClick={() => {
                  setSearchTerm("");
                  setSelectedType("all");
                  setSelectedCountry("all");
                  setMinInnovation([0]);
                }}
                className="mt-4 text-primary underline hover:text-accent"
              >
                Réinitialiser les filtres
              </button>
            </div>
          ) : (
            <div className="grid md:grid-cols-2 gap-6">
              {filteredFiches.map((fiche) => (
                <Link key={fiche.slug} href={`/fiche/${fiche.slug}`} className="group block">
                  <div className="bg-card border border-border/50 p-8 h-full flex flex-col transition-all duration-300 hover:border-primary/40 hover:bg-card/80">
                    <div className="flex justify-between items-start mb-6">
                      <h3 className="text-2xl font-serif text-primary group-hover:text-accent transition-colors">
                        {fiche.nom}
                      </h3>
                      <Badge variant="outline" className="rounded-none border-primary/20 text-primary">
                        {fiche.type === 'luthier' ? 'Luthier' : 'Marque'}
                      </Badge>
                    </div>
                    
                    <div className="flex items-center gap-4 text-sm text-muted-foreground mb-6">
                      <span className="flex items-center gap-1">
                        <MapPin className="h-3.5 w-3.5" />
                        {fiche.ville ? `${fiche.ville}, ` : ''}{fiche.pays}
                      </span>
                    </div>
                    
                    <p className="text-muted-foreground text-sm leading-relaxed mb-8 flex-1">
                      {fiche.ia.resume_ia || "Description non disponible."}
                    </p>
                    
                    <div className="space-y-4">
                      {fiche.prix_min_eur && (
                        <div className="text-sm flex justify-between border-b border-border/30 pb-2">
                          <span className="text-muted-foreground">Budget indicatif</span>
                          <span className="font-medium text-foreground">
                            À partir de {fiche.prix_min_eur}€
                          </span>
                        </div>
                      )}
                      
                      <div className="flex flex-wrap gap-2">
                        {fiche.ia.tags?.slice(0, 3).map((tag) => (
                          <span key={tag} className="text-xs px-2 py-1 bg-secondary/30 text-secondary-foreground border border-secondary">
                            {tag}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}