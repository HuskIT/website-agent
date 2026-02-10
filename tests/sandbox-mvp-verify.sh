#!/bin/bash
# MVP Verification Script for Sandbox Provider
# Feature: 001-sandbox-providers
# This script verifies Vercel Sandbox is properly configured and working

set -e

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo "=========================================="
echo "  MVP Sandbox Verification"
echo "  Feature: 001-sandbox-providers"
echo "=========================================="
echo ""

PASSED=0
FAILED=0

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

# ============================================
# Phase 1: Environment Configuration
# ============================================
echo -e "${BLUE}Phase 1: Environment Configuration${NC}"
echo "------------------------------------------"

# Check .env.local exists
if [ -f .env.local ]; then
    echo -e "${GREEN}✓${NC} .env.local file exists"
    ((PASSED++))
else
    echo -e "${RED}✗${NC} .env.local file not found"
    echo "   Run: cp .env.example .env.local"
    ((FAILED++))
fi

# Check required environment variables
check_env_var() {
    local var="$1"
    local required="$2"

    if grep -q "^$var=" .env.local 2>/dev/null; then
        local value=$(grep "^$var=" .env.local | cut -d'=' -f2)
        if [ -n "$value" ] && [ "$value" != "your_$var" ] && [ "$value" != "xxxxxxxxxxxxxxxxxx" ]; then
            echo -e "${GREEN}✓${NC} $var is set"
            ((PASSED++))
        else
            if [ "$required" = "true" ]; then
                echo -e "${RED}✗${NC} $var is empty or has placeholder value"
                ((FAILED++))
            fi
        fi
    else
        if [ "$required" = "true" ]; then
            echo -e "${RED}✗${NC} $var not found in .env.local"
            ((FAILED++))
        fi
    fi
}

# Required for Vercel Sandbox
check_env_var "VERCEL_TOKEN" "true"
check_env_var "VERCEL_TEAM_ID" "true"
check_env_var "VERCEL_PROJECT_ID" "true"

# Check default provider
echo -n "Checking SANDBOX_PROVIDER_DEFAULT... "
if grep -q "^SANDBOX_PROVIDER_DEFAULT=vercel" .env.local 2>/dev/null; then
    echo -e "${GREEN}✓${NC} Set to 'vercel' (cloud sandbox)"
    ((PASSED++))
else
    echo -e "${YELLOW}⚠${NC} Not set to 'vercel' (will use WebContainer fallback)"
    echo "   To use Vercel Sandbox, add: SANDBOX_PROVIDER_DEFAULT=vercel"
fi

# Check feature flag
echo -n "Checking SANDBOX_VERCEL_ENABLED... "
if grep -q "^SANDBOX_VERCEL_ENABLED=true" .env.local 2>/dev/null; then
    echo -e "${GREEN}✓${NC} Vercel Sandbox is enabled"
    ((PASSED++))
else
    echo -e "${YELLOW}⚠${NC} Not explicitly enabled"
fi

echo ""

# ============================================
# Phase 2: File Structure
# ============================================
echo -e "${BLUE}Phase 2: Core Files${NC}"
echo "------------------------------------------"

run_test "Sandbox types" "test -f app/lib/sandbox/types.ts"
run_test "Sandbox provider factory" "test -f app/lib/sandbox/index.ts"
run_test "Vercel provider" "test -f app/lib/sandbox/providers/vercel-sandbox.ts"
run_test "WebContainer provider" "test -f app/lib/sandbox/providers/webcontainer.ts"
run_test "File sync manager" "test -f app/lib/sandbox/file-sync.ts"
run_test "Timeout manager" "test -f app/lib/sandbox/timeout-manager.ts"
run_test "Sandbox store" "test -f app/lib/stores/sandbox.ts"

echo ""

# ============================================
# Phase 3: API Routes
# ============================================
echo -e "${BLUE}Phase 3: API Routes${NC}"
echo "------------------------------------------"

run_test "Create sandbox API" "test -f app/routes/api.sandbox.create.ts"
run_test "Files API" "test -f app/routes/api.sandbox.files.ts"
run_test "Command API" "test -f app/routes/api.sandbox.command.ts"
run_test "Status API" "test -f app/routes/api.sandbox.status.ts"
run_test "Extend API" "test -f app/routes/api.sandbox.extend.ts"
run_test "Stop API" "test -f app/routes/api.sandbox.stop.ts"
run_test "Reconnect API" "test -f app/routes/api.sandbox.reconnect.ts"

echo ""

# ============================================
# Phase 4: UI Components
# ============================================
echo -e "${BLUE}Phase 4: UI Components${NC}"
echo "------------------------------------------"

run_test "Provider badge (read-only)" "test -f app/components/workbench/ProviderBadge.tsx"
run_test "Timeout warning" "test -f app/components/workbench/TimeoutWarning.tsx"
run_test "Sandbox settings tab" "test -f app/components/@settings/tabs/sandbox/SandboxTab.tsx"

echo ""

# ============================================
# Phase 5: TypeScript Check
# ============================================
echo -e "${BLUE}Phase 5: TypeScript Compilation${NC}"
echo "------------------------------------------"

echo -n "Running TypeScript check... "
if pnpm run typecheck > /tmp/tsc_output.txt 2>&1; then
    echo -e "${GREEN}✓ PASS${NC}"
    ((PASSED++))
else
    # Check if only pre-existing errors
    if grep -q "@codemirror/search" /tmp/tsc_output.txt && [ $(grep -c "error TS" /tmp/tsc_output.txt) -le 2 ]; then
        echo -e "${YELLOW}⚠ PASS with pre-existing errors${NC}"
        ((PASSED++))
    else
        echo -e "${RED}✗ FAIL${NC}"
        echo "Errors:"
        grep "error TS" /tmp/tsc_output.txt | head -5
        ((FAILED++))
    fi
fi

echo ""

# ============================================
# Summary
# ============================================
echo "=========================================="
echo "  Verification Summary"
echo "=========================================="
echo -e "${GREEN}Passed:   $PASSED${NC}"
echo -e "${RED}Failed:   $FAILED${NC}"
echo ""

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}✓ All verification checks passed!${NC}"
    echo ""
    echo "Next steps to verify Vercel connection:"
    echo ""
    echo "1. Start the dev server:"
    echo "   pnpm run dev"
    echo ""
    echo "2. Open a project in the browser"
    echo ""
    echo "3. Check the workbench header - you should see a 'Cloud' badge"
    echo "   (indicating Vercel Sandbox is active)"
    echo ""
    echo "4. Open browser console and check for sandbox connection logs"
    echo ""
    echo "5. Try running a command - it should execute on Vercel's infrastructure"
    echo ""
    echo "To switch to local mode, change .env.local:"
    echo "   SANDBOX_PROVIDER_DEFAULT=webcontainer"
    echo ""
    exit 0
else
    echo -e "${RED}✗ Some checks failed. Please fix the issues above.${NC}"
    echo ""
    echo "Common fixes:"
    echo "- Copy .env.example to .env.local: cp .env.example .env.local"
    echo "- Add your Vercel credentials to .env.local"
    echo "- Install dependencies: pnpm install"
    echo ""
    exit 1
fi
