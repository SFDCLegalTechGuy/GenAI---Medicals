import json
import boto3
import os
import time
import asyncio
import aiohttp
from botocore.exceptions import ClientError
from decimal import Decimal
from boto3.dynamodb.conditions import Key
from base64 import b64encode
import requests
from aws_xray_sdk.core import xray_recorder
from aws_xray_sdk.core import patch_all

patch_all()

# Initialize DynamoDB client
dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(os.environ['DOCUMENT_METADATA_TABLE_NAME'])

IBM_APPCONNECT_URL = os.environ['IBM_APPCONNECT_URL']
IBM_APPCONNECT_USERNAME = os.environ['IBM_APPCONNECT_USERNAME']
IBM_APPCONNECT_PASSWORD = os.environ['IBM_APPCONNECT_PASSWORD']


async def update_dynamodb(document_id: str, status: str, completion_time: int, duration: float, error: str = None) -> None:
    """
    Update or insert a document in DynamoDB.

    Args:
        document_id (str): The unique identifier of the document.
        status (str): The current status of the document.
        completion_time (int): The completion time of the document processing.
        duration (float): The duration of the document processing.
        error (str, optional): Any error message if processing failed.

    Raises:
        ClientError: If there's an error updating DynamoDB.
    """
    try:
        # First, query the table to get the latest item for this documentId
        response = table.query(
            KeyConditionExpression=Key('documentId').eq(document_id),
            ScanIndexForward=False,  # This will sort in descending order
            Limit=1  # We only need the most recent item
        )

        items = response.get('Items', [])   
        print(f"Items: {items}")

        if not items:
            # If no item exists, create a new one
            current_timestamp = int(time.time() * 1000)  # Use milliseconds for more precision
            item = {
                'documentId': document_id,
                'timestamp': current_timestamp,
                'status': status,
                'completionTime': completion_time,
                'duration': Decimal(str(duration)) if duration is not None else None
            }
            if error:
                item['error'] = error
            
            table.put_item(Item=item)
        else:
            # If an item exists, update it
            latest_item = items[0]
            update_expression = "SET #status = :status"
            expression_attribute_names = {'#status': 'status'}
            expression_attribute_values = {':status': status}

            if completion_time is not None:
                update_expression += ", completionTime = :completion_time"
                expression_attribute_values[':completion_time'] = completion_time

            if duration is not None:
                update_expression += ", #duration = :duration"
                expression_attribute_names['#duration'] = 'duration'
                expression_attribute_values[':duration'] = Decimal(str(duration))

            if error:
                update_expression += ", #error = :error"
                expression_attribute_names['#error'] = 'error'
                expression_attribute_values[':error'] = error

            table.update_item(
                Key={
                    'documentId': document_id,
                    'timestamp': latest_item['timestamp']
                },
                UpdateExpression=update_expression,
                ExpressionAttributeNames=expression_attribute_names,
                ExpressionAttributeValues=expression_attribute_values
            )

    except Exception as e:
        print(f"Error updating DynamoDB: {str(e)}")
        raise


async def notify_ibm_appconnect(file_info_id, payload):
    print(f"Payload: {payload}")
    async with aiohttp.ClientSession() as session:
        try:
            _url = f"{IBM_APPCONNECT_URL}/Treatment_API/Treatment/{payload['Id']}"
            print(f"IBM_APPCONNECT_URL: {_url}")
            headers = {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'Authorization': f'Basic {b64encode(f"{IBM_APPCONNECT_USERNAME}:{IBM_APPCONNECT_PASSWORD}".encode()).decode()}'
            }
            
            payload_json = json.dumps(payload)
            print(f"Payload JSON: {payload_json}")
            
            async with session.put(_url, data=payload_json, headers=headers) as response:
                response_text = await response.text()
                print(f"IBM AppConnect response: {response_text}")

                if response.status in [200, 201]:
                    response_data = json.loads(response_text)
                    print(f"Successfully notified IBM AppConnect for file {file_info_id}")
                    return response_data  # Return the entire response data
                else:
                    error_message = f"Failed to notify IBM AppConnect. Status: {response.status}, Response: {response_text}"
                    print(error_message)
                    raise Exception(error_message)
        except Exception as e:
            error_message = f"Error notifying IBM AppConnect: {str(e)}"
            print(error_message)
            raise Exception(error_message)


