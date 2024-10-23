sam local invoke "DataProcessingLambda" \
    -e ./event-and-env-vars/processing/event.json \
    -n ./event-and-env-vars/processing/event-vars.json \
    -t ./cdk.out/shulmanStack.template.json \
    --profile shulman-hill