import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { PythonFunction } from '@aws-cdk/aws-lambda-python-alpha';
import { Construct } from 'constructs';
import { ApiGatewayConstruct, ApiGatewayProps } from './api-gateway';
import { DynamoDBConstruct } from './dynamodb';
import { S3BucketsConstruct } from './s3-buckets';
import { StepFunction } from './step-function';
import { applyTagsToStack } from './utils/resource_tagger';
import { LambdaConstruct } from './lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

export class SHStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        // Validate required environment variables
        this.validateEnvironmentVariables();

        // Create DynamoDB table
        const dynamoDB = new DynamoDBConstruct(this, 'DynamoDB');

        try {

            const bedrockModelId = process.env.BEDROCK_MODEL_ID || 'anthropic.claude-3-haiku-20240307-v1:0';
            

            // Create Lambda functions
            const lambdas = new LambdaConstruct(this, 'Lambdas', {
                s3BucketNames: {
                    shrawStagingBucket: process.env.RAW_STAGING_BUCKET_NAME!,
                    shtextractOutputBucket: process.env.TEXTRACT_OUTPUT_BUCKET_NAME!,
                    shlambdaOutputBucket: process.env.LAMBDA_OUTPUT_BUCKET_NAME!,
                },
                documentMetadataTableName: process.env.DOCUMENT_METADATA_TABLE_NAME!,
                documentSoapTableName: process.env.DOCUMENT_SOAP_TABLE_NAME!,
                ibmAppConnect: {
                    url: process.env.IBM_APPCONNECT_URL!,
                    username: process.env.IBM_APPCONNECT_USERNAME!,
                    password: process.env.IBM_APPCONNECT_PASSWORD!,
                },
                bedrockModelId: bedrockModelId,
                stepFunctionArn: process.env.STATE_MACHINE_ARN!,
                docRio: {
                    apiUrl: process.env.DOC_RIO_API_URL!,
                    authUrl: process.env.DOC_RIO_AUTH_URL!,
                    clientId: process.env.DOC_RIO_CLIENT_ID!,
                    clientSecret: process.env.DOC_RIO_CLIENT_SECRET!,
                },
            });

            // Create the Step Function
            const stepFunction = new StepFunction(this, 'DocumentProcessingStepFunction', {
                startWorkflowLambda: lambdas.startWorkflowLambda,
                extractionLambda: lambdas.documentExtractionLambda,
                processingLambda: lambdas.dataProcessingLambda,
                notifyIBMAppConnectLambda: lambdas.ibmAppConnectNotificationLambda,
            });

            // Create API Gateway
            const apiGateway = new ApiGatewayConstruct(this, 'ApiGateway', {
                startWorkflowLambda: lambdas.startWorkflowLambda,
            });

            // Apply tags to all resources in the stack
            applyTagsToStack(this, {
                Project: process.env.PROJECT_NAME!,
                Team: process.env.TEAM_NAME!,
                Environment: process.env.ENVIRONMENT!,
            });
        } catch (error) {
            console.error('Error creating SHStack:', error);
            throw error;
        }
    }

    private validateEnvironmentVariables() {
        const requiredEnvVars = [
            'IBM_APPCONNECT_URL',
            'RAW_STAGING_BUCKET_NAME',
            'TEXTRACT_OUTPUT_BUCKET_NAME',
            'LAMBDA_OUTPUT_BUCKET_NAME',
            'DOCUMENT_METADATA_TABLE_NAME',
            'PROJECT_NAME',
            'TEAM_NAME',
            'ENVIRONMENT'
        ];

        for (const envVar of requiredEnvVars) {
            if (!process.env[envVar]) {
                throw new Error(`Missing required environment variable: ${envVar}`);
            }
        }
    }
}

