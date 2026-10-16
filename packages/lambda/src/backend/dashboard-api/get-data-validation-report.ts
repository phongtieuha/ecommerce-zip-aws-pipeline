import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";

const s3 = new S3Client({ region: "ap-southeast-1" });
const PROCESSED_BUCKET = process.env.PROCESSED_BUCKET;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function jsonResponse(statusCode: number, body: Record<string, unknown>): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function isValidDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return false;

  const normalized = date.toISOString().slice(0, 10);
  return normalized === value;
}

async function bodyToString(body: unknown): Promise<string> {
  if (!body) return "";

  const maybeBody = body as any;
  if (typeof maybeBody.transformToString === "function") {
    return maybeBody.transformToString();
  }

  const chunks: Buffer[] = [];
  for await (const chunk of maybeBody as NodeJS.ReadableStream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf-8");
}

function buildReportKey(date: string): string {
  return `data-quality/${date}_Data Validation Report.json`;
}

type Feature = "feature1" | "feature2";
type Feature1Section = "consolidated" | "shop-products" | "product-skus";
type Feature2Section = "keyword-products";
type Section = Feature1Section | Feature2Section;

function isValidFeature(value: string): value is Feature {
  return value === "feature1" || value === "feature2";
}

function isValidFeature1Section(value: string): value is Feature1Section {
  return value === "consolidated" || value === "shop-products" || value === "product-skus";
}

function isValidFeature2Section(value: string): value is Feature2Section {
  return value === "keyword-products";
}

function isValidSection(value: string, feature: Feature): value is Section {
  if (feature === "feature1") {
    return isValidFeature1Section(value);
  }
  return isValidFeature2Section(value);
}

function filterDataValidationReport(
  data: Record<string, unknown>,
  feature?: Feature,
  section?: Section,
): Record<string, unknown> {
  if (!feature) {
    return data;
  }

  if (feature === "feature1") {
    const feature1Data = data.feature1 as Record<string, unknown> | undefined;
    if (!feature1Data) {
      return { feature1: {} };
    }

    if (!section) {
      return { feature1: feature1Data };
    }

    if (isValidFeature1Section(section)) {
      return {
        feature1: {
          [section]: feature1Data[section] || [],
        },
      };
    }

    return { feature1: feature1Data };
  }

  if (feature === "feature2") {
    const feature2Data = data.feature2 as unknown[] | undefined;
    return {
      feature2: feature2Data || [],
    };
  }

  return data;
}

export async function handleGetDataValidationReport(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  if (!PROCESSED_BUCKET) {
    return jsonResponse(500, { error: "PROCESSED_BUCKET is not configured." });
  }

  const date = event.queryStringParameters?.date?.trim();
  if (!date || !isValidDate(date)) {
    return jsonResponse(400, {
      error: "Invalid or missing date parameter. Use date=YYYY-MM-DD.",
    });
  }

  const featureParam = event.queryStringParameters?.feature?.trim();
  const sectionParam = event.queryStringParameters?.section?.trim();

  let validatedFeature: Feature | undefined;
  if (featureParam) {
    if (!isValidFeature(featureParam)) {
      return jsonResponse(400, {
        error: "Invalid feature parameter. Use feature=feature1 or feature=feature2.",
      });
    }
    validatedFeature = featureParam;
  }

  if (sectionParam) {
    if (!validatedFeature) {
      return jsonResponse(400, {
        error: "section parameter requires feature parameter.",
      });
    }
    if (!isValidSection(sectionParam, validatedFeature)) {
      const validSections =
        validatedFeature === "feature1"
          ? "consolidated, shop-products, product-skus"
          : "keyword-products";
      return jsonResponse(400, {
        error: `Invalid section parameter for ${validatedFeature}. Valid options: ${validSections}`,
      });
    }
  }

  const key = buildReportKey(date);

  try {
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: PROCESSED_BUCKET,
        Key: key,
      }),
    );

    const rawBody = await bodyToString(response.Body);
    if (!rawBody) {
      return jsonResponse(404, {
        error: "Data validation report was not found for the requested date.",
        date,
        key,
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return jsonResponse(502, {
        error: "Data validation report exists but is not valid JSON.",
        date,
        key,
      });
    }

    const filtered = filterDataValidationReport(
      parsed as Record<string, unknown>,
      validatedFeature,
      sectionParam as Section | undefined,
    );

    const updatedAt = response.LastModified ? response.LastModified.toISOString() : null;

    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...filtered,
        updatedAt,
      }),
    };
  } catch (error) {
    const err = error as { name?: string };
    if (err.name === "NoSuchKey" || err.name === "NotFound") {
      return jsonResponse(404, {
        error: "Data validation report was not found for the requested date.",
        date,
        key,
      });
    }

    console.error("Failed to fetch data validation report", {
      date,
      key,
      error,
    });

    return jsonResponse(500, {
      error: "Failed to fetch data validation report.",
      date,
      key,
    });
  }
}
