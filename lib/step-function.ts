import * as cdk from 'aws-cdk-lib';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import { S3BucketsConstruct } from './s3-buckets';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as stepfunctionsTasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';

export interface StepFunctionProps {
    startWorkflowLambda: lambda.IFunction;
    extractionLambda: lambda.IFunction;
    processingLambda: lambda.IFunction;
    notifyIBMAppConnectLambda: lambda.IFunction;
}

export class StepFunction extends Construct {
    public readonly stateMachine: sfn.StateMachine;

    constructor(scope: Construct, id: string, props: StepFunctionProps) {
        super(scope, id);

        const s3Buckets = new S3BucketsConstruct(this, 'S3Buckets');

        // Define a single Fail state
        const jobFailed = new stepfunctions.Fail(this, 'JobFailed', {
            comment: 'Job processing failed'
        });

        // Define all tasks
        const startWorkflowTask = new tasks.LambdaInvoke(this, 'StartWorkflowTask', {
            lambdaFunction: props.startWorkflowLambda,
            outputPath: '$',
            resultPath: '$.startWorkflowResult',
            payloadResponseOnly: true,
            retryOnServiceExceptions: true,
        });

        const documentExtractionTask = new tasks.LambdaInvoke(this, 'DocumentExtractionTask', {
            lambdaFunction: props.extractionLambda,
            outputPath: '$.Payload',
            retryOnServiceExceptions: true,
        });

        const startTextractTask = new stepfunctionsTasks.CallAwsService(this, 'StartTextractTask', {
            service: 'textract',
            action: 'startDocumentAnalysis',
            parameters: {
                DocumentLocation: {
                    S3Object: {
                        Bucket: s3Buckets.shrawStagingBucketName,
                        Name: stepfunctions.JsonPath.stringAt('$.body.file_name')
                    }
                },
                FeatureTypes: ['TABLES'],
                OutputConfig: {
                    S3Bucket: s3Buckets.shtextractOutputBucketName,
                    S3Prefix: stepfunctions.JsonPath.format('textract-output/{}', stepfunctions.JsonPath.stringAt('$.body.file_name'))
                }
            },
            iamResources: ['*'],
            resultPath: '$.textractJobId',
        });

        const waitForTextractJob = new stepfunctions.Wait(this, 'WaitForTextractJob', {
            time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(30)),
        });

        const getTextractJobStatus = new stepfunctionsTasks.CallAwsService(this, 'GetTextractJobStatus', {
            service: 'textract',
            action: 'getDocumentAnalysis',
            parameters: {
                JobId: stepfunctions.JsonPath.stringAt('$.textractJobId.JobId'),
                MaxResults: 1
            },
            iamResources: ['*'],
            resultPath: '$.textractJobStatus',
        });

        const prepareSuccessOutput = new stepfunctions.Pass(this, 'PrepareSuccessOutput', {
            parameters: {
                'processingResult': {
                    'textractJobId': stepfunctions.JsonPath.stringAt('$.textractJobId.JobId'),
                    'documentType': stepfunctions.JsonPath.stringAt('$.body.documentType'),
                    'documentId': stepfunctions.JsonPath.stringAt('$.body.documentId'),
                    'fileInfoId': stepfunctions.JsonPath.stringAt('$.body.fileInfoId'),
                    'bucket_name': stepfunctions.JsonPath.stringAt('$.body.bucket_name'),
                    'file_name': stepfunctions.JsonPath.stringAt('$.body.file_name')
                }
            }
        });

        const processingTask = new tasks.LambdaInvoke(this, 'ProcessingTask', {
            lambdaFunction: props.processingLambda,
            outputPath: '$.Payload',
            inputPath: '$',
            retryOnServiceExceptions: true,
        }).addCatch(jobFailed, {
            resultPath: '$.error'
        });

        const notifyIBMAppConnectTask = new tasks.LambdaInvoke(this, 'NotifyIBMAppConnectTask', {
            lambdaFunction: props.notifyIBMAppConnectLambda,
            outputPath: '$.Payload',
            retryOnServiceExceptions: true,
        }).addCatch(jobFailed, {
            resultPath: '$.error'
        });

        // Define the main chain
        const definition = startWorkflowTask
            .next(documentExtractionTask)
            .next(startTextractTask)
            .next(waitForTextractJob)
            .next(getTextractJobStatus)
            .next(new stepfunctions.Choice(this, 'CheckTextractJobStatus')
                .when(stepfunctions.Condition.stringEquals('$.textractJobStatus.JobStatus', 'SUCCEEDED'), prepareSuccessOutput
                    .next(processingTask)
                    .next(notifyIBMAppConnectTask)
                    .next(new stepfunctions.Choice(this, 'WasNotifyIBMAppConnectSuccess')
                        .when(stepfunctions.Condition.numberEquals('$.statusCode', 200), new stepfunctions.Succeed(this, 'Success'))
                        .otherwise(jobFailed)))
                .when(stepfunctions.Condition.stringEquals('$.textractJobStatus.JobStatus', 'FAILED'), jobFailed)
                .otherwise(waitForTextractJob));

        // Create an explicit IAM role for Textract
        const textractRole = new iam.Role(this, 'TextractServiceRole', {
            assumedBy: new iam.ServicePrincipal('textract.amazonaws.com'),
            description: 'IAM role for Textract service',
        });
      
        textractRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                's3:GetObject',
                's3:ListBucket'
            ],
            resources: [
                `arn:aws:s3:::${s3Buckets.shrawStagingBucketName}`,
                `arn:aws:s3:::${s3Buckets.shrawStagingBucketName}/*`,
            ],
        }));
      
        textractRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                's3:PutObject'
            ],
            resources: [
                `arn:aws:s3:::${s3Buckets.shtextractOutputBucketName}`,
                `arn:aws:s3:::${s3Buckets.shtextractOutputBucketName}/*`,
            ],
        }));

        // Create an explicit IAM role for the Step Function
        const stepFunctionRole = new iam.Role(this, 'DocumentProcessingRole', {
            assumedBy: new iam.ServicePrincipal('states.amazonaws.com'),
            roleName: `DocumentProcessingRole`,
            description: 'IAM role for Document Processing Workflow Step Function',
        });

        new cdk.CfnOutput(this, 'StepFunctionRoleArn', { value: stepFunctionRole.roleArn });

        // Add necessary permissions to the role
        stepFunctionRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                'textract:StartDocumentTextDetection',
                'textract:GetDocumentTextDetection'
            ],
            resources: ['*'],
        }));
      
        stepFunctionRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                's3:GetObject',
                's3:ListBucket',
                's3:PutObject'
            ],
            resources: [
                `arn:aws:s3:::${s3Buckets.shrawStagingBucketName}`,
                `arn:aws:s3:::${s3Buckets.shrawStagingBucketName}/*`,
                `arn:aws:s3:::${s3Buckets.shtextractOutputBucketName}`,
                `arn:aws:s3:::${s3Buckets.shtextractOutputBucketName}/*`,
                `arn:aws:s3:::${s3Buckets.shlambdaOutputBucketName}`,
                `arn:aws:s3:::${s3Buckets.shlambdaOutputBucketName}/*`,
            ],
        }));

        // Create the state machine
        this.stateMachine = new sfn.StateMachine(this, 'DocumentProcessingWorkflow', {
            definitionBody: sfn.DefinitionBody.fromChainable(definition),
            stateMachineName: 'DocumentProcessingWorkflow',
            role: stepFunctionRole,  
        });
    }
}
