/**
 * Build Lambda functions for AWS deployment using esbuild.
 * Bundles code for Node.js 20 runtime, excluding AWS SDK (provided by Lambda).
 */
import * as esbuild from "esbuild";
import { rmSync, mkdirSync, cpSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "dist-aws");

// Clean and create dist directory
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

const lambdas = [
  { name: "processor", entry: "src/processor/index.ts" },
  { name: "coordinator", entry: "src/coordinator/index.ts" },
  { name: "data-quality-checker", entry: "src/data-quality-checker/index.ts" },
  { name: "email-summariser", entry: "src/email-summariser/index.ts" },
  { name: "dashboard-api", entry: "src/backend/dashboard-api/index.ts" },
  { name: "zip-output-checker", entry: "src/zip-output-checker/index.ts" },
  { name: "dlq-handler", entry: "src/dlq-handler/index.ts" },
];

// Copy vendor mappings to dist (processor, coordinator, and dashboard-api need them)
const mappingsSource = join(__dirname, "../../mappings");
const mappingsDests = [
  join(distDir, "processor", "mappings"),
  join(distDir, "coordinator", "mappings"),
  join(distDir, "dashboard-api", "mappings"),
];

async function build() {
  for (const lambda of lambdas) {
    const outdir = join(distDir, lambda.name);
    mkdirSync(outdir, { recursive: true });

    console.log(`Building ${lambda.name}...`);

    await esbuild.build({
      entryPoints: [join(__dirname, lambda.entry)],
      bundle: true,
      platform: "node",
      target: "node20",
      format: "esm",
      outfile: join(outdir, "index.mjs"),
      external: [
        "@aws-sdk/*", // AWS SDK v3 is provided by Lambda runtime
      ],
      banner: {
        // Required for ESM in Node.js Lambda
        js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
      },
      minify: true,
      sourcemap: false,
      metafile: true,
    });

    console.log(`  → ${outdir}/index.mjs`);
  }

  // Copy mappings for processor, coordinator, and dashboard-api
  if (existsSync(mappingsSource)) {
    for (const dest of mappingsDests) {
      mkdirSync(dest, { recursive: true });
      cpSync(mappingsSource, dest, { recursive: true });
    }
    console.log(`Copied vendor mappings to processor, coordinator, and dashboard-api`);
  }

  console.log("\nBuild complete!");
}

await build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
