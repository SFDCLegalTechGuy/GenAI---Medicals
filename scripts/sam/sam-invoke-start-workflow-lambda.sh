sam local invoke "StartWorkflowLambda" \
    -e ../event-and-env-vars/start_workflow/event-pt-chiro.json \
    -n ../event-and-env-vars/start_workflow/event-vars.json \
    -t ../../cdk.out/shulmanStack.template.json \
    --profile shulman-hill