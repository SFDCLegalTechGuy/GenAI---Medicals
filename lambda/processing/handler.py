import os
import boto3
import json
import logging
from botocore.exceptions import ClientError
from typing import List, Dict, Any
from datetime import datetime
import time
import aiohttp
from base64 import b64encode
from aws_xray_sdk.core import xray_recorder
from aws_xray_sdk.core import patch_all
import asyncio

patch_all()

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Check for required environment variables
REQUIRED_ENV_VARS = [
    'DOCUMENT_METADATA_TABLE_NAME',
    'BEDROCK_MODEL_ID',
    'LAMBDA_OUTPUT_BUCKET_NAME',
    'IBM_APPCONNECT_URL'
]
missing_vars = [var for var in REQUIRED_ENV_VARS if not os.environ.get(var)]
if missing_vars:
    raise EnvironmentError(f"Missing required environment variables: {', '.join(missing_vars)}")

# Initialize AWS clients
s3_client = boto3.client('s3')
dynamodb = boto3.resource('dynamodb')
textract_client = boto3.client('textract')
bedrock_runtime = boto3.client('bedrock-runtime')

# Get environment variables
table = dynamodb.Table(os.environ['DOCUMENT_METADATA_TABLE_NAME'])
BEDROCK_MODEL_ID = os.environ['BEDROCK_MODEL_ID']
LAMBDA_OUTPUT_BUCKET_NAME = os.environ['LAMBDA_OUTPUT_BUCKET_NAME']

IBM_APPCONNECT_URL = os.environ['IBM_APPCONNECT_URL']
IBM_APPCONNECT_USERNAME = os.environ['IBM_APPCONNECT_USERNAME']
IBM_APPCONNECT_PASSWORD = os.environ['IBM_APPCONNECT_PASSWORD']

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
            logger.info(f"Payload JSON: {payload_json}")
            
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

async def async_lambda_handler(event, context):
    logger.info(f"Received event: {json.dumps(event, default=str)}")
    
    try:
        processing_result = event['processingResult']
        bucket_name = processing_result['bucket_name']
        key = processing_result['file_name']
        document_type = processing_result['documentType']
        document_id = processing_result['documentId']
        file_info_id = processing_result['fileInfoId']

        if not all([bucket_name, key, document_type, document_id, file_info_id]):
            error_message = f"Missing required fields in event. documentId: {document_id}, fileInfoId: {file_info_id}"
            logger.error(error_message)
            return {
                'statusCode': 400,
                'body': json.dumps({'error': error_message})
            }
        
        await update_salesforce_status(file_info_id, document_id, "Processing Extracted Document Content")
            
        logger.info(f"Validated input: bucket={bucket_name}, key={key}, type={document_type}")

        job_id = start_textract_job(bucket_name, key)
        if not job_id:
            raise ValueError("Failed to start Textract job")
        logger.info(f"Started Textract job: {job_id}")

        job_status = await wait_for_job_completion(job_id)
        logger.info(f"Textract job completed with status: {job_status}")
        if job_status != 'SUCCEEDED':
            raise ValueError(f"Textract job failed or timed out. Final status: {job_status}")

        textract_results = await get_textract_results(job_id)
        combined_text = combine_textract_results(textract_results)
        organized_data = await process_data_with_claude(combined_text, key, document_type)

        logger.info(f"Organized data: {organized_data}")

        output_key = f"{key}-organized-analysis.json"
        save_to_s3(organized_data, output_key)
        await update_dynamodb(key, organized_data)
        
        return create_success_response(output_key, organized_data, document_id, file_info_id)

    except Exception as e:
        logger.error(f"Error in lambda_handler: {str(e)}", exc_info=True)
        return create_error_response(e)

@xray_recorder.capture('lambda_handler')
def lambda_handler(event, context):
    loop = asyncio.get_event_loop()
    return loop.run_until_complete(async_lambda_handler(event, context))

def start_textract_job(bucket_name: str, key: str) -> str:
    response = textract_client.start_document_text_detection(
        DocumentLocation={
            'S3Object': {
                'Bucket': bucket_name,
                'Name': key
            }
        },
        OutputConfig={
            'S3Bucket': LAMBDA_OUTPUT_BUCKET_NAME,
            'S3Prefix': f'textract-output/{key}'
        },
        JobTag='DocumentProcessingJob'
    )
    return response['JobId']

