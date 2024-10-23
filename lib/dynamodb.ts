import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import * as backup from 'aws-cdk-lib/aws-backup';

export class DynamoDBConstruct extends Construct {
    public readonly documentMetadataTable: dynamodb.TableV2;
    public readonly documentSoapTable: dynamodb.TableV2;

    constructor(scope: Construct, id: string) {
        super(scope, id);

        // Get the table names from environment variables
        const metadataTableName = process.env.DOCUMENT_METADATA_TABLE_NAME || 'sh-metadata-table';
        const soapTableName = process.env.DOCUMENT_SOAP_TABLE_NAME || 'sh-soap-table';

        // Create the DynamoDB tables with custom resource policies
        this.documentMetadataTable = new dynamodb.TableV2(this, 'sh-Document-Metadata-Table', {
            tableName: metadataTableName,
            partitionKey: { name: 'documentId', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'timestamp', type: dynamodb.AttributeType.NUMBER },
            billing: dynamodb.Billing.onDemand({
                maxReadRequestUnits: 100,
                maxWriteRequestUnits: 115,
            }),
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            pointInTimeRecovery: true,
            timeToLiveAttribute: 'ttl',
        });

        this.documentSoapTable = new dynamodb.TableV2(this, 'sh-Document-Soap-Table', {
            tableName: soapTableName,
            partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'timestamp', type: dynamodb.AttributeType.NUMBER },
            billing: dynamodb.Billing.onDemand({
                maxReadRequestUnits: 100,
                maxWriteRequestUnits: 115,
            }),
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            pointInTimeRecovery: true,
            timeToLiveAttribute: 'ttl',
        });

        // Add attributes for the new fields
        this.documentSoapTable.addLocalSecondaryIndex({
            indexName: 'FileInfoIdIndex',
            sortKey: { name: 'file_info_id', type: dynamodb.AttributeType.STRING },
        });

        // Update the existing GSI for document_type
        this.documentSoapTable.addGlobalSecondaryIndex({
            indexName: 'DocumentTypeIndex',
            partitionKey: { name: 'document_type', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'timestamp', type: dynamodb.AttributeType.NUMBER },
        });

        // Backup policy for the soap table (Daily at midnight)
        const soapBackupPlan = new backup.BackupPlan(this, 'sh-Soap-Table-BackupPlan', {
            backupPlanName: 'DocSoapTableBackupPlan',
        });
        soapBackupPlan.addSelection('Selection', {
            resources: [
                backup.BackupResource.fromDynamoDbTable(this.documentSoapTable),
            ],
        });
        soapBackupPlan.addRule(new backup.BackupPlanRule({
            ruleName: 'DailyBackup',
            scheduleExpression: cdk.aws_events.Schedule.cron({ minute: '0', hour: '0' }), 
            deleteAfter: cdk.Duration.days(7),
        }));


        // Backup Policy for the table (Daily at midnight)
        const backupPlan = new backup.BackupPlan(this, 'sh-Metadata-Table-BackupPlan', {
            backupPlanName: 'DocMetadataTableBackupPlan',
        });
        backupPlan.addSelection('Selection', {
            resources: [
                backup.BackupResource.fromDynamoDbTable(this.documentMetadataTable),
            ],
        });
        backupPlan.addRule(new backup.BackupPlanRule({
            ruleName: 'DailyBackup',
            scheduleExpression: cdk.aws_events.Schedule.cron({ minute: '0', hour: '0' }), 
            deleteAfter: cdk.Duration.days(7),
        }));

        // Add GSI for efficient querying by document type
        this.documentMetadataTable.addGlobalSecondaryIndex({
            indexName: 'DocumentTypeIndex',
            partitionKey: { name: 'documentType', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'timestamp', type: dynamodb.AttributeType.NUMBER },
        });


        // Output the table name
        new cdk.CfnOutput(this, 'DocumentMetadataTableName', {
            value: this.documentMetadataTable.tableName,
            description: 'Metadata DynamoDB Table Name',
        });

        new cdk.CfnOutput(this, 'DocumentSoapTableName', {
            value: this.documentSoapTable.tableName,
            description: 'SOAP DynamoDB Table Name',
        });
    }
}
