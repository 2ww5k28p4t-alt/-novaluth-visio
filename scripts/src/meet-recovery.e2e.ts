import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

type CdpReply = {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message?: string };
};

class CdpClient {
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as CdpReply;
      if (typeof message.id !== "number") return;
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.error) {
        request.reject(new Error(message.error.message || "Commande CDP refusée"));
      } else {
        request.resolve(message.result ?? {});
      }
    });
  }

  static async connect(url: string) {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error(`Connexion CDP impossible : ${url}`)), {
        once: true,
      });
    });
    return new CdpClient(socket);
  }

  send(method: string, params: Record<string, unknown> = {}) {
    const id = this.nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function waitForJson<T>(url: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json() as T;
    } catch (error) {
      lastError = error;
    }
    await delay(150);
  }
  throw new Error(`Délai dépassé pour ${url}: ${String(lastError ?? "aucune réponse")}`);
}

async function requireHttpEndpoint(url: string, label: string) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (error) {
    throw new Error(
      `${label} indisponible sur ${url}. Vérifiez que les workflows ` +
      `"artifacts/novaluth: web" et "artifacts/api-server: API Server" sont démarrés. ` +
      `Cause: ${String(error)}`,
    );
  }
}

async function requireChromium(chromium: string) {
  const child = spawn(chromium, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  }).catch((error) => {
    throw new Error(
      `Chromium est requis pour la validation Meet (CHROMIUM_BIN=${chromium}). Cause: ${String(error)}`,
    );
  });
  if (exitCode !== 0) {
    throw new Error(`Chromium ne démarre pas (${chromium}, code ${exitCode}): ${stderr.trim()}`);
  }
}

function signalBrowser(browser: ChildProcess, signal: NodeJS.Signals) {
  if (browser.pid && process.platform !== "win32") {
    try {
      process.kill(-browser.pid, signal);
      return;
    } catch {
      // Le processus principal peut déjà être sorti; tente alors le signal direct.
    }
  }
  browser.kill(signal);
}

async function openPage(debugPort: number, url: string) {
  const response = await fetch(
    `http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(url)}`,
    { method: "PUT" },
  );
  if (!response.ok) throw new Error(`Création de l'onglet refusée (${response.status})`);
  const target = await response.json() as { webSocketDebuggerUrl: string };
  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  await Promise.all([
    client.send("Page.enable"),
    client.send("Runtime.enable"),
    client.send("Network.enable"),
  ]);
  return client;
}

async function evaluate<T>(client: CdpClient, expression: string): Promise<T> {
  const response = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  const exception = response.exceptionDetails as { text?: string } | undefined;
  if (exception) throw new Error(exception.text || `Évaluation navigateur échouée : ${expression}`);
  const result = response.result as { value?: T; description?: string } | undefined;
  if (result?.description?.startsWith("Error:")) throw new Error(result.description);
  return result?.value as T;
}

async function waitFor(
  client: CdpClient,
  expression: string,
  description: string,
  timeoutMs = 20_000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastValue: unknown;
  while (Date.now() < deadline) {
    lastValue = await evaluate(client, expression);
    if (lastValue) return;
    await delay(200);
  }
  throw new Error(`${description} non observé dans le délai imparti (dernière valeur : ${String(lastValue)})`);
}

async function fillAndJoin(client: CdpClient, name: string, room: string) {
  await waitFor(
    client,
    `Boolean(document.querySelector('[data-testid="meet-join"]:not(:disabled)'))`,
    "formulaire Meet prêt",
  );
  await evaluate(
    client,
    `(() => {
      const setValue = (selector, value) => {
        const input = document.querySelector(selector);
        if (!(input instanceof HTMLInputElement)) throw new Error('champ absent: ' + selector);
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      setValue('[data-testid="meet-name"]', ${JSON.stringify(name)});
      setValue('[data-testid="meet-room"]', ${JSON.stringify(room)});
      document.querySelector('[data-testid="meet-join"]').click();
      return true;
    })()`,
  );
  await waitFor(
    client,
    `document.querySelector('[data-testid="meet-connection-status"]')?.textContent === 'Connecté'`,
    `${name} connecté`,
    30_000,
  );
}

const liveMediaExpression = `(() => {
  const local = document.querySelector('[data-testid="meet-local-video"]');
  const remote = document.querySelector('[data-testid="meet-remote-video"]');
  const live = (video) => {
    const stream = video?.srcObject;
    if (!(stream instanceof MediaStream)) return false;
    return stream.getAudioTracks().some((track) => track.readyState === 'live')
      && stream.getVideoTracks().some((track) => track.readyState === 'live');
  };
  return live(local) && live(remote);
})()`;

const mediaSnapshotExpression = `(() => {
  const describe = (video) => {
    const stream = video?.srcObject;
    return {
      hasStream: stream instanceof MediaStream,
      tracks: stream instanceof MediaStream
        ? stream.getTracks().map((track) => ({
            kind: track.kind,
            readyState: track.readyState,
            enabled: track.enabled,
            muted: track.muted,
          }))
        : [],
    };
  };
  return {
    status: document.querySelector('[data-testid="meet-connection-status"]')?.textContent,
    participantCount: document.querySelector('[data-testid="meet-participant-count"]')?.textContent,
    remoteTiles: document.querySelectorAll('[data-testid="meet-remote-peer"]').length,
    local: describe(document.querySelector('[data-testid="meet-local-video"]')),
    remote: describe(document.querySelector('[data-testid="meet-remote-video"]')),
    error: document.querySelector('[role="alert"]')?.textContent,
  };
})()`;

