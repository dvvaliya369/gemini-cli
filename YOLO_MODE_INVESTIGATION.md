# YOLO Mode Investigation: ask_user Tool Auto-Approval Behavior

## Executive Summary

This investigation examined how YOLO mode currently auto-approves all tool confirmations, with specific focus on why the `ask_user` tool dialog is being auto-approved and submitted with empty responses.

**Key Finding:** The codebase has **protective logic in place** to prevent `ask_user` from being auto-approved in YOLO mode, but there are **multiple layers** where this protection is implemented, and potential gaps exist depending on the execution path.

---

## Architecture Overview

### YOLO Mode Approval Flow

YOLO mode auto-approval is implemented at multiple levels:

1. **CLI Config Level** (`packages/cli/src/config/config.ts`)
2. **A2A Server Task Level** (`packages/a2a-server/src/agent/task.ts`)
3. **Core Scheduler Level** (`packages/core/src/scheduler/scheduler.ts`)
4. **CoreToolScheduler Level** (`packages/core/src/core/coreToolScheduler.ts`)

---

## Detailed Findings

### 1. CLI Config: Tool Exclusion in Non-Interactive Mode

**Location:** `/vercel/sandbox/packages/cli/src/config/config.ts` (lines 603-605)

```typescript
// In non-interactive mode, exclude tools that require a prompt.
const extraExcludes: string[] = [];
if (!interactive) {
  // ask_user requires user interaction and must be excluded in all
  // non-interactive modes, regardless of the approval mode.
  extraExcludes.push(ASK_USER_TOOL_NAME);
```

**Behavior:**
- In **non-interactive mode**, `ask_user` is completely excluded from the tool registry
- This prevents the LLM from even attempting to call `ask_user`
- **Protection Level:** ✅ Strong (tool not available)

---

### 2. A2A Server Task: Auto-Approval with ask_user Exception

**Location:** `/vercel/sandbox/packages/a2a-server/src/agent/task.ts` (lines 405-425)

```typescript
if (
  this.autoExecute ||
  this.config.getApprovalMode() === ApprovalMode.YOLO
) {
  logger.info(
    '[Task] ' +
      (this.autoExecute ? '' : 'YOLO mode enabled. ') +
      'Auto-approving all tool calls.',
  );
  toolCalls.forEach((tc: ToolCall) => {
    if (tc.status === 'awaiting_approval' && tc.confirmationDetails) {
      // ask_user requires user interaction to collect answers;
      // auto-approving it would submit empty answers.
      if (tc.request.name === ASK_USER_TOOL_NAME) {
        return;  // ⚠️ SKIP auto-approval for ask_user
      }
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      (tc.confirmationDetails as ToolCallConfirmationDetails).onConfirm(
        ToolConfirmationOutcome.ProceedOnce,
      );
      this.pendingToolConfirmationDetails.delete(tc.request.callId);
    }
  });
  return;
}
```

**Behavior:**
- When YOLO mode is enabled, all tools awaiting approval are auto-approved
- **Exception:** `ask_user` tool is explicitly skipped (early return)
- If `ask_user` is skipped, it remains in `awaiting_approval` status
- **Protection Level:** ✅ Strong (explicit skip with comment explaining why)

**Potential Issue:**
- The tool remains in `awaiting_approval` state but is never confirmed
- This could lead to a **hung state** where the task waits indefinitely for user input

---

### 3. Core Scheduler: Policy-Based Confirmation

**Location:** `/vercel/sandbox/packages/core/src/scheduler/scheduler.ts` (lines 437-441)

```typescript
// ask_user always requires user interaction to collect answers, even when
// the policy auto-approves (e.g. YOLO mode). Without this, the tool would
// execute with empty answers.
const needsConfirmation =
  decision === PolicyDecision.ASK_USER ||
  toolCall.request.name === ASK_USER_TOOL_NAME;
```

**Behavior:**
- Even if policy decision is `ALLOW`, `ask_user` forces confirmation
- This ensures user interaction is required to collect answers
- **Protection Level:** ✅ Strong (forces confirmation flow)

---

### 4. CoreToolScheduler: Validation and Confirmation

**Location:** `/vercel/sandbox/packages/core/src/core/coreToolScheduler.ts` (lines 620-624)

