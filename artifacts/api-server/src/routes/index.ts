import { Router, type IRouter } from "express";
import healthRouter from "./health";
import novaluthRouter from "./novaluth";
import gatewayRouter from "../gateway/router";
import transparenceRouter from "./transparence";
import p2pMeetRouter from "./p2p-meet";

const router: IRouter = Router();

router.use(healthRouter);
router.use(gatewayRouter);
router.use(transparenceRouter);
router.use(p2pMeetRouter);
router.use(novaluthRouter);

export default router;
