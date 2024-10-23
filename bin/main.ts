#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { SHStack } from '../lib/sh-stack';
import { applyTagsToStack } from '../lib/utils/resource_tagger';

const app = new cdk.App();

// Read environment from CDK context
const environment = app.node.tryGetContext('environment') || 'dev';

const stack = new SHStack(app, 'shulmanStack', {});

applyTagsToStack(stack, {
    Environment: environment,
    Project: 'Shulman & Hill',
    Owner: 'Shulman & Hill',
    Author: 'Innovative Solutions ProServ Team'
});