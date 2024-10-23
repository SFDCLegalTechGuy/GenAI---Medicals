.PHONY: help build watch test deploy diff synth bootstrap clean

help:
	@echo "Available commands:"
	@echo "  make build      - Compile TypeScript to JavaScript"
	@echo "  make watch      - Watch for changes and compile"
	@echo "  make test       - Run unit tests"
	@echo "  make deploy     - Deploy the stack to your default AWS account/region"
	@echo "  make diff       - Compare deployed stack with current state"
	@echo "  make synth      - Emit the synthesized CloudFormation template"
	@echo "  make bootstrap  - Bootstrap CDK resources in your AWS account"
	@echo "  make clean      - Remove build artifacts"
	@echo "  make help       - Display this help message"

build:
	poetry run npm run build

watch:
	poetry run npm run watch

test:
	poetry run npm run test

deploy:
	poetry run cdk deploy

diff:
	poetry run cdk diff

synth:
	poetry run cdk synth

bootstrap:
	poetry run cdk bootstrap

clean:
	rm -rf cdk.out

# Set the default target to help
.DEFAULT_GOAL := help