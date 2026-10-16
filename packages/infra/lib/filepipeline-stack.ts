import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as cr from "aws-cdk-lib/custom-resources";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as apigwv2Authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import { Construct } from "constructs";

declare const process: {
  readonly env: Record<string, string | undefined>;
};

export class FilePipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Tag resources (Tier is applied per-resource-group further down, once
    // the data/app/web resources below are all in scope)
    cdk.Tags.of(this).add("Project", "filepipeline");
    cdk.Tags.of(this).add("ENV", "prod");

    const parseCsvEnv = (name: string, fallback: string[]): string[] => {
      const raw = process.env[name];
      if (!raw) return fallback;

      const parsed = raw
        .split(",")
        .map((item: string) => item.trim())
        .filter(Boolean);

      return parsed.length > 0 ? parsed : fallback;
    };

    // Consolidation Coordination Table (for coordinator Lambda)
    const consolidationTable = new dynamodb.Table(this, "ConsolidationTable", {
      tableName: "filepipeline-consolidation",
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // DynamoDB Table
    const filesTable = new dynamodb.Table(this, "FilesTable", {
      tableName: "filepipeline-files",
      partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // GSI for querying by vendor and status
    filesTable.addGlobalSecondaryIndex({
      indexName: "vendor-status-index",
      partitionKey: { name: "vendor", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "status", type: dynamodb.AttributeType.STRING },
    });

    // GSI for querying by status and createdAt
    filesTable.addGlobalSecondaryIndex({
      indexName: "status-createdAt-index",
      partitionKey: { name: "status", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "createdAt", type: dynamodb.AttributeType.STRING },
    });

    // GSI for querying by s3Key
    filesTable.addGlobalSecondaryIndex({
      indexName: "s3Key-index",
      partitionKey: { name: "s3Key", type: dynamodb.AttributeType.STRING },
    });

    // DynamoDB Vendor Batch Table (for consolidating multiple files)
    const vendorBatchTable = new dynamodb.Table(this, "VendorBatchTable", {
      tableName: "filepipeline-vendor-batches",
      partitionKey: { name: "batchKey", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // SQS Dead Letter Queue
    const dlq = new sqs.Queue(this, "ProcessorDLQ", {
      queueName: "filepipeline-dlq",
      retentionPeriod: cdk.Duration.days(14),
    });

    // SQS Main Queue
    const processingQueue = new sqs.Queue(this, "ProcessingQueue", {
      queueName: "filepipeline-queue",
      visibilityTimeout: cdk.Duration.minutes(10), // 6x Lambda timeout
      retentionPeriod: cdk.Duration.days(1),
      deadLetterQueue: {
        queue: dlq,
        maxReceiveCount: 2,
      },
    });

    // SQS delay queue for zip-output-checker: each message carries its own
    // 5-minute DelaySeconds, so the consumer Lambda fires exactly once per
    // ZIP instead of polling a shared table on a fixed schedule.
    const zipCheckDelayDlq = new sqs.Queue(this, "ZipCheckDelayDLQ", {
      queueName: "filepipeline-zip-check-dlq",
      retentionPeriod: cdk.Duration.days(14),
    });

    const zipCheckDelayQueue = new sqs.Queue(this, "ZipCheckDelayQueue", {
      queueName: "filepipeline-zip-check-delay",
      visibilityTimeout: cdk.Duration.minutes(1),
      retentionPeriod: cdk.Duration.days(1),
      deadLetterQueue: {
        queue: zipCheckDelayDlq,
        maxReceiveCount: 2,
      },
    });

    const dataQualityLockTable = new dynamodb.Table(this, "DataQualityLockTable", {
      tableName: "filepipeline-data-quality-locks",
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // S3 Buckets
    const incomingBucket = new s3.Bucket(this, "IncomingBucket", {
      bucketName:
        process.env.INCOMING_BUCKET?.trim() ||
        `filepipeline-incoming-${this.account}-${this.region}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      eventBridgeEnabled: true,
    });

    const processedBucket = new s3.Bucket(this, "ProcessedBucket", {
      bucketName:
        process.env.PROCESSED_BUCKET?.trim() ||
        `filepipeline-processed-${this.account}-${this.region}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const dashboardPrefix = "dashboard";

    const dashboardOriginAccessIdentity = new cloudfront.OriginAccessIdentity(
      this,
      "DashboardOriginAccessIdentity",
      {
        comment: "OAI for FilePipeline dashboard static assets",
      },
    );

    const dashboardDistribution = new cloudfront.Distribution(this, "DashboardDistribution", {
      defaultRootObject: `${dashboardPrefix}/index.html`,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessIdentity(processedBucket, {
          originAccessIdentity: dashboardOriginAccessIdentity,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
      },
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: `/${dashboardPrefix}/index.html`,
          ttl: cdk.Duration.minutes(5),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: `/${dashboardPrefix}/index.html`,
          ttl: cdk.Duration.minutes(5),
        },
      ],
    });

    const dashboardCloudFrontBaseUrl = `https://${dashboardDistribution.domainName}`;
    const dashboardCloudFrontAppUrl = `${dashboardCloudFrontBaseUrl}/${dashboardPrefix}/`;

    // Pre-create .keep placeholder objects so all known incoming prefixes are
    // permanently visible in S3 (S3 has no real folders; once the last object
    // under a prefix is removed the "folder" disappears from the console).
    // The processor Lambda also writes .keep after archiving as a safety net
    // for any channels added in the future without a CDK redeploy.
    const knownIncomingPrefixes = [
      "file_type=html/channel=711/request_type=shop-products",
      "file_type=html/channel=711/request_type=product-skus",
      "file_type=json/channel=lazada/request_type=shop-products",
      "file_type=json/channel=lazada/request_type=product-skus",
      "file_type=json/channel=momoshop/request_type=catalogue-products",
      "file_type=json/channel=momoshop/request_type=keyword-products",
      "file_type=json/channel=momoshop/request_type=product-skus",
      "file_type=json/channel=redmart/request_type=shop-products",
      "file_type=json/channel=redmart/request_type=product-skus",
      "file_type=json/channel=shopee/request_type=shop-products",
      "file_type=json/channel=shopee/request_type=product-skus",
      "file_type=json/channel=tiktok/request_type=username-products",
      "file_type=json/channel=tiktok/request_type=product-skus",
      "file_type=json/channel=watsons/request_type=shop-products",
      "file_type=json/channel=watsons/request_type=product-skus",
      "archive",
    ];

    for (const prefix of knownIncomingPrefixes) {
      const resourceId = prefix.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-");
      new cr.AwsCustomResource(this, `IncomingKeep-${resourceId}`, {
        onCreate: {
          service: "S3",
          action: "putObject",
          parameters: {
            Bucket: incomingBucket.bucketName,
            Key: `${prefix}/.keep`,
            Body: "",
          },
          physicalResourceId: cr.PhysicalResourceId.of(`incoming-keep-${prefix}`),
        },
        policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
          resources: [incomingBucket.arnForObjects("*")],
        }),
      });
    }

    // S3 Event Notification to SQS
    incomingBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.SqsDestination(processingQueue),
      { prefix: "file_type", suffix: ".zip" },
    );

    // =========================================================================
    // CloudWatch Log Groups (explicit for retention control)
    // =========================================================================

    const processorLogGroup = new logs.LogGroup(this, "ProcessorLogGroup", {
      logGroupName: "/aws/lambda/filepipeline-processor",
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // =========================================================================
    // Lambda Functions (Node.js 20 runtime for AWS deployment)
    // =========================================================================

    // Processor Lambda
    const processorLambda = new lambda.Function(this, "ProcessorLambda", {
      functionName: "filepipeline-processor",
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset("../lambda/dist-aws/processor"),
      timeout: cdk.Duration.minutes(5),
      memorySize: 2560,
      reservedConcurrentExecutions: 100,
      logGroup: processorLogGroup,
      environment: {
        DYNAMODB_TABLE: filesTable.tableName,
        INCOMING_BUCKET: incomingBucket.bucketName,
        PROCESSED_BUCKET: processedBucket.bucketName,
        ENABLE_FEATURE2_VALIDATION: process.env.ENABLE_FEATURE2_VALIDATION?.trim() || "false",
        ENABLE_FEATURE2_ERROR_REPORT: process.env.ENABLE_FEATURE2_ERROR_REPORT?.trim() || "false",
      },
    });

    // Grant permissions
    filesTable.grantReadWriteData(processorLambda);
    vendorBatchTable.grantReadWriteData(processorLambda);

    incomingBucket.grantRead(processorLambda);
    incomingBucket.grantWrite(processorLambda);
    processedBucket.grantWrite(processorLambda);

    // SQS Event Source for Processor
    processorLambda.addEventSource(
      new lambdaEventSources.SqsEventSource(processingQueue, {
        batchSize: 1,
        maxConcurrency: 100,
        reportBatchItemFailures: true, // Enable partial batch failure reporting
      }),
    );

    // =========================================================================
    // DLQ Handler Lambda — marks a file record `status: "DLQ"` whenever SQS
    // itself moves a message to filepipeline-dlq, independent of whether the
    // processor's own in-process error handling ever got a chance to run
    // (a hard Lambda execution timeout kills the invocation before any of its
    // own catch/finally code can run, so its own DLQ bookkeeping never fires).
    // =========================================================================
    const dlqHandlerLogGroup = new logs.LogGroup(this, "DlqHandlerLogGroup", {
      logGroupName: "/aws/lambda/filepipeline-dlq-handler",
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const dlqHandlerLambda = new lambda.Function(this, "DlqHandlerLambda", {
      functionName: "filepipeline-dlq-handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset("../lambda/dist-aws/dlq-handler"),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      logGroup: dlqHandlerLogGroup,
      environment: {
        DYNAMODB_TABLE: filesTable.tableName,
      },
    });

    filesTable.grantReadWriteData(dlqHandlerLambda);

    dlqHandlerLambda.addEventSource(
      new lambdaEventSources.SqsEventSource(dlq, {
        batchSize: 10,
      }),
    );

    // =========================================================================
    // Coordinator Lambda (for CSV merge coordination)
    // =========================================================================
    const coordinatorLogGroup = new logs.LogGroup(this, "CoordinatorLogGroup", {
      logGroupName: "/aws/lambda/filepipeline-coordinator",
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const coordinatorLambda = new lambda.Function(this, "CoordinatorLambda", {
      functionName: "filepipeline-coordinator",
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset("../lambda/dist-aws/coordinator"),
      timeout: cdk.Duration.minutes(5),
      memorySize: 3584,
      logGroup: coordinatorLogGroup,
      environment: {
        DYNAMODB_TABLE: filesTable.tableName,
        CONSOLIDATION_TABLE: consolidationTable.tableName,
        PROCESSED_BUCKET: processedBucket.bucketName,
        EXTERNAL_EGRESSOR_FUNCTION: "filepipeline-external-egressor",
        CONSOLIDATION_EGRESSOR_FUNCTION: "filepipeline-consolidation-egressor",
        ENABLE_FEATURE1_VALIDATION: process.env.ENABLE_FEATURE1_VALIDATION?.trim() || "false",
        ENABLE_FEATURE1_ERROR_REPORT: process.env.ENABLE_FEATURE1_ERROR_REPORT?.trim() || "true",
        ...(process.env.SENDGRID_API_KEY ? { SENDGRID_API_KEY: process.env.SENDGRID_API_KEY } : {}),
      },
    });

    const dataQualityCheckerLogGroup = new logs.LogGroup(this, "DataQualityCheckerLogGroup", {
      logGroupName: "/aws/lambda/filepipeline-data-quality-checker",
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const dataQualityCheckerLambda = new lambda.Function(this, "DataQualityCheckerLambda", {
      functionName: "filepipeline-data-quality-checker",
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset("../lambda/dist-aws/data-quality-checker"),
      timeout: cdk.Duration.minutes(5),
      memorySize: 1536,
      logGroup: dataQualityCheckerLogGroup,
      environment: {
        PROCESSED_BUCKET: processedBucket.bucketName,
        DATA_QUALITY_LOCK_TABLE: dataQualityLockTable.tableName,
        DATA_QUALITY_RETRY_DELAY_SECONDS: "180",
        DATA_QUALITY_LOCK_TTL_SECONDS: "600",
      },
    });

    // Grant permissions
    filesTable.grantReadWriteData(coordinatorLambda);
    processedBucket.grantReadWrite(coordinatorLambda);
    consolidationTable.grantReadWriteData(coordinatorLambda);
    processedBucket.grantRead(dataQualityCheckerLambda);
    dataQualityLockTable.grantReadWriteData(dataQualityCheckerLambda);
    dataQualityCheckerLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject", "s3:DeleteObject"],
        resources: [processedBucket.arnForObjects("data-quality/*")],
      }),
    );
    coordinatorLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: [
          `arn:aws:lambda:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:function:filepipeline-external-egressor`,
          `arn:aws:lambda:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:function:filepipeline-consolidation-egressor`,
        ],
      }),
    );

    // S3 Event Notification: processed bucket triggers coordinator Lambda on .csv files under output/ only
    processedBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(coordinatorLambda),
      { prefix: "output/", suffix: ".csv" },
    );

    // =========================================================================
    // ZIP Output Checker Lambda (S3 event handler)
    // =========================================================================
    const zipOutputCheckerS3LogGroup = new logs.LogGroup(this, "ZipOutputCheckerS3LogGroup", {
      logGroupName: "/aws/lambda/filepipeline-zip-output-checker-s3",
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const zipOutputCheckerS3Lambda = new lambda.Function(this, "ZipOutputCheckerS3Lambda", {
      functionName: "filepipeline-zip-output-checker-s3",
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handleS3ZipArrival",
      code: lambda.Code.fromAsset("../lambda/dist-aws/zip-output-checker"),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      logGroup: zipOutputCheckerS3LogGroup,
      environment: {
        ZIP_CHECK_QUEUE_URL: zipCheckDelayQueue.queueUrl,
      },
    });

    zipCheckDelayQueue.grantSendMessages(zipOutputCheckerS3Lambda);

    // EventBridge rule: trigger zip-output-checker S3 handler on incoming .zip objects
    const zipOutputCheckerS3EventRule = new events.Rule(this, "ZipOutputCheckerS3EventRule", {
      eventPattern: {
        source: ["aws.s3"],
        detailType: ["Object Created"],
        detail: {
          bucket: {
            name: [incomingBucket.bucketName],
          },
          object: {
            key: [{ suffix: ".zip" }],
          },
        },
      },
    });

    zipOutputCheckerS3EventRule.addTarget(new targets.LambdaFunction(zipOutputCheckerS3Lambda));

    // =========================================================================
    // ZIP Output Checker Lambda (SQS delay-queue handler)
    // =========================================================================
    const zipOutputCheckerDelayedLogGroup = new logs.LogGroup(
      this,
      "ZipOutputCheckerDelayedLogGroup",
      {
        logGroupName: "/aws/lambda/filepipeline-zip-output-checker-delayed",
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      },
    );

    const zipOutputCheckerDelayedLambda = new lambda.Function(
      this,
      "ZipOutputCheckerDelayedLambda",
      {
        functionName: "filepipeline-zip-output-checker-delayed",
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: "index.handleDelayedCheck",
        code: lambda.Code.fromAsset("../lambda/dist-aws/zip-output-checker"),
        timeout: cdk.Duration.seconds(30),
        memorySize: 256,
        logGroup: zipOutputCheckerDelayedLogGroup,
        environment: {
          PROCESSED_BUCKET: processedBucket.bucketName,
        },
      },
    );

    processedBucket.grantRead(zipOutputCheckerDelayedLambda);

    // Each ZIP's check message becomes visible only after its own DelaySeconds
    // elapses, so this Lambda fires exactly once per ZIP instead of on a fixed schedule.
    zipOutputCheckerDelayedLambda.addEventSource(
      new lambdaEventSources.SqsEventSource(zipCheckDelayQueue, {
        batchSize: 1,
        reportBatchItemFailures: true,
      }),
    );

    // =========================================================================
    // Email Summariser Lambda (daily at 8:00 AM SGT)
    // =========================================================================
    const emailSummariserLogGroup = new logs.LogGroup(this, "EmailSummariserLogGroup", {
      logGroupName: "/aws/lambda/filepipeline-email-summariser",
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const emailSummariserLambda = new lambda.Function(this, "EmailSummariserLambda", {
      functionName: "filepipeline-email-summariser",
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset("../lambda/dist-aws/email-summariser"),
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        DYNAMODB_TABLE: filesTable.tableName,
        CONSOLIDATION_TABLE: consolidationTable.tableName,
        PROCESSED_BUCKET: processedBucket.bucketName,
      },
      logGroup: emailSummariserLogGroup,
    });

    filesTable.grantReadData(emailSummariserLambda);
    consolidationTable.grantReadData(emailSummariserLambda);
    processedBucket.grantReadWrite(emailSummariserLambda);

    // 8:00 AM SGT = 00:00 UTC daily
    const emailSummariserSchedule = new events.Rule(this, "EmailSummariserSchedule", {
      schedule: events.Schedule.cron({ minute: "0", hour: "0" }),
      description: "Runs email summariser Lambda daily at 8:00 AM SGT",
    });

    emailSummariserSchedule.addTarget(new targets.LambdaFunction(emailSummariserLambda));

    // Runs at 00:00, 06:00, 12:00, 18:00 UTC (every 6 hours, 4 times daily)
    const dataQualityCheckerSchedule = new events.Rule(this, "DataQualityCheckerSchedule", {
      schedule: events.Schedule.cron({ minute: "0", hour: "0,6,12,18" }),
      description: "Runs data quality checker Lambda every 6 hours (4 times daily at UTC)",
    });

    dataQualityCheckerSchedule.addTarget(new targets.LambdaFunction(dataQualityCheckerLambda));

    // =========================================================================
    // Dashboard API Lambda + Cognito/AuthN HTTP API (for SPA token auth)
    // =========================================================================
    const dashboardApiLogGroup = new logs.LogGroup(this, "DashboardApiLogGroup", {
      logGroupName: "/aws/lambda/filepipeline-dashboard-api",
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const dashboardApiLambda = new lambda.Function(this, "DashboardApiLambda", {
      functionName: "filepipeline-dashboard-api",
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset("../lambda/dist-aws/dashboard-api"),
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      logGroup: dashboardApiLogGroup,
      environment: {
        DYNAMODB_TABLE: filesTable.tableName,
        CONSOLIDATION_TABLE: consolidationTable.tableName,
        PROCESSED_BUCKET: processedBucket.bucketName,
      },
    });

    filesTable.grantReadData(dashboardApiLambda);
    consolidationTable.grantReadData(dashboardApiLambda);
    processedBucket.grantRead(dashboardApiLambda);

    const dashboardUserPool = new cognito.UserPool(this, "DashboardUserPool", {
      userPoolName: "filepipeline-dashboard-users",
      selfSignUpEnabled: false,
      signInAliases: {
        email: true,
      },
      mfa: cognito.Mfa.OFF,
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      passwordPolicy: {
        minLength: 8,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: true,
        requireSymbols: false,
      },
    });

    const authCallbackUrls = parseCsvEnv("DASHBOARD_AUTH_CALLBACK_URLS", [
      "http://localhost:5173/",
      dashboardCloudFrontAppUrl,
    ]);
    const authLogoutUrls = parseCsvEnv("DASHBOARD_AUTH_LOGOUT_URLS", [
      "http://localhost:5173/",
      dashboardCloudFrontAppUrl,
    ]);

    const dashboardUserPoolClient = new cognito.UserPoolClient(this, "DashboardUserPoolClient", {
      userPool: dashboardUserPool,
      generateSecret: false,
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
        },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: authCallbackUrls,
        logoutUrls: authLogoutUrls,
      },
    });

    const dashboardUserPoolDomain = dashboardUserPool.addDomain("DashboardUserPoolDomain", {
      cognitoDomain: {
        domainPrefix: `filepipeline-dashboard-${this.account}-${this.region}`.toLowerCase(),
      },
    });

    const seedUserEmail = process.env.DASHBOARD_SEED_USER_EMAIL?.trim();
    const seedUserPassword = process.env.DASHBOARD_SEED_USER_PASSWORD?.trim();

    if (seedUserEmail && seedUserPassword) {
      const seedUser = new cr.AwsCustomResource(this, "DashboardSeedUser", {
        onCreate: {
          service: "CognitoIdentityServiceProvider",
          action: "adminCreateUser",
          parameters: {
            UserPoolId: dashboardUserPool.userPoolId,
            Username: seedUserEmail,
            MessageAction: "SUPPRESS",
            UserAttributes: [
              { Name: "email", Value: seedUserEmail },
              { Name: "email_verified", Value: "true" },
            ],
          },
          physicalResourceId: cr.PhysicalResourceId.of(`dashboard-seed-user-${seedUserEmail}`),
          ignoreErrorCodesMatching: "UsernameExistsException",
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ["cognito-idp:AdminCreateUser"],
            resources: [dashboardUserPool.userPoolArn],
          }),
        ]),
      });

      const setSeedPassword = new cr.AwsCustomResource(this, "DashboardSeedUserPassword", {
        onCreate: {
          service: "CognitoIdentityServiceProvider",
          action: "adminSetUserPassword",
          parameters: {
            UserPoolId: dashboardUserPool.userPoolId,
            Username: seedUserEmail,
            Password: seedUserPassword,
            Permanent: true,
          },
          physicalResourceId: cr.PhysicalResourceId.of(`dashboard-seed-password-${seedUserEmail}`),
        },
        onUpdate: {
          service: "CognitoIdentityServiceProvider",
          action: "adminSetUserPassword",
          parameters: {
            UserPoolId: dashboardUserPool.userPoolId,
            Username: seedUserEmail,
            Password: seedUserPassword,
            Permanent: true,
          },
          physicalResourceId: cr.PhysicalResourceId.of(`dashboard-seed-password-${seedUserEmail}`),
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ["cognito-idp:AdminSetUserPassword"],
            resources: [dashboardUserPool.userPoolArn],
          }),
        ]),
      });

      setSeedPassword.node.addDependency(seedUser);
    }

    const dashboardApiAllowedOrigins = parseCsvEnv("DASHBOARD_API_ALLOWED_ORIGINS", [
      "http://localhost:5173",
      dashboardCloudFrontBaseUrl,
    ]);

    const dashboardApi = new apigwv2.HttpApi(this, "DashboardHttpApi", {
      apiName: "filepipeline-dashboard-api",
      corsPreflight: {
        allowOrigins: dashboardApiAllowedOrigins,
        allowMethods: [apigwv2.CorsHttpMethod.GET],
        allowHeaders: ["authorization", "content-type"],
      },
    });

    const dashboardJwtAuthorizer = new apigwv2Authorizers.HttpJwtAuthorizer(
      "DashboardJwtAuthorizer",
      `https://cognito-idp.${this.region}.amazonaws.com/${dashboardUserPool.userPoolId}`,
      {
        jwtAudience: [dashboardUserPoolClient.userPoolClientId],
      },
    );

    dashboardApi.addRoutes({
      path: "/metrics",
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        "DashboardMetricsIntegration",
        dashboardApiLambda,
      ),
      authorizer: dashboardJwtAuthorizer,
    });

    dashboardApi.addRoutes({
      path: "/feature1/metrics",
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        "DashboardFeature1MetricsIntegration",
        dashboardApiLambda,
      ),
      authorizer: dashboardJwtAuthorizer,
    });

    dashboardApi.addRoutes({
      path: "/feature2/metrics",
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        "DashboardFeature2MetricsIntegration",
        dashboardApiLambda,
      ),
      authorizer: dashboardJwtAuthorizer,
    });

    dashboardApi.addRoutes({
      path: "/feature1/zipFilesIngestedTotal",
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        "DashboardFeature1ZipFilesIngestedTotalIntegration",
        dashboardApiLambda,
      ),
      authorizer: dashboardJwtAuthorizer,
    });

    dashboardApi.addRoutes({
      path: "/feature2/zipFilesIngestedTotal",
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        "DashboardFeature2ZipFilesIngestedTotalIntegration",
        dashboardApiLambda,
      ),
      authorizer: dashboardJwtAuthorizer,
    });

    dashboardApi.addRoutes({
      path: "/feature1/jsonHtmlFilesIngested",
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        "DashboardFeature1JsonHtmlFilesIngestedIntegration",
        dashboardApiLambda,
      ),
      authorizer: dashboardJwtAuthorizer,
    });

    dashboardApi.addRoutes({
      path: "/feature2/jsonHtmlFilesIngested",
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        "DashboardFeature2JsonHtmlFilesIngestedIntegration",
        dashboardApiLambda,
      ),
      authorizer: dashboardJwtAuthorizer,
    });

    dashboardApi.addRoutes({
      path: "/feature1/uniqueProductsIngestedTotal",
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        "DashboardFeature1UniqueProductsIngestedTotalIntegration",
        dashboardApiLambda,
      ),
      authorizer: dashboardJwtAuthorizer,
    });

    dashboardApi.addRoutes({
      path: "/feature2/uniqueProductsIngestedTotal",
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        "DashboardFeature2UniqueProductsIngestedTotalIntegration",
        dashboardApiLambda,
      ),
      authorizer: dashboardJwtAuthorizer,
    });

    dashboardApi.addRoutes({
      path: "/feature1/uniqueProductsInOutputTotalTotal",
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        "DashboardFeature1UniqueProductsInOutputTotalTotalIntegration",
        dashboardApiLambda,
      ),
      authorizer: dashboardJwtAuthorizer,
    });

    dashboardApi.addRoutes({
      path: "/feature2/uniqueProductsInOutputTotalTotal",
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        "DashboardFeature2UniqueProductsInOutputTotalTotalIntegration",
        dashboardApiLambda,
      ),
      authorizer: dashboardJwtAuthorizer,
    });

    dashboardApi.addRoutes({
      path: "/get-data-validation-report",
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        "DashboardDataValidationReportIntegration",
        dashboardApiLambda,
      ),
      authorizer: dashboardJwtAuthorizer,
    });

    dashboardApi.addRoutes({
      path: "/get-product-ids",
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        "DashboardProductIdsIntegration",
        dashboardApiLambda,
      ),
      authorizer: dashboardJwtAuthorizer,
    });

    dashboardApi.addRoutes({
      path: "/get-product-ids-report",
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        "DashboardProductIdsReportIntegration",
        dashboardApiLambda,
      ),
      authorizer: dashboardJwtAuthorizer,
    });

    dashboardApi.addRoutes({
      path: "/get-shop-ids",
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        "DashboardShopIdsIntegration",
        dashboardApiLambda,
      ),
      authorizer: dashboardJwtAuthorizer,
    });

    dashboardApi.addRoutes({
      path: "/get-shop-ids-report",
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        "DashboardShopIdsReportIntegration",
        dashboardApiLambda,
      ),
      authorizer: dashboardJwtAuthorizer,
    });

    // =========================================================================
    // Granular Tier tagging: data (persistent storage), app (compute/queues),
    // web (the dashboard's public-facing surface). Tags.of() recurses into
    // each construct's own children (e.g. a Lambda's auto-generated IAM role),
    // so tagging the top-level resource is sufficient.
    // =========================================================================
    for (const dataResource of [
      consolidationTable,
      filesTable,
      vendorBatchTable,
      dataQualityLockTable,
      incomingBucket,
      processedBucket,
    ]) {
      cdk.Tags.of(dataResource).add("Tier", "data");
    }

    for (const appResource of [
      dlq,
      processingQueue,
      zipCheckDelayDlq,
      zipCheckDelayQueue,
      processorLambda,
      dlqHandlerLambda,
      coordinatorLambda,
      dataQualityCheckerLambda,
      zipOutputCheckerS3Lambda,
      zipOutputCheckerDelayedLambda,
      emailSummariserLambda,
      dashboardApiLambda,
    ]) {
      cdk.Tags.of(appResource).add("Tier", "app");
    }

    for (const webResource of [
      dashboardOriginAccessIdentity,
      dashboardDistribution,
      dashboardUserPool,
      dashboardUserPoolClient,
      dashboardApi,
    ]) {
      cdk.Tags.of(webResource).add("Tier", "web");
    }

    // =========================================================================
    // Outputs
    // =========================================================================

    new cdk.CfnOutput(this, "IncomingBucketName", {
      value: incomingBucket.bucketName,
      description: "Name of the incoming S3 bucket",
      exportName: "filepipeline-incoming-bucket",
    });

    new cdk.CfnOutput(this, "ProcessedBucketName", {
      value: processedBucket.bucketName,
      description: "Name of the processed S3 bucket",
      exportName: "filepipeline-processed-bucket",
    });

    new cdk.CfnOutput(this, "QueueUrl", {
      value: processingQueue.queueUrl,
      description: "URL of the processing SQS queue",
      exportName: "filepipeline-queue-url",
    });

    new cdk.CfnOutput(this, "DLQUrl", {
      value: dlq.queueUrl,
      description: "URL of the dead letter queue",
      exportName: "filepipeline-dlq-url",
    });

    new cdk.CfnOutput(this, "DynamoTableName", {
      value: filesTable.tableName,
      description: "Name of the DynamoDB table",
      exportName: "filepipeline-dynamodb-table",
    });

    new cdk.CfnOutput(this, "VendorBatchTableName", {
      value: vendorBatchTable.tableName,
      description: "Name of the vendor batch DynamoDB table",
      exportName: "filepipeline-vendor-batch-table",
    });

    new cdk.CfnOutput(this, "ConsolidationTableName", {
      value: consolidationTable.tableName,
      description: "Name of the consolidation DynamoDB table",
      exportName: "filepipeline-consolidation-table",
    });

    new cdk.CfnOutput(this, "DataQualityLockTableName", {
      value: dataQualityLockTable.tableName,
      description: "Name of the data quality lock DynamoDB table",
      exportName: "filepipeline-data-quality-lock-table",
    });

    new cdk.CfnOutput(this, "ProcessorLambdaArn", {
      value: processorLambda.functionArn,
      description: "ARN of the processor Lambda function",
    });

    new cdk.CfnOutput(this, "CoordinatorLambdaArn", {
      value: coordinatorLambda.functionArn,
      description: "ARN of the coordinator Lambda function",
    });

    new cdk.CfnOutput(this, "ProcessorLogGroupName", {
      value: processorLogGroup.logGroupName,
      description: "CloudWatch log group for processor Lambda",
    });

    new cdk.CfnOutput(this, "DlqHandlerLambdaArn", {
      value: dlqHandlerLambda.functionArn,
      description: "ARN of the DLQ handler Lambda function",
    });

    new cdk.CfnOutput(this, "DlqHandlerLogGroupName", {
      value: dlqHandlerLogGroup.logGroupName,
      description: "CloudWatch log group for DLQ handler Lambda",
    });

    new cdk.CfnOutput(this, "CoordinatorLogGroupName", {
      value: coordinatorLogGroup.logGroupName,
      description: "CloudWatch log group for coordinator Lambda",
    });

    new cdk.CfnOutput(this, "EmailSummariserLambdaArn", {
      value: emailSummariserLambda.functionArn,
      description: "ARN of the email summariser Lambda function",
    });

    new cdk.CfnOutput(this, "ZipOutputCheckerS3LambdaArn", {
      value: zipOutputCheckerS3Lambda.functionArn,
      description: "ARN of the zip output checker S3 Lambda function",
    });

    new cdk.CfnOutput(this, "ZipOutputCheckerDelayedLambdaArn", {
      value: zipOutputCheckerDelayedLambda.functionArn,
      description: "ARN of the zip output checker delayed (SQS-triggered) Lambda function",
    });

    new cdk.CfnOutput(this, "DashboardApiLambdaArn", {
      value: dashboardApiLambda.functionArn,
      description: "ARN of the dashboard API Lambda function",
    });

    new cdk.CfnOutput(this, "MetricsApiUrl", {
      value: dashboardApi.url ?? "",
      description: "URL of the metrics API Lambda function",
      exportName: "filepipeline-metrics-api-url",
    });

    new cdk.CfnOutput(this, "DashboardUserPoolId", {
      value: dashboardUserPool.userPoolId,
      description: "Cognito User Pool ID for dashboard auth",
      exportName: "filepipeline-dashboard-user-pool-id",
    });

    new cdk.CfnOutput(this, "DashboardUserPoolClientId", {
      value: dashboardUserPoolClient.userPoolClientId,
      description: "Cognito App Client ID for dashboard SPA auth",
      exportName: "filepipeline-dashboard-user-pool-client-id",
    });

    new cdk.CfnOutput(this, "DashboardUserPoolDomain", {
      value: dashboardUserPoolDomain.domainName,
      description: "Cognito Hosted UI domain for dashboard auth",
      exportName: "filepipeline-dashboard-user-pool-domain",
    });

    new cdk.CfnOutput(this, "DashboardCloudFrontDomain", {
      value: dashboardDistribution.domainName,
      description: "CloudFront domain for dashboard",
      exportName: "filepipeline-dashboard-cloudfront-domain",
    });

    new cdk.CfnOutput(this, "DashboardCloudFrontUrl", {
      value: dashboardCloudFrontAppUrl,
      description: "CloudFront dashboard URL",
      exportName: "filepipeline-dashboard-cloudfront-url",
    });

    new cdk.CfnOutput(this, "MetricsApiLogGroupName", {
      value: dashboardApiLogGroup.logGroupName,
      description: "CloudWatch log group for dashboard API Lambda",
    });

    new cdk.CfnOutput(this, "EmailSummariserLogGroupName", {
      value: emailSummariserLogGroup.logGroupName,
      description: "CloudWatch log group for email summariser Lambda",
    });

    new cdk.CfnOutput(this, "ZipOutputCheckerS3LogGroupName", {
      value: zipOutputCheckerS3LogGroup.logGroupName,
      description: "CloudWatch log group for zip output checker S3 Lambda",
    });

    new cdk.CfnOutput(this, "ZipOutputCheckerDelayedLogGroupName", {
      value: zipOutputCheckerDelayedLogGroup.logGroupName,
      description: "CloudWatch log group for zip output checker delayed (SQS-triggered) Lambda",
    });
  }
}
