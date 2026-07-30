declare module "elizabot" {
  export default class ElizaBot {
    constructor(noRandomFlag?: boolean);
    transform(input: string): string;
    getInitial(): string;
    getFinal(): string;
    reset(): void;
    quit: boolean;
  }
}
