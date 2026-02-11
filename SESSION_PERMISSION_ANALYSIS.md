# Session Permission Issue Analysis

## Problem Statement
The Gemini CLI keeps asking for permission even after the user chooses "Allow for this session". The session-based permissions are not persisting as expected.

## Code Flow Analysis

### 1. **User Interaction Flow**
When a tool requires confirmation, the user sees options like:
- Allow once
- **Allow for this session** (ProceedAlways)
- Allow for all future sessions (ProceedAlwaysAndSave)

### 2. **Confirmation Handling**
Location: `packages/cli/src/ui/components/messages/ToolConfirmationMessage.tsx`

```typescript
// Lines 117-119
{
  label: 'Allow for this session',
  value: ToolConfirmationOutcome.ProceedAlways,
  key: 'Allow for this session',
}
```

### 3. **Outcome Processing**
Location: `packages/core/src/scheduler/scheduler.ts` (line 452)

When user confirms, the outcome is passed to `updatePolicy()`:
```typescript
await updatePolicy(toolCall.tool, outcome, lastDetails, {
  config: this.config,
  messageBus: this.messageBus,
});
```

### 4. **Policy Update Logic**
Location: `packages/core/src/scheduler/policy.ts`

The `updatePolicy()` function handles different outcomes:

```typescript
async function handleStandardPolicyUpdate(
  tool: AnyDeclarativeTool,
  outcome: ToolConfirmationOutcome,
  confirmationDetails: SerializableConfirmationDetails | undefined,
  messageBus: MessageBus,
): Promise<void> {
  if (
    outcome === ToolConfirmationOutcome.ProceedAlways ||
    outcome === ToolConfirmationOutcome.ProceedAlwaysAndSave
  ) {
    const options: PolicyUpdateOptions = {};

    if (confirmationDetails?.type === 'exec') {
      options.commandPrefix = confirmationDetails.rootCommands;
    }

    await messageBus.publish({
      type: MessageBusType.UPDATE_POLICY,
      toolName: tool.name,
      persist: outcome === ToolConfirmationOutcome.ProceedAlwaysAndSave,
      ...options,
    });
  }
}
```

**KEY FINDING**: The `UPDATE_POLICY` message is published for both `ProceedAlways` and `ProceedAlwaysAndSave`.

### 5. **Policy Engine Update**
Location: `packages/core/src/policy/config.ts` (lines 335-376)

The `createPolicyUpdater()` function subscribes to `UPDATE_POLICY` messages:

```typescript
messageBus.subscribe(
  MessageBusType.UPDATE_POLICY,
  async (message: UpdatePolicy) => {
    const toolName = message.toolName;

    if (message.commandPrefix) {
      // Convert commandPrefix(es) to argsPatterns for in-memory rules
      const patterns = buildArgsPatterns(undefined, message.commandPrefix);
      for (const pattern of patterns) {
        if (pattern) {
          policyEngine.addRule({
            toolName,
            decision: PolicyDecision.ALLOW,
            priority: 2.95,
            argsPattern: new RegExp(pattern),
            source: 'Dynamic (Confirmed)',
          });
        }
      }
    } else {
      const argsPattern = message.argsPattern
        ? new RegExp(message.argsPattern)
        : undefined;

      policyEngine.addRule({
        toolName,
        decision: PolicyDecision.ALLOW,
        priority: 2.95,
        argsPattern,
        source: 'Dynamic (Confirmed)',
      });
    }
    
    // Only persist if message.persist is true
    if (message.persist) {
      // ... file writing logic ...
    }
  },
);
```

**KEY FINDING**: Rules are added to the PolicyEngine in-memory for BOTH `ProceedAlways` and `ProceedAlwaysAndSave`, but only persisted to disk when `persist: true`.

### 6. **Policy Engine Rule Matching**
Location: `packages/core/src/policy/policy-engine.ts`

The PolicyEngine checks rules in priority order and returns the first match.

## Root Cause Analysis

### Potential Issues:

1. **Session Scope Problem**: 
   - The PolicyEngine is instantiated per session
   - Rules added via `addRule()` are stored in-memory in `this.rules` array
   - **HYPOTHESIS**: The PolicyEngine instance might be recreated or reset between tool calls, losing the in-memory rules

2. **Rule Matching Issue**:
   - For shell commands, the code uses `commandPrefix` which gets converted to `argsPattern`
   - **HYPOTHESIS**: The pattern matching might not be working correctly for subsequent identical commands

