/**
 * The slice of jsdom that `cdp.test.ts` uses. jsdom ships no types and `@types/jsdom` is not a
 * dependency of this workspace; this ambient declaration keeps the test typed without one.
 */
declare module "jsdom" {
  export class VirtualConsole {}

  export interface DOMWindow {
    /** Global eval in the document's realm (scripts run "outside-only"). */
    eval(code: string): unknown;
    close(): void;
    document: { title: string };
  }

  export interface ConstructorOptions {
    url?: string;
    runScripts?: "dangerously" | "outside-only";
    pretendToBeVisual?: boolean;
    virtualConsole?: VirtualConsole;
  }

  export class JSDOM {
    constructor(html?: string, options?: ConstructorOptions);
    readonly window: DOMWindow;
  }
}
