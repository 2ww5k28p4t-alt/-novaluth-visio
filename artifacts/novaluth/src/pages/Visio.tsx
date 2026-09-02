import { useEffect, useRef, useState } from "react";
import { useRoute } from "wouter";
import { useGetVisioRoom, getGetVisioRoomQueryKey, VisioRoom } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { CalendarClock, ExternalLink, LockKeyhole, Music2, ShieldCheck, Video, WifiOff } from "lucide-react";
import { format, parseISO } from "date-fns";
import { fr } from "date-fns/locale";

declare global {
  interface Window {
    JitsiMeetExternalAPI?: new (domain: string, options: {
      roomName: string;
      jwt?: string;
      parentNode: HTMLElement;
      width?: string;
      height?: string;
      configOverwrite?: Record<string, unknown>;
      interfaceConfigOverwrite?: Record<string, unknown>;
    }) => { dispose: () => void };
  }
}

function cleanDomain(domain: string) {
  return domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function encodeRoomPath(roomName: string) {
  return roomName.split("/").map(encodeURIComponent).join("/");
}

export default function Visio() {
  const [, params] = useRoute("/visio/:token");
  const token = params?.token || "";
  const { data: room, isLoading, isError } = useGetVisioRoom(token, {
    query: {
      enabled: !!token,
      queryKey: getGetVisioRoomQueryKey(token),
      retry: false,
    },
  });

  if (isLoading) return <VisioLoading />;

  if (isError || !room) {
    return (
      <main className="min-h-[100dvh] bg-background px-4 py-16">
        <Card className="mx-auto max-w-xl border-destructive/30 bg-card">
          <CardContent className="flex flex-col items-center p-10 text-center">
            <div className="rounded-full border border-destructive/20 bg-destructive/10 p-4">
              <WifiOff className="h-8 w-8 text-destructive" />
            </div>
            <h1 className="mt-5 font-serif text-3xl text-destructive">Salle indisponible</h1>
            <p className="mt-3 max-w-md text-muted-foreground">
              Ce lien de visioconférence est invalide ou a expiré. Demandez à l’atelier de vous transmettre un nouveau lien.
            </p>
          </CardContent>
        </Card>
      </main>
    );
  }

  return <VisioRoomView room={room} />;
}

function VisioLoading() {
  return (
    <main className="min-h-[100dvh] bg-background px-4 py-8 md:py-12">
      <div className="mx-auto max-w-6xl space-y-6">
        <Skeleton className="h-8 w-44" />
        <Skeleton className="h-16 w-2/3" />
        <Skeleton className="h-[min(68vh,640px)] w-full rounded-xl" />
      </div>
    </main>
  );
}

function VisioRoomView({ room }: { room: VisioRoom }) {
  const meetingRef = useRef<HTMLDivElement>(null);
  const [isApiReady, setIsApiReady] = useState(false);
  const [isFallback, setIsFallback] = useState(false);
  const domain = cleanDomain(room.domaine_jitsi);
  const directUrl = `https://${domain}/${encodeRoomPath(room.nom_salle)}${
    room.jeton_jwt ? `?jwt=${encodeURIComponent(room.jeton_jwt)}` : ""
  }`;
  const fallbackUrl = `https://${cleanDomain(room.domaine_jitsi_secours)}/${encodeRoomPath(
    room.nom_salle_secours,
  )}`;

  useEffect(() => {
    let disposed = false;
    let api: { dispose: () => void } | undefined;
    let fallbackTimer: number | undefined;
    const scriptId = "novaluth-jitsi-external-api";

    const mountMeeting = () => {
      if (disposed || !meetingRef.current || !window.JitsiMeetExternalAPI) {
        if (!disposed) setIsFallback(true);
        return;
      }
      try {
        api = new window.JitsiMeetExternalAPI(domain, {
          roomName: room.nom_salle,
          ...(room.jeton_jwt ? { jwt: room.jeton_jwt } : {}),
          parentNode: meetingRef.current,
          width: "100%",
          height: "100%",
          configOverwrite: {
            prejoinPageEnabled: true,
            disableAP: true,
            recording: { enabled: false },
            transcription: { enabled: false },
          },
          interfaceConfigOverwrite: {
            DISABLE_JOIN_LEAVE_NOTIFICATIONS: true,
            TOOLBAR_BUTTONS: ["microphone", "camera", "chat", "tileview", "fullscreen", "hangup"],
          },
        });
        setIsApiReady(true);
      } catch {
        setIsFallback(true);
      }
    };

    const existing = document.getElementById(scriptId) as HTMLScriptElement | null;
    if (window.JitsiMeetExternalAPI) {
      mountMeeting();
    } else if (existing) {
      existing.addEventListener("load", mountMeeting, { once: true });
      existing.addEventListener("error", () => setIsFallback(true), { once: true });
      fallbackTimer = window.setTimeout(mountMeeting, 1800);
    } else {
      const script = document.createElement("script");
      script.id = scriptId;
      script.src = `https://${domain}/external_api.js`;
      script.async = true;
      script.onload = mountMeeting;
      script.onerror = () => setIsFallback(true);
      document.head.appendChild(script);
    }

    return () => {
      disposed = true;
      if (fallbackTimer) window.clearTimeout(fallbackTimer);
      api?.dispose();
      if (meetingRef.current) meetingRef.current.innerHTML = "";
    };
  }, [domain, room.nom_salle, room.jeton_jwt]);

  return (
    <main className="min-h-[100dvh] bg-background px-4 py-6 md:px-8 md:py-10">
      <div className="mx-auto max-w-6xl">
        <header className="mb-6 flex flex-col gap-5 border-b border-border/60 pb-6 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="border-primary/25 bg-primary/5 text-primary">
                <LockKeyhole className="mr-1.5 h-3 w-3" /> Salle privée
              </Badge>
              <Badge variant="outline" className="border-border text-muted-foreground">
                {room.role === "atelier" ? "Côté atelier" : "Côté musicien"}
              </Badge>
              <Badge variant="outline" className="border-border text-muted-foreground">
                {room.mode_visio === "jaas" ? "JaaS prioritaire" : "Jitsi public"}
              </Badge>
            </div>
            <h1 className="max-w-3xl font-serif text-3xl leading-tight text-primary md:text-5xl">
              {room.objet_libelle}
            </h1>
            <p className="mt-2 flex items-center gap-2 text-muted-foreground">
              <Music2 className="h-4 w-4 text-accent" /> {room.atelier_nom}
            </p>
          </div>
          <div className="space-y-1 text-left text-sm text-muted-foreground md:text-right">
            <p className="font-mono text-xs uppercase tracking-wider text-foreground/70">{room.reference}</p>
            <p>{room.date_heure ? `Prévu le ${format(parseISO(room.date_heure), "d MMMM yyyy · HH:mm", { locale: fr })}` : "Horaire à convenir"}</p>
            <p className="flex items-center gap-1.5 md:justify-end"><CalendarClock className="h-3.5 w-3.5" /> Expire le {format(parseISO(room.expire_le), "d MMM yyyy · HH:mm", { locale: fr })}</p>
          </div>
        </header>

        <section className="overflow-hidden rounded-xl border border-primary/20 bg-card shadow-[0_20px_80px_rgba(45,25,80,0.22)]">
          <div className="flex items-center justify-between border-b border-border/60 bg-muted/20 px-4 py-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <span className={`h-2 w-2 rounded-full ${isApiReady ? "bg-emerald-500" : "bg-amber-500"}`} />
              {isApiReady ? "Connexion sécurisée" : "Préparation de la salle"}
            </div>
            <span className="hidden text-xs text-muted-foreground sm:block">Aucun enregistrement</span>
          </div>
          <div ref={meetingRef} data-testid="visio-meeting-container" className="min-h-[min(68vh,640px)] bg-[#17121f]">
            {isFallback && (
              <div className="flex min-h-[min(68vh,640px)] items-center justify-center p-6">
                <Card className="max-w-md border-amber-500/25 bg-background/95 text-center">
                  <CardHeader>
                    <div className="mx-auto rounded-full border border-amber-500/25 bg-amber-500/10 p-3">
                      <Video className="h-6 w-6 text-amber-500" />
                    </div>
                    <CardTitle className="font-serif">La salle intégrée n’a pas pu s’ouvrir</CardTitle>
                    <CardDescription>
                      {room.mode_visio === "jaas"
                        ? "JaaS n’a pas pu ouvrir la salle intégrée. Le service public Jitsi est disponible en secours."
                        : "La salle intégrée n’a pas pu s’ouvrir. Le service public Jitsi est disponible via son lien direct."} Vos échanges restent privés et ne sont pas enregistrés par NovaLuth.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Button data-testid="link-visio-direct" asChild className="w-full">
                      <a href={fallbackUrl} target="_blank" rel="noreferrer">
                        <ExternalLink className="mr-2 h-4 w-4" /> Ouvrir avec Jitsi public
                      </a>
                    </Button>
                    <p className="mt-3 break-all text-xs text-muted-foreground">{fallbackUrl}</p>
                  </CardContent>
                </Card>
              </div>
            )}
          </div>
        </section>

        <footer className="mt-5 grid gap-4 md:grid-cols-[1fr_auto] md:items-center">
          <p className="flex items-start gap-2 text-sm leading-relaxed text-muted-foreground">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            NovaLuth ne rejoint pas l’appel, ne l’enregistre pas et ne le transcrit pas. Cette visioconférence est gratuite, privée et temporaire.
          </p>
          {!isFallback && (
            <Button data-testid="button-visio-direct" variant="outline" size="sm" asChild>
              <a href={directUrl} target="_blank" rel="noreferrer"><ExternalLink className="mr-2 h-3.5 w-3.5" /> Lien direct</a>
            </Button>
          )}
        </footer>
      </div>
    </main>
  );
}