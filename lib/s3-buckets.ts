import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export class S3BucketsConstruct extends Construct {
    public readonly shrawStagingBucketName: string;
    public readonly shtextractOutputBucketName: string;
    public readonly shlambdaOutputBucketName: string;

    public readonly shrawStagingBucketArn: string;
    public readonly shtextractOutputBucketArn: string;
    public readonly shlambdaOutputBucketArn: string;

    constructor(scope: Construct, id: string) {
        super(scope, id);

        // Get bucket names from environment variables
        this.shrawStagingBucketName = process.env.RAW_STAGING_BUCKET_NAME!;
        this.shtextractOutputBucketName = process.env.TEXTRACT_OUTPUT_BUCKET_NAME!;
        this.shlambdaOutputBucketName = process.env.LAMBDA_OUTPUT_BUCKET_NAME!;

        // Create the docrio-raw-staging bucket
        const shrawStagingBucket = new s3.Bucket(this, 'sh-Docrio-Raw-Staging', {
            bucketName: this.shrawStagingBucketName,
            versioned: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
            lifecycleRules: [
                {
                    enabled: true,
                    transitions: [
                        {
                            storageClass: s3.StorageClass.INTELLIGENT_TIERING,
                            transitionAfter: cdk.Duration.days(30),
                        },
                    ],
                },
            ],
        });

        //Give Textract Access to the raw staging bucket
        shrawStagingBucket.addToResourcePolicy(new iam.PolicyStatement({
            actions: ['s3:GetObject'],
            resources: [shrawStagingBucket.bucketArn + '/*'],
            principals: [new iam.ServicePrincipal('textract.amazonaws.com')],
        }));

        // Create the textract-output bucket
        const shtextractOutputBucket = new s3.Bucket(this, 'sh-Textract-Output', {
            bucketName: this.shtextractOutputBucketName,
            versioned: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
            lifecycleRules: [
                {
                    enabled: true,
                    transitions: [
                        {
                            storageClass: s3.StorageClass.INTELLIGENT_TIERING,
                            transitionAfter: cdk.Duration.days(30),
                        },
                    ],
                },
            ],
        });
              
        
        // Create Lambda Output bucket
        const shlambdaOutputBucket = new s3.Bucket(this, 'sh-Lambda-Output', {
            bucketName: this.shlambdaOutputBucketName,
            versioned: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
            lifecycleRules: [
                {
                    enabled: true,
                    transitions: [
                        {
                            storageClass: s3.StorageClass.INTELLIGENT_TIERING,
                            transitionAfter: cdk.Duration.days(30),
                        },
                    ],
                },
            ],
        });

        // Create a role for the Lambda functions
        const lambdaRole = new iam.Role(this, 'DocrioLambdaRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        });

        // Grant permissions to the Lambda role for both buckets
        shrawStagingBucket.grantReadWrite(lambdaRole);
        shrawStagingBucket.grantPutAcl(lambdaRole);
        shtextractOutputBucket.grantReadWrite(lambdaRole);
        shtextractOutputBucket.grantPutAcl(lambdaRole);
        shlambdaOutputBucket.grantReadWrite(lambdaRole);
        shlambdaOutputBucket.grantPutAcl(lambdaRole);

        // Add Glue/Hive partitioning
        const addPartitioningToPolicy = (bucket: s3.Bucket) => {
            bucket.addToResourcePolicy(new iam.PolicyStatement({
                actions: ['s3:PutObject'],
                resources: [bucket.arnForObjects('YEAR=*/MONTH=*/DAY=*/*')],
                principals: [lambdaRole],
            }));
        };

        addPartitioningToPolicy(shrawStagingBucket);
        addPartitioningToPolicy(shtextractOutputBucket);
        addPartitioningToPolicy(shlambdaOutputBucket);

        // Output the bucket names
        new cdk.CfnOutput(this, 'RawStagingBucketName', {
            value: shrawStagingBucket.bucketName,
            description: 'The name of the raw staging bucket',
        });

        new cdk.CfnOutput(this, 'textractOutputBucketName', {
            value: shtextractOutputBucket.bucketName,
            description: 'The name of the Textract output bucket',
        });

        new cdk.CfnOutput(this, 'LambdaOutputBucketName', {
            value: shlambdaOutputBucket.bucketName,
            description: 'The name of the Lambda output bucket',
        });

        //Output the bucket ARNs
        new cdk.CfnOutput(this, 'RawStagingBucketArn', {
            value: shrawStagingBucket.bucketArn,
            description: 'The ARN of the raw staging bucket',
        });

        new cdk.CfnOutput(this, 'textractOutputBucketArn', {
            value: shtextractOutputBucket.bucketArn,
            description: 'The ARN of the Textract output bucket',
        });

        new cdk.CfnOutput(this, 'LambdaOutputBucketArn', {
            value: shlambdaOutputBucket.bucketArn,
            description: 'The ARN of the Lambda output bucket',
        });

        // Set the bucket ARN Variables
        this.shrawStagingBucketArn = shrawStagingBucket.bucketArn;
        this.shtextractOutputBucketArn = shtextractOutputBucket.bucketArn;
        this.shlambdaOutputBucketArn = shlambdaOutputBucket.bucketArn;
    }
}

