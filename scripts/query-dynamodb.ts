#!/usr/bin/env node

import { DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { writeFileSync } from "node:fs";

const endpoint = process.env.AWS_ENDPOINT_URL || "http://localhost:4566";
const region = process.env.AWS_REGION || "ap-southeast-1";
const tableName = "filepipeline-files";
const batchTableName = "filepipeline-vendor-batches";
const client = new DynamoDBClient({
  endpoint,
  region,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "test",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "test",
  },
});

interface Options {
  outputFile?: string;
  verbose: boolean;
}

interface FileRecord {
  readonly id: string;
  readonly filename: string;
  readonly s3Key: string;
  readonly vendor: string;
  readonly status: string;
  readonly createdAt: string;
  readonly rowCount?: number;
  readonly errorCount?: number;
}

interface VendorBatch {
  readonly batchKey: string;
  readonly vendor: string;
  readonly date: string;
  readonly rows: Array<Record<string, unknown>>;
  readonly fileCount: number;
  readonly successRowCount: number;
  readonly errorRowCount: number;
  readonly isConsolidated: boolean;
  readonly consolidatedOutputKey?: string;
  readonly lastUpdatedAt: string;
}

async function getAllFiles(): Promise<FileRecord[]> {
  const command = new ScanCommand({
    TableName: tableName,
  });

  const response = await client.send(command);
  return (response.Items || []).map((item) => unmarshall(item)) as FileRecord[];
}

async function getByStatus(status: string): Promise<FileRecord[]> {
  const command = new ScanCommand({
    TableName: tableName,
    FilterExpression: "#status = :status",
    ExpressionAttributeNames: {
      "#status": "status",
    },
    ExpressionAttributeValues: {
      ":status": { S: status },
    },
  });

  const response = await client.send(command);
  return (response.Items || []).map((item) => unmarshall(item)) as FileRecord[];
}

async function getByVendor(vendor: string): Promise<FileRecord[]> {
  const command = new ScanCommand({
    TableName: tableName,
    FilterExpression: "vendor = :vendor",
    ExpressionAttributeValues: {
      ":vendor": { S: vendor },
    },
  });

  const response = await client.send(command);
  return (response.Items || []).map((item) => unmarshall(item)) as FileRecord[];
}

async function getAllVendorBatches(): Promise<VendorBatch[]> {
  const command = new ScanCommand({
    TableName: batchTableName,
  });

  const response = await client.send(command);
  return (response.Items || []).map((item) => unmarshall(item)) as VendorBatch[];
}

function formatDate(timestamp: string | number): string {
  return new Date(timestamp).toLocaleString();
}

function printTable(records: FileRecord[]): void {
  if (records.length === 0) {
    console.log("No records found.");
    return;
  }

  console.table(
    records.map((r) => ({
      Vendor: r.vendor,
      Filename: r.filename,
      Status: r.status,
      Records: r.rowCount ?? "-",
      Errors: r.errorCount ?? "-",
      "Created At": formatDate(r.createdAt),
      "S3 Key": r.s3Key,
    })),
  );
}

function printVendorBatches(batches: VendorBatch[]): void {
  if (batches.length === 0) {
    console.log("No vendor batches found.");
    return;
  }

  console.table(
    batches.map((b) => ({
      "Batch Key": b.batchKey,
      Vendor: b.vendor,
      Date: b.date,
      Files: b.fileCount,
      "Success Rows": b.successRowCount,
      "Error Rows": b.errorRowCount,
      "Total Rows": b.successRowCount + b.errorRowCount,
      Consolidated: b.isConsolidated ? "✓" : "✗",
      "Output Key": b.consolidatedOutputKey || "-",
      "Last Updated": b.lastUpdatedAt,
    })),
  );
}

