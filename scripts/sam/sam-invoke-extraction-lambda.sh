sam local invoke "DocumentExtractionLambda" \
    -e ./event-and-env-vars/extraction/event.json \
    -n ./event-and-env-vars/extraction/event-vars.json \
    -t ./cdk.out/shulmanStack.template.json \
    --profile shulman-hill