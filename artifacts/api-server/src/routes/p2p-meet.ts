import { Router, type IRouter, type Request } from "express";
import crypto from "node:crypto";
import {
  CreateMeetAccountBody,
  CreateMeetAccountResponse,
  GetMeetAuthSessionResponse,
  GetMeetConfigResponse,
  GetMeetIceConfigResponse,
  ListMeetAccountsResponse,
  LoginMeetAccountBody,
  LoginMeetAccountResponse,
  ResetMeetAccountPasswordParams,
  ResetMeetAccountPasswordResponse,
  UpdateMeetAccountBody,
  UpdateMeetAccountParams,
  UpdateMeetAccountResponse,
} from "@workspace/api-zod";
import { db, novaluthPlatformAccountsTable } from "@workspace/db";
import { buildP2PIceServers } from "../lib/p2p-meet";
import {
  accountForSession,
  accountToPublic,
  cookieIsSecure,
  createMeetAccount,
  createMeetSession,
  deleteMeetSession,
  expiredSessionCookie,
  isMeetAuthRequired,
  loginMeetAccount,
  resetMeetAccountPassword,
  sessionCookie,
  sessionTokenFromCookie,
  setMeetAccountActive,
  validateMeetAccountInput,
} from "../lib/p2p-meet-auth";

const router: IRouter = Router();

router.get("/meet/config", (_req, res): void => {
  res.set({
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  res.json(GetMeetConfigResponse.parse({
    maxPeers: Math.max(2, Number(process.env.MAX_PEERS_PER_ROOM ?? 8)),
    accessCodeRequired: Boolean(process.env.ACCESS_CODE),
    forceRelay: String(process.env.FORCE_RELAY ?? "false") === "true",
    authRequired: isMeetAuthRequired(),
  }));
});

router.get("/meet/auth/session", async (req, res, next) => {
  try {
    const account = await accountForSession(
      sessionTokenFromCookie(req.header("cookie")),
    );
    res.set("Cache-Control", "no-store");
    res.json(
      GetMeetAuthSessionResponse.parse({
        authenticated: Boolean(account),
        account: account ? accountToPublic(account) : null,
      }),
    );
  } catch (error) {
    next(error);
  }
});

router.post("/meet/auth/login", async (req, res, next) => {
  try {
    const input = LoginMeetAccountBody.parse(req.body);
    const result = await loginMeetAccount(input.login, input.password);
    if (!result.ok) {
      res.status(401).json({ error: result.error });
      return;
    }
    const { token } = await createMeetSession(result.account.id);
    res
      .set("Set-Cookie", sessionCookie(token, cookieIsSecure(req)))
      .json(
        LoginMeetAccountResponse.parse({
          authenticated: true,
          account: accountToPublic(result.account),
        }),
      );
  } catch (error) {
    next(error);
  }
});

router.post("/meet/auth/logout", async (req, res, next) => {
  try {
    await deleteMeetSession(sessionTokenFromCookie(req.header("cookie")));
    res.set("Set-Cookie", expiredSessionCookie(cookieIsSecure(req))).status(204).send();
  } catch (error) {
    next(error);
  }
});

router.get("/meet/ice", async (req, res, next) => {
  try {
    if (
      isMeetAuthRequired()
      && !(await accountForSession(sessionTokenFromCookie(req.header("cookie"))))
    ) {
      res.status(401).json({ error: "Une session NovaLuth est requise pour Meet." });
      return;
    }
  const iceServers = buildP2PIceServers(crypto.randomUUID());
  const forceRelay = String(process.env.FORCE_RELAY ?? "false") === "true";
  res.set({
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  res.json(GetMeetIceConfigResponse.parse({
    iceServers,
    iceTransportPolicy: forceRelay ? "relay" : "all",
    iceCandidatePoolSize: 2,
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require",
    warning:
      iceServers.length === 0
        ? "Aucun serveur STUN/TURN configuré : les appels ne fonctionneront qu'en réseau local."
        : null,
  }));
  } catch (error) {
    next(error);
  }
});

function hasLegacyAdminToken(token: string | undefined) {
  const expected = process.env.NOVALUTH_ADMIN_TOKEN
    ?? (process.env.NODE_ENV === "production" ? "" : "demo-admin");
  return Boolean(token) && token === expected;
}

async function requireMeetAdmin(req: Request) {
  if (hasLegacyAdminToken(req.header("X-Admin-Token") ?? undefined)) return true;
  const account = await accountForSession(
    sessionTokenFromCookie(req.header("cookie")),
  );
  return account?.role === "admin";
}

router.get("/admin/meet/accounts", async (req, res, next) => {
  try {
    if (!(await requireMeetAdmin(req))) {
      res.status(401).json({ error: "Accès administrateur requis." });
      return;
    }
    const accounts = await db
      .select()
      .from(novaluthPlatformAccountsTable)
      .orderBy(novaluthPlatformAccountsTable.login);
    res.set("Cache-Control", "no-store");
    res.json(ListMeetAccountsResponse.parse({
      accounts: accounts.map(accountToPublic),
    }));
  } catch (error) {
    next(error);
  }
});

router.post("/admin/meet/accounts", async (req, res, next) => {
  try {
    if (!(await requireMeetAdmin(req))) {
      res.status(401).json({ error: "Accès administrateur requis." });
      return;
    }
    const input = CreateMeetAccountBody.parse(req.body);
    const validationError = validateMeetAccountInput(input);
    if (validationError) {
      res.status(400).json({ error: validationError });
      return;
    }
    try {
      const created = await createMeetAccount(input);
      res.status(201).json(CreateMeetAccountResponse.parse({
        account: accountToPublic(created.account),
        temporaryPassword: created.temporaryPassword,
      }));
    } catch (error) {
      if (String(error).includes("novaluth_platform_accounts_login_unique")) {
        res.status(409).json({ error: "Cet identifiant existe déjà." });
        return;
      }
      throw error;
    }
  } catch (error) {
    next(error);
  }
});

router.patch("/admin/meet/accounts/:accountId", async (req, res, next) => {
  try {
    if (!(await requireMeetAdmin(req))) {
      res.status(401).json({ error: "Accès administrateur requis." });
      return;
    }
    const { accountId } = UpdateMeetAccountParams.parse(req.params);
    const { active } = UpdateMeetAccountBody.parse(req.body);
    const account = await setMeetAccountActive(accountId, active);
    if (!account) {
      res.status(404).json({ error: "Compte Meet introuvable." });
      return;
    }
    res.json(UpdateMeetAccountResponse.parse(accountToPublic(account)));
  } catch (error) {
    next(error);
  }
});

router.post("/admin/meet/accounts/:accountId/reset-password", async (req, res, next) => {
  try {
    if (!(await requireMeetAdmin(req))) {
      res.status(401).json({ error: "Accès administrateur requis." });
      return;
    }
    const { accountId } = ResetMeetAccountPasswordParams.parse(req.params);
    const reset = await resetMeetAccountPassword(accountId);
    if (!reset) {
      res.status(404).json({ error: "Compte Meet introuvable." });
      return;
    }
    res.json(ResetMeetAccountPasswordResponse.parse({
      account: accountToPublic(reset.account),
      temporaryPassword: reset.temporaryPassword,
    }));
  } catch (error) {
    next(error);
  }
});

export default router;