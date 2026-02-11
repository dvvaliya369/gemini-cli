# Session Permissions Analysis

## Overview
This document identifies the parts of the codebase that handle session permissions in the Gemini CLI project.

## Key Components

### 1. **Folder Trust System** (`packages/cli/src/config/trustedFolders.ts`)
The primary permission system for sessions based on workspace/folder trust levels.

**Key Functions:**
- `isWorkspaceTrusted(settings, workspaceDir, trustConfig)`: Determines if a workspace is trusted
  - Returns `TrustResult` with `isTrusted` boolean and `source` ('ide' | 'file')
  - Checks IDE context first, then falls back to local configuration
  - Returns `true` if folder trust is disabled

- `isFolderTrustEnabled(settings)`: Checks if folder trust feature is enabled
  - Reads from `settings.security?.folderTrust?.enabled` (default: true)

- `LoadedTrustedFolders.isPathTrusted(location, config)`: Checks if a specific path is trusted
  - Uses longest-match algorithm for trust rules
  - Supports `TRUST_FOLDER`, `TRUST_PARENT`, and `DO_NOT_TRUST` levels

**Trust Levels:**
```typescript
enum TrustLevel {
  TRUST_FOLDER = 'TRUST_FOLDER',
  TRUST_PARENT = 'TRUST_PARENT', 
  DO_NOT_TRUST = 'DO_NOT_TRUST',
}
```

**Storage:**
- Trust configuration stored in `~/.gemini/trustedFolders.json`
- Can be overridden via `GEMINI_CLI_TRUSTED_FOLDERS_PATH` environment variable

---

### 2. **Config Class** (`packages/core/src/config/config.ts`)
Central configuration that enforces trust-based permissions.

**Key Methods:**
- `getFolderTrust()`: Returns whether folder trust feature is enabled
  - Line 1813-1815

- `isTrustedFolder()`: Returns whether current workspace is trusted
  - Line 1821-1829
  - Checks IDE context first (`ideContextStore.get()?.workspaceState?.isTrusted`)
  - Falls back to `this.trustedFolder` value if folder trust is enabled
  - Returns `true` if folder trust is disabled

**Permission Enforcement:**
- `setApprovalMode(mode)`: Prevents privileged approval modes in untrusted folders
  - Line 1497-1520
  - Throws error if trying to set non-DEFAULT mode in untrusted folder
  ```typescript
  if (!this.isTrustedFolder() && mode !== ApprovalMode.DEFAULT) {
    throw new Error('Cannot enable privileged approval modes in an untrusted folder.');
  }
  ```

- `isYoloModeDisabled()`: Disables YOLO mode in untrusted folders
  - Line 1567-1569
  ```typescript
  return this.disableYoloMode || !this.isTrustedFolder();
  ```

**Initialization:**
- `folderTrust` and `trustedFolder` set during config loading (line 439-440 in CLI config)
  ```typescript
  const folderTrust = settings.security?.folderTrust?.enabled ?? false;
  const trustedFolder = isWorkspaceTrusted(settings, cwd)?.isTrusted ?? false;
  ```

---

### 3. **Policy Engine** (`packages/core/src/policy/policy-engine.ts`)
Enforces approval modes and tool execution policies.

**Approval Modes:**
```typescript
enum ApprovalMode {
  DEFAULT = 'default',      // Standard confirmation prompts
  AUTO_EDIT = 'autoEdit',   // Auto-approve edit operations
  YOLO = 'yolo',            // Auto-approve all operations
  PLAN = 'plan',            // Planning mode only
}
```

**Trust Integration:**
- Approval mode changes are restricted based on folder trust
- YOLO mode is disabled in untrusted folders
- Policy rules can include `trustedFolder` in execution context

---

### 4. **Hook Trust System** (`packages/core/src/hooks/trustedHooks.ts`)
Manages trust for project-specific hooks.

**Key Class: `TrustedHooksManager`**
- `getUntrustedHooks(projectPath, hooks)`: Returns list of untrusted hooks for a project
- `trustHooks(projectPath, hooks)`: Marks hooks as trusted for a project
- Storage: `~/.gemini/trusted_hooks.json`

**Hook Sources:**
```typescript
type HookSource = 'project' | 'user' | 'system' | 'extension';
```

---

### 5. **Extension Manager** (`packages/cli/src/config/extension-manager.ts`)
Enforces trust requirements for extension installation.

