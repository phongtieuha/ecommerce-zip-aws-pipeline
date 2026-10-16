import { readdir, readFile } from "node:fs/promises";
import { extname, join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DeleteBucketPolicyCommand,
  DeleteBucketWebsiteCommand,
  DeleteObjectsCommand,
  GetBucketPolicyCommand,
  ListObjectsV2Command,
  PutBucketPolicyCommand,
  PutBucketWebsiteCommand,
  PutObjectCommand,
  PutPublicAccessBlockCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const DIST_DIR = fileURLToPath(new URL("../dist", import.meta.url));
const bucketName = process.env.FRONTEND_BUCKET_NAME;
const bucketPrefix = normalizePrefix(process.env.FRONTEND_BUCKET_PREFIX ?? "");
const region = process.env.AWS_REGION ?? "ap-southeast-1";
const deleteStale = process.env.FRONTEND_DELETE_STALE === "true";
const enableWebsite = process.env.FRONTEND_ENABLE_WEBSITE === "true";

if (!bucketName) {
  throw new Error("FRONTEND_BUCKET_NAME is required");
}

const client = new S3Client({ region });
const filePaths = (await listFiles(DIST_DIR)).sort();

if (filePaths.length === 0) {
  throw new Error(`No build output found in ${DIST_DIR}. Run bun run build first.`);
}

const deployedKeys = new Set<string>();

for (const filePath of filePaths) {
  const body = await readFile(filePath);
  const relativePath = relative(DIST_DIR, filePath).split("\\").join(posix.sep);
  const objectKey = `${bucketPrefix}${relativePath}`;
  const cacheControl = getCacheControl(relativePath);
  const contentType = getContentType(filePath);

  await client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: objectKey,
      Body: body,
      CacheControl: cacheControl,
      ContentType: contentType,
    }),
  );

  deployedKeys.add(objectKey);
  console.log(`Uploaded s3://${bucketName}/${objectKey}`);
}

function getContentType(filePath: string) {
  switch (extname(filePath).toLowerCase()) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".map":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

if (deleteStale) {
  await removeStaleObjects({ bucketName, bucketPrefix, deployedKeys, client });
}

if (enableWebsite) {
  await configureStaticWebsite({ bucketName, bucketPrefix, region, client });
} else {
  await disablePublicWebsiteAccess({ bucketName, client });
}

console.log(
  `Deployment complete: ${filePaths.length} file(s) uploaded to s3://${bucketName}/${bucketPrefix}`,
);

if (enableWebsite) {
  const websiteUrl = `http://${bucketName}.s3-website-${region}.amazonaws.com/${bucketPrefix}`;
  console.log(`Website URL: ${websiteUrl}`);
}

function normalizePrefix(prefix: string) {
  if (!prefix) {
    return "";
  }

  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}

function getCacheControl(relativePath: string) {
  if (relativePath === "index.html") {
    return "no-cache, no-store, must-revalidate";
  }

  if (relativePath.startsWith("assets/")) {
    return "public, max-age=31536000, immutable";
  }

  return "public, max-age=300";
}

async function removeStaleObjects({
  bucketName,
  bucketPrefix,
  deployedKeys,
  client,
}: {
  bucketName: string;
  bucketPrefix: string;
  deployedKeys: Set<string>;
  client: S3Client;
}) {
  let continuationToken: string | undefined;

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: bucketPrefix,
        ContinuationToken: continuationToken,
      }),
    );

    continuationToken = response.NextContinuationToken;

    const keysToDelete = (response.Contents ?? [])
      .flatMap((item) => (item.Key ? [item.Key] : []))
      .filter((key) => !deployedKeys.has(key));

    if (keysToDelete.length === 0) {
      continue;
    }

    await client.send(
      new DeleteObjectsCommand({
        Bucket: bucketName,
        Delete: {
          Objects: keysToDelete.map((key) => ({ Key: key })),
          Quiet: false,
        },
      }),
    );

    for (const key of keysToDelete) {
      console.log(`Deleted stale s3://${bucketName}/${key}`);
    }
  } while (continuationToken);
}

async function configureStaticWebsite({
  bucketName,
  bucketPrefix,
  region,
  client,
}: {
  bucketName: string;
  bucketPrefix: string;
  region: string;
  client: S3Client;
}) {
  await client.send(
    new PutPublicAccessBlockCommand({
      Bucket: bucketName,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: false,
        IgnorePublicAcls: false,
        BlockPublicPolicy: false,
        RestrictPublicBuckets: false,
      },
    }),
  );

  const indexKey = "index.html";
  const errorKey = bucketPrefix ? `${bucketPrefix}index.html` : "index.html";

  await client.send(
    new PutBucketWebsiteCommand({
      Bucket: bucketName,
      WebsiteConfiguration: {
        IndexDocument: { Suffix: indexKey },
        ErrorDocument: { Key: errorKey },
      },
    }),
  );

  const policyDocument = await getOrCreateBucketPolicy({ bucketName, bucketPrefix, client });

  await client.send(
    new PutBucketPolicyCommand({
      Bucket: bucketName,
      Policy: JSON.stringify(policyDocument),
    }),
  );

  const websiteUrl = `http://${bucketName}.s3-website-${region}.amazonaws.com/${bucketPrefix}`;
  console.log(`Configured static website hosting for ${websiteUrl}`);
}

