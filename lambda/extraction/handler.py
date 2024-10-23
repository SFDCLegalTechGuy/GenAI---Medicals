import os
import json
import boto3
import aiohttp
from botocore.exceptions import ClientError
from typing import Dict, Any
from base64 import b64encode
from aws_xray_sdk.core import xray_recorder
from aws_xray_sdk.core import patch_all
import asyncio

patch_all()

# Constants
RAW_STAGING_BUCKET_NAME = os.environ["RAW_STAGING_BUCKET_NAME"]
DOC_RIO_API_URL = os.environ["DOC_RIO_API_URL"]
DOC_RIO_AUTH_URL = os.environ["DOC_RIO_AUTH_URL"]
DOC_RIO_CLIENT_ID = os.environ["DOC_RIO_CLIENT_ID"]
DOC_RIO_CLIENT_SECRET = os.environ["DOC_RIO_CLIENT_SECRET"]

IBM_APPCONNECT_URL = os.environ['IBM_APPCONNECT_URL']
IBM_APPCONNECT_USERNAME = os.environ['IBM_APPCONNECT_USERNAME']
IBM_APPCONNECT_PASSWORD = os.environ['IBM_APPCONNECT_PASSWORD']

s3_client = boto3.client("s3")

async def update_salesforce_status(file_info_id: str, document_id: str, status: str) -> Dict[str, Any]:
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
                    return response_data
                else:
                    error_message = f"Failed to notify IBM AppConnect. Status: {response.status}, Response: {response_text}"
                    print(error_message)
                    raise Exception(error_message)
        except Exception as e:
            error_message = f"Error notifying IBM AppConnect: {str(e)}"
            print(error_message)
            raise

async def get_bearer_token() -> str:
    """
    Retrieve a new bearer token using basic authorization.
    
    Returns:
        str: The bearer token.
    
    Raises:
        aiohttp.ClientError: If the token retrieval fails.
    """
    headers = {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': f'Basic {b64encode(f"{DOC_RIO_CLIENT_ID}:{DOC_RIO_CLIENT_SECRET}".encode()).decode()}'
    }
    data = {
        'grant_type': 'client_credentials'
    }
    print(f"Authorization Header: {headers}") # TODO: Remove this
    
    async with aiohttp.ClientSession() as session:
        async with session.post(DOC_RIO_AUTH_URL, headers=headers, data=data) as response:
            response.raise_for_status()
            response_json = await response.json()
            return response_json['access_token']

@xray_recorder.capture('lambda_handler')
def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    return asyncio.get_event_loop().run_until_complete(async_lambda_handler(event, context))

async def async_lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    Asynchronous Lambda handler to download a file from SignedUrlV2 and upload it to RAW_STAGING_BUCKET.
    
    Args:
        event (Dict[str, Any]): The event dict containing the input parameters.
        context (Any): The context object provided by AWS Lambda.
    
    Returns:
        Dict[str, Any]: A dictionary containing the status code, response message,
                        and the original payload for the next step.
    """
    print(f"Received event: {json.dumps(event, default=str)}")
    
    try:
            
        # Extract fileInfoId and other details from the event
        start_workflow_task = event.get('startWorkflowTask', {})
        file_info_id = start_workflow_task.get('fileInfoId')
        document_id = start_workflow_task.get('documentId')
        document_type = start_workflow_task.get('documentType')
        
        if not file_info_id:
            raise ValueError("fileInfoId not found in the event payload")

        if not all([document_id, file_info_id, document_type]):
            error_message = f"Missing required fields in event. documentId: {document_id}, fileInfoId: {file_info_id}, documentType: {document_type}"
            print(error_message)
            return {
                'statusCode': 400,
                'body': json.dumps({'error': error_message})
            }
            
        await update_salesforce_status(file_info_id, document_id, "Retrieving Document from Docrio")


        # Get a new bearer token
        bearer_token = await get_bearer_token()
        
        # Make API request to get SignedUrlV2
        headers = {
            'accept': 'application/json',
            'Authorization': f'Bearer {bearer_token}'
        }
        params = {'Id': file_info_id}
        async with aiohttp.ClientSession() as session:
            async with session.get(DOC_RIO_API_URL, headers=headers, params=params) as response:
                response.raise_for_status()
                response_json = await response.json()
        
        # Extract SignedUrlV2
        signed_url = response_json['Records'][0]['SignedUrlV2']

        # Download file from SignedUrlV2
        async with aiohttp.ClientSession() as session:
            async with session.get(signed_url) as file_response:
                file_response.raise_for_status()
                file_content = await file_response.read()
        
        # Upload file to RAW_STAGING_BUCKET
        file_name = f"{file_info_id}.pdf"  # Assuming it's a PDF
        await asyncio.get_event_loop().run_in_executor(
            None,
            lambda: s3_client.put_object(
                Bucket=RAW_STAGING_BUCKET_NAME,
                Key=file_name,
                Body=file_content
            )
        )
        
        print(f"Success: File {file_name} uploaded to {RAW_STAGING_BUCKET_NAME}")
        
        await update_salesforce_status(file_info_id, document_id, "Extracting Content from Document")
        
        # Prepare the response with the original payload for the next step
        return {
            "statusCode": 200,
            "body": {
                "documentId": start_workflow_task.get('documentId'),
                "fileInfoId": file_info_id,
                "file_name": file_name,
                "bucket_name": RAW_STAGING_BUCKET_NAME,
                "documentType": document_type
            }
        }
    
    except (aiohttp.ClientError, ClientError, ValueError) as e:
        print(f"Error: {str(e)}")
        return {
            "statusCode": 500,
            "body": json.dumps({"message": f"Error: {str(e)}"})
        }
