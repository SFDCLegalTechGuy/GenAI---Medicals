import json
import boto3
import os
import xml.etree.ElementTree as ET
from typing import Dict, Any
import time
import aiohttp
from base64 import b64encode
from aws_xray_sdk.core import xray_recorder
from aws_xray_sdk.core import patch_all
import asyncio
import logging
import backoff
from datetime import timezone, datetime

patch_all()

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize AWS clients
stepfunctions_client = boto3.client("stepfunctions")
dynamodb = boto3.resource("dynamodb")

# Constants
REQUIRED_FIELDS = {'SessionId', 'OrganizationId', 'sf:Id', 'sf:File_Info_Id__c', 'sf:Record_Type_Name__c'}
DYNAMODB_TABLE_NAME = os.environ['DOCUMENT_SOAP_TABLE_NAME']
STATE_MACHINE_ARN = os.environ['STATE_MACHINE_ARN']

IBM_APPCONNECT_URL = os.environ['IBM_APPCONNECT_URL']
IBM_APPCONNECT_USERNAME = os.environ['IBM_APPCONNECT_USERNAME']
IBM_APPCONNECT_PASSWORD = os.environ['IBM_APPCONNECT_PASSWORD']

SNS_TOPIC_ARN = os.environ['SNS_TOPIC_ARN']

@backoff.on_exception(backoff.expo, 
                      (aiohttp.ClientError, asyncio.TimeoutError),
                      max_tries=5)
async def update_salesforce_status(file_info_id, document_id, status):
    """
    Update the Salesforce status for a given fileInfoId and documentId.
    """
    
    payload = {
        "Id": document_id,
        "File_Info_Id__c": file_info_id,
        "Document_Extraction_Status__c": status
    }
    
    async with aiohttp.ClientSession() as session:
        try:
            _url = f"{IBM_APPCONNECT_URL}/Treatment_API/Treatment/{payload['Id']}"
            logger.info(f"IBM_APPCONNECT_URL: {_url}")
            headers = {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'Authorization': f'Basic {b64encode(f"{IBM_APPCONNECT_USERNAME}:{IBM_APPCONNECT_PASSWORD}".encode()).decode()}'
            }
            
            payload_json = json.dumps(payload)
            logger.debug(f"Payload JSON: {payload_json}")
            
            async with session.put(_url, data=payload_json, headers=headers) as response:
                response_text = await response.text()
                logger.info(f"IBM AppConnect response: {response_text}")

                if response.status in [200, 201]:
                    response_data = json.loads(response_text)
                    logger.info(f"Successfully notified IBM AppConnect for file {file_info_id}")
                    return response_data  # Return the entire response data
                else:
                    error_message = f"Failed to notify IBM AppConnect. Status: {response.status}, Response: {response_text}"
                    logger.error(error_message)
                    raise Exception(error_message)
        except Exception as e:
            error_message = f"Error notifying IBM AppConnect: {str(e)}"
            logger.error(error_message)
            raise

async def async_lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    logger.info(f"Received event: {json.dumps(event, default=str)}")
    
    try:
        # Step 1: Extract and validate SOAP message
        soap_message = event.get('body', '')
        logger.debug(f"SOAP message: {soap_message}")
        try:
            extracted_data = extract_soap_data(soap_message)
        except ET.ParseError as parse_error:
            if "no element found" in str(parse_error):
                logger.warning(f"Ignoring 'no element found' error: {str(parse_error)}")
                return create_response(200, is_soap=True)
            else:
                raise  # Re-raise the exception if it's not the specific error we're looking for

        if not all(field in extracted_data for field in REQUIRED_FIELDS):
            return create_response(400, is_soap=True)

        document_type = extracted_data['sf:Record_Type_Name__c']
        document_id = extracted_data['sf:Id']
        file_info_id = extracted_data['sf:File_Info_Id__c']
        
        # Validate required fields
        if not all([document_id, file_info_id]):
            error_message = f"Missing required fields in event. documentId: {document_id}, fileInfoId: {file_info_id}"
            logger.error(error_message)
            send_sns_notification("Missing Required Fields", error_message)
            return create_response(400, is_soap=True)

        # Update Salesforce status
        try:
            await update_salesforce_status(file_info_id, document_id, "Starting Document Process Workflow")
        except Exception as e:
            error_message = f"Failed to update Salesforce status: {str(e)}"
            logger.error(error_message)
            send_sns_notification("Salesforce Update Error", error_message)
            return create_response(500, is_soap=True)

        # Step 2: Prepare Step Function input
        step_function_input = {
            "startWorkflowTask": {
                "documentId": document_id,
                "fileInfoId": file_info_id,
                "documentType": document_type
            }
        }
        logger.debug(f"step_function_input: {step_function_input}")

        # Step 3: Start Step Function execution
        state_machine_arn = STATE_MACHINE_ARN
        response = stepfunctions_client.start_execution(
            stateMachineArn=state_machine_arn,
            input=json.dumps(step_function_input)
        )

        # Step 4: Write record to DynamoDB
        write_to_dynamodb(extracted_data, soap_message)
        
        await update_salesforce_status(file_info_id, document_id, "Started Document Process Workflow")

        return create_response(200, is_soap=True)
    except Exception as e:
        error_message = f"Uncaught exception in StartWorkflow Lambda: {str(e)}"
        logger.error(error_message)
        send_sns_notification("Uncaught Exception in StartWorkflow Lambda", error_message, event)
        send_to_dlq(event)  # Send the failed event to the Dead Letter Queue
        return create_response(500, is_soap=True)

