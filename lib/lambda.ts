import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { PythonFunction } from '@aws-cdk/aws-lambda-python-alpha';
import { Construct } from 'constructs';
import * as dotenv from 'dotenv';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Stack } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as awsLambda from 'aws-cdk-lib/aws-lambda';

dotenv.config();

export interface LambdaConstructProps {
    s3BucketNames: {
        shrawStagingBucket: string;
        shtextractOutputBucket: string;
        shlambdaOutputBucket: string;
    };
    bedrockModelId?: string;
    documentMetadataTableName: string;
    documentSoapTableName: string;
    ibmAppConnect: {
        url: string;
        username: string;
        password: string;
    };
    stepFunctionArn: string;
    docRio: {
        authUrl: string;
        apiUrl: string;
        clientId: string;
        clientSecret: string;
    };
}

export class LambdaConstruct extends Construct {
    private readonly region: string;
    private readonly account: string;
    private readonly role: iam.IRole;

    public readonly startWorkflowLambda: PythonFunction;
    public readonly documentExtractionLambda: PythonFunction;
    public readonly dataProcessingLambda: PythonFunction;
    public readonly ibmAppConnectNotificationLambda: PythonFunction;

    constructor(scope: Construct, id: string, props: LambdaConstructProps) {
        super(scope, id);

        const stack = Stack.of(this);
        this.region = stack.region;
        this.account = stack.account;
        this.role = new iam.Role(this, 'LambdaRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        });

        const bedrockModelId = props.bedrockModelId || 'anthropic.claude-3-haiku-20240307-v1:0';


        this.startWorkflowLambda = this.createLambdaFunction('StartWorkflowLambda', 'start_workflow', props, {
            STATE_MACHINE_ARN: props.stepFunctionArn,
            DOCUMENT_SOAP_TABLE_NAME: props.documentSoapTableName,
            IBM_APPCONNECT_URL: props.ibmAppConnect.url,
            IBM_APPCONNECT_USERNAME: props.ibmAppConnect.username,
            IBM_APPCONNECT_PASSWORD: props.ibmAppConnect.password,
        });

        this.documentExtractionLambda = this.createLambdaFunction('DocumentExtractionLambda', 'extraction', props, {
            RAW_STAGING_BUCKET_NAME: props.s3BucketNames.shrawStagingBucket,
            DOC_RIO_AUTH_URL: props.docRio.authUrl,
            DOC_RIO_API_URL: props.docRio.apiUrl,
            DOC_RIO_CLIENT_ID: props.docRio.clientId,
            DOC_RIO_CLIENT_SECRET: props.docRio.clientSecret,
            IBM_APPCONNECT_URL: props.ibmAppConnect.url,
            IBM_APPCONNECT_USERNAME: props.ibmAppConnect.username,
            IBM_APPCONNECT_PASSWORD: props.ibmAppConnect.password,
        });

        this.dataProcessingLambda = this.createLambdaFunction('DataProcessingLambda', 'processing', props, {
            DOCUMENT_METADATA_TABLE_NAME: props.documentMetadataTableName,
            RAW_STAGING_BUCKET_NAME: props.s3BucketNames.shrawStagingBucket,
            LAMBDA_OUTPUT_BUCKET_NAME: props.s3BucketNames.shlambdaOutputBucket,
            BEDROCK_MODEL_ID: bedrockModelId,
            IBM_APPCONNECT_URL: props.ibmAppConnect.url,
            IBM_APPCONNECT_USERNAME: props.ibmAppConnect.username,
            IBM_APPCONNECT_PASSWORD: props.ibmAppConnect.password,
        });

        this.ibmAppConnectNotificationLambda = this.createLambdaFunction('IBMAppConnectNotificationLambda', 'notify_app_connect', props, {
            IBM_APPCONNECT_URL: props.ibmAppConnect.url,
            IBM_APPCONNECT_USERNAME: props.ibmAppConnect.username,
            IBM_APPCONNECT_PASSWORD: props.ibmAppConnect.password,
            DOCUMENT_METADATA_TABLE_NAME: props.documentMetadataTableName,
        });
        
        this.setupCommonConfigurations(props);

    }

    private createLambdaFunction(name: string, entryPoint: string, props: LambdaConstructProps, environment: { [key: string]: string }): PythonFunction {
        const lambda: PythonFunction = new PythonFunction(this, name, {
            entry: `lambda/${entryPoint}`,
            runtime: awsLambda.Runtime.PYTHON_3_11,
            index: 'handler.py',
            handler: 'lambda_handler',
            timeout: cdk.Duration.seconds(900),
            memorySize: 2048,
            environment: environment,
            tracing: awsLambda.Tracing.ACTIVE,
            logRetention: logs.RetentionDays.ONE_WEEK,
        });

        // Add xray permissions for all lambdas
        lambda.addToRolePolicy(new iam.PolicyStatement({
            actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
            resources: ['*'],
        }));

        if (name === 'DataProcessingLambda') {
            lambda.addToRolePolicy(new iam.PolicyStatement({
                actions: ['bedrock:*', 'textract:GetDocumentTextDetection', 'textract:StartDocumentTextDetection'],
                resources: ['*'],
            }));

            lambda.addToRolePolicy(new iam.PolicyStatement({
                actions: ['dynamodb:GetItem', 'dynamodb:PutItem'],
                resources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${props.documentMetadataTableName}`],
            }));
        }

        if (name === 'IBMAppConnectNotificationLambda') {
            lambda.addToRolePolicy(new iam.PolicyStatement({
                actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:UpdateItem'],
                resources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${props.documentMetadataTableName}`],
            }));
        }

        if (name === 'StartWorkflowLambda') {
            lambda.addToRolePolicy(new iam.PolicyStatement({
                actions: ['dynamodb:GetItem', 'dynamodb:PutItem'],
                resources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${props.documentSoapTableName}`],
            }));

            lambda.addToRolePolicy(new iam.PolicyStatement({
                actions: ['states:StartExecution'],
                resources: [props.stepFunctionArn],
            }));
        }

        this.addS3PermissionsToLambda(lambda, props.s3BucketNames);
        return lambda;
    }

    private setupCommonConfigurations(props: LambdaConstructProps) {
        const startWorkflowTopic = new sns.Topic(this, 'StartWorkflowTopic', {
            topicName: 'StartWorkflowNotificationTopic',
        });

        startWorkflowTopic.addSubscription(new subscriptions.EmailSubscription('salesforce@shulman-hill.com')); 

        // Check if startWorkflowLambda exists before calling addEnvironment
        if (this.startWorkflowLambda) {
            this.startWorkflowLambda.addEnvironment('SNS_TOPIC_ARN', startWorkflowTopic.topicArn);
            this.startWorkflowLambda.addToRolePolicy(new iam.PolicyStatement({
                actions: ['sns:Publish'],
                resources: [startWorkflowTopic.topicArn],
            }));

            const startWorkflowAlarm = new cloudwatch.Alarm(this, 'StartWorkflowAlarm', {
                alarmName: 'StartWorkflowErrorAlarm',
                metric: this.startWorkflowLambda.metricErrors(),
                threshold: 1,
                evaluationPeriods: 1,
                treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
            });
            startWorkflowAlarm.addAlarmAction(new actions.SnsAction(startWorkflowTopic));

            new cdk.CfnOutput(this, 'StartWorkflowSNSTopicArn', {
                value: startWorkflowTopic.topicArn,
                description: 'The ARN of the SNS topic for StartWorkflow Lambda errors',
            });

            const startWorkflowDLQ = new sqs.Queue(this, 'StartWorkflowDLQ', {
                queueName: 'StartWorkflowDeadLetterQueue',
                visibilityTimeout: cdk.Duration.seconds(900),
            });

            this.startWorkflowLambda.addEventSource(new lambdaEventSources.SqsEventSource(startWorkflowDLQ));
            this.startWorkflowLambda.addToRolePolicy(new iam.PolicyStatement({
                actions: ['sqs:SendMessage'],
                resources: [startWorkflowDLQ.queueArn],
            }));

            new cdk.CfnOutput(this, 'StartWorkflowDLQUrl', {
                value: startWorkflowDLQ.queueUrl,
                description: 'The URL of the Dead Letter Queue for StartWorkflow Lambda',
            });

            this.startWorkflowLambda.addEnvironment('DLQ_URL', process.env.DLQ_URL || startWorkflowDLQ.queueUrl);
        } else {
            console.warn('startWorkflowLambda is undefined');
        }

        this.addS3PermissionsToLambda(this.startWorkflowLambda, props.s3BucketNames);
    }

    private addS3PermissionsToLambda(lambdaFunction: PythonFunction | undefined, bucketNames: {
        shrawStagingBucket: string;
        shtextractOutputBucket: string;
        shlambdaOutputBucket: string;
    }) {
        if (!lambdaFunction) {
            console.warn('Lambda function is undefined, skipping S3 permissions');
            return;
        }

        const buckets = [
            bucketNames.shrawStagingBucket,
            bucketNames.shtextractOutputBucket,
            bucketNames.shlambdaOutputBucket
        ];

        buckets.forEach(bucketName => {
            lambdaFunction.addToRolePolicy(new iam.PolicyStatement({
                actions: [
                    's3:PutObject',
                    's3:GetObject',
                    's3:DeleteObject',
                    's3:ListBucket'
                ],
                resources: [
                    `arn:aws:s3:::${bucketName}`,
                    `arn:aws:s3:::${bucketName}/*`
                ],
            }));
        });
    }
}
