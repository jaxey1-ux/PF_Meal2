import { Router } from "express";
import {
  AnalyzeFitnessScreenshotBody,
  AnalyzeFitnessScreenshotResponse,
  GenerateStrengthPlanBody,
  GenerateStrengthPlanResponse,
} from "@workspace/api-zod";

const router = Router();
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5";

type ClaudeTextResponse = {
  content?: Array<{ type?: string; text?: string }>;
  error?: { message?: string };
};

class UpstreamError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");

  if (start < 0 || end < start) {
    throw new Error("Claude did not return JSON");
  }

  return JSON.parse(withoutFence.slice(start, end + 1));
}

async function callClaude(
  body: Record<string, unknown>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<unknown> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new UpstreamError(500, "AI service is not configured");
  }

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = AbortSignal.any([signal, timeoutSignal]);
  let response: Response;

  try {
    response = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8192,
        ...body,
      }),
      signal: combinedSignal,
    });
  } catch (error) {
    if (timeoutSignal.aborted && !signal.aborted) {
      throw new UpstreamError(504, "Anthropic request timed out");
    }
    throw error;
  }

  const payload = (await response.json()) as ClaudeTextResponse;
  if (!response.ok) {
    throw new UpstreamError(
      response.status,
      payload.error?.message ?? "Anthropic request failed",
    );
  }

  const text = payload.content?.find((block) => block.type === "text")?.text;
  if (!text) {
    throw new Error("Claude returned an empty response");
  }

  return extractJson(text);
}

function publicError(status: number): string {
  if (status === 429) {
    return "Too many people are building plans right now. Wait a moment and try again.";
  }
  if (status === 401 || status === 403) {
    return "The plan service needs attention. Please try again later.";
  }
  if (status === 504) {
    return "That took longer than expected. Try the image again or enter your details manually.";
  }
  return "We could not finish that request. Please try again.";
}

router.post(
  "/strength/analyze",
  async (req, res): Promise<void> => {
    const parsed = AnalyzeFitnessScreenshotBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Choose a valid image and try again." });
      return;
    }

    const match = parsed.data.imageData.match(
      /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/,
    );
    if (!match) {
      res.status(400).json({ error: "Use a JPEG, PNG, or WebP image." });
      return;
    }

    const [, mediaType, data] = match;
    if (Buffer.byteLength(data, "base64") > 9 * 1024 * 1024) {
      res.status(400).json({ error: "That image is too large. Choose one under 9 MB." });
      return;
    }

    const controller = new AbortController();
    req.on("aborted", () => controller.abort());
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });

    try {
      const result = (await callClaude(
        {
          max_tokens: 1200,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: mediaType,
                    data,
                  },
                },
                {
                  type: "text",
                  text: `Look closely at this image. It may be a screenshot from any fitness tracker, a gym console, or a photo of a handwritten activity log.

If it is not related to fitness or activity tracking, return exactly:
{"isFitnessImage":false,"reason":"brief plain-language reason"}

If it is fitness-related, extract only metrics that are visibly supported. Do not assume a fixed app or layout. Return only valid JSON in this exact shape:
{
  "isFitnessImage": true,
  "sourceApp": "best guess, or Unknown fitness source",
  "metrics": [
    {"label":"plain label including unit where useful","value":"visible value","confidence":"high or low"}
  ],
  "gaps": ["common useful metric not visible"],
  "bucket": "one short phrase describing the current activity pattern"
}

Use high confidence only when text is read clearly. Use low when interpretation is uncertain. Common gaps can include heart rate, calories, duration, distance, frequency, pace, or resistance, but include only useful gaps. Keep the bucket warm, factual, and free of judgement.`,
                },
              ],
            },
          ],
        },
        controller.signal,
        45_000,
      )) as Record<string, unknown>;

      if (result.isFitnessImage !== true) {
        res.status(400).json({
          error:
            "That does not look like a fitness screenshot or activity log. Try another image or enter your stats manually.",
        });
        return;
      }

      const response = AnalyzeFitnessScreenshotResponse.parse({
        sourceApp: result.sourceApp,
        metrics: result.metrics,
        gaps: result.gaps,
        bucket: result.bucket,
      });
      res.json(response);
    } catch (error) {
      if (controller.signal.aborted) return;
      const status = error instanceof UpstreamError ? error.status : 500;
      req.log.error(
        { err: error, upstreamStatus: status },
        "Fitness screenshot analysis failed",
      );
      res
        .status(status === 429 ? 429 : status === 504 ? 504 : 500)
        .json({ error: publicError(status) });
    }
  },
);

router.post("/strength/plan", async (req, res): Promise<void> => {
  const parsed = GenerateStrengthPlanBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Check your activity details and try again.",
    });
    return;
  }

  const controller = new AbortController();
  req.on("aborted", () => controller.abort());
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  try {
    const result = await callClaude(
      {
        max_tokens: 5000,
        messages: [
          {
            role: "user",
            content: `Recommend one quick, easy recovery meal from the confirmed activity information below.

Confirmed input:
${JSON.stringify(parsed.data)}

Return only valid JSON in this exact shape:
{
  "summary": "one warm sentence introducing the meal",
  "recoveryRecipe": {
    "name": "warm, appetizing recipe name",
    "ingredients": ["3 to 4 short ingredients with practical amounts"],
    "howToMake": "one short, easy sentence",
    "whyItFits": "one short sentence explaining how it helps replace energy and fluids used in the visible distance, duration, or activity type"
  }
}

Requirements:
- Return only the meal recommendation. Do not create or mention a training plan, workout, exercises, or future routine.
- Recommend one concrete, familiar meal that sounds appetizing and takes little effort to make.
- Use 3 or 4 short ingredients only. Do not add a separate principles list, protein target, timing tips, calorie target, or medical claim.
- The whyItFits line must mention the person's actual distance, duration, or activity type where one is available and explain simply what the meal helps replace.
- Keep language plain, direct, warm, and free of nutrition jargon.
- Use sentence case and do not use em dashes.`,
          },
        ],
      },
      controller.signal,
      60_000,
    );

    res.json(GenerateStrengthPlanResponse.parse(result));
  } catch (error) {
    if (controller.signal.aborted) return;
    const status = error instanceof UpstreamError ? error.status : 500;
    req.log.error(
      { err: error, upstreamStatus: status },
      "Strength plan generation failed",
    );
    res
      .status(status === 429 ? 429 : status === 504 ? 504 : 500)
      .json({ error: publicError(status) });
  }
});

export default router;