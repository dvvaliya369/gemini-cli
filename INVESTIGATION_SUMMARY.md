# Session Permission Issue - Investigation Summary

## Issue Description
The Gemini CLI keeps asking for permission even after the user chooses "Allow for this session". Session-based permissions are not persisting as expected.

## Code Components Involved

### 1. **User Interface** (`ToolConfirmationMessage.tsx`)
- Displays confirmation options including "Allow for this session"
- Maps to `ToolConfirmationOutcome.ProceedAlways`

### 2. **Outcome Processing** (`scheduler/scheduler.ts`)
- Receives user's confirmation outcome
- Calls `updatePolicy()` to handle the permission

### 3. **Policy Update Logic** (`scheduler/policy.ts`)
- Publishes `UPDATE_POLICY` message to MessageBus
- For shell commands, extracts `rootCommands` from confirmation details
- Sets `persist: false` for ProceedAlways (session-only)
- Sets `persist: true` for ProceedAlwaysAndSave (permanent)

### 4. **Policy Updater** (`policy/config.ts`)
- Subscribes to `UPDATE_POLICY` messages
- Converts command prefixes to regex patterns
- Adds rules to PolicyEngine with priority 2.95
- Only writes to disk if `persist: true`

### 5. **Policy Engine** (`policy/policy-engine.ts`)
- Stores rules in-memory in `this.rules` array
- Checks rules in priority order
- Returns first matching rule

## How It Should Work

1. User runs a command (e.g., `git status`)
2. CLI asks for permission
3. User selects "Allow for this session"
4. System creates a rule: `{ toolName: 'run_shell_command', argsPattern: /"command":"git(?:[\s"]|\\")"/, decision: ALLOW, priority: 2.95 }`
5. Rule is stored in PolicyEngine's in-memory rules array
6. Next time `git status` runs, PolicyEngine finds the matching rule and auto-allows

## Potential Issues Identified

### Issue #1: Confirmation Details Not Passed
**Location**: `scheduler/scheduler.ts` → `scheduler/policy.ts`

The `confirmationDetails` parameter might be undefined or incomplete when passed to `updatePolicy()`. If `confirmationDetails.type !== 'exec'` or `confirmationDetails.rootCommands` is missing, no pattern will be created.

**Impact**: Rule is added without an `argsPattern`, so it won't match specific commands.

### Issue #2: Pattern Matching Too Strict
**Location**: `policy/utils.ts` - `buildArgsPatterns()`

The pattern created is:
```regex
"command":"git(?:[\s"]|\\")"
```

This matches JSON-stringified args. If the args structure changes slightly (e.g., extra whitespace, different JSON serialization), the pattern might not match.

**Impact**: Subsequent identical commands might not match the stored pattern.

### Issue #3: Tool Name Mismatch
**Location**: Multiple files

Different tools might use different names or aliases. The rule is stored with `tool.name`, but the check might use a different name.

**Impact**: Rule won't match if tool names don't align.

## Files to Investigate

1. **`packages/core/src/scheduler/policy.ts`**
   - Line 148-159: Check if `confirmationDetails` is properly populated
   - Add logging to see what `commandPrefix` is being sent

2. **`packages/core/src/policy/config.ts`**
   - Line 335-376: Check if patterns are being created correctly
   - Add logging to see what rules are being added

3. **`packages/core/src/policy/policy-engine.ts`**
   - Line 300-400: Check if rules are matching correctly
   - Add logging to see what rules are being evaluated

4. **`packages/core/src/scheduler/scheduler.ts`**
   - Line 452: Check if `lastDetails` is properly populated
   - Add logging to see what confirmation details are being passed

## Recommended Debugging Steps

1. **Add Debug Logging**:
   ```typescript
   // In scheduler/policy.ts - handleStandardPolicyUpdate()
   console.log('[DEBUG] updatePolicy called:', {
     toolName: tool.name,
     outcome,
     confirmationDetails,
     commandPrefix: confirmationDetails?.type === 'exec' ? confirmationDetails.rootCommands : undefined
   });
   ```

2. **Add Debug Logging**:
   ```typescript
   // In policy/config.ts - UPDATE_POLICY subscriber
   console.log('[DEBUG] UPDATE_POLICY received:', {
     toolName: message.toolName,
     commandPrefix: message.commandPrefix,
     argsPattern: message.argsPattern,
     persist: message.persist
   });
   
   // After buildArgsPatterns
   console.log('[DEBUG] Patterns created:', patterns);
   
   // After addRule
   console.log('[DEBUG] Rule added:', {
     toolName,
     argsPattern,
     priority: 2.95,
     source: 'Dynamic (Confirmed)'
   });
   ```

3. **Add Debug Logging**:
   ```typescript
   // In policy/policy-engine.ts - check() method
   console.log('[DEBUG] Policy check:', {
     toolName: toolCall.name,
     stringifiedArgs,
     rulesCount: this.rules.length,
     dynamicRules: this.rules.filter(r => r.source === 'Dynamic (Confirmed)')
   });
   ```

4. **Test Scenario**:
   - Run a simple command: `ls -la`
   - Select "Allow for this session"
   - Run the same command again: `ls -la`
   - Check if it asks for permission again
   - Review debug logs to see where the flow breaks

## Expected Behavior

After selecting "Allow for this session":
- A rule should be added to PolicyEngine
- The rule should have an `argsPattern` that matches the command
- Subsequent identical commands should match the rule
- No permission prompt should appear for the same command in the same session

## Actual Behavior (Suspected)

One of these is likely happening:
- Rule is added without proper `argsPattern`
- Pattern doesn't match subsequent commands
- Confirmation details are not being passed correctly
- Tool name mismatch prevents rule matching
