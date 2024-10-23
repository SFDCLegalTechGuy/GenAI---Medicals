Certainly! I'll add a pre-step to the documentation to remind users about activating the poetry shell and ensuring all requirements are installed. Here's the updated markdown documentation:

# Creating an Event to Manually Process Medical Claim Evidence

## Prerequisites

Before you begin, ensure you have the following installed and configured:

1. Python (3.9 or later)
2. Poetry (Python dependency management tool)
3. SAM CLI
4. Docker
5. AWS credentials (either through SSO or ACCESS KEY + SECRET)
6. CDK stack deployed (refer to the main README.md for deployment instructions)

## Pre-Step: Activate Poetry Environment and Install Requirements

Before proceeding with the main steps, make sure to activate the poetry shell and install all required dependencies:

1. Navigate to the project directory in your terminal.
2. Run the following commands:

```bash
poetry shell
poetry install
poetry update
```

This will activate the poetry environment, install all dependencies, and ensure everything is up to date.

## Step 1: Prepare the Event JSON

To create the event JSON, you'll need to use a Python script that generates the appropriate file based on the document type. You'll need three pieces of information:

1. Document ID
2. File Info ID
3. Record Type (e.g., "Diagnostic Test", "Procedures", "Providers", "Hospital/Urgent Care", or "PT/Chiro")

Refer to the Google Sheet for the correct IDs to use for each document type.

Run the Python script (located in the `sam` directory) with the following command:

```bash
python sam/generate_event.py <document_id> <file_info_id> "<record_type>"
```

For example:

```bash
python sam/generate_event.py a32TV000000n0lFYAQ a2VTV000001I4qz2AC "Hospital/Urgent Care"
```

This will generate a file named `event-hospital-urgent-care.json` in the `event-and-env-vars/start_workflow` directory.

## Step 2: Invoke the StartWorkflowLambda

Once you have generated the event JSON file, you can use the SAM CLI to invoke the StartWorkflowLambda function. Use the provided bash script:


```1:6:sam-invoke-start-workflow-lambda.sh
sam local invoke "StartWorkflowLambda" \
    -e ./event-and-env-vars/start_workflow/event-pt-chiro.json \
    -n ./event-and-env-vars/start_workflow/event-vars.json \
    -t ./cdk.out/shulmanStack.template.json \
    --profile shulman-hill
```


Modify the script to use the correct event JSON file name that you generated in Step 1. For example:

```bash
sam local invoke "StartWorkflowLambda" \
    -e ./event-and-env-vars/start_workflow/event-hospital-urgent-care.json \
    -n ./event-and-env-vars/start_workflow/event-vars.json \
    -t ./cdk.out/shulmanStack.template.json \
    --profile shulman-hill
```

## Step 3: Monitor the Process

After invoking the lambda function, the step function will be triggered. You can monitor the progress of the document processing workflow in the AWS Step Functions console.

The step function will perform the following steps:

1. Start the workflow
2. Extract document information
3. Start Textract analysis
4. Wait for Textract job completion
5. Process the extracted data
6. Notify IBM App Connect

You can refer to the step function definition for more details in the `lib/step-function.ts` file.

## Troubleshooting

If you encounter any issues during the process, check the following:

1. Ensure all prerequisites are correctly installed and configured.
2. Verify that your AWS credentials are valid and have the necessary permissions.
3. Double-check the Document ID, File Info ID, and Record Type against the Google Sheet to ensure accuracy.
4. Review the SAM CLI output and AWS CloudWatch logs for any error messages.
5. If you encounter any poetry-related issues, try deactivating and reactivating the poetry shell:
   ```bash
   exit  # or 'deactivate' if 'exit' doesn't work
   poetry shell
   ```

By following these steps, you should be able to manually create and process events for different types of medical claim evidence using the SAM CLI and our document processing workflow.