**Trust Checks:**
- Line 184-194: Prompts user to trust workspace before installing extensions
  ```typescript
  if (!isWorkspaceTrusted(this.settings).isTrusted) {
    // Prompt user to trust workspace
    trustedFolders.setValue(this.workspaceDir, TrustLevel.TRUST_FOLDER);
  }
  ```

- Line 610: Only auto-loads extensions in trusted workspaces

---

### 6. **Permissions UI** (`packages/cli/src/ui/components/PermissionsModifyTrustDialog.tsx`)
User interface for managing folder trust settings.

**Features:**
- Displays current trust level
- Allows changing trust level (Trust Folder, Trust Parent, Don't Trust)
- Shows inherited trust from parent folders or IDE
- Requires CLI restart to apply changes

**Command:** `/permissions trust [<directory-path>]`
- Defined in `packages/cli/src/ui/commands/permissionsCommand.ts`

---

## Permission Flow

### Session Initialization
1. **Load Settings** → Read `security.folderTrust.enabled` setting
2. **Check Workspace Trust** → Call `isWorkspaceTrusted(settings, cwd)`
   - Check IDE context (`ideContextStore`)
   - Check local trust configuration (`trustedFolders.json`)
3. **Initialize Config** → Pass `folderTrust` and `trustedFolder` to Config
4. **Enforce Restrictions** → Apply trust-based limitations:
   - Approval mode restrictions
   - YOLO mode availability
   - Extension loading
   - Hook execution

### Runtime Permission Checks
- **Approval Mode Changes**: `Config.setApprovalMode()` validates trust
- **YOLO Mode**: `Config.isYoloModeDisabled()` checks trust
- **Extension Installation**: `ExtensionManager` validates trust
- **Hook Execution**: `TrustedHooksManager` validates hook trust

---

## Configuration Files

### User-Level Trust Configuration
- **Path**: `~/.gemini/trustedFolders.json`
- **Format**:
  ```json
  {
    "/path/to/project": "TRUST_FOLDER",
    "/path/to/parent": "TRUST_PARENT",
    "/untrusted/path": "DO_NOT_TRUST"
  }
  ```

### Hook Trust Configuration
- **Path**: `~/.gemini/trusted_hooks.json`
- **Format**:
  ```json
  {
    "/path/to/project": ["hook-name:command", "another-hook:command"]
  }
  ```

### Settings Configuration
- **Location**: `.gemini/settings.json` (workspace) or `~/.gemini/settings.json` (user)
- **Relevant Settings**:
  ```json
  {
    "security": {
      "folderTrust": {
        "enabled": true
      }
    }
  }
  ```

---

## Key Insights

1. **Trust is Workspace-Based**: Permissions are tied to the current working directory, not individual sessions
2. **IDE Integration**: IDE workspace trust takes precedence over local configuration
3. **Hierarchical Trust**: Parent folder trust can cascade to child folders
4. **Default Behavior**: When folder trust is disabled, all folders are considered trusted
5. **Approval Mode Gating**: Privileged modes (YOLO, AUTO_EDIT) require trusted folders
6. **Extension Safety**: Extensions only auto-load in trusted workspaces
7. **Hook Safety**: Project hooks require explicit trust per project

---

## Related Files

### Core Permission Logic
- `packages/cli/src/config/trustedFolders.ts` - Folder trust implementation
- `packages/core/src/config/config.ts` - Config class with trust enforcement
- `packages/core/src/policy/policy-engine.ts` - Policy enforcement
- `packages/core/src/policy/types.ts` - Policy and approval mode types

### UI Components
- `packages/cli/src/ui/components/PermissionsModifyTrustDialog.tsx` - Trust dialog
- `packages/cli/src/ui/commands/permissionsCommand.ts` - Permissions command
- `packages/cli/src/ui/hooks/usePermissionsModifyTrust.ts` - Trust management hook

### Extension & Hook Management
- `packages/cli/src/config/extension-manager.ts` - Extension trust checks
- `packages/core/src/hooks/trustedHooks.ts` - Hook trust management

### Tests
- `packages/cli/src/config/trustedFolders.test.ts`
- `packages/cli/src/config/config.test.ts` (lines 1734-1780 for folder trust tests)
- `packages/core/src/hooks/trustedHooks.test.ts`
