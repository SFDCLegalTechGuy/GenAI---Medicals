import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as fs from 'fs';
import * as path from 'path';

export interface ApiGatewayProps {
    startWorkflowLambda: lambda.Function;
}

export class ApiGatewayConstruct extends Construct {
    public readonly api: apigateway.RestApi;

    constructor(scope: Construct, id: string, props: ApiGatewayProps) {
        super(scope, id);

        const logGroup = new logs.LogGroup(this, 'ApiGatewayLogs', {
            logGroupName: '/aws/apigateway/SHApiGateway',
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const apiGatewayRole = new iam.Role(this, 'ApiGatewayRole', {
            assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
            description: 'Role for API Gateway to access CloudWatch Logs',
        });

        apiGatewayRole.addManagedPolicy(
            iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonAPIGatewayPushToCloudWatchLogs')
        );

        new apigateway.CfnAccount(this, 'ApiGatewayAccount', {
            cloudWatchRoleArn: apiGatewayRole.roleArn,
        });

        let apiSpec = fs.readFileSync(path.join(__dirname, 'api', 'spec.yaml'), 'utf8');
        apiSpec = apiSpec.replace('${arn:aws:lambda:us-east-1:026090522987:function:shulmanStack-LambdasStartWorkflowLambdaE23F8DD3-9cPtClV2HT0T}', props.startWorkflowLambda.functionArn);

        this.api = new apigateway.RestApi(this, 'SHApiGateway', {
            restApiName: 'SH API Gateway',
            description: 'API Gateway for Shulman & Hill project',
            deployOptions: {
                stageName: 'prod',
                metricsEnabled: true,
                loggingLevel: apigateway.MethodLoggingLevel.INFO,
                dataTraceEnabled: true,
                tracingEnabled: true,
                accessLogDestination: new apigateway.LogGroupLogDestination(logGroup),
                accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
            },
            defaultCorsPreflightOptions: {
                allowOrigins: apigateway.Cors.ALL_ORIGINS,
                allowMethods: apigateway.Cors.ALL_METHODS,
            },
            apiKeySourceType: apigateway.ApiKeySourceType.HEADER,
        });

        const processDocument = this.api.root.addResource('process-document');
        processDocument.addMethod('POST', new apigateway.LambdaIntegration(props.startWorkflowLambda, {
            proxy: true,
        }), {
            apiKeyRequired: false,
        });

        // Not needed, we are verifying the Salesforce SessionId in the API Gateway stage settings
        // const apiKey = new apigateway.ApiKey(this, 'ApiKey', {
        //     enabled: true,
        // });

        const plan = this.api.addUsagePlan('UsagePlan', {
            name: 'Standard',
            throttle: {
                rateLimit: 10,
                burstLimit: 2,
            },
            quota: {
                limit: 1000,
                period: apigateway.Period.MONTH
            }
        });

        // plan.addApiKey(apiKey);
        // plan.addApiStage({
        //     stage: this.api.deploymentStage,
        // });

        props.startWorkflowLambda.grantInvoke(new iam.ServicePrincipal('apigateway.amazonaws.com'));

        // new cdk.CfnOutput(this, 'ApiKeyValue', {
        //     value: apiKey.keyId,
        //     description: 'API Key ID (use this to retrieve the actual key value)',
        // });

        new cdk.CfnOutput(this, 'ApiUrl', {
            value: this.api.url,
            description: 'API Gateway URL',
        });
    }
}