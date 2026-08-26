import { Link, useLocation } from "wouter";
import { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Music } from "lucide-react";
import { useHealthCheck, getHealthCheckQueryKey } from "@workspace/api-client-react";

export function Shell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { data: health } = useHealthCheck({ query: { retry: false, refetchInterval: 30000, queryKey: getHealthCheckQueryKey() } });

  const navLinks = [
    { href: "/annuaire", label: "Annuaire" },
    { href: "/brief", label: "Trouver son instrument" },
  ];

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background selection:bg-primary selection:text-primary-foreground">
      <header className="sticky top-0 z-50 w-full border-b border-border/40 bg-background/80 backdrop-blur-md">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 transition-opacity hover:opacity-80">
            <Music className="h-6 w-6 text-primary" strokeWidth={1.5} />
            <span className="font-serif font-semibold text-xl tracking-tight text-primary">NovaLuth</span>
          </Link>
          
          <nav className="hidden md:flex items-center gap-6">
            {navLinks.map((link) => (
              <Link 
                key={link.href} 
                href={link.href}
                className={`text-sm font-medium transition-colors hover:text-primary ${
                  location.startsWith(link.href) ? "text-primary" : "text-muted-foreground"
                }`}
              >
                {link.label}
              </Link>
            ))}
          </nav>

          <div className="flex items-center gap-4">
            <Button variant="outline" size="sm" asChild className="hidden md:flex rounded-none border-primary/20 text-primary hover:bg-primary/5">
              <Link href="/admin">Espace Artisan</Link>
            </Button>
            <Button size="sm" asChild className="rounded-none bg-primary text-primary-foreground hover:bg-primary/90">
              <Link href="/brief">Démarrer un projet</Link>
            </Button>
          </div>
        </div>
      </header>

      <main className="flex-1">
        {children}
      </main>

      <footer className="border-t border-border/40 bg-muted/30 mt-auto">
        <div className="container mx-auto px-4 py-12 flex flex-col md:flex-row justify-between items-center gap-6">
          <div className="flex items-center gap-2 opacity-80">
            <Music className="h-5 w-5 text-primary" strokeWidth={1.5} />
            <span className="font-serif font-medium text-lg text-primary">NovaLuth</span>
          </div>
          
          <p className="text-sm text-muted-foreground text-center md:text-left max-w-md">
            Un espace de découverte pour les musiciens exigeants. 
            Aucun achat direct, aucune commission, simplement l'artisanat dans toute sa transparence.
          </p>

          <nav className="flex items-center gap-4">
            {health?.status === 'ok' && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground mr-2">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-500 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-green-600"></span>
                </span>
                API
              </div>
            )}
            <Link href="/legal" className="text-sm text-muted-foreground hover:text-primary transition-colors">
              Transparence & Légal
            </Link>
            <Link href="/admin" className="text-sm text-muted-foreground hover:text-primary transition-colors">
              Administration
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}