3. **Tool Name Mismatch**:
   - Different tools might have different names or aliases
   - **HYPOTHESIS**: The tool name used when adding the rule might not match the tool name used when checking

4. **Confirmation Details Missing**:
   - For non-exec tools, `confirmationDetails` might be undefined
   - **HYPOTHESIS**: Without proper confirmation details, the rule might not have the right pattern to match

## Investigation Steps Needed

To identify the exact issue, we need to:

1. **Check PolicyEngine Lifecycle**:
   - Verify if PolicyEngine is a singleton or recreated per turn/session
   - Check if rules persist across multiple tool calls in the same session

2. **Verify Rule Addition**:
   - Add logging to confirm rules are actually being added to the engine
   - Check the rule priority and pattern

3. **Verify Rule Matching**:
   - Add logging in the policy check to see which rules are being evaluated
   - Verify the tool name and args being checked match the stored rule

4. **Check for Rule Clearing**:
   - Search for any code that might clear or reset the PolicyEngine rules
   - Check if there's any session cleanup that removes dynamic rules

## Findings from Code Investigation

### PolicyEngine Lifecycle ✅
Location: `packages/core/src/config/config.ts` (line 798)

```typescript
this.policyEngine = new PolicyEngine({
  ...params.policyEngineConfig,
  approvalMode: params.approvalMode ?? params.policyEngineConfig?.approvalMode,
});
this.messageBus = new MessageBus(this.policyEngine, this.debugMode);
```

**Finding**: PolicyEngine is created ONCE in the Config constructor and stored as an instance variable. It's a singleton per Config instance.

### Policy Updater Setup ✅
Location: `packages/cli/src/gemini.tsx` (line 534)

```typescript
const policyEngine = config.getPolicyEngine();
const messageBus = config.getMessageBus();
createPolicyUpdater(policyEngine, messageBus);
```

**Finding**: The policy updater is properly set up and subscribes to UPDATE_POLICY messages.

### Rule Pattern Matching 🔍
Location: `packages/core/src/policy/utils.ts`

The `buildArgsPatterns()` function creates regex patterns like:
```
"command":"git(?:[\\s"]|\\\\")"
```

This pattern matches JSON-stringified args where the command starts with the prefix.

### Potential Issue Identified ⚠️

Looking at the flow:

1. User selects "Allow for this session" (ProceedAlways)
2. `updatePolicy()` is called in `scheduler/policy.ts`
3. For shell commands, it extracts `rootCommands` from confirmation details
4. UPDATE_POLICY message is published with `commandPrefix: rootCommands`
5. Policy updater receives message and calls `buildArgsPatterns()`
6. Pattern is created and rule is added to PolicyEngine

**CRITICAL FINDING**: The issue might be in how `confirmationDetails` is passed through the flow.

Let me trace the confirmation details flow:

1. In `scheduler/scheduler.ts` line 452:
   ```typescript
   await updatePolicy(toolCall.tool, outcome, lastDetails, {...});
   ```

2. The `lastDetails` variable comes from the confirmation loop

3. In `scheduler/policy.ts` line 148-159:
   ```typescript
   if (confirmationDetails?.type === 'exec') {
     options.commandPrefix = confirmationDetails.rootCommands;
   }
   ```

**HYPOTHESIS**: If `confirmationDetails` is undefined or doesn't have the right structure, the rule won't have the proper pattern to match future commands.

## Root Cause Hypothesis

The most likely issue is that **confirmation details are not being properly passed** when the user selects "Allow for this session". This could happen if:

1. The confirmation details are lost between the initial confirmation request and the policy update
2. The `rootCommands` field is not properly populated in the confirmation details
3. The pattern matching is too strict and doesn't match subsequent identical commands

## Recommended Fix

Add debug logging to trace:
1. What confirmation details are passed to `updatePolicy()`
2. What pattern is generated by `buildArgsPatterns()`
3. What rule is actually added to the PolicyEngine
4. What args are being checked when the same command runs again

## Next Steps

1. Add debug logging to `scheduler/policy.ts` in `handleStandardPolicyUpdate()`
2. Add debug logging to `policy/config.ts` in the UPDATE_POLICY subscriber
3. Add debug logging to `policy/policy-engine.ts` in the `check()` method
4. Test with a simple shell command to see if the pattern matches
