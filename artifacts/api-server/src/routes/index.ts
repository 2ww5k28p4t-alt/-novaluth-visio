import { Router, type IRouter } from "express";
import healthRouter from "./health";
import novaluthRouter from "./novaluth";

const router: IRouter = Router();

router.use(healthRouter);
router.use(novaluthRouter);

export default router;
