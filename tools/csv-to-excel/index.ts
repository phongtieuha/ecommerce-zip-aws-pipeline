#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import * as XLSX from "xlsx";

function toOutputPath(inputPath: string): string {
  const resolvedInput = path.resolve(inputPath);
  const inputDir = path.dirname(resolvedInput);
  const inputBase = path.basename(resolvedInput, path.extname(resolvedInput));
  return path.join(inputDir, `${inputBase}.xlsx`);
}

function usage(): void {
  console.error(
    `Usage:\n  bun run --filter @filepipeline/csv-to-excel start -- <input.csv>\n\nExamples:\n  bun run --filter @filepipeline/csv-to-excel start -- /tmp/data.csv\n`,
  );
}

function main(): void {
  const inputPath = process.argv[2];

  if (!inputPath || process.argv.length !== 3) {
    usage();
    process.exit(1);
  }

  const resolvedInput = path.resolve(inputPath);
  if (!fs.existsSync(resolvedInput)) {
    console.error(`File not found: ${resolvedInput}`);
    process.exit(1);
  }

  if (path.extname(resolvedInput).toLowerCase() !== ".csv") {
    console.error(`Invalid file type: ${resolvedInput}`);
    console.error(`Only .csv input is accepted.`);
    process.exit(1);
  }

  const csv = fs.readFileSync(resolvedInput, "utf8");

  const records = parse(csv, {
    bom: true,
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: false,
  }) as Array<Record<string, string>>;

  const EXCEL_MAX_CELL_LEN = 32767;
  const truncated = records.map((row) => {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(row)) {
      out[key] =
        typeof value === "string" && value.length > EXCEL_MAX_CELL_LEN
          ? value.slice(0, EXCEL_MAX_CELL_LEN)
          : value;
    }
    return out;
  });

  const sheet = XLSX.utils.json_to_sheet(truncated);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "data");

  const resolvedOutput = toOutputPath(resolvedInput);
  XLSX.writeFile(workbook, resolvedOutput);

  console.log(`Converted CSV to Excel:`);
  console.log(`  input:  ${resolvedInput}`);
  console.log(`  output: ${resolvedOutput}`);
  console.log(`  rows:   ${records.length}`);
}

main();