def save_to_s3(data: Dict[str, Any], output_key: str) -> None:
    s3_client.put_object(
        Bucket=LAMBDA_OUTPUT_BUCKET_NAME,
        Key=output_key,
        Body=json.dumps(data),
        ContentType="application/json"
    )

def create_success_response(output_key: str, organized_data: Dict[str, Any], 
                            document_id: str, file_info_id: str) -> Dict[str, Any]:
    return {
        'statusCode': 200,
        'body': json.dumps({'message': 'Medical document processed successfully'}),
        'outputS3BucketName': LAMBDA_OUTPUT_BUCKET_NAME,
        'outputS3Key': output_key,
        'extractedData': organized_data['extractedData'],
        'documentType': organized_data['documentType'],
        'sourceKey': organized_data['sourceKey'],
        'processingTimestamp': organized_data['processingTimestamp'],
        'documentId': document_id,
        'fileInfoId': file_info_id
    }

def create_error_response(error: Exception) -> Dict[str, Any]:
    return {
        'statusCode': 500,
        'body': json.dumps({
            'error': str(error),
            'details': f"Error type: {type(error).__name__}, Error message: {str(error)}"
        })
    }

async def wait_for_job_completion(job_id: str, max_attempts: int = 60) -> str:
    for _ in range(max_attempts):
        response = textract_client.get_document_text_detection(JobId=job_id)
        status = response['JobStatus']
        
        if status in ['SUCCEEDED', 'FAILED']:
            return status
        
        await asyncio.sleep(5)
    
    return 'TIMED_OUT'

async def get_textract_results(job_id: str) -> List[Dict[str, Any]]:
    pages = []
    next_token = None

    while True:
        try:
            if next_token:
                response = textract_client.get_document_text_detection(JobId=job_id, NextToken=next_token)
            else:
                response = textract_client.get_document_text_detection(JobId=job_id)

            pages.extend(response.get('Blocks', []))
            logger.info(f"Retrieved {len(response.get('Blocks', []))} blocks from Textract")

            next_token = response.get('NextToken')
            if not next_token:
                break
        except ClientError as e:
            logger.error(f"Error calling Textract API: {str(e)}")
            raise

    return pages

def combine_textract_results(textract_results: List[Dict[str, Any]]) -> str:
    combined_text = []
    for block in textract_results:
        if block.get('BlockType') == 'LINE':
            text = block.get('Text')
            if text is not None:
                combined_text.append(text)
    return "\n".join(combined_text)

