const express = require("express");
const rateLimit = require("express-rate-limit");
const env = require("../config/env");
const {
  createSession,
  getCurrentSession,
  submitResponse,
  completeSession,
  resetSession,
  purgeResponses
} = require("../controllers/sessionController");
const { getPlaybookStatus, getPlaybook } = require("../controllers/playbookController");
const asyncHandler = require("../middleware/asyncHandler");
const { requireSession } = require("../middleware/sessionAuth");
const { authVerify } = require("../middleware/authVerify");

const router = express.Router();

const sessionCreateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: env.sessionCreateRateLimitPerMin,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: "Too many session create requests", status: 429 } }
});

router.post("/sessions", sessionCreateLimiter, authVerify, asyncHandler(createSession));
router.get("/sessions/current", requireSession, asyncHandler(getCurrentSession));
router.post("/responses", requireSession, asyncHandler(submitResponse));
router.post("/responses/purge", requireSession, asyncHandler(purgeResponses));
router.post("/complete", requireSession, asyncHandler(completeSession));
router.delete("/sessions/current", requireSession, asyncHandler(resetSession));

router.get("/playbooks/:id/status", authVerify, asyncHandler(getPlaybookStatus));
router.get("/playbooks/:id", authVerify, asyncHandler(getPlaybook));

module.exports = router;
