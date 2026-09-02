import { ArrowRight, BookOpenCheck, FileText, HeartHandshake, Scale, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "wouter";
import { legalKitConfig } from "@/lib/legal-kit-config";

export default function Legal() {
  const prices = [
    ["Accès à un petit projet (< 1 500 €)", "Atelier", legalKitConfig.tarifs.accesPetitProjet],
    ["Accès à un projet courant (1 500 € à 4 000 €)", "Atelier", legalKitConfig.tarifs.accesProjetCourant],
    ["Accès à une grande commande (> 4 000 €)", "Atelier", legalKitConfig.tarifs.accesGrandeCommande],
    ["Carnet d’accès — solde 79,95 €", "Atelier", legalKitConfig.tarifs.carnetPetitPrix],
    ["Carnet d’accès — solde 159,90 €", "Atelier", legalKitConfig.tarifs.carnetGrandPrix],
    ["Création et vérification d’une fiche", "Atelier", legalKitConfig.tarifs.ficheVerifiee],
    ["Abonnement atelier — mensuel", "Atelier", legalKitConfig.tarifs.abonnementAtelierMensuel],
    ["Mise en avant éditoriale", "Marque", legalKitConfig.tarifs.contenuMarque + legalKitConfig.tarifs.encartMarque],
  ] as const;
  const euro = (value: number) =>
    new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(value);

  return (
    <div className="container mx-auto px-4 py-16">
      <div className="mx-auto max-w-5xl space-y-14">
        <div className="nv-page-intro space-y-4">
          <p className="text-xs uppercase tracking-[0.22em] text-primary">Cadre juridique NovaLuth</p>
          <h1 className="text-4xl text-foreground md:text-5xl">Transparence, contrats & mentions légales</h1>
          <p className="text-xl font-light text-muted-foreground">
            Les informations essentielles sur notre rôle, nos offres et les documents utiles pour contractualiser.
          </p>
        </div>

        <div className="grid gap-5 md:grid-cols-3">
          <LegalResource href="/legal/devis" icon={<FileText className="h-8 w-8 text-primary" />} title="Générateur de devis">
            Préparez un devis adapté à la qualité du client et au mode de conclusion.
          </LegalResource>
          <LegalResource href="/legal/contrat" icon={<Scale className="h-8 w-8 text-primary" />} title="Contrat de prestation">
            Un modèle structuré en 19 articles, avec rétractation, garanties et médiation.
          </LegalResource>
          <LegalResource href="/legal/notice" icon={<BookOpenCheck className="h-8 w-8 text-primary" />} title="Notice des clauses">
            Comprenez la base légale, l’utilité et le point de vigilance de chaque mention.
          </LegalResource>
        </div>

        <div className="grid gap-8 sm:grid-cols-3">
          <LegalPrinciple icon={<Scale className="mx-auto h-8 w-8 text-primary" />} title="Indépendance">
            L’annuaire n’est pas classé selon une note ou une rémunération. Les contenus commerciaux sont signalés.
          </LegalPrinciple>
          <LegalPrinciple icon={<ShieldCheck className="mx-auto h-8 w-8 text-primary" />} title="Données maîtrisées">
            Les fiches reposent sur des données publiques. Chaque artisan peut réclamer et modifier sa fiche.
          </LegalPrinciple>
          <LegalPrinciple icon={<HeartHandshake className="mx-auto h-8 w-8 text-primary" />} title="Respect">
            Les briefs restent confidentiels et ne sont transmis qu’après accord explicite du musicien.
          </LegalPrinciple>
        </div>

        <div className="space-y-10 text-muted-foreground">
          <section>
            <h2 className="font-serif text-2xl text-primary">Grille tarifaire NovaLuth</h2>
            <p className="mt-3">
              Les montants ci-dessous correspondent aux offres décrites dans le kit juridique. Les paiements restent simulés dans cette version de la plateforme.
            </p>
            <div className="mt-5 overflow-x-auto border border-border/60">
              <table className="w-full min-w-[620px] text-left text-sm">
                <thead><tr className="border-b border-border text-muted-foreground"><th className="px-4 py-3">Prestation</th><th className="px-4 py-3">Payée par</th><th className="px-4 py-3 text-right">Montant</th></tr></thead>
                <tbody>{prices.map(([label, payer, value]) => <tr key={label} className="border-b border-border/50"><td className="px-4 py-3 text-foreground">{label}</td><td className="px-4 py-3">{payer}</td><td className="px-4 py-3 text-right">{euro(value)}</td></tr>)}</tbody>
              </table>
            </div>
            <p className="mt-3 text-sm">
              Une commande protégée ne débite rien lors de la déclaration. Le musicien dispose de 7 jours pour confirmer ou refuser ; la confirmation déclenche les frais d’engagement de 29 €, puis la commission de 2 % à la livraison, plafonnée à 149 €.
            </p>
          </section>

          <section>
            <h2 className="font-serif text-2xl text-primary">1. Édition et rôle du service</h2>
            <p className="mt-3">
              NovaLuth est un service numérique d’annuaire et de mise en relation entre musiciens, ateliers de lutherie et marques émergentes. NovaLuth n’est pas partie au contrat de lutherie conclu entre un musicien et un atelier et ne garantit ni la qualité des travaux ni leur délai.
            </p>
          </section>

          <section>
            <h2 className="font-serif text-2xl text-primary">2. Statut des fiches artisans</h2>
            <p className="mt-3">
              Les fiches sont créées à partir de données publiques et d’un traitement algorithmique visant à extraire les spécificités de chaque artisan. Les fiches vérifiées ont été validées par l’artisan. Une demande de rectification ou de retrait peut être faite depuis l’Espace Artisan.
            </p>
            <p className="mt-3">
              Les budgets et délais indiqués sont des moyennes observées et ne constituent ni un devis ni un engagement contractuel.
            </p>
          </section>

          <section>
            <h2 className="font-serif text-2xl text-primary">3. Données personnelles</h2>
            <p className="mt-3">
              Les informations du Brief servent au calcul de compatibilité. Un e-mail est utilisé pour envoyer les résultats, sauf consentement explicite pour une transmission à un artisan.
            </p>
            <p className="mt-3">
              Pour une commande protégée, les coordonnées nécessaires au suivi sont traitées pour l’exécution du parcours, les notifications et les obligations légales. Contact RGPD : {legalKitConfig.contacts.rgpd}.
            </p>
          </section>

          <section>
            <h2 className="font-serif text-2xl text-primary">4. Identité visuelle et classement</h2>
            <p className="mt-3">
              Le mot-symbole, le globe, la corde et la baseline NovaLuth constituent une identité graphique indissociable. Leur reproduction hors du service requiert une autorisation écrite préalable.
            </p>
            <p className="mt-3">
              Pour connaître l’ordre d’affichage, la rotation quotidienne et l’absence de biais commercial, consultez la <Link href="/legal/classement" className="text-primary underline hover:text-accent">page dédiée au classement</Link>.
            </p>
          </section>

          <section>
            <h2 className="font-serif text-2xl text-primary">5. Prestataires, sources et médiation</h2>
            <p className="mt-3">
              NovaLuth publie la liste de ses prestataires techniques, les sources déclarées, les tarifs observés et les limites appliquées à la lecture des pages. Consultez la <Link href="/transparence" className="text-primary underline hover:text-accent">page de transparence</Link>.
            </p>
            <p className="mt-3">
              Toute réclamation peut être adressée à {legalKitConfig.contacts.reclamation}. Le médiateur de la consommation doit être complété avant l’usage contractuel des modèles : {legalKitConfig.mediateur.nom}.
            </p>
          </section>

          <section className="border border-amber-500/40 bg-amber-500/10 p-5 text-sm">
            <strong className="text-foreground">Informations à compléter avant usage contractuel :</strong>{" "}
            adresse, SIREN, SIRET, téléphone, représentant, assurance et médiateur agréé. Les modèles sont informatifs et doivent être validés au regard de la situation réelle de NovaLuth.
          </section>
        </div>
      </div>
    </div>
  );
}

function LegalResource({ href, icon, title, children }: { href: string; icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <Link href={href} className="group border border-border/50 bg-card p-6 transition-colors hover:border-primary/60">
      {icon}
      <h3 className="mt-4 font-serif text-lg text-primary">{title}</h3>
      <p className="mt-2 text-sm text-muted-foreground">{children}</p>
      <span className="mt-4 inline-flex items-center gap-2 text-sm text-primary">Ouvrir <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" /></span>
    </Link>
  );
}

function LegalPrinciple({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="space-y-3 border border-border/50 bg-card p-6 text-center">
      {icon}
      <h3 className="font-serif text-lg text-primary">{title}</h3>
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  );
}