```typescript
// ask_user always requires user interaction to collect answers, even
// when the policy auto-approves (e.g. YOLO mode).
const isAskUser = toolCall.request.name === ASK_USER_TOOL_NAME;

if (decision === PolicyDecision.ALLOW && !isAskUser) {
  this.setToolCallOutcome(
    reqInfo.callId,
    ToolConfirmationOutcome.ProceedAlways,
  );
  this.setStatusInternal(reqInfo.callId, 'scheduled', signal);
} else {
  // PolicyDecision.ASK_USER (or ask_user tool that needs interaction)
  const confirmationDetails = await invocation.shouldConfirmExecute(signal);
  // ... confirmation flow
}
```

**Behavior:**
- If policy allows and tool is NOT `ask_user`, auto-approve
- If tool IS `ask_user`, enter confirmation flow regardless of policy
- **Protection Level:** ✅ Strong (explicit check)

---

### 5. ask_user Tool Implementation: Empty Answer Handling

**Location:** `/vercel/sandbox/packages/core/src/tools/ask-user.ts` (lines 189-207)

```typescript
async execute(_signal: AbortSignal): Promise<ToolResult> {
  if (this.confirmationOutcome === ToolConfirmationOutcome.Cancel) {
    return {
      llmContent: 'User dismissed ask_user dialog without answering.',
      returnDisplay: 'User dismissed dialog',
    };
  }

  const answerEntries = Object.entries(this.userAnswers);
  const hasAnswers = answerEntries.length > 0;

  const returnDisplay = hasAnswers
    ? `**User answered:**\n${answerEntries
        .map(([index, answer]) => {
          const question = this.params.questions[parseInt(index, 10)];
          const category = question?.header ?? `Q${index}`;
          return `  ${category} → ${answer}`;
        })
        .join('\n')}`
    : 'User submitted without answering questions.';  // ⚠️ Empty submission case

  return {
    llmContent: JSON.stringify({ answers: this.userAnswers }),
    returnDisplay,
  };
}
```

**Behavior:**
- If `userAnswers` is empty, the tool still executes successfully
- Returns `llmContent: JSON.stringify({ answers: {} })` (empty object)
- **Issue:** ⚠️ If somehow auto-approved without user input, empty answers are submitted

---

## Problem Scenarios

### Scenario 1: Interactive Mode + YOLO
**Expected:** `ask_user` should still prompt for user input
**Actual:** ✅ Protected by A2A Server Task logic (skips auto-approval)
**Status:** Working as intended

### Scenario 2: Non-Interactive Mode + YOLO
**Expected:** `ask_user` should be excluded from available tools
**Actual:** ✅ Protected by CLI Config (tool excluded)
**Status:** Working as intended

### Scenario 3: Edge Case - Direct onConfirm Call
**Potential Issue:** If `onConfirm` is called directly without going through the scheduler's protection logic
**Risk:** ⚠️ Could result in empty answers being submitted

**Example Path:**
```typescript
// If this is called directly in YOLO mode without the ask_user check:
confirmationDetails.onConfirm(ToolConfirmationOutcome.ProceedOnce);
// And execute() is called without user input:
await invocation.execute(signal);
// Result: Empty answers submitted
```

---

## Root Cause Analysis

### Why Empty Responses Could Occur

1. **Race Condition:** If auto-approval happens before the `ask_user` check
2. **Bypass Path:** If there's a code path that calls `onConfirm` without the protection checks
3. **State Inconsistency:** If `confirmationOutcome` is set but `userAnswers` remains empty

### Current Protection Mechanisms

| Layer | Protection | Effectiveness |
|-------|-----------|---------------|
| CLI Config | Excludes `ask_user` in non-interactive mode | ✅ Strong |
| A2A Server Task | Skips auto-approval for `ask_user` | ✅ Strong |
| Core Scheduler | Forces confirmation for `ask_user` | ✅ Strong |
| CoreToolScheduler | Explicit `ask_user` check | ✅ Strong |
| ask_user Tool | Handles empty answers gracefully | ⚠️ Weak (allows empty) |

---

## Recommendations

### 1. Add Validation in ask_user.execute()

**Current Issue:** The tool allows execution with empty answers

