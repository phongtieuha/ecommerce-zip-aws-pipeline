import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
  DeleteObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { extractDateFromFilename } from "@filepipeline/shared/utility/date-extraction";

const ARCHIVE_PREFIX = "archive/";

function normalizeVendorName(vendor: string): string {
  const trimmed = vendor.trim();
  if (!trimmed) return trimmed;
  // Override map for vendors whose folder names don't follow simple title-case
  const overrides: Record<string, string> = { jd: "JD" };
  const lower = trimmed.toLowerCase();
  if (overrides[lower]) return overrides[lower];
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

// Validate required environment variables
const AWS_REGION = process.env.AWS_REGION;
if (!AWS_REGION) throw new Error("AWS_REGION environment variable is required");

const client = new S3Client({
  region: AWS_REGION,
  endpoint: process.env.AWS_ENDPOINT_URL,
  forcePathStyle: true, // Required for LocalStack
});

export async function getObject(bucket: string, key: string): Promise<Buffer> {
  const response = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
  );

  if (!response.Body) {
    throw new Error(`No body in S3 response for ${bucket}/${key}`);
  }

  // Convert stream to buffer
  const stream = response.Body as Readable;
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

export async function getObjectStream(bucket: string, key: string): Promise<Readable> {
  const response = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
  );

  if (!response.Body) {
    throw new Error(`No body in S3 response for ${bucket}/${key}`);
  }

  return response.Body as Readable;
}

export async function putObject(
  bucket: string,
  key: string,
  body: string | Buffer,
  contentType: string = "application/json",
): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

export function parseS3Key(key: string): {
  country: string;
  vendor: string;
  date: string;
  filename: string;
  requestType?: string;
} {
  // Supported formats:
  // - vendor/yyyy/MM/dd/filename.zip
  // - country/vendor/yyyy/MM/dd/filename.zip
  // - archive/country/vendor/yyyy/MM/dd/filename.zip
  let normalizedKey = key;
  if (normalizedKey.startsWith(ARCHIVE_PREFIX)) {
    normalizedKey = normalizedKey.slice(ARCHIVE_PREFIX.length);
  }

  // New format:
  // file_type=json/channel={vendor}/request_type={type}/filename.zip
  // Region may be inferred from paths inside ZIP entries rather than S3 key.
  const decodedKey = decodeURIComponent(normalizedKey);
  if (decodedKey.includes("channel=") && decodedKey.includes("request_type=")) {
    const parts = decodedKey.split("/");
    const channelPart = parts.find((p) => p.startsWith("channel="));
    const requestTypePart = parts.find((p) => p.startsWith("request_type="));
    const filename = parts[parts.length - 1] || "";

    const vendor = normalizeVendorName((channelPart?.split("=")[1] || "").trim());
    const requestType = (requestTypePart?.split("=")[1] || "").trim();

    const date = extractDateFromFilename(filename) || new Date().toISOString().slice(0, 10);

    return {
      country: "",
      vendor,
      date,
      filename,
      requestType,
    };
  }

  const parts = normalizedKey.split("/");
  if (parts.length < 5) {
    throw new Error(`Invalid S3 key format: ${key}`);
  }

  if (parts.length >= 6) {
    const country = parts[0];
    const vendor = parts[1];
    const date = `${parts[2]}-${parts[3]}-${parts[4]}`;
    const filename = parts.slice(5).join("/");
    return { country, vendor, date, filename };
  }

  const vendor = parts[0];
  const date = `${parts[1]}-${parts[2]}-${parts[3]}`;
  const filename = parts.slice(4).join("/");

  return { country: "", vendor, date, filename };
}

function buildPrefix(
  country: string | undefined,
  vendor: string,
  year: string,
  month: string,
  day: string,
): string {
  const segments = [country, vendor, year, month, day].filter(Boolean) as string[];
  return segments.join("/");
}

