import { IAspect, Tags, Aspects } from 'aws-cdk-lib';
import { IConstruct } from 'constructs';

export class ResourceTagger implements IAspect {
    private readonly tags: { [key: string]: string };

    constructor(tags: { [key: string]: string }) {
        this.tags = tags;
    }

    public visit(node: IConstruct): void {
        for (const [key, value] of Object.entries(this.tags)) {
            Tags.of(node).add(key, value);
        }
    }
}

export function applyTagsToStack(stack: IConstruct, tags: { [key: string]: string }): void {
    const tagger = new ResourceTagger(tags);
    Aspects.of(stack).add(tagger);
}

