import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useCreateBrief, useRecommend, useGetFichesMeta, BriefInputTypeInstrument, BriefInputZonePreferee } from "@workspace/api-client-react";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { ArrowRight, Sparkles, CheckCircle2, ChevronRight } from "lucide-react";
import { Link } from "wouter";

const briefSchema = z.object({
  type_instrument: z.nativeEnum(BriefInputTypeInstrument),
  budget_min_eur: z.coerce.number().min(0).max(200000),
  budget_max_eur: z.coerce.number().min(0).max(200000),
  styles: z.string().transform(val => val.split(',').map(s => s.trim()).filter(Boolean)),
  bois_souhaites: z.string().transform(val => val.split(',').map(s => s.trim()).filter(Boolean)),
  delai_max_mois: z.coerce.number().min(0).max(120).optional(),
  pays_livraison: z.string().max(60).optional(),
  zone_preferee: z.nativeEnum(BriefInputZonePreferee),
  chaleur_souhaitee: z.number().min(0).max(10).optional(),
  brillance_souhaitee: z.number().min(0).max(10).optional(),
  facons_recherchees: z.array(z.string()).optional(),
  personnalisation: z.boolean().default(false),
  description_libre: z.string().max(1500),
  email: z.string().email().optional().or(z.literal('')),
  consentement_transmission: z.boolean().default(false),
}).refine(data => data.budget_max_eur >= data.budget_min_eur, {
  message: "Le budget maximum doit être supérieur ou égal au budget minimum",
  path: ["budget_max_eur"]
});

