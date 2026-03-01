"""
Test to verify that agent tokens are not exposed in the /api/agents response.
This is a security test to ensure the vulnerability is fixed.
"""
import asyncio
import aiohttp
import json

SERVER_URL = "http://127.0.0.1:8000"

async def test_agent_list_no_token_exposure():
    """Test that /api/agents does not expose tokens."""
    print("Testing /api/agents endpoint for token exposure...")

    # First, register an agent to have something in the list
    async with aiohttp.ClientSession() as session:
        # Register an agent
        register_data = {
            "ide": "TestIDE",
            "model": "TestModel",
            "description": "Test agent for token exposure check"
        }
        async with session.post(f"{SERVER_URL}/api/agents/register", json=register_data) as resp:
            if resp.status != 200:
                print(f"Failed to register agent: {resp.status}")
                return False
            register_result = await resp.json()
            print(f"Registered agent: {register_result['agent_id']}")
            print(f"Token from registration (should be present): {register_result.get('token', 'MISSING')}")

        # Now get the agent list
        async with session.get(f"{SERVER_URL}/api/agents") as resp:
            if resp.status != 200:
                print(f"Failed to get agent list: {resp.status}")
                return False

            agents = await resp.json()
            print(f"\nFound {len(agents)} agents")

            # Check each agent for token exposure
            for agent in agents:
                agent_id = agent.get('id')
                print(f"\nChecking agent {agent_id}:")
                print(f"  Name: {agent.get('name')}")
                print(f"  Online: {agent.get('is_online')}")

                # CRITICAL: Check if token is exposed
                if 'token' in agent:
                    print(f"  ❌ SECURITY ISSUE: Token is exposed in agent list: {agent['token']}")
                    return False
                else:
                    print(f"  ✓ Token is NOT exposed (correct)")

    print("\n✓ All checks passed! Tokens are properly protected.")
    return True

async def main():
    try:
        success = await test_agent_list_no_token_exposure()
        exit(0 if success else 1)
    except aiohttp.ClientConnectorError:
        print("Error: Cannot connect to server. Make sure the server is running at http://127.0.0.1:8000")
        exit(1)
    except Exception as e:
        print(f"Error: {e}")
        exit(1)

if __name__ == "__main__":
    asyncio.run(main())
