#!/bin/bash
# Manual API Tests for Sandbox Provider
# Run these after starting the dev server

BASE_URL="http://localhost:5171"

echo "=========================================="
echo "  Sandbox Provider API Tests"
echo "  Base URL: $BASE_URL"
echo "=========================================="
echo ""
echo "⚠️  You must be logged in to test these endpoints"
echo ""

# Function to test an endpoint
test_endpoint() {
    local method="$1"
    local endpoint="$2"
    local body="$3"
    local description="$4"

    echo "----------------------------------------"
    echo "Test: $description"
    echo "Endpoint: $method $endpoint"
    echo ""

    if [ -n "$body" ]; then
        echo "Request body:"
        echo "$body" | jq .
        echo ""

        curl -s -X "$method" \
            "$BASE_URL$endpoint" \
            -H "Content-Type: application/json" \
            -d "$body" | jq .
    else
        curl -s -X "$method" \
            "$BASE_URL$endpoint" \
            -H "Content-Type: application/json" | jq .
    fi

    echo ""
}

echo "1. Check Feature Flag Status"
echo "   (Should show if Vercel Sandbox is enabled)"
test_endpoint "GET" "/api/health" "" "Health Check"

echo ""
echo "2. Test Sandbox Preference API (requires auth)"
test_endpoint "PATCH" "/api/user/sandbox-preference" \
    '{"preferredProvider": "vercel"}' \
    "Update preference to Vercel"

echo ""
echo "=========================================="
echo "  Next Steps (Manual Browser Testing):"
echo "=========================================="
echo ""
echo "1. Open http://localhost:5171 in your browser"
echo "2. Log in if not already logged in"
echo "3. Check Settings → Sandbox tab:"
echo "   - Should show 'WebContainer (Local)' and 'Vercel Sandbox (Cloud)' options"
echo ""
echo "4. Open any project or create new one"
echo "5. Check workbench header:"
echo "   - Should see 'Local' or 'Cloud' badge near the Code/Diff/Preview slider"
echo ""
echo "6. Click on the provider badge:"
echo "   - Should show dropdown to switch providers"
echo ""
echo "7. To test Vercel sandbox creation:"
echo "   - Switch to 'Cloud' provider"
echo "   - Open browser console"
echo "   - Run: await workbenchStore.initializeProvider('vercel', 'test-project', 'user-id')"
echo ""
