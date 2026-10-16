import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";

const AWS_REGION = process.env.AWS_REGION ?? "ap-southeast-1";
const s3 = new S3Client({
  region: AWS_REGION,
  endpoint: process.env.AWS_ENDPOINT_URL,
  forcePathStyle: Boolean(process.env.AWS_ENDPOINT_URL),
});
const PROCESSED_BUCKET = process.env.PROCESSED_BUCKET;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const FEATURE1_SECTIONS = ["consolidated", "shop-products", "product-skus"] as const;

type Feature = "feature1";
type Feature1Section = (typeof FEATURE1_SECTIONS)[number];
type ProductIdsByRegion = Record<string, string[]>;
type ProductIdsBySection = Partial<Record<Feature1Section, ProductIdsByRegion>>;

interface ProductIdPlatformFile {
  readonly date?: string;
  readonly generatedAt?: string;
  readonly type?: Feature1Section;
  readonly platform?: string;
  readonly count?: number;
  readonly productIdsByRegion?: Record<string, string[]>;
}

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
  return date.toISOString().slice(0, 10) === value;
}

function isValidFeature(value: string): value is Feature {
  return value === "feature1";
}

function isValidFeature1Section(value: string): value is Feature1Section {
  return FEATURE1_SECTIONS.includes(value as Feature1Section);
}

function parseMultiValueQuery(event: APIGatewayProxyEventV2, keys: string[]): string[] {
  const values: string[] = [];
  const raw = event.rawQueryString ?? "";

  if (raw.trim().length > 0) {
    const searchParams = new URLSearchParams(raw);
    for (const key of keys) {
      for (const value of searchParams.getAll(key)) {
        const normalized = value.trim();
        if (normalized.length > 0) {
          values.push(normalized);
        }
      }
    }
  }

  if (values.length > 0) {
    return values;
  }

  const qp = event.queryStringParameters ?? {};
  for (const key of keys) {
    const value = qp[key];
    if (value && value.trim().length > 0) {
      values.push(value.trim());
    }
  }

  return values;
}

function toProductIdPlatformFileSegment(platform: string): string {
  return platform
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "_");
}

function buildProductIdPayloadKey(
  date: string,
  section: Feature1Section,
  platform: string,
): string {
  return `data-quality/${date}_Product_IDs/${section}/${toProductIdPlatformFileSegment(platform)}.json`;
}

async function bodyToString(body: unknown): Promise<string> {
  if (!body) return "";

  const maybeBody = body as {
    transformToString?: () => Promise<string>;
    [Symbol.asyncIterator]?: () => AsyncIterator<Buffer | Uint8Array | string>;
  };

  if (typeof maybeBody.transformToString === "function") {
    return maybeBody.transformToString();
  }

  if (typeof maybeBody[Symbol.asyncIterator] === "function") {
    const chunks: Buffer[] = [];
    for await (const chunk of maybeBody as AsyncIterable<Buffer | Uint8Array | string>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf-8");
  }

  return "";
}

async function fetchPlatformProductIds(
  date: string,
  section: Feature1Section,
  platform: string,
): Promise<ProductIdsByRegion> {
  if (!PROCESSED_BUCKET) {
    throw new Error("PROCESSED_BUCKET is not configured.");
  }

  const key = buildProductIdPayloadKey(date, section, platform);

  try {
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: PROCESSED_BUCKET,
        Key: key,
      }),
    );

    const content = await bodyToString(response.Body);
    if (!content) {
      return {};
    }

    const parsed = JSON.parse(content) as ProductIdPlatformFile;
    if (!parsed.productIdsByRegion || typeof parsed.productIdsByRegion !== "object") {
      return {};
    }

    const productIdsByRegion: ProductIdsByRegion = {};
    const regions = Object.keys(parsed.productIdsByRegion).sort((left, right) =>
      left.localeCompare(right),
    );

    for (const region of regions) {
      const regionIds = parsed.productIdsByRegion[region];
      if (!Array.isArray(regionIds)) {
        continue;
      }

      productIdsByRegion[region] = regionIds
        .filter((value): value is string => typeof value === "string")
        .sort((left, right) => left.localeCompare(right));
    }

    return productIdsByRegion;
  } catch (error) {
    const err = error as { name?: string };
    if (err.name === "NoSuchKey" || err.name === "NotFound") {
      return {};
    }
    throw error;
  }
}

function mergeProductIdsByRegion(
  target: ProductIdsByRegion,
  incoming: ProductIdsByRegion,
): ProductIdsByRegion {
  for (const region of Object.keys(incoming).sort((left, right) => left.localeCompare(right))) {
    const ids = incoming[region] ?? [];
    if (ids.length === 0) {
      continue;
    }

    const mergedIds = new Set([...(target[region] ?? []), ...ids]);
    target[region] = [...mergedIds].sort((left, right) => left.localeCompare(right));
  }

  return target;
}

export async function handleGetProductIds(
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

  const feature = event.queryStringParameters?.feature?.trim();
  if (!feature || !isValidFeature(feature)) {
    return jsonResponse(400, {
      error: "Invalid or missing feature parameter. Use feature=feature1.",
    });
  }

  const sectionValues = parseMultiValueQuery(event, ["section[]", "section"]);
  if (sectionValues.length === 0) {
    return jsonResponse(400, {
      error: "Missing section[] parameter. Use section[]=consolidated|shop-products|product-skus.",
    });
  }

  const invalidSection = sectionValues.find((value) => !isValidFeature1Section(value));
  if (invalidSection) {
    return jsonResponse(400, {
      error: "Invalid section parameter. Valid options: consolidated, shop-products, product-skus.",
      invalidSection,
    });
  }

  const sections: Feature1Section[] = [...new Set(sectionValues)] as Feature1Section[];

  const platforms = [...new Set(parseMultiValueQuery(event, ["platform[]", "platform"]))];
  if (platforms.length === 0) {
    return jsonResponse(400, {
      error: "Missing platform[] parameter. Example: platform[]=Lazada",
    });
  }

  try {
    const productIdsBySection: ProductIdsBySection = {};

    for (const section of sections) {
      productIdsBySection[section] = {};
    }

    for (const section of sections) {
      for (const platform of platforms) {
        const idsByRegion = await fetchPlatformProductIds(date, section, platform);
        productIdsBySection[section] = mergeProductIdsByRegion(
          productIdsBySection[section] ?? {},
          idsByRegion,
        );
      }
    }

    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(productIdsBySection),
    };
  } catch (error) {
    console.error("Failed to fetch product IDs", {
      date,
      sections,
      platforms,
      error,
    });

    return jsonResponse(500, {
      error: "Failed to fetch product IDs.",
      date,
      sections,
      platforms,
    });
  }
}