async function disablePublicWebsiteAccess({
  bucketName,
  client,
}: {
  bucketName: string;
  client: S3Client;
}) {
  await client.send(
    new PutPublicAccessBlockCommand({
      Bucket: bucketName,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
    }),
  );

  const existingPolicy = await getBucketPolicyOrNull({ bucketName, client });

  if (existingPolicy) {
    const statements = Array.isArray(existingPolicy.Statement) ? existingPolicy.Statement : [];
    const filteredStatements = statements.filter(
      (statement) =>
        statement.Sid !== "FilePipelineDashboardPublicRead" &&
        statement.Sid !== "CubeDashboardPublicRead",
    );

    if (filteredStatements.length !== statements.length) {
      if (filteredStatements.length === 0) {
        await client.send(new DeleteBucketPolicyCommand({ Bucket: bucketName }));
      } else {
        await client.send(
          new PutBucketPolicyCommand({
            Bucket: bucketName,
            Policy: JSON.stringify({
              Version: existingPolicy.Version ?? "2012-10-17",
              Statement: filteredStatements,
            }),
          }),
        );
      }
    }
  }

  try {
    await client.send(new DeleteBucketWebsiteCommand({ Bucket: bucketName }));
  } catch (error) {
    const maybeNoWebsite = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (
      maybeNoWebsite.name !== "NoSuchWebsiteConfiguration" &&
      maybeNoWebsite.$metadata?.httpStatusCode !== 404
    ) {
      throw error;
    }
  }

  console.log(`Disabled public static website access for s3://${bucketName}`);
}

async function getBucketPolicyOrNull({
  bucketName,
  client,
}: {
  bucketName: string;
  client: S3Client;
}): Promise<{ Version?: string; Statement?: Array<Record<string, unknown>> } | null> {
  try {
    const existingPolicy = await client.send(new GetBucketPolicyCommand({ Bucket: bucketName }));
    if (!existingPolicy.Policy) {
      return null;
    }

    return JSON.parse(existingPolicy.Policy) as {
      Version?: string;
      Statement?: Array<Record<string, unknown>>;
    };
  } catch (error) {
    const maybeNoPolicy = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (
      maybeNoPolicy.name === "NoSuchBucketPolicy" ||
      maybeNoPolicy.$metadata?.httpStatusCode === 404
    ) {
      return null;
    }

    throw error;
  }
}

async function getOrCreateBucketPolicy({
  bucketName,
  bucketPrefix,
  client,
}: {
  bucketName: string;
  bucketPrefix: string;
  client: S3Client;
}) {
  const publicReadResource = bucketPrefix
    ? `arn:aws:s3:::${bucketName}/${bucketPrefix}*`
    : `arn:aws:s3:::${bucketName}/*`;

  const publicReadStatement = {
    Sid: "FilePipelineDashboardPublicRead",
    Effect: "Allow",
    Principal: "*",
    Action: "s3:GetObject",
    Resource: publicReadResource,
  };

  const basePolicy = {
    Version: "2012-10-17",
    Statement: [publicReadStatement],
  };

  try {
    const existingPolicy = await client.send(new GetBucketPolicyCommand({ Bucket: bucketName }));

    if (!existingPolicy.Policy) {
      return basePolicy;
    }

    const parsedPolicy = JSON.parse(existingPolicy.Policy) as {
      Version?: string;
      Statement?: Array<Record<string, unknown>>;
    };

    const statements = Array.isArray(parsedPolicy.Statement) ? parsedPolicy.Statement : [];
    const remainingStatements = statements.filter(
      (statement) => statement.Sid !== publicReadStatement.Sid,
    );

    return {
      Version: parsedPolicy.Version ?? "2012-10-17",
      Statement: [...remainingStatements, publicReadStatement],
    };
  } catch (error) {
    const maybeNoPolicy = error as { name?: string; $metadata?: { httpStatusCode?: number } };

    if (
      maybeNoPolicy.name === "NoSuchBucketPolicy" ||
      maybeNoPolicy.$metadata?.httpStatusCode === 404
    ) {
      return basePolicy;
    }

    throw error;
  }
}

async function listFiles(directoryPath: string): Promise<string[]> {
  const directoryEntries = await readdir(directoryPath, { withFileTypes: true });
  const filePaths: string[] = [];

  for (const entry of directoryEntries) {
    const fullPath = join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      filePaths.push(...(await listFiles(fullPath)));
      continue;
    }

    if (entry.isFile()) {
      filePaths.push(fullPath);
    }
  }

  return filePaths;
}
