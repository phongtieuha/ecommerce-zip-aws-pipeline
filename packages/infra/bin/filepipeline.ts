#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { FilePipelineStack } from "../lib/filepipeline-stack";

const app = new cdk.App();

const region = process.env.CDK_DEFAULT_REGION;
if (!region) throw new Error("CDK_DEFAULT_REGION environment variable is required");

const stack = new FilePipelineStack(app, "FilePipelineStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
  },
  description: "FilePipeline File Processor Infrastructure",
});

// Export stack for potential use in tests or multi-stack deployments
export { stack };

app.synth();