function formatAsText(records: FileRecord[], batches: VendorBatch[], verbose: boolean): string {
  let output = "";

  // Files section
  output += "=".repeat(80) + "\n";
  output += "FILE RECORDS\n";
  output += "=".repeat(80) + "\n\n";
  output += `Found ${records.length} record(s)\n\n`;

  if (records.length > 0) {
    for (const r of records) {
      output += `Vendor:     ${r.vendor}\n`;
      output += `Filename:   ${r.filename}\n`;
      output += `Status:     ${r.status}\n`;
      output += `Records:    ${r.rowCount ?? "-"}\n`;
      output += `Errors:     ${r.errorCount ?? "-"}\n`;
      output += `Created At: ${formatDate(r.createdAt)}\n`;
      output += `S3 Key:     ${r.s3Key}\n`;
      output += "-".repeat(80) + "\n";
    }
  }

  // Vendor batches section
  output += "\n" + "=".repeat(80) + "\n";
  output += "VENDOR BATCHES (CONSOLIDATION STATUS)\n";
  output += "=".repeat(80) + "\n\n";
  output += `Found ${batches.length} batch(es)\n\n`;

  if (batches.length > 0) {
    for (const b of batches) {
      output += `Batch Key:        ${b.batchKey}\n`;
      output += `Vendor:           ${b.vendor}\n`;
      output += `Date:             ${b.date}\n`;
      output += `Files Processed:  ${b.fileCount}\n`;
      output += `Success Rows:     ${b.successRowCount}\n`;
      output += `Error Rows:       ${b.errorRowCount}\n`;
      output += `Total Rows:       ${b.successRowCount + b.errorRowCount}\n`;
      output += `Consolidated:     ${b.isConsolidated ? "Yes" : "No"}\n`;
      output += `Output Key:       ${b.consolidatedOutputKey || "-"}\n`;
      output += `Last Updated:     ${b.lastUpdatedAt}\n`;
      output += "-".repeat(80) + "\n";
    }
  }

  return output;
}

function parseArgs(): { command: string; arg?: string; options: Options } {
  const args = process.argv.slice(2);
  const options: Options = { verbose: false };
  let command = "";
  let arg: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const current = args[i];

    if (current === "--output" || current === "-o") {
      options.outputFile = args[++i];
    } else if (current === "--verbose" || current === "-v") {
      options.verbose = true;
    } else if (!command) {
      command = current.toLowerCase();
    } else if (!arg) {
      arg = current;
    }
  }

  return { command, arg, options };
}

async function main(): Promise<void> {
  const { command, arg, options } = parseArgs();

  try {
    let records: FileRecord[] = [];

    switch (command) {
      case "all":
      case "":
        if (!options.outputFile) console.log("📋 All files in DynamoDB:\n");
        records = await getAllFiles();
        break;

      case "status":
        if (!arg) {
          console.error("❌ Usage: bun run query:local:dynamodb status <COMPLETED|PARTIAL|FAILED>");
          process.exit(1);
        }
        if (!options.outputFile) console.log(`📋 Files with status "${arg}":\n`);
        records = await getByStatus(arg.toUpperCase());
        break;

      case "vendor":
        if (!arg) {
          console.error("❌ Usage: bun run query:local:dynamodb vendor <vendor-a|vendor-b>");
          process.exit(1);
        }
        if (!options.outputFile) console.log(`📋 Files from vendor "${arg}":\n`);
        records = await getByVendor(arg);
        break;

      default:
        console.error("❌ Invalid command. Usage:");
        console.error("  bun run query:local:dynamodb [COMMAND] [ARG] [OPTIONS]");
        console.error("");
        console.error("Commands:");
        console.error("  all              Show all files (default)");
        console.error("  status <STATUS>  Filter by status (COMPLETED, PARTIAL, FAILED, DLQ)");
        console.error("  vendor <VENDOR>  Filter by vendor");
        console.error("");
        console.error("Options:");
        console.error("  -o, --output <file>  Write output to file instead of console");
        console.error("  -v, --verbose        Include full row data in vendor batches");
        process.exit(1);
    }

    // Get vendor batches
    const batches = await getAllVendorBatches();

    // Output to file or console
    if (options.outputFile) {
      const textOutput = formatAsText(records, batches, options.verbose);
      writeFileSync(options.outputFile, textOutput, "utf-8");
      console.log(`✅ Output written to ${options.outputFile}`);
      console.log(`   Files: ${records.length}, Batches: ${batches.length}`);
      if (options.verbose) {
        console.log(`   ℹ️  Verbose mode: Full row data included`);
      }
    } else {
      console.log(`Found ${records.length} record(s)\n`);
      printTable(records);
      console.log();

      console.log("📦 Vendor Batches (Consolidation Status):\n");
      console.log(`Found ${batches.length} batch(es)\n`);
      printVendorBatches(batches);
      console.log();

      if (options.verbose) {
        console.log("ℹ️  Use --output to save full verbose output with row data to a file\n");
      }
    }
  } catch (error) {
    console.error("❌ Error querying DynamoDB:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