async function main() {
  const appUrl = process.env.MEET_E2E_URL ?? "http://127.0.0.1:80/meet";
  const chromium = process.env.CHROMIUM_BIN ?? "chromium";
  const debugPort = Number(process.env.MEET_E2E_DEBUG_PORT ?? 9228);
  const profile = await mkdtemp(path.join(tmpdir(), "novaluth-meet-e2e-"));
  let browser: ChildProcess | null = null;
  let browserExited: Promise<void> | null = null;
  const pages: CdpClient[] = [];
  let browserLogs = "";

  try {
    console.log(
      "Précontrôle: Chromium headless avec faux périphériques audio/vidéo; " +
      "les workflows NovaLuth web et API doivent être accessibles.",
    );
    await requireChromium(chromium);
    await requireHttpEndpoint(appUrl, "Frontend NovaLuth Meet");
    const healthUrl = new URL("/api/healthz", appUrl).toString();
    await requireHttpEndpoint(healthUrl, "API NovaLuth");

    browser = spawn(chromium, [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--autoplay-policy=no-user-gesture-required",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      "about:blank",
    ], { detached: process.platform !== "win32", stdio: ["ignore", "ignore", "pipe"] });
    browserExited = new Promise<void>((resolve) => {
      browser?.once("exit", () => resolve());
    });
    browser.stderr?.on("data", (chunk) => {
      browserLogs = `${browserLogs}${String(chunk)}`.slice(-8_000);
    });

    await waitForJson(`http://127.0.0.1:${debugPort}/json/version`);
    console.log("1/6 Chromium prêt");
    const alice = await openPage(debugPort, appUrl);
    const bob = await openPage(debugPort, appUrl);
    pages.push(alice, bob);

    const room = `reprise-${Date.now().toString(36)}`;
    await fillAndJoin(alice, "Alice", room);
    await fillAndJoin(bob, "Bob", room);
    console.log("2/6 Deux participants connectés");

    try {
      await Promise.all([
        waitFor(alice, `document.querySelector('[data-testid="meet-participant-count"]')?.textContent === '2'`, "Alice voit deux participants"),
        waitFor(bob, `document.querySelector('[data-testid="meet-participant-count"]')?.textContent === '2'`, "Bob voit deux participants"),
        waitFor(alice, liveMediaExpression, "Alice reçoit les flux audio et vidéo", 30_000),
        waitFor(bob, liveMediaExpression, "Bob reçoit les flux audio et vidéo", 30_000),
      ]);
    } catch (error) {
      console.error("État média Alice:", JSON.stringify(await evaluate(alice, mediaSnapshotExpression)));
      console.error("État média Bob:", JSON.stringify(await evaluate(bob, mediaSnapshotExpression)));
      throw error;
    }
    console.log("3/6 Flux audio et vidéo reçus dans les deux sens");

    for (let second = 0; second < 8; second += 2) {
      await delay(2_000);
      const stable = await Promise.all([
        evaluate<boolean>(alice, liveMediaExpression),
        evaluate<boolean>(bob, liveMediaExpression),
      ]);
      if (!stable.every(Boolean)) throw new Error("un flux audio ou vidéo s'est interrompu pendant la tenue prolongée");
    }
    console.log("4/6 Flux restés actifs pendant huit secondes");

    await alice.send("Network.emulateNetworkConditions", {
      offline: true,
      latency: 0,
      downloadThroughput: 0,
      uploadThroughput: 0,
    });
    await waitFor(
      alice,
      `document.querySelector('[data-testid="meet-connection-status"]')?.textContent === 'Reconnexion…'`,
      "message de reconnexion",
      15_000,
    );
    await delay(1_500);
    await alice.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
      connectionType: "wifi",
    });

    await Promise.all([
      waitFor(
        alice,
        `document.querySelector('[data-testid="meet-recovery-message"]')?.textContent?.includes('appel vidéo a repris')`,
        "message de reprise",
        30_000,
      ),
      waitFor(
        alice,
        `document.querySelector('[data-testid="meet-participant-count"]')?.textContent === '2'`,
        "deux participants après la reprise",
        30_000,
      ),
      waitFor(
        bob,
        `document.querySelectorAll('[data-testid="meet-remote-peer"]').length === 1`,
        "absence de doublon chez Bob",
        30_000,
      ),
    ]);
    await Promise.all([
      waitFor(alice, liveMediaExpression, "flux repris chez Alice", 30_000),
      waitFor(bob, liveMediaExpression, "flux repris chez Bob", 30_000),
    ]);
    console.log("5/6 Reconnexion, renégociation et absence de doublon confirmées");

    await evaluate(bob, `document.querySelector('[data-testid="meet-leave"]').click()`);
    await Promise.all([
      waitFor(
        alice,
        `document.querySelector('[data-testid="meet-participant-count"]')?.textContent === '1'`,
        "sortie volontaire visible chez Alice",
      ),
      waitFor(
        bob,
        `Boolean(document.querySelector('[data-testid="meet-join"]'))`,
        "retour de Bob au formulaire",
      ),
    ]);
    console.log("6/6 Sortie volontaire propagée");

    console.log("NovaLuth Meet recovery E2E passed: media stable, reconnect recovered, no duplicate, voluntary leave propagated.");
  } catch (error) {
    if (browserLogs) console.error(browserLogs);
    throw error;
  } finally {
    pages.forEach((page) => page.close());
    if (browser && browserExited) {
      signalBrowser(browser, "SIGTERM");
      const exited = await Promise.race([
        browserExited.then(() => true),
        delay(3_000).then(() => false),
      ]);
      if (!exited) {
        signalBrowser(browser, "SIGKILL");
        await Promise.race([browserExited, delay(1_000)]);
      }
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

try {
  await main();
  // La commande est un exécutable de validation autonome. Certaines versions de
  // Chromium conservent des handles CDP internes après leur arrêt; ne les laissez
  // pas transformer un scénario réussi en expiration de la validation.
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}