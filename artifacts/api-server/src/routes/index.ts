import { Router, type IRouter } from "express";
import healthRouter from "./health";
import strengthRouter from "./strength";

const router: IRouter = Router();

router.use(healthRouter);
router.use(strengthRouter);

export default router;
