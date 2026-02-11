# YOLO Mode Auto-Approval Analysis

## Executive Summary

YOLO mode in Gemini CLI auto-approves **all tool confirmations except the `ask_user` tool**, which is explicitly excluded from auto-approval to ensure it always requires explicit user interaction. When YOLO mode is active and the `ask_user` tool dialog appears, it is **NOT auto-approved** - instead, it's shown to the user for manual interaction. However, if a user were to submit the dialog without providing answers, the tool would receive empty responses.

## How YOLO Mode Works

### 1. Policy Engine Configuration

YOLO mode is implemented through a high-priority policy rule defined in `/packages/core/src/policy/policies/yolo.toml`:

```toml
[[rule]]
decision = "allow"
priority = 999
modes = ["yolo"]
allow_redirection = true
```

**Key Points:**
- **Priority 999**: Highest priority in the default tier (becomes 1.999 after tier transformation)
- **Decision "allow"**: Automatically approves all tool calls
- **Modes ["yolo"]**: Only active when approval mode is set to YOLO
- **allow_redirection = true**: Even allows shell command redirection (normally downgraded to ASK_USER)

### 2. Policy Decision Flow

When a tool call is made in YOLO mode:

1. **Policy Engine Check** (`/packages/core/src/policy/policy-engine.ts`):
   - The policy engine evaluates rules by priority (highest first)
   - YOLO rule matches all tools when `approvalMode === ApprovalMode.YOLO`
   - Returns `PolicyDecision.ALLOW` for all tools

2. **Message Bus Processing** (`/packages/core/src/confirmation-bus/message-bus.ts`, lines 61-67):
   ```typescript
   case PolicyDecision.ALLOW:
     // Directly emit the response instead of recursive publish
     this.emitMessage({
       type: MessageBusType.TOOL_CONFIRMATION_RESPONSE,
       correlationId: message.correlationId,
       confirmed: true,
     });
     break;
   ```
   - When policy decision is ALLOW, the message bus immediately emits a confirmation response
   - No user interaction required - the tool is auto-approved

### 3. Tool Scheduler Auto-Approval

In `/packages/core/src/core/coreToolScheduler.ts` (lines 619-665):

```typescript
if (decision === PolicyDecision.ALLOW) {
  // ask_user requires explicit user interaction even in YOLO mode.
  // Without this, YOLO auto-approves the dialog with empty answers.
  if (toolCall.request.name === ASK_USER_TOOL_NAME) {
    const confirmationDetails = await invocation.shouldConfirmExecute(signal);
    
    if (confirmationDetails) {
      // Show confirmation dialog to user
      this.setStatusInternal(
        reqInfo.callId,
        'awaiting_approval',
        signal,
        wrappedConfirmationDetails,
      );
    }
  } else {
    // All other tools: auto-approve immediately
    this.setToolCallOutcome(
      reqInfo.callId,
      ToolConfirmationOutcome.ProceedAlways,
    );
    this.setStatusInternal(reqInfo.callId, 'scheduled', signal);
  }
}
```

**Critical Logic:**
- **Line 622 Comment**: "Without this, YOLO auto-approves the dialog with empty answers."
- **Special handling for `ask_user`**: Even when policy says ALLOW, the scheduler forces user interaction
- **All other tools**: Immediately set to `ProceedAlways` and scheduled for execution

## Why `ask_user` Tool Dialog is NOT Auto-Approved

### 1. Explicit Exclusion in Multiple Locations

The codebase has **three separate safeguards** to prevent `ask_user` auto-approval:

#### Location 1: Core Tool Scheduler (`/packages/core/src/core/coreToolScheduler.ts`, line 622)
```typescript
// ask_user requires explicit user interaction even in YOLO mode.
// Without this, YOLO auto-approves the dialog with empty answers.
if (toolCall.request.name === ASK_USER_TOOL_NAME) {
  // Force user interaction
}
```

#### Location 2: A2A Server Task Handler (`/packages/a2a-server/src/agent/task.ts`, lines 415-418)
```typescript
// Never auto-approve ask_user — it requires explicit user interaction
if (tc.request.name === ASK_USER_TOOL_NAME) {
  return;
}
```

#### Location 3: CLI UI Hook (`/packages/cli/src/ui/hooks/useGeminiStream.ts`, lines 1366-1368)
```typescript
// Never auto-approve ask_user — it requires explicit user interaction
awaitingApprovalCalls = awaitingApprovalCalls.filter(
  (call) => call.request.name !== ASK_USER_TOOL_NAME,
);
```

### 2. Design Rationale

The `ask_user` tool is fundamentally different from other tools:

- **Purpose**: Gather user preferences, clarify requirements, or make decisions
- **Requires Input**: Needs actual user responses to questions
- **Cannot be Auto-Approved**: Auto-approving would result in empty answers, defeating the tool's purpose
- **Explicit Interaction**: The tool's entire purpose is to interact with the user

From `/packages/core/src/tools/ask-user.ts`:
```typescript
export class AskUserTool extends BaseDeclarativeTool<AskUserParams, ToolResult> {
  constructor(messageBus: MessageBus) {
    super(
      ASK_USER_TOOL_NAME,
      ASK_USER_DISPLAY_NAME,
      'Ask the user one or more questions to gather preferences, clarify requirements, or make decisions.',
      // ...
    );
  }
}
```