async def process_data_with_claude(combined_text: str, src_key: str, document_type: str) -> Dict[str, Any]:
    system_prompt = """You are a medical document processor trained in extracting information from medical documents. Use the provided Textract OCR results to extract the data accurately and concisely."""

    document_prompts = {
            "PT/Chiro": """Extract the following information:
- history: The patients account of what they verbally told the provider. Reason for visit, history of present illness, cause of injury (Limit to 1-2 sentences). If they are bulleted or numbered, please keep them numbered in the response. (e.g "history": ["1. He is complaining of low back pain. ", "2. He is also complaining of neck pain."]) {"value": array of strings}
- chiefComplaints: What the client complained about in regards to their injury (Limit to 1-2 sentences). If they are bulleted or numbered, please keep them numbered in the response. {"value": string}
- numberOfVisits: Total count of visits to the provider. {"value": number}
- impression: The provider's diagnosis and interpretation of the patient's condition based on their exam or diagnostic test (Limit to 1-2 sentences). If they are bulleted or numbered, please keep them numbered in the response. (e.g "impression": []"1. The patient has a fracture of the left leg", "2. The patient has a fracture of the right leg"],) {"value": array of strings}
- recommendations: Recommendations based on treatment. If applicable, select ONE of the available values: Physical Therapy, Diagnostic Testing, Injections, Surgery {"value": string}""",
            "Provider": """Extract the following information:
- history: The patients account of what they verbally told the provider. Reason for visit, history of present illness, cause of injury (Limit to 1-2 sentences). If they are bulleted or numbered, please keep them numbered in the response. (e.g "history": ["1. He is complaining of low back pain. ", "2. He is also complaining of neck pain."]) {"value": array of strings}
- chiefComplaints: What the client complained about in regards to their injury (Limit to 1-2 sentences). If they are bulleted or numbered, please keep them numbered in the response. {"value": string}
- numberOfVisits: Total count of visits to the provider. The default value is 0. {"value": number}
- examFindings: The physical exam findings throughout the chronology of the visits. Summary based on current physical exam and the clients condition (Limit to 4-6 sentences) {"value": string}
- impression: The provider's diagnosis and interpretation of the patient's condition based on their exam or diagnostic test (Limit to 1-2 sentences). If they are bulleted or numbered, please keep them numbered in the response. (e.g "impression": ["1. The patient has a fracture of the left leg", "2. The patient has a fracture of the right leg"],) {"value": array of strings}
- recommendations: Recommendations based on treatment. If applicable, select ONE of the available values: Physical Therapy, Diagnostic Testing, Injections, Surgery. {"value": string}
- surgeryRecommended: If surgery is recommended next course of treatment then true else false. The default value is false. {"value": boolean}
- injectionRecommended: If injections are recommended next course of treatment then true else false. The default value is false. {"value": boolean}
- positiveFindings: If a positive finding of fractures, bulges, herniations,or tears exist then true else false. The default value is false. {"value": boolean}
- numberofFractures: Count of unique fractures in findings. The default value is 0. {"value": number}
- numberofBulges: Count of unique bulges in findings. The default value is 0. {"value": number}
- numberofHerniations: Count of unique herniations in findings. The default value is 0. {"value": number}
- numberofTears: Count of unique tears in findings. The default value is 0. {"value": number}
- radiculopathy: If Radiculopathy exists in findings then true else false. The default value is false. {"value": boolean}
- numberOfOtherPositiveFindings: Count of unique findings that are NOT fractures, bulges, herniations, or tears. The default value is 0. {"value": number}""",
            "Diagnostic Test": """Extract the following information:
- numberOfVisits: Total count of visits to the provider. The default value is 0. {"value": number}
- impression: The provider's diagnosis and interpretation of the patient's condition based on their exam or diagnostic test (Limit to 1-2 sentences). If they are bulleted or numbered, please keep them numbered in the response. (e.g "impression": ["1. The patient has a fracture of the left leg", "2. The patient has a fracture of the right leg"],) {"value": array of strings}
- positiveFindings: If a positive finding of fractures, bulges, herniations,or tears exist then true else false. The default value is false. {"value": boolean}
- numberofFractures: Count of unique fractures in findings. The default value is 0. {"value": number}
- numberofBulges: Count of unique bulges in findings. The default value is 0. {"value": number}
- numberofHerniations: Count of unique herniations in findings. The default value is 0. {"value": number}
- numberofTears: Count of unique tears in findings. The default value is 0. {"value": number}
- radiculopathy: If Radiculopathy exists in findings then true else false. The default value is false. {"value": boolean}
- numberOfOtherPositiveFindings: Count of unique findings that are NOT fractures, bulges, herniations, or tears. The default value is 0. {"value": number}""",
            "Procedures": """Extract the following information:
- numberOfVisits: Total count of visits to the provider. The default value is 0. {"value": number}
- preOpDiagnosis: The medical condition identified before surgery that requires the surgical procedure (list of strings). If they are bulleted or numbered, please keep them numbered in the response. If there is no pre-op diagnosis, us "N/A" {"value": [string]}
- postOpDiagnosis: The confirmed medical condition after surgery, often refined with additional findings from the operation (list of strings). If they are bulleted or numbered, please keep them numbered in the response. If there is no post-op diagnosis, us "N/A" {"value": [string]}
- procedurePerformed: The specific surgical procedure carried out to address the diagnosed medical condition. The default value is an empty array. If they are bulleted or numbered, please keep them numbered in the response. If there is no procedure performed, use "N/A" {"value": [string]}""",
            "Hospital/Urgent Care": """Extract the following information:
- history: The patients account of what they verbally told the provider. Reason for visit, history of present illness, cause of injury (Limit to 1-2 sentences). If they are bulleted or numbered, please keep them numbered in the response. (e.g "history": ["1. He is complaining of low back pain. ", "2. He is also complaining of neck pain."]) {"value": array of strings}
- chiefComplaints: What the client complained about in regards to their injury (Limit to 1-2 sentences). If they are bulleted or numbered, please keep them numbered in the response. {"value": string}
- impression: The provider's diagnosis and interpretation of the patient's condition based on their exam or diagnostic test (Limit to 1-2 sentences). If they are bulleted or numbered, please keep them numbered in the response. (e.g "impression": []"1. The patient has a fracture of the left leg", "2. The patient has a fracture of the right leg"],) {"value": array of strings}
- surgeryRecommended: If surgery is recommended next course of treatment then true else false. The default value is false. {"value": boolean}
- injectionRecommended: If injections are recommended next course of treatment then true else false. The default value is false. {"value": boolean}
- positiveFindings: If a positive finding of fractures, bulges, herniations,or tears exist then true else false. The default value is false. {"value": boolean}
- numberofFractures: Count of unique fractures in findings. The default value is 0. {"value": number}
- numberofBulges: Count of unique bulges in findings. The default value is 0. {"value": number}
- numberofHerniations: Count of unique herniations in findings. The default value is 0. {"value": number}
- numberofTears: Count of unique tears in findings. The default value is 0. {"value": number}
- radiculopathy: If Radiculopathy exists in findings then true else false. The default value is false. {"value": boolean}"""
        }

    user_prompt = f"""
    {document_prompts[document_type]}

    Respond with a JSON object containing the extracted information, matching the structure and data types specified above. Please do not include the "value" key in the response of the JSON object. Do not return "history": {{"value": "This is the history"}}, instead return the value with out the "value" key e.g. {{"history": "This is the history"}}.
    Also important, do not create new keys outside of the ones specified (e.g. do not create {{ "1": "Physical Therapy", "2": "Surgery" }} it must be {{ "recommendations": 'Physical Therapy', 'Surgery'}}), the keys must be the same as the ones specified in the prompt.
    Wrap the JSON object in <extracted_data> tags. If you cannot find the requested information, return an empty JSON object with null values. Do not include any other content in your response. Please ensure that JSON is valid and all fields are present."""

    extraction_response = await invoke_claude_converse(system_prompt, user_prompt, combined_text)
    extracted_json_str = await extract_tagged_content(extraction_response, 'extracted_data')
    
    if not extracted_json_str:
        logger.warning(f"No extracted data found for document type: {document_type}")
        extracted_data = {field: None for field in document_prompts[document_type].split('\n') if field.strip().startswith('-')}
    else:
        try:
            extracted_data = json.loads(extracted_json_str)
        except json.JSONDecodeError:
            logger.error(f"Failed to parse JSON: {extracted_json_str}")
            extracted_data = {field: None for field in document_prompts[document_type].split('\n') if field.strip().startswith('-')}

    return {
        "documentType": document_type,
        "extractedData": extracted_data,
        "sourceKey": src_key,
        "processingTimestamp": datetime.now().isoformat()
    }

