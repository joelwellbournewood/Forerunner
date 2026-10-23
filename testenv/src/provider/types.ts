/**
 * The provider contract the fake implements.
 *
 * testenv does not depend on @forerunner/runtime at runtime (it is not a declared dependency),
 * so the contract is imported type-only by relative path. `verbatimModuleSyntax` erases this
 * file completely at runtime: nothing is copied, nothing is loaded, and the two sides can never
 * drift because the compiler checks the fake against the real `ModelProvider` on every build.
 */
export type {
  ChatMessage,
  ContentBlock,
  EffortLevel,
  ModelProvider,
  ModelRef,
  ModelRequest,
  ModelResponse,
  ModelTier,
  ProviderCapabilities,
  ProviderDeclaredCapabilities,
  StopReason,
  StreamEvent,
  TextBlock,
  ThinkingBlock,
  ToolDefinition,
  ToolResultBlock,
  ToolUseBlock,
  Usage,
} from "../../../packages/runtime/src/provider/types.ts";
