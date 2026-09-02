import { Link, useLocation } from "wouter";
import { ReactNode } from "react";
import { useHealthCheck, getHealthCheckQueryKey } from "@workspace/api-client-react";
import { assetPath } from "@/lib/asset-path";

export function Shell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { data: health } = useHealthCheck({ query: { retry: false, refetchInterval: 30000, queryKey: getHealthCheckQueryKey() } });

  const navLinks = [
    { href: "/annuaire", label: "Annuaire" },
    { href: "/brief", label: "Mon projet" },
    { href: "/legal", label: "Informations légales" },
  ];

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background selection:bg-primary selection:text-primary-foreground">
      <header className="nv-entete w-full">
        <div className="nv-entete-inner">
          <Link href="/" className="nv-logo transition-opacity hover:opacity-80" aria-label="NovaLuth, accueil">
            <img src={assetPath("novaluth-wordmark.png")} alt="NovaLuth" width="1200" height="247" />
          </Link>

          <nav className="nv-nav" aria-label="Navigation principale">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                data-active={location.startsWith(link.href)}
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>

      <main className="flex-1">
        {children}
      </main>

      <footer className="nv-pied mt-auto">
        <div className="container mx-auto px-4">
          <img className="nv-pied-logo" src={assetPath("novaluth-wordmark.png")} alt="NovaLuth" width="1200" height="247" />
          <p className="nv-baseline">L'avenir de l'instrument</p>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Un espace de découverte pour les musiciens exigeants. Les commandes et paiements
            simulés sont encadrés séparément ; la relation de lutherie reste entre le musicien et l’artisan.
          </p>
          <nav className="nv-pied-links items-center">
            {health?.status === 'ok' && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground mr-2">
                <span className="nv-point h-2 w-2">
                </span>
                API
              </div>
            )}
            <Link href="/legal">Transparence & légal</Link>
            <Link href="/admin" className="text-sm text-muted-foreground hover:text-primary transition-colors">
              Administration
            </Link>
            <div className="text-muted-foreground mx-2">•</div>
            <Link href="/annuaire" className="text-sm text-muted-foreground hover:text-primary transition-colors">
              Espace Artisan
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}