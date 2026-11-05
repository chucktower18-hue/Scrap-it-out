const SITE_ORIGIN = "https://resonant-duckanoo-6ed9d.netlify.app";
const MAX_IMAGE_CHARS = 5_500_000;
const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 5;
const requestBuckets = new Map();

const responseHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": SITE_ORIGIN,
  "Vary": "Origin",
};

function json(statusCode, payload) {
  return new Response(JSON.stringify(payload), {
    status: statusCode,
    headers: responseHeaders
  });
}

export default async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...responseHeaders,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      }
    });
  }

  if (request.method !== "POST") {
    return json(405, { error: "Use POST for image analysis." });
  }

  const origin = request.headers.get("origin");

  if (origin && origin !== SITE_ORIGIN) {
    return json(403, {
      error: "This endpoint only accepts requests from the Scrap It Out website."
    });
  }

  const ip = request.headers.get("x-nf-client-connection-ip") || "unknown";
  const now = Date.now();
  const bucket = requestBuckets.get(ip) || { start: now, count: 0 };

  if (now - bucket.start > WINDOW_MS) {
    bucket.start = now;
    bucket.count = 0;
  }

  bucket.count += 1;
  requestBuckets.set(ip, bucket);

  if (bucket.count > MAX_REQUESTS_PER_WINDOW) {
    return json(429, {
      error: "Testing limit reached. Please wait 10 minutes before scanning again."
    });
  }

  if (!process.env.OPENAI_API_KEY) {
    return json(503, {
      error: "AI service is not configured yet. Add OPENAI_API_KEY in Netlify environment variables."
    });
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return json(400, { error: "Request body must be valid JSON." });
  }

  const imageDataUrl = body?.imageDataUrl;

  if (
    typeof imageDataUrl !== "string" ||
    !/^data:image\/(jpeg|jpg|png|webp);base64,/.test(imageDataUrl)
  ) {
    return json(400, {
      error: "Please send a JPEG, PNG, or WebP image."
    });
  }

  if (imageDataUrl.length > MAX_IMAGE_CHARS) {
    return json(413, {
      error: "Image is too large. Please take a closer, smaller photo."
    });
  }

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      metal: { type: "string" },
      grade: { type: "string" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      checks: { type: "array", items: { type: "string" } },
      prep: { type: "array", items: { type: "string" } },
      hazards: { type: "array", items: { type: "string" } }
    },
    required: ["metal", "grade", "confidence", "checks", "prep", "hazards"]
  };

  const prompt = `You are the visual scrap-metal assistant for Scrap It Out, a cautious Ontario scrap-sorting guide. Inspect the image and return a practical estimate, not a laboratory identification. Identify the most likely visible material and likely scrap category/grade only when supported by visible evidence. Never claim a precise alloy or certified grade from appearance alone. If uncertain, say so in metal/grade and lower confidence. Mention what markings, magnet test (only when safe), or yard testing could verify it. Provide 2-4 concise verification checks and 2-4 safe preparation tips. Include hazards whenever the object could contain stored energy, electricity, refrigerant, oil, chemicals, batteries, pressure, sharp edges, or unknown contents. Never tell the user to burn insulation, cut live wiring, open sealed/pressurized items, or dismantle hazardous equipment. If the image is not clearly scrap metal, say that. Confidence is a cautious estimate from 0 to 1, not a probability guarantee.`;

  try {
    const upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
        store: false,
        max_output_tokens: 450,
        input: [{
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: imageDataUrl, detail: "low" }
          ]
        }],
        text: {
          format: {
            type: "json_schema",
            name: "scrap_analysis",
            strict: true,
            schema
          }
        }
      })
    });

    const result = await upstream.json();

    if (!upstream.ok) {
      const message = result?.error?.message ||
        `AI provider returned HTTP ${upstream.status}`;

      return json(502, { error: message });
    }

    const outputText = result.output
      ?.flatMap(item => item.content || [])
      .find(part => part.type === "output_text")?.text;

    if (!outputText) {
      return json(502, {
        error: "The AI returned no usable analysis. Please try another photo."
      });
    }

    let analysis;

    try {
      analysis = JSON.parse(outputText);
    } catch {
      return json(502, {
        error: "The AI response could not be read. Please try again."
      });
    }

    return json(200, analysis);

  } catch (error) {
    return json(500, {
      error: "The analysis service had a temporary problem. Please try again."
    });
  }
};
