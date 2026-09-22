import { Router } from "express";
import healthRouter from "./health";
import strengthRouter from "./strength";

const router = Router();

router.use(healthRouter);
router.use(strengthRouter);

export default router;
