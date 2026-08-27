import { useState, useEffect } from "react";
import { Link } from "wouter";
import {
  useListFiches,
  useGetFichesMeta,
  ListFichesStatut,
  ListFichesType,
  ListFichesInstrument,
  ListFichesZone,
  ListFichesTri,
  ListFichesCouleurSon
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Search, MapPin, Info, SlidersHorizontal, Trash2 } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";

const soundLabels: Record<string, string> = {
  chaud: "chaud et rond",
  equilibre: "équilibré",
  clair: "clair et brillant",
  douce: "douce et progressive",
  franche: "franche",
  percussive: "percussive et immédiate",
  courte: "courte et nette",
  moyenne: "moyenne",
  longue: "longue et chantante",
};

export default function Annuaire() {
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const [filters, setFilters] = useState({
    type: "all",
    pays: "all",
    instrument: "all",
    style: "all",
    zone: "all",
    couleur_son: "all",
    budget_eur: "",
    delai_max_mois: "",
    relue_seulement: false,
    facons: [] as string[],
    tri: "equitable",
  });

  const { data: meta } = useGetFichesMeta();
  
  // Build params
  const params: any = { statut: ListFichesStatut.publiee };
  if (debouncedQ) params.q = debouncedQ;
  if (filters.type !== "all") params.type = filters.type as ListFichesType;
  if (filters.pays !== "all") params.pays = filters.pays;
  if (filters.instrument !== "all") params.instrument = filters.instrument as ListFichesInstrument;
  if (filters.style !== "all") params.style = filters.style;
  if (filters.zone !== "all") params.zone = filters.zone as ListFichesZone;
  if (filters.couleur_son !== "all") params.couleur_son = filters.couleur_son as ListFichesCouleurSon;
  if (filters.budget_eur) params.budget_eur = parseInt(filters.budget_eur, 10);
  if (filters.delai_max_mois) params.delai_max_mois = parseInt(filters.delai_max_mois, 10);
  if (filters.relue_seulement) params.relue_seulement = true;
  if (filters.facons.length > 0) params.facons = filters.facons.join(",");
  params.tri = filters.tri as ListFichesTri;

  const { data: fiches = [], isLoading, isError, refetch } = useListFiches(params);

  const getFacetteLabel = (cle: string) => {
    if (!meta) return cle;
    for (const famille of meta.facettes) {
      const found = famille.cases.find(c => c.cle === cle);
      if (found) return found.libelle;
    }
    return cle;
  };

  const getCouleurSonLabel = (cle: string) => {
    if (!meta || !meta.couleurs_son) return cle;
    const found = meta.couleurs_son.find(c => c.cle === cle);
    return found ? found.libelle : cle;
  };

  const resetFilters = () => {
    setQ("");
    setFilters({
      type: "all",
      pays: "all",
      instrument: "all",
      style: "all",
      zone: "all",
      couleur_son: "all",
      budget_eur: "",
      delai_max_mois: "",
      relue_seulement: false,
      facons: [],
      tri: "equitable",
    });
  };

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
        <aside className="w-full lg:w-1/3 xl:w-1/4 shrink-0">
          <div className="bg-card border border-border/50 p-6 space-y-6 lg:sticky lg:top-24 max-h-[calc(100vh-8rem)] overflow-y-auto custom-scrollbar">
            <div className="flex items-center justify-between border-b border-border/50 pb-4">
              <h2 className="font-serif text-xl text-primary flex items-center gap-2">
                <SlidersHorizontal className="h-5 w-5" /> Filtres
              </h2>
              <Button variant="ghost" size="sm" onClick={resetFilters} className="h-8 px-2 text-muted-foreground hover:text-primary" title="Réinitialiser">
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
            
            <div className="space-y-3">
              <label className="text-sm font-medium text-foreground flex items-center gap-2">
                <Search className="h-4 w-4" />
                Recherche
              </label>
              <Input 
                placeholder="Nom, mot-clé..." 
                className="rounded-none bg-background"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-3">
                <label className="text-sm font-medium text-foreground">Type</label>
                <Select value={filters.type} onValueChange={v => setFilters({...filters, type: v})}>
                  <SelectTrigger className="rounded-none bg-background">
                    <SelectValue placeholder="Tous" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Tous</SelectItem>
                    <SelectItem value="luthier">Luthier</SelectItem>
                    <SelectItem value="marque_emergente">Marque</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-3">
                <label className="text-sm font-medium text-foreground">Instrument</label>
                <Select value={filters.instrument} onValueChange={v => setFilters({...filters, instrument: v})}>
                  <SelectTrigger className="rounded-none bg-background">
                    <SelectValue placeholder="Tous" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Tous</SelectItem>
                    <SelectItem value="electrique">Électrique</SelectItem>
                    <SelectItem value="acoustique">Acoustique</SelectItem>
                    <SelectItem value="basse">Basse</SelectItem>
                    <SelectItem value="autre">Autre</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-3">
                <label className="text-sm font-medium text-foreground">Pays</label>
                <Select value={filters.pays} onValueChange={v => setFilters({...filters, pays: v})}>
                  <SelectTrigger className="rounded-none bg-background">
                    <SelectValue placeholder="Tous" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Tous</SelectItem>
                    {meta?.pays?.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-3">
                <label className="text-sm font-medium text-foreground">Style</label>
                <Select value={filters.style} onValueChange={v => setFilters({...filters, style: v})}>
                  <SelectTrigger className="rounded-none bg-background">
                    <SelectValue placeholder="Tous" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Tous</SelectItem>
                    {meta?.styles?.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-3">
                <label className="text-sm font-medium text-foreground">Zone d'expédition</label>
                <Select value={filters.zone} onValueChange={v => setFilters({...filters, zone: v})}>
                  <SelectTrigger className="rounded-none bg-background">
                    <SelectValue placeholder="Toutes" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Toutes</SelectItem>
                    <SelectItem value="france">France</SelectItem>
                    <SelectItem value="europe">Europe</SelectItem>
                    <SelectItem value="monde">Monde</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-3">
                <label className="text-sm font-medium text-foreground">Couleur du son annoncée</label>
                <Select value={filters.couleur_son} onValueChange={v => setFilters({...filters, couleur_son: v})}>
                  <SelectTrigger className="rounded-none bg-background">
                    <SelectValue placeholder="Toutes" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Toutes</SelectItem>
                    {meta?.couleurs_son?.map(c => <SelectItem key={c.cle} value={c.cle}>{c.libelle}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-3">
                <label className="text-sm font-medium text-foreground">Budget max (€)</label>
                <Input
                  type="number"
                  placeholder="Ex: 3000"
                  value={filters.budget_eur}
                  onChange={e => setFilters({...filters, budget_eur: e.target.value})}
                  className="rounded-none bg-background"
                />
              </div>
              <div className="space-y-3">
                <label className="text-sm font-medium text-foreground">Délai max (mois)</label>
                <Input
                  type="number"
                  placeholder="Ex: 12"
                  value={filters.delai_max_mois}
                  onChange={e => setFilters({...filters, delai_max_mois: e.target.value})}
                  className="rounded-none bg-background"
                />
              </div>
            </div>

            <div className="flex items-center space-x-2 pt-2 pb-4 border-b border-border/50">
              <Switch
                id="relue"
                checked={filters.relue_seulement}
                onCheckedChange={c => setFilters({...filters, relue_seulement: c})}
              />
              <label htmlFor="relue" className="text-sm font-medium text-foreground cursor-pointer">
                Fiches validées par l'artisan
              </label>
            </div>

            {meta?.facettes?.map(famille => (
              <div key={famille.cle} className="space-y-3 pt-2">
                <label className="text-sm font-medium text-foreground">{famille.titre}</label>
                <div className="space-y-2">
                  {famille.cases.map(facette => (
                    <div key={facette.cle} className="flex items-start space-x-2">
                      <Checkbox
                        id={`facon-${facette.cle}`}
                        checked={filters.facons.includes(facette.cle)}
                        onCheckedChange={(checked) => {
                          setFilters(prev => ({
                            ...prev,
                            facons: checked
                              ? [...prev.facons, facette.cle]
                              : prev.facons.filter(f => f !== facette.cle)
                          }));
                        }}
                      />
                      <div className="grid leading-none">
                        <label htmlFor={`facon-${facette.cle}`} className="text-sm font-medium leading-none cursor-pointer">
                          {facette.libelle}
                        </label>
                        <p className="mt-1 text-xs leading-snug text-muted-foreground">{facette.aide}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </aside>

        {/* Results Grid */}
        <main className="w-full lg:flex-1">

          <div className="bg-primary/10 border border-primary/20 p-4 mb-8 rounded-none text-sm relative">
            <div className="flex items-start gap-3">
              <Info className="h-5 w-5 text-primary shrink-0 mt-0.5" />
              <div>
                <h3 className="font-serif text-primary text-base font-medium mb-1">À sélectionner, affiner</h3>
                <p className="text-muted-foreground leading-relaxed">
                  L'ordre par défaut est une rotation quotidienne neutre. Vous pouvez utiliser les filtres pour affiner votre recherche. Les critères manquants sur une fiche ne la pénalisent pas. <Link href="/legal/classement" className="text-primary underline hover:text-accent font-medium">En savoir plus sur le fonctionnement du tri.</Link>
                </p>
              </div>
            </div>
          </div>

          <div className="mb-6 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
              {isLoading ? "Chargement..." : `${fiches.length} résultat${fiches.length !== 1 ? 's' : ''}`}
            </h2>
            <div className="flex items-center gap-3 w-full sm:w-auto">
              <span className="text-sm text-muted-foreground shrink-0">Trier par</span>
              <Select value={filters.tri} onValueChange={(v) => setFilters({...filters, tri: v})}>
                <SelectTrigger className="rounded-none bg-card border-border/50 w-full sm:w-[180px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="equitable">Rotation équitable</SelectItem>
                  <SelectItem value="delai">Délai le plus court</SelectItem>
                  <SelectItem value="budget">Budget le plus bas</SelectItem>
                  <SelectItem value="alpha">Ordre alphabétique</SelectItem>
                  <SelectItem value="maj">Mise à jour récente</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {isLoading ? (
            <div className="grid md:grid-cols-2 gap-6">
              {[1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-80 w-full rounded-none" />
              ))}
            </div>
          ) : isError ? (
            <div className="bg-card border border-destructive/40 p-12 text-center">
              <p className="text-muted-foreground text-lg mb-4">L’annuaire est momentanément indisponible.</p>
              <Button onClick={() => refetch()} variant="outline" className="rounded-none">
                Réessayer
              </Button>
            </div>
          ) : fiches.length === 0 ? (
            <div className="bg-card border border-border/50 p-12 text-center">
              <p className="text-muted-foreground text-lg mb-4">Aucun artisan ne correspond à vos critères.</p>
              <Button onClick={resetFilters} variant="outline" className="rounded-none">
                Réinitialiser les filtres
              </Button>
            </div>
          ) : (
            <div className="grid md:grid-cols-2 gap-6">
              {fiches.map((fiche) => (
                <Link key={fiche.slug} href={`/fiche/${fiche.slug}`} className="group block h-full">
                  <div className="bg-card border border-border/50 p-8 h-full flex flex-col transition-all duration-300 hover:border-primary/40 hover:bg-card/80">
                    <div className="flex justify-between items-start mb-6">
                      <h3 className="text-2xl font-serif text-primary group-hover:text-accent transition-colors">
                        {fiche.nom}
                      </h3>
                      <Badge variant="outline" className="rounded-none border-primary/20 text-primary whitespace-nowrap ml-4">
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
                        {fiche.facons_travail?.slice(0, 3).map((cle) => (
                          <span key={cle} className="text-xs px-2 py-1 bg-secondary/30 text-secondary-foreground border border-secondary">
                            {getFacetteLabel(cle)}
                          </span>
                        ))}
                      </div>
                      {fiche.profil_sonore && (fiche.profil_sonore.couleur || fiche.profil_sonore.attaque || fiche.profil_sonore.tenue) && (
                        <div className="text-xs text-muted-foreground mt-2 pt-2 border-t border-border/30">
                          <span className="block font-medium text-foreground mb-1">Son annoncé</span>
                          <div className="flex flex-wrap gap-x-3 gap-y-1">
                            {fiche.profil_sonore.couleur && <span>Couleur : <span className="text-foreground">{soundLabels[fiche.profil_sonore.couleur] ?? getCouleurSonLabel(fiche.profil_sonore.couleur)}</span></span>}
                            {fiche.profil_sonore.attaque && <span>Attaque : <span className="text-foreground">{soundLabels[fiche.profil_sonore.attaque] ?? fiche.profil_sonore.attaque}</span></span>}
                            {fiche.profil_sonore.tenue && <span>Tenue : <span className="text-foreground">{soundLabels[fiche.profil_sonore.tenue] ?? fiche.profil_sonore.tenue}</span></span>}
                          </div>
                        </div>
                      )}

                      <p className="text-xs text-muted-foreground mt-2 pt-2 border-t border-border/30">
                        Façons de travailler : {fiche.provenance_facons}
                      </p>
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
