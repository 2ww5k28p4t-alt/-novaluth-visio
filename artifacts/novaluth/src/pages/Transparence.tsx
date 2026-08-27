import { Link } from "wouter";
import {
  Activity,
  ArrowLeft,
  BookOpen,
  CheckCircle2,
  CircleAlert,
  Cpu,
  Search,
  ShieldCheck,
  Share2,
  XCircle,
} from "lucide-react";
import {
  getGetTransparencyQueryKey,
  useGetTransparency,
  type Provider,
  type Transparency,
} from "@workspace/api-client-react";

const categories = {
  inference: {
    label: "Inférence et traitement",
    description: "Traitement ponctuel de texte, toujours soumis à une liste blanche de modèles.",
    Icon: Cpu,
  },
  recherche: {
    label: "Recherche d’adresses",
    description: "Les moteurs servent à repérer des pages ; NovaLuth ne republie pas leurs extraits.",
    Icon: Search,
  },
  lecture: {
    label: "Lecture de pages",
    description: "La lecture directe respecte robots.txt, les réservations TDM, la taille et la cadence par domaine.",
    Icon: BookOpen,
  },
  collecte: {
    label: "Collecte publique",
    description: "Les publications publiques sont uniquement des signaux de découverte et ne modifient jamais une fiche seules.",
    Icon: Share2,
  },
} as const;

function ProviderStatus({ provider }: { provider: Provider }) {
  if (provider.configure) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-green-500/10 text-green-400 border border-green-500/20">
        <CheckCircle2 className="h-3.5 w-3.5" />
        Configuré
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-muted text-muted-foreground border border-border">
      <XCircle className="h-3.5 w-3.5" />
      Non configuré
    </span>
  );
}

function ProviderSource({ value }: { value: string }) {
  if (!/^https?:\/\//i.test(value)) {
    return <span className="text-sm text-foreground/90">{value}</span>;
  }
  return (
    <a
      href={value}
      target="_blank"
      rel="noreferrer"
      className="text-primary underline underline-offset-4 hover:text-accent break-all"
    >
      Consulter la source déclarée
    </a>
  );
}

function ProviderCard({
  provider,
  category,
}: {
  provider: Provider;
  category: keyof typeof categories;
}) {
  const categoryInfo = categories[category];
  const Icon = categoryInfo.Icon;
  return (
    <article className="bg-card border border-border/50 rounded-xl overflow-hidden transition-colors hover:border-primary/30">
      <div className="p-6 md:p-8 space-y-6">
        <header className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm text-primary">
              <Icon className="h-5 w-5" />
              {categoryInfo.label}
            </div>
            <h2 className="text-2xl font-serif text-foreground">{provider.nom}</h2>
          </div>
          <ProviderStatus provider={provider} />
        </header>

        <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-5 pt-5 border-t border-border/30">
          <div className="space-y-1.5">
            <dt className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Réseau</dt>
            <dd className="text-sm text-foreground/90">
              {provider.reseau}
              {provider.netuid !== null ? ` · identifiant observé ${provider.netuid}` : ""}
            </dd>
          </div>
          <div className="space-y-1.5">
            <dt className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Tarification</dt>
            <dd className="text-sm text-foreground/90">{provider.tarif}</dd>
          </div>
          <div className="space-y-1.5">
            <dt className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Source</dt>
            <dd><ProviderSource value={provider.source} /></dd>
          </div>
          <div className="space-y-1.5">
            <dt className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Licence</dt>
            <dd className="text-sm text-foreground/90">{provider.licence}</dd>
          </div>
        </dl>

        {provider.reserve && (
          <div className="pt-5 border-t border-border/30 flex gap-3">
            <ShieldCheck className="h-5 w-5 text-primary shrink-0 mt-0.5" />
            <div className="space-y-1">
              <h3 className="text-xs font-semibold text-primary uppercase tracking-wider">Réserve</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">{provider.reserve}</p>
            </div>
          </div>
        )}
      </div>
    </article>
  );
}

function TransparencyContent({ data }: { data: Transparency }) {
  return (
    <div className="space-y-10">
      <div className="bg-card border border-border/50 rounded-xl p-6 md:p-8 space-y-4">
        <p className="text-lg text-foreground leading-relaxed">{data.engagement}</p>
        <ul className="space-y-3 text-sm text-muted-foreground">
          {data.donnees.map((item) => (
            <li key={item} className="flex gap-3">
              <ShieldCheck className="h-4 w-4 text-primary shrink-0 mt-1" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </div>

      {(Object.entries(categories) as [keyof typeof categories, (typeof categories)[keyof typeof categories]][]).map(
        ([key, details]) => (
          <section key={key} className="space-y-4">
            <div className="flex gap-3 items-start">
              <details.Icon className="h-5 w-5 text-primary mt-1" />
              <div>
                <h2 className="text-2xl font-serif text-primary">{details.label}</h2>
                <p className="text-sm text-muted-foreground">{details.description}</p>
              </div>
            </div>
            <div className="space-y-5">
              {data.besoins[key].map((provider) => (
                <ProviderCard key={provider.cle} provider={provider} category={key} />
              ))}
            </div>
          </section>
        ),
      )}

      <section className="bg-muted/30 border border-border/50 rounded-xl p-6 md:p-8 space-y-4">
        <h2 className="text-xl font-serif text-primary">Règles de fonctionnement</h2>
        <ul className="space-y-3 text-sm text-muted-foreground">
          {data.principes.map((principle) => (
            <li key={principle} className="flex gap-3">
              <Activity className="h-4 w-4 text-primary shrink-0 mt-1" />
              <span>{principle}</span>
            </li>
          ))}
        </ul>
        {data.hors_production.length > 0 && (
          <p className="text-sm text-muted-foreground border-t border-border/50 pt-4">
            Fournisseurs volontairement exclus de la production : {data.hors_production.join(", ")}.
          </p>
        )}
      </section>
    </div>
  );
}

export default function Transparence() {
  const { data, isLoading, isError } = useGetTransparency({
    query: { retry: 1, queryKey: getGetTransparencyQueryKey() },
  });

  return (
    <div className="container mx-auto px-4 py-16">
      <div className="max-w-3xl mx-auto space-y-12">
        <div className="space-y-6">
          <Link href="/legal" className="inline-flex items-center text-sm text-muted-foreground hover:text-primary transition-colors">
            <ArrowLeft className="h-4 w-4 mr-2" /> Retour aux mentions légales
          </Link>
          <div className="nv-page-intro space-y-4">
            <h1 className="text-4xl md:text-5xl font-serif text-primary">
              {data?.titre ?? "Prestataires et sources"}
            </h1>
            <p className="text-xl text-muted-foreground font-light leading-relaxed">
              Les services techniques déclarés par NovaLuth, leurs sources et les limites appliquées à leur usage.
            </p>
          </div>
        </div>

        {isLoading && (
          <div className="space-y-5 animate-pulse" aria-label="Chargement des prestataires">
            {[1, 2, 3].map((item) => (
              <div key={item} className="h-48 rounded-xl bg-card border border-border/50" />
            ))}
          </div>
        )}
        {isError && (
          <div className="bg-destructive/5 border border-destructive/20 rounded-xl p-8 text-center space-y-3">
            <CircleAlert className="h-10 w-10 text-destructive mx-auto" />
            <h2 className="text-lg font-serif text-destructive">Les données de transparence sont momentanément indisponibles</h2>
            <p className="text-sm text-muted-foreground">Réessayez dans quelques instants. Les parcours de l’annuaire restent disponibles.</p>
          </div>
        )}
        {data && <TransparencyContent data={data} />}
      </div>
    </div>
  );
}
