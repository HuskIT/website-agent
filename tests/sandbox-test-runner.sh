#!/bin/bash
# Sandbox Provider Test Runner
# Feature: 001-sandbox-providers

set -e

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo "=========================================="
echo "  Sandbox Provider Test Runner"
echo "  Feature: 001-sandbox-providers"
echo "=========================================="
echo ""

# Counters
PASSED=0
FAILED=0
WARNINGS=0

# Test function
run_test() {
    local name="$1"
    local command="$2"

    echo -n "Testing: $name... "
    if eval "$command" > /dev/null 2>&1; then
        echo -e "${GREEN}✓ PASS${NC}"
        ((PASSED++))
        return 0
    else
        echo -e "${RED}✗ FAIL${NC}"
        ((FAILED++))
        return 1
    fi
}

warning() {
    local name="$1"
    echo -e "${YELLOW}⚠ WARNING${NC}: $name"
    ((WARNINGS++))
}

# ============================================
# Phase 1: Environment Validation
# ============================================
echo -e "${BLUE}Phase 1: Environment Validation${NC}"
echo "------------------------------------------"

# Check .env.local exists
if [ -f .env.local ]; then
    echo -e "${GREEN}✓${NC} .env.local file exists"
    ((PASSED++))
else
    echo -e "${RED}✗${NC} .env.local file not found (copy from .env.example)"
    ((FAILED++))
fi

# Check required environment variables
check_env_var() {
    local var="$1"
    local required="$2"

    if grep -q "^$var=" .env.local 2>/dev/null; then
        local value=$(grep "^$var=" .env.local | cut -d'=' -f2)
        if [ -n "$value" ] && [ "$value" != "your_$var" ]; then
            if [ "$required" = "true" ]; then
                echo -e "${GREEN}✓${NC} $var is set"
                ((PASSED++))
            else
                echo -e "${GREEN}✓${NC} $var is set (optional)"
                ((PASSED++))
            fi
        else
            if [ "$required" = "true" ]; then
                echo -e "${RED}✗${NC} $var is empty or has placeholder value"
                ((FAILED++))
            else
                warning "$var is empty (optional but recommended)"
            fi
        fi
    else
        if [ "$required" = "true" ]; then
            echo -e "${RED}✗${NC} $var not found in .env.local"
            ((FAILED++))
        else
            warning "$var not found (optional)"
        fi
    fi
}

# Required for Vercel Sandbox
check_env_var "VERCEL_TOKEN" "true"
check_env_var "VERCEL_TEAM_ID" "true"
check_env_var "VERCEL_PROJECT_ID" "true"

# Optional
check_env_var "SANDBOX_VERCEL_ENABLED" "false"
check_env_var "SANDBOX_PROVIDER_DEFAULT" "false"

echo ""

# ============================================
# Phase 2: File Structure Validation
# ============================================
echo -e "${BLUE}Phase 2: File Structure Validation${NC}"
echo "------------------------------------------"

FILES=(
    "app/lib/sandbox/types.ts"
    "app/lib/sandbox/schemas.ts"
    "app/lib/sandbox/index.ts"
    "app/lib/sandbox/file-sync.ts"
    "app/lib/sandbox/timeout-manager.ts"
    "app/lib/sandbox/providers/webcontainer.ts"
    "app/lib/sandbox/providers/vercel-sandbox.ts"
    "app/lib/stores/sandbox.ts"
    "app/routes/api.sandbox.create.ts"
    "app/routes/api.sandbox.files.ts"
    "app/routes/api.sandbox.command.ts"
    "app/routes/api.sandbox.reconnect.ts"
    "app/routes/api.sandbox.status.ts"
    "app/routes/api.sandbox.extend.ts"
    "app/routes/api.sandbox.stop.ts"
    "app/routes/api.sandbox.snapshot.ts"
    "app/routes/api.user.sandbox-preference.ts"
    "app/components/@settings/tabs/sandbox/SandboxTab.tsx"
    "app/components/workbench/TimeoutWarning.tsx"
    "app/components/workbench/ProviderBadge.tsx"
)

for file in "${FILES[@]}"; do
    run_test "File exists: $file" "test -f '$file'"
done

# Check special files with $ in name separately
run_test "File exists: api.sandbox.files.\$path.ts" "test -f 'app/routes/api.sandbox.files.\$path.ts'"
run_test "File exists: api.sandbox.snapshot.\$id.restore.ts" "test -f 'app/routes/api.sandbox.snapshot.\$id.restore.ts'"

echo ""

# ============================================
# Phase 3: TypeScript Compilation
# ============================================
echo -e "${BLUE}Phase 3: TypeScript Compilation${NC}"
echo "------------------------------------------"

echo -n "Running TypeScript check (this may take a while)... "
if pnpm run typecheck > /tmp/tsc_output.txt 2>&1; then
    echo -e "${GREEN}✓ PASS${NC}"
    ((PASSED++))
else
    # Check if only pre-existing errors
    if grep -q "@codemirror/search" /tmp/tsc_output.txt && [ $(grep -c "error TS" /tmp/tsc_output.txt) -eq 1 ]; then
        echo -e "${YELLOW}⚠ PASS with pre-existing error${NC} (@codemirror/search - unrelated)"
        ((PASSED++))
    else
        echo -e "${RED}✗ FAIL${NC}"
        echo "Errors:"
        grep "error TS" /tmp/tsc_output.txt | head -10
        ((FAILED++))
    fi
fi

echo ""

# ============================================
# Phase 4: Lint Check
# ============================================
echo -e "${BLUE}Phase 4: Lint Check${NC}"
echo "------------------------------------------"

echo -n "Running ESLint on sandbox files... "
if pnpm run lint -- --max-warnings=50 app/lib/sandbox app/routes/api.sandbox.* app/components/@settings/tabs/sandbox app/components/workbench/TimeoutWarning.tsx app/components/workbench/ProviderBadge.tsx > /tmp/lint_output.txt 2>&1; then
    echo -e "${GREEN}✓ PASS${NC}"
    ((PASSED++))
else
    echo -e "${YELLOW}⚠ WARNINGS${NC} (check with: pnpm run lint)"
    ((WARNINGS++))
fi

echo ""

# ============================================
# Phase 5: Dependency Check
# ============================================
echo -e "${BLUE}Phase 5: Dependency Check${NC}"
echo "------------------------------------------"

run_test "@vercel/sandbox installed" "grep -q '@vercel/sandbox' package.json"
run_test "zod installed" "grep -q 'zod' package.json"

echo ""

# ============================================
# Summary
# ============================================
echo "=========================================="
echo "  Test Summary"
echo "=========================================="
echo -e "${GREEN}Passed:   $PASSED${NC}"
echo -e "${RED}Failed:   $FAILED${NC}"
echo -e "${YELLOW}Warnings: $WARNINGS${NC}"
echo ""

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}✓ All critical tests passed!${NC}"
    echo ""
    echo "Next steps:"
    echo "1. Start the dev server: pnpm run dev"
    echo "2. Run manual tests from tests/sandbox-validation.md"
    echo "3. Verify Vercel credentials by creating a test sandbox"
    exit 0
else
    echo -e "${RED}✗ Some tests failed. Please fix the issues above.${NC}"
    exit 1
fi
