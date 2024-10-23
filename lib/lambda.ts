import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { PythonFunction } from '@aws-cdk/aws-lambda-python-alpha';
import { Construct } from 'constructs';
import * as dotenv from 'dotenv';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Stack } from 'aws-cdk-lib';

// Load environment variables from .env file
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

    // Define public Lambda functions
    public readonly startWorkflowLambda: PythonFunction;
    public readonly documentExtractionLambda: PythonFunction;
    public readonly dataProcessingLambda: PythonFunction;
    public readonly ibmAppConnectNotificationLambda: PythonFunction;

    constructor(scope: Construct, id: string, props: LambdaConstructProps) {
        super(scope, id);

        const stack = Stack.of(this);
        this.region = stack.region;
        this.account = stack.account;

        try {

            const bedrockModelId = props.bedrockModelId || 'anthropic.claude-3-haiku-20240307-v1:0';
            

            // Create Lambda functions for each step of the document processing workflow
            this.startWorkflowLambda = this.createPythonLambda('StartWorkflowLambda', 'start_workflow', props, {
                STATE_MACHINE_ARN: props.stepFunctionArn,
                DOCUMENT_SOAP_TABLE_NAME: props.documentSoapTableName,
                IBM_APPCONNECT_URL: props.ibmAppConnect.url,
                IBM_APPCONNECT_USERNAME: props.ibmAppConnect.username,
                IBM_APPCONNECT_PASSWORD: props.ibmAppConnect.password,
            });
            this.startWorkflowLambda.addToRolePolicy(new iam.PolicyStatement({
                actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
                resources: ['*'],
            }));
            this.startWorkflowLambda.addToRolePolicy(new iam.PolicyStatement({
                actions: ['dynamodb:GetItem', 'dynamodb:PutItem'],
                resources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${props.documentSoapTableName}`],
            }));

            // Add this new policy statement to grant Step Function execution permissions
            this.startWorkflowLambda.addToRolePolicy(new iam.PolicyStatement({
                actions: ['states:StartExecution'],
                resources: [props.stepFunctionArn],
            }));

            this.documentExtractionLambda = this.createPythonLambda('DocumentExtractionLambda', 'extraction', props, {
                RAW_STAGING_BUCKET_NAME: props.s3BucketNames.shrawStagingBucket,
                DOC_RIO_AUTH_URL: props.docRio.authUrl,
                DOC_RIO_API_URL: props.docRio.apiUrl,
                DOC_RIO_CLIENT_ID: props.docRio.clientId,
                DOC_RIO_CLIENT_SECRET: props.docRio.clientSecret,
                IBM_APPCONNECT_URL: props.ibmAppConnect.url,
                IBM_APPCONNECT_USERNAME: props.ibmAppConnect.username,
                IBM_APPCONNECT_PASSWORD: props.ibmAppConnect.password,
            });
            this.documentExtractionLambda.addToRolePolicy(new iam.PolicyStatement({
                actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
                resources: ['*'],
            }));

            // Add S3 permissions for DocumentExtractionLambda
            this.documentExtractionLambda.addToRolePolicy(new iam.PolicyStatement({
                actions: ['s3:PutObject', 's3:GetObject', 's3:ListBucket'],
                resources: [
                    `arn:aws:s3:::${props.s3BucketNames.shrawStagingBucket}`,
                    `arn:aws:s3:::${props.s3BucketNames.shrawStagingBucket}/*`,
                ],
            }));


            this.dataProcessingLambda = this.createPythonLambda('DataProcessingLambda', 'processing', props, {
                DOCUMENT_METADATA_TABLE_NAME: props.documentMetadataTableName,
                RAW_STAGING_BUCKET_NAME: props.s3BucketNames.shrawStagingBucket,
                LAMBDA_OUTPUT_BUCKET_NAME: props.s3BucketNames.shlambdaOutputBucket,
                BEDROCK_MODEL_ID: bedrockModelId,
                IBM_APPCONNECT_URL: props.ibmAppConnect.url,
                IBM_APPCONNECT_USERNAME: props.ibmAppConnect.username,
                IBM_APPCONNECT_PASSWORD: props.ibmAppConnect.password,
            });
            this.dataProcessingLambda.addToRolePolicy(new iam.PolicyStatement({
                actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
                resources: ['*'],
            }));

            //S3 permissions for data processing lambda
            this.dataProcessingLambda.addToRolePolicy(new iam.PolicyStatement({
                actions: ['s3:ListBucket', 's3:GetObject'],
                resources: [
                    `arn:aws:s3:::${props.s3BucketNames.shtextractOutputBucket}`,
                    `arn:aws:s3:::${props.s3BucketNames.shtextractOutputBucket}/*`, 
                    `arn:aws:s3:::${props.s3BucketNames.shrawStagingBucket}`,
                    `arn:aws:s3:::${props.s3BucketNames.shrawStagingBucket}/*`,
                ],
              }));
              
              this.dataProcessingLambda.addToRolePolicy(new iam.PolicyStatement({
                actions: ['s3:PutObject'],
                resources: [`arn:aws:s3:::${props.s3BucketNames.shlambdaOutputBucket}/*`],
              }));

            // Bedrock permissions
            this.dataProcessingLambda.addToRolePolicy(new iam.PolicyStatement({
                actions: ['bedrock:*'],
                resources: ['*']
            }));

            // Dynamo DB permissions
            this.dataProcessingLambda.addToRolePolicy(new iam.PolicyStatement({
                actions: ['dynamodb:GetItem', 'dynamodb:PutItem'],
                resources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${props.documentMetadataTableName}`],
            }));

            // Textract Permissions
            this.dataProcessingLambda.addToRolePolicy(new iam.PolicyStatement({
                actions: ['textract:StartDocumentTextDetection', 'textract:GetDocumentTextDetection'],
                resources: ['*'],
            }));
            

            this.ibmAppConnectNotificationLambda = this.createPythonLambda('IBMAppConnectNotificationLambda', 'notify_app_connect', props, {
                IBM_APPCONNECT_URL: props.ibmAppConnect.url,
                IBM_APPCONNECT_USERNAME: props.ibmAppConnect.username,
                IBM_APPCONNECT_PASSWORD: props.ibmAppConnect.password,
                DOCUMENT_METADATA_TABLE_NAME: props.documentMetadataTableName,
            });

            // Add specific DynamoDB permissions for the IBMAppConnectNotificationLambda
            this.ibmAppConnectNotificationLambda.addToRolePolicy(new iam.PolicyStatement({
                actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query'],
                resources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${props.documentMetadataTableName}`],
            }));

            // Add S3 permissions to all Lambda functions
            this.addS3PermissionsToLambda(this.startWorkflowLambda, props.s3BucketNames);
            this.addS3PermissionsToLambda(this.documentExtractionLambda, props.s3BucketNames);
            this.addS3PermissionsToLambda(this.dataProcessingLambda, props.s3BucketNames);
            this.addS3PermissionsToLambda(this.ibmAppConnectNotificationLambda, props.s3BucketNames);

        } catch (error) {
            console.error('Error creating Lambda functions:', error);
            throw error;
        }
    }

    /**
     * Creates a Python Lambda function with specified configuration
     * @param name - The name of the Lambda function
     * @param entryPoint - The entry point for the Lambda function code
     * @param props - The LambdaConstructProps containing shared configuration
     * @param environment - Additional environment variables for the Lambda function
     * @returns A new PythonFunction instance
     */
    private createPythonLambda(
        name: string,
        entryPoint: string,
        props: LambdaConstructProps,
        environment: { [key: string]: string } = {}
    ): PythonFunction {
        console.log(`Creating Python Lambda function: ${name}`);
        return new PythonFunction(this, name, {
            entry: `lambda/${entryPoint}`,
            runtime: lambda.Runtime.PYTHON_3_11,
            index: 'handler.py',
            handler: 'lambda_handler',
            timeout: cdk.Duration.seconds(300), 
            memorySize: 1024,
            environment: environment,
            tracing: lambda.Tracing.ACTIVE, // Enable X-Ray tracing for better observability
            logRetention: logs.RetentionDays.ONE_WEEK, // Set log retention period to manage CloudWatch logs
        });

    }

    // Helper method to add S3 permissions to a Lambda function
    private addS3PermissionsToLambda(lambdaFunction: PythonFunction, bucketNames: {
        shrawStagingBucket: string;
        shtextractOutputBucket: string;
        shlambdaOutputBucket: string;
    }) {
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