async def process_event(event):
    print(f"Received event: {json.dumps(event, default=str)}")

    document_id = event.get('documentId')
    file_info_id = event.get('fileInfoId')
    extracted_data = event.get('extractedData')

    print(f"Extracted data: {extracted_data}")  

    if not all([document_id, file_info_id, extracted_data]):
        error_message = f"Missing required fields in event. documentId: {document_id}, fileInfoId: {file_info_id}, extractedData: {'present' if extracted_data else 'missing'}"
        print(error_message)
        return {
            'statusCode': 400,
            'body': json.dumps({'error': error_message})
        }

    start_time = time.time()
    status = 'COMPLETED'
    error = None

    try:
        payload = construct_appconnect_payload(extracted_data, file_info_id, document_id)
        print(f"Payload: {payload}")

        app_connect_response = await notify_ibm_appconnect(file_info_id, payload)
        print(f"AppConnect Response: {app_connect_response}")

        completion_time = int(time.time() * 1000)
        duration = (completion_time - int(start_time * 1000)) / 1000.0
        await update_dynamodb(document_id, status, completion_time, duration)

        return {
            'statusCode': 200,
            'body': json.dumps({
                'message': 'Processing completed successfully',
                'status': status,
                'appConnectResponse': app_connect_response  # Include the full response
            })
        }

    except Exception as e:
        status = 'ERROR'
        error = str(e)
        completion_time = int(time.time() * 1000)
        duration = (completion_time - int(start_time * 1000)) / 1000.0
        await update_dynamodb(document_id, status, completion_time, duration, error)

        return {
            'statusCode': 500,
            'body': json.dumps({'message': 'Processing failed', 'status': status, 'error': error})
        }


def construct_appconnect_payload(extracted_data, file_info_id, document_id):
    # Here is the payload IBM AppConnect expects:
    # {
    # "File_Info_Id__c": "sample_file_info_id__c",
    # "Impression__c": "sample_impression__c",
    # "Positive_Finding__c": true,
    # "Number_of_Visits__c": 1234567,
    # "Number_of_Fractures__c": 1234567,
    # "of_Bulges__c": 1234567,
    # "of_Herniations__c": 1234567,
    # "of_Other_Positive_Findings__c": 1234567,
    # "of_Tears__c": 1234567,
    # "Radiculopathy__c": true,
    # "keys": "sample_keys",
    # "History__c": "sample_history__c",
    # "Chief_Complaints__c": "sample_chief_complaints__c",
    # "Exam_Findings__c": "sample_exam_findings__c",
    # "Recommendations__c": "sample_recommendations__c",
    # "Pre_Op_Diagnosis__c": "sample_pre_op_diagnosis__c",
    # "Post_Op_Diagnosis__c": "sample_post_op_diagnosis__c",
    # "Procedure_Performed__c": "sample_procedure_performed__c",
    # "Surgery_Recommended__c": true,
    # "Injections_Recommended__c": true
    # "Document_Extraction_Status__c": "Document Processing Complete"
    # }
    def bool_or_str_to_bool(value):
        if isinstance(value, bool):
            return value
        return str(value).lower() == 'true' if value is not None else False

    return {
        'File_Info_Id__c': file_info_id,
        'Impression__c': extracted_data.get('impression'),
        'Positive_Finding__c': bool_or_str_to_bool(extracted_data.get('positiveFindings')),
        'Number_of_Visits__c': extracted_data.get('numberOfVisits'),
        'Number_of_Fractures__c': extracted_data.get('numberofFractures'),
        'of_Bulges__c': extracted_data.get('numberofBulges'),
        'of_Herniations__c': extracted_data.get('numberofHerniations'),
        'of_Other_Positive_Findings__c': extracted_data.get('numberOfOtherPositiveFindings'),
        'of_Tears__c': extracted_data.get('numberofTears'),
        'Radiculopathy__c': bool_or_str_to_bool(extracted_data.get('radiculopathy')),
        'Id': document_id,
        "History__c": extracted_data.get('history'),
        "Chief_Complaints__c": extracted_data.get('chiefComplaints'),
        "Exam_Findings__c": extracted_data.get('examFindings'),
        "Recommendations__c": extracted_data.get('recommendations'),
        "Pre_Op_Diagnosis__c": extracted_data.get('preOpDiagnosis'),
        "Post_Op_Diagnosis__c": extracted_data.get('postOpDiagnosis'),
        "Procedure_Performed__c": extracted_data.get('procedurePerformed'),
        "Surgery_Recommended__c": bool_or_str_to_bool(extracted_data.get('surgeryRecommended')),
        "Injections_Recommended__c": bool_or_str_to_bool(extracted_data.get('injectionsRecommended')),
        "Document_Extraction_Status__c": "Document Processing Complete"
    }


@xray_recorder.capture('lambda_handler')
def lambda_handler(event, context):
    try:
        result = asyncio.run(process_event(event))
        return result
    except Exception as e:
        print(f"Error in lambda_handler: {str(e)}")
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)})
        }