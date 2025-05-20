import { Construct } from 'constructs';
import { Stack, StackProps, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as eventsources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as path from 'path';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';

export class CallQualityScorecardStack extends Stack {
  private bucket: s3.Bucket;
  private s3Policy: iam.Policy;
  private transcribePolicy: iam.Policy;
  private bedrockRuntimePolicy: iam.Policy;
  private lambdaAudioToText: lambda.Function;
  private lambdaCallAnalysis: lambda.Function;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.bucket = this.createBucket();
    this.uploadConfigToBucket();
    
    
    this.s3Policy = this.createS3Policy();
    this.transcribePolicy = this.createTranscribePolicy();
    this.bedrockRuntimePolicy = this.createBedrockRuntimePolicy();

    this.lambdaAudioToText = this.createLambdaS3TriggerTranscribeFunction();
    this.lambdaCallAnalysis = this.createLambdaS3TriggerBedrockFunction();
  }

  private createBucket(): s3.Bucket {
    return new s3.Bucket(this, 'SummarizerBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.RETAIN,
    });
  }

  private uploadConfigToBucket(): void {
    new s3deploy.BucketDeployment(this, 'DeployConfig', {
      sources: [s3deploy.Source.asset(path.join(__dirname, './config'))],
      destinationBucket: this.bucket,
      destinationKeyPrefix: 'config',
      retainOnDelete: true,
    });
  }

  private createS3Policy(): iam.Policy {
    return new iam.Policy(this, 'S3Policy', {
      policyName: 'S3Policy',
      statements: [
        new iam.PolicyStatement({
          actions: ['s3:*'],
          resources: [this.bucket.bucketArn, `${this.bucket.bucketArn}/*`],
        }),
      ],
    });
  }

  private createTranscribePolicy(): iam.Policy {
    return new iam.Policy(this, 'TranscribePolicy', {
      policyName: 'TranscribePolicy',
      statements: [
        new iam.PolicyStatement({
          actions: ['transcribe:*'],
          resources: [`arn:aws:transcribe:${this.region}:${this.account}:*`],
        }),
      ],
    });
  }

  private createBedrockRuntimePolicy(): iam.Policy {
    return new iam.Policy(this, 'BedrockRuntimePolicy', {
      policyName: 'BedrockRuntimePolicy',
      statements: [
        new iam.PolicyStatement({
          actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
          resources: [
            // `arn:aws:bedrock:${this.region}::foundation-model/*`,
            // `arn:aws:bedrock:${this.region}::inference-profile/*`
            "*"
          ],
        }),
      ],
    });
  }

  private createLambdaS3TriggerTranscribeFunction(): lambda.Function {
    const lambdaFunction = new NodejsFunction(this, 'S3RecordingTriggerTranscribe', {
      functionName: 'audio-to-text',
      runtime: lambda.Runtime.NODEJS_16_X,
      entry: path.join(__dirname, 'lambda/audio-to-text.js'),
      architecture: lambda.Architecture.ARM_64,
      memorySize: 128,
      timeout: Duration.seconds(15),
      environment: {
        OUTPUT_BUCKET: this.bucket.bucketName,
      },
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    lambdaFunction.applyRemovalPolicy(RemovalPolicy.DESTROY);
    lambdaFunction.role?.attachInlinePolicy(this.s3Policy);
    lambdaFunction.role?.attachInlinePolicy(this.transcribePolicy);

    lambdaFunction.addEventSource(
      new eventsources.S3EventSource(this.bucket, {
        events: [s3.EventType.OBJECT_CREATED],
        filters: [{ prefix: 'voices/' }], //TODO: change to recordings
      })
    );

    return lambdaFunction;
  }

  private createLambdaS3TriggerBedrockFunction(): lambda.Function {
    const lambdaFunction = new NodejsFunction(this, 'S3TranscriptionTriggerBedrock', {
      functionName: 'call-scoring',
      runtime: lambda.Runtime.NODEJS_16_X,
      entry: path.join(__dirname, 'lambda/call-scoring.js'),
      architecture: lambda.Architecture.ARM_64,
      memorySize: 128,
      timeout: Duration.seconds(120),
      bundling: {
        nodeModules: ['@aws-sdk/client-bedrock-runtime', '@aws-sdk/client-s3'],
      },
      environment: {
        OUTPUT_BUCKET: this.bucket.bucketName,
      },
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    lambdaFunction.applyRemovalPolicy(RemovalPolicy.DESTROY);
    lambdaFunction.role?.attachInlinePolicy(this.s3Policy);
    lambdaFunction.role?.attachInlinePolicy(this.transcribePolicy);
    lambdaFunction.role?.attachInlinePolicy(this.bedrockRuntimePolicy);

    lambdaFunction.addEventSource(
      new eventsources.S3EventSource(this.bucket, {
        events: [s3.EventType.OBJECT_CREATED],
        filters: [{ prefix: 'transcription/' }], //TODO: change to recordings
      })
    );


    // const rule = new events.Rule(this, 'TranscribeRule', {
    //   eventPattern: {
    //     source: ['aws.transcribe'],
    //     detailType: ['Transcribe Job State Change'],
    //     detail: {
    //       TranscriptionJobStatus: ['COMPLETED', 'FAILED'],
    //       TranscriptionJobName: [{ prefix: 'summarizer-' }],
    //     },
    //   },
    // });

    // rule.addTarget(new targets.LambdaFunction(lambdaFunction));

    // lambdaFunction.addPermission('AllowEventBridgeInvocation', {
    //   principal: new iam.ServicePrincipal('events.amazonaws.com'),
    //   sourceArn: rule.ruleArn,
    // });

    return lambdaFunction;
  }
}