import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import {
  ArrowLeft,
  Camera,
  CameraOff,
  Check,
  Copy,
  Loader2,
  MessageSquare,
  Mic,
  MicOff,
  MonitorUp,
  PhoneOff,
  RefreshCw,
  Send,
  ShieldCheck,
  Users,
  Video,
  X,
} from "lucide-react";
import { Link } from "wouter";
import {
  useGetMeetConfig,
  useGetMeetIceConfig,
  type MeetIceConfig,
} from "@workspace/api-client-react";

type IceConfig = Omit<MeetIceConfig, "iceServers"> & { iceServers: RTCIceServer[] };

type RemotePeer = {
  id: string;
  name: string;
  stream: MediaStream;
  audio: boolean;
  video: boolean;
};

type PeerConnectionState = RemotePeer & { pc: RTCPeerConnection };

type JoinResponse = {
  ok: boolean;
  error?: string;
  selfId?: string;
  room?: string;
  peers?: Array<{ id: string; name: string }>;
};

type ChatMessage = {
  from: string;
  name: string;
  text: string;
  at: number;
};

const socketPath = "/api/socket.io";

function initials(name: string) {
  return name.trim().charAt(0).toUpperCase() || "?";
}

function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop());
}

export default function P2PMeet() {
  const params = new URLSearchParams(window.location.search);
  const [name, setName] = useState(() => params.get("name") ?? localStorage.getItem("p2pmeet.name") ?? "");
  const [room, setRoom] = useState(() => params.get("room") ?? "");
  const [code, setCode] = useState("");
  const { data: config, isError: configQueryFailed } = useGetMeetConfig();
  const { data: iceData, isError: iceQueryFailed } = useGetMeetIceConfig();
  const iceConfig = useMemo<IceConfig | null>(
    () =>
      iceData
        ? {
            ...iceData,
            iceServers: iceData.iceServers.map((server) => ({
              urls: server.urls,
              ...(server.username ? { username: server.username } : {}),
              ...(server.credential ? { credential: server.credential } : {}),
            })),
          }
        : null,
    [iceData],
  );
  const configError = configQueryFailed || iceQueryFailed
    ? "La configuration de la salle est indisponible."
    : "";
  const [joinError, setJoinError] = useState("");
  const [joined, setJoined] = useState(false);
  const [joining, setJoining] = useState(false);
  const [activeRoom, setActiveRoom] = useState("");
  const [selfId, setSelfId] = useState("");
  const [localStreamReady, setLocalStreamReady] = useState(false);
  const [remotePeers, setRemotePeers] = useState<RemotePeer[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatText, setChatText] = useState("");
  const [chatOpen, setChatOpen] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [sharing, setSharing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [connectionState, setConnectionState] = useState<"ready" | "connecting" | "connected" | "offline">("ready");

  const socketRef = useRef<Socket | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const cameraTrackRef = useRef<MediaStreamTrack | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef(new Map<string, PeerConnectionState>());
  const videoRefs = useRef(new Map<string, HTMLVideoElement>());
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const facingModeRef = useRef<"user" | "environment">("user");
  const activeRoomRef = useRef("");

  const showPeerStream = useCallback((peer: RemotePeer) => {
    const video = videoRefs.current.get(peer.id);
    if (video && video.srcObject !== peer.stream) video.srcObject = peer.stream;
  }, []);

  const updatePeer = useCallback((id: string, update: Partial<RemotePeer>) => {
    setRemotePeers((current) =>
      current.map((peer) => (peer.id === id ? { ...peer, ...update } : peer)),
    );
    const peer = peersRef.current.get(id);
    if (peer) Object.assign(peer, update);
  }, []);

  const createPeer = useCallback(
    (peerId: string, peerName: string, initiator: boolean) => {
      const existing = peersRef.current.get(peerId);
      if (existing) return existing;

      const pc = new RTCPeerConnection({
        iceServers: iceConfig?.iceServers ?? [],
        iceTransportPolicy: iceConfig?.iceTransportPolicy ?? "all",
        bundlePolicy: "max-bundle",
        rtcpMuxPolicy: "require",
        iceCandidatePoolSize: 2,
      });
      const stream = new MediaStream();
      const peer: PeerConnectionState = {
        id: peerId,
        name: peerName,
        stream,
        audio: true,
        video: true,
        pc,
      };
      peersRef.current.set(peerId, peer);
      setRemotePeers((current) => [...current, peer]);

      localStreamRef.current?.getTracks().forEach((track) => {
        pc.addTrack(track, localStreamRef.current as MediaStream);
      });
      pc.ontrack = (event) => {
        event.streams[0]?.getTracks().forEach((track) => {
          if (!stream.getTracks().includes(track)) stream.addTrack(track);
        });
        showPeerStream(peer);
        setRemotePeers((current) =>
          current.map((item) => (item.id === peerId ? { ...item, stream } : item)),
        );
      };
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          socketRef.current?.emit("signal", {
            to: peerId,
            data: { candidate: event.candidate },
          });
        }
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "connected") setConnectionState("connected");
        if (pc.connectionState === "failed") {
          setConnectionState("offline");
          pc.restartIce?.();
        }
      };

      if (initiator) {
        void pc
          .createOffer()
          .then((offer) => pc.setLocalDescription(offer))
          .then(() => {
            socketRef.current?.emit("signal", {
              to: peerId,
              data: { sdp: pc.localDescription },
            });
          })
          .catch(() => setJoinError("La négociation avec un participant a échoué."));
      }
      return peer;
    },
    [iceConfig, showPeerStream],
  );

  const removePeer = useCallback((peerId: string) => {
    const peer = peersRef.current.get(peerId);
    if (!peer) return;
    peer.pc.close();
    peersRef.current.delete(peerId);
    videoRefs.current.delete(peerId);
    setRemotePeers((current) => current.filter((item) => item.id !== peerId));
  }, []);

  const handleSignal = useCallback(
    async ({ from, name: peerName, data }: { from: string; name?: string; data: { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit } }) => {
      const peer = createPeer(from, peerName || "Invité", false);
      try {
        if (data.sdp) {
          await peer.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
          if (data.sdp.type === "offer") {
            const answer = await peer.pc.createAnswer();
            await peer.pc.setLocalDescription(answer);
            socketRef.current?.emit("signal", {
              to: from,
              data: { sdp: peer.pc.localDescription },
            });
          }
        } else if (data.candidate) {
          await peer.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        }
      } catch {
        setJoinError("La signalisation WebRTC a rencontré une erreur.");
      }
    },
    [createPeer],
  );

  useEffect(() => {
    return () => {
      stopStream(localStreamRef.current);
      stopStream(screenStreamRef.current);
      peersRef.current.forEach((peer) => peer.pc.close());
      socketRef.current?.disconnect();
    };
  }, []);

  useEffect(() => {
    if (localVideoRef.current && localStreamRef.current) {
      localVideoRef.current.srcObject = sharing ? screenStreamRef.current : localStreamRef.current;
    }
  }, [sharing, localStreamReady]);

  const join = async (event: React.FormEvent) => {
    event.preventDefault();
    setJoinError("");
    const cleanName = name.trim();
    const cleanRoom = room.trim();
    if (!cleanName || !cleanRoom) {
      setJoinError("Indiquez votre prénom et le nom de la salle.");
      return;
    }
    if (!iceConfig) {
      setJoinError(configError || "La configuration réseau n'est pas encore prête.");
      return;
    }
    setJoining(true);
    setConnectionState("connecting");
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
        throw new Error("WebRTC_NOT_SUPPORTED");
      }
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: {
            facingMode: facingModeRef.current,
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30, max: 30 },
          },
        });
      } catch (error) {
        const mediaError = error as DOMException;
        if (mediaError.name !== "NotFoundError" && mediaError.name !== "OverconstrainedError") throw error;
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        setCamOn(false);
      }
      localStreamRef.current = stream;
      cameraTrackRef.current = stream.getVideoTracks()[0] ?? null;
      setLocalStreamReady(true);
      localStorage.setItem("p2pmeet.name", cleanName);

      const socket = io({ path: socketPath, transports: ["websocket", "polling"] });
      socketRef.current = socket;
      socket.on("connect", () => {
        socket.emit(
          "join",
          { room: cleanRoom, name: cleanName, code },
          (response: JoinResponse) => {
            if (!response.ok) {
              setJoinError(response.error || "Connexion refusée.");
              stopStream(localStreamRef.current);
              socket.disconnect();
              setLocalStreamReady(false);
              setConnectionState("ready");
              setJoining(false);
              return;
            }
            const joinedRoom = response.room || cleanRoom;
            activeRoomRef.current = joinedRoom;
            setActiveRoom(joinedRoom);
            setSelfId(response.selfId || "");
            setJoined(true);
            setJoining(false);
            setConnectionState("connected");
            window.history.replaceState(null, "", `?room=${encodeURIComponent(joinedRoom)}`);
            response.peers?.forEach((peer) => createPeer(peer.id, peer.name, true));
          },
        );
      });
      socket.on("peer-joined", ({ id, name: peerName }: { id: string; name: string }) => {
        createPeer(id, peerName, false);
      });
      socket.on("signal", handleSignal);
      socket.on("peer-left", ({ id }: { id: string }) => removePeer(id));
      socket.on("state", ({ from, audio, video }: { from: string; audio: boolean; video: boolean }) => {
        updatePeer(from, { audio, video });
      });
      socket.on("chat", (message: ChatMessage) => setChatMessages((current) => [...current, message]));
      socket.on("disconnect", () => setConnectionState("offline"));
    } catch (error) {
      const message = error instanceof Error && error.message === "WebRTC_NOT_SUPPORTED"
        ? "Ce navigateur ne prend pas en charge WebRTC."
        : error instanceof DOMException && error.name === "NotAllowedError"
          ? "Autorisez l'accès à la caméra et au micro dans les réglages du navigateur."
          : "Impossible d'accéder à la caméra ou au micro.";
      setJoinError(message);
      setConnectionState("ready");
      setJoining(false);
    }
  };

  const broadcastState = (audio: boolean, video: boolean) => {
    socketRef.current?.emit("state", { audio, video });
  };

  const toggleMic = () => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (!track) {
      setJoinError("Aucun micro détecté.");
      return;
    }
    const next = !micOn;
    track.enabled = next;
    setMicOn(next);
    broadcastState(next, camOn);
  };

  const toggleCamera = () => {
    const track = sharing ? cameraTrackRef.current : localStreamRef.current?.getVideoTracks()[0];
    if (!track) {
      setJoinError("Aucune caméra détectée.");
      return;
    }
    const next = !camOn;
    track.enabled = next;
    setCamOn(next);
    broadcastState(micOn, next);
  };

  const replaceOutgoingVideo = async (track: MediaStreamTrack) => {
    await Promise.all(
      Array.from(peersRef.current.values()).map(async ({ pc }) => {
        const sender = pc.getSenders().find((item) => item.track?.kind === "video");
        if (sender) await sender.replaceTrack(track);
      }),
    );
  };

  const flipCamera = async () => {
    if (sharing || !navigator.mediaDevices) return;
    facingModeRef.current = facingModeRef.current === "user" ? "environment" : "user";
    try {
      const fresh = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: facingModeRef.current, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      const newTrack = fresh.getVideoTracks()[0];
      if (!newTrack) return;
      await replaceOutgoingVideo(newTrack);
      const oldTrack = localStreamRef.current?.getVideoTracks()[0];
      if (oldTrack && localStreamRef.current) {
        localStreamRef.current.removeTrack(oldTrack);
        oldTrack.stop();
        localStreamRef.current.addTrack(newTrack);
      }
      cameraTrackRef.current = newTrack;
      newTrack.enabled = camOn;
      if (localVideoRef.current && localStreamRef.current) localVideoRef.current.srcObject = localStreamRef.current;
    } catch {
      setJoinError("Impossible de changer de caméra sur cet appareil.");
    }
  };

  const toggleShare = async () => {
    if (sharing) {
      stopStream(screenStreamRef.current);
      screenStreamRef.current = null;
      setSharing(false);
      if (cameraTrackRef.current) await replaceOutgoingVideo(cameraTrackRef.current);
      return;
    }
    if (!navigator.mediaDevices.getDisplayMedia) {
      setJoinError("Le partage d'écran n'est pas disponible sur ce navigateur.");
      return;
    }
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: false });
      const screenTrack = screenStream.getVideoTracks()[0];
      if (!screenTrack) return;
      await replaceOutgoingVideo(screenTrack);
      screenStreamRef.current = screenStream;
      setSharing(true);
      screenTrack.addEventListener("ended", () => {
        void toggleShare();
      });
    } catch (error) {
      if (error instanceof DOMException && error.name !== "NotAllowedError") {
        setJoinError("Partage d'écran impossible.");
      }
    }
  };

  const leave = () => {
    peersRef.current.forEach((peer) => peer.pc.close());
    peersRef.current.clear();
    stopStream(localStreamRef.current);
    stopStream(screenStreamRef.current);
    localStreamRef.current = null;
    screenStreamRef.current = null;
    cameraTrackRef.current = null;
    socketRef.current?.disconnect();
    socketRef.current = null;
    setRemotePeers([]);
    setJoined(false);
    setLocalStreamReady(false);
    setActiveRoom("");
    setSelfId("");
    setChatMessages([]);
    setChatOpen(false);
    setConnectionState("ready");
    window.history.replaceState(null, "", window.location.pathname);
  };

  const copyInvite = async () => {
    const invite = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(activeRoomRef.current)}`;
    try {
      await navigator.clipboard.writeText(invite);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setJoinError(invite);
    }
  };

  const sendChat = (event: React.FormEvent) => {
    event.preventDefault();
    const text = chatText.trim();
    if (!text) return;
    socketRef.current?.emit("chat", { text });
    setChatText("");
  };

  const totalParticipants = remotePeers.length + 1;
  const connectionLabel =
    connectionState === "connected" ? "Connecté" :
      connectionState === "offline" ? "Signalisation interrompue" :
        connectionState === "connecting" ? "Connexion…" : "Prêt à rejoindre";

  if (!joined) {
    return (
      <main className="min-h-[calc(100vh-5rem)] bg-[#0b0f14] px-4 py-10 text-slate-100 sm:py-16">
        <div className="mx-auto w-full max-w-xl">
          <Link href="/" className="mb-8 inline-flex items-center gap-2 text-sm text-slate-400 transition hover:text-white">
            <ArrowLeft className="h-4 w-4" /> Retour à NovaLuth
          </Link>
          <section className="overflow-hidden rounded-3xl border border-slate-700/70 bg-[#172029] shadow-2xl">
            <div className="border-b border-slate-700/70 bg-[radial-gradient(circle_at_top,rgba(61,220,151,0.18),transparent_65%)] px-6 py-8 text-center sm:px-10">
              <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl border border-emerald-400/30 bg-emerald-400/10">
                <Video className="h-7 w-7 text-emerald-300" />
              </div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-[0.28em] text-emerald-300">NovaLuth Meet</p>
              <h1 className="font-serif text-4xl text-white">Un échange direct, sans intermédiaire</h1>
              <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-slate-300">
                Une salle temporaire où l’audio et la vidéo circulent directement entre les navigateurs.
              </p>
            </div>
            <form onSubmit={join} className="space-y-5 p-6 sm:p-10">
              <label className="block space-y-2">
                <span className="text-sm font-medium text-slate-200">Votre prénom</span>
                <input value={name} onChange={(event) => setName(event.target.value)} maxLength={24} required placeholder="Ex. Alex" className="h-12 w-full rounded-xl border border-slate-600 bg-[#0b0f14] px-4 text-sm outline-none transition placeholder:text-slate-600 focus:border-emerald-400" />
              </label>
              <label className="block space-y-2">
                <span className="text-sm font-medium text-slate-200">Nom de la salle</span>
                <input value={room} onChange={(event) => setRoom(event.target.value)} maxLength={60} required placeholder="Ex. projet-atelier" className="h-12 w-full rounded-xl border border-slate-600 bg-[#0b0f14] px-4 text-sm outline-none transition placeholder:text-slate-600 focus:border-emerald-400" />
              </label>
              {config?.accessCodeRequired && (
                <label className="block space-y-2">
                  <span className="text-sm font-medium text-slate-200">Code d’accès</span>
                  <input value={code} onChange={(event) => setCode(event.target.value)} type="password" maxLength={64} required className="h-12 w-full rounded-xl border border-slate-600 bg-[#0b0f14] px-4 text-sm outline-none focus:border-emerald-400" />
                </label>
              )}
              <button type="submit" disabled={joining || !iceConfig} className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-emerald-400 px-5 font-semibold text-[#0b0f14] transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-60">
                {joining ? <Loader2 className="h-5 w-5 animate-spin" /> : <Users className="h-5 w-5" />}
                {joining ? "Connexion…" : "Rejoindre la salle"}
              </button>
              {(joinError || configError) && <p className="rounded-xl border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-200" role="alert">{joinError || configError}</p>}
              <div className="space-y-2 border-t border-slate-700/70 pt-5 text-xs leading-5 text-slate-400">
                <p className="flex gap-2"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" /> Média chiffré de bout en bout, sans enregistrement côté NovaLuth.</p>
                <p className="flex gap-2"><RefreshCw className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" /> Jusqu’à {config?.maxPeers ?? 8} participants, avec relais TURN si configuré.</p>
                <p className="text-slate-500">{iceConfig?.warning ?? "Vérification de la configuration réseau…"}</p>
              </div>
            </form>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-[calc(100vh-5rem)] flex-col bg-[#0b0f14] text-slate-100">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-700/70 bg-[#131a22] px-4 py-4 sm:px-6">
        <div className="flex items-center gap-3">
          <span className={`h-3 w-3 rounded-full ${connectionState === "connected" ? "bg-emerald-400" : connectionState === "offline" ? "bg-red-400" : "bg-slate-500"}`} />
          <div>
            <p className="font-semibold text-white">{activeRoom}</p>
            <p className="text-xs text-slate-400">{connectionLabel}</p>
          </div>
          <span className="rounded-full border border-slate-600 px-2 py-0.5 text-xs text-slate-300">{totalParticipants}</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={copyInvite} className="inline-flex items-center gap-2 rounded-lg border border-slate-600 px-3 py-2 text-sm transition hover:border-emerald-300 hover:text-emerald-300">
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} {copied ? "Copié" : "Inviter"}
          </button>
          <button onClick={() => setChatOpen(true)} className="inline-flex items-center gap-2 rounded-lg border border-slate-600 px-3 py-2 text-sm transition hover:border-emerald-300 hover:text-emerald-300">
            <MessageSquare className="h-4 w-4" /> Chat
          </button>
        </div>
      </header>

      <div className="relative flex-1 p-3 sm:p-5">
        <div className={`mx-auto grid min-h-[52vh] max-w-7xl gap-3 ${totalParticipants <= 2 ? "lg:grid-cols-2" : "md:grid-cols-2 xl:grid-cols-3"}`}>
          <div className="relative min-h-[260px] overflow-hidden rounded-2xl border border-emerald-400/30 bg-[#172029]">
            <div className="absolute inset-0 flex items-center justify-center text-6xl font-bold text-slate-500">{initials(name)}</div>
            <video ref={localVideoRef} autoPlay playsInline muted className={`relative z-10 h-full min-h-[260px] w-full object-cover ${camOn || sharing ? "opacity-100" : "opacity-0"}`} />
            <div className="absolute bottom-3 left-3 z-20 rounded-lg bg-black/65 px-3 py-1.5 text-sm">{name} (vous)</div>
            <div className="absolute right-3 top-3 z-20 flex gap-2">
              {!micOn && <span className="rounded-full bg-red-400/90 p-2"><MicOff className="h-4 w-4 text-white" /></span>}
              {!camOn && !sharing && <span className="rounded-full bg-red-400/90 p-2"><CameraOff className="h-4 w-4 text-white" /></span>}
            </div>
          </div>
          {remotePeers.map((peer) => (
            <div key={peer.id} className="relative min-h-[260px] overflow-hidden rounded-2xl border border-slate-700 bg-[#172029]">
              <div className="absolute inset-0 flex items-center justify-center text-6xl font-bold text-slate-500">{initials(peer.name)}</div>
              <video
                ref={(element) => {
                  if (element) {
                    videoRefs.current.set(peer.id, element);
                    showPeerStream(peer);
                  } else videoRefs.current.delete(peer.id);
                }}
                autoPlay
                playsInline
                className={`relative z-10 h-full min-h-[260px] w-full object-cover ${peer.video ? "opacity-100" : "opacity-0"}`}
              />
              <div className="absolute bottom-3 left-3 z-20 rounded-lg bg-black/65 px-3 py-1.5 text-sm">{peer.name}</div>
              <div className="absolute right-3 top-3 z-20 flex gap-2">
                {!peer.audio && <span className="rounded-full bg-red-400/90 p-2"><MicOff className="h-4 w-4 text-white" /></span>}
                {!peer.video && <span className="rounded-full bg-red-400/90 p-2"><CameraOff className="h-4 w-4 text-white" /></span>}
              </div>
            </div>
          ))}
        </div>
        {joinError && <p className="mx-auto mt-4 max-w-2xl rounded-xl border border-red-400/30 bg-red-400/10 p-3 text-center text-sm text-red-200">{joinError}</p>}
      </div>

      <nav className="grid grid-cols-5 gap-2 border-t border-slate-700/70 bg-[#131a22] p-3 sm:flex sm:justify-center sm:gap-3">
        <button onClick={toggleMic} aria-pressed={micOn} className={`flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl border px-2 text-xs transition ${micOn ? "border-slate-600 bg-[#172029] hover:border-emerald-300" : "border-red-400/50 bg-red-400/15 text-red-100"}`}>
          {micOn ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />} <span className="hidden sm:inline">{micOn ? "Micro actif" : "Micro coupé"}</span>
        </button>
        <button onClick={toggleCamera} aria-pressed={camOn} className={`flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl border px-2 text-xs transition ${camOn ? "border-slate-600 bg-[#172029] hover:border-emerald-300" : "border-red-400/50 bg-red-400/15 text-red-100"}`}>
          {camOn ? <Camera className="h-5 w-5" /> : <CameraOff className="h-5 w-5" />} <span className="hidden sm:inline">{camOn ? "Caméra active" : "Caméra coupée"}</span>
        </button>
        <button onClick={() => void flipCamera()} disabled={sharing} className="flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl border border-slate-600 bg-[#172029] px-2 text-xs transition hover:border-emerald-300 disabled:opacity-40">
          <RefreshCw className="h-5 w-5" /> <span className="hidden sm:inline">Changer de caméra</span>
        </button>
        <button onClick={() => void toggleShare()} className={`flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl border px-2 text-xs transition ${sharing ? "border-emerald-400/50 bg-emerald-400/15 text-emerald-200" : "border-slate-600 bg-[#172029] hover:border-emerald-300"}`}>
          <MonitorUp className="h-5 w-5" /> <span className="hidden sm:inline">{sharing ? "Partage en cours" : "Partager l’écran"}</span>
        </button>
        <button onClick={leave} className="flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl border border-red-400/50 bg-red-400/15 px-2 text-xs text-red-100 transition hover:bg-red-400/25">
          <PhoneOff className="h-5 w-5" /> <span className="hidden sm:inline">Quitter</span>
        </button>
      </nav>

      {chatOpen && (
        <aside className="fixed inset-y-0 right-0 z-50 flex w-full max-w-sm flex-col border-l border-slate-700 bg-[#172029] shadow-2xl">
          <div className="flex items-center justify-between border-b border-slate-700 px-4 py-4">
            <h2 className="font-serif text-xl">Messages</h2>
            <button onClick={() => setChatOpen(false)} aria-label="Fermer le chat" className="rounded-lg p-2 text-slate-400 hover:bg-slate-700 hover:text-white"><X className="h-5 w-5" /></button>
          </div>
          <div className="flex-1 space-y-4 overflow-y-auto p-4" aria-live="polite">
            {chatMessages.length === 0 && <p className="py-8 text-center text-sm text-slate-500">Aucun message pour le moment.</p>}
            {chatMessages.map((message, index) => (
              <div key={`${message.at}-${index}`} className={message.from === selfId ? "text-right" : ""}>
                <p className="mb-1 text-xs text-slate-500">{message.from === selfId ? "Vous" : message.name} · {new Date(message.at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</p>
                <p className="inline-block max-w-[90%] break-words rounded-xl bg-[#0b0f14] px-3 py-2 text-left text-sm">{message.text}</p>
              </div>
            ))}
          </div>
          <form onSubmit={sendChat} className="flex gap-2 border-t border-slate-700 p-3">
            <input value={chatText} onChange={(event) => setChatText(event.target.value)} maxLength={800} placeholder="Écrire un message…" className="min-w-0 flex-1 rounded-lg border border-slate-600 bg-[#0b0f14] px-3 py-2 text-sm outline-none focus:border-emerald-400" />
            <button type="submit" aria-label="Envoyer" className="rounded-lg bg-emerald-400 px-3 text-[#0b0f14] transition hover:bg-emerald-300"><Send className="h-4 w-4" /></button>
          </form>
        </aside>
      )}
    </main>
  );
}