export default function Brief() {
  const [receipt, setReceipt] = useState<any>(null);
  const { data: meta } = useGetFichesMeta();
  
  const form = useForm<z.input<typeof briefSchema>>({
    resolver: zodResolver(briefSchema),
    defaultValues: {
      type_instrument: BriefInputTypeInstrument.electrique,
      budget_min_eur: 1500,
      budget_max_eur: 3000,
      styles: "",
      bois_souhaites: "",
      delai_max_mois: 12,
      pays_livraison: "France",
      zone_preferee: BriefInputZonePreferee.france,
      chaleur_souhaitee: 5,
      brillance_souhaitee: 5,
      facons_recherchees: [],
      personnalisation: false,
      description_libre: "",
      email: "",
      consentement_transmission: false
    }
  });

  const createBrief = useCreateBrief();
  const recommend = useRecommend();

  const onSubmit = (data: any) => {
    // Cast empty email to undefined
    if (data.email === "") data.email = undefined;
    
    if (data.consentement_transmission || data.email) {
      createBrief.mutate({ data }, {
        onSuccess: (res) => {
          setReceipt({
            reference: res.reference,
            portail_musicien: res.portail_musicien,
            recommandations: res.recommandations,
            isSaved: true
          });
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
      });
    } else {
      recommend.mutate({ data }, {
        onSuccess: (res) => {
          setReceipt({
            reference: "TEST-" + Math.random().toString(36).substring(7),
            recommandations: res.resultats,
            isSaved: false
          });
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
      });
    }
  };

  if (receipt) {
    return (
      <div className="container mx-auto px-4 py-16">
        <div className="max-w-4xl mx-auto space-y-12">
          
          <div className="text-center space-y-4">
            <div className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-green-900/10 text-green-700 mb-4">
              <CheckCircle2 className="h-8 w-8" />
            </div>
            <h1 className="text-4xl md:text-5xl font-serif text-primary">Analyse Terminée</h1>
            <p className="text-xl text-muted-foreground font-light max-w-2xl mx-auto">
              Notre intelligence artificielle a analysé votre brief (Réf: {receipt.reference}). Voici les artisans qui correspondent le mieux à votre projet.
            </p>
            {receipt.portail_musicien && (
              <div className="mt-6 inline-block bg-primary/10 border border-primary/20 rounded-md p-4 max-w-lg mx-auto text-left">
                <p className="text-sm text-primary mb-2 font-medium">Conservez ce lien précieux :</p>
                <p className="text-xs text-muted-foreground mb-3">
                  Ce lien vous donne accès à votre portail personnel. Il vous permettra de suivre et d'accepter les propositions des artisans.
                </p>
                <div className="flex items-center justify-between bg-background border border-border p-2 rounded">
                  <code className="text-xs text-foreground truncate block w-full">{window.location.origin}{receipt.portail_musicien}</code>
                  <Button variant="ghost" size="sm" className="ml-2 h-8 px-2 shrink-0" onClick={() => {
                    navigator.clipboard.writeText(`${window.location.origin}${receipt.portail_musicien}`);
                  }}>
                    Copier
                  </Button>
                </div>
                <div className="mt-4 text-center">
                  <Button asChild variant="outline" size="sm" className="w-full">
                    <Link href={receipt.portail_musicien}>
                      Ouvrir mon portail
                    </Link>
                  </Button>
                </div>
              </div>
            )}
          </div>

          <div className="space-y-8 mt-12">
            <h2 className="text-2xl font-serif text-primary flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-accent" />
              Recommandations
            </h2>
            
            {receipt.recommandations.length === 0 ? (
              <div className="bg-card border border-border/50 p-12 text-center">
                <p className="text-muted-foreground">Aucun artisan ne correspond parfaitement à vos critères très spécifiques. Vous pouvez élargir votre budget ou vos zones de préférence.</p>
                <Button variant="outline" className="mt-6" onClick={() => setReceipt(null)}>Modifier le brief</Button>
              </div>
            ) : (
              <div className="space-y-6">
                {receipt.recommandations.map((rec: any, index: number) => (
                  <div key={rec.slug} className="bg-card border border-border/50 p-8 flex flex-col md:flex-row gap-8 relative overflow-hidden transition-all hover:border-primary/30">
                    <div className="absolute top-0 right-0 bg-primary text-primary-foreground px-4 py-1 font-serif text-sm">
                      Match {Math.round(rec.correspondance * 100)}%
                    </div>
                    
                    <div className="flex-1 space-y-4">
                      <div>
                        <span className="text-xs uppercase tracking-wider text-muted-foreground mb-1 block">
                          {rec.type === 'luthier' ? 'Luthier' : 'Marque Émergente'} • {index + 1}er Choix
                        </span>
                        <h3 className="text-3xl font-serif text-primary">{rec.nom}</h3>
                      </div>
                      
                      <div className="grid sm:grid-cols-2 gap-x-8 gap-y-6 pt-4 border-t border-border/50">
                        <div>
                          <h4 className="font-medium text-sm text-foreground mb-2 flex items-center gap-1.5">
                            <CheckCircle2 className="h-4 w-4 text-green-600" /> Points forts
                          </h4>
                          <ul className="space-y-1">
                            {rec.points_correspondance.map((pt: string, i: number) => (
                              <li key={i} className="text-sm text-muted-foreground flex items-start gap-2">
                                <span className="text-green-600/50 mt-0.5">•</span> {pt}
                              </li>
                            ))}
                          </ul>
                        </div>
                        
                        {rec.points_vigilance.length > 0 && (
                          <div>
                            <h4 className="font-medium text-sm text-foreground mb-2 flex items-center gap-1.5">
                              <span className="h-4 w-4 rounded-full border border-accent text-accent flex items-center justify-center text-[10px] font-bold">!</span> 
                              À considérer
                            </h4>
                            <ul className="space-y-1">
                              {rec.points_vigilance.map((pt: string, i: number) => (
                                <li key={i} className="text-sm text-muted-foreground flex items-start gap-2">
                                  <span className="text-accent/50 mt-0.5">•</span> {pt}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    </div>
                    
                    <div className="md:w-48 flex flex-col justify-end gap-3 shrink-0">
                      <Button asChild className="w-full rounded-none bg-primary text-primary-foreground hover:bg-primary/90">
                        <Link href={`/fiche/${rec.slug}`}>Voir la fiche <ChevronRight className="h-4 w-4 ml-1" /></Link>
                      </Button>
                      {rec.site_web && (
                        <Button asChild variant="outline" className="w-full rounded-none">
                          <a href={rec.site_web} target="_blank" rel="noopener noreferrer">Site officiel</a>
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
            
            <div className="text-center pt-8">
              <Button variant="ghost" onClick={() => setReceipt(null)} className="text-muted-foreground hover:text-primary">
                Nouveau projet
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-16">
      <div className="max-w-3xl mx-auto">
        <div className="mb-12">
          <h1 className="text-4xl md:text-5xl font-serif text-primary mb-4">Trouver votre artisan</h1>
          <p className="text-lg text-muted-foreground font-light leading-relaxed">
            Détaillez votre projet. Notre système analysera l'approche, le son et les spécificités des luthiers de notre annuaire pour vous suggérer les meilleures correspondances.
          </p>
        </div>

        <div className="bg-card border border-border/50 p-6 md:p-10">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-12">
              
              {/* Section 1: Le Projet */}
              <div className="space-y-6">
                <h2 className="text-2xl font-serif text-primary border-b border-border/50 pb-2">1. Le Projet</h2>
                
                <div className="grid md:grid-cols-2 gap-6">
                  <FormField
                    control={form.control}
                    name="type_instrument"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Type d'instrument</FormLabel>
                        <Select onValueChange={field.onChange} defaultValue={field.value}>
                          <FormControl>
                            <SelectTrigger className="rounded-none bg-background">
                              <SelectValue placeholder="Sélectionnez..." />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value={BriefInputTypeInstrument.electrique}>Guitare Électrique</SelectItem>
                            <SelectItem value={BriefInputTypeInstrument.acoustique}>Guitare Acoustique</SelectItem>
                            <SelectItem value={BriefInputTypeInstrument.basse}>Basse</SelectItem>
                            <SelectItem value={BriefInputTypeInstrument.autre}>Autre (folk, etc.)</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  
                  <FormField
                    control={form.control}
                    name="delai_max_mois"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Délai maximum acceptable (mois)</FormLabel>
                        <FormControl>
                          <Input type="number" {...field} value={field.value || ''} className="rounded-none bg-background" />
                        </FormControl>
                        <FormDescription>Laissez vide si vous n'êtes pas pressé.</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <div className="grid md:grid-cols-2 gap-6">
                  <FormField
                    control={form.control}
                    name="budget_min_eur"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Budget minimum (€)</FormLabel>
                        <FormControl>
                          <Input type="number" {...field} className="rounded-none bg-background" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  
                  <FormField
                    control={form.control}
                    name="budget_max_eur"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Budget maximum (€)</FormLabel>
                        <FormControl>
                          <Input type="number" {...field} className="rounded-none bg-background" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={form.control}
                  name="description_libre"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Décrivez votre projet idéal</FormLabel>
                      <FormControl>
                        <Textarea 
                          placeholder="Qu'attendez-vous de cet instrument ? Quels sont vos goûts ? Pourquoi faire appel à un luthier ?" 
                          className="rounded-none bg-background min-h-[150px] resize-y" 
                          {...field} 
                        />
                      </FormControl>
                      <FormDescription>Plus vous serez précis, plus le matching sera pertinent.</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              {/* Section 2: Son & Approche */}
              <div className="space-y-6">
                <h2 className="text-2xl font-serif text-primary border-b border-border/50 pb-2">2. Son & Approche</h2>
                
                <div className="space-y-8 pt-4">
                  <FormField
                    control={form.control}
                    name="chaleur_souhaitee"
                    render={({ field }) => (
                      <FormItem>
                        <div className="flex justify-between items-center mb-4">
                          <FormLabel className="text-base">Chaleur recherchée</FormLabel>
                          <span className="text-sm font-medium text-accent">{field.value}/10</span>
                        </div>
                        <FormControl>
                          <Slider
                            value={[field.value || 5]}
                            onValueChange={(v) => field.onChange(v[0])}
                            max={10}
                            step={1}
                            className="[&_[role=slider]]:border-primary [&_[role=slider]]:bg-primary"
                          />
                        </FormControl>
                        <div className="flex justify-between text-xs text-muted-foreground mt-2">
                          <span>Froid / Analytique</span>
                          <span>Chaud / Rond</span>
                        </div>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="brillance_souhaitee"
                    render={({ field }) => (
                      <FormItem>
                        <div className="flex justify-between items-center mb-4">
                          <FormLabel className="text-base">Brillance recherchée</FormLabel>
                          <span className="text-sm font-medium text-accent">{field.value}/10</span>
                        </div>
                        <FormControl>
                          <Slider
                            value={[field.value || 5]}
                            onValueChange={(v) => field.onChange(v[0])}
                            max={10}
                            step={1}
                            className="[&_[role=slider]]:border-primary [&_[role=slider]]:bg-primary"
                          />
                        </FormControl>
                        <div className="flex justify-between text-xs text-muted-foreground mt-2">
                          <span>Mat / Sombre</span>
                          <span>Brillant / Tranchant</span>
                        </div>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <div className="grid md:grid-cols-2 gap-6 pt-4">
                  <FormField
                    control={form.control}
                    name="styles"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Styles de musique (séparés par des virgules)</FormLabel>
                        <FormControl>
                          <Input placeholder="Jazz, Metal, Post-Rock..." className="rounded-none bg-background" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  
                  <FormField
                    control={form.control}
                    name="bois_souhaites"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Essences de bois (optionnel)</FormLabel>
                        <FormControl>
                          <Input placeholder="Acajou, Érable, Noyer local..." className="rounded-none bg-background" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                {meta?.facettes && (
                  <div className="space-y-6 pt-6 border-t border-border/50">
                    <h3 className="font-serif text-lg text-primary">Méthodes et caractéristiques recherchées (Optionnel)</h3>
                    <div className="grid gap-8">
                      {meta.facettes.map(famille => (
                        <div key={famille.cle} className="space-y-4">
                          <h4 className="font-medium text-foreground">{famille.titre}</h4>
                          <div className="grid sm:grid-cols-2 gap-4">
                            {famille.cases.map(facette => (
                              <FormField
                                key={facette.cle}
                                control={form.control}
                                name="facons_recherchees"
                                render={({ field }) => {
                                  return (
                                    <FormItem
                                      className="flex flex-row items-start space-x-3 space-y-0"
                                    >
                                      <FormControl>
                                        <Checkbox
                                          checked={field.value?.includes(facette.cle)}
                                          onCheckedChange={(checked) => {
                                            return checked
                                              ? field.onChange([...(field.value || []), facette.cle])
                                              : field.onChange(
                                                  field.value?.filter(
                                                    (value) => value !== facette.cle
                                                  )
                                                )
                                          }}
                                        />
                                      </FormControl>
                                      <div className="space-y-1 leading-none">
                                        <FormLabel className="font-normal cursor-pointer">
                                          {facette.libelle}
                                        </FormLabel>
                                        {facette.aide && (
                                          <FormDescription className="text-xs">
                                            {facette.aide}
                                          </FormDescription>
                                        )}
                                      </div>
                                    </FormItem>
                                  )
                                }}
                              />
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Section 3: Logistique & Contact */}
              <div className="space-y-6">
                <h2 className="text-2xl font-serif text-primary border-b border-border/50 pb-2">3. Pratique</h2>
                
                <div className="grid md:grid-cols-2 gap-6">
                  <FormField
                    control={form.control}
                    name="zone_preferee"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Zone géographique de l'artisan</FormLabel>
                        <Select onValueChange={field.onChange} defaultValue={field.value}>
                          <FormControl>
                            <SelectTrigger className="rounded-none bg-background">
                              <SelectValue placeholder="Sélectionnez..." />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value={BriefInputZonePreferee.france}>France uniquement</SelectItem>
                            <SelectItem value={BriefInputZonePreferee.europe}>Europe</SelectItem>
                            <SelectItem value={BriefInputZonePreferee.monde}>Monde entier</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  
                  <FormField
                    control={form.control}
                    name="pays_livraison"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Votre pays de résidence</FormLabel>
                        <FormControl>
                          <Input placeholder="France" className="rounded-none bg-background" {...field} value={field.value || ''} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <div className="grid md:grid-cols-2 gap-6 border-t border-border/50 pt-6">
                  <FormField
                    control={form.control}
                    name="email"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Email (Optionnel)</FormLabel>
                        <FormControl>
                          <Input type="email" placeholder="pour recevoir une copie" className="rounded-none bg-background" {...field} value={field.value || ''} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  
                  <div className="space-y-4">
                    <FormField
                      control={form.control}
                      name="personnalisation"
                      render={({ field }) => (
                        <FormItem className="flex flex-row items-center justify-between rounded-none border border-border/50 bg-background p-4 shadow-sm">
                          <div className="space-y-0.5">
                            <FormLabel className="text-base">Sur-mesure intégral</FormLabel>
                            <FormDescription>
                              Je veux un instrument 100% unique, pas un modèle de catalogue.
                            </FormDescription>
                          </div>
                          <FormControl>
                            <Switch
                              checked={field.value}
                              onCheckedChange={field.onChange}
                            />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                    
                    <FormField
                      control={form.control}
                      name="consentement_transmission"
                      render={({ field }) => (
                        <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-none border border-border/50 bg-background p-4 shadow-sm">
                          <FormControl>
                            <Checkbox
                              checked={field.value}
                              onCheckedChange={field.onChange}
                            />
                          </FormControl>
                          <div className="space-y-1 leading-none">
                            <FormLabel>
                              Sauvegarder ce projet
                            </FormLabel>
                            <FormDescription>
                              Enregistrer pour obtenir un numéro de référence. Si vous ne cochez pas, seul un test sera effectué.
                            </FormDescription>
                          </div>
                        </FormItem>
                      )}
                    />
                  </div>
                </div>
              </div>

              <div className="pt-8">
                <Button 
                  type="submit" 
                  size="lg" 
                  className="w-full rounded-none bg-primary hover:bg-primary/90 text-primary-foreground h-14 text-lg"
                  disabled={createBrief.isPending || recommend.isPending}
                >
                  {(createBrief.isPending || recommend.isPending) ? "Analyse en cours..." : "Lancer l'analyse"} 
                  {!(createBrief.isPending || recommend.isPending) && <ArrowRight className="ml-2 h-5 w-5" />}
                </Button>
                <p className="text-center text-sm text-muted-foreground mt-4">
                  Vos données ne sont utilisées que pour le calcul des recommandations. NovaLuth ne stocke aucune donnée personnelle sans consentement explicite.
                </p>
              </div>
            </form>
          </Form>
        </div>
      </div>
    </div>
  );
}