**Proposed Fix:**
```typescript
async execute(_signal: AbortSignal): Promise<ToolResult> {
  if (this.confirmationOutcome === ToolConfirmationOutcome.Cancel) {
    return {
      llmContent: 'User dismissed ask_user dialog without answering.',
      returnDisplay: 'User dismissed dialog',
    };
  }

  const answerEntries = Object.entries(this.userAnswers);
  const hasAnswers = answerEntries.length > 0;

  // NEW: Validate that answers were actually provided
  if (!hasAnswers) {
    throw new Error(
      'ask_user tool executed without user input. This should not happen in YOLO mode.'
    );
  }

  const returnDisplay = `**User answered:**\n${answerEntries
    .map(([index, answer]) => {
      const question = this.params.questions[parseInt(index, 10)];
      const category = question?.header ?? `Q${index}`;
      return `  ${category} → ${answer}`;
    })
    .join('\n')}`;

  return {
    llmContent: JSON.stringify({ answers: this.userAnswers }),
    returnDisplay,
  };
}
```

### 2. Add Defensive Check in onConfirm

**Proposed Addition:**
```typescript
onConfirm: async (
  outcome: ToolConfirmationOutcome,
  payload?: ToolConfirmationPayload,
) => {
  this.confirmationOutcome = outcome;
  if (payload && 'answers' in payload) {
    this.userAnswers = payload.answers;
  } else if (outcome === ToolConfirmationOutcome.ProceedOnce) {
    // NEW: Prevent proceeding without answers
    throw new Error(
      'Cannot proceed with ask_user without user-provided answers'
    );
  }
},
```

### 3. Add Integration Test

**Test Case:**
```typescript
it('should NOT auto-approve ask_user in YOLO mode', async () => {
  const config = createMockConfig({ approvalMode: 'yolo' });
  const task = await Task.create('test-id', 'context-id', config);
  
  // Schedule ask_user tool call
  const askUserRequest = {
    callId: 'ask-1',
    name: 'ask_user',
    args: {
      questions: [{ question: 'Test?', header: 'Test', type: 'text' }]
    }
  };
  
  await task.scheduleToolCalls([askUserRequest], new AbortController().signal);
  
  // Verify it's awaiting approval (not auto-approved)
  const toolCall = task.pendingToolConfirmationDetails.get('ask-1');
  expect(toolCall).toBeDefined();
  expect(toolCall.type).toBe('ask_user');
});
```

### 4. Add Logging for Debugging

**Add to A2A Server Task:**
```typescript
if (tc.request.name === ASK_USER_TOOL_NAME) {
  logger.warn(
    `[Task] Skipping auto-approval for ask_user tool (callId: ${tc.request.callId}) ` +
    `in YOLO mode. Tool will remain in awaiting_approval state.`
  );
  return;
}
```

---

## Testing Checklist

- [ ] Test YOLO mode with `ask_user` in interactive mode
- [ ] Test YOLO mode with `ask_user` in non-interactive mode
- [ ] Test that `ask_user` is excluded from tool registry in non-interactive mode
- [ ] Test that `ask_user` remains in `awaiting_approval` state in YOLO mode
- [ ] Test that empty answers cannot be submitted
- [ ] Test that canceling `ask_user` returns appropriate message
- [ ] Add integration test for YOLO + ask_user scenario

---

## Conclusion

The codebase has **multiple layers of protection** to prevent `ask_user` from being auto-approved in YOLO mode. However, the current implementation has a potential weakness:

1. **The tool allows execution with empty answers** - This is the primary vulnerability
2. **No explicit error when auto-approval is attempted** - Silent failure could lead to confusion

The recommended fixes add defensive validation at the tool level to ensure that even if protection layers are bypassed, the tool will fail explicitly rather than submitting empty responses.

---

## Files Analyzed

1. `/vercel/sandbox/packages/a2a-server/src/agent/task.ts`
2. `/vercel/sandbox/packages/cli/src/config/config.ts`
3. `/vercel/sandbox/packages/core/src/scheduler/scheduler.ts`
4. `/vercel/sandbox/packages/core/src/core/coreToolScheduler.ts`
5. `/vercel/sandbox/packages/core/src/tools/ask-user.ts`
6. `/vercel/sandbox/packages/core/src/scheduler/confirmation.ts`
7. `/vercel/sandbox/packages/core/src/tools/tool-names.ts`

---

**Investigation Date:** February 11, 2026  
**Investigator:** Blackbox AI Agent
