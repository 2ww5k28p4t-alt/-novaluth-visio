import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
} from 'wouter';

import { Shell } from '@/components/layout/Shell';
import Home from '@/pages/Home';
import Annuaire from '@/pages/Annuaire';
import Fiche from '@/pages/Fiche';
import Brief from '@/pages/Brief';
import Admin from '@/pages/Admin';
import Legal from '@/pages/Legal';
import Atelier from '@/pages/Atelier';
import Portail from '@/pages/Portail';
import NotFound from '@/pages/not-found';
import Classement from '@/pages/Classement';
import Transparence from '@/pages/Transparence';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function Router() {
  return (
    <Shell>
      <RoutedErrorBoundary>
        <Switch>
          <Route path="/" component={Home} />
          <Route path="/annuaire" component={Annuaire} />
          <Route path="/fiche/:slug" component={Fiche} />
          <Route path="/atelier/:slug" component={Atelier} />
          <Route path="/projets/:reference/portail/:token" component={Portail} />
          <Route path="/brief" component={Brief} />
          <Route path="/admin" component={Admin} />
          <Route path="/legal" component={Legal} />
          <Route path="/legal/classement" component={Classement} />
          <Route path="/transparence" component={Transparence} />
          <Route component={NotFound} />
        </Switch>
      </RoutedErrorBoundary>
    </Shell>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
