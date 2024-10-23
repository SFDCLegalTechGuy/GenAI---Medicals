import json
import xml.etree.ElementTree as ET
import argparse
from pathlib import Path

def generate_event_json(document_id: str, file_info_id: str, record_type: str) -> str:
    """
    Generate the event JSON file based on input parameters.

    Args:
        document_id (str): The document ID.
        file_info_id (str): The file info ID.
        record_type (str): The record type.

    Returns:
        str: The generated JSON string.

    Usage:
    python generate_event.py <document_id> <file_info_id> <record_type>
    for example:
    python generate_event.py a32TV000000n0lFYAQ a2VTV000001I4qz2AC "Hospital/Urgent Care"
    """
    # Load the template XML
    with open('event-and-env-vars/start_workflow/event-template.json', 'r') as f:
        template = json.load(f)

    # Parse the XML content
    root = ET.fromstring(template['body'])

    # Update the relevant fields
    namespace = {'sf': 'urn:sobject.enterprise.soap.sforce.com'}
    root.find('.//sf:Id', namespace).text = document_id
    root.find('.//sf:File_Info_Id__c', namespace).text = file_info_id
    root.find('.//sf:Record_Type_Name__c', namespace).text = record_type

    # Convert back to string
    updated_xml = ET.tostring(root, encoding='unicode')

    # Create the new event JSON
    new_event = {
        "body": updated_xml
    }

    return json.dumps(new_event, indent=2)

def main():
    parser = argparse.ArgumentParser(description='Generate event JSON for StartWorkflowLambda')
    parser.add_argument('document_id', help='Document ID')
    parser.add_argument('file_info_id', help='File Info ID')
    parser.add_argument('record_type', help='Record Type')
    args = parser.parse_args()

    event_json = generate_event_json(args.document_id, args.file_info_id, args.record_type)

    # Generate the output file name
    output_file_name = f"event-{args.record_type.lower().replace('/', '-').replace(' ', '-')}.json"
    output_path = Path('event-and-env-vars/start_workflow') / output_file_name

    # Write the event JSON to the file
    with open(output_path, 'w') as f:
        f.write(event_json)

    print(f"Event JSON file generated: {output_path}")

if __name__ == "__main__":
    main()
