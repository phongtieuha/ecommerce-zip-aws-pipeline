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

function jsonResponse(statusCode: number, body: Record<string, unknown>): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function isValidDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    return false;
  }

  return date.toISOString().slice(0, 10) === value;
}

function buildShopIdsReportKey(date: string): string {
  return `data-quality/${date}_Shop IDs.json`;
}

async function bodyToString(body: unknown): Promise<string> {
  if (!body) {
    return "";
  }

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

export async function handleGetShopIdsReport(
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

  const key = buildShopIdsReportKey(date);

  try {
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: PROCESSED_BUCKET,
        Key: key,
      }),
    );

    const content = await bodyToString(response.Body);
    if (!content) {
      return jsonResponse(404, {
        error: "Shop IDs report was not found for the requested date.",
        date,
        key,
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return jsonResponse(502, {
        error: "Shop IDs report exists but is not valid JSON.",
        date,
        key,
      });
    }

    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(parsed),
    };
  } catch (error) {
    const err = error as { name?: string };
    if (err.name === "NoSuchKey" || err.name === "NotFound") {
      return jsonResponse(404, {
        error: "Shop IDs report was not found for the requested date.",
        date,
        key,
      });
    }

    console.error("Failed to fetch Shop IDs report", {
      date,
      key,
      error,
    });

    return jsonResponse(500, {
      error: "Failed to fetch Shop IDs report.",
      date,
      key,
    });
  }
}
