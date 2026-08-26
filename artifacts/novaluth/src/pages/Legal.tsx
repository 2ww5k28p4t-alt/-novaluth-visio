import { Scale, ShieldCheck, HeartHandshake } from "lucide-react";

export default function Legal() {
  return (
    <div className="container mx-auto px-4 py-16">
      <div className="max-w-3xl mx-auto space-y-16">
        
        <div className="text-center space-y-4">
          <h1 className="text-4xl md:text-5xl font-serif text-primary">Transparence & Mentions Légales</h1>
          <p className="text-xl text-muted-foreground font-light">
            Notre engagement envers les artisans et les musiciens.
          </p>
        </div>

        <div className="grid sm:grid-cols-3 gap-8">
          <div className="bg-card border border-border/50 p-6 text-center space-y-3">
            <Scale className="h-8 w-8 text-primary mx-auto" />
            <h3 className="font-serif text-lg text-primary">Indépendance</h3>
            <p className="text-sm text-muted-foreground">Aucune commission, aucune affiliation commerciale avec les marques présentées.</p>
          </div>
          <div className="bg-card border border-border/50 p-6 text-center space-y-3">
            <ShieldCheck className="h-8 w-8 text-primary mx-auto" />
            <h3 className="font-serif text-lg text-primary">Données Libres</h3>
            <p className="text-sm text-muted-foreground">Fiches construites sur des données publiques. Chaque artisan peut réclamer et modifier sa fiche.</p>
          </div>
          <div className="bg-card border border-border/50 p-6 text-center space-y-3">
            <HeartHandshake className="h-8 w-8 text-primary mx-auto" />
            <h3 className="font-serif text-lg text-primary">Respect</h3>
            <p className="text-sm text-muted-foreground">Nous ne vendons pas les données des musiciens. Les briefs restent confidentiels.</p>
          </div>
        </div>

        <div className="prose prose-stone dark:prose-invert max-w-none text-muted-foreground">
          <h2 className="text-2xl font-serif text-primary">1. Édition du service</h2>
          <p>
            NovaLuth est une plateforme expérimentale d'information et de mise en relation algorithmique (ci-après "le Service"). 
            Ce service n'est pas une place de marché, un e-commerce, ou un intermédiaire de paiement.
          </p>
          
          <h2 className="text-2xl font-serif text-primary mt-8">2. Statut des fiches artisans</h2>
          <p>
            Les fiches présentes dans l'annuaire sont créées à partir de données publiques (sites web des luthiers, réseaux sociaux, interviews) et d'un traitement algorithmique visant à extraire les spécificités de chaque artisan.
          </p>
          <p>
            Les fiches portant la mention "Fiche vérifiée" ont été validées par l'artisan lui-même. Si vous êtes artisan et souhaitez revendiquer, modifier ou supprimer votre fiche, vous pouvez nous contacter via l'Espace Artisan.
          </p>

          <h2 className="text-2xl font-serif text-primary mt-8">3. Absence de garantie</h2>
          <p>
            NovaLuth ne garantit en aucun cas les prestations, délais, tarifs ou la qualité des instruments fournis par les artisans référencés. La mise en relation s'effectue à titre informatif. Le contrat de réalisation ou de vente se fait exclusivement entre le musicien et l'artisan.
          </p>
          <p>
            Les budgets et délais indiqués sont des moyennes observées et ne constituent en aucun cas un devis ou un engagement contractuel.
          </p>

          <h2 className="text-2xl font-serif text-primary mt-8">4. Données personnelles</h2>
          <p>
            Les informations renseignées dans le formulaire "Trouver son instrument" (le Brief) sont utilisées uniquement pour le calcul de compatibilité. Si vous fournissez un email, il ne sera utilisé que pour vous envoyer les résultats de l'analyse, sauf si vous cochez explicitement la case de consentement pour la transmission à un artisan.
          </p>
        </div>
      </div>
    </div>
  );
}