type ApiRequest = {
  method?: string;
  body?: unknown;
  on?: (event: string, listener: () => void) => void;
};

type ApiResponse = {
  status: (statusCode: number) => ApiResponse;
  json: (body: unknown) => void;
  setHeader: (name: string, value: string) => void;
};

type ClaudeTextResponse = {
  content?: Array<{ type?: string; text?: string }>;
  error?: { message?: string };
};

type FitnessMetric = {
  label: string;
  value: string;
  confidence: "high" | "low";
};

class UpstreamError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5";

function extractJson(text: string): unknown {
  const withoutFence = text
    .trim()
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
): Promise<unknown> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new UpstreamError(500, "AI service is not configured");
  }

  const response = await fetch(ANTHROPIC_URL, {
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
    signal,
  });

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
    return "That took longer than expected. Try the image again.";
  }
  return "We could not finish that request. Please try again.";
}

function requestBody(req: ApiRequest): Record<string, unknown> | null {
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return null;
    }
  }
  return body && typeof body === "object"
    ? (body as Record<string, unknown>)
    : null;
}

function isMetric(value: unknown): value is FitnessMetric {
  if (!value || typeof value !== "object") return false;
  const metric = value as Record<string, unknown>;
  return (
    typeof metric.label === "string" &&
    typeof metric.value === "string" &&
    (metric.confidence === "high" || metric.confidence === "low")
  );
}

function methodAllowed(req: ApiRequest, res: ApiResponse): boolean {
  if (req.method === "POST") return true;
  res.setHeader("Allow", "POST");
  res.status(405).json({ error: "Method not allowed." });
  return false;
}

function timeoutController(req: ApiRequest, timeoutMs: number): AbortController {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  req.on?.("aborted", () => controller.abort());
  controller.signal.addEventListener("abort", () => clearTimeout(timeout), {
    once: true,
  });
  return controller;
}

export function handleHealth(_req: ApiRequest, res: ApiResponse): void {
  res.status(200).json({ status: "ok" });
}

export async function handleAnalyze(
  req: ApiRequest,
  res: ApiResponse,
): Promise<void> {
  if (!methodAllowed(req, res)) return;

  const body = requestBody(req);
  const imageData = body?.imageData;
  if (typeof imageData !== "string" || imageData.length < 20) {
    res.status(400).json({ error: "Choose a valid image and try again." });
    return;
  }

  const match = imageData.match(
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

  const controller = timeoutController(req, 45_000);

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
    )) as Record<string, unknown>;

    if (result.isFitnessImage !== true) {
      res.status(400).json({
        error:
          "That does not look like a fitness screenshot or activity log. Try another image.",
      });
      return;
    }

    if (
      typeof result.sourceApp !== "string" ||
      !Array.isArray(result.metrics) ||
      !result.metrics.every(isMetric) ||
      !Array.isArray(result.gaps) ||
      !result.gaps.every((gap) => typeof gap === "string") ||
      typeof result.bucket !== "string"
    ) {
      throw new Error("Claude returned an invalid analysis");
    }

    res.status(200).json({
      sourceApp: result.sourceApp,
      metrics: result.metrics,
      gaps: result.gaps,
      bucket: result.bucket,
    });
  } catch (error) {
    const timedOut = controller.signal.aborted;
    const status = timedOut
      ? 504
      : error instanceof UpstreamError
        ? error.status
        : 500;
    console.error("Fitness screenshot analysis failed", error);
    res
      .status(status === 429 ? 429 : status === 504 ? 504 : 500)
      .json({ error: publicError(status) });
  }
}

export async function handlePlan(
  req: ApiRequest,
  res: ApiResponse,
): Promise<void> {
  if (!methodAllowed(req, res)) return;

  const body = requestBody(req);
  const metrics = body?.metrics;
  const gaps = body?.gaps;
  const bucket = body?.bucket;
  const bodyweightKg = body?.bodyweightKg;
  const goal = body?.goal;

  const validBodyweight =
    bodyweightKg == null ||
    (typeof bodyweightKg === "number" &&
      bodyweightKg >= 25 &&
      bodyweightKg <= 350);
  const validGoal =
    goal == null ||
    ["general_fitness", "build_strength", "lose_weight", "not_sure"].includes(
      String(goal),
    );

  if (
    !Array.isArray(metrics) ||
    metrics.length === 0 ||
    !metrics.every(isMetric) ||
    !Array.isArray(gaps) ||
    !gaps.every((gap) => typeof gap === "string") ||
    typeof bucket !== "string" ||
    bucket.length === 0 ||
    !validBodyweight ||
    !validGoal
  ) {
    res.status(400).json({ error: "Check your activity details and try again." });
    return;
  }

  const controller = timeoutController(req, 60_000);

  try {
    const result = (await callClaude(
      {
        max_tokens: 5000,
        messages: [
          {
            role: "user",
            content: `Recommend one quick, easy recovery meal from the confirmed activity information below.

Confirmed input:
${JSON.stringify(body)}

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
    )) as Record<string, unknown>;

    const recipe =
      result.recoveryRecipe && typeof result.recoveryRecipe === "object"
        ? (result.recoveryRecipe as Record<string, unknown>)
        : null;
    if (
      typeof result.summary !== "string" ||
      !recipe ||
      typeof recipe.name !== "string" ||
      !Array.isArray(recipe.ingredients) ||
      recipe.ingredients.length < 3 ||
      recipe.ingredients.length > 4 ||
      !recipe.ingredients.every((item) => typeof item === "string") ||
      typeof recipe.howToMake !== "string" ||
      typeof recipe.whyItFits !== "string"
    ) {
      throw new Error("Claude returned an invalid meal");
    }

    res.status(200).json({
      summary: result.summary,
      recoveryRecipe: {
        name: recipe.name,
        ingredients: recipe.ingredients,
        howToMake: recipe.howToMake,
        whyItFits: recipe.whyItFits,
      },
    });
  } catch (error) {
    const timedOut = controller.signal.aborted;
    const status = timedOut
      ? 504
      : error instanceof UpstreamError
        ? error.status
        : 500;
    console.error("Recovery meal generation failed", error);
    res
      .status(status === 429 ? 429 : status === 504 ? 504 : 500)
      .json({ error: publicError(status) });
  }
}