@xray_recorder.capture('lambda_handler')
def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    loop = asyncio.get_event_loop()
    return loop.run_until_complete(async_lambda_handler(event, context))

def extract_soap_data(soap_message: str) -> Dict[str, str]:
    """
    Extract relevant data from SOAP message.
    """
    root = ET.fromstring(soap_message)
    namespaces = {
        'soapenv': 'http://schemas.xmlsoap.org/soap/envelope/',
        'ns': 'http://soap.sforce.com/2005/09/outbound',
        'sf': 'urn:sobject.enterprise.soap.sforce.com'
    }

    data = {}
    for field in REQUIRED_FIELDS:
        if field.startswith('sf:'):
            xpath = f'.//ns:sObject/sf:{field.split(":")[-1]}'
        else:
            xpath = f'.//ns:{field}'
        
        element = root.find(xpath, namespaces)
        if element is not None:
            data[field] = element.text

    return data

def write_to_dynamodb(extracted_data: Dict[str, str], soap_message: str) -> None:
    """
    Write extracted data and SOAP message to DynamoDB.
    """
    table = dynamodb.Table(DYNAMODB_TABLE_NAME)
    current_timestamp = int(time.time() * 1000)  # Current time in milliseconds
    
    table.put_item(Item={
        'id': extracted_data['sf:Id'],
        'timestamp': current_timestamp,
        'file_info_id': extracted_data['sf:File_Info_Id__c'],
        'document_type': extracted_data['sf:Record_Type_Name__c'],
        'extracted_data': extracted_data,
        'soap_message': soap_message
    })

def create_response(status_code: int, is_soap: bool = False, body: Any = None) -> Dict[str, Any]:
    """
    Create a standardized API response, with an option for SOAP responses.
    """
    if is_soap:
        soap_response = f"""
        <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
            <soap:Body>
                <notificationsResponse xmlns:ns2="urn:sobject.enterprise.soap.sforce.com" xmlns="http://soap.sforce.com/2005/09/outbound">
                    <Ack>true</Ack>
                </notificationsResponse>
            </soap:Body>
        </soap:Envelope>
        """
        return {
            "statusCode": status_code,
            "body": soap_response,
            "headers": {"Content-Type": "text/xml"},
        }
    else:
        return {
            "statusCode": status_code,
            "body": json.dumps(body) if body else "",
            "headers": {"Content-Type": "application/json"},
        }

def send_sns_notification(subject: str, message: str, event: Dict[str, Any] = None):
    sns_client = boto3.client('sns')
    try:
        error_details = {
            "subject": subject,
            "message": message,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "function_name": os.environ.get('AWS_LAMBDA_FUNCTION_NAME'),
            "request_id": os.environ.get('AWS_REQUEST_ID'),
        }
        if event:
            # Include non-sensitive event data
            error_details["event"] = {k: v for k, v in event.items() if k not in ['body']}  # Exclude potentially sensitive data
        
        sns_client.publish(
            TopicArn=SNS_TOPIC_ARN,
            Subject=subject,
            Message=json.dumps(error_details, default=str)  # Use default=str to handle datetime serialization
        )
        logger.info(f"SNS notification sent: {subject}")
    except Exception as e:
        logger.error(f"Failed to send SNS notification: {str(e)}")

def send_to_dlq(message: Dict[str, Any]):
    sqs_client = boto3.client('sqs')
    try:
        sqs_client.send_message(
            QueueUrl=os.environ['DLQ_URL'],
            MessageBody=json.dumps(message)
        )
        logger.info(f"Message sent to DLQ: {message}")
    except Exception as e:
        logger.error(f"Failed to send message to DLQ: {str(e)}")