export function buildOutputKey(
  vendor: string,
  date: string,
  filename: string,
  country: string = "",
): string {
  const [year, month, day] = date.split("-");
  const baseName = filename.replace(/\.(zip|json)$/i, "");
  return `output/${buildPrefix(country, vendor, year, month, day)}/${baseName}.csv`;
}

export function buildErrorReportKey(
  vendor: string,
  date: string,
  filename: string,
  country: string = "",
  sourceS3Key?: string,
): string {
  const normalizedSourceKey = sourceS3Key?.startsWith(ARCHIVE_PREFIX)
    ? sourceS3Key.slice(ARCHIVE_PREFIX.length)
    : sourceS3Key;

  // New key-value incoming format:
  // file_type=json/channel=lazada/request_type=product-skus/<file>.zip
  // Desired output:
  // output/file_type=json/channel=lazada/request_type=product-skus/<file>.errors.json
  if (
    normalizedSourceKey &&
    normalizedSourceKey.includes("file_type=") &&
    normalizedSourceKey.includes("channel=") &&
    normalizedSourceKey.includes("request_type=")
  ) {
    const lastSlash = normalizedSourceKey.lastIndexOf("/");
    const dir = (lastSlash >= 0 ? normalizedSourceKey.slice(0, lastSlash) : "").replace(
      /^\/+|\/+$/g,
      "",
    );
    const leaf = lastSlash >= 0 ? normalizedSourceKey.slice(lastSlash + 1) : normalizedSourceKey;
    const name = leaf.replace(/\.[^.]+$/, "");
    return dir ? `output/${dir}/${name}.errors.json` : `output/${name}.errors.json`;
  }

  // Old format: country/vendor/yyyy/MM/dd/<file>.zip
  const [year, month, day] = date.split("-");
  const baseName = filename.replace(/\.(zip|json)$/i, "");
  return `output/${buildPrefix(country, vendor, year, month, day)}/${baseName}.errors.json`;
}

export function buildConsolidatedOutputKey(
  vendor: string,
  date: string,
  country: string = "",
  sourceFilename?: string,
  runId?: string,
  sourceS3Key?: string,
): string {
  const normalizedSourceKey = sourceS3Key?.startsWith(ARCHIVE_PREFIX)
    ? sourceS3Key.slice(ARCHIVE_PREFIX.length)
    : sourceS3Key;

  // New key-value incoming format:
  // file_type=json/channel=lazada/request_type=product-skus/<file>.zip
  // Desired output:
  // output/file_type=json/channel=lazada/request_type=product-skus/<file>_processed_<runId>.csv
  if (
    normalizedSourceKey &&
    normalizedSourceKey.includes("file_type=") &&
    normalizedSourceKey.includes("channel=") &&
    normalizedSourceKey.includes("request_type=")
  ) {
    const lastSlash = normalizedSourceKey.lastIndexOf("/");
    const dir = (lastSlash >= 0 ? normalizedSourceKey.slice(0, lastSlash) : "").replace(
      /^\/+|\/+$/g,
      "",
    );
    const leaf = lastSlash >= 0 ? normalizedSourceKey.slice(lastSlash + 1) : normalizedSourceKey;
    const name = leaf.replace(/\.[^.]+$/, "");
    return dir ? `output/${dir}/${name}_processed.csv` : `output/${name}_processed.csv`;
  }

  const [year, month, day] = date.split("-");
  const leaf = sourceFilename ? sourceFilename.split("/").pop() || sourceFilename : vendor;
  const name = leaf.replace(/\.[^.]+$/, "");
  return `output/${buildPrefix(country, vendor, year, month, day)}/${name}_processed.csv`;
}

export async function countPendingFilesInIncomingBucket(
  bucket: string,
  vendor: string,
  date: string,
  country: string = "",
): Promise<number> {
  // Count JSON files in the incoming bucket for this vendor/date
  const [year, month, day] = date.split("-");
  const prefix = country
    ? `${country}/${vendor}/${year}/${month}/${day}/`
    : `${vendor}/${year}/${month}/${day}/`;

  const response = await client.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
    }),
  );

  // Count only JSON files
  const jsonFiles = (response.Contents || []).filter((obj) => obj.Key?.endsWith(".json")).length;

  return jsonFiles;
}