async def invoke_claude_converse(system_prompt: str, user_prompt: str, textract_text: str) -> str:
    try:
        logger.info(f"Invoking Claude with BEDROCK_MODEL_ID: {BEDROCK_MODEL_ID}")
        
        messages = [
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": f"{system_prompt}\n\nTextract OCR Results:\n\n{textract_text}\n\n{user_prompt}"
                    }
                ]
            }
        ]

        request_body = json.dumps({
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 1100,
            "temperature": 0.5,
            "top_p": 0.99,
            "messages": messages
        })
        
        logger.info(f"Request body: {request_body}")

        response = bedrock_runtime.invoke_model(
            modelId=BEDROCK_MODEL_ID,
            contentType="application/json",
            accept="application/json",
            body=request_body
        )
        
        logger.info(f"Received response from Bedrock: {response}")
        
        response_body = json.loads(response['body'].read())
        logger.info(f"Response body: {response_body}")
        
        if 'content' not in response_body or not response_body['content']:
            raise ValueError("Unexpected response format from Bedrock")
        
        return response_body['content'][0]['text']
    except Exception as e:
        logger.error(f"Error invoking Claude Converse API: {str(e)}", exc_info=True)
        raise

async def extract_tagged_content(text: str, tag: str) -> str:
    import re
    pattern = rf'<{tag}>(.*?)</{tag}>'
    match = re.search(pattern, text, re.DOTALL)
    print(f"Match: {match}")
    if match:
        return match.group(1).strip()
    else:
        logger.warning(f"No content found within <{tag}> tags. Full text: {text}")
        return "{}"  # Return an empty JSON object string

async def update_dynamodb(document_id: str, organized_data: Dict[str, Any]) -> None:
    try:
        current_timestamp = int(time.time() * 1000)  # Convert to milliseconds
        await asyncio.to_thread(
            table.put_item,
            Item={
                'documentId': document_id,
                'status': 'processed',
                'processingTimestamp': datetime.now().isoformat(),
                'timestamp': current_timestamp,  
                'extractedData': organized_data['extractedData'],
            }
        )
    except ClientError as e:
        logger.error(f"Error updating DynamoDB: {str(e)}")
        raise
