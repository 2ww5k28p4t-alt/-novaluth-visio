import { Link } from "wouter";
import { ArrowLeft } from "lucide-react";

export default function Classement() {
  return (
    <div className="container mx-auto px-4 py-16">
      <div className="max-w-3xl mx-auto space-y-12">
        <div>
          <Link href="/legal" className="inline-flex items-center text-sm text-muted-foreground hover:text-primary mb-6 transition-colors">
            <ArrowLeft className="h-4 w-4 mr-2" /> Retour aux mentions légales
          </Link>
          <h1 className="text-4xl md:text-5xl font-serif text-primary mb-6">Ordre d'affichage et transparence</h1>
          <p className="text-lg text-muted-foreground font-light leading-relaxed">
            NovaLuth s'engage à présenter les artisans de manière neutre, équitable et sans biais commercial. Voici comment fonctionne notre annuaire.
          </p>
        </div>

        <div className="space-y-8">
          <section className="bg-card border border-border/50 p-6 md:p-8">
            <h2 className="text-2xl font-serif text-primary mb-4">Rotation neutre (Tri par défaut)</h2>
            <p className="text-muted-foreground mb-4">
              Par défaut, l'annuaire affiche les résultats selon un "Tri équitable". Il s'agit d'une rotation quotidienne neutre et aléatoire, mais identique pour tous les visiteurs ce jour-là. Cela garantit que chaque artisan bénéficie d'une visibilité tournante, sans qu'aucun ne soit figé au sommet de la liste.
            </p>
          </section>

          <section className="space-y-6">
            <h2 className="text-2xl font-serif text-primary">Le tri explicite</h2>
            <p className="text-muted-foreground">
              Vous pouvez à tout moment choisir de trier les résultats selon vos préférences : par délai, budget, ordre alphabétique, ou récence de mise à jour. Ces critères sont purement mathématiques.
            </p>
          </section>

          <section className="space-y-6">
            <h2 className="text-2xl font-serif text-primary">Les filtres n'avantagent personne</h2>
            <p className="text-muted-foreground">
              Utiliser des filtres (budget, délai, styles...) se contente de restreindre la liste aux artisans correspondants. Les filtres n'agissent pas comme un système de "boost". De plus, l'absence d'une donnée déclarée (par exemple, si un artisan n'a pas précisé son budget) ne le fera pas disparaître des recherches par budget ; nous estimons préférable de vous le présenter plutôt que de le masquer.
            </p>
          </section>

          <section className="space-y-6">
            <h2 className="text-2xl font-serif text-primary">Zéro score, zéro étoile</h2>
            <p className="text-muted-foreground">
              Vous ne trouverez ni notes de 0 à 10, ni niveaux, ni étoiles sur NovaLuth. Nous ne jugeons pas la qualité ou la valeur du travail d'un luthier. Notre rôle est de vous fournir des caractéristiques descriptives (méthodes de travail, spécifications sonores) pour vous aider à trouver ce qui vous correspond.
            </p>
          </section>

          <section className="space-y-6">
            <h2 className="text-2xl font-serif text-primary">Zéro placement payant</h2>
            <p className="text-muted-foreground">
              Aucun artisan ne peut payer pour apparaître plus haut dans les résultats. Les frais d'accès aux fonctionnalités de mise en relation de la plateforme n'ont aucune influence sur la position dans l'annuaire public.
            </p>
          </section>

          <section className="space-y-6">
            <h2 className="text-2xl font-serif text-primary">Origine des méthodes de travail</h2>
            <p className="text-muted-foreground">
               Les « façons de travailler » affichées sur les fiches proviennent des informations publiques de l’atelier. Elles restent présentées avec leur provenance jusqu’à ce que l’artisan relise et confirme sa fiche.
            </p>
          </section>
        </div>

        <div className="pt-8 border-t border-border/50 text-center">
          <Link href="/annuaire" className="text-primary underline hover:text-accent">
            Retourner à l'annuaire
          </Link>
        </div>
      </div>
    </div>
  );
}
