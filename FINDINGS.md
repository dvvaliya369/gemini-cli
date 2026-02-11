# Session Permission Issue - Investigation Findings

## Summary

I've investigated why the Gemini CLI keeps asking for permission even after choosing "Allow for this session". Here's what I found:

## How Session Permissions Work

### The Flow:

1. **User Action**: When you select "Allow for this session", it triggers `ToolConfirmationOutcome.ProceedAlways`

2. **Policy Update**: The system publishes an `UPDATE_POLICY` message with:
   - Tool name (e.g., `run_shell_command`)
   - Command prefix (e.g., `["git"]` for `git status`)
   - `persist: false` (session-only, not saved to disk)

3. **Rule Creation**: The policy updater:
   - Converts the command prefix to a regex pattern
   - Adds a rule to the PolicyEngine's in-memory rules
   - Priority: 2.95 (high priority for user confirmations)

4. **Future Checks**: When the same command runs again:
   - PolicyEngine checks all rules in priority order
   - Should find the matching rule and auto-allow
   - No permission prompt should appear

## Code Locations

### Where Session Permissions Are Handled:

1. **UI Component**: `packages/cli/src/ui/components/messages/ToolConfirmationMessage.tsx`
   - Lines 117-119: "Allow for this session" option

2. **Policy Update**: `packages/core/src/scheduler/policy.ts`
   - Lines 148-159: Extracts command prefix from confirmation details
   - Publishes UPDATE_POLICY message

3. **Policy Updater**: `packages/core/src/policy/config.ts`
   - Lines 335-376: Subscribes to UPDATE_POLICY messages
   - Converts command prefix to regex pattern
   - Adds rule to PolicyEngine

4. **Policy Engine**: `packages/core/src/policy/policy-engine.ts`
   - Stores rules in `this.rules` array (in-memory)
   - Checks rules on every tool call

## Potential Root Causes

### Most Likely Issue: Missing Confirmation Details

**Problem**: The `confirmationDetails` parameter might not be properly populated when `updatePolicy()` is called.

**Evidence**:
```typescript
// In scheduler/policy.ts
if (confirmationDetails?.type === 'exec') {
  options.commandPrefix = confirmationDetails.rootCommands;
}
```

If `confirmationDetails` is undefined or doesn't have `type === 'exec'`, no command prefix is set, and the rule won't have a pattern to match.

**Impact**: Rule is added without an `argsPattern`, so it matches ALL invocations of the tool (not just the specific command). This might cause issues with the policy engine's matching logic.

### Secondary Issue: Pattern Matching

**Problem**: The regex pattern created might be too strict or not match subsequent commands.

**Pattern Format**:
```regex
"command":"git(?:[\s"]|\\")"
```

This pattern matches against JSON-stringified arguments. If the JSON serialization changes slightly, the pattern might not match.

## What Should Happen vs. What Might Be Happening

### Expected:
```
1. User runs: git status
2. User selects: "Allow for this session"
3. Rule added: { toolName: 'run_shell_command', argsPattern: /"command":"git(?:[\s"]|\\")"/, decision: ALLOW }
4. User runs: git status (again)
5. PolicyEngine finds matching rule → Auto-allows
```

### Suspected:
```
1. User runs: git status
2. User selects: "Allow for this session"
3. confirmationDetails is undefined or incomplete
4. Rule added: { toolName: 'run_shell_command', decision: ALLOW } (no argsPattern!)
5. User runs: git status (again)
6. PolicyEngine checks rule but it doesn't match properly → Asks again
```

## Recommended Next Steps

### 1. Add Debug Logging

Add logging to trace the flow:

**In `packages/core/src/scheduler/policy.ts`** (line ~150):
```typescript
console.log('[SESSION-PERM] updatePolicy called:', {
  toolName: tool.name,
  outcome,
  confirmationType: confirmationDetails?.type,
  rootCommands: confirmationDetails?.type === 'exec' ? confirmationDetails.rootCommands : undefined
});
```

**In `packages/core/src/policy/config.ts`** (line ~340):
```typescript
console.log('[SESSION-PERM] UPDATE_POLICY received:', {
  toolName: message.toolName,
  commandPrefix: message.commandPrefix,
  persist: message.persist
});

// After buildArgsPatterns
console.log('[SESSION-PERM] Patterns created:', patterns);
```

**In `packages/core/src/policy/policy-engine.ts`** (line ~300):
```typescript
console.log('[SESSION-PERM] Policy check:', {
  toolName: toolCall.name,
  dynamicRulesCount: this.rules.filter(r => r.source === 'Dynamic (Confirmed)').length
});
```

### 2. Test Scenario

1. Run a simple command: `ls -la`
2. Select "Allow for this session"
3. Check console logs to see:
   - What confirmation details were passed
   - What pattern was created
   - What rule was added
4. Run the same command again: `ls -la`
5. Check console logs to see:
   - If the rule is being checked
   - If the pattern matches
   - Why it's asking for permission again

### 3. Verify PolicyEngine Persistence

Check that the PolicyEngine instance is not being recreated between tool calls:

**In `packages/core/src/config/config.ts`**:
```typescript
getPolicyEngine(): PolicyEngine {
  console.log('[SESSION-PERM] PolicyEngine rules count:', this.policyEngine.getRules().length);
  return this.policyEngine;
}
```

## Files That Need Investigation

1. `packages/core/src/scheduler/scheduler.ts` - Line 452
   - Check if `lastDetails` is properly populated

2. `packages/core/src/scheduler/policy.ts` - Lines 148-159
   - Check if `confirmationDetails` has the right structure

3. `packages/core/src/policy/config.ts` - Lines 335-376
   - Check if patterns are being created correctly

4. `packages/core/src/policy/policy-engine.ts` - Check method
   - Check if rules are matching correctly

## Conclusion

The session permission system is architecturally sound - it creates in-memory rules that should persist for the session. The issue is likely in the **data flow** where confirmation details are not being properly passed through the chain, resulting in rules without proper patterns to match subsequent commands.

The recommended approach is to add debug logging at key points to trace exactly where the flow breaks down, then fix the data passing issue.