export function isArchivedIncomingKey(key: string): boolean {
  return key.startsWith(ARCHIVE_PREFIX);
}

export function buildArchiveKeyFromIncomingKey(key: string, runId: string): string {
  if (key.startsWith(ARCHIVE_PREFIX)) {
    return key;
  }
  const lastSlash = key.lastIndexOf("/");
  const dir = lastSlash >= 0 ? key.slice(0, lastSlash + 1) : "";
  const filename = lastSlash >= 0 ? key.slice(lastSlash + 1) : key;
  return `${ARCHIVE_PREFIX}${dir}${filename}`;
}

export async function moveObject(
  bucket: string,
  sourceKey: string,
  destinationKey: string,
): Promise<void> {
  const encodedSourceKey = encodeURIComponent(sourceKey).replace(/%2F/g, "/");
  await client.send(
    new CopyObjectCommand({
      Bucket: bucket,
      CopySource: `${bucket}/${encodedSourceKey}`,
      Key: destinationKey,
    }),
  );

  await client.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: sourceKey,
    }),
  );
}

/**
 * S3 multipart upload writer for streaming large files.
 * Buffers data internally and flushes parts when the buffer exceeds the
 * minimum multipart part size (5 MB). Call `finish()` to upload remaining
 * data and complete the multipart upload.
 *
 * If the total data is small enough (≤ MIN_PART_SIZE), falls back to a
 * single PutObject to avoid multipart overhead.
 */
export class S3MultipartWriter {
  private bucket: string;
  private key: string;
  private contentType: string;
  private uploadId: string | undefined;
  private parts: Array<{ ETag: string; PartNumber: number }> = [];
  private buffer: string = "";
  private partNumber = 1;
  private finished = false;

  // S3 minimum part size is 5 MB (except the last part)
  private static readonly MIN_PART_SIZE = 5 * 1024 * 1024;

  constructor(bucket: string, key: string, contentType = "text/csv") {
    this.bucket = bucket;
    this.key = key;
    this.contentType = contentType;
  }

  /** Append data to the internal buffer, flushing a part if large enough. */
  async write(data: string): Promise<void> {
    if (this.finished) throw new Error("Cannot write after finish()");
    this.buffer += data;

    if (Buffer.byteLength(this.buffer, "utf-8") >= S3MultipartWriter.MIN_PART_SIZE) {
      await this.flushPart();
    }
  }

  /** Flush remaining data and complete the upload. */
  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;

    // If we never started a multipart upload, use single PutObject
    if (!this.uploadId) {
      await putObject(this.bucket, this.key, this.buffer, this.contentType);
      return;
    }

    // Flush any remaining buffer as the final part
    if (this.buffer.length > 0) {
      await this.flushPart();
    }

    await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: this.key,
        UploadId: this.uploadId,
        MultipartUpload: { Parts: this.parts },
      }),
    );
  }

  /** Abort the multipart upload (for error cleanup). */
  async abort(): Promise<void> {
    if (this.uploadId && !this.finished) {
      this.finished = true;
      await client.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: this.key,
          UploadId: this.uploadId,
        }),
      );
    }
  }

  private async flushPart(): Promise<void> {
    if (!this.uploadId) {
      const resp = await client.send(
        new CreateMultipartUploadCommand({
          Bucket: this.bucket,
          Key: this.key,
          ContentType: this.contentType,
        }),
      );
      this.uploadId = resp.UploadId;
    }

    const body = Buffer.from(this.buffer, "utf-8");
    this.buffer = "";

    const resp = await client.send(
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: this.key,
        UploadId: this.uploadId,
        PartNumber: this.partNumber,
        Body: body,
      }),
    );

    this.parts.push({ ETag: resp.ETag!, PartNumber: this.partNumber });
    this.partNumber++;
  }
}
