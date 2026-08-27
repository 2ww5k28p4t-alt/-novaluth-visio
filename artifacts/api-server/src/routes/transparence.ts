import { Router, type IRouter } from "express";
import { publicProviderState } from "../gateway/provider-registry";

const router: IRouter = Router();

router.get("/transparence", (_req, res) => {
  res.json({
    ...publicProviderState(),
    titre: "Prestataires et sources de NovaLuth",
    mise_a_jour: "2026-08-27",
    engagement:
      "Cette page décrit les services déclarés. La présence d’un fournisseur ne constitue ni une recommandation ni une garantie de disponibilité.",
    donnees: [
      "Les briefs de musiciens restent sur le serveur NovaLuth et sont anonymisés avant tout envoi à un tiers.",
      "Les recherches servent à repérer des adresses de pages, pas à republier les contenus des moteurs.",
      "Une page d’atelier est lue uniquement si les règles du site et les réservations de fouille le permettent.",
      "Une fiche candidate doit être relue avant toute publication ; une collecte automatique ne modifie jamais l’annuaire seule.",
    ],
  });
});

export default router;