## What Happens When Dialog is Submitted Empty

If a user manually submits the `ask_user` dialog without providing answers:

### 1. Empty Answers Handling (`/packages/core/src/tools/ask-user.ts`, lines 206-213)

```typescript
const answerEntries = Object.entries(this.userAnswers);
const hasAnswers = answerEntries.length > 0;

const returnDisplay = hasAnswers
  ? `**User answered:**\n${answerEntries.map(...).join('\n')}`
  : 'User submitted without answering questions.';

return {
  llmContent: JSON.stringify({ answers: this.userAnswers }),
  returnDisplay,
};
```

**Result:**
- **LLM receives**: `{"answers": {}}` (empty object)
- **User sees**: "User submitted without answering questions."
- **Tool succeeds**: The execution completes successfully, just with no data

### 2. Cancellation Handling (`/packages/core/src/tools/ask-user.ts`, lines 194-199)

```typescript
if (this.confirmationOutcome === ToolConfirmationOutcome.Cancel) {
  return {
    llmContent: 'User dismissed ask_user dialog without answering.',
    returnDisplay: 'User dismissed dialog',
  };
}
```

**Distinction:**
- **Cancel**: User explicitly dismissed the dialog (ESC key, cancel button)
- **Empty Submit**: User clicked submit/confirm without filling in answers

## Complete Auto-Approval Flow in YOLO Mode

### For Regular Tools (e.g., `edit`, `run_shell_command`, `write_file`)

```
1. Tool call requested
   ↓
2. Policy Engine evaluates
   → YOLO rule matches (priority 999)
   → Returns PolicyDecision.ALLOW
   ↓
3. Message Bus receives TOOL_CONFIRMATION_REQUEST
   → Sees PolicyDecision.ALLOW
   → Immediately emits TOOL_CONFIRMATION_RESPONSE with confirmed=true
   ↓
4. Tool Scheduler receives ALLOW decision
   → Sets outcome to ProceedAlways
   → Schedules tool for immediate execution
   ↓
5. Tool executes without user interaction
```

### For `ask_user` Tool (Exception)

```
1. ask_user tool call requested
   ↓
2. Policy Engine evaluates
   → YOLO rule matches (priority 999)
   → Returns PolicyDecision.ALLOW
   ↓
3. Tool Scheduler receives ALLOW decision
   → Checks: if (toolCall.request.name === ASK_USER_TOOL_NAME)
   → SPECIAL HANDLING: Force user interaction
   ↓
4. Confirmation details generated
   → Status set to 'awaiting_approval'
   → Dialog shown to user
   ↓
5. User must manually interact
   → Provide answers and submit
   → OR cancel the dialog
   → OR submit without answers (empty response)
   ↓
6. Tool executes with user's response
```

## Code References

### Key Files

1. **Policy Configuration**: `/packages/core/src/policy/policies/yolo.toml`
   - Defines the YOLO mode rule with priority 999

2. **Policy Engine**: `/packages/core/src/policy/policy-engine.ts`
   - Evaluates rules and returns PolicyDecision.ALLOW for YOLO mode

3. **Message Bus**: `/packages/core/src/confirmation-bus/message-bus.ts`
   - Lines 61-67: Auto-approves when PolicyDecision.ALLOW

4. **Core Tool Scheduler**: `/packages/core/src/core/coreToolScheduler.ts`
   - Lines 619-665: Special handling for ask_user tool
   - Line 622: Critical comment explaining the exception

5. **Ask User Tool**: `/packages/core/src/tools/ask-user.ts`
   - Lines 194-213: Handles empty answers and cancellation

6. **A2A Server**: `/packages/a2a-server/src/agent/task.ts`
   - Lines 406-424: Auto-approval loop with ask_user exclusion

7. **CLI UI Hook**: `/packages/cli/src/ui/hooks/useGeminiStream.ts`
   - Lines 1354-1395: Approval mode change handler with ask_user filter

### Key Constants

- **ASK_USER_TOOL_NAME**: `'ask_user'` (defined in `/packages/core/src/tools/tool-names.ts`)
- **ApprovalMode.YOLO**: `'yolo'` (defined in `/packages/core/src/policy/types.ts`)
- **PolicyDecision.ALLOW**: `'allow'` (defined in `/packages/core/src/policy/types.ts`)

## Summary

**YOLO mode auto-approves all tool confirmations EXCEPT `ask_user`:**

1. ✅ **Regular tools**: Auto-approved via high-priority YOLO policy rule
2. ❌ **`ask_user` tool**: Explicitly excluded from auto-approval in 3 separate code locations
3. 🔒 **Reason**: The tool's purpose is to gather user input - auto-approval would defeat this
4. 📝 **Empty submission**: If user submits without answers, tool receives `{"answers": {}}` and reports "User submitted without answering questions"
5. 🚫 **Cancellation**: If user cancels, tool reports "User dismissed ask_user dialog without answering"

The comment on line 622 of `coreToolScheduler.ts` is the smoking gun: **"Without this, YOLO auto-approves the dialog with empty answers."** This confirms that the special handling is intentional and necessary to prevent the dialog from being auto-approved with